import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_thread_creations = sqliteTable("thread_creations", {
  "thread_id": text("thread_id").notNull(),
  "result_json": text("result_json").notNull(),
  "phase": text("phase").notNull(),
  "input_id": text("input_id"),
  "turn_id": text("turn_id"),
  "environment_owner": text("environment_owner"),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
  check("thread_creations_check_0", sql`phase IN ('created','attempted','accepted','persisted')`),
]);
