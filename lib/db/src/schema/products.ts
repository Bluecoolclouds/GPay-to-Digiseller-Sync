import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const productsTable = pgTable("sync_products", {
  id: serial("id").primaryKey(),
  gpayId: integer("gpay_id").notNull().unique(),
  digisellerId: integer("digiseller_id"),
  previousDigisellerId: integer("previous_digiseller_id"),
  digisellerDeliveryType: text("digiseller_delivery_type"),
  digisellerTextStocked: boolean("digiseller_text_stocked")
    .notNull()
    .default(false),
  platiCategoryId: integer("plati_category_id"),
  appId: integer("app_id"),
  subId: integer("sub_id"),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  digisellerImageUploaded: boolean("digiseller_image_uploaded")
    .notNull()
    .default(false),
  productType: text("product_type").notNull(),
  supplierPriceUsd: doublePrecision("supplier_price_usd").notNull(),
  salePriceRub: doublePrecision("sale_price_rub").notNull(),
  marginPercent: doublePrecision("margin_percent").notNull(),
  profitRub: doublePrecision("profit_rub").notNull(),
  isAvailable: boolean("is_available").notNull().default(false),
  publicationStatus: text("publication_status").notNull().default("draft"),
  publicationError: text("publication_error"),
  publicationFailureStage: text("publication_failure_stage"),
  region: text("region").notNull().default("Не указан"),
  warningMessage: text("warning_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SyncProduct = typeof productsTable.$inferSelect;