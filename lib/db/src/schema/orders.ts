import {
  boolean,
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
    isReturned: boolean("is_returned").notNull().default(false),
    operatorNote: text("operator_note"),
    publicTokenHash: text("public_token_hash"),
    publicLinkExpiresAt: timestamp("public_link_expires_at", { withTimezone: true }),
    publicCodeEncrypted: text("public_code_encrypted"),
    publicOpenedAt: timestamp("public_opened_at", { withTimezone: true }),
    publicSubmittedAt: timestamp("public_submitted_at", { withTimezone: true }),
    publicSubmittedCodeHash: text("public_submitted_code_hash"),
    publicSubmissionError: text("public_submission_error"),
    gpayPurchaseStatus: text("gpay_purchase_status"),
    gpayPurchaseUniqueCode: text("gpay_purchase_unique_code"),
    gpayPurchaseOrderId: integer("gpay_purchase_order_id"),
    gpayPurchaseStartedAt: timestamp("gpay_purchase_started_at", {
      withTimezone: true,
    }),
    gpayPurchaseCompletedAt: timestamp("gpay_purchase_completed_at", {
      withTimezone: true,
    }),
    gpayPurchaseError: text("gpay_purchase_error"),
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
    publicTokenHashUnique: uniqueIndex("sync_orders_public_token_hash_unique").on(
      table.publicTokenHash,
    ),
  }),
);

export type SyncOrder = typeof syncOrdersTable.$inferSelect;

/**
 * Digiseller product identifiers are not stable across publication
 * migrations.  Keep this append-only mapping so an order for an old card can
 * still be associated with its local product after the old id is cleared.
 */
export const syncProductDigisellerIdsTable = pgTable(
  "sync_product_digiseller_ids",
  {
    id: serial("id").primaryKey(),
    localProductId: integer("local_product_id").notNull(),
    digisellerProductId: integer("digiseller_product_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    digisellerProductIdUnique: uniqueIndex(
      "sync_product_digiseller_ids_external_unique",
    ).on(table.digisellerProductId),
    localProductIdDigisellerProductIdUnique: uniqueIndex(
      "sync_product_digiseller_ids_local_external_unique",
    ).on(table.localProductId, table.digisellerProductId),
  }),
);

export type SyncProductDigisellerId =
  typeof syncProductDigisellerIdsTable.$inferSelect;

/**
 * A singleton cursor.  A null cursor means that the first successful sync
 * must perform the historical backfill.
 */
export const syncOrderStateTable = pgTable("sync_order_state", {
  id: integer("id").primaryKey().default(1),
  cursorAt: timestamp("cursor_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SyncOrderState = typeof syncOrderStateTable.$inferSelect;