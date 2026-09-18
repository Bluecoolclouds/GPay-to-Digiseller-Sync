import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  activitiesTable,
  backgroundJobStateTable,
  db,
  pool,
  productsTable,
  publicationJobsTable,
  settingsTable,
  syncOrderStateTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
} from "@workspace/db";
import app from "../app";
import {
  fetchDigisellerSalesPage,
  selectCataloguerAttributes,
} from "../lib/digiseller";
import { applyPricingSettings, syncKeyPrices } from "../lib/price-sync";
import { fetchGPayProducts } from "../lib/gpay";
import { clearOfficialUsdRubRateCache } from "../lib/exchange-rate";
import {
  recordDigisellerProductIds,
  syncDigisellerOrders,
  upsertDigisellerSales,
} from "../lib/orders";

const fixtureIds = [2_140_001_001, 2_140_001_002, 2_140_001_003];
const [keyGpayId, giftGpayId, unknownGpayId] = fixtureIds;
const originalFetch = globalThis.fetch;
afterEach(() => {
  fetchOverride = undefined;
});

let baseUrl = "";
let server: ReturnType<typeof app.listen>;
let fetchOverride:
  | ((
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => Promise<Response>)
  | undefined;

const catalog = [
  {
    id: keyGpayId,
    name: "Regression key updated",
    productType: 2,
    currentPartnerPrice: 21,
    isAvailable: true,
    region: "Global",
  },
  {
    id: giftGpayId,
    name: "Regression gift updated",
    productType: 1,
    currentPartnerPrice: 31,
    isAvailable: true,
    region: "Global",
  },
  {
    id: unknownGpayId,
    name: "Regression unknown updated",
    productType: 77,
    currentPartnerPrice: 41,
    isAvailable: true,
    region: "Global",
  },
];

test("cataloguer attributes select platform, content type, and explicit edition", () => {
  const attributes = [
    {
      attribute_id: 10,
      name: [{ locale: "ru-RU", value: "Платформа" }],
      values: [
        {
          attribute_value_id: 101,
          name: [{ locale: "en-US", value: "Steam" }],
        },
        {
          attribute_value_id: 102,
          name: [{ locale: "en-US", value: "Xbox" }],
        },
      ],
    },
    {
      attribute_id: 20,
      name: [{ locale: "ru-RU", value: "Тип контента" }],
      values: [
        {
          attribute_value_id: 201,
          name: [{ locale: "ru-RU", value: "Ключи" }],
        },
        {
          attribute_value_id: 202,
          name: [{ locale: "ru-RU", value: "Гифты" }],
        },
      ],
    },
    {
      attribute_id: 30,
      name: [{ locale: "ru-RU", value: "Издание" }],
      values: [
        {
          attribute_value_id: 301,
          name: [{ locale: "en-US", value: "Deluxe" }],
        },
        {
          attribute_value_id: 302,
          name: [{ locale: "en-US", value: "Standard" }],
        },
      ],
    },
  ];

  assert.deepEqual(
    selectCataloguerAttributes(attributes, {
      name: "Example Game Deluxe | Steam ключ",
      productType: "2",
    }),
    [
      { attribute_id: 10, attribute_value_id: 101 },
      { attribute_id: 20, attribute_value_id: 201 },
      { attribute_id: 30, attribute_value_id: 301 },
    ],
  );
});

async function cleanup() {
  await db.delete(productsTable).where(inArray(productsTable.gpayId, fixtureIds));
}

async function seedProducts() {
  await cleanup();
  await db.insert(productsTable).values([
    {
      gpayId: keyGpayId,
      name: "Regression key original",
      productType: "2",
      supplierPriceUsd: 11,
      salePriceRub: 1100,
      marginPercent: 15,
      profitRub: 100,
      isAvailable: true,
    },
    {
      gpayId: giftGpayId,
      name: "Regression gift original",
      productType: "1",
      supplierPriceUsd: 12,
      salePriceRub: 1200,
      marginPercent: 15,
      profitRub: 100,
      isAvailable: true,
    },
    {
      gpayId: unknownGpayId,
      name: "Regression unknown original",
      productType: "77",
      supplierPriceUsd: 13,
      salePriceRub: 1300,
      marginPercent: 15,
      profitRub: 100,
      isAvailable: true,
    },
  ]);
}

async function allowlistProductsByGpayIds(gpayIds: number[]) {
  const products = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(inArray(productsTable.gpayId, gpayIds));
  await db
    .update(settingsTable)
    .set({ autonomousAllowlist: JSON.stringify(products.map((product) => product.id)) })
    .where(eq(settingsTable.id, 1));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await originalFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

async function productNames() {
  const rows = await db
    .select({ gpayId: productsTable.gpayId, name: productsTable.name })
    .from(productsTable)
    .where(inArray(productsTable.gpayId, fixtureIds));
  return new Map(rows.map((row) => [row.gpayId, row.name]));
}

before(async () => {
  assert.match(
    process.env.TEST_DATABASE_SCHEMA ?? "",
    /^sync_product_types_test_[a-f0-9]+$/,
    "Tests must run in the isolated schema created by test-environment.ts",
  );
  const databaseContext = await db.execute<{ currentSchema: string }>(
    sql`select current_schema() as "currentSchema"`,
  );
  assert.equal(
    databaseContext.rows[0]?.currentSchema,
    process.env.TEST_DATABASE_SCHEMA,
  );

  process.env.GPAY_LOGIN ||= "test-login";
  process.env.GPAY_PASSWORD ||= "test-password";
  globalThis.fetch = async (input, init) => {
    if (fetchOverride) return fetchOverride(input, init);
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.ok(
        body.productType === undefined ||
          body.productType === 1 ||
          body.productType === 2,
      );
      return Response.json({
        status: "success",
        data: {
          products: [catalog[body.page - 1]].filter(Boolean),
          totalCount: catalog.length,
          page: body.page,
          pageSize: body.pageSize,
        },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/seller-goods")) {
      return Response.json({ retval: 0, rows: [], pages: 1 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  await seedProducts();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
});

test("list endpoint filters key, gift, all, and unknown product types", async () => {
  const expectations = {
    key: [[keyGpayId, "key"]],
    gift: [[giftGpayId, "gift"]],
    unknown: [[unknownGpayId, "unknown"]],
    all: [
      [keyGpayId, "key"],
      [giftGpayId, "gift"],
      [unknownGpayId, "unknown"],
    ],
  } as const;

  for (const [kind, expected] of Object.entries(expectations)) {
    const body = await request<{
      items: Array<{ gpayId: number; productKind: string }>;
    }>(
      `/api/products?productKind=${kind}&pageSize=100&search=Regression`,
    );
    const actual = body.items
      .map((item: { gpayId: number; productKind: string }) => [
        item.gpayId,
        item.productKind,
      ])
      .sort((a: [number, string], b: [number, string]) => a[0] - b[0]);
    assert.deepEqual(actual, [...expected].sort((a, b) => a[0] - b[0]));
  }
});

test("bulk margin update recalculates every selected draft atomically", async () => {
  await seedProducts();
  const selectedIds = await db
    .select({ id: productsTable.id, gpayId: productsTable.gpayId })
    .from(productsTable)
    .where(inArray(productsTable.gpayId, [keyGpayId, giftGpayId]));
  const result = await request<{
    updated: number;
    publishedUpdated: number;
    marginPercent: number;
  }>("/api/products/bulk-margin", {
    method: "POST",
    body: JSON.stringify({
      productIds: selectedIds.map((product) => product.id),
      marginPercent: 27.5,
    }),
  });
  const updated = await db
    .select()
    .from(productsTable)
    .where(inArray(productsTable.gpayId, [keyGpayId, giftGpayId]));

  assert.equal(result.updated, 2);
  assert.equal(result.publishedUpdated, 0);
  assert.equal(result.marginPercent, 27.5);
  assert.ok(updated.every((product) => product.marginPercent === 27.5));
  assert.ok(updated.every((product) => product.profitRub >= 100));
  assert.ok(updated.every((product) => product.salePriceRub > 0));
});

test("emergency pause rejects bulk margin changes without touching products", async () => {
  await seedProducts();
  const [selected] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));
  await db
    .update(settingsTable)
    .set({ autonomousPaused: true })
    .where(eq(settingsTable.id, 1));

  try {
    const response = await originalFetch(`${baseUrl}/api/products/bulk-margin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productIds: [selected.id],
        marginPercent: 42,
      }),
    });
    const body = (await response.json()) as { error?: string };
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, selected.id));

    assert.equal(response.status, 409);
    assert.match(body.error ?? "", /приостановлены оператором/i);
    assert.equal(saved.marginPercent, 15);
  } finally {
    await db
      .update(settingsTable)
      .set({ autonomousPaused: false })
      .where(eq(settingsTable.id, 1));
  }
});

test("manual mode can pass preflight after a recent skipped price-sync run", async () => {
  const now = new Date();
  const preflightGpayIds = Array.from(
    { length: 5 },
    (_, index) => 1_150_001_000 + index,
  );
  await db.delete(productsTable).where(inArray(productsTable.gpayId, preflightGpayIds));
  const products = await db
    .insert(productsTable)
    .values(
      preflightGpayIds.map((gpayId, index) => ({
        gpayId,
        digisellerId: 1_950_001_000 + index,
        name: `Preflight key ${index + 1}`,
        productType: "2",
        supplierPriceUsd: 1,
        salePriceRub: 200,
        marginPercent: 15,
        profitRub: 100,
        isAvailable: true,
        publicationStatus: "published" as const,
      })),
    )
    .returning({ id: productsTable.id });
  await db
    .update(settingsTable)
    .set({
      automationMode: "manual",
      exchangeRateMode: "manual",
      usdRubRate: 92,
      autonomousAllowlist: JSON.stringify(products.map((product) => product.id)),
      launchPreflightAt: null,
    })
    .where(eq(settingsTable.id, 1));
  await db.delete(backgroundJobStateTable);
  await db.insert(backgroundJobStateTable).values([
    {
      name: "scheduler",
      intervalSeconds: 30,
      lastHeartbeatAt: now,
    },
    ...(["purchase-reconciliation", "order-sync", "digiseller-chat"] as const).map(
      (name) => ({
        name,
        intervalSeconds: 60,
        lastHeartbeatAt: now,
        lastStartedAt: now,
        lastSuccessfulAt: now,
        lastFinishedAt: now,
      }),
    ),
    {
      name: "price-sync",
      intervalSeconds: 60 * 60,
      lastHeartbeatAt: now,
      lastStartedAt: now,
      lastSuccessfulAt: null,
      lastFinishedAt: now,
      lastResult: JSON.stringify({ skipped: true }),
    },
  ]);

  try {
    const result = await request<{
      passed: boolean;
      checks: { workers: boolean };
    }>("/api/autonomous/preflight");
    const [settings] = await db
      .select({ launchPreflightAt: settingsTable.launchPreflightAt })
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));

    assert.equal(result.passed, true);
    assert.equal(result.checks.workers, true);
    assert.ok(settings.launchPreflightAt);
  } finally {
    await db.delete(productsTable).where(inArray(productsTable.gpayId, preflightGpayIds));
    await db.delete(backgroundJobStateTable);
  }
});

test("failed autonomous preflight invalidates an earlier successful check", async () => {
  const previousCheck = new Date();
  await db
    .update(settingsTable)
    .set({
      autonomousAllowlist: "[]",
      exchangeRateMode: "manual",
      usdRubRate: 92,
      launchPreflightAt: previousCheck,
    })
    .where(eq(settingsTable.id, 1));

  const result = await request<{ passed: boolean }>("/api/autonomous/preflight");
  const [settings] = await db
    .select({ launchPreflightAt: settingsTable.launchPreflightAt })
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));

  assert.equal(result.passed, false);
  assert.equal(settings.launchPreflightAt, null);
});

test("filtered margin update reports exact totals and changes only matching products", async () => {
  await seedProducts();
  await db
    .update(productsTable)
    .set({
      digisellerId: 1_914_001_001,
      publicationStatus: "published",
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  usePriceSyncResponses({ Status: 3, ErrorCount: 0 });

  try {
    const summary = await request<{ total: number; published: number }>(
      "/api/products/bulk-margin-summary?search=Regression&productKind=key",
    );
    const result = await request<{
      updated: number;
      publishedUpdated: number;
      marginPercent: number;
    }>("/api/products/bulk-margin", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          search: "Regression",
          status: "all",
          productKind: "key",
        },
        marginPercent: 31,
      }),
    });
    const products = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.gpayId, fixtureIds));
    const key = products.find((product) => product.gpayId === keyGpayId);
    const untouched = products.filter((product) => product.gpayId !== keyGpayId);

    assert.deepEqual(summary, { total: 1, published: 1 });
    assert.equal(result.updated, 1);
    assert.equal(result.publishedUpdated, 1);
    assert.equal(key?.marginPercent, 31);
    assert.ok(untouched.every((product) => product.marginPercent === 15));
  } finally {
    fetchOverride = undefined;
  }
});

test("dashboard creates a warning after repeated price task timeouts and clears it after success", async () => {
  await db.delete(activitiesTable).where(eq(activitiesTable.type, "price"));
  const timeoutDescription = (count: number, error: string) =>
    `Проверено ${count}, изменилось ${count}, обновлено в Digiseller 0, ошибок ${count}. Тайм-аут задачи Digiseller: затронуто ${count}. Последняя ошибка: ${error}`;

  await db.insert(activitiesTable).values({
    type: "price",
    title: "Автоматическая проверка цен завершена",
    description: timeoutDescription(
      2,
      "Digiseller #102: Digiseller не завершил обновление цен за 60 секунд",
    ),
    status: "warning",
  });

  let dashboard = await request<{
    priceTimeoutWarning: null | {
      affectedProductCount: number;
      latestError: string;
    };
  }>("/api/dashboard");
  assert.equal(dashboard.priceTimeoutWarning, null);

  await db.insert(activitiesTable).values({
    type: "price",
    title: "Автоматическая проверка цен завершена",
    description: timeoutDescription(
      3,
      "Digiseller #203: Digiseller не завершил обновление цен за 60 секунд",
    ),
    status: "warning",
  });

  dashboard = await request("/api/dashboard");
  assert.deepEqual(dashboard.priceTimeoutWarning, {
    affectedProductCount: 3,
    latestError:
      "Digiseller #203: Digiseller не завершил обновление цен за 60 секунд",
  });

  await db.insert(activitiesTable).values({
    type: "price",
    title: "Автоматическая проверка цен завершена",
    description:
      "Проверено 3, изменилось 3, обновлено в Digiseller 3, ошибок 0.",
    status: "success",
  });

  dashboard = await request("/api/dashboard");
  assert.equal(dashboard.priceTimeoutWarning, null);
});

test("key sync changes only keys", async () => {
  await seedProducts();
  const body = await request<{ productKind: string; updated: number }>("/api/sync/catalog", {
    method: "POST",
    body: JSON.stringify({ productKind: "key", pageSize: 1 }),
  });
  assert.equal(body.productKind, "key");
  assert.equal(body.updated, 1);

  const names = await productNames();
  assert.equal(names.get(keyGpayId), "Regression key updated");
  assert.equal(names.get(giftGpayId), "Regression gift original");
  assert.equal(names.get(unknownGpayId), "Regression unknown original");
});

test("gift sync changes only gifts", async () => {
  await seedProducts();
  const body = await request<{ productKind: string; updated: number }>("/api/sync/catalog", {
    method: "POST",
    body: JSON.stringify({ productKind: "gift", pageSize: 1 }),
  });
  assert.equal(body.productKind, "gift");
  assert.equal(body.updated, 1);

  const names = await productNames();
  assert.equal(names.get(keyGpayId), "Regression key original");
  assert.equal(names.get(giftGpayId), "Regression gift updated");
  assert.equal(names.get(unknownGpayId), "Regression unknown original");
});

test("all sync persists and counts unique key, gift, and unknown products", async () => {
  await seedProducts();
  const body = await request<{ productKind: string; updated: number }>("/api/sync/catalog", {
    method: "POST",
    body: JSON.stringify({ productKind: "all", pageSize: 1 }),
  });
  assert.equal(body.productKind, "all");
  assert.equal(body.updated, 3);

  const names = await productNames();
  assert.equal(names.get(keyGpayId), "Regression key updated");
  assert.equal(names.get(giftGpayId), "Regression gift updated");
  assert.equal(names.get(unknownGpayId), "Regression unknown updated");
});

test("settings save applies the exact live rate approved by preview", async () => {
  clearOfficialUsdRubRateCache();
  await seedProducts();
  const candidate = {
    defaultMarginPercent: 15,
    usdRubRate: 50,
    exchangeRateMode: "cbr" as const,
    conversionMarkupPercent: 2,
    digisellerFeePercent: 5,
    fixedReserveRub: 30,
    minimumProfitRub: 100,
    automationMode: "manual" as const,
    disableOnUnavailable: true,
  };
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("bestchange.app")) {
      return Response.json({
        rates: {
          "21-10": [
            { rate: 95, reserve: 10_000 },
            { rate: 95, reserve: 10_000 },
            { rate: 95, reserve: 10_000 },
          ],
        },
      });
    }
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        status: "success",
        data: {
          products: [{
            id: keyGpayId,
            name: "Regression key updated",
            productType: 2,
            currentPartnerPrice: 21,
            isAvailable: true,
          }],
          totalCount: 1,
          page: body.page,
          pageSize: body.pageSize,
        },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const preview = await request<{
      usdRubRate: number;
      previewToken: string;
    }>("/api/settings/preview", {
      method: "POST",
      body: JSON.stringify(candidate),
    });
    assert.equal(preview.usdRubRate, 95);
    assert.ok(preview.previewToken);

    const saved = await request<{ usdRubRate: number }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ ...candidate, previewToken: preview.previewToken }),
    });
    assert.equal(saved.usdRubRate, preview.usdRubRate);

    const [settings] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));
    assert.equal(settings.usdRubRate, preview.usdRubRate);

    const rejected = await originalFetch(`${baseUrl}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...candidate,
        minimumProfitRub: 101,
        previewToken: preview.previewToken,
      }),
    });
    assert.equal(rejected.status, 409);

    const nextCandidate = {
      ...candidate,
      exchangeRateMode: "manual" as const,
      usdRubRate: 96,
      minimumProfitRub: 120,
    };
    const nextPreview = await request<{ previewToken: string }>(
      "/api/settings/preview",
      {
        method: "POST",
        body: JSON.stringify(nextCandidate),
      },
    );
    const lockClient = await pool.connect();
    await lockClient.query("select pg_advisory_lock($1)", [704_291_163]);
    try {
      const busy = await originalFetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...nextCandidate,
          previewToken: nextPreview.previewToken,
        }),
      });
      assert.equal(busy.status, 409);
    } finally {
      await lockClient.query("select pg_advisory_unlock($1)", [704_291_163]);
      lockClient.release();
    }
    const [afterBusy] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));
    assert.equal(afterBusy.usdRubRate, 95);
    assert.equal(afterBusy.minimumProfitRub, 100);
  } finally {
    fetchOverride = undefined;
  }
});

