import { eq, inArray } from "drizzle-orm";
import {
  activitiesTable,
  db,
  pool,
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
import { calculateProductPrice } from "./pricing";
import { notifyFailure, notifyRecovery } from "./notifications";

const PRICE_SYNC_LOCK_ID = 704_291_163;

export async function withPriceSyncLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("select pg_advisory_lock($1)", [PRICE_SYNC_LOCK_ID]);
  try {
    return await operation();
  } finally {
    await client.query("select pg_advisory_unlock($1)", [PRICE_SYNC_LOCK_ID]);
    client.release();
  }
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

export type PriceSettingsInput = {
  defaultMarginPercent: number;
  usdRubRate: number;
  exchangeRateMode: "cbr" | "manual";
  conversionMarkupPercent: number;
  digisellerFeePercent: number;
  fixedReserveRub: number;
  minimumProfitRub: number;
  automationMode: "manual" | "automatic";
  disableOnUnavailable: boolean;
};

type ProductRecord = typeof productsTable.$inferSelect;

async function rollbackPublishedPrices(
  published: Array<{ product: ProductRecord }>,
  token: string,
) {
  const rollbackFailures = new Set<number>();
  const batchSize = 100;
  for (let start = 0; start < published.length; start += batchSize) {
    const batch = published.slice(start, start + batchSize);
    try {
      const failedRollback = await updateDigisellerProductPrices(
        batch.map(({ product }) => ({
          productId: product.digisellerId!,
          priceRub: product.salePriceRub,
        })),
        token,
      );
      for (const id of failedRollback.keys()) rollbackFailures.add(id);
    } catch {
      for (const { product } of batch) {
        rollbackFailures.add(product.digisellerId!);
      }
    }
  }
  return rollbackFailures;
}

async function disableProductsWithUncertainPrices(
  published: Array<{ product: ProductRecord }>,
  rollbackFailures: Set<number>,
  token: string,
) {
  for (const { product } of published) {
    if (!rollbackFailures.has(product.digisellerId!)) continue;
    try {
      await setDigisellerProductEnabled(
        product.digisellerId!,
        getDigisellerProductInput(product),
        false,
        token,
        product.platiCategoryId,
        product.digisellerDeliveryType ?? "code",
      );
      await db
        .update(productsTable)
        .set({
          isAvailable: false,
          warningMessage:
            "Карточка отключена: не удалось безопасно откатить изменение цены",
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, product.id));
    } catch {
      // The caller records the primary failure; no safer remote action remains.
    }
  }
}

export async function applyPricingSettings(
  candidate: PriceSettingsInput,
  effectiveUsdRubRate: number,
) {
  const lockClient = await pool.connect();
  const lock = await lockClient.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [PRICE_SYNC_LOCK_ID],
  );
  if (!lock.rows[0]?.locked) {
    lockClient.release();
    return {
      applied: false as const,
      reason:
        "Применение цен занято другой задачей. Повторите сохранение после её завершения.",
    };
  }

  try {
    const settings = { ...candidate, usdRubRate: effectiveUsdRubRate };
    const [catalog, localProducts] = await Promise.all([
      fetchGPayProducts(100, "key"),
      db
        .select()
        .from(productsTable)
        .where(eq(productsTable.productType, "2")),
    ]);
    const supplierById = new Map(
      (catalog.products ?? []).map((product) => [product.id, product]),
    );
    const changes = localProducts.flatMap((product) => {
      const supplier = supplierById.get(product.gpayId);
      if (!supplier) return [];
      const calculated = calculateProductPrice(
        supplier.currentPartnerPrice,
        settings,
        product.marginPercent,
      );
      if (
        supplier.currentPartnerPrice === product.supplierPriceUsd &&
        calculated.salePriceRub === product.salePriceRub
      ) {
        return [];
      }
      return [{ product, supplier, calculated }];
    });
    const published = changes.filter(
      ({ product }) =>
        product.publicationStatus === "published" &&
        product.digisellerId !== null,
    );
    const failures = new Map<number, string>();
    let digisellerToken: string | undefined;
    if (published.length > 0) {
      try {
        digisellerToken = await loginDigiseller();
      } catch (error) {
        return {
          applied: false as const,
          reason:
            error instanceof Error
              ? error.message
              : "Не удалось войти в Digiseller",
        };
      }
      const batchSize = 100;
      for (let start = 0; start < published.length; start += batchSize) {
        const batch = published.slice(start, start + batchSize);
        try {
          const batchFailures = await updateDigisellerProductPrices(
            batch.map(({ product, calculated }) => ({
              productId: product.digisellerId!,
              priceRub: calculated.salePriceRub,
            })),
            digisellerToken,
          );
          for (const [id, message] of batchFailures) failures.set(id, message);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Ошибка обновления цены";
          for (const { product } of batch) {
            failures.set(product.digisellerId!, message);
          }
        }
      }

      if (failures.size > 0) {
        const rollbackFailures = await rollbackPublishedPrices(
          published,
          digisellerToken,
        );
        await disableProductsWithUncertainPrices(
          published,
          rollbackFailures,
          digisellerToken,
        );
        await db.insert(activitiesTable).values({
          type: "price",
          title: "Настройки цен не применены",
          description: `Digiseller отклонил ${failures.size} цен. Активные настройки сохранены без изменений; подтверждённые изменения откачены.`,
          status: "warning",
        });
        return {
          applied: false as const,
          reason: `Digiseller отклонил ${failures.size} цен. Настройки не изменены.`,
        };
      }
    }

    let savedSettings: typeof settingsTable.$inferSelect;
    try {
      [savedSettings] = await db.transaction(async (transaction) => {
        const [saved] = await transaction
          .insert(settingsTable)
          .values({ id: 1, ...settings })
          .onConflictDoUpdate({
            target: settingsTable.id,
            set: { ...settings, updatedAt: new Date() },
          })
          .returning();
        for (const { product, supplier, calculated } of changes) {
          await transaction
            .update(productsTable)
            .set({
              supplierPriceUsd: supplier.currentPartnerPrice,
              salePriceRub: calculated.salePriceRub,
              profitRub: calculated.profitRub,
              updatedAt: new Date(),
            })
            .where(eq(productsTable.id, product.id));
        }
        return [saved];
      });
    } catch (error) {
      if (published.length > 0) {
        if (!digisellerToken) throw error;
        const rollbackFailures = await rollbackPublishedPrices(
          published,
          digisellerToken,
        );
        await disableProductsWithUncertainPrices(
          published,
          rollbackFailures,
          digisellerToken,
        );
      }
      throw error;
    }
    await db.insert(activitiesTable).values({
      type: "price",
      title: "Настройки цен применены",
      description: `Изменено ${changes.length} цен, включая ${published.length} опубликованных.`,
      status: "success",
    });
    return {
      applied: true as const,
      settings: savedSettings,
      changed: changes.length,
      publishedChanged: published.length,
    };
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [PRICE_SYNC_LOCK_ID]);
    lockClient.release();
  }
}

