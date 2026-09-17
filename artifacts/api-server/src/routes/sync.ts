import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  db,
  pool,
  productsTable,
  publicationJobsTable,
  type PublicationJobItem,
  settingsTable,
} from "@workspace/db";
import {
  PublishProductsBatchBody,
  PublishProductsBatchResponse,
  GetLatestPublishProductsBatchResponse,
  GetPublishProductsBatchResponse,
  GetConnectionsResponse,
  GetDashboardResponse,
  GetExchangeRateResponse,
  GetSettingsResponse,
  LinkDigisellerProductBody,
  LinkDigisellerProductResponse,
  ListActivitiesQueryParams,
  ListActivitiesResponse,
  ListDigisellerProductsResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  PublishProductParams,
  PublishProductResponse,
  SyncCatalogBody,
  SyncCatalogResponse,
  TestConnectionsResponse,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  classifyGPayProductType,
  fetchGPayProducts,
  loginGPay,
} from "../lib/gpay";
import { buildProductDescriptions } from "../lib/product-description";
import {
  addDigisellerProductToPlati,
  createDigisellerProduct,
  disableLegacyDigisellerProduct,
  fetchDigisellerSellerProducts,
  loginDigiseller,
  setDigisellerCodeUnlimitedStock,
  uploadDigisellerProductImage,
} from "../lib/digiseller";
import { getOfficialUsdRubRate } from "../lib/exchange-rate";
import { getRepeatedPriceTimeoutWarning } from "../lib/price-timeout-warning";
import { recordDigisellerProductIds } from "../lib/orders";
import { requireOperatorRole } from "../middlewares/auth";

const router: IRouter = Router();

router.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    requireOperatorRole(req, res, next);
    return;
  }
  next();
});

const credentialsConfigured = () =>
  Boolean(
    process.env.GPAY_LOGIN &&
      process.env.GPAY_PASSWORD &&
      process.env.DIGISELLER_SELLER_ID &&
      process.env.DIGISELLER_LOGIN &&
      process.env.DIGISELLER_API_GUID,
  );

async function getSettingsRow() {
  await db.insert(settingsTable).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  return settings;
}

function calculatePrice(
  supplierPriceUsd: number,
  settings: Awaited<ReturnType<typeof getSettingsRow>>,
  marginPercent = settings.defaultMarginPercent,
) {
  const purchaseRate = settings.usdRubRate * (1 + settings.conversionMarkupPercent / 100);
  const baseRub = supplierPriceUsd * purchaseRate;
  const price = Math.ceil(
    baseRub * (1 + settings.digisellerFeePercent / 100) * (1 + marginPercent / 100) +
      settings.fixedReserveRub,
  );
  return {
    salePriceRub: Math.max(price, Math.ceil(baseRub + settings.minimumProfitRub)),
    profitRub: Math.max(price, Math.ceil(baseRub + settings.minimumProfitRub)) - baseRub,
  };
}

async function recalculateAllProductPrices(
  settings: Awaited<ReturnType<typeof getSettingsRow>>,
) {
  const purchaseRate =
    settings.usdRubRate * (1 + settings.conversionMarkupPercent / 100);
  const baseRub = sql`${productsTable.supplierPriceUsd} * ${purchaseRate}`;
  const calculatedPrice = sql`greatest(
    ceil(${baseRub} * (1 + ${settings.digisellerFeePercent} / 100.0) * (1 + ${productsTable.marginPercent} / 100.0) + ${settings.fixedReserveRub}),
    ceil(${baseRub} + ${settings.minimumProfitRub})
  )`;
  await db
    .update(productsTable)
    .set({
      salePriceRub: calculatedPrice,
      profitRub: sql`${calculatedPrice} - ${baseRub}`,
      updatedAt: new Date(),
    });
}

router.get("/dashboard", async (_req, res): Promise<void> => {
  const settings = await getSettingsRow();
  const [[metrics], latestPriceActivities] = await Promise.all([
    db
      .select({
        totalProducts: sql<number>`count(*)::int`,
        availableProducts: sql<number>`count(*) filter (where ${productsTable.isAvailable})::int`,
        publishedProducts: sql<number>`count(*) filter (where ${productsTable.publicationStatus} = 'published')::int`,
        averageMargin: sql<number>`coalesce(avg(${productsTable.marginPercent}), 0)::float8`,
        potentialRevenue: sql<number>`coalesce(sum(${productsTable.salePriceRub}) filter (where ${productsTable.isAvailable}), 0)::float8`,
        lastSyncAt: sql<Date | null>`max(${productsTable.updatedAt})`,
      })
      .from(productsTable),
    db
      .select({ description: activitiesTable.description })
      .from(activitiesTable)
      .where(eq(activitiesTable.type, "price"))
      .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.id))
      .limit(2),
  ]);
  res.json(
    GetDashboardResponse.parse({
      ...metrics,
      lastSyncAt: metrics.lastSyncAt ? new Date(metrics.lastSyncAt).toISOString() : null,
      automationMode: settings.automationMode,
      priceTimeoutWarning:
        getRepeatedPriceTimeoutWarning(latestPriceActivities),
    }),
  );
});

