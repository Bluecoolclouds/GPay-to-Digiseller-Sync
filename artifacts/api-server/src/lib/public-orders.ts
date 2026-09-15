import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, syncOrdersTable } from "@workspace/db";

const LINK_LIFETIME_MS = 24 * 60 * 60 * 1_000;

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return createHash("sha256").update(secret).digest();
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function encrypt(value: string) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decrypt(value: string | null) {
  if (!value) return "";
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Invalid encrypted order code");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export async function createPublicOrderLink(invoiceId: string, code: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + LINK_LIFETIME_MS);
  const [order] = await db
    .update(syncOrdersTable)
    .set({
      publicTokenHash: hash(token),
      publicLinkExpiresAt: expiresAt,
      publicCodeEncrypted: encrypt(code.trim()),
      publicOpenedAt: null,
      publicSubmittedAt: null,
      publicSubmittedCodeHash: null,
      publicSubmissionError: null,
      updatedAt: new Date(),
    })
    .where(eq(syncOrdersTable.invoiceId, invoiceId))
    .returning({ invoiceId: syncOrdersTable.invoiceId });
  return order ? { token, expiresAt } : null;
}

export async function getPublicOrder(token: string) {
  const tokenHash = hash(token);
  const [order] = await db
    .select({
      productName: syncOrdersTable.productName,
      code: syncOrdersTable.publicCodeEncrypted,
      expiresAt: syncOrdersTable.publicLinkExpiresAt,
      submittedAt: syncOrdersTable.publicSubmittedAt,
      isReturned: syncOrdersTable.isReturned,
    })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.publicTokenHash, tokenHash));
  if (!order || !order.expiresAt || order.expiresAt <= new Date()) return null;
  if (order.isReturned) return { returned: true as const };
  await db
    .update(syncOrdersTable)
    .set({ publicOpenedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(syncOrdersTable.publicTokenHash, tokenHash),
        isNull(syncOrdersTable.publicOpenedAt),
      ),
    );
  return {
    returned: false as const,
    productName: order.productName,
    code: order.submittedAt ? "" : decrypt(order.code),
    expiresAt: order.expiresAt,
    alreadySubmitted: Boolean(order.submittedAt),
  };
}

export async function submitPublicOrderCode(token: string, code: string) {
  const tokenHash = hash(token);
  const now = new Date();
  const [existing] = await db
    .select({
      submittedAt: syncOrdersTable.publicSubmittedAt,
      expiresAt: syncOrdersTable.publicLinkExpiresAt,
      isReturned: syncOrdersTable.isReturned,
    })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.publicTokenHash, tokenHash));
  if (!existing || !existing.expiresAt || existing.expiresAt <= now) return null;
  if (existing.isReturned) return { returned: true as const };
  if (existing.submittedAt) {
    return { returned: false as const, alreadySubmitted: true };
  }
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      publicSubmittedAt: now,
      publicSubmittedCodeHash: hash(code.trim()),
      publicSubmissionError: null,
      status: "processing",
      updatedAt: now,
    })
    .where(
      and(
        eq(syncOrdersTable.publicTokenHash, tokenHash),
        gt(syncOrdersTable.publicLinkExpiresAt, now),
        isNull(syncOrdersTable.publicSubmittedAt),
      ),
    )
    .returning({ id: syncOrdersTable.id });
  return {
    returned: false as const,
    alreadySubmitted: !updated,
  };
}