async function preparePublishedPriceFixture() {
  await seedProducts();
  await db
    .update(productsTable)
    .set({
      digisellerId: 1_914_001_001,
      publicationStatus: "published",
      supplierPriceUsd: 11,
      salePriceRub: 1100,
    })
    .where(inArray(productsTable.gpayId, [keyGpayId]));
  await db
    .insert(settingsTable)
    .values({ id: 1, automationMode: "automatic", exchangeRateMode: "manual" })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { automationMode: "automatic", exchangeRateMode: "manual" },
    });
  await allowlistProductsByGpayIds([keyGpayId]);
}

function usePriceSyncResponses(status: Record<string, unknown>) {
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: {
          products: [
            {
              id: keyGpayId,
              name: "Regression key original",
              productType: 2,
              currentPartnerPrice: 21,
              isAvailable: true,
              region: "Global",
            },
          ],
          totalCount: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/prices")) {
      return new Response("12345678-1234-1234-1234-123456789abc");
    }
    if (url.includes("/UpdateProductsTaskStatus")) {
      return Response.json(status);
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
}

test("published price is saved locally only after Digiseller confirms success", async () => {
  await preparePublishedPriceFixture();
  usePriceSyncResponses({ Status: 3, ErrorCount: 0 });

  try {
    const result = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.gpayId, [keyGpayId]));

    assert.equal(result.digisellerUpdated, 1);
    assert.equal(result.failed, 0);
    assert.equal(saved.supplierPriceUsd, 21);
    assert.notEqual(saved.salePriceRub, 1100);
  } finally {
    fetchOverride = undefined;
  }
});