export async function applyProductMargins(
  productIds: number[],
  marginPercent: number,
) {
  const lockClient = await pool.connect();
  const lock = await lockClient.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [PRICE_SYNC_LOCK_ID],
  );
  if (!lock.rows[0]?.locked) {
    lockClient.release();
    return {
      applied: false as const,
      reason:
        "Изменение цен занято другой задачей. Повторите операцию после её завершения.",
    };
  }

  try {
    await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing();
    const [[settings], products] = await Promise.all([
      db.select().from(settingsTable).where(eq(settingsTable.id, 1)),
      db
        .select()
        .from(productsTable)
        .where(inArray(productsTable.id, productIds)),
    ]);
    if (products.length !== productIds.length) {
      return {
        applied: false as const,
        reason: "Один или несколько выбранных товаров не найдены",
      };
    }
    const changes = products.map((product) => ({
      product,
      calculated: calculateProductPrice(
        product.supplierPriceUsd,
        settings,
        marginPercent,
      ),
    }));
    const published = changes.filter(
      ({ product }) =>
        product.publicationStatus === "published" &&
        product.digisellerId !== null,
    );
    let token: string | undefined;
    if (published.length > 0) {
      try {
        token = await loginDigiseller();
      } catch (error) {
        return {
          applied: false as const,
          reason:
            error instanceof Error
              ? error.message
              : "Не удалось войти в Digiseller",
        };
      }
      const failures = new Map<number, string>();
      const batchSize = 100;
      for (let start = 0; start < published.length; start += batchSize) {
        const batch = published.slice(start, start + batchSize);
        try {
          const batchFailures = await updateDigisellerProductPrices(
            batch.map(({ product, calculated }) => ({
              productId: product.digisellerId!,
              priceRub: calculated.salePriceRub,
            })),
            token,
          );
          for (const [id, message] of batchFailures) failures.set(id, message);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Digiseller не подтвердил изменение цены";
          for (const { product } of batch) {
            failures.set(product.digisellerId!, message);
          }
        }
      }
      if (failures.size > 0) {
        const rollbackFailures = await rollbackPublishedPrices(published, token);
        await disableProductsWithUncertainPrices(
          published,
          rollbackFailures,
          token,
        );
        return {
          applied: false as const,
          reason: `Digiseller отклонил ${failures.size} цен. Изменения маржи не сохранены.`,
        };
      }
    }

    try {
      await db.transaction(async (transaction) => {
        for (const { product, calculated } of changes) {
          await transaction
            .update(productsTable)
            .set({
              marginPercent,
              salePriceRub: calculated.salePriceRub,
              profitRub: calculated.profitRub,
              updatedAt: new Date(),
            })
            .where(eq(productsTable.id, product.id));
        }
      });
    } catch (error) {
      if (token && published.length > 0) {
        const rollbackFailures = await rollbackPublishedPrices(published, token);
        await disableProductsWithUncertainPrices(
          published,
          rollbackFailures,
          token,
        );
      }
      throw error;
    }

    await db.insert(activitiesTable).values({
      type: "price",
      title: "Маржа товаров изменена",
      description: `Маржа ${marginPercent}% применена к ${changes.length} товарам, включая ${published.length} опубликованных.`,
      status: "success",
    });
    return {
      applied: true as const,
      updated: changes.length,
      publishedUpdated: published.length,
      marginPercent,
    };
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [PRICE_SYNC_LOCK_ID]);
    lockClient.release();
  }
}

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
  const lockClient = await pool.connect();
  const lock = await lockClient.query<{ locked: boolean }>(
    "select pg_try_advisory_lock($1) as locked",
    [PRICE_SYNC_LOCK_ID],
  );
  if (!lock.rows[0]?.locked) {
    lockClient.release();
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

    const rate =
      settings.exchangeRateMode === "manual"
        ? {
            usdRub: settings.usdRubRate,
            source: "Ручной курс",
            effectiveDate: new Date().toLocaleDateString("ru-RU"),
            fetchedAt: new Date().toISOString(),
            isFallback: false,
          }
        : await getOfficialUsdRubRate(settings.usdRubRate);
    if (settings.exchangeRateMode !== "manual" && rate.isFallback) {
      const message =
        "Автоматическая проверка цен остановлена: актуальный курс BestChange недоступен";
      await notifyFailure({
        key: "exchange-rate:stale",
        title: "Не удалось обновить курс валют",
        reason: message,
      });
      await db.insert(activitiesTable).values({
        type: "price",
        title: "Автоматическая проверка цен остановлена",
        description: message,
        status: "warning",
      });
      return {
        checked: 0,
        changed: 0,
        digisellerUpdated: 0,
        failed: 1,
        stockChecked: 0,
        stockReplenished: 0,
        stockFailed: 0,
        skipped: true,
        errors: [message],
      };
    }
    await notifyRecovery("exchange-rate:stale", "Обновление курса валют");
    const effectiveSettings =
      !rate.isFallback && rate.usdRub !== settings.usdRubRate
        ? { ...settings, usdRubRate: rate.usdRub }
        : settings;

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
        ? calculateProductPrice(
            supplier.currentPartnerPrice,
            effectiveSettings,
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
        await notifyRecovery("supplier-auth:digiseller", "Авторизация Digiseller");
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Не удалось войти в Digiseller";
        for (const productId of publishedProductIds) {
          digisellerFailures.set(productId, message);
        }
        await notifyFailure({
          key: "supplier-auth:digiseller",
          title: "Ошибка авторизации Digiseller",
          reason: message,
        });
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
    if (
      digisellerFailures.size === 0 &&
      effectiveSettings.usdRubRate !== settings.usdRubRate
    ) {
      await db
        .update(settingsTable)
        .set({
          usdRubRate: effectiveSettings.usdRubRate,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, 1));
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
    if (result.failed > 0) {
      await notifyFailure({
        key: "price-sync:digiseller",
        title: "Ошибки обновления опубликованных товаров",
        reason: result.errors.join("; "),
      });
    } else {
      await notifyRecovery(
        "price-sync:digiseller",
        "Обновление опубликованных товаров",
      );
    }
    for (const product of localProducts) {
      if (product.publicationStatus !== "published") continue;
      const supplierAvailable =
        supplierById.get(product.gpayId)?.isAvailable === true;
      if (!supplierAvailable) {
        await notifyFailure({
          key: `product-unavailable:${product.id}`,
          title: "Опубликованный товар недоступен у поставщика",
          reason: `Внутренний ID товара: ${product.id}`,
        });
      } else {
        await notifyRecovery(
          `product-unavailable:${product.id}`,
          `Доступность товара ${product.id}`,
        );
      }
    }
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
    await lockClient.query("select pg_advisory_unlock($1)", [PRICE_SYNC_LOCK_ID]);
    lockClient.release();
  }
}