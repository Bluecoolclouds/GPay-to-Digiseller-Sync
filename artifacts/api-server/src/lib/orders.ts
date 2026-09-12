import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  productsTable,
  syncOrdersTable,
  type SyncOrder,
} from "@workspace/db";
import { fetchDigisellerLastSales, type DigisellerSale } from "./digiseller";

const ORDER_SYNC_LOCK_ID = 704_291_164;

type DbExecutor = Pick<typeof db, "select" | "insert">;

export type OrderSyncResult = {
  fetched: number;
  inserted: number;
  updated: number;
  ignored: number;
  skipped: boolean;
};

function parseSaleDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Upsert sales while deliberately excluding status and operatorNote from the
 * update set. Those two fields are local fulfillment state and must survive
 * every external resynchronization.
 */
export async function upsertDigisellerSales(
  executor: DbExecutor,
  sales: DigisellerSale[],
): Promise<Omit<OrderSyncResult, "skipped" | "fetched">> {
  const validSales = sales.flatMap((sale) => {
    const saleTimestamp = parseSaleDate(sale.date);
    return saleTimestamp ? [{ sale, saleTimestamp }] : [];
  });
  const productIds = [...new Set(validSales.map(({ sale }) => sale.productId))];
  const products = productIds.length
    ? await executor
        .select({
          digisellerId: productsTable.digisellerId,
          previousDigisellerId: productsTable.previousDigisellerId,
        })
        .from(productsTable)
        .where(
          or(
            inArray(productsTable.digisellerId, productIds),
            inArray(productsTable.previousDigisellerId, productIds),
          ),
        )
    : [];
  const mappedProductIds = new Set(
    products
      .flatMap((product) => [
        product.digisellerId,
        product.previousDigisellerId,
      ])
      .filter((id): id is number => id !== null),
  );

  let inserted = 0;
  let updated = 0;
  let ignored = sales.length - validSales.length;
  for (const { sale, saleTimestamp } of validSales) {
    if (!mappedProductIds.has(sale.productId)) {
      ignored++;
      continue;
    }
    const [existing] = await executor
      .select({ id: syncOrdersTable.id })
      .from(syncOrdersTable)
      .where(eq(syncOrdersTable.invoiceId, sale.invoiceId));
    await executor
      .insert(syncOrdersTable)
      .values({
        invoiceId: sale.invoiceId,
        digisellerProductId: sale.productId,
        productName: sale.productName,
        paidAmountRub: sale.paidAmountRub,
        saleTimestamp,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: syncOrdersTable.invoiceId,
        set: {
          digisellerProductId: sale.productId,
          productName: sale.productName,
          paidAmountRub: sale.paidAmountRub,
          saleTimestamp,
          syncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    if (existing) updated++;
    else inserted++;
  }
  return { inserted, updated, ignored };
}

export async function syncDigisellerOrders(): Promise<OrderSyncResult> {
  return db.transaction(async (tx) => {
    const lockResult = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${ORDER_SYNC_LOCK_ID}) as locked`,
    );
    const locked = Boolean(
      (lockResult.rows[0] as { locked?: boolean } | undefined)?.locked,
    );
    if (!locked) {
      return {
        fetched: 0,
        inserted: 0,
        updated: 0,
        ignored: 0,
        skipped: true,
      };
    }
    const sales = await fetchDigisellerLastSales();
    const result = await upsertDigisellerSales(tx, sales);
    return { fetched: sales.length, ...result, skipped: false };
  });
}

export async function listOrders(input: {
  status?: "all" | "new" | "processing" | "delivered";
  search?: string;
  page: number;
  pageSize: number;
}) {
  const filters = [];
  if (input.status && input.status !== "all") {
    filters.push(eq(syncOrdersTable.status, input.status));
  }
  if (input.search) {
    filters.push(
      sql`(${ilike(syncOrdersTable.invoiceId, `%${input.search}%`)} or ${ilike(syncOrdersTable.productName, `%${input.search}%`)})`,
    );
  }
  const where = filters.length ? and(...filters) : undefined;
  const [countRow] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(syncOrdersTable)
    .where(where);
  const items = await db
    .select()
    .from(syncOrdersTable)
    .where(where)
    .orderBy(desc(syncOrdersTable.saleTimestamp), desc(syncOrdersTable.id))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
  return { items, total: countRow?.total ?? 0 };
}

export async function updateOrder(
  invoiceId: string,
  values: { status?: "new" | "processing" | "delivered"; note?: string | null },
): Promise<SyncOrder | undefined> {
  const [updated] = await db
    .update(syncOrdersTable)
    .set({
      ...(values.status !== undefined ? { status: values.status } : {}),
      ...(values.note !== undefined ? { operatorNote: values.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(syncOrdersTable.invoiceId, invoiceId))
    .returning();
  return updated;
}