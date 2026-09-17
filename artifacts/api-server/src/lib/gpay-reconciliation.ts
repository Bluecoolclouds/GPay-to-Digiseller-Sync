import { and, eq } from "drizzle-orm";
import {
  activitiesTable,
  db,
  productsTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
  type SyncOrder,
} from "@workspace/db";
import {
  fetchGPayKeyOrderHistory,
  fetchGPayKeyPurchaseStatus,
  type GPayPartnerOrder,
} from "./gpay";
import { saveGPayPurchaseResult } from "./public-orders";

const MATCH_WINDOW_MS = 3 * 60 * 1_000;
const HISTORY_SETTLING_MS = 30 * 1_000;

export class GPayReconciliationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPayReconciliationConflictError";
  }
}

export class GPayReconciliationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GPayReconciliationUnavailableError";
  }
}

async function recordDecision(input: {
  invoiceId: string;
  title: string;
  description: string;
  status: "success" | "warning" | "error";
}) {
  await db.insert(activitiesTable).values({
    type: "connection",
    title: input.title,
    description: `Заказ ${input.invoiceId}: ${input.description}`,
    status: input.status,
  });
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (
      typeof current === "object" &&
      "code" in current &&
      current.code === "23505"
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return false;
}

export async function reconcileUnknownGPayPurchase(input: {
  invoiceId: string;
  uniqueCode?: string;
  orderId?: number;
  searchHistory?: boolean;
  reason: string;
}): Promise<SyncOrder | undefined> {
  const [order] = await db
    .select({
      order: syncOrdersTable,
      gpayId: productsTable.gpayId,
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
    .where(eq(syncOrdersTable.invoiceId, input.invoiceId));
  if (!order) return undefined;
  if (order.order.gpayPurchaseStatus !== "unknown") {
    throw new GPayReconciliationConflictError(
      "Сверка доступна только для закупки с неизвестным статусом",
    );
  }

  let uniqueCode = input.uniqueCode?.trim();
  let matchedOrderId = input.orderId;
  if (!uniqueCode && input.searchHistory) {
    const expectedAmount = order.order.gpayPurchaseExpectedAmountUsd;
    const startedAt = order.order.gpayPurchaseStartedAt;
    if (!order.gpayId || expectedAmount === null || !startedAt) {
      throw new GPayReconciliationConflictError(
        "Для автоматического поиска не хватает товара, суммы или времени закупки",
      );
    }
    const safeAfter =
      startedAt.getTime() + MATCH_WINDOW_MS + HISTORY_SETTLING_MS;
    if (Date.now() < safeAfter) {
      const seconds = Math.ceil((safeAfter - Date.now()) / 1_000);
      throw new GPayReconciliationConflictError(
        `История ещё формируется. Повторите поиск через ${seconds} сек.`,
      );
    }
    let candidates: GPayPartnerOrder[];
    try {
      candidates = findGPayPurchaseCandidates({
        orders: await fetchGPayKeyOrderHistory(),
        productId: order.gpayId,
        expectedAmountUsd: expectedAmount,
        startedAt,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "GPay history API unavailable";
      await recordDecision({
        invoiceId: input.invoiceId,
        title: "Поиск закупки GPay не выполнен",
        description: `${input.reason.trim()}. Ошибка истории: ${message}`,
        status: "error",
      });
      throw new GPayReconciliationUnavailableError(message);
    }
    if (candidates.length !== 1) {
      const message =
        candidates.length === 0
          ? "В истории GPay не найдено однозначного совпадения"
          : `В истории GPay найдено несколько совпадений: ${candidates.length}`;
      const [updated] = await db
        .update(syncOrdersTable)
        .set({ gpayPurchaseError: message, updatedAt: new Date() })
        .where(
          and(
            eq(syncOrdersTable.id, order.order.id),
            eq(syncOrdersTable.gpayPurchaseStatus, "unknown"),
          ),
        )
        .returning();
      if (!updated) {
        throw new GPayReconciliationConflictError(
          "Состояние закупки изменилось во время сверки",
        );
      }
      await recordDecision({
        invoiceId: input.invoiceId,
        title: "Автоматическая сверка GPay требует ручной проверки",
        description: `${input.reason.trim()}. ${message}`,
        status: "warning",
      });
      return updated;
    }
    uniqueCode = candidates[0].uniqueCode ?? undefined;
    matchedOrderId = candidates[0].id;
  }
  if (!uniqueCode) {
    const [updated] = await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseError: `Ручная сверка: ${input.reason.trim()}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncOrdersTable.id, order.order.id),
          eq(syncOrdersTable.gpayPurchaseStatus, "unknown"),
        ),
      )
      .returning();
    if (!updated) {
      throw new GPayReconciliationConflictError(
        "Состояние закупки изменилось во время сверки",
      );
    }
    await recordDecision({
      invoiceId: input.invoiceId,
      title: "Закупка GPay оставлена на ручной проверке",
      description: input.reason.trim(),
      status: "warning",
    });
    return updated;
  }

  let purchase;
  try {
    purchase = await fetchGPayKeyPurchaseStatus(uniqueCode);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GPay status API unavailable";
    await recordDecision({
      invoiceId: input.invoiceId,
      title: "Сверка закупки GPay не выполнена",
      description: `${input.reason.trim()}. Проверка uniqueCode завершилась ошибкой: ${message}`,
      status: "error",
    });
    throw new GPayReconciliationUnavailableError(message);
  }

  if (matchedOrderId && purchase.orderId !== matchedOrderId) {
    await recordDecision({
      invoiceId: input.invoiceId,
      title: "Сверка закупки GPay отклонена",
      description: `${input.reason.trim()}. Указанный orderId не совпал с ответом GPay`,
      status: "warning",
    });
    throw new GPayReconciliationConflictError(
      "Указанный orderId не совпадает с операцией GPay",
    );
  }

  let saved = false;
  try {
    saved = await saveGPayPurchaseResult(
      order.order.id,
      purchase,
      ["unknown"],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await recordDecision({
      invoiceId: input.invoiceId,
      title: "Сверка закупки GPay отклонена",
      description: `${input.reason.trim()}. Операция GPay уже привязана к другому заказу`,
      status: "warning",
    });
    throw new GPayReconciliationConflictError(
      "Операция GPay уже привязана к другому заказу",
    );
  }
  if (!saved) {
    throw new GPayReconciliationConflictError(
      "Состояние закупки изменилось во время сверки",
    );
  }
  await recordDecision({
    invoiceId: input.invoiceId,
    title: "Закупка GPay сверена",
    description: `${input.reason.trim()}. GPay подтвердил операцию ${purchase.orderId}, статус: ${purchase.deliveryStatus}`,
    status: "success",
  });
  const [updated] = await db
    .select()
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.id, order.order.id));
  return updated;
}

export function findGPayPurchaseCandidates(input: {
  orders: GPayPartnerOrder[];
  productId: number;
  expectedAmountUsd: number;
  startedAt: Date;
}) {
  const earliest = input.startedAt.getTime() - MATCH_WINDOW_MS;
  const latest = input.startedAt.getTime() + MATCH_WINDOW_MS;
  return input.orders.filter((order) => {
    const createdAt = Date.parse(order.createdAt);
    return (
      order.productType === 2 &&
      order.itemId === input.productId &&
      Boolean(order.uniqueCode) &&
      Math.round(order.totalAmount * 10_000) ===
        Math.round(input.expectedAmountUsd * 10_000) &&
      Number.isFinite(createdAt) &&
      createdAt >= earliest &&
      createdAt <= latest
    );
  });
}