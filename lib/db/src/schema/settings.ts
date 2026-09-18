import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const settingsTable = pgTable("sync_settings", {
  id: integer("id").primaryKey().default(1),
  defaultMarginPercent: doublePrecision("default_margin_percent").notNull().default(15),
  usdRubRate: doublePrecision("usd_rub_rate").notNull().default(92),
  exchangeRateMode: text("exchange_rate_mode").notNull().default("cbr"),
  conversionMarkupPercent: doublePrecision("conversion_markup_percent").notNull().default(2),
  digisellerFeePercent: doublePrecision("digiseller_fee_percent").notNull().default(5),
  fixedReserveRub: doublePrecision("fixed_reserve_rub").notNull().default(30),
  minimumProfitRub: doublePrecision("minimum_profit_rub").notNull().default(100),
  automationMode: text("automation_mode").notNull().default("manual"),
  disableOnUnavailable: boolean("disable_on_unavailable").notNull().default(true),
  autonomousPaused: boolean("autonomous_paused").notNull().default(false),
  autonomousAllowlist: text("autonomous_allowlist").notNull().default("[]"),
  launchPreflightAt: timestamp("launch_preflight_at", { withTimezone: true }),
  launchOrderConfirmedAt: timestamp("launch_order_confirmed_at", { withTimezone: true }),
  launchOrderConfirmationNote: text("launch_order_confirmation_note"),
  notificationWebhookEncrypted: text("notification_webhook_encrypted"),
  digisellerChatCodeEnabled: boolean("digiseller_chat_code_enabled")
    .notNull()
    .default(false),
  digisellerThankYouPromoEnabled: boolean("digiseller_thank_you_promo_enabled")
    .notNull()
    .default(false),
  customerSiteUrl: text("customer_site_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
