import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, settingsTable, syncOrdersTable } from "@workspace/db";
import {
  fetchDigisellerChatMessages,
  fetchDigisellerBuyerChats,
  loginDigiseller,
  markDigisellerChatSeen,
  sendDigisellerChatMessage,
  verifyDigisellerUniqueCode,
} from "./digiseller";
import { createPublicOrderLink } from "./public-orders";

const ORDER_CODE_PATTERN = /^\d{16}$/;
const PROMO_CODE_PATTERN = /^GP-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
const PROMO_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decrypt(value: string | null) {
  if (!value) return "";
  const [iv, tag, data] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
function newPromo() {
  const bytes = randomBytes(8).toString("hex").toUpperCase();
  return `GP-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`;
}

export async function redeemDigisellerPromo(code: string, invoiceId: string) {
  const normalized = code.trim();
  const [existing] = await db.select({ redeemedAt: syncOrdersTable.promoCodeRedeemedAt, expiresAt: syncOrdersTable.promoCodeExpiresAt })
    .from(syncOrdersTable).where(eq(syncOrdersTable.promoCodeHash, hash(normalized)));
  if (!existing) return { status: "unknown" as const };
  if (existing.expiresAt && existing.expiresAt <= new Date()) return { status: "expired" as const };
  if (existing.redeemedAt) return { status: "already-used" as const };
  const [order] = await db
    .update(syncOrdersTable)
    .set({ promoCodeRedeemedAt: new Date(), promoCodeRedeemedInvoiceId: invoiceId, updatedAt: new Date() })
    .where(and(
      eq(syncOrdersTable.promoCodeHash, hash(normalized)),
      isNull(syncOrdersTable.promoCodeRedeemedAt),
      or(isNull(syncOrdersTable.promoCodeExpiresAt), gt(syncOrdersTable.promoCodeExpiresAt, new Date())),
    ))
    .returning({ expiresAt: syncOrdersTable.promoCodeExpiresAt });
  if (!order) return { status: "already-used" as const };
  return { status: "redeemed" as const };
}

export async function sendDigisellerThankYou(orderId: number) {
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  if (!settings?.digisellerThankYouPromoEnabled || !orderId) return false;
  const [order] = await db.select().from(syncOrdersTable).where(eq(syncOrdersTable.id, orderId));
  const chatId = order?.digisellerChatId ?? Number(order?.invoiceId);
  if (!order || !Number.isInteger(chatId) || order.digisellerChatThankYouSentAt) return false;
  const token = await loginDigiseller();
  const promo = order.promoCodeEncrypted ? decrypt(order.promoCodeEncrypted) : newPromo();
  const expiry = order.promoCodeExpiresAt ?? new Date(Date.now() + PROMO_LIFETIME_MS);
  if (!order.promoCodeEncrypted) {
    await db.update(syncOrdersTable).set({
      promoCodeEncrypted: encrypt(promo),
      promoCodeHash: hash(promo),
      promoCodeExpiresAt: expiry,
      updatedAt: new Date(),
    }).where(eq(syncOrdersTable.id, orderId));
  }
  await sendDigisellerChatMessage(token, chatId,
    `Спасибо за покупку! Ваш ключ уже доступен на странице заказа. Ваш персональный промокод ${promo} даёт скидку 5% при ручном применении к следующей покупке и действует до ${expiry.toLocaleDateString("ru-RU")}. Код одноразовый: отправьте его в чат Digiseller до оформления следующей покупки.`);
  await db.update(syncOrdersTable).set({ digisellerChatThankYouSentAt: new Date(), digisellerChatError: null, updatedAt: new Date() }).where(eq(syncOrdersTable.id, orderId));
  return true;
}

export async function syncDigisellerBuyerChats() {
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  if (!settings?.digisellerChatCodeEnabled && !settings?.digisellerThankYouPromoEnabled) {
    return { skipped: true, reason: "disabled" };
  }
  const token = await loginDigiseller();
  const chats = await fetchDigisellerBuyerChats(token);
  let processed = 0;
  for (const chat of chats) {
    const [state] = await db.select({
      id: syncOrdersTable.id,
      cursor: syncOrdersTable.digisellerChatLastMessageId,
      productId: syncOrdersTable.digisellerProductId,
      linkEncrypted: syncOrdersTable.digisellerChatLinkEncrypted,
    })
      .from(syncOrdersTable).where(eq(syncOrdersTable.invoiceId, String(chat.id))).limit(1);
    if (!state) continue;
    const messages = await fetchDigisellerChatMessages(token, chat.id, state?.cursor ?? undefined);
    for (const message of messages.sort((a, b) => a.id - b.id)) {
      if (message.fromSeller || message.file || message.deleted || !message.text) {
        await db.update(syncOrdersTable)
          .set({ digisellerChatId: chat.id, digisellerChatLastMessageId: message.id, updatedAt: new Date() })
          .where(eq(syncOrdersTable.id, state.id));
        continue;
      }

      const text = message.text.trim();
      if (
        settings.digisellerThankYouPromoEnabled &&
        PROMO_CODE_PATTERN.test(text)
      ) {
        const redeem = await redeemDigisellerPromo(text.toUpperCase(), String(chat.id));
        const reply =
          redeem.status === "redeemed"
            ? "Промокод зарегистрирован. Скидка 5% будет применена оператором вручную к этой покупке."
            : redeem.status === "expired"
              ? "Срок действия промокода истёк."
              : redeem.status === "already-used"
                ? "Этот промокод уже использован."
                : "Промокод не найден.";
        await sendDigisellerChatMessage(token, chat.id, reply);
      } else if (
        settings.digisellerChatCodeEnabled &&
        ORDER_CODE_PATTERN.test(text)
      ) {
        let verified;
        try {
          verified = await verifyDigisellerUniqueCode(text, token);
        } catch (error) {
          await db.update(syncOrdersTable)
            .set({
              digisellerChatError:
                error instanceof Error ? error.message : "Не удалось проверить код заказа",
              updatedAt: new Date(),
            })
            .where(eq(syncOrdersTable.id, state.id));
          throw error;
        }
        if (
          verified.invoiceId !== String(chat.id) ||
          verified.productId !== state.productId ||
          ![1, 5].includes(verified.state)
        ) {
          await sendDigisellerChatMessage(
            token,
            chat.id,
            "Код не относится к этому заказу или товар по нему уже был передан.",
          );
        } else {
          const base = settings.customerSiteUrl?.replace(/\/+$/, "");
          if (!base) throw new Error("Не задан URL клиентского сайта");
          const link = state.linkEncrypted
            ? null
            : await createPublicOrderLink(String(chat.id), text);
          if (link || state.linkEncrypted) {
            const absolute = state.linkEncrypted
              ? decrypt(state.linkEncrypted)
              : `${base}/order/${link!.token}`;
            if (!state.linkEncrypted) {
              await db.update(syncOrdersTable)
                .set({ digisellerChatLinkEncrypted: encrypt(absolute), updatedAt: new Date() })
                .where(eq(syncOrdersTable.id, state.id));
            }
            await sendDigisellerChatMessage(token, chat.id, `Откройте страницу заказа: ${absolute}`);
            await db.update(syncOrdersTable)
              .set({ digisellerChatLinkSentAt: new Date(), digisellerChatError: null, updatedAt: new Date() })
              .where(eq(syncOrdersTable.id, state.id));
          }
        }
      }
      await db.update(syncOrdersTable)
        .set({
          digisellerChatId: chat.id,
          digisellerChatLastMessageId: message.id,
          updatedAt: new Date(),
        })
        .where(eq(syncOrdersTable.id, state.id));
      processed++;
    }
    await markDigisellerChatSeen(token, chat.id);
  }
  return { chats: chats.length, processed };
}