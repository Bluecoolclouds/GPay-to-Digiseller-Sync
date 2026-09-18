import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { eq } from "drizzle-orm";
import { db, settingsTable, syncOrdersTable } from "@workspace/db";
import { fetchDigisellerChatMessages } from "../lib/digiseller";
import { syncDigisellerBuyerChats } from "../lib/digiseller-chat";

process.env.SESSION_SECRET ||= "digiseller-chat-test-secret";
process.env.DIGISELLER_SELLER_ID ||= "123";
process.env.DIGISELLER_LOGIN ||= "seller";
process.env.DIGISELLER_API_GUID ||= "guid";

const originalFetch = globalThis.fetch;
let sequence = 0;
const invoice = () => String(9_100_000 + sequence++);

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function createOrder(invoiceId = invoice(), productId = 77) {
  const [order] = await db.insert(syncOrdersTable).values({
    invoiceId,
    digisellerProductId: productId,
    productName: "Chat test product",
    saleTimestamp: new Date(),
  }).returning();
  return order;
}

beforeEach(async () => {
  await db.delete(syncOrdersTable);
  await db.delete(settingsTable);
  await db.insert(settingsTable).values({
    id: 1,
    digisellerChatCodeEnabled: true,
    digisellerThankYouPromoEnabled: true,
    customerSiteUrl: "https://shop.example/base",
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("numeric seller, file and deleted messages are ignored", async () => {
  globalThis.fetch = async () => response({
    messages: [
      { id: 1, message: "seller", seller: 1 },
      { id: 2, message: "file", buyer: 1, is_file: 1 },
      { id: 3, message: "deleted", buyer: 1, deleted: 1 },
    ],
  });
  const messages = await fetchDigisellerChatMessages("token", 123);
  assert.deepEqual(messages.map((message) => [message.fromSeller, message.file, message.deleted]), [
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ]);
});

test("matching buyer code sends one same-order link and persists cursor", async () => {
  const order = await createOrder();
  const sent: string[] = [];
  let messageCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname.endsWith("/chats")) return response({ chats: [{ id_i: Number(order.invoiceId) }] });
    if (url.pathname === "/api/debates/v2") {
      messageCalls++;
      return response({ messages: messageCalls === 1 ? [{ id: 10, message: "1234567890123456", buyer: 1 }] : [] });
    }
    if (url.pathname === "/api/purchases/unique-code/1234567890123456") {
      return response({ retval: 0, inv: order.invoiceId, id_goods: order.digisellerProductId, unique_code_state: { state: 5 } });
    }
    if (url.pathname === "/api/debates/v2/") {
      sent.push(String((init?.body && JSON.parse(String(init.body)).message) ?? ""));
      return response({ retval: 0 });
    }
    if (url.pathname.endsWith("/seen")) return response({});
    throw new Error(`Unexpected fetch ${url}`);
  };
  await syncDigisellerBuyerChats();
  await syncDigisellerBuyerChats();
  assert.equal(sent.length, 1);
  assert.match(sent[0], new RegExp(`https://shop\\.example/base/order/`));
  const [updated] = await db.select().from(syncOrdersTable).where(eq(syncOrdersTable.id, order.id));
  assert.equal(updated.digisellerChatLastMessageId, 10);
});

test("cross-order code sends rejection and no link", async () => {
  const order = await createOrder();
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname.endsWith("/chats")) return response({ chats: [{ id_i: Number(order.invoiceId) }] });
    if (url.pathname === "/api/debates/v2") return response({ messages: [{ id: 1, message: "1234567890123456", buyer: 1 }] });
    if (url.pathname.includes("/unique-code/")) return response({ retval: 0, inv: "999999", id_goods: order.digisellerProductId, unique_code_state: { state: 5 } });
    if (url.pathname === "/api/debates/v2/") { sent.push(String((init?.body && JSON.parse(String(init.body)).message) ?? "")); return response({}); }
    if (url.pathname.endsWith("/seen")) return response({});
    throw new Error(`Unexpected fetch ${url}`);
  };
  await syncDigisellerBuyerChats();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /не относится/);
  assert.doesNotMatch(sent[0], /https:/);
});
