import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  activitiesTable,
  productsTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
} from "@workspace/db";
import {
  createPublicOrderLink,
  getPublicOrder,
  submitPublicOrderCode,
} from "../lib/public-orders";
import {
  findGPayPurchaseCandidates,
  reconcileUnknownGPayPurchase,
} from "../lib/gpay-reconciliation";
import {
  markDigisellerUniqueCodeDelivered,
  verifyDigisellerUniqueCode,
} from "../lib/digiseller";
import app from "../app";
import { redactSensitiveRequestUrl } from "../lib/request-log";

process.env.SESSION_SECRET ||= "public-order-test-secret";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

function verifiedDigisellerCode(invoiceId: string, productId: number, state = 5) {
  return Response.json({
    retval: 0,
    inv: invoiceId,
    id_goods: productId,
    unique_code_state: { state },
  });
}

test("Digiseller unique-code verification uses the primary host when available", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return verifiedDigisellerCode("primary-invoice", 123);
  };
  try {
    const result = await verifyDigisellerUniqueCode("code", "token");
    assert.equal(result.invoiceId, "primary-invoice");
    assert.deepEqual(calls.map((url) => new URL(url).host), ["api.digiseller.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Digiseller unique-code verification recovers through the reserve host", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (new URL(url).host === "api.digiseller.com") {
      return Response.json({ retdesc: "temporarily unavailable" }, { status: 503 });
    }
    return verifiedDigisellerCode("reserve-invoice", 456);
  };
  try {
    const result = await verifyDigisellerUniqueCode("code", "token");
    assert.equal(result.invoiceId, "reserve-invoice");
    assert.deepEqual(calls.map((url) => new URL(url).host), [
      "api.digiseller.com",
      "oplata.info",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Digiseller unique-code verification does not mask business rejection", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ retval: 1, retdesc: "Invalid unique code" });
  };
  try {
    await assert.rejects(
      verifyDigisellerUniqueCode("code", "token"),
      /Invalid unique code/,
    );
    assert.deepEqual(calls.map((url) => new URL(url).host), ["api.digiseller.com"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Digiseller delivery recovers through reserve and reports complete outage", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ host: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    const host = new URL(String(input)).host;
    calls.push({ host, method: init?.method ?? "GET" });
    if (host === "api.digiseller.com") throw new TypeError("primary offline");
    return verifiedDigisellerCode("reserve-delivery", 789, 2);
  };
  try {
    const result = await markDigisellerUniqueCodeDelivered("code", "token");
    assert.equal(result.state, 2);
    assert.deepEqual(calls, [
      { host: "api.digiseller.com", method: "PUT" },
      { host: "oplata.info", method: "PUT" },
    ]);

    calls.length = 0;
    globalThis.fetch = async (input, init) => {
      calls.push({
        host: new URL(String(input)).host,
        method: init?.method ?? "GET",
      });
      return Response.json({ retval: 2, retdesc: "Delivery is not permitted" });
    };
    await assert.rejects(
      markDigisellerUniqueCodeDelivered("code", "token"),
      /Delivery is not permitted/,
    );
    assert.deepEqual(calls, [
      { host: "api.digiseller.com", method: "PUT" },
    ]);

    globalThis.fetch = async () =>
      Response.json({ retdesc: "maintenance" }, { status: 502 });
    await assert.rejects(
      verifyDigisellerUniqueCode("code", "token"),
      /основной и резервный серверы недоступны.*api\.digiseller\.com.*oplata\.info/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Digiseller verification fails closed without a valid transaction state", async () => {
  const invoiceId = await createOrder();
  const [fixture] = await db
    .select({ productId: syncOrdersTable.digisellerProductId })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    return Response.json({
      retval: 0,
      inv: invoiceId,
      id_goods: fixture.productId,
    });
  };
  try {
    const link = await createPublicOrderLink(invoiceId, "");
    assert(link);
    const result = await submitPublicOrderCode(link.token, "1234567890123456");
    assert(result && !result.returned && "error" in result);
    const [stored] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(stored.publicSubmittedAt, null);
    assert.equal(stored.gpayPurchaseStatus, null);
  } finally {
    globalThis.fetch = originalFetch;
    await removeOrder(invoiceId);
  }
});

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

async function waitForDeliveryStatus(invoiceId: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [order] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    if (order?.digisellerDeliveryStatus === expected) return order;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Delivery status did not become ${expected}`);
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
  return { invoiceId, gpayId, productId: product.id, digisellerProductId };
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
  const originalFetch = globalThis.fetch;
  try {
    const [fixture] = await db
      .select({ productId: syncOrdersTable.digisellerProductId })
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/apilogin")) {
        return Response.json({ token: "digiseller-test-token" });
      }
      if (url.includes("/api/purchases/unique-code/")) {
        return verifiedDigisellerCode(invoiceId, fixture.productId);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
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
        submitPublicOrderCode(second.token, "1234567890123456"),
      ),
    );
    assert.equal(
      attempts.filter((attempt) => attempt && !attempt.returned && !attempt.alreadySubmitted).length,
      1,
      JSON.stringify(attempts),
    );
    const repeated = await submitPublicOrderCode(second.token, "1234567890123456");
    assert(repeated && !repeated.returned);
    assert.equal(repeated.alreadySubmitted, true);

    const [stored] = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, invoiceId));
    assert.equal(stored.status, "processing");
    assert(stored.publicSubmittedAt);
    assert(stored.publicSubmittedCodeHash);
    assert.notEqual(stored.publicSubmittedCodeHash, "1234567890123456");
    assert.notEqual(stored.publicSubmittedCodeEncrypted, "1234567890123456");
  } finally {
    globalThis.fetch = originalFetch;
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
  const [fixture] = await db
    .select({ productId: syncOrdersTable.digisellerProductId })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/purchases/unique-code/")) {
      return verifiedDigisellerCode(invoiceId, fixture.productId);
    }
    return originalFetch(input);
  };
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
        body: JSON.stringify({ code: "1234567890123456" }),
      },
    );
    assert.equal(created.status, 200);
    const link = (await created.json()) as { urlPath: string };
    const token = link.urlPath.split("/").at(-1);
    assert(token);

    const opened = await fetch(`${baseUrl}/public/orders/${token}`);
    assert.equal(opened.status, 200);
    assert.equal(((await opened.json()) as { code: string }).code, "1234567890123456");

    const submit = () =>
      fetch(`${baseUrl}/public/orders/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "1234567890123456" }),
      });
    const responses = await Promise.all([submit(), submit(), submit()]);
    assert(responses.every((response) => response.status === 200));
  } finally {
    globalThis.fetch = originalFetch;
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
  let deliveryCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/purchases/unique-code/1234567890123456/deliver")) {
      deliveryCalls++;
      return verifiedDigisellerCode(fixture.invoiceId, 700_000_000 + Number(fixture.invoiceId.split("-").at(-1)), 2);
    }
    if (url.includes("/api/purchases/unique-code/1234567890123456")) {
      return verifiedDigisellerCode(fixture.invoiceId, 700_000_000 + Number(fixture.invoiceId.split("-").at(-1)));
    }
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
          key: "DELIVERED-GAME-KEY",
          totalCharged: 10,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "1234567890123456");
    assert(link);
    const submissions = await Promise.all(
      Array.from({ length: 5 }, () =>
        submitPublicOrderCode(link.token, "1234567890123456"),
      ),
    );
    assert.equal(
      submissions.some((result) => result && "error" in result),
      false,
      JSON.stringify(submissions),
    );
    await waitForPurchaseStatus(fixture.invoiceId, "processing");
    assert.equal(createCalls, 1);

    await submitPublicOrderCode(link.token, "1234567890123456");
    await waitForPurchaseStatus(fixture.invoiceId, "delivered");
    const delivered = await waitForDeliveryStatus(fixture.invoiceId, "delivered");
    assert.equal(createCalls, 1);
    assert.equal(statusCalls, 1);
    assert.equal(deliveryCalls, 1);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.gpayPurchaseError, null);
    assert.equal(delivered.digisellerDeliveryStatus, "delivered");
    assert.notEqual(delivered.gpayDeliveredKeyEncrypted, "DELIVERED-GAME-KEY");
    const publicOrder = await getPublicOrder(link.token);
    assert(publicOrder && !publicOrder.returned);
    assert.equal(publicOrder.deliveredKey, "DELIVERED-GAME-KEY");
    const rotated = await createPublicOrderLink(fixture.invoiceId, "UNVERIFIED-CODE");
    assert(rotated);
    const rotatedOrder = await getPublicOrder(rotated.token);
    assert(rotatedOrder && !rotatedOrder.returned);
    assert.equal(rotatedOrder.alreadySubmitted, true);
    assert.equal(rotatedOrder.deliveredKey, "DELIVERED-GAME-KEY");
    await submitPublicOrderCode(link.token, "1234567890123456");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(createCalls, 1);
    assert.equal(deliveryCalls, 1);
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
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/purchases/unique-code/1234567890123456")) {
      return verifiedDigisellerCode(
        fixture.invoiceId,
        700_000_000 + Number(fixture.invoiceId.split("-").at(-1)),
      );
    }
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
    const link = await createPublicOrderLink(fixture.invoiceId, "1234567890123456");
    assert(link);
    await submitPublicOrderCode(link.token, "1234567890123456");
    const unknown = await waitForPurchaseStatus(fixture.invoiceId, "unknown");
    assert.match(unknown.gpayPurchaseError ?? "", /автоматический повтор заблокирован/);

    await Promise.all(
      Array.from({ length: 3 }, () =>
        submitPublicOrderCode(link.token, "1234567890123456"),
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
  globalThis.fetch = async (input) => {
    const url = String(input);
    fetchCalls++;
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    return verifiedDigisellerCode(
      fixture.invoiceId,
      700_000_000 + Number(fixture.invoiceId.split("-").at(-1)),
    );
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "1234567890123456");
    assert(link);
    await submitPublicOrderCode(link.token, "1234567890123456");
    const manual = await waitForPurchaseStatus(fixture.invoiceId, "manual");
    assert.match(manual.gpayPurchaseError ?? "", /ручной обработке/);
    assert.equal(fetchCalls, 2);
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
    if (url.endsWith("/api/apilogin")) {
      return Response.json({ token: "digiseller-test-token" });
    }
    if (url.includes("/api/purchases/unique-code/1234567890123456")) {
      return verifiedDigisellerCode(
        fixture.invoiceId,
        700_000_000 + Number(fixture.invoiceId.split("-").at(-1)),
      );
    }
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
            key: "RETRIED-GAME-KEY",
          }],
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const link = await createPublicOrderLink(fixture.invoiceId, "1234567890123456");
    assert(link);
    await submitPublicOrderCode(link.token, "1234567890123456");
    const queued = await waitForRetryablePurchaseError(fixture.invoiceId);
    assert.equal(queued.gpayPurchaseStartedAt, null);

    await submitPublicOrderCode(link.token, "1234567890123456");
    const delivered = await waitForPurchaseStatus(fixture.invoiceId, "delivered");
    assert.equal(createCalls, 2);
    assert.equal(delivered.gpayPurchaseOrderId, 456);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("operator reconciliation links a confirmed unknown GPay purchase", async () => {
  const invoiceId = await createOrder();
  const originalFetch = globalThis.fetch;
  let statusCalls = 0;
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseStartedAt: new Date(),
      gpayPurchaseError: "Purchase response was not received",
    })
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/keys/orders/recovered-code")) {
      statusCalls++;
      return Response.json({
        status: "success",
        data: {
          orderId: 765,
          uniqueCode: "recovered-code",
          deliveryStatus: "processing",
          isTerminal: false,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const updated = await reconcileUnknownGPayPurchase({
      invoiceId,
      uniqueCode: "recovered-code",
      orderId: 765,
      reason: "Найдено в истории GPay",
    });
    assert.equal(statusCalls, 1);
    assert.equal(updated?.gpayPurchaseOrderId, 765);
    assert.equal(updated?.gpayPurchaseUniqueCode, "recovered-code");
    assert.equal(updated?.gpayPurchaseStatus, "processing");
    const decisions = await db
      .select()
      .from(activitiesTable);
    assert(decisions.some((item) =>
      item.title === "Закупка GPay сверена" &&
      item.description.includes(invoiceId),
    ));
  } finally {
    globalThis.fetch = originalFetch;
    await removeOrder(invoiceId);
  }
});

