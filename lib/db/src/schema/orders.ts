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

export type BackgroundJobName =
  | "scheduler"
  | "order-sync"
  | "price-sync"
  | "purchase-reconciliation";

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
    publicSubmittedCodeEncrypted: text("public_submitted_code_encrypted"),
    publicSubmissionError: text("public_submission_error"),
    gpayPurchaseStatus: text("gpay_purchase_status"),
    gpayPurchaseUniqueCode: text("gpay_purchase_unique_code"),
    gpayPurchaseOrderId: integer("gpay_purchase_order_id"),
    gpayPurchaseExpectedAmountUsd: doublePrecision(
      "gpay_purchase_expected_amount_usd",
    ),
    gpayPurchaseStartedAt: timestamp("gpay_purchase_started_at", {
      withTimezone: true,
    }),
    gpayPurchaseCompletedAt: timestamp("gpay_purchase_completed_at", {
      withTimezone: true,
    }),
    gpayPurchaseError: text("gpay_purchase_error"),
    gpayDeliveredKeyEncrypted: text("gpay_delivered_key_encrypted"),
    digisellerDeliveryStatus: text("digiseller_delivery_status"),
    digisellerDeliveryStartedAt: timestamp("digiseller_delivery_started_at", {
      withTimezone: true,
    }),
    digisellerDeliveryCompletedAt: timestamp("digiseller_delivery_completed_at", {
      withTimezone: true,
    }),
    digisellerDeliveryError: text("digiseller_delivery_error"),
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
    gpayPurchaseOrderIdUnique: uniqueIndex(
      "sync_orders_gpay_purchase_order_id_unique",
    ).on(table.gpayPurchaseOrderId),
    gpayPurchaseUniqueCodeUnique: uniqueIndex(
      "sync_orders_gpay_purchase_unique_code_unique",
    ).on(table.gpayPurchaseUniqueCode),
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

export const backgroundJobStateTable = pgTable("sync_background_job_state", {
  name: text("name").$type<BackgroundJobName>().primaryKey(),
  intervalSeconds: integer("interval_seconds").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  lastStartedAt: timestamp("last_started_at", { withTimezone: true }),
  lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  lastResult: text("last_result"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BackgroundJobState = typeof backgroundJobStateTable.$inferSelect;

export const notificationStateTable = pgTable("sync_notification_state", {
  key: text("key").primaryKey(),
  active: boolean("active").notNull().default(false),
  fingerprint: text("fingerprint"),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  lastRecoveredAt: timestamp("last_recovered_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