test("non-allowlisted published price remains unchanged locally and remotely", async () => {
  await preparePublishedPriceFixture();
  await db
    .update(settingsTable)
    .set({ autonomousAllowlist: "[]" })
    .where(eq(settingsTable.id, 1));
  usePriceSyncResponses({ Status: 3, ErrorCount: 0 });

  try {
    const result = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));

    assert.equal(result.changed, 1);
    assert.equal(result.digisellerUpdated, 0);
    assert.equal(saved.supplierPriceUsd, 11);
    assert.equal(saved.salePriceRub, 1100);
    assert.equal(saved.isAvailable, true);
  } finally {
    fetchOverride = undefined;
  }
});

test("single published margin update reaches Digiseller before local save", async () => {
  await preparePublishedPriceFixture();
  usePriceSyncResponses({ Status: 3, ErrorCount: 0 });
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const updated = await request<{
      marginPercent: number;
      salePriceRub: number;
    }>(`/api/products/${before.id}`, {
      method: "PATCH",
      body: JSON.stringify({ marginPercent: 33 }),
    });
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, before.id));

    assert.equal(updated.marginPercent, 33);
    assert.equal(saved.marginPercent, 33);
    assert.notEqual(saved.salePriceRub, before.salePriceRub);
    assert.equal(updated.salePriceRub, saved.salePriceRub);
  } finally {
    fetchOverride = undefined;
  }
});

test("single published margin update keeps previous local values when Digiseller rejects it", async () => {
  await preparePublishedPriceFixture();
  usePriceSyncResponses({
    Status: 2,
    ErrorCount: 1,
    ErrorsDescriptions: [
      { Key: "1914001001", Value: "Digiseller rejected margin price" },
    ],
  });
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const response = await originalFetch(`${baseUrl}/api/products/${before.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marginPercent: 44 }),
    });
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, before.id));

    assert.equal(response.status, 409);
    assert.equal(saved.marginPercent, before.marginPercent);
    assert.equal(saved.salePriceRub, before.salePriceRub);
    assert.equal(saved.profitRub, before.profitRub);
  } finally {
    fetchOverride = undefined;
  }
});

test("published category change disables the old Digiseller card before saving the new category", async () => {
  await preparePublishedPriceFixture();
  const oldCategoryId = 87_655;
  const newCategoryId = 87_656;
  await db
    .update(productsTable)
    .set({
      platiCategoryId: oldCategoryId,
      digisellerDeliveryType: "code",
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  let disabled = false;
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/uniquefixed/1914001001")) {
      const payload = JSON.parse(String(init?.body)) as {
        enabled?: boolean;
        categories?: Array<{ category_id?: number }>;
      };
      disabled = payload.enabled === false;
      assert.deepEqual(payload.categories, [
        { owner: 0, category_id: oldCategoryId },
      ]);
      return Response.json({ retval: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const updated = await request<{
      platiCategoryId: number;
      publicationStatus: string;
    }>(`/api/products/${before.id}`, {
      method: "PATCH",
      body: JSON.stringify({ platiCategoryId: newCategoryId }),
    });
    const activities = await request<Array<{
      type: string;
      status: string;
      description: string;
    }>>("/api/activities?limit=1");
    const [activity] = activities;

    assert.equal(disabled, true);
    assert.equal(updated.platiCategoryId, newCategoryId);
    assert.equal(updated.publicationStatus, "draft");
    assert.equal(activity.type, "category");
    assert.equal(activity.status, "success");
    assert.match(activity.description, /1914001001/);
    assert.match(activity.description, /87655.*87656/);
  } finally {
    fetchOverride = undefined;
  }
});

test("published category change keeps local category and status when Digiseller cannot disable the old card", async () => {
  await preparePublishedPriceFixture();
  const oldCategoryId = 87_655;
  await db
    .update(productsTable)
    .set({
      platiCategoryId: oldCategoryId,
      digisellerDeliveryType: "code",
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/uniquefixed/1914001001")) {
      return Response.json({
        retval: 1,
        retdesc: "Old category card could not be disabled",
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const response = await originalFetch(`${baseUrl}/api/products/${before.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platiCategoryId: 87_656 }),
    });
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, before.id));
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.id))
      .limit(1);

    assert.equal(response.status, 502);
    assert.equal(saved.platiCategoryId, oldCategoryId);
    assert.equal(saved.publicationStatus, "published");
    assert.equal(activity.type, "category");
    assert.equal(activity.status, "error");
    assert.match(activity.description, /1914001001/);
    assert.match(activity.description, /Old category card could not be disabled/);
  } finally {
    fetchOverride = undefined;
  }
});

