import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type PublicationJobStatus = "queued" | "running" | "completed";
export type PublicationJobItem = {
  productId: number;
  name: string;
  operation?: "publish" | "regenerateImage";
  status: "queued" | "publishing" | "published" | "failed";
  digisellerId: number | null;
  imageStatus: "uploaded" | "skipped" | "failed";
  error: string | null;
};

export const publicationJobsTable = pgTable("sync_publication_jobs", {
  id: uuid("id").primaryKey(),
  status: text("status").$type<PublicationJobStatus>().notNull().default("queued"),
  productIds: integer("product_ids").array().notNull(),
  items: jsonb("items").$type<PublicationJobItem[]>().notNull().default([]),
  requested: integer("requested").notNull(),
  succeeded: integer("succeeded").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});