test("manual reconciliation keeps an unknown purchase blocked", async () => {
  const invoiceId = await createOrder();
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseStartedAt: new Date(),
    })
    .where(eq(syncOrdersTable.invoiceId, invoiceId));
  try {
    const updated = await reconcileUnknownGPayPurchase({
      invoiceId,
      reason: "Передано в поддержку GPay",
    });
    assert.equal(updated?.gpayPurchaseStatus, "unknown");
    assert.match(updated?.gpayPurchaseError ?? "", /Ручная сверка/);
  } finally {
    await removeOrder(invoiceId);
  }
});

test("automatic reconciliation finds one matching GPay history order", async () => {
  const fixture = await createMappedOrder("2");
  const startedAt = new Date(Date.now() - 4 * 60 * 1_000);
  const originalFetch = globalThis.fetch;
  let createCalls = 0;
  let loginCalls = 0;
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseStartedAt: startedAt,
      gpayPurchaseExpectedAmountUsd: 10,
    })
    .where(eq(syncOrdersTable.invoiceId, fixture.invoiceId));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      loginCalls++;
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/orders/list")) {
      return Response.json({
        status: "success",
        data: {
          orders: [{
            id: 987,
            uniqueCode: "history-code",
            productType: 2,
            itemId: fixture.gpayId,
            totalAmount: 10,
            createdAt: startedAt.toISOString(),
          }],
          totalCount: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (url.endsWith("/partner-api/keys/orders/history-code")) {
      return Response.json({
        status: "success",
        data: {
          orderId: 987,
          uniqueCode: "history-code",
          deliveryStatus: "processing",
          isTerminal: false,
        },
      });
    }
    if (url.endsWith("/partner-api/keys/order")) createCalls++;
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const updated = await reconcileUnknownGPayPurchase({
      invoiceId: fixture.invoiceId,
      searchHistory: true,
      reason: "Автоматический поиск по истории GPay",
    });
    assert.equal(createCalls, 0);
    assert.equal(loginCalls, 2);
    assert.equal(updated?.gpayPurchaseOrderId, 987);
    assert.equal(updated?.gpayPurchaseUniqueCode, "history-code");
    assert.equal(updated?.gpayPurchaseStatus, "processing");
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("automatic reconciliation waits until the matching window closes", async () => {
  const fixture = await createMappedOrder("2");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseStartedAt: new Date(),
      gpayPurchaseExpectedAmountUsd: 10,
    })
    .where(eq(syncOrdersTable.invoiceId, fixture.invoiceId));
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("History must not be read while the window is open");
  };
  try {
    await assert.rejects(
      reconcileUnknownGPayPurchase({
        invoiceId: fixture.invoiceId,
        searchHistory: true,
        reason: "Слишком ранний автоматический поиск",
      }),
      /История ещё формируется/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await removeMappedOrder(fixture);
  }
});

test("multiple GPay history matches remain unknown", () => {
  const startedAt = new Date();
  const matching = {
    productType: 2,
    itemId: 123,
    totalAmount: 10,
    createdAt: startedAt.toISOString(),
  };
  const candidates = findGPayPurchaseCandidates({
    orders: [
      { ...matching, id: 1, uniqueCode: "first" },
      { ...matching, id: 2, uniqueCode: "second" },
      { ...matching, id: 3, uniqueCode: null },
      { ...matching, id: 4, uniqueCode: "wrong-price", totalAmount: 11 },
      { ...matching, id: 5, uniqueCode: "adjacent-cent", totalAmount: 10.009 },
    ],
    productId: 123,
    expectedAmountUsd: 10,
    startedAt,
  });
  assert.deepEqual(candidates.map((candidate) => candidate.id), [1, 2]);
});

test("one GPay history purchase cannot be linked to two local orders", async () => {
  const fixture = await createMappedOrder("2");
  const secondInvoiceId = `${fixture.invoiceId}-second`;
  const startedAt = new Date(Date.now() - 4 * 60 * 1_000);
  const originalFetch = globalThis.fetch;
  await db.insert(syncOrdersTable).values({
    invoiceId: secondInvoiceId,
    digisellerProductId: fixture.digisellerProductId,
    productName: "Second ambiguous order",
    paidAmountRub: 1_000,
    saleTimestamp: new Date(),
  });
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseStartedAt: startedAt,
      gpayPurchaseExpectedAmountUsd: 10,
    })
    .where(eq(syncOrdersTable.digisellerProductId, fixture.digisellerProductId));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/partner-api/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "test-token", expiresAt: new Date().toISOString() },
      });
    }
    if (url.endsWith("/partner-api/orders/list")) {
      return Response.json({
        status: "success",
        data: {
          orders: [{
            id: 654,
            uniqueCode: "single-supplier-order",
            productType: 2,
            itemId: fixture.gpayId,
            totalAmount: 10,
            createdAt: startedAt.toISOString(),
          }],
          totalCount: 1,
          page: 1,
          pageSize: 100,
        },
      });
    }
    if (url.endsWith("/partner-api/keys/orders/single-supplier-order")) {
      return Response.json({
        status: "success",
        data: {
          orderId: 654,
          uniqueCode: "single-supplier-order",
          deliveryStatus: "processing",
          isTerminal: false,
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const results = await Promise.allSettled(
      [fixture.invoiceId, secondInvoiceId].map((invoiceId) =>
        reconcileUnknownGPayPurchase({
          invoiceId,
          searchHistory: true,
          reason: "Параллельная автоматическая сверка",
        }),
      ),
    );
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    const linked = await db
      .select()
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.gpayPurchaseOrderId, 654));
    assert.equal(linked.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await removeOrder(secondInvoiceId);
    await removeMappedOrder(fixture);
  }
});