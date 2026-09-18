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
  sql,
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
import {
  markDigisellerUniqueCodeDelivered,
  verifyDigisellerUniqueCode,
} from "./digiseller";
import { logger } from "./logger";
import { sendDigisellerThankYou } from "./digiseller-chat";
import {
  notifyFailure,
  notifyRecovery,
  sanitizeNotificationText,
} from "./notifications";

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
  const encryptedCode = encrypt(code.trim());
  const [order] = await db
    .update(syncOrdersTable)
    .set({
      publicTokenHash: hash(token),
      publicLinkExpiresAt: expiresAt,
      publicCodeEncrypted: sql`case when ${syncOrdersTable.publicSubmittedAt} is null then ${encryptedCode} else ${syncOrdersTable.publicCodeEncrypted} end`,
      publicSubmissionError: sql`case when ${syncOrdersTable.publicSubmittedAt} is null then null else ${syncOrdersTable.publicSubmissionError} end`,
      publicOpenedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(syncOrdersTable.invoiceId, invoiceId))
    .returning({ invoiceId: syncOrdersTable.invoiceId });
  return order ? { token, expiresAt } : null;
}

export async function createVerifiedPublicOrderLink(
  invoiceId: string,
  code: string,
) {
  const normalizedInvoiceId = invoiceId.trim();
  const normalizedCode = code.trim();
  const [order] = await db
    .select({
      invoiceId: syncOrdersTable.invoiceId,
      digisellerProductId: syncOrdersTable.digisellerProductId,
      isReturned: syncOrdersTable.isReturned,
    })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.invoiceId, normalizedInvoiceId));
  if (!order || order.isReturned) return null;

  const verified = await verifyDigisellerUniqueCode(normalizedCode);
  if (
    verified.invoiceId !== order.invoiceId ||
    verified.productId !== order.digisellerProductId ||
    ![1, 5].includes(verified.state)
  ) {
    return null;
  }
  return createPublicOrderLink(order.invoiceId, normalizedCode);
}

