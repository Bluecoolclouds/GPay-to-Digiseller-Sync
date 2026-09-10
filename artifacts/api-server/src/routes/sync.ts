import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  db,
  productsTable,
  settingsTable,
} from "@workspace/db";
import {
  GetConnectionsResponse,
  GetDashboardResponse,
  GetExchangeRateResponse,
  GetSettingsResponse,
  ListActivitiesQueryParams,
  ListActivitiesResponse,
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
import { fetchGPayProducts, loginGPay } from "../lib/gpay";
import { loginDigiseller } from "../lib/digiseller";
import { getOfficialUsdRubRate } from "../lib/exchange-rate";

const router: IRouter = Router();

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
  const baseRub = supplierPriceUsd * settings.usdRubRate;
  const price = Math.ceil(
    baseRub * (1 + settings.digisellerFeePercent / 100) * (1 + marginPercent / 100) +
      settings.fixedReserveRub,
  );
  return {
    salePriceRub: Math.max(price, Math.ceil(baseRub + settings.minimumProfitRub)),
    profitRub: Math.max(price, Math.ceil(baseRub + settings.minimumProfitRub)) - baseRub,
  };
}

router.get("/dashboard", async (_req, res): Promise<void> => {
  const settings = await getSettingsRow();
  const [metrics] = await db
    .select({
      totalProducts: sql<number>`count(*)::int`,
      availableProducts: sql<number>`count(*) filter (where ${productsTable.isAvailable})::int`,
      publishedProducts: sql<number>`count(*) filter (where ${productsTable.publicationStatus} = 'published')::int`,
      averageMargin: sql<number>`coalesce(avg(${productsTable.marginPercent}), 0)::float8`,
      potentialRevenue: sql<number>`coalesce(sum(${productsTable.salePriceRub}) filter (where ${productsTable.isAvailable}), 0)::float8`,
      lastSyncAt: sql<Date | null>`max(${productsTable.updatedAt})`,
    })
    .from(productsTable);
  res.json(
    GetDashboardResponse.parse({
      ...metrics,
      lastSyncAt: metrics.lastSyncAt ? new Date(metrics.lastSyncAt).toISOString() : null,
      automationMode: settings.automationMode,
    }),
  );
});

router.get("/products", async (req, res): Promise<void> => {
  const parsed = ListProductsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, status = "all", page = 1, pageSize = 20 } = parsed.data;
  const filters = [];
  if (search) {
    filters.push(or(ilike(productsTable.name, `%${search}%`), sql`${productsTable.gpayId}::text ilike ${`%${search}%`}`));
  }
  if (status === "available") filters.push(eq(productsTable.isAvailable, true));
  if (status === "unavailable") filters.push(eq(productsTable.isAvailable, false));
  if (status === "published") filters.push(eq(productsTable.publicationStatus, "published"));
  if (status === "draft") filters.push(eq(productsTable.publicationStatus, "draft"));
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
      items: rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() })),
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
  const [current] = await db.select().from(productsTable).where(eq(productsTable.id, params.data.id));
  if (!current) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const marginPercent = body.data.marginPercent ?? current.marginPercent;
  const calculated = calculatePrice(current.supplierPriceUsd, settings, marginPercent);
  const [updated] = await db
    .update(productsTable)
    .set({ ...body.data, marginPercent, ...calculated, updatedAt: new Date() })
    .where(eq(productsTable.id, params.data.id))
    .returning();
  res.json(UpdateProductResponse.parse({ ...updated, updatedAt: updated.updatedAt.toISOString() }));
});

router.post("/products/:id/publish", async (req, res): Promise<void> => {
  const params = PublishProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [current] = await db.select().from(productsTable).where(eq(productsTable.id, params.data.id));
  if (!current || !current.isAvailable) {
    res.status(409).json({ error: "Only available products can be published" });
    return;
  }
  const [updated] = await db
    .update(productsTable)
    .set({ publicationStatus: "published", updatedAt: new Date() })
    .where(eq(productsTable.id, params.data.id))
    .returning();
  await db.insert(activitiesTable).values({
    type: "publish",
    title: "Товар готов к публикации",
    description: `${updated.name} переведен в статус публикации. Реальная отправка карточки будет включена после проверки категории и контента.`,
    status: "success",
  });
  res.json(PublishProductResponse.parse({ ...updated, updatedAt: updated.updatedAt.toISOString() }));
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
    const data = await fetchGPayProducts(parsed.data.pageSize);
    let imported = 0;
    let updated = 0;
    for (const product of data.products ?? []) {
      if (parsed.data.availableOnly && product.isAvailable !== true) continue;
      const [existing] = await db.select().from(productsTable).where(eq(productsTable.gpayId, product.id));
      const marginPercent = existing?.marginPercent ?? settings.defaultMarginPercent;
      const calculated = calculatePrice(product.currentPartnerPrice, settings, marginPercent);
      const values = {
        gpayId: product.id,
        appId: product.appId ?? null,
        subId: product.subId ?? null,
        name: product.name,
        imageUrl: product.imageUrl ?? null,
        productType: String(product.productType),
        supplierPriceUsd: product.currentPartnerPrice,
        marginPercent,
        ...calculated,
        isAvailable: product.isAvailable === true,
        region: product.region || "Не указан",
        warningMessage: product.warningMessage ?? null,
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
      description: `Добавлено ${imported}, обновлено ${updated} товаров.`,
      status: "success",
    });
    res.json(
      SyncCatalogResponse.parse({
        success: true,
        imported,
        updated,
        disabled: 0,
        message: `Получено ${data.products?.length ?? 0} из ${data.totalCount} товаров`,
        completedAt: new Date().toISOString(),
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "GPay catalog sync failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "GPay API error" });
  }
});

router.get("/activities", async (req, res): Promise<void> => {
  const parsed = ListActivitiesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db.select().from(activitiesTable).orderBy(desc(activitiesTable.createdAt)).limit(parsed.data.limit ?? 20);
  res.json(ListActivitiesResponse.parse(rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))));
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
  const rate = await getOfficialUsdRubRate(settings.usdRubRate);
  if (!rate.isFallback && rate.usdRub !== settings.usdRubRate) {
    await db
      .update(settingsTable)
      .set({ usdRubRate: rate.usdRub, updatedAt: new Date() })
      .where(eq(settingsTable.id, 1));
  }
  res.json(GetExchangeRateResponse.parse(rate));
});

export default router;