test("published category change completes after a timed-out disable is confirmed externally", async () => {
  await preparePublishedPriceFixture();
  const oldCategoryId = 87_655;
  const newCategoryId = 87_656;
  await db
    .update(productsTable)
    .set({
      platiCategoryId: oldCategoryId,
      digisellerDeliveryType: "code",
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/uniquefixed/1914001001")) {
      throw new DOMException("The operation timed out", "TimeoutError");
    }
    if (url.includes("/api/seller-goods")) {
      return Response.json({
        retval: 0,
        pages: 1,
        rows: [{ id_goods: 1_914_001_001, visible: 0 }],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const updated = await request<{
      platiCategoryId: number;
      publicationStatus: string;
    }>(`/api/products/${before.id}`, {
      method: "PATCH",
      body: JSON.stringify({ platiCategoryId: newCategoryId }),
    });

    assert.equal(updated.platiCategoryId, newCategoryId);
    assert.equal(updated.publicationStatus, "draft");
  } finally {
    fetchOverride = undefined;
  }
});

test("published category change stays unchanged when the old card remains active after timeout", async () => {
  await preparePublishedPriceFixture();
  const oldCategoryId = 87_655;
  await db
    .update(productsTable)
    .set({
      platiCategoryId: oldCategoryId,
      digisellerDeliveryType: "code",
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/uniquefixed/1914001001")) {
      throw new DOMException("The operation timed out", "TimeoutError");
    }
    if (url.includes("/api/seller-goods")) {
      return Response.json({
        retval: 0,
        pages: 1,
        rows: [{ id_goods: 1_914_001_001, visible: 1 }],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  const [before] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.gpayId, keyGpayId));

  try {
    const response = await originalFetch(`${baseUrl}/api/products/${before.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platiCategoryId: 87_656 }),
    });
    const responseBody = (await response.json()) as { error?: string };
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, before.id));

    assert.equal(response.status, 502);
    assert.match(responseBody.error ?? "", /остаётся активной/);
    assert.equal(saved.platiCategoryId, oldCategoryId);
    assert.equal(saved.publicationStatus, "published");
  } finally {
    fetchOverride = undefined;
  }
});

test("automatic price sync stops before changes when the live rate is unavailable", async () => {
  clearOfficialUsdRubRateCache();
  await preparePublishedPriceFixture();
  await db
    .update(settingsTable)
    .set({ exchangeRateMode: "cbr" })
    .where(eq(settingsTable.id, 1));
  let gpayCalls = 0;
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("bestchange.app")) {
      return new Response("Unavailable", { status: 503 });
    }
    if (url.includes("gpay.market")) gpayCalls++;
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const result = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.type, "price"))
      .orderBy(desc(activitiesTable.createdAt))
      .limit(1);

    assert.equal(result.skipped, true);
    assert.equal(result.failed, 1);
    assert.equal(gpayCalls, 0);
    assert.equal(saved.salePriceRub, 1100);
    assert.equal(activity.status, "warning");
    assert.match(activity.description, /актуальный курс.*недоступен/i);
  } finally {
    fetchOverride = undefined;
    await db
      .update(settingsTable)
      .set({ exchangeRateMode: "manual" })
      .where(eq(settingsTable.id, 1));
  }
});

test("an incomplete GPay catalog snapshot is rejected", async () => {
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: {
          products: [],
          totalCount: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    await assert.rejects(
      fetchGPayProducts(100, "key"),
      /получен не полностью/,
    );
  } finally {
    fetchOverride = undefined;
  }
});

test("overlapping GPay catalog pages are rejected before availability changes", async () => {
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      const { page, pageSize } = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        status: "success",
        data: {
          products: [{
            id: keyGpayId,
            name: `Repeated page ${page}`,
            productType: 2,
            currentPartnerPrice: 10,
            isAvailable: true,
          }],
          totalCount: 2,
          page,
          pageSize,
        },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    await assert.rejects(
      fetchGPayProducts(1, "key"),
      /повторяющиеся товары/,
    );
  } finally {
    fetchOverride = undefined;
  }
});

test("per-product Digiseller failure leaves the previous local price unchanged", async () => {
  await preparePublishedPriceFixture();
  usePriceSyncResponses({
    Status: 2,
    ErrorCount: 1,
    ErrorsDescriptions: [
      { Key: "1914001001", Value: "Digiseller rejected this product" },
    ],
  });

  try {
    const result = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.gpayId, [keyGpayId]));

    assert.equal(result.digisellerUpdated, 0);
    assert.equal(result.failed, 1);
    assert.equal(saved.supplierPriceUsd, 11);
    assert.equal(saved.salePriceRub, 1100);
  } finally {
    fetchOverride = undefined;
  }
});

test("failed settings application rolls Digiseller back and keeps active rules unchanged", async () => {
  await preparePublishedPriceFixture();
  const [beforeSettings] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, 1));
  let priceEditCalls = 0;
  let statusCalls = 0;
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: {
          products: [{
            id: keyGpayId,
            name: "Regression key original",
            productType: 2,
            currentPartnerPrice: 21,
            isAvailable: true,
          }],
          totalCount: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/prices")) {
      priceEditCalls++;
      return new Response("12345678-1234-1234-1234-123456789abc");
    }
    if (url.includes("/UpdateProductsTaskStatus")) {
      statusCalls++;
      return Response.json(
        statusCalls === 1
          ? {
              Status: 2,
              ErrorCount: 1,
              ErrorsDescriptions: [{
                Key: "1914001001",
                Value: "Rejected candidate price",
              }],
            }
          : { Status: 3, ErrorCount: 0 },
      );
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const application = await applyPricingSettings(
      {
        defaultMarginPercent: beforeSettings.defaultMarginPercent,
        usdRubRate: beforeSettings.usdRubRate,
        exchangeRateMode: "manual",
        conversionMarkupPercent: beforeSettings.conversionMarkupPercent,
        digisellerFeePercent: beforeSettings.digisellerFeePercent,
        fixedReserveRub: beforeSettings.fixedReserveRub,
        minimumProfitRub: beforeSettings.minimumProfitRub + 50,
        automationMode: "manual",
        disableOnUnavailable: beforeSettings.disableOnUnavailable,
      },
      beforeSettings.usdRubRate,
    );
    const [afterSettings] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.id, 1));
    const [product] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));

    assert.equal(application.applied, false);
    assert.equal(priceEditCalls, 2);
    assert.equal(afterSettings.minimumProfitRub, beforeSettings.minimumProfitRub);
    assert.equal(product.salePriceRub, 1100);
  } finally {
    fetchOverride = undefined;
  }
});

test("hourly sync disables missing keys and re-enables them only after confirmed availability", async () => {
  const digisellerId = 1_914_001_001;
  await preparePublishedPriceFixture();
  await db
    .update(productsTable)
    .set({
      digisellerDeliveryType: "code",
      platiCategoryId: 87_655,
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  let supplierAvailable = false;
  const enabledCalls: boolean[] = [];

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: {
          products: supplierAvailable
            ? [{
                id: keyGpayId,
                name: "Regression key original",
                productType: 2,
                currentPartnerPrice: 11,
                isAvailable: true,
                region: "Global",
              }]
            : [],
          totalCount: supplierAvailable ? 1 : 0,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes(`/api/product/edit/uniquefixed/${digisellerId}`)) {
      const payload = JSON.parse(String(init?.body)) as { enabled?: boolean };
      enabledCalls.push(payload.enabled === true);
      return Response.json({ retval: 0 });
    }
    if (url.includes("/api/product/edit/prices")) {
      return new Response("12345678-1234-1234-1234-123456789abc");
    }
    if (url.includes("/UpdateProductsTaskStatus")) {
      return Response.json({ Status: 3, ErrorCount: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const disabled = await syncKeyPrices();
    const [afterDisable] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));
    assert.deepEqual(enabledCalls, [false]);
    assert.equal(disabled.failed, 0);
    assert.equal(afterDisable.isAvailable, false);
    assert.match(afterDisable.warningMessage ?? "", /исчез из каталога GPay/);

    await syncKeyPrices();
    assert.deepEqual(enabledCalls, [false]);

    supplierAvailable = true;
    const enabled = await syncKeyPrices();
    const [afterEnable] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));
    assert.deepEqual(enabledCalls, [false, true]);
    assert.equal(enabled.failed, 0);
    assert.equal(afterEnable.isAvailable, true);
  } finally {
    fetchOverride = undefined;
  }
});

test("failed Digiseller disable remains retryable and visible in activities", async () => {
  const digisellerId = 1_914_001_001;
  await preparePublishedPriceFixture();
  await db
    .update(productsTable)
    .set({
      digisellerDeliveryType: "code",
      platiCategoryId: 87_655,
    })
    .where(eq(productsTable.gpayId, keyGpayId));
  let disableAttempts = 0;

  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: { products: [], totalCount: 0, page: 1, pageSize: 100 },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes(`/api/product/edit/uniquefixed/${digisellerId}`)) {
      disableAttempts++;
      return Response.json({ retval: 1, retdesc: "Disable rejected" });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const first = await syncKeyPrices();
    const second = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .orderBy(desc(activitiesTable.createdAt))
      .limit(1);

    assert.equal(disableAttempts, 2);
    assert.equal(first.failed, 1);
    assert.equal(second.failed, 1);
    assert.match(first.errors?.[0] ?? "", /Disable rejected/);
    assert.equal(saved.isAvailable, true);
    assert.equal(activity.status, "warning");
    assert.match(activity.description, /Disable rejected/);
  } finally {
    fetchOverride = undefined;
  }
});

test("disableOnUnavailable false records unavailability without editing Digiseller", async () => {
  await preparePublishedPriceFixture();
  await db
    .update(settingsTable)
    .set({ disableOnUnavailable: false })
    .where(eq(settingsTable.id, 1));
  let digisellerCalls = 0;

  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: { products: [], totalCount: 0, page: 1, pageSize: 100 },
      });
    }
    if (url.includes("digiseller.com")) {
      digisellerCalls++;
      return Response.json({ retval: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const result = await syncKeyPrices();
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.gpayId, keyGpayId));
    assert.equal(result.failed, 0);
    assert.equal(digisellerCalls, 0);
    assert.equal(saved.isAvailable, false);
  } finally {
    fetchOverride = undefined;
    await db
      .update(settingsTable)
      .set({ disableOnUnavailable: true })
      .where(eq(settingsTable.id, 1));
  }
});

test("a failed price batch does not prevent later batches from saving", async () => {
  const batchGpayIds = Array.from(
    { length: 101 },
    (_, index) => 2_130_000_000 + index,
  );
  const digisellerOffset = 1_920_000_000;
  const previousSupplierPrice = 10;
  const previousSalePrice = 1000;
  const submittedBatches: number[][] = [];

  await cleanup();
  await db.delete(productsTable).where(inArray(productsTable.gpayId, batchGpayIds));
  await db.insert(productsTable).values(
    batchGpayIds.map((gpayId, index) => ({
      gpayId,
      digisellerId: digisellerOffset + index,
      name: `Batch regression product ${index + 1}`,
      productType: "2",
      publicationStatus: "published" as const,
      supplierPriceUsd: previousSupplierPrice,
      salePriceRub: previousSalePrice,
      marginPercent: 15,
      profitRub: 100,
      isAvailable: true,
    })),
  );
  await db
    .insert(settingsTable)
    .values({ id: 1, automationMode: "automatic", exchangeRateMode: "manual" })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { automationMode: "automatic", exchangeRateMode: "manual" },
    });
  await allowlistProductsByGpayIds(batchGpayIds);

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      const { page, pageSize } = JSON.parse(String(init?.body ?? "{}"));
      const start = (page - 1) * pageSize;
      return Response.json({
        status: "success",
        data: {
          products: batchGpayIds.slice(start, start + pageSize).map((id, index) => ({
            id,
            name: `Batch regression product ${start + index + 1}`,
            productType: 2,
            currentPartnerPrice: 20 + (start + index) / 100,
            isAvailable: true,
            region: "Global",
          })),
          totalCount: batchGpayIds.length,
          page,
          pageSize,
        },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/edit/prices")) {
      const submitted = JSON.parse(String(init?.body ?? "[]")) as Array<{
        product_id: number;
      }>;
      submittedBatches.push(submitted.map(({ product_id }) => product_id));
      if (submittedBatches.length === 1) {
        return new Response("First batch unavailable", { status: 503 });
      }
      return new Response("12345678-1234-1234-1234-123456789abc");
    }
    if (url.includes("/UpdateProductsTaskStatus")) {
      return Response.json({ Status: 3, ErrorCount: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const result = await syncKeyPrices();
    const saved = await db
      .select()
      .from(productsTable)
      .where(inArray(productsTable.gpayId, batchGpayIds));
    const [activity] = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.type, "price"))
      .orderBy(desc(activitiesTable.createdAt))
      .limit(1);
    const failedIds = new Set(submittedBatches[0]);
    const successfulIds = new Set(submittedBatches[1]);

    assert.deepEqual(
      submittedBatches.map((batch) => batch.length),
      [100, 1],
    );
    assert.equal(result.checked, 101);
    assert.equal(result.changed, 101);
    assert.equal(result.digisellerUpdated, 1);
    assert.equal(result.failed, 100);
    assert.equal(result.errors?.length, 100);
    assert.match(result.errors?.[0] ?? "", /First batch unavailable/);

    for (const product of saved) {
      if (failedIds.has(product.digisellerId!)) {
        assert.equal(product.supplierPriceUsd, previousSupplierPrice);
        assert.equal(product.salePriceRub, previousSalePrice);
      } else {
        assert.ok(successfulIds.has(product.digisellerId!));
        assert.notEqual(product.supplierPriceUsd, previousSupplierPrice);
        assert.notEqual(product.salePriceRub, previousSalePrice);
      }
    }

    assert.equal(activity.status, "warning");
    assert.match(
      activity.description,
      /Проверено 101, изменилось 101, обновлено в Digiseller 1, ошибок 100\./,
    );
    assert.match(activity.description, /First batch unavailable/);
  } finally {
    fetchOverride = undefined;
    await db
      .delete(productsTable)
      .where(inArray(productsTable.gpayId, batchGpayIds));
    await seedProducts();
  }
});

test("category retry creates one Digiseller product after the category is accepted", async () => {
  const retryGpayId = 2_140_001_021;
  const createdDigisellerId = 1_940_001_021;
  const verifiedCategoryId = 87_654;
  let createCalls = 0;
  let contentCalls = 0;

  await db.delete(productsTable).where(eq(productsTable.gpayId, retryGpayId));
  const [fixture] = await db
    .insert(productsTable)
    .values({
      gpayId: retryGpayId,
      name: "Restricted category retry regression",
      productType: "2",
      supplierPriceUsd: 20,
      salePriceRub: 2200,
      marginPercent: 15,
      profitRub: 200,
      isAvailable: true,
      digisellerImageUploaded: true,
      platiCategoryId: verifiedCategoryId,
    })
    .returning();

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/create/uniquefixed")) {
      createCalls += 1;
      const payload = JSON.parse(
        input instanceof Request
          ? await input.clone().text()
          : typeof init?.body === "string"
            ? init.body
            : "{}",
      ) as {
        categories?: Array<{ owner?: number; category_id?: number }>;
        content_type?: string;
      };
      assert.equal(payload.content_type, "digisellercode");
      assert.deepEqual(payload.categories, [
        { owner: 0, category_id: verifiedCategoryId },
      ]);
      if (createCalls === 1) {
        return Response.json({
          retval: 1,
          retdesc: "Restricted category rejected",
        });
      }
      return Response.json({
        retval: 0,
        content: { product_id: createdDigisellerId },
      });
    }
    if (url.includes("/api/product/content/code/count")) {
      assert.equal(new URL(url).searchParams.get("variant_id"), "0");
      assert.deepEqual(JSON.parse(String(init?.body)), { count: -1 });
      return Response.json({ retval: 0, content: { count: -1 } });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const failedResponse = await originalFetch(
      `${baseUrl}/api/products/${fixture.id}/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      },
    );
    assert.equal(failedResponse.status, 502);

    const afterFailureResult = await db.execute<{
      digisellerId: number | null;
      publicationStatus: string;
      publicationError: string | null;
      publicationFailureStage: string | null;
    }>(sql`
      select
        digiseller_id as "digisellerId",
        publication_status as "publicationStatus",
        publication_error as "publicationError",
        publication_failure_stage as "publicationFailureStage"
      from ${productsTable}
      where ${productsTable.id} = ${fixture.id}
    `);
    const afterFailure = afterFailureResult.rows[0];
    assert.equal(afterFailure.digisellerId, null);
    assert.equal(afterFailure.publicationStatus, "error");
    assert.match(afterFailure.publicationError ?? "", /Restricted category rejected/);
    assert.equal(afterFailure.publicationFailureStage, "category");
    assert.equal(createCalls, 1);

    const retried = await request<{
      digisellerId: number;
      publicationStatus: string;
      publicationError: string | null;
      publicationFailureStage: string | null;
    }>(`/api/products/${fixture.id}/publish`, { method: "POST" });
    assert.equal(retried.digisellerId, createdDigisellerId);
    assert.equal(retried.publicationStatus, "published");
    assert.equal(retried.publicationError, null);
    assert.equal(retried.publicationFailureStage, null);
    assert.equal(createCalls, 2);
    assert.equal(contentCalls, 0);
  } finally {
    fetchOverride = undefined;
    await db.delete(productsTable).where(eq(productsTable.gpayId, retryGpayId));
  }
});

test("batch publication returns immediately and exposes persisted progress", async () => {
  const missingProductId = 2_000_000_000;
  const startedAt = Date.now();
  const response = await originalFetch(`${baseUrl}/api/products/publish-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productIds: [missingProductId] }),
  });
  const responseBody = await response.text();
  assert.equal(response.status, 202, responseBody);
  const task = JSON.parse(responseBody) as {
    taskId: string;
    status: string;
  };
  assert.ok(Date.now() - startedAt < 500);
  assert.match(task.taskId, /^[0-9a-f-]{36}$/);

  let completed:
    | {
        status: string;
        requested: number;
        failed: number;
        items: Array<{ productId: number; status: string; error: string | null }>;
      }
    | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const latest = await request<typeof completed>(
      `/api/products/publish-batch/${task.taskId}`,
    );
    if (latest?.status === "completed") {
      completed = latest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(completed?.requested, 1);
  assert.equal(completed?.failed, 1);
  assert.deepEqual(completed?.items, [
    {
      productId: missingProductId,
      status: "failed",
      name: `Товар #${missingProductId}`,
      digisellerId: null,
      imageStatus: "skipped",
      error: "Товар не найден",
    },
  ]);
  await db
    .delete(publicationJobsTable)
    .where(eq(publicationJobsTable.id, task.taskId));
});

test("Digiseller login failure remains retryable before product creation", async () => {
  const loginFailureGpayId = 2_140_001_024;
  await db.delete(productsTable).where(eq(productsTable.gpayId, loginFailureGpayId));
  const [fixture] = await db
    .insert(productsTable)
    .values({
      gpayId: loginFailureGpayId,
      name: "Pre-creation login failure regression",
      productType: "2",
      supplierPriceUsd: 20,
      salePriceRub: 2200,
      marginPercent: 15,
      profitRub: 200,
      isAvailable: true,
    })
    .returning();
  fetchOverride = async (input) => {
    if (String(input).includes("/api/apilogin")) {
      return Response.json(
        { desc: "Temporary Digiseller login outage" },
        { status: 503 },
      );
    }
    throw new Error(`Unexpected outbound request: ${String(input)}`);
  };

  try {
    const response = await originalFetch(
      `${baseUrl}/api/products/${fixture.id}/publish`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    assert.equal(response.status, 502);
    const [saved] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, fixture.id));
    assert.equal(saved.publicationStatus, "error");
    assert.equal(saved.publicationFailureStage, "category");
    assert.match(saved.publicationError ?? "", /Temporary Digiseller login outage/);
  } finally {
    fetchOverride = undefined;
    await db
      .delete(productsTable)
      .where(eq(productsTable.gpayId, loginFailureGpayId));
  }
});

test("published legacy Text key migrates safely to unlimited Code", async () => {
  const migrationGpayId = 2_140_001_022;
  const legacyDigisellerId = 1_940_001_022;
  const newDigisellerId = 1_940_001_023;
  const verifiedCategoryId = 87_655;
  const calls: string[] = [];

  await db
    .update(settingsTable)
    .set({ digisellerThankYouPromoEnabled: true })
    .where(eq(settingsTable.id, 1));
  await db.delete(productsTable).where(eq(productsTable.gpayId, migrationGpayId));
  const [fixture] = await db
    .insert(productsTable)
    .values({
      gpayId: migrationGpayId,
      digisellerId: legacyDigisellerId,
      name: "Legacy Form key migration",
      imageUrl: "https://images.test/key.png",
      digisellerImageUploaded: true,
      productType: "2",
      supplierPriceUsd: 20,
      salePriceRub: 2200,
      marginPercent: 15,
      profitRub: 200,
      isAvailable: true,
      publicationStatus: "published",
      digisellerDeliveryType: "text" as const,
      platiCategoryId: verifiedCategoryId,
    })
    .returning();

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/product/create/uniquefixed")) {
      calls.push("create-code");
      const payload = JSON.parse(String(init?.body)) as {
        content_type?: string;
        enabled?: boolean;
        bonus?: { enabled?: boolean; percent?: number };
      };
      assert.equal(payload.content_type, "digisellercode");
      assert.equal(payload.enabled, true);
      assert.deepEqual(payload.bonus, { enabled: true, percent: 5 });
      return Response.json({
        retval: 0,
        content: { product_id: newDigisellerId },
      });
    }
    if (url.includes("/api/product/content/code/count")) {
      calls.push("unlimited-code");
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("product_id"), String(newDigisellerId));
      assert.equal(parsed.searchParams.get("variant_id"), "0");
      assert.deepEqual(JSON.parse(String(init?.body)), { count: -1 });
      return Response.json({ retval: 0, content: { count: -1 } });
    }
    if (url === "https://images.test/key.png") {
      calls.push("download-image");
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "content-type": "image/png" },
      });
    }
    if (url.includes(`/api/product/preview/add/images/${newDigisellerId}`)) {
      calls.push("upload-image");
      return Response.json({ retval: 0, content: [{ preview_id: 1 }] });
    }
    if (url.includes(`/api/product/edit/uniquefixed/${legacyDigisellerId}`)) {
      calls.push("disable-legacy-text");
      const payload = JSON.parse(String(init?.body)) as { enabled?: boolean };
      assert.equal(payload.enabled, false);
      return Response.json({ retval: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const published = await request<{
      digisellerId: number;
      publicationStatus: string;
    }>(`/api/products/${fixture.id}/publish`, { method: "POST" });
    assert.equal(published.digisellerId, newDigisellerId);
    assert.equal(published.publicationStatus, "published");
    assert.deepEqual(calls, [
      "create-code",
      "unlimited-code",
      "download-image",
      "upload-image",
      "disable-legacy-text",
    ]);

    const [migrated] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, fixture.id));
    assert.equal(migrated.digisellerId, newDigisellerId);
    assert.equal(migrated.previousDigisellerId, null);
    assert.equal(migrated.digisellerDeliveryType, "code");
    assert.equal(migrated.digisellerImageUploaded, true);
  } finally {
    fetchOverride = undefined;
    await db.delete(productsTable).where(eq(productsTable.gpayId, migrationGpayId));
  }
});

