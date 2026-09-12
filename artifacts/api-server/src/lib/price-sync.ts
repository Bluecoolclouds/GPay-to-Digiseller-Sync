import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import {
  activitiesTable,
  db,
  productsTable,
  settingsTable,
} from "@workspace/db";
import { fetchGPayProducts } from "./gpay";
import {
  loginDigiseller,
  replenishDigisellerTextStock,
  updateDigisellerProductPrices,
} from "./digiseller";
import { getOfficialUsdRubRate } from "./exchange-rate";
import { createPriceTimeoutSummary } from "./price-timeout-warning";

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
    const localProducts = supplierById.size
      ? await db
          .select()
          .from(productsTable)
          .where(inArray(productsTable.gpayId, [...supplierById.keys()]))
      : [];

    const changes = localProducts.flatMap((product) => {
      const supplier = supplierById.get(product.gpayId);
      if (!supplier) return [];
      const calculated = calculatePrice(
        supplier.currentPartnerPrice,
        settings,
        product.marginPercent,
      );
      const isAvailable = supplier.isAvailable === true;
      if (
        supplier.currentPartnerPrice === product.supplierPriceUsd &&
        calculated.salePriceRub === product.salePriceRub &&
        isAvailable === product.isAvailable
      ) {
        return [];
      }
      return [{ product, supplier, calculated }];
    });

    const published = changes.filter(
      ({ product }) =>
        product.publicationStatus === "published" && product.digisellerId,
    );
    const textProducts = await db
      .select()
      .from(productsTable)
      .where(
        and(
          eq(productsTable.productType, "2"),
          eq(productsTable.digisellerDeliveryType, "text"),
          isNotNull(productsTable.digisellerId),
          or(
            eq(productsTable.publicationStatus, "published"),
            and(
              eq(productsTable.publicationStatus, "error"),
              eq(productsTable.publicationFailureStage, "stock"),
            ),
          ),
        ),
      );
    const digisellerFailures = new Map<number, string>();
    const stockFailures = new Map<number, string>();
    let stockReplenished = 0;
    if (published.length > 0 || textProducts.length > 0) {
      const token = await loginDigiseller();
      const batchSize = 100;
      for (let start = 0; start < published.length; start += batchSize) {
        const batch = published.slice(start, start + batchSize);
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
      for (const product of textProducts) {
        try {
          const stock = await replenishDigisellerTextStock(
            product.digisellerId!,
            token,
          );
          if (stock.added > 0) stockReplenished++;
          if (product.publicationFailureStage === "stock") {
            await db
              .update(productsTable)
              .set({
                publicationStatus: "published",
                publicationError: null,
                publicationFailureStage: null,
                updatedAt: new Date(),
              })
              .where(eq(productsTable.id, product.id));
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Ошибка пополнения Text-остатка";
          stockFailures.set(product.digisellerId!, message);
          await db
            .update(productsTable)
            .set({
              publicationStatus: "error",
              publicationError: message,
              publicationFailureStage: "stock",
              updatedAt: new Date(),
            })
            .where(eq(productsTable.id, product.id));
        }
      }
    }

    let updated = 0;
    for (const { product, supplier, calculated } of changes) {
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
          supplierPriceUsd: supplier.currentPartnerPrice,
          ...calculated,
          isAvailable: supplier.isAvailable === true,
          warningMessage: supplier.warningMessage ?? null,
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, product.id));
      updated++;
    }

    const result = {
      checked: localProducts.length,
      changed: changes.length,
      digisellerUpdated: published.length - digisellerFailures.size,
      failed: digisellerFailures.size,
      stockChecked: textProducts.length,
      stockReplenished,
      stockFailed: stockFailures.size,
      skipped: false,
      errors: [
        ...[...digisellerFailures.entries()].map(
          ([productId, message]) => `Digiseller #${productId}: ${message}`,
        ),
        ...[...stockFailures.entries()].map(
          ([productId, message]) =>
            `Text-остаток Digiseller #${productId}: ${message}`,
        ),
      ],
    };
    const timeoutSummary = createPriceTimeoutSummary(result.errors);
    await db.insert(activitiesTable).values({
      type: "price",
      title: "Автоматическая проверка цен завершена",
      description: [
        `Проверено ${result.checked}, изменилось ${result.changed}, обновлено в Digiseller ${result.digisellerUpdated}, ошибок ${result.failed}.`,
        `Text-остаток: проверено ${result.stockChecked}, пополнено ${result.stockReplenished}, ошибок ${result.stockFailed}.`,
        ...result.errors.slice(0, 3),
        ...(timeoutSummary ? [timeoutSummary] : []),
      ].join(" "),
      status: result.failed > 0 || result.stockFailed > 0 ? "warning" : "success",
    });
    return result;
  } finally {
    await db.execute(`select pg_advisory_unlock(${PRICE_SYNC_LOCK_ID})`);
  }
}