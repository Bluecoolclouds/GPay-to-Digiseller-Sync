import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import {
  db,
  productsTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
} from "@workspace/db";
import {
  classifyGPayProductType,
  fetchGPayKeyPurchaseStatus,
  GPayPurchaseAmbiguousError,
  GPayPurchaseUnauthorizedError,
  loginGPay,
  purchaseGPayKey,
  type GPayKeyPurchase,
} from "./gpay";
import { logger } from "./logger";

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
      id: syncOrdersTable.id,
      submittedAt: syncOrdersTable.publicSubmittedAt,
      expiresAt: syncOrdersTable.publicLinkExpiresAt,
      isReturned: syncOrdersTable.isReturned,
    })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.publicTokenHash, tokenHash));
  if (!existing || !existing.expiresAt || existing.expiresAt <= now) return null;
  if (existing.isReturned) return { returned: true as const };
  if (existing.submittedAt) {
    queueGPayPurchase(existing.id);
    return { returned: false as const, alreadySubmitted: true };
  }
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      publicSubmittedAt: now,
      publicSubmittedCodeHash: hash(code.trim()),
      publicSubmissionError: null,
      gpayPurchaseStatus: "queued",
      gpayPurchaseError: null,
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
  if (updated) queueGPayPurchase(updated.id);
  return {
    returned: false as const,
    alreadySubmitted: !updated,
  };
}

function queueGPayPurchase(orderId: number) {
  void processGPayPurchase(orderId).catch((error) => {
    logger.error({ err: error, orderId }, "Unhandled GPay purchase processing failure");
  });
}

function purchaseError(error: unknown) {
  if (error instanceof GPayPurchaseAmbiguousError) {
    return "Ответ GPay после отправки закупки не получен: автоматический повтор заблокирован во избежание двойного списания";
  }
  return error instanceof Error ? error.message : "Неизвестная ошибка закупки GPay";
}

async function savePurchaseResult(orderId: number, result: GPayKeyPurchase) {
  const terminal = result.isTerminal;
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: result.deliveryStatus,
      gpayPurchaseUniqueCode: result.uniqueCode,
      gpayPurchaseOrderId: result.orderId,
      gpayPurchaseCompletedAt: terminal ? new Date() : null,
      gpayPurchaseError: result.errorMessage,
      publicSubmissionError: result.errorMessage,
      ...(result.deliveryStatus === "delivered" ? { status: "delivered" as const } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.id, orderId),
        or(
          isNull(syncOrdersTable.gpayPurchaseStatus),
          notInArray(syncOrdersTable.gpayPurchaseStatus, ["delivered", "failed"]),
        ),
      ),
    );
}

export async function processGPayPurchase(orderId: number) {
  const [order] = await db
    .select({
      id: syncOrdersTable.id,
      digisellerProductId: syncOrdersTable.digisellerProductId,
      purchaseStatus: syncOrdersTable.gpayPurchaseStatus,
      uniqueCode: syncOrdersTable.gpayPurchaseUniqueCode,
      startedAt: syncOrdersTable.gpayPurchaseStartedAt,
      gpayId: productsTable.gpayId,
      productType: productsTable.productType,
    })
    .from(syncOrdersTable)
    .leftJoin(
      syncProductDigisellerIdsTable,
      eq(
        syncProductDigisellerIdsTable.digisellerProductId,
        syncOrdersTable.digisellerProductId,
      ),
    )
    .leftJoin(
      productsTable,
      eq(productsTable.id, syncProductDigisellerIdsTable.localProductId),
    )
    .where(eq(syncOrdersTable.id, orderId));
  if (!order || order.purchaseStatus === "delivered" || order.purchaseStatus === "failed") return;
  if (order.productType && classifyGPayProductType(order.productType) !== "key") {
    await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseStatus: "manual",
        gpayPurchaseError: "Steam Gift остаётся на ручной обработке",
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    return;
  }
  if (!order.gpayId || !order.productType) {
    await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseStatus: "failed",
        gpayPurchaseCompletedAt: new Date(),
        gpayPurchaseError: "Не найден связанный товар GPay",
        publicSubmissionError: "Не найден связанный товар GPay",
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    return;
  }
  if (order.uniqueCode) {
    try {
      await savePurchaseResult(
        orderId,
        await fetchGPayKeyPurchaseStatus(order.uniqueCode),
      );
    } catch (error) {
      const message = purchaseError(error);
      await db
        .update(syncOrdersTable)
        .set({ gpayPurchaseError: message, publicSubmissionError: message, updatedAt: new Date() })
        .where(eq(syncOrdersTable.id, orderId));
    }
    return;
  }
  if (order.startedAt) return;
  let token: string;
  try {
    token = await loginGPay();
  } catch (error) {
    const message = purchaseError(error);
    await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseStatus: "queued",
        gpayPurchaseError: message,
        publicSubmissionError: message,
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    return;
  }
  const [claimed] = await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "creating",
      gpayPurchaseStartedAt: new Date(),
      gpayPurchaseError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.id, orderId),
        isNull(syncOrdersTable.gpayPurchaseStartedAt),
      ),
    )
    .returning({ id: syncOrdersTable.id });
  if (!claimed) return;
  try {
    await savePurchaseResult(orderId, await purchaseGPayKey(order.gpayId, token));
  } catch (error) {
    const message = purchaseError(error);
    if (error instanceof GPayPurchaseUnauthorizedError) {
      await db
        .update(syncOrdersTable)
        .set({
          gpayPurchaseStatus: "queued",
          gpayPurchaseStartedAt: null,
          gpayPurchaseError: message,
          publicSubmissionError: message,
          updatedAt: new Date(),
        })
        .where(eq(syncOrdersTable.id, orderId));
      return;
    }
    const ambiguous = error instanceof GPayPurchaseAmbiguousError;
    await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseStatus:
          ambiguous ? "unknown" : "failed",
        gpayPurchaseCompletedAt:
          ambiguous ? null : new Date(),
        gpayPurchaseError: message,
        publicSubmissionError: message,
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
  }
}

export async function reconcilePendingGPayPurchases() {
  const staleCreatingBefore = new Date(Date.now() - 2 * 60 * 1_000);
  await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "unknown",
      gpayPurchaseError:
        "Процесс прервался во время создания закупки; автоматический повтор заблокирован",
      publicSubmissionError:
        "Процесс прервался во время создания закупки; автоматический повтор заблокирован",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.gpayPurchaseStatus, "creating"),
        isNull(syncOrdersTable.gpayPurchaseUniqueCode),
        lt(syncOrdersTable.gpayPurchaseStartedAt, staleCreatingBefore),
      ),
    );
  const pending = await db
    .select({ id: syncOrdersTable.id })
    .from(syncOrdersTable)
    .where(
      and(
        isNotNull(syncOrdersTable.publicSubmittedAt),
        or(
          eq(syncOrdersTable.gpayPurchaseStatus, "queued"),
          isNull(syncOrdersTable.gpayPurchaseStatus),
          and(
            inArray(syncOrdersTable.gpayPurchaseStatus, [
              "processing",
              "awaitingActivation",
            ]),
            isNotNull(syncOrdersTable.gpayPurchaseUniqueCode),
          ),
        ),
      ),
    );
  for (const order of pending) {
    await processGPayPurchase(order.id);
  }
  return { checked: pending.length };
}