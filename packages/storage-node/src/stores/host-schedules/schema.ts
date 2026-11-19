import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_schedule_runs = sqliteTable("schedule_runs", {
  "id": text("id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("schedule_runs_thread").on(table["thread_id"]),
]);

export const table_schedules = sqliteTable("schedules", {
  "thread_id": text("thread_id").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);
