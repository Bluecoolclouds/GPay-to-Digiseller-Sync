import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  productsTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
} from "@workspace/db";
import {
  createPublicOrderLink,
  getPublicOrder,
  submitPublicOrderCode,
} from "../lib/public-orders";
import app from "../app";
import { redactSensitiveRequestUrl } from "../lib/request-log";

process.env.SESSION_SECRET ||= "public-order-test-secret";

let sequence = 0;
async function createOrder(returned = false) {
  const invoiceId = `public-order-${process.pid}-${sequence++}`;
  await db.insert(syncOrdersTable).values({
    invoiceId,
    digisellerProductId: 900_000_000 + sequence,
    productName: "Public order test",
    paidAmountRub: 100,
    saleTimestamp: new Date(),
    isReturned: returned,
  });
  return invoiceId;
}

async function removeOrder(invoiceId: string) {
  await db.delete(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, invoiceId));
}

async function waitForPurchaseStatus(invoiceId: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [order] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    if (order?.gpayPurchaseStatus === expected) return order;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Purchase status did not become ${expected}`);
}

async function waitForRetryablePurchaseError(invoiceId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [order] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    if (
      order?.gpayPurchaseStatus === "queued" &&
      order.gpayPurchaseError?.includes("Expired token")
    ) {
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Purchase did not return to the queue after authentication rejection");
}

async function createMappedOrder(productType: "1" | "2") {
  const suffix = 100_000 + sequence++;
  const gpayId = 800_000_000 + suffix;
  const digisellerProductId = 700_000_000 + suffix;
  const invoiceId = `public-gpay-order-${process.pid}-${suffix}`;
  const [product] = await db
    .insert(productsTable)
    .values({
      gpayId,
      digisellerId: digisellerProductId,
      name: "Mapped public order test",
      productType,
      supplierPriceUsd: 10,
      salePriceRub: 1_000,
      marginPercent: 15,
      profitRub: 100,
    })
    .returning({ id: productsTable.id });
  await db.insert(syncProductDigisellerIdsTable).values({
    localProductId: product.id,
    digisellerProductId,
  });
  await db.insert(syncOrdersTable).values({
    invoiceId,
    digisellerProductId,
    productName: "Mapped public order test",
    paidAmountRub: 1_000,
    saleTimestamp: new Date(),
  });
  return { invoiceId, gpayId, productId: product.id };
}

async function removeMappedOrder(fixture: {
  invoiceId: string;
  productId: number;
}) {
  await removeOrder(fixture.invoiceId);
  await db
    .delete(syncProductDigisellerIdsTable)
    .where(eq(syncProductDigisellerIdsTable.localProductId, fixture.productId));
  await db.delete(productsTable).where(eq(productsTable.id, fixture.productId));
}

test("public order link is replaced and code is submitted once", async () => {
  const invoiceId = await createOrder();
  try {
    const first = await createPublicOrderLink(invoiceId, "FIRST-CODE");
    const second = await createPublicOrderLink(invoiceId, "SECOND-CODE");
    assert(first);
    assert(second);
    assert.equal(await getPublicOrder(first.token), null);

    const publicOrder = await getPublicOrder(second.token);
    assert(publicOrder && !publicOrder.returned);
    assert.equal(publicOrder.code, "SECOND-CODE");

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        submitPublicOrderCode(second.token, "SECOND-CODE"),
      ),
    );
    assert.equal(
      attempts.filter((attempt) => attempt && !attempt.returned && !attempt.alreadySubmitted).length,
      1,
    );
    const repeated = await submitPublicOrderCode(second.token, "SECOND-CODE");
    assert(repeated && !repeated.returned);
    assert.equal(repeated.alreadySubmitted, true);

    const [stored] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(stored.status, "processing");
    assert(stored.publicSubmittedAt);
    assert(stored.publicSubmittedCodeHash);
    assert.notEqual(stored.publicSubmittedCodeHash, "SECOND-CODE");
  } finally {
    await removeOrder(invoiceId);
  }
});

test("expired and returned links cannot be used", async () => {
  const expiredInvoice = await createOrder();
  const returnedInvoice = await createOrder(true);
  try {
    const expired = await createPublicOrderLink(expiredInvoice, "");
    const returned = await createPublicOrderLink(returnedInvoice, "");
    assert(expired);
    assert(returned);
    await db
      .update(syncOrdersTable)
      .set({ publicLinkExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(syncOrdersTable.invoiceId, expiredInvoice));
    assert.equal(await getPublicOrder(expired.token), null);
    assert.equal(await submitPublicOrderCode(expired.token, "ABC"), null);
    assert.deepEqual(await getPublicOrder(returned.token), { returned: true });
    assert.deepEqual(await submitPublicOrderCode(returned.token, "ABC"), { returned: true });
  } finally {
    await removeOrder(expiredInvoice);
    await removeOrder(returnedInvoice);
  }
});

test("public HTTP flow validates codes and is idempotent", async () => {
  const invoiceId = await createOrder();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  try {
    const invalid = await fetch(
      `${baseUrl}/orders/${encodeURIComponent(invoiceId)}/public-link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "AB" }),
      },
    );
    assert.equal(invalid.status, 400);

    const created = await fetch(
      `${baseUrl}/orders/${encodeURIComponent(invoiceId)}/public-link`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ABC" }),
      },
    );
    assert.equal(created.status, 200);
    const link = (await created.json()) as { urlPath: string };
    const token = link.urlPath.split("/").at(-1);
    assert(token);

    const opened = await fetch(`${baseUrl}/public/orders/${token}`);
    assert.equal(opened.status, 200);
    assert.equal(((await opened.json()) as { code: string }).code, "ABC");

    const submit = () =>
      fetch(`${baseUrl}/public/orders/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "ABC" }),
      });
    const responses = await Promise.all([submit(), submit(), submit()]);
    assert(responses.every((response) => response.status === 200));
  } finally {
    server.close();
    await removeOrder(invoiceId);
  }
});

test("request logs redact public tokens and query strings", () => {
  assert.equal(
    redactSensitiveRequestUrl("/api/public/orders/top-secret-token?source=email"),
    "/api/public/orders/[redacted]",
  );
});

test("accepted key code creates one GPay purchase and later checks its status", async () => {
  const fixture = await createMappedOrder("2");
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  let statusCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/keys/order")) {
      createCalls++;
      return Response.json({
        status: "success",
        data: {
          success: true,
          items: [{
            orderId: 123,
            uniqueCode: "purchase-unique-code",
            isSuccess: true,
            deliveryStatus: "processing",
          }],
        },
      });
    }
    if (url.endsWith("/partner-api/keys/orders/purchase-unique-code")) {
      statusCalls++;
      return Response.json({
        status: "success",
        data: {
          orderId: 123,
          uniqueCode: "purchase-unique-code",
          deliveryStatus: "delivered",
          isTerminal: true,
          totalCharged: 10,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "KEY-CODE");
    assert(link);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        submitPublicOrderCode(link.token, "KEY-CODE"),
      ),
    );
    await waitForPurchaseStatus(fixture.invoiceId, "processing");
    assert.equal(createCalls, 1);

    await submitPublicOrderCode(link.token, "KEY-CODE");
    const delivered = await waitForPurchaseStatus(fixture.invoiceId, "delivered");
    assert.equal(createCalls, 1);
    assert.equal(statusCalls, 1);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.gpayPurchaseError, null);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("ambiguous GPay timeout cannot create a second purchase", async () => {
  const fixture = await createMappedOrder("2");
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/keys/order")) {
      createCalls++;
      throw new DOMException("Timed out", "TimeoutError");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "KEY-CODE");
    assert(link);
    await submitPublicOrderCode(link.token, "KEY-CODE");
    const unknown = await waitForPurchaseStatus(fixture.invoiceId, "unknown");
    assert.match(unknown.gpayPurchaseError ?? "", /автоматический повтор заблокирован/);

    await Promise.all(
      Array.from({ length: 3 }, () =>
        submitPublicOrderCode(link.token, "KEY-CODE"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(createCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("Steam Gift remains manual after code confirmation", async () => {
  const fixture = await createMappedOrder("1");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("Steam Gift must not call GPay purchase API");
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "STEAM-CODE");
    assert(link);
    await submitPublicOrderCode(link.token, "STEAM-CODE");
    const manual = await waitForPurchaseStatus(fixture.invoiceId, "manual");
    assert.match(manual.gpayPurchaseError ?? "", /ручной обработке/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("GPay purchase authentication rejection releases the claim for a safe retry", async () => {
  const fixture = await createMappedOrder("2");
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: `test-token-${createCalls}`, expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/keys/order")) {
      createCalls++;
      if (createCalls === 1) {
        return Response.json(
          { status: "error", errorMessage: "Expired token" },
          { status: 401 },
        );
      }
      return Response.json({
        status: "success",
        data: {
          success: true,
          items: [{
            orderId: 456,
            uniqueCode: "retried-unique-code",
            isSuccess: true,
            deliveryStatus: "delivered",
          }],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "KEY-CODE");
    assert(link);
    await submitPublicOrderCode(link.token, "KEY-CODE");
    const queued = await waitForRetryablePurchaseError(fixture.invoiceId);
    assert.equal(queued.gpayPurchaseStartedAt, null);

    await submitPublicOrderCode(link.token, "KEY-CODE");
    const delivered = await waitForPurchaseStatus(fixture.invoiceId, "delivered");
    assert.equal(createCalls, 2);
    assert.equal(delivered.gpayPurchaseOrderId, 456);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});