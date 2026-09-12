import {
  doublePrecision,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const syncOrderStatus = pgEnum("sync_order_status", [
  "new",
  "processing",
  "delivered",
]);

export const syncOrdersTable = pgTable(
  "sync_orders",
  {
    id: serial("id").primaryKey(),
    invoiceId: text("invoice_id").notNull(),
    digisellerProductId: integer("digiseller_product_id").notNull(),
    productName: text("product_name").notNull(),
    paidAmountRub: doublePrecision("paid_amount_rub"),
    saleTimestamp: timestamp("sale_timestamp", {
      withTimezone: true,
    }).notNull(),
    status: syncOrderStatus("status").notNull().default("new"),
    operatorNote: text("operator_note"),
    syncedAt: timestamp("synced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    invoiceIdUnique: uniqueIndex("sync_orders_invoice_id_unique").on(
      table.invoiceId,
    ),
  }),
);

export type SyncOrder = typeof syncOrdersTable.$inferSelect;