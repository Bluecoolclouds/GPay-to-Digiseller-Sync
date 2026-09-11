import { eq, inArray } from "drizzle-orm";
import {
  activitiesTable,
  db,
  productsTable,
  settingsTable,
} from "@workspace/db";
import { fetchGPayProducts } from "./gpay";
import {
  loginDigiseller,
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
    const digisellerFailures = new Map<number, string>();
    if (published.length > 0) {
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
      skipped: false,
      errors: [...digisellerFailures.entries()].map(
        ([productId, message]) => `Digiseller #${productId}: ${message}`,
      ),
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