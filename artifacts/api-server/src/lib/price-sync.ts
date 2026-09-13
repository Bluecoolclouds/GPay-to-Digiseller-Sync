import { eq } from "drizzle-orm";
import {
  activitiesTable,
  db,
  productsTable,
  settingsTable,
} from "@workspace/db";
import { classifyGPayProductType, fetchGPayProducts } from "./gpay";
import {
  loginDigiseller,
  setDigisellerProductEnabled,
  updateDigisellerProductPrices,
} from "./digiseller";
import { getOfficialUsdRubRate } from "./exchange-rate";
import { createPriceTimeoutSummary } from "./price-timeout-warning";
import { buildProductDescriptions } from "./product-description";

const PRICE_SYNC_LOCK_ID = 704_291_163;

function calculatePrice(
  supplierPriceUsd: number,
  settings: typeof settingsTable.$inferSelect,
  marginPercent: number,
) {
  const purchaseRate =
    settings.usdRubRate * (1 + settings.conversionMarkupPercent / 100);
  const baseRub = supplierPriceUsd * purchaseRate;
  const calculated = Math.ceil(
    baseRub *
      (1 + settings.digisellerFeePercent / 100) *
      (1 + marginPercent / 100) +
      settings.fixedReserveRub,
  );
  const salePriceRub = Math.max(
    calculated,
    Math.ceil(baseRub + settings.minimumProfitRub),
  );
  return { salePriceRub, profitRub: salePriceRub - baseRub };
}

export type PriceSyncResult = {
  checked: number;
  changed: number;
  digisellerUpdated: number;
  failed: number;
  stockChecked: number;
  stockReplenished: number;
  stockFailed: number;
  skipped: boolean;
  errors?: string[];
};

type ProductRecord = typeof productsTable.$inferSelect;

export function getDigisellerProductInput(product: ProductRecord) {
  const productKind = classifyGPayProductType(product.productType);
  const cleanName = product.name
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .split("|")[0]
    .trim();
  const platform =
    product.name.match(/\bSteam\b/i)?.[0] ??
    product.name.match(/\bXbox\b/i)?.[0] ??
    product.name.match(/\bPlayStation\b/i)?.[0] ??
    "PC";
  const region =
    product.region && product.region !== "Не указан"
      ? product.region
      : "Без региональных ограничений";
  const descriptions = buildProductDescriptions({
    productId: product.gpayId,
    cleanName,
    platform,
    region,
    productKind,
  });
  return {
    name: product.name,
    ...descriptions,
    priceRub: product.salePriceRub,
    productType: product.productType,
  };
}

