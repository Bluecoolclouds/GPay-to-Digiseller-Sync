import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const activitiesTable = pgTable("sync_activities", {
  id: serial("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});