test("hourly sync does not stock legacy Text notices", async () => {
  const lowStockGpayId = 2_140_001_031;
  const healthyStockGpayId = 2_140_001_032;
  const failedStockGpayId = 2_140_001_033;
  const stockFixtureIds = [lowStockGpayId, healthyStockGpayId, failedStockGpayId];
  const digisellerByGpay = new Map([
    [lowStockGpayId, 1_940_001_031],
    [healthyStockGpayId, 1_940_001_032],
    [failedStockGpayId, 1_940_001_033],
  ]);
  const addedCounts = new Map<number, number>();

  await db.delete(productsTable).where(inArray(productsTable.gpayId, stockFixtureIds));
  await db.insert(productsTable).values(
    stockFixtureIds.map((gpayId) => ({
      gpayId,
      digisellerId: digisellerByGpay.get(gpayId),
      digisellerDeliveryType: "text" as const,
      digisellerTextStocked: true,
      name: `Text stock regression ${gpayId}`,
      productType: "2",
      publicationStatus: "published" as const,
      supplierPriceUsd: 20,
      salePriceRub: 2200,
      marginPercent: 15,
      profitRub: 200,
      isAvailable: true,
    })),
  );
  await db
    .insert(settingsTable)
    .values({ id: 1, automationMode: "automatic", exchangeRateMode: "manual" })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { automationMode: "automatic", exchangeRateMode: "manual" },
    });
  await allowlistProductsByGpayIds(stockFixtureIds);

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("cbr.ru")) return new Response("", { status: 503 });
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/products/list")) {
      return Response.json({
        status: "success",
        data: { products: [], totalCount: 0, page: 1, pageSize: 100 },
      });
    }
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    const productMatch = url.match(/\/api\/products\/(\d+)\/data/);
    if (productMatch) {
      const stockUrl = new URL(url);
      assert.equal(stockUrl.searchParams.get("token"), "digiseller-test-token");
      assert.equal(stockUrl.searchParams.has("q.token"), false);
      const productId = Number(productMatch[1]);
      if (productId === digisellerByGpay.get(failedStockGpayId)) {
        return Response.json({ retval: 1, retdesc: "Stock endpoint unavailable" });
      }
      return Response.json({
        retval: 0,
        product: {
          num_in_stock:
            productId === digisellerByGpay.get(lowStockGpayId)
              ? addedCounts.has(productId)
                ? 100
                : 10
              : 25,
        },
      });
    }
    if (url.includes("/api/product/content/add/text")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        product_id: number;
        content: unknown[];
      };
      addedCounts.set(body.product_id, body.content.length);
      return Response.json({ retval: 0 });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const first = await syncKeyPrices();
    const second = await syncKeyPrices();
    const failed = (
      await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.gpayId, failedStockGpayId))
    )[0];

    assert.equal(first.stockChecked, 0);
    assert.equal(first.stockReplenished, 0);
    assert.equal(first.stockFailed, 0);
    assert.equal(second.stockReplenished, 0);
    assert.equal(addedCounts.size, 0);
    assert.equal(failed.publicationStatus, "published");
    assert.equal(failed.publicationFailureStage, null);
  } finally {
    fetchOverride = undefined;
    await db.delete(productsTable).where(inArray(productsTable.gpayId, stockFixtureIds));
  }
});

