import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  activitiesTable,
  db,
  pool,
  productsTable,
  settingsTable,
} from "@workspace/db";
import app from "../app";
import { syncKeyPrices } from "../lib/price-sync";

const fixtureIds = [2_140_001_001, 2_140_001_002, 2_140_001_003];
const [keyGpayId, giftGpayId, unknownGpayId] = fixtureIds;
const originalFetch = globalThis.fetch;
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
    id: keyGpayId,
    name: "Regression key duplicate should be ignored",
    productType: 2,
    currentPartnerPrice: 99,
    isAvailable: true,
    region: "Duplicate",
  },
  {
    id: giftGpayId,
    name: "Regression gift duplicate should be ignored",
    productType: 1,
    currentPartnerPrice: 99,
    isAvailable: true,
    region: "Duplicate",
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

test("key sync counts repeated key pages once without changing other types", async () => {
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

test("gift sync counts repeated gift pages once without changing other types", async () => {
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
    .values({ id: 1, automationMode: "automatic" })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { automationMode: "automatic" },
    });
}

function usePriceSyncResponses(status: Record<string, unknown>) {
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

test("a failed price batch does not prevent later batches from saving", async () => {
  const batchGpayIds = Array.from(
    { length: 101 },
    (_, index) => 2_130_000_000 + index,
  );
  const digisellerOffset = 1_920_000_000;
  const previousSupplierPrice = 10;
  const previousSalePrice = 1000;
  const submittedBatches: number[][] = [];

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
    .values({ id: 1, automationMode: "automatic" })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { automationMode: "automatic" },
    });

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
  }
});