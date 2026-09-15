import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import {
  ListOrdersQueryParams,
  ListOrdersResponse,
  SyncOrdersResponse,
  UpdateOrderBody,
  UpdateOrderParams,
  UpdateOrderResponse,
  CreateOrderPublicLinkBody,
  CreateOrderPublicLinkParams,
  CreateOrderPublicLinkResponse,
  GetPublicOrderParams,
  GetPublicOrderResponse,
  SubmitPublicOrderCodeBody,
  SubmitPublicOrderCodeParams,
  SubmitPublicOrderCodeResponse,
  ReconcileOrderGPayPurchaseBody,
  ReconcileOrderGPayPurchaseParams,
  ReconcileOrderGPayPurchaseResponse,
} from "@workspace/api-zod";
import {
  listOrders,
  ReturnedOrderConfirmationRequiredError,
  syncDigisellerOrders,
  updateOrder,
} from "../lib/orders";
import { requireOperatorRole } from "../middlewares/auth";
import {
  createPublicOrderLink,
  getPublicOrder,
  submitPublicOrderCode,
} from "../lib/public-orders";
import {
  GPayReconciliationConflictError,
  GPayReconciliationUnavailableError,
  reconcileUnknownGPayPurchase,
} from "../lib/gpay-reconciliation";

const router: IRouter = Router();
export const publicOrdersRouter: IRouter = Router();

function serializeOrder(order: {
  id: number;
  invoiceId: string;
  digisellerProductId: number;
  productName: string;
  paidAmountRub: number | null;
  saleTimestamp: Date;
  status: "new" | "processing" | "delivered";
  isReturned: boolean;
  operatorNote: string | null;
  syncedAt: Date;
  updatedAt: Date;
  publicLinkExpiresAt: Date | null;
  publicOpenedAt: Date | null;
  publicSubmittedAt: Date | null;
  publicSubmissionError: string | null;
  gpayPurchaseStatus: string | null;
  gpayPurchaseUniqueCode: string | null;
  gpayPurchaseOrderId: number | null;
  gpayPurchaseStartedAt: Date | null;
  gpayPurchaseCompletedAt: Date | null;
  gpayPurchaseError: string | null;
}) {
  return {
    ...order,
    saleTimestamp: order.saleTimestamp.toISOString(),
    syncedAt: order.syncedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    publicLinkExpiresAt: order.publicLinkExpiresAt?.toISOString() ?? null,
    publicOpenedAt: order.publicOpenedAt?.toISOString() ?? null,
    publicSubmittedAt: order.publicSubmittedAt?.toISOString() ?? null,
    gpayPurchaseStartedAt: order.gpayPurchaseStartedAt?.toISOString() ?? null,
    gpayPurchaseCompletedAt: order.gpayPurchaseCompletedAt?.toISOString() ?? null,
  };
}

const attemptsByToken = new Map<string, { count: number; resetAt: number }>();
function publicAttemptAllowed(token: string) {
  const now = Date.now();
  if (attemptsByToken.size >= 10_000) {
    for (const [key, value] of attemptsByToken) {
      if (value.resetAt <= now) attemptsByToken.delete(key);
    }
    if (attemptsByToken.size >= 10_000) {
      attemptsByToken.delete(attemptsByToken.keys().next().value as string);
    }
  }
  const key = createHash("sha256").update(token).digest("hex");
  const current = attemptsByToken.get(key);
  if (!current || current.resetAt <= now) {
    attemptsByToken.set(key, { count: 1, resetAt: now + 15 * 60 * 1_000 });
    return true;
  }
  current.count++;
  return current.count <= 10;
}

publicOrdersRouter.get("/public/orders/:token", async (req, res): Promise<void> => {
  const params = GetPublicOrderParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Ссылка недоступна" });
    return;
  }
  const order = await getPublicOrder(params.data.token);
  if (!order || order.returned) {
    res.status(order?.returned ? 409 : 404).json({ error: "Ссылка недоступна или истекла" });
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.json(GetPublicOrderResponse.parse({
    productName: order.productName,
    code: order.code,
    expiresAt: order.expiresAt.toISOString(),
    alreadySubmitted: order.alreadySubmitted,
  }));
});

