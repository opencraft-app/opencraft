import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_provider_retries = sqliteTable("provider_retries", {
  "thread_id": text("thread_id").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);
