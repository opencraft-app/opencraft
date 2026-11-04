import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_thread_notes = sqliteTable("thread_notes", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "state": blob("state").notNull(),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"]] }),
]);
