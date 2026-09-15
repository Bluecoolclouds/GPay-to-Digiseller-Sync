import { and, eq } from "drizzle-orm";
import { activitiesTable, db, syncOrdersTable, type SyncOrder } from "@workspace/db";
import { fetchGPayKeyPurchaseStatus } from "./gpay";

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

export async function reconcileUnknownGPayPurchase(input: {
  invoiceId: string;
  uniqueCode?: string;
  orderId?: number;
  reason: string;
}): Promise<SyncOrder | undefined> {
  const [order] = await db
    .select()
    .from(syncOrdersTable)
    .where(eq(syncOrdersTable.invoiceId, input.invoiceId));
  if (!order) return undefined;
  if (order.gpayPurchaseStatus !== "unknown") {
    throw new GPayReconciliationConflictError(
      "Сверка доступна только для закупки с неизвестным статусом",
    );
  }

  const uniqueCode = input.uniqueCode?.trim();
  if (!uniqueCode) {
    await recordDecision({
      invoiceId: input.invoiceId,
      title: "Закупка GPay оставлена на ручной проверке",
      description: input.reason.trim(),
      status: "warning",
    });
    const [updated] = await db
      .update(syncOrdersTable)
      .set({
        gpayPurchaseError: `Ручная сверка: ${input.reason.trim()}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncOrdersTable.id, order.id),
          eq(syncOrdersTable.gpayPurchaseStatus, "unknown"),
        ),
      )
      .returning();
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

  if (input.orderId && purchase.orderId !== input.orderId) {
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

  const completed = purchase.isTerminal ? new Date() : null;
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      gpayPurchaseUniqueCode: purchase.uniqueCode,
      gpayPurchaseOrderId: purchase.orderId,
      gpayPurchaseStatus: purchase.deliveryStatus,
      gpayPurchaseCompletedAt: completed,
      gpayPurchaseError: purchase.errorMessage,
      publicSubmissionError: purchase.errorMessage,
      ...(purchase.deliveryStatus === "delivered"
        ? { status: "delivered" as const }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(syncOrdersTable.id, order.id),
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
    title: "Закупка GPay сверена",
    description: `${input.reason.trim()}. GPay подтвердил операцию ${purchase.orderId}, статус: ${purchase.deliveryStatus}`,
    status: "success",
  });
  return updated;
}