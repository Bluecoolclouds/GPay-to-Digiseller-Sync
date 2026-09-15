import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db, syncOrdersTable } from "@workspace/db";
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