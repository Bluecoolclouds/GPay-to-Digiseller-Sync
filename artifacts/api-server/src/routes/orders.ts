import { Router, type IRouter } from "express";
import {
  ListOrdersQueryParams,
  ListOrdersResponse,
  SyncOrdersResponse,
  UpdateOrderBody,
  UpdateOrderParams,
  UpdateOrderResponse,
} from "@workspace/api-zod";
import {
  listOrders,
  ReturnedOrderConfirmationRequiredError,
  syncDigisellerOrders,
  updateOrder,
} from "../lib/orders";
import { requireOperatorRole } from "../middlewares/auth";

const router: IRouter = Router();

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
}) {
  return {
    ...order,
    saleTimestamp: order.saleTimestamp.toISOString(),
    syncedAt: order.syncedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

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