export async function syncKeyPrices(): Promise<PriceSyncResult> {
  const lock = await db.execute<{ locked: boolean }>(
    `select pg_try_advisory_lock(${PRICE_SYNC_LOCK_ID}) as locked`,
  );
  if (!lock.rows[0]?.locked) {
    return {
      checked: 0,
      changed: 0,
      digisellerUpdated: 0,
      failed: 0,
      stockChecked: 0,
      stockReplenished: 0,
      stockFailed: 0,
      skipped: true,
    };
  }

  try {
    await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing();
    let [settings] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));
    if (settings.automationMode !== "automatic") {
      return {
        checked: 0,
        changed: 0,
        digisellerUpdated: 0,
        failed: 0,
        stockChecked: 0,
        stockReplenished: 0,
        stockFailed: 0,
        skipped: true,
      };
    }

    const rate = await getOfficialUsdRubRate(settings.usdRubRate);
    if (!rate.isFallback && rate.usdRub !== settings.usdRubRate) {
      [settings] = await db
        .update(settingsTable)
        .set({ usdRubRate: rate.usdRub, updatedAt: new Date() })
        .where(eq(settingsTable.id, 1))
        .returning();
    }

    const catalog = await fetchGPayProducts(100, "key");
    const supplierById = new Map(
      (catalog.products ?? []).map((product) => [product.id, product]),
    );
    const localProducts = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.productType, "2"));

    const changes = localProducts.flatMap((product) => {
      const supplier = supplierById.get(product.gpayId);
      const calculated = supplier
        ? calculatePrice(
            supplier.currentPartnerPrice,
            settings,
            product.marginPercent,
          )
        : {
            salePriceRub: product.salePriceRub,
            profitRub: product.profitRub,
          };
      const isAvailable = supplier?.isAvailable === true;
      const priceChanged =
        supplier !== undefined &&
        (supplier.currentPartnerPrice !== product.supplierPriceUsd ||
          calculated.salePriceRub !== product.salePriceRub);
      const availabilityChanged = isAvailable !== product.isAvailable;
      if (
        !priceChanged &&
        !availabilityChanged &&
        (supplier?.warningMessage ?? null) === product.warningMessage
      ) {
        return [];
      }
      return [{
        product,
        supplier,
        calculated,
        isAvailable,
        priceChanged,
        availabilityChanged,
      }];
    });

    const publishedPriceChanges = changes.filter(
      ({ product, priceChanged }) =>
        priceChanged &&
        product.publicationStatus === "published" && product.digisellerId,
    );
    const publishedAvailabilityChanges = changes.filter(
      ({ product, isAvailable, availabilityChanged }) =>
        availabilityChanged &&
        (isAvailable || settings.disableOnUnavailable) &&
        product.publicationStatus === "published" &&
        product.digisellerId,
    );
    const publishedProductIds = new Set(
      [...publishedPriceChanges, ...publishedAvailabilityChanges].map(
        ({ product }) => product.digisellerId!,
      ),
    );
    const digisellerFailures = new Map<number, string>();
    if (publishedProductIds.size > 0) {
      let token: string;
      try {
        token = await loginDigiseller();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Не удалось войти в Digiseller";
        for (const productId of publishedProductIds) {
          digisellerFailures.set(productId, message);
        }
        token = "";
      }
      const batchSize = 100;
      for (
        let start = 0;
        start < publishedPriceChanges.length;
        start += batchSize
      ) {
        const batch = publishedPriceChanges.slice(start, start + batchSize);
        if (!token) continue;
        try {
          const failures = await updateDigisellerProductPrices(
            batch.map(({ product, calculated }) => ({
              productId: product.digisellerId!,
              priceRub: calculated.salePriceRub,
            })),
            token,
          );
          for (const [id, message] of failures) {
            digisellerFailures.set(id, message);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Ошибка обновления цены";
          for (const { product } of batch) {
            digisellerFailures.set(product.digisellerId!, message);
          }
        }
      }
      for (const change of publishedAvailabilityChanges) {
        const productId = change.product.digisellerId!;
        if (!token || digisellerFailures.has(productId)) continue;
        try {
          await setDigisellerProductEnabled(
            productId,
            {
              ...getDigisellerProductInput(change.product),
              priceRub: change.calculated.salePriceRub,
            },
            change.isAvailable,
            token,
            change.product.platiCategoryId,
            change.product.digisellerDeliveryType ?? "code",
          );
        } catch (error) {
          digisellerFailures.set(
            productId,
            error instanceof Error
              ? error.message
              : `Не удалось ${change.isAvailable ? "включить" : "отключить"} товар`,
          );
        }
      }
    }

    let updated = 0;
    for (const { product, supplier, calculated, isAvailable } of changes) {
      if (
        product.digisellerId &&
        product.publicationStatus === "published" &&
        digisellerFailures.has(product.digisellerId)
      ) {
        continue;
      }
      await db
        .update(productsTable)
        .set({
          supplierPriceUsd:
            supplier?.currentPartnerPrice ?? product.supplierPriceUsd,
          ...calculated,
          isAvailable,
          warningMessage:
            supplier?.warningMessage ??
            (supplier ? null : "Товар исчез из каталога GPay"),
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, product.id));
      updated++;
    }

    const result = {
      checked: localProducts.length,
      changed: changes.length,
      digisellerUpdated: publishedProductIds.size - digisellerFailures.size,
      failed: digisellerFailures.size,
      stockChecked: 0,
      stockReplenished: 0,
      stockFailed: 0,
      skipped: false,
      errors: [
        ...[...digisellerFailures.entries()].map(
          ([productId, message]) => `Digiseller #${productId}: ${message}`,
        ),
      ],
    };
    const timeoutSummary = createPriceTimeoutSummary(result.errors);
    await db.insert(activitiesTable).values({
      type: "price",
      title: "Автоматическая проверка цен завершена",
      description: [
        `Проверено ${result.checked}, изменилось ${result.changed}, обновлено в Digiseller ${result.digisellerUpdated}, ошибок ${result.failed}.`,
        ...result.errors.slice(0, 3),
        ...(timeoutSummary ? [timeoutSummary] : []),
      ].join(" "),
      status: result.failed > 0 ? "warning" : "success",
    });
    return result;
  } finally {
    await db.execute(`select pg_advisory_unlock(${PRICE_SYNC_LOCK_ID})`);
  }
}