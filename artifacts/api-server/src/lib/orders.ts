import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  db,
  productsTable,
  syncOrderStateTable,
  syncOrdersTable,
  syncProductDigisellerIdsTable,
  type SyncOrder,
} from "@workspace/db";
import {
  fetchDigisellerSalesPage,
  loginDigiseller,
  parseDigisellerDate as parseDigisellerDateValue,
  type DigisellerSale,
} from "./digiseller";

const DEFAULT_ORDER_SYNC_LOCK_ID = 704_291_164;

/**
 * Advisory locks are database-wide, not schema-scoped.  Keep the production
 * lock stable, but namespace isolated test schemas so a scheduler using the
 * same database cannot make an otherwise healthy test report `skipped`.
 */
function getOrderSyncLockId() {
  const testSchema = process.env.TEST_DATABASE_SCHEMA;
  if (!testSchema) return DEFAULT_ORDER_SYNC_LOCK_ID;
  let hash = 2_166_136_261;
  for (const character of testSchema) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return 1_000_000_000 + (hash >>> 0) % 1_000_000_000;
}

type DbExecutor = Pick<typeof db, "select" | "insert">;

export type OrderSyncResult = {
  fetched: number;
  inserted: number;
  updated: number;
  ignored: number;
  skipped: boolean;
};

export const parseDigisellerDate = parseDigisellerDateValue;

function parseSaleAmount(sale: DigisellerSale) {
  const currency = sale.amountCurrency?.trim().toUpperCase();
  if (currency !== "RUB" && currency !== "RUR") return null;
  const amount = sale.amountIn;
  return amount !== null && amount !== undefined && Number.isFinite(amount)
    ? amount
    : null;
}