router.get("/products", async (req, res): Promise<void> => {
  const parsed = ListProductsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const {
    search,
    status = "all",
    productKind = "all",
    page = 1,
    pageSize = 20,
  } = parsed.data;
  const filters = [];
  if (search) {
    filters.push(or(ilike(productsTable.name, `%${search}%`), sql`${productsTable.gpayId}::text ilike ${`%${search}%`}`));
  }
  if (status === "available") filters.push(eq(productsTable.isAvailable, true));
  if (status === "unavailable") filters.push(eq(productsTable.isAvailable, false));
  if (status === "published") filters.push(eq(productsTable.publicationStatus, "published"));
  if (status === "draft") filters.push(eq(productsTable.publicationStatus, "draft"));
  if (productKind === "key") filters.push(eq(productsTable.productType, "2"));
  if (productKind === "gift") filters.push(eq(productsTable.productType, "1"));
  if (productKind === "unknown") {
    filters.push(sql`${productsTable.productType} not in ('1', '2')`);
  }
  const where = filters.length ? and(...filters) : undefined;
  const [countRow] = await db.select({ total: sql<number>`count(*)::int` }).from(productsTable).where(where);
  const rows = await db
    .select()
    .from(productsTable)
    .where(where)
    .orderBy(desc(productsTable.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  res.json(
    ListProductsResponse.parse({
      items: rows.map((row) => ({
        ...row,
        productKind: classifyGPayProductType(row.productType),
        updatedAt: row.updatedAt.toISOString(),
      })),
      total: countRow.total,
      page,
      pageSize,
    }),
  );
});

router.patch("/products/:id", async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  const body = UpdateProductBody.safeParse(req.body);
  if (!params.success || !body.success) {
    const error = !params.success ? params.error.message : !body.success ? body.error.message : "Invalid request";
    res.status(400).json({ error });
    return;
  }
  const settings = await getSettingsRow();
  const [current] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const marginPercent = body.data.marginPercent ?? current.marginPercent;
  const calculated = calculatePrice(current.supplierPriceUsd, settings, marginPercent);
  const categoryChanged =
    body.data.platiCategoryId !== undefined &&
    body.data.platiCategoryId !== current.platiCategoryId;
  const [updated] = await db
    .update(productsTable)
    .set({
      ...body.data,
      marginPercent,
      ...calculated,
      ...(categoryChanged
        ? {
            publicationStatus: "draft",
            publicationError: null,
            publicationFailureStage: null,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(productsTable.id, params.data.id))
    .returning();
  res.json(
    UpdateProductResponse.parse({
      ...updated,
      productKind: classifyGPayProductType(updated.productType),
      updatedAt: updated.updatedAt.toISOString(),
    }),
  );
});

type ProductRecord = typeof productsTable.$inferSelect;

function getDigisellerProductInput(current: ProductRecord) {
  const productKind = classifyGPayProductType(current.productType);
  const cleanName = current.name
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .split("|")[0]
    .trim();
  const platform =
    current.name.match(/\bSteam\b/i)?.[0] ??
    current.name.match(/\bXbox\b/i)?.[0] ??
    current.name.match(/\bPlayStation\b/i)?.[0] ??
    "PC";
  const regionFromName = current.name
    .split("|")
    .slice(1)
    .join(" ")
    .replace(new RegExp(platform, "ig"), "")
    .trim();
  const region =
    current.region && current.region !== "Не указан"
      ? current.region
      : regionFromName || "Без региональных ограничений";
  const descriptions = buildProductDescriptions({
    productId: current.gpayId,
    cleanName,
    platform,
    region,
    productKind,
  });
  return {
    name: current.name,
    ...descriptions,
    priceRub: current.salePriceRub,
    productType: current.productType,
  };
}

function toProductResponse(current: ProductRecord) {
  return {
    ...current,
    productKind: classifyGPayProductType(current.productType),
    updatedAt: current.updatedAt.toISOString(),
  };
}

async function publishProductRecord(current: ProductRecord) {
  if (!current.isAvailable) {
    throw new Error("Можно публиковать только доступные товары");
  }
  if (classifyGPayProductType(current.productType) === "unknown") {
    throw new Error(`Неизвестный тип товара GPay: ${current.productType}`);
  }
  if (
    current.publicationStatus === "publishing" &&
    current.publicationFailureStage === "uncertain"
  ) {
    throw new Error(
      current.publicationError ??
        "Предыдущая попытка прервалась во время создания карточки. Автоматический повтор остановлен, чтобы не создать дубликат.",
    );
  }
  const markCreationRequestStarting = async () => {
    await db
      .update(productsTable)
      .set({
        publicationStatus: "publishing",
        publicationError:
          "Создание карточки было начато. При прерывании потребуется сверка с Digiseller.",
        publicationFailureStage: "uncertain",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
  };
  const markCreationRequestRejected = async () => {
    await db
      .update(productsTable)
      .set({
        publicationStatus: "draft",
        publicationError: null,
        publicationFailureStage: null,
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
  };

  const token = await loginDigiseller();
  const input = getDigisellerProductInput(current);
  let digisellerId = current.digisellerId;
  let previousDigisellerId = current.previousDigisellerId;
  let deliveryType = current.digisellerDeliveryType;
  let digisellerTextStocked = current.digisellerTextStocked;
  let digisellerImageUploaded = current.digisellerImageUploaded;
  let platiCategoryId = current.platiCategoryId;
  let createdCodeProduct = false;
  const historicalDigisellerIds = new Set<number>(
    [current.digisellerId, current.previousDigisellerId].filter(
      (id): id is number => id !== null,
    ),
  );
  const legacyDeliveryType: "form" | "text" =
    deliveryType === "text" ||
    (deliveryType === "code" && Boolean(previousDigisellerId))
      ? "text"
      : "form";
  const runWithCategoryRecovery = async <T>(
    operation: (categoryId: number | null) => Promise<T>,
  ): Promise<T> => {
    try {
      return await operation(platiCategoryId);
    } catch (error) {
      if (
        !platiCategoryId ||
        !(error instanceof Error) ||
        !error.message.includes('"code":"marketplace-1"')
      ) {
        throw error;
      }
      platiCategoryId = null;
      await db
        .update(productsTable)
        .set({ platiCategoryId: null, updatedAt: new Date() })
        .where(eq(productsTable.id, current.id));
      return operation(null);
    }
  };

  if (
    digisellerId &&
    deliveryType === "text" &&
    !previousDigisellerId
  ) {
    // Text cards cannot be converted in place. Keep the old ID until the
    // replacement code card has stock and an image, then disable it.
    previousDigisellerId = digisellerId;
    digisellerId = await runWithCategoryRecovery((categoryId) =>
      createDigisellerProduct(
        input,
        token,
        categoryId,
        markCreationRequestStarting,
        markCreationRequestRejected,
      ),
    );
    deliveryType = "code";
    createdCodeProduct = true;
    digisellerTextStocked = false;
    digisellerImageUploaded = false;
    historicalDigisellerIds.add(previousDigisellerId);
    historicalDigisellerIds.add(digisellerId);
    await db
      .update(productsTable)
      .set({
        digisellerId,
        previousDigisellerId,
        digisellerDeliveryType: deliveryType,
        digisellerTextStocked,
        digisellerImageUploaded,
        publicationStatus: "draft",
        publicationError: null,
        publicationFailureStage: "image",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
    await recordDigisellerProductIds(
      db,
      current.id,
      [...historicalDigisellerIds],
    );
  } else if (
    digisellerId &&
    deliveryType !== "text" &&
    deliveryType !== "code"
  ) {
    previousDigisellerId = digisellerId;
    digisellerId = await runWithCategoryRecovery((categoryId) =>
      createDigisellerProduct(
        input,
        token,
        categoryId,
        markCreationRequestStarting,
        markCreationRequestRejected,
      ),
    );
    deliveryType = "code";
    createdCodeProduct = true;
    digisellerTextStocked = false;
    digisellerImageUploaded = false;
    historicalDigisellerIds.add(previousDigisellerId);
    historicalDigisellerIds.add(digisellerId);
    await db
      .update(productsTable)
      .set({
        digisellerId,
        previousDigisellerId,
        digisellerDeliveryType: deliveryType,
        digisellerTextStocked,
        digisellerImageUploaded,
        publicationStatus: "draft",
        publicationError: null,
        publicationFailureStage: "image",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
    await recordDigisellerProductIds(
      db,
      current.id,
      [...historicalDigisellerIds],
    );
  } else if (digisellerId) {
    try {
      await runWithCategoryRecovery((categoryId) =>
        addDigisellerProductToPlati(
          digisellerId!,
          input,
          token,
          categoryId,
          deliveryType === "text" ? "text" : "code",
        ),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('"code":"product-0"')
      ) {
        throw error;
      }
      historicalDigisellerIds.add(digisellerId);
      digisellerId = await runWithCategoryRecovery((categoryId) =>
        createDigisellerProduct(
          input,
          token,
          categoryId,
          markCreationRequestStarting,
          markCreationRequestRejected,
        ),
      );
      deliveryType = "code";
      createdCodeProduct = true;
      digisellerTextStocked = false;
      digisellerImageUploaded = false;
      historicalDigisellerIds.add(digisellerId);
      await db
        .update(productsTable)
        .set({
          digisellerId,
          digisellerDeliveryType: deliveryType,
          digisellerTextStocked,
          digisellerImageUploaded,
          publicationStatus: "draft",
          publicationError: null,
          publicationFailureStage: "image",
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, current.id));
      await recordDigisellerProductIds(
        db,
        current.id,
        [...historicalDigisellerIds],
      );
    }
  } else {
    digisellerId = await runWithCategoryRecovery((categoryId) =>
      createDigisellerProduct(
        input,
        token,
        categoryId,
        markCreationRequestStarting,
        markCreationRequestRejected,
      ),
    );
    deliveryType = "code";
    createdCodeProduct = true;
    historicalDigisellerIds.add(digisellerId);
    await db
      .update(productsTable)
      .set({
        digisellerId,
        digisellerDeliveryType: deliveryType,
        digisellerTextStocked: false,
        digisellerImageUploaded: false,
        publicationStatus: "draft",
        publicationError: null,
        publicationFailureStage: "image",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
    await recordDigisellerProductIds(
      db,
      current.id,
      [...historicalDigisellerIds],
    );
  }

  // A newly created (or interrupted migration) Code card must be unlimited
  // before it can be considered ready. Existing code cards are edited in
  // place and do not need this call.
  if (
    createdCodeProduct ||
      (deliveryType === "code" && previousDigisellerId) ||
      (deliveryType === "code" &&
        current.publicationFailureStage === "image" &&
        !current.digisellerImageUploaded)
  ) {
    await setDigisellerCodeUnlimitedStock(digisellerId!, token);
  }

  let imageStatus: "uploaded" | "skipped" | "failed" = "skipped";
  let imageError: string | null = null;
  if (!digisellerImageUploaded) {
    try {
      await uploadDigisellerProductImage(
        digisellerId,
        {
          imageUrl: current.imageUrl,
          name: current.name,
          productKind: classifyGPayProductType(current.productType) as "key" | "gift",
          region: current.region,
        },
        token,
      );
      imageStatus = "uploaded";
      digisellerImageUploaded = true;
    } catch (error) {
      imageStatus = "failed";
      imageError =
        error instanceof Error ? error.message : "Не удалось загрузить изображение";
    }
  }

  if (previousDigisellerId && imageStatus !== "failed") {
    // Persist the ready replacement before touching the live legacy card. If
    // disabling fails, the next retry resumes from this code ID safely.
    await db
      .update(productsTable)
      .set({
        digisellerImageUploaded: true,
        publicationStatus: "draft",
        publicationError: null,
        publicationFailureStage: null,
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
    await disableLegacyDigisellerProduct(
      previousDigisellerId,
      input,
      token,
      platiCategoryId,
      legacyDeliveryType,
    );
    previousDigisellerId = null;
  }

  const [updated] = await db
    .update(productsTable)
    .set({
      digisellerId,
      previousDigisellerId,
      digisellerDeliveryType: deliveryType,
      digisellerTextStocked,
      digisellerImageUploaded,
      publicationStatus: imageStatus === "failed" ? "error" : "published",
      publicationError: imageError,
      publicationFailureStage: imageStatus === "failed" ? "image" : null,
      updatedAt: new Date(),
    })
    .where(eq(productsTable.id, current.id))
    .returning();
  await recordDigisellerProductIds(
    db,
    current.id,
    [...historicalDigisellerIds, digisellerId, previousDigisellerId],
  );
  return { product: updated, imageStatus, imageError };
}

type PublicationJob = typeof publicationJobsTable.$inferSelect;

function toPublicationJobResponse(job: PublicationJob) {
  return {
    taskId: job.id,
    status: job.status,
    requested: job.requested,
    succeeded: job.succeeded,
    failed: job.failed,
    items: job.items,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

async function savePublicationJobItems(
  taskId: string,
  items: PublicationJobItem[],
) {
  const succeeded = items.filter((item) => item.status === "published").length;
  const failed = items.filter((item) => item.status === "failed").length;
  await db
    .update(publicationJobsTable)
    .set({ items, succeeded, failed, updatedAt: new Date() })
    .where(eq(publicationJobsTable.id, taskId));
}

async function withProductPublicationLock<T>(
  productId: number,
  operation: () => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1, $2)", [42, productId]);
    return await operation();
  } finally {
    await client.query("select pg_advisory_unlock($1, $2)", [42, productId]);
    client.release();
  }
}

async function publishJobItem(
  taskId: string,
  item: PublicationJobItem,
  items: PublicationJobItem[],
) {
  await withProductPublicationLock(item.productId, async () => {
    try {
    const [current] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, item.productId));
    if (!current) throw new Error("Товар не найден");

    item.name = current.name;
    if (
      current.publicationStatus === "published" &&
      current.digisellerId &&
      current.digisellerDeliveryType === "code"
    ) {
      item.status = "published";
      item.digisellerId = current.digisellerId;
      return;
    }

    item.status = "publishing";
    await savePublicationJobItems(taskId, items);
    const result = await publishProductRecord(current);
    item.status = result.imageStatus === "failed" ? "failed" : "published";
    item.digisellerId = result.product.digisellerId;
    item.imageStatus = result.imageStatus;
    item.error = result.imageError;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка публикации";
    const [persistedFailure] = await db
      .select({
        publicationStatus: productsTable.publicationStatus,
        digisellerId: productsTable.digisellerId,
        publicationFailureStage: productsTable.publicationFailureStage,
      })
      .from(productsTable)
      .where(eq(productsTable.id, item.productId));
    const creationIsUncertain =
      persistedFailure?.publicationStatus === "publishing" &&
      persistedFailure.publicationFailureStage === "uncertain";
    const persistedMessage = creationIsUncertain
      ? `Результат создания карточки неизвестен: ${message}. Автоматический повтор остановлен, чтобы не создать дубликат.`
      : message;
    const [failedProduct] = await db
      .update(productsTable)
      .set({
        publicationStatus: creationIsUncertain ? "publishing" : "error",
        publicationError: persistedMessage,
        publicationFailureStage:
          creationIsUncertain
            ? "uncertain"
            : persistedFailure?.publicationFailureStage ?? "category",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, item.productId))
      .returning();
    item.status = "failed";
    item.digisellerId = failedProduct?.digisellerId ?? null;
    item.error = persistedMessage;
    logger.error(
      { err: error, productId: item.productId, taskId },
      "Background batch Digiseller product publication failed",
    );
    } finally {
    await savePublicationJobItems(taskId, items);
    }
  });
}

async function runPublicationJob(taskId: string) {
  const lockClient = await pool.connect();
  const lockResult = await lockClient.query<{ acquired: boolean }>(
    "select pg_try_advisory_lock(hashtext($1)) as acquired",
    [taskId],
  );
  if (!lockResult.rows[0]?.acquired) {
    lockClient.release();
    return;
  }
  try {
  const [job] = await db
    .select()
    .from(publicationJobsTable)
    .where(eq(publicationJobsTable.id, taskId));
  if (!job || job.status === "completed") return;

  const items = job.items.map((item) => ({
    ...item,
    status:
      item.status === "publishing" ? ("queued" as const) : item.status,
  }));
  await db
    .update(publicationJobsTable)
    .set({ status: "running", items, updatedAt: new Date() })
    .where(eq(publicationJobsTable.id, taskId));

  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (item.status === "queued") {
        await publishJobItem(taskId, item, items);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, items.length) }, () => worker()),
  );

  const succeeded = items.filter((item) => item.status === "published").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const imageFailures = items.filter(
    (item) => item.imageStatus === "failed",
  ).length;
  const completedAt = new Date();
  await db
    .update(publicationJobsTable)
    .set({
      status: "completed",
      items,
      succeeded,
      failed,
      updatedAt: completedAt,
      completedAt,
    })
    .where(eq(publicationJobsTable.id, taskId));
  await db.insert(activitiesTable).values({
    type: "publish",
    title: "Пакетная публикация завершена",
    description: `Опубликовано ${succeeded}, ошибок ${failed}, изображений не загружено ${imageFailures}.`,
    status: failed > 0 || imageFailures > 0 ? "warning" : "success",
  });
  } finally {
    await lockClient.query("select pg_advisory_unlock(hashtext($1))", [taskId]);
    lockClient.release();
  }
}

function launchPublicationJob(taskId: string) {
  setImmediate(() => {
    void runPublicationJob(taskId).catch((error) => {
      logger.error({ err: error, taskId }, "Background publication job crashed");
    });
  });
}

setImmediate(() => {
  void db
    .select({ id: publicationJobsTable.id })
    .from(publicationJobsTable)
    .where(sql`${publicationJobsTable.status} in ('queued', 'running')`)
    .then((jobs) => jobs.forEach((job) => launchPublicationJob(job.id)))
    .catch((error) => {
      logger.error({ err: error }, "Failed to recover publication jobs");
    });
});

router.post("/products/publish-batch", async (req, res): Promise<void> => {
  const body = PublishProductsBatchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const ids = [...body.data.productIds].sort((a, b) => a - b);
  const [existing] = await db
    .select()
    .from(publicationJobsTable)
    .where(
      and(
        sql`${publicationJobsTable.status} in ('queued', 'running')`,
        eq(publicationJobsTable.productIds, ids),
      ),
    )
    .orderBy(desc(publicationJobsTable.createdAt))
    .limit(1);
  if (existing) {
    res.status(202).json(
      PublishProductsBatchResponse.parse(toPublicationJobResponse(existing)),
    );
    return;
  }

  const rows = await db
    .select({ id: productsTable.id, name: productsTable.name })
    .from(productsTable)
    .where(inArray(productsTable.id, ids));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const items: PublicationJobItem[] = ids.map((productId) => ({
    productId,
    name: names.get(productId) ?? `Товар #${productId}`,
    status: "queued",
    digisellerId: null,
    imageStatus: "skipped",
    error: null,
  }));
  const [job] = await db
    .insert(publicationJobsTable)
    .values({
      id: randomUUID(),
      productIds: ids,
      requested: ids.length,
      items,
    })
    .returning();
  launchPublicationJob(job.id);
  res.status(202).json(
    PublishProductsBatchResponse.parse(toPublicationJobResponse(job)),
  );
});

router.get("/products/publish-batch", async (_req, res): Promise<void> => {
  const [job] = await db
    .select()
    .from(publicationJobsTable)
    .orderBy(desc(publicationJobsTable.createdAt))
    .limit(1);
  res.json(
    GetLatestPublishProductsBatchResponse.parse(
      job ? toPublicationJobResponse(job) : null,
    ),
  );
});

router.get("/products/publish-batch/:taskId", async (req, res): Promise<void> => {
  const [job] = await db
    .select()
    .from(publicationJobsTable)
    .where(eq(publicationJobsTable.id, req.params.taskId));
  if (!job) {
    res.status(404).json({ error: "Задача публикации не найдена" });
    return;
  }
  res.json(
    GetPublishProductsBatchResponse.parse(toPublicationJobResponse(job)),
  );
});

router.post("/products/:id/publish", async (req, res): Promise<void> => {
  const params = PublishProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [current] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  try {
    const result = await withProductPublicationLock(current.id, async () => {
      const [latest] = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, current.id));
      if (!latest) throw new Error("Товар не найден");
      return publishProductRecord(latest);
    });
    await db.insert(activitiesTable).values({
      type: "publish",
      title: "Товар готов к публикации",
      description:
        result.imageStatus === "failed"
          ? `${result.product.name} опубликован, но изображение не загружено: ${result.imageError}`
          : `${result.product.name} создан в Digiseller, ID ${result.product.digisellerId}.`,
      status: result.imageStatus === "failed" ? "warning" : "success",
    });
    res.json(PublishProductResponse.parse(toProductResponse(result.product)));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Digiseller publication failed";
    const [persistedFailure] = await db
      .select({
        publicationStatus: productsTable.publicationStatus,
        digisellerId: productsTable.digisellerId,
        publicationFailureStage: productsTable.publicationFailureStage,
      })
      .from(productsTable)
      .where(eq(productsTable.id, current.id));
    const creationIsUncertain =
      persistedFailure?.publicationStatus === "publishing" &&
      persistedFailure.publicationFailureStage === "uncertain";
    const persistedMessage = creationIsUncertain
      ? `Результат создания карточки неизвестен: ${message}. Автоматический повтор остановлен, чтобы не создать дубликат.`
      : message;
    await db
      .update(productsTable)
      .set({
        publicationStatus: creationIsUncertain ? "publishing" : "error",
        publicationError: persistedMessage,
        publicationFailureStage:
          creationIsUncertain
            ? "uncertain"
            : persistedFailure?.publicationFailureStage ?? "category",
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, current.id));
    req.log.error(
      { err: error, productId: current.id },
      "Digiseller product publication failed",
    );
    res.status(502).json({
      error: persistedMessage,
    });
  }
});

router.post("/sync/catalog", async (req, res): Promise<void> => {
  const parsed = SyncCatalogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    let settings = await getSettingsRow();
    const rate = await getOfficialUsdRubRate(settings.usdRubRate);
    if (!rate.isFallback && rate.usdRub !== settings.usdRubRate) {
      [settings] = await db
        .update(settingsTable)
        .set({ usdRubRate: rate.usdRub, updatedAt: new Date() })
        .where(eq(settingsTable.id, 1))
        .returning();
    }
    const requestedProductKind = parsed.data.productKind ?? "all";
    const productKindLabel = {
      all: "все товары",
      key: "ключи",
      gift: "гифты",
    }[requestedProductKind];
    const data = await fetchGPayProducts(
      parsed.data.pageSize,
      requestedProductKind,
    );
    let imported = 0;
    let updated = 0;
    for (const product of data.products ?? []) {
      if (parsed.data.availableOnly && product.isAvailable !== true) continue;
      const productKind = classifyGPayProductType(product.productType);
      if (
        requestedProductKind !== "all" &&
        productKind !== requestedProductKind
      ) {
        continue;
      }
      const normalizedProductType = String(product.productType);
      const [existing] = await db
        .select()
        .from(productsTable)
        .where(
          and(
            eq(productsTable.gpayId, product.id),
            eq(productsTable.productType, normalizedProductType),
          ),
        );
      const marginPercent = existing?.marginPercent ?? settings.defaultMarginPercent;
      const calculated = calculatePrice(product.currentPartnerPrice, settings, marginPercent);
      const values = {
        gpayId: product.id,
        appId: product.appId ?? null,
        subId: product.subId ?? null,
        name: product.name,
        imageUrl: product.imageUrl ?? null,
        productType: normalizedProductType,
        supplierPriceUsd: product.currentPartnerPrice,
        marginPercent,
        ...calculated,
        isAvailable: product.isAvailable === true,
        region: product.region || "Не указан",
        warningMessage:
          productKind === "unknown"
            ? [
                product.warningMessage,
                `Неизвестный тип товара GPay: ${String(product.productType)}`,
              ]
                .filter(Boolean)
                .join(". ")
            : (product.warningMessage ?? null),
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(productsTable).set(values).where(eq(productsTable.id, existing.id));
        updated++;
      } else {
        await db.insert(productsTable).values(values);
        imported++;
      }
    }
    await db.insert(activitiesTable).values({
      type: "sync",
      title: "Каталог GPay синхронизирован",
      description: `Тип: ${productKindLabel}. Добавлено ${imported}, обновлено ${updated} товаров.`,
      status: "success",
    });
    res.json(
      SyncCatalogResponse.parse({
        success: true,
        imported,
        updated,
        disabled: 0,
        productKind: requestedProductKind,
        message: `Синхронизация завершена: ${productKindLabel}. Получено ${data.products?.length ?? 0} из ${data.totalCount} товаров`,
        completedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "GPay catalog sync failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "GPay API error" });
  }
});

router.get("/sync/digiseller-products", async (req, res): Promise<void> => {
  try {
    const [sellerProducts, linkedProducts] = await Promise.all([
      fetchDigisellerSellerProducts(),
      db
        .select({
          id: productsTable.id,
          digisellerId: productsTable.digisellerId,
        })
        .from(productsTable)
        .where(isNotNull(productsTable.digisellerId)),
    ]);
    const linkedByDigisellerId = new Map(
      linkedProducts
        .filter(
          (
            item,
          ): item is { id: number; digisellerId: number } =>
            item.digisellerId !== null,
        )
        .map((item) => [item.digisellerId, item.id]),
    );
    res.json(
      ListDigisellerProductsResponse.parse({
        items: sellerProducts.map((product) => ({
          ...product,
          linkedProductId: linkedByDigisellerId.get(product.id) ?? null,
        })),
        total: sellerProducts.length,
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Digiseller product list failed");
    res.status(502).json({
      error:
        error instanceof Error
          ? error.message
          : "Digiseller API error",
    });
  }
});

router.post(
  "/sync/digiseller-products/link",
  async (req, res): Promise<void> => {
    const parsed = LinkDigisellerProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { localProductId, digisellerId, deliveryType } = parsed.data;
    try {
      const sellerProducts = await fetchDigisellerSellerProducts();
      const sellerProduct = sellerProducts.find(
        (product) => product.id === digisellerId,
      );
      if (!sellerProduct) {
        res.status(404).json({
          error: "Карточка не найдена в аккаунте Digiseller",
        });
        return;
      }

      const result = await withProductPublicationLock(
        localProductId,
        async () =>
          db.transaction(async (transaction) => {
            const [localProduct] = await transaction
              .select()
              .from(productsTable)
              .where(eq(productsTable.id, localProductId));
            if (!localProduct) {
              return { kind: "local-not-found" as const };
            }
            if (
              localProduct.digisellerId !== null &&
              localProduct.digisellerId !== digisellerId
            ) {
              return {
                kind: "local-already-linked" as const,
                digisellerId: localProduct.digisellerId,
              };
            }

            const [existingLink] = await transaction
              .select({ id: productsTable.id, name: productsTable.name })
              .from(productsTable)
              .where(eq(productsTable.digisellerId, digisellerId))
              .limit(1);
            if (existingLink && existingLink.id !== localProductId) {
              return {
                kind: "external-already-linked" as const,
                name: existingLink.name,
              };
            }

            await recordDigisellerProductIds(
              transaction,
              localProductId,
              [digisellerId],
            );
            const [updated] = await transaction
              .update(productsTable)
              .set({
                digisellerId,
                digisellerDeliveryType: deliveryType,
                publicationStatus: "published",
                publicationError: null,
                publicationFailureStage: null,
                updatedAt: new Date(),
              })
              .where(eq(productsTable.id, localProductId))
              .returning();
            await transaction.insert(activitiesTable).values({
              type: "sync",
              title: "Товар Digiseller связан",
              description: `${updated.name} связан с карточкой ${sellerProduct.name}, ID ${digisellerId}.`,
              status: "success",
            });
            return { kind: "updated" as const, product: updated };
          }),
      );

      if (result.kind === "local-not-found") {
        res.status(404).json({ error: "Локальный товар не найден" });
        return;
      }
      if (result.kind === "local-already-linked") {
        res.status(409).json({
          error: `Локальный товар уже связан с карточкой Digiseller ${result.digisellerId}. Сначала требуется отдельная операция перепривязки.`,
        });
        return;
      }
      if (result.kind === "external-already-linked") {
        res.status(409).json({
          error: `Карточка уже связана с товаром «${result.name}»`,
        });
        return;
      }
      res.json(
        LinkDigisellerProductResponse.parse(
          toProductResponse(result.product),
        ),
      );
    } catch (error) {
      if (
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505") ||
        (error instanceof Error &&
          error.message.includes("already mapped to local product"))
      ) {
        res.status(409).json({
          error: "Эта карточка Digiseller уже связана с другим товаром",
        });
        return;
      }
      req.log.error(
        { err: error, localProductId, digisellerId },
        "Digiseller product linking failed",
      );
      res.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : "Digiseller API error",
      });
    }
  },
);

router.get("/activities", async (req, res): Promise<void> => {
  const parsed = ListActivitiesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db.select().from(activitiesTable).orderBy(desc(activitiesTable.createdAt)).limit(parsed.data.limit ?? 20);
  res.json(
    ListActivitiesResponse.parse(
      rows.map((row) => ({
        ...row,
        type: row.type === "price-sync" ? "price" : row.type,
        createdAt: row.createdAt.toISOString(),
      })),
    ),
  );
});

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await getSettingsRow();
  res.json(GetSettingsResponse.parse({ ...settings, credentialsConfigured: credentialsConfigured() }));
});

router.put("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db
    .insert(settingsTable)
    .values({ id: 1, ...parsed.data })
    .onConflictDoUpdate({ target: settingsTable.id, set: { ...parsed.data, updatedAt: new Date() } })
    .returning();
  await recalculateAllProductPrices(settings);
  res.json(UpdateSettingsResponse.parse({ ...settings, credentialsConfigured: credentialsConfigured() }));
});

router.get("/connections", async (_req, res): Promise<void> => {
  const configured = credentialsConfigured();
  res.json(
    GetConnectionsResponse.parse({
      gpay: { configured: Boolean(process.env.GPAY_LOGIN && process.env.GPAY_PASSWORD), healthy: false, label: "GPay Partner API", detail: "Нажмите «Проверить подключения»" },
      digiseller: { configured: Boolean(process.env.DIGISELLER_API_GUID), healthy: false, label: "Digiseller API", detail: "Нажмите «Проверить подключения»" },
      checkedAt: new Date().toISOString(),
    }),
  );
});

router.post("/connections/test", async (_req, res): Promise<void> => {
  const [gpay, digiseller] = await Promise.allSettled([loginGPay(), loginDigiseller()]);
  res.json(
    TestConnectionsResponse.parse({
      gpay: { configured: Boolean(process.env.GPAY_LOGIN), healthy: gpay.status === "fulfilled", label: "GPay Partner API", detail: gpay.status === "fulfilled" ? "Авторизация успешна" : gpay.reason instanceof Error ? gpay.reason.message : "Ошибка подключения" },
      digiseller: { configured: Boolean(process.env.DIGISELLER_API_GUID), healthy: digiseller.status === "fulfilled", label: "Digiseller API", detail: digiseller.status === "fulfilled" ? "Авторизация успешна" : digiseller.reason instanceof Error ? digiseller.reason.message : "Ошибка подключения" },
      checkedAt: new Date().toISOString(),
    }),
  );
});

router.get("/exchange-rate", async (_req, res): Promise<void> => {
  const settings = await getSettingsRow();
  if (settings.exchangeRateMode === "manual") {
    res.json(
      GetExchangeRateResponse.parse({
        usdRub: settings.usdRubRate,
        conversionMarkupPercent: settings.conversionMarkupPercent,
        purchaseRate:
          settings.usdRubRate * (1 + settings.conversionMarkupPercent / 100),
        source: "Ручной курс",
        effectiveDate: new Date().toLocaleDateString("ru-RU"),
        fetchedAt: new Date().toISOString(),
        isFallback: false,
      }),
    );
    return;
  }
  const rate = await getOfficialUsdRubRate(settings.usdRubRate);
  if (!rate.isFallback && rate.usdRub !== settings.usdRubRate) {
    const [updatedSettings] = await db
      .update(settingsTable)
      .set({ usdRubRate: rate.usdRub, updatedAt: new Date() })
      .where(eq(settingsTable.id, 1))
      .returning();
    await recalculateAllProductPrices(updatedSettings);
  }
  res.json(
    GetExchangeRateResponse.parse({
      ...rate,
      conversionMarkupPercent: settings.conversionMarkupPercent,
      purchaseRate: rate.usdRub * (1 + settings.conversionMarkupPercent / 100),
    }),
  );
});

export default router;
