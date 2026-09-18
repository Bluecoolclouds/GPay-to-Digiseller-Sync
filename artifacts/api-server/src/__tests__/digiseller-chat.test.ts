import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, settingsTable, syncOrdersTable } from "@workspace/db";
import { fetchDigisellerChatMessages } from "../lib/digiseller";
import {
  redeemDigisellerPromo,
  sendDigisellerThankYou,
  syncDigisellerBuyerChats,
} from "../lib/digiseller-chat";

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

test("thank-you generates one reusable promo with thirty-day expiry", async () => {
  const order = await createOrder("9200001");
  await db.update(syncOrdersTable).set({ digisellerChatId: Number(order.invoiceId) }).where(eq(syncOrdersTable.id, order.id));
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname === "/api/debates/v2/") { sent.push(String((init?.body && JSON.parse(String(init.body)).message) ?? "")); return response({}); }
    throw new Error(`Unexpected fetch ${url}`);
  };
  await sendDigisellerThankYou(order.id);
  const [stored] = await db.select().from(syncOrdersTable).where(eq(syncOrdersTable.id, order.id));
  await sendDigisellerThankYou(order.id);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /GP-[A-Z0-9]{4}-[A-Z0-9]{4}/);
  assert.match(sent[0], /дождитесь подтверждения новой цены/);
  assert.match(sent[0], /к уже оплаченному заказу скидка не применяется/i);
  assert.ok(stored.promoCodeExpiresAt!.getTime() - Date.now() > 29 * 24 * 60 * 60 * 1_000);
});

test("promo redemption distinguishes redeemed, used, expired and unknown", async () => {
  const order = await createOrder("9300001");
  // Generate a real promo through the thank-you path, then exercise its hash.
  await db.update(settingsTable).set({ digisellerThankYouPromoEnabled: true }).where(eq(settingsTable.id, 1));
  await db.update(syncOrdersTable).set({ digisellerChatId: Number(order.invoiceId) }).where(eq(syncOrdersTable.id, order.id));
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname === "/api/debates/v2/") {
      sent.push(String((init?.body && JSON.parse(String(init.body)).message) ?? ""));
      return response({});
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  await sendDigisellerThankYou(order.id);
  const [withPromo] = await db.select().from(syncOrdersTable).where(eq(syncOrdersTable.id, order.id));
  assert.ok(withPromo.promoCodeEncrypted);
  const sentCode = sent[0].match(/GP-[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
  assert.equal((await redeemDigisellerPromo(sentCode, "9300001")).status, "redeemed");
  assert.equal((await redeemDigisellerPromo(sentCode, "9300001")).status, "already-used");
  assert.equal((await redeemDigisellerPromo("GP-0000-0000", "9300001")).status, "unknown");
  const expiredCode = "GP-EEEE-EEEE";
  await db.update(syncOrdersTable).set({ promoCodeHash: createHash("sha256").update(expiredCode).digest("hex"), promoCodeExpiresAt: new Date(Date.now() - 1_000), promoCodeRedeemedAt: null }).where(eq(syncOrdersTable.id, order.id));
  assert.equal((await redeemDigisellerPromo(expiredCode, "9300001")).status, "expired");
});

test("promo chat reply does not promise an automatic discount on a paid order", async () => {
  const sourceOrder = await createOrder("9400001");
  const chatOrder = await createOrder("9400002");
  await db.update(syncOrdersTable)
    .set({ digisellerChatId: Number(sourceOrder.invoiceId) })
    .where(eq(syncOrdersTable.id, sourceOrder.id));

  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname.endsWith("/chats")) {
      return response({ chats: [{ id_i: Number(chatOrder.invoiceId) }] });
    }
    if (url.pathname === "/api/debates/v2/") {
      if (init?.method === "POST") {
        sent.push(String(JSON.parse(String(init.body)).message ?? ""));
        return response({ retval: 0 });
      }
      return response({ messages: [] });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  await sendDigisellerThankYou(sourceOrder.id);
  const promo = sent[0].match(/GP-[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
  sent.length = 0;

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/apilogin")) return response({ token: "token" });
    if (url.pathname.endsWith("/chats")) {
      return response({ chats: [{ id_i: Number(chatOrder.invoiceId) }] });
    }
    if (url.pathname === "/api/debates/v2") {
      return response({ messages: [{ id: 1, message: promo, buyer: 1 }] });
    }
    if (url.pathname === "/api/debates/v2/") {
      sent.push(String(JSON.parse(String(init?.body)).message ?? ""));
      return response({ retval: 0 });
    }
    if (url.pathname.endsWith("/seen")) return response({});
    throw new Error(`Unexpected fetch ${url}`);
  };

  await syncDigisellerBuyerChats();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /не предоставляет API/);
  assert.match(sent[0], /Не оплачивайте новый заказ до подтверждения/);
  assert.match(sent[0], /к уже оплаченному заказу скидка не применяется/i);
  assert.doesNotMatch(sent[0], /автоматически|к этой покупке/i);
});