export async function getPublicOrder(token: string) {
  const tokenHash = hash(token);
  const [order] = await db
    .select({
      id: syncOrdersTable.id,
      productName: syncOrdersTable.productName,
      code: syncOrdersTable.publicCodeEncrypted,
      expiresAt: syncOrdersTable.publicLinkExpiresAt,
      submittedAt: syncOrdersTable.publicSubmittedAt,
      deliveredKey: syncOrdersTable.gpayDeliveredKeyEncrypted,
      deliveryStatus: syncOrdersTable.digisellerDeliveryStatus,
      deliveryError: syncOrdersTable.digisellerDeliveryError,
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
  const result = {
    returned: false as const,
    productName: order.productName,
    code: order.submittedAt ? "" : decrypt(order.code),
    deliveredKey:
      order.deliveryStatus === "delivered" ? decrypt(order.deliveredKey) : "",
    deliveryStatus: order.deliveryStatus,
    deliveryError: order.deliveryError,
    expiresAt: order.expiresAt,
    alreadySubmitted: Boolean(order.submittedAt),
  };
  if (result.deliveryStatus === "delivered" && result.deliveredKey) {
    void sendDigisellerThankYou(order.id).catch((error) => {
      logger.warn({ err: error, orderId: order.id }, "Could not send Digiseller thank-you");
    });
  }
  return result;
}

export async function submitPublicOrderCode(token: string, code: string) {
  const tokenHash = hash(token);
  const now = new Date();
  const [existing] = await db
    .select({
      id: syncOrdersTable.id,
      invoiceId: syncOrdersTable.invoiceId,
      digisellerProductId: syncOrdersTable.digisellerProductId,
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
  const submittedCode = code.trim();
  let verified;
  try {
    verified = await verifyDigisellerUniqueCode(submittedCode);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Не удалось проверить код Digiseller";
    await db
      .update(syncOrdersTable)
      .set({ publicSubmissionError: message, updatedAt: now })
      .where(eq(syncOrdersTable.id, existing.id));
    return {
      returned: false as const,
      alreadySubmitted: false,
      error: message,
    };
  }
  if (
    verified.invoiceId !== existing.invoiceId ||
    verified.productId !== existing.digisellerProductId
  ) {
    const message = "Код Digiseller относится к другому заказу или товару";
    await db
      .update(syncOrdersTable)
      .set({ publicSubmissionError: message, updatedAt: now })
      .where(eq(syncOrdersTable.id, existing.id));
    return {
      returned: false as const,
      alreadySubmitted: false,
      error: message,
    };
  }
  if (![1, 5].includes(verified.state)) {
    const message = "По этому коду Digiseller товар уже был передан";
    await db
      .update(syncOrdersTable)
      .set({ publicSubmissionError: message, updatedAt: now })
      .where(eq(syncOrdersTable.id, existing.id));
    return {
      returned: false as const,
      alreadySubmitted: false,
      error: message,
    };
  }
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      publicSubmittedAt: now,
      publicSubmittedCodeHash: hash(submittedCode),
      publicSubmittedCodeEncrypted: encrypt(submittedCode),
      publicSubmissionError: null,
      gpayPurchaseStatus: "queued",
      gpayPurchaseError: null,
      digisellerDeliveryStatus: "queued",
      digisellerDeliveryError: null,
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
    logger.error(
      { err: sanitizeNotificationText(error), orderId },
      "Unhandled GPay purchase processing failure",
    );
  });
}

function purchaseError(error: unknown) {
  if (error instanceof GPayPurchaseAmbiguousError) {
    return "Ответ GPay после отправки закупки не получен: автоматический повтор заблокирован во избежание двойного списания";
  }
  return error instanceof Error ? error.message : "Неизвестная ошибка закупки GPay";
}

export async function saveGPayPurchaseResult(
  orderId: number,
  result: GPayKeyPurchase,
  expectedStatuses?: string[],
) {
  const terminal = result.isTerminal;
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: result.deliveryStatus,
      gpayPurchaseUniqueCode: result.uniqueCode,
      gpayPurchaseOrderId: result.orderId,
      gpayPurchaseCompletedAt: terminal ? new Date() : null,
      gpayPurchaseError: result.errorMessage,
      publicSubmissionError: result.errorMessage,
      ...(result.deliveredKey
        ? { gpayDeliveredKeyEncrypted: encrypt(result.deliveredKey) }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.id, orderId),
        or(
          ...(expectedStatuses
            ? [inArray(syncOrdersTable.gpayPurchaseStatus, expectedStatuses)]
            : [
                isNull(syncOrdersTable.gpayPurchaseStatus),
                notInArray(syncOrdersTable.gpayPurchaseStatus, [
                  "delivered",
                  "failed",
                ]),
              ]),
        ),
      ),
    )
    .returning({ id: syncOrdersTable.id });
  if (updated && result.deliveryStatus === "delivered") {
    await processDigisellerDelivery(orderId);
  } else if (updated && result.deliveryStatus === "failed") {
    await notifyFailure({
      key: `gpay-purchase:${orderId}`,
      title: "Не удалось выполнить покупку GPay",
      reason: result.errorMessage ?? "GPay сообщил об ошибке покупки",
    });
  }
  return Boolean(updated);
}