export async function recordDigisellerProductIds(
  executor: Pick<typeof db, "select" | "insert">,
  localProductId: number,
  digisellerProductIds: Array<number | null | undefined>,
) {
  const ids = [
    ...new Set(
      digisellerProductIds.filter(
        (id): id is number =>
          typeof id === "number" && Number.isInteger(id) && id > 0,
      ),
    ),
  ];
  for (const digisellerProductId of ids) {
    const now = new Date();
    const [existing] = await executor
      .select({
        localProductId: syncProductDigisellerIdsTable.localProductId,
      })
      .from(syncProductDigisellerIdsTable)
      .where(
        eq(
          syncProductDigisellerIdsTable.digisellerProductId,
          digisellerProductId,
        ),
      );
    if (existing && existing.localProductId !== localProductId) {
      throw new Error(
        `Digiseller product ID ${digisellerProductId} is already mapped to local product ${existing.localProductId}`,
      );
    }
    await executor
      .insert(syncProductDigisellerIdsTable)
      .values({
        localProductId,
        digisellerProductId,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: syncProductDigisellerIdsTable.digisellerProductId,
        set: { lastSeenAt: now },
      });
  }
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
  const validSales = sales.map((sale) => {
    const saleTimestamp = parseDigisellerDateValue(sale.date);
    if (!saleTimestamp) {
      throw new Error(
        `Digiseller sale ${sale.invoiceId || "unknown"} has an invalid date`,
      );
    }
    return { sale, saleTimestamp };
  });
  const productIds = [...new Set(validSales.map(({ sale }) => sale.productId))];
  const historicalProducts = productIds.length
    ? await executor
        .select({
          digisellerProductId:
            syncProductDigisellerIdsTable.digisellerProductId,
        })
        .from(syncProductDigisellerIdsTable)
        .where(
          inArray(
            syncProductDigisellerIdsTable.digisellerProductId,
            productIds,
          ),
        )
    : [];
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
  const mappedProductIds = new Set([
    ...historicalProducts.map((product) => product.digisellerProductId),
    ...products
      .flatMap((product) => [
        product.digisellerId,
        product.previousDigisellerId,
      ])
      .filter((id): id is number => id !== null),
  ]);

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
        paidAmountRub: parseSaleAmount(sale),
        saleTimestamp,
        syncedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: syncOrdersTable.invoiceId,
        set: {
          digisellerProductId: sale.productId,
          productName: sale.productName,
          paidAmountRub: parseSaleAmount(sale),
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
      sql`select pg_try_advisory_xact_lock(${getOrderSyncLockId()}) as locked`,
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
    const productRows = await tx
      .select({
        id: productsTable.id,
        digisellerId: productsTable.digisellerId,
        previousDigisellerId: productsTable.previousDigisellerId,
      })
      .from(productsTable);
    for (const product of productRows) {
      await recordDigisellerProductIds(tx, product.id, [
        product.digisellerId,
        product.previousDigisellerId,
      ]);
    }

    const [state] = await tx
      .select()
      .from(syncOrderStateTable)
      .where(eq(syncOrderStateTable.id, 1));
    const now = new Date();
    const dateStart = state?.cursorAt
      ? new Date(state.cursorAt.getTime() - 24 * 60 * 60 * 1_000)
      : new Date("1999-12-31T21:00:00.000Z");
    const formatMoscowDate = (date: Date) => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Moscow",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).formatToParts(date).map(({ type, value }) => [type, value]),
      ) as Record<string, string>;
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    };
    const startString = formatMoscowDate(dateStart);
    const finishString = formatMoscowDate(now);
    const knownIds = await tx
      .select({
        digisellerProductId:
          syncProductDigisellerIdsTable.digisellerProductId,
      })
      .from(syncProductDigisellerIdsTable);
    const ids = [
      ...new Set(knownIds.map(({ digisellerProductId }) => digisellerProductId)),
    ];
    if (ids.length === 0) {
      return {
        fetched: 0,
        inserted: 0,
        updated: 0,
        ignored: 0,
        skipped: false,
      };
    }

    let fetched = 0;
    let inserted = 0;
    let updated = 0;
    let ignored = 0;
    const token = await loginDigiseller();
    // Keep requests comfortably below common API body limits.  Chunks are
    // intentionally processed one after another so the cursor is all-or-
    // nothing across the complete product-id set.
    const chunkSize = 100;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const productIds = ids.slice(offset, offset + chunkSize);
      let page = 1;
      let pageCount: number | undefined;
      let chunkTotalRows: number | undefined;
      let chunkRawRows = 0;
      const seenPages = new Set<number>();
      while (pageCount === undefined || page <= pageCount) {
        if (seenPages.has(page) || seenPages.size > 100_000) {
          throw new Error("Digiseller sales API returned looping pagination");
        }
        seenPages.add(page);
        const result = await fetchDigisellerSalesPage({
          productIds,
          dateStart: startString,
          dateFinish: finishString,
          page,
          providedToken: token,
        });
        if (
          result.page !== page ||
          result.pages < 0 ||
          result.pages > 100_000 ||
          (result.pages === 0 && result.sales.length > 0) ||
          (result.pages > 0 && result.pages < page)
        ) {
          throw new Error("Digiseller sales API returned invalid page sequence");
        }
        if (page === 1) {
          pageCount = result.pages;
          chunkTotalRows = result.totalRows;
        } else if (
          result.pages !== pageCount ||
          result.totalRows !== chunkTotalRows
        ) {
          throw new Error(
            "Digiseller sales API pagination metadata changed between pages",
          );
        }
        if (result.sales.length > 1_000) {
          throw new Error("Digiseller sales API returned too many rows");
        }
        if (result.rawRowCount !== result.sales.length) {
          throw new Error("Digiseller sales API row count mismatch");
        }
        chunkRawRows += result.rawRowCount;
        fetched += result.sales.length;
        const upserted = await upsertDigisellerSales(tx, result.sales);
        inserted += upserted.inserted;
        updated += upserted.updated;
        ignored += upserted.ignored;
        if (pageCount === 0 || page >= pageCount) break;
        page++;
      }
      if (chunkRawRows !== chunkTotalRows) {
        throw new Error(
          `Digiseller sales API returned ${chunkRawRows} rows, expected ${chunkTotalRows}`,
        );
      }
    }
    await tx
      .insert(syncOrderStateTable)
      .values({ id: 1, cursorAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: syncOrderStateTable.id,
        set: { cursorAt: now, updatedAt: now },
      });
    return { fetched, inserted, updated, ignored, skipped: false };
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