test("order resync updates sale data but preserves fulfillment state", async () => {
  const gpayId = 2_140_001_041;
  const digisellerProductId = 1_940_001_041;
  const invoiceId = "invoice-preservation-regression";
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values({
      gpayId,
      digisellerId: digisellerProductId,
      name: "Order preservation product",
      productType: "2",
      supplierPriceUsd: 20,
      salePriceRub: 2200,
      marginPercent: 15,
      profitRub: 200,
      isAvailable: true,
    })
    .returning();
  const initialSale = {
    invoiceId,
    date: "2026-01-01T00:00:00Z",
    productId: digisellerProductId,
    productName: "Original name",
    amountIn: 1_000,
    amountCurrency: "RUB",
    isReturned: false,
  };
  const first = await upsertDigisellerSales(db, [initialSale]);
  assert.equal(first.inserted, 1);
  await db
    .update(syncOrdersTable)
    .set({ status: "processing", operatorNote: "operator-owned note" })
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  const second = await upsertDigisellerSales(db, [
    {
      ...initialSale,
      date: "2026-01-02T00:00:00Z",
      productName: "Updated name",
      amountIn: 1_250,
      amountCurrency: "RUB",
    },
  ]);
  assert.equal(second.updated, 1);
  const [order] = await db
    .select()
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  assert.equal(order.status, "processing");
  assert.equal(order.operatorNote, "operator-owned note");
  assert.equal(order.productName, "Updated name");
  assert.equal(order.paidAmountRub, 1_250);
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  await db.delete(productsTable).where(eq(productsTable.id, product.id));
});