function assertMatchingDigisellerOrder(
  expected: { invoiceId: string; digisellerProductId: number },
  actual: { invoiceId: string; productId: number },
) {
  if (
    actual.invoiceId !== expected.invoiceId ||
    actual.productId !== expected.digisellerProductId
  ) {
    throw new Error("Digiseller подтвердил передачу для другого заказа или товара");
  }
}
export async function processGPayPurchase(orderId: number) {
  const [order] = await db
    .select({
      id: syncOrdersTable.id,
      digisellerProductId: syncOrdersTable.digisellerProductId,
      purchaseStatus: syncOrdersTable.gpayPurchaseStatus,
      uniqueCode: syncOrdersTable.gpayPurchaseUniqueCode,
      startedAt: syncOrdersTable.gpayPurchaseStartedAt,
      deliveredKey: syncOrdersTable.gpayDeliveredKeyEncrypted,
      gpayId: productsTable.gpayId,
      productType: productsTable.productType,
      supplierPriceUsd: productsTable.supplierPriceUsd,
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
  if (!order || order.purchaseStatus === "failed") return;
  if (order.purchaseStatus === "delivered") {
    if (!order.deliveredKey && order.uniqueCode) {
      try {
        const saved = await saveGPayPurchaseResult(
          orderId,
          await fetchGPayKeyPurchaseStatus(order.uniqueCode),
          ["delivered"],
        );
        if (saved) {
          await notifyRecovery(
            `gpay-poll:${orderId}`,
            "Проверка результата покупки GPay",
          );
        }
      } catch (error) {
        const message = purchaseError(error);
        await db
          .update(syncOrdersTable)
          .set({
            gpayPurchaseError: message,
            publicSubmissionError: message,
            updatedAt: new Date(),
          })
          .where(eq(syncOrdersTable.id, orderId));
        await notifyFailure({
          key: `gpay-poll:${orderId}`,
          title: "Не удалось проверить результат покупки GPay",
          reason: message,
        });
      }
      return;
    }
    await processDigisellerDelivery(orderId);
    return;
  }
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
    await notifyFailure({
      key: `gpay-purchase:${orderId}`,
      title: "Не удалось выполнить покупку GPay",
      reason: "Не найден связанный товар GPay",
    });
    return;
  }
  if (order.uniqueCode) {
    try {
      const saved = await saveGPayPurchaseResult(
        orderId,
        await fetchGPayKeyPurchaseStatus(order.uniqueCode),
      );
      if (saved) {
        await notifyRecovery(
          `gpay-poll:${orderId}`,
          "Проверка результата покупки GPay",
        );
      }
    } catch (error) {
      const message = purchaseError(error);
      await db
        .update(syncOrdersTable)
        .set({ gpayPurchaseError: message, publicSubmissionError: message, updatedAt: new Date() })
        .where(eq(syncOrdersTable.id, orderId));
      await notifyFailure({
        key: `gpay-poll:${orderId}`,
        title: "Не удалось проверить результат покупки GPay",
        reason: message,
      });
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
    await notifyFailure({
      key: "supplier-auth:gpay-login",
      title: "Ошибка авторизации GPay",
      reason: message,
    });
    return;
  }
  await notifyRecovery("supplier-auth:gpay-login", "Авторизация GPay");
  const [claimed] = await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseStatus: "creating",
      gpayPurchaseStartedAt: new Date(),
      gpayPurchaseExpectedAmountUsd: order.supplierPriceUsd,
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
    await saveGPayPurchaseResult(
      orderId,
      await purchaseGPayKey(order.gpayId, token),
    );
    await notifyRecovery(
      "supplier-auth:gpay-purchase",
      "Авторизация покупки GPay",
    );
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
      await notifyFailure({
        key: "supplier-auth:gpay-purchase",
        title: "Ошибка авторизации GPay",
        reason: "GPay отклонил авторизацию при создании покупки",
      });
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
    await notifyFailure({
      key: `gpay-purchase:${orderId}`,
      title: ambiguous
        ? "Неоднозначный результат покупки GPay"
        : "Не удалось выполнить покупку GPay",
      reason: message,
    });
  }
}

export async function reconcilePendingGPayPurchases() {
  const staleCreatingBefore = new Date(Date.now() - 2 * 60 * 1_000);
  const ambiguousPurchases = await db
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
    )
    .returning({ id: syncOrdersTable.id });
  for (const purchase of ambiguousPurchases) {
    await notifyFailure({
      key: `gpay-purchase:${purchase.id}`,
      title: "Неоднозначный результат покупки GPay",
      reason:
        "Процесс прервался во время создания закупки; автоматический повтор заблокирован",
    });
  }
  await db
    .update(syncOrdersTable)
    .set({
      digisellerDeliveryStatus: "failed",
      digisellerDeliveryError:
        "Процесс прервался во время передачи; выполняется безопасный повтор",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.digisellerDeliveryStatus, "delivering"),
        lt(syncOrdersTable.digisellerDeliveryStartedAt, staleCreatingBefore),
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
            eq(syncOrdersTable.gpayPurchaseStatus, "delivered"),
            or(
              isNull(syncOrdersTable.digisellerDeliveryStatus),
                eq(syncOrdersTable.digisellerDeliveryStatus, "queued"),
              eq(syncOrdersTable.digisellerDeliveryStatus, "failed"),
            ),
          ),
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

async function processDigisellerDelivery(orderId: number) {
  const [order] = await db
    .select({
      invoiceId: syncOrdersTable.invoiceId,
      digisellerProductId: syncOrdersTable.digisellerProductId,
      submittedCode: syncOrdersTable.publicSubmittedCodeEncrypted,
      deliveredKey: syncOrdersTable.gpayDeliveredKeyEncrypted,
      purchaseStatus: syncOrdersTable.gpayPurchaseStatus,
      deliveryStatus: syncOrdersTable.digisellerDeliveryStatus,
    })
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.id, orderId));
  if (
    !order ||
    order.deliveryStatus === "delivered" ||
    order.purchaseStatus !== "delivered"
  ) {
    return;
  }
  if (!order.deliveredKey) {
    await db
      .update(syncOrdersTable)
      .set({
        digisellerDeliveryStatus: "failed",
        digisellerDeliveryError:
          "GPay сообщил о доставке, но не вернул ключ для передачи покупателю",
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    await notifyFailure({
      key: `digiseller-delivery:${orderId}`,
      title: "Ошибка выдачи ключа Digiseller",
      reason: "GPay не вернул ключ после подтверждения доставки",
    });
    return;
  }
  if (!order.submittedCode) {
    await db
      .update(syncOrdersTable)
      .set({
        digisellerDeliveryStatus: "failed",
        digisellerDeliveryError: "Код заказа Digiseller не сохранён",
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    await notifyFailure({
      key: `digiseller-delivery:${orderId}`,
      title: "Ошибка выдачи ключа Digiseller",
      reason: "Код заказа Digiseller не сохранён",
    });
    return;
  }
  const [claimed] = await db
    .update(syncOrdersTable)
    .set({
      digisellerDeliveryStatus: "delivering",
      digisellerDeliveryStartedAt: new Date(),
      digisellerDeliveryError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.id, orderId),
        or(
          isNull(syncOrdersTable.digisellerDeliveryStatus),
          eq(syncOrdersTable.digisellerDeliveryStatus, "queued"),
          eq(syncOrdersTable.digisellerDeliveryStatus, "failed"),
        ),
      ),
    )
    .returning({ id: syncOrdersTable.id });
  if (!claimed) return;
  try {
    const result = await markDigisellerUniqueCodeDelivered(
      decrypt(order.submittedCode),
    );
    assertMatchingDigisellerOrder(order, result);
    await db
      .update(syncOrdersTable)
      .set({
        digisellerDeliveryStatus: "delivered",
        digisellerDeliveryCompletedAt: new Date(),
        digisellerDeliveryError: null,
        publicSubmissionError: null,
        status: "delivered",
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    await notifyRecovery(
      `digiseller-delivery:${orderId}`,
      "Выдача ключа Digiseller",
    );
    await notifyRecovery(`gpay-purchase:${orderId}`, "Покупка GPay");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Неизвестная ошибка передачи Digiseller";
    await db
      .update(syncOrdersTable)
      .set({
        digisellerDeliveryStatus: "failed",
        digisellerDeliveryError: message,
        updatedAt: new Date(),
      })
      .where(eq(syncOrdersTable.id, orderId));
    await notifyFailure({
      key: `digiseller-delivery:${orderId}`,
      title: "Ошибка выдачи ключа Digiseller",
      reason: message,
    });
  }
}