publicOrdersRouter.post("/public/orders/:token", async (req, res): Promise<void> => {
  const params = SubmitPublicOrderCodeParams.safeParse(req.params);
  const body = SubmitPublicOrderCodeBody.safeParse(req.body);
  if (!params.success || !body.success || (params.success && !publicAttemptAllowed(params.data.token))) {
    res.status(!params.success || !body.success ? 400 : 429).json({ error: "Не удалось принять код" });
    return;
  }
  const result = await submitPublicOrderCode(params.data.token, body.data.code);
  if (!result || result.returned) {
    res.status(result?.returned ? 409 : 404).json({ error: "Ссылка недоступна или истекла" });
    return;
  }
  res.json(SubmitPublicOrderCodeResponse.parse({
    accepted: true,
    alreadySubmitted: result.alreadySubmitted,
  }));
});

router.get("/orders", async (req, res): Promise<void> => {
  const parsed = ListOrdersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await listOrders(parsed.data);
  res.json(
    ListOrdersResponse.parse({
      items: result.items.map(serializeOrder),
      total: result.total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      sync: {
        ...result.sync,
        lastSuccessfulAt: result.sync.lastSuccessfulAt?.toISOString() ?? null,
        lastAttemptAt: result.sync.lastAttemptAt?.toISOString() ?? null,
      },
    }),
  );
});

router.post("/orders/sync", requireOperatorRole, async (req, res): Promise<void> => {
  try {
    res.json(SyncOrdersResponse.parse(await syncDigisellerOrders()));
  } catch (error) {
    req.log.error({ err: error }, "Digiseller order sync failed");
    res.status(502).json({
      error:
        error instanceof Error ? error.message : "Digiseller sales API error",
    });
  }
});

router.post("/orders/:invoiceId/public-link", requireOperatorRole, async (req, res): Promise<void> => {
  const params = CreateOrderPublicLinkParams.safeParse(req.params);
  const body = CreateOrderPublicLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Некорректные параметры ссылки" });
    return;
  }
  const link = await createPublicOrderLink(params.data.invoiceId, body.data.code ?? "");
  if (!link) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(CreateOrderPublicLinkResponse.parse({
    urlPath: `/order/${link.token}`,
    expiresAt: link.expiresAt.toISOString(),
  }));
});

router.post("/orders/:invoiceId/gpay-reconcile", requireOperatorRole, async (req, res): Promise<void> => {
  const params = ReconcileOrderGPayPurchaseParams.safeParse(req.params);
  const body = ReconcileOrderGPayPurchaseBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Укажите причину сверки и корректные идентификаторы GPay" });
    return;
  }
  try {
    const updated = await reconcileUnknownGPayPurchase({
      invoiceId: params.data.invoiceId,
      uniqueCode: body.data.uniqueCode,
      orderId: body.data.orderId,
      searchHistory: body.data.searchHistory,
      reason: body.data.reason,
    });
    if (!updated) {
      res.status(404).json({ error: "Заказ не найден" });
      return;
    }
    res.json(ReconcileOrderGPayPurchaseResponse.parse(serializeOrder(updated)));
  } catch (error) {
    if (error instanceof GPayReconciliationConflictError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof GPayReconciliationUnavailableError) {
      res.status(502).json({ error: `Не удалось проверить операцию GPay: ${error.message}` });
      return;
    }
    throw error;
  }
});

router.patch("/orders/:invoiceId", requireOperatorRole, async (req, res): Promise<void> => {
  const params = UpdateOrderParams.safeParse(req.params);
  const body = UpdateOrderBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: !params.success
        ? params.error.message
        : body.error?.message ?? "Invalid request",
    });
    return;
  }
  let updated;
  try {
    updated = await updateOrder(params.data.invoiceId, {
      status: body.data.status,
      note: body.data.note,
      confirmReturned: body.data.confirmReturned,
    });
  } catch (error) {
    if (error instanceof ReturnedOrderConfirmationRequiredError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!updated) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(UpdateOrderResponse.parse(serializeOrder(updated)));
});

export default router;