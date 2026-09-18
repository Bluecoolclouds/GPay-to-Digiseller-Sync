import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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
export async function syncDigisellerBuyerChats() {
  const [settings] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1));
  if (!settings?.digisellerChatCodeEnabled) {
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
      if (ORDER_CODE_PATTERN.test(text)) {
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