function orderSyncProductValues(
  gpayId: number,
  digisellerId: number,
  previousDigisellerId?: number | null,
) {
  return {
    gpayId,
    digisellerId,
    previousDigisellerId: previousDigisellerId ?? null,
    name: `Order sync regression ${gpayId}`,
    productType: "2",
    supplierPriceUsd: 20,
    salePriceRub: 2200,
    marginPercent: 15,
    profitRub: 200,
    isAvailable: true,
  };
}

async function resetOrderSyncState() {
  await db.delete(syncOrderStateTable);
}

async function assertOrderSyncRolledBack() {
  const state = await db.select().from(syncOrderStateTable);
  assert.equal(state.length, 1);
  assert.equal(state[0].cursorAt, null);
  assert.equal(state[0].consecutiveFailures, 1);
  assert.ok(state[0].lastError);
}

test("seller-sells pagination imports every sale beyond the first 1000 rows", async () => {
  const gpayId = 2_140_001_051;
  const digisellerId = 1_940_001_051;
  const invoiceIds = Array.from(
    { length: 1_001 },
    (_, index) => `invoice-pagination-${index}`,
  );
  await resetOrderSyncState();
  // This test starts with a clean history set; later tests intentionally
  // retain history to verify that IDs are never forgotten.
  await db.delete(syncProductDigisellerIdsTable);
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(inArray(syncOrdersTable.invoiceId, invoiceIds));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  const requests: Array<Record<string, unknown>> = [];

  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> & {
        page: number;
      };
      requests.push(body);
      const pageRows =
        body.page === 1
          ? invoiceIds.slice(0, 1_000)
          : invoiceIds.slice(1_000);
      return Response.json({
        retval: 0,
        total_rows: invoiceIds.length,
        pages: 2,
        page: body.page,
        rows: pageRows.map((invoiceId, index) => ({
          invoice_id: invoiceId,
          product_id: digisellerId,
          product_name: "Paginated order",
          date_pay: "2024-01-01 00:00:00",
          amount_in: String(index + 1),
          amount_currency: "RUB",
          returned: 0,
        })),
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const result = await syncDigisellerOrders();
    assert.equal(result.skipped, false);
    assert.equal(result.fetched, 1_001);
    assert.equal(result.inserted, 1_001);
    assert.equal(requests.length, 2);
    for (const [index, body] of requests.entries()) {
      assert.ok((body.product_ids as number[]).includes(digisellerId));
      assert.equal(body.returned, 0);
      assert.equal(body.rows, 1_000);
      assert.equal(body.page, index + 1);
      assert.equal(body.date_start, "2000-01-01 00:00:00");
      assert.match(String(body.date_finish), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncOrdersTable)
      .where(inArray(syncOrdersTable.invoiceId, invoiceIds));
    assert.equal(count.count, 1_001);
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(inArray(syncOrdersTable.invoiceId, invoiceIds));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("overlap resync upserts one invoice without replacing fulfillment state", async () => {
  const gpayId = 2_140_001_052;
  const digisellerId = 1_940_001_052;
  const invoiceId = "invoice-overlap-regression";
  await resetOrderSyncState();
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  let syncAttempt = 0;
  const requests: Array<Record<string, unknown>> = [];
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      syncAttempt++;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      return Response.json({
        retval: 0,
        total_rows: 1,
        pages: 1,
        page: 1,
        rows: [
          {
            invoice_id: invoiceId,
            product_id: digisellerId,
            product_name: syncAttempt === 1 ? "Original" : "Resent",
            date_pay: "2024-01-02 00:00:00",
            amount_in: syncAttempt === 1 ? "1000" : "1100",
            amount_currency: "RUR",
            returned: syncAttempt === 1 ? 0 : 1,
          },
        ],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const firstSync = await syncDigisellerOrders();
    assert.equal(firstSync.skipped, false);
    assert.equal(firstSync.inserted, 1);
    await db
      .update(syncOrdersTable)
      .set({ status: "processing", operatorNote: "keep this note" })
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    const overlapSync = await syncDigisellerOrders();
    assert.equal(overlapSync.skipped, false);
    assert.equal(overlapSync.updated, 1);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[1].date_start, "2000-01-01 00:00:00");
    const matchingOrders = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(matchingOrders.length, 1);
    assert.equal(matchingOrders[0].status, "processing");
    assert.equal(matchingOrders[0].operatorNote, "keep this note");
    assert.equal(matchingOrders[0].isReturned, true);
    assert.equal(matchingOrders[0].productName, "Resent");
    assert.equal(matchingOrders[0].paidAmountRub, 1_100);
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("a refund after payment is persisted without erasing operator state and requires confirmation", async () => {
  const gpayId = 2_140_001_053;
  const digisellerId = 1_940_001_053;
  const invoiceId = "invoice-returned-after-payment";
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  const paidSale = {
    invoiceId,
    date: "2026-01-01T00:00:00Z",
    productId: digisellerId,
    productName: "Refund regression product",
    amountIn: 1_500,
    amountCurrency: "RUB",
    isReturned: false,
  };

  try {
    await upsertDigisellerSales(db, [paidSale]);
    await db
      .update(syncOrdersTable)
      .set({ operatorNote: "Contacted buyer" })
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    await upsertDigisellerSales(db, [{ ...paidSale, isReturned: true }]);

    const [returnedOrder] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(returnedOrder.isReturned, true);
    assert.equal(returnedOrder.operatorNote, "Contacted buyer");
    assert.equal(returnedOrder.status, "new");

    for (const returned of [undefined, null]) {
      fetchOverride = async (input) => {
        const url = String(input);
        if (url.includes("/api/seller-sells/v2")) {
          return Response.json({
            retval: 0,
            total_rows: 1,
            pages: 1,
            page: 1,
            rows: [
              {
                invoice_id: invoiceId,
                product_id: digisellerId,
                product_name: "Refund regression product",
                date_pay: "2026-01-01T00:00:00Z",
                amount_in: "1500",
                amount_currency: "RUB",
                ...(returned !== undefined ? { returned } : {}),
              },
            ],
          });
        }
        throw new Error(`Unexpected outbound request: ${url}`);
      };
      await assert.rejects(
        fetchDigisellerSalesPage({
          productIds: [digisellerId],
          dateStart: "2026-01-01 00:00:00",
          dateFinish: "2026-01-02 00:00:00",
          page: 1,
          providedToken: "digiseller-order-test-token",
        }),
        /malformed return state/,
      );
      const [stillReturned] = await db
        .select({ isReturned: syncOrdersTable.isReturned })
        .from(syncOrdersTable)
        .where(eq(syncOrdersTable.invoiceId, invoiceId));
      assert.equal(stillReturned.isReturned, true);
    }
    fetchOverride = undefined;

    const rejectedResponse = await originalFetch(
      `${baseUrl}/api/orders/${encodeURIComponent(invoiceId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "processing" }),
      },
    );
    assert.equal(rejectedResponse.status, 409);
    assert.deepEqual(await rejectedResponse.json(), {
      error: "Returned order status change requires explicit confirmation",
    });
    const confirmedResponse = await originalFetch(
      `${baseUrl}/api/orders/${encodeURIComponent(invoiceId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "processing",
          confirmReturned: true,
        }),
      },
    );
    assert.equal(confirmedResponse.status, 200);
    const confirmed = (await confirmedResponse.json()) as {
      status: string;
      isReturned: boolean;
    };
    assert.equal(confirmed.status, "processing");
    assert.equal(confirmed.isReturned, true);
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
  }
});

test("seller-sells page failure rolls back rows and leaves the cursor unchanged", async () => {
  const gpayId = 2_140_001_053;
  const digisellerId = 1_940_001_053;
  const invoiceIds = Array.from(
    { length: 1_000 },
    (_, index) => `invoice-page-failure-${index}`,
  );
  await resetOrderSyncState();
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(inArray(syncOrdersTable.invoiceId, invoiceIds));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { page: number };
      if (body.page === 2) {
        return Response.json(
          { retval: 1, retdesc: "page 2 unavailable" },
          { status: 503 },
        );
      }
      return Response.json({
        retval: 0,
        total_rows: 1_001,
        pages: 2,
        page: 1,
        rows: invoiceIds.map((invoiceId) => ({
          invoice_id: invoiceId,
          product_id: digisellerId,
          product_name: "Rolled back order",
          date_pay: "2024-01-03 00:00:00",
          amount_in: "10",
          amount_currency: "RUB",
          returned: 0,
        })),
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    await assert.rejects(
      () => syncDigisellerOrders(),
      /page 2 unavailable|503/,
    );
    const rows = await db
      .select({ id: syncOrdersTable.id })
      .from(syncOrdersTable)
      .where(inArray(syncOrdersTable.invoiceId, invoiceIds));
    assert.equal(rows.length, 0);
    await assertOrderSyncRolledBack();
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(inArray(syncOrdersTable.invoiceId, invoiceIds));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("historical Digiseller ID remains importable after previous ID is cleared", async () => {
  const gpayId = 2_140_001_054;
  const currentDigisellerId = 1_940_001_054;
  const historicalDigisellerId = 1_940_001_055;
  const invoiceId = "invoice-historical-id-regression";
  await resetOrderSyncState();
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, currentDigisellerId, null))
    .returning();
  await db.insert(syncProductDigisellerIdsTable).values({
    localProductId: product.id,
    digisellerProductId: historicalDigisellerId,
  });
  const requests: Array<Record<string, unknown>> = [];
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push(body);
      return Response.json({
        retval: 0,
        total_rows: 1,
        pages: 1,
        page: 1,
        rows: [
          {
            invoice_id: invoiceId,
            product_id: historicalDigisellerId,
            product_name: "Historical product order",
            date_pay: "2024-01-04 00:00:00",
            amount_in: "77",
            amount_currency: "RUB",
            returned: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    const result = await syncDigisellerOrders();
    assert.equal(result.skipped, false);
    assert.equal(result.inserted, 1);
    assert.ok((requests[0].product_ids as number[]).includes(currentDigisellerId));
    assert.ok(
      (requests[0].product_ids as number[]).includes(historicalDigisellerId),
    );
    const [order] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(order.digisellerProductId, historicalDigisellerId);
    assert.equal(order.paidAmountRub, 77);
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("a malformed seller-sells row rolls back the import and cursor", async () => {
  const gpayId = 2_140_001_055;
  const digisellerId = 1_940_001_058;
  const invoiceId = "invoice-malformed-row-regression";
  await resetOrderSyncState();
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  fetchOverride = async (input) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      return Response.json({
        retval: 0,
        total_rows: 1,
        pages: 1,
        page: 1,
        rows: [
          {
            invoice_id: invoiceId,
            product_id: digisellerId,
            product_name: "   ",
            date_pay: "2024-01-05 00:00:00",
            amount_in: "not-a-number",
            amount_currency: "RUB",
            returned: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    await assert.rejects(
      () => syncDigisellerOrders(),
      /malformed row|malformed amount/,
    );
    const orders = await db
      .select({ id: syncOrdersTable.id })
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(orders.length, 0);
    await assertOrderSyncRolledBack();
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("page metadata drift rolls back page one and leaves cursor unchanged", async () => {
  const gpayId = 2_140_001_056;
  const digisellerId = 1_940_001_059;
  const invoiceId = "invoice-metadata-drift-regression";
  await resetOrderSyncState();
  await db.delete(productsTable).where(eq(productsTable.gpayId, gpayId));
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
  const [product] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(gpayId, digisellerId))
    .returning();
  fetchOverride = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/apilogin")) {
      return Response.json({ token: "digiseller-order-test-token" });
    }
    if (url.includes("/api/seller-sells/v2")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { page: number };
      return Response.json({
        retval: 0,
        total_rows: body.page === 1 ? 1_001 : 1_002,
        pages: 2,
        page: body.page,
        rows: [
          {
            invoice_id: invoiceId,
            product_id: digisellerId,
            product_name: "Metadata drift order",
            date_pay: "2024-01-06 00:00:00",
            amount_in: "10",
            amount_currency: "RUB",
            returned: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };

  try {
    await assert.rejects(
      () => syncDigisellerOrders(),
      /pagination metadata changed/,
    );
    const orders = await db
      .select({ id: syncOrdersTable.id })
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(orders.length, 0);
    await assertOrderSyncRolledBack();
  } finally {
    fetchOverride = undefined;
    await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    await resetOrderSyncState();
  }
});

test("Digiseller ID ownership collisions fail and roll back history writes", async () => {
  const ownerGpayId = 2_140_001_057;
  const contenderGpayId = 2_140_001_058;
  const ownedDigisellerId = 1_940_001_060;
  const rolledBackDigisellerId = 1_940_001_061;
  await db.delete(productsTable).where(
    inArray(productsTable.gpayId, [ownerGpayId, contenderGpayId]),
  );
  const [owner] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(ownerGpayId, ownedDigisellerId))
    .returning();
  const [contender] = await db
    .insert(productsTable)
    .values(orderSyncProductValues(contenderGpayId, 1_940_001_062))
    .returning();
  await recordDigisellerProductIds(db, owner.id, [ownedDigisellerId]);

  try {
    await assert.rejects(
      () =>
        db.transaction((tx) =>
          recordDigisellerProductIds(tx, contender.id, [
            rolledBackDigisellerId,
            ownedDigisellerId,
          ]),
        ),
      /already mapped to local product/,
    );
    const [owned] = await db
      .select()
      .from(syncProductDigisellerIdsTable)
      .where(
        eq(
          syncProductDigisellerIdsTable.digisellerProductId,
          ownedDigisellerId,
        ),
      );
    assert.equal(owned.localProductId, owner.id);
    const rolledBack = await db
      .select()
      .from(syncProductDigisellerIdsTable)
      .where(
        eq(
          syncProductDigisellerIdsTable.digisellerProductId,
          rolledBackDigisellerId,
        ),
      );
    assert.equal(rolledBack.length, 0);
  } finally {
    await db.delete(productsTable).where(
      inArray(productsTable.gpayId, [ownerGpayId, contenderGpayId]),
    );
  }
});
