import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_opencraft_threads = sqliteTable("opencraft_threads", {
  "id": text("id"),
  "document": text("document").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_opencraft_catalog_sync = sqliteTable("opencraft_catalog_sync", {
  "archived": integer("archived"),
  "last_success_ms": integer("last_success_ms"),
  "watermark": real("watermark"),
  "last_full_ms": integer("last_full_ms"),
  "state": text("state").notNull(),
}, table => [
  primaryKey({ columns: [table["archived"]] }),
  check("opencraft_catalog_sync_check_0", sql`archived IN (0,1)`),
  check("opencraft_catalog_sync_check_1", sql`state IN ('syncing','ready','error')`),
]);

export const table_opencraft_thread_catalog = sqliteTable("opencraft_thread_catalog", {
  "thread_id": text("thread_id").notNull(),
  "metadata_json": text("metadata_json").notNull(),
  "updated_at": real("updated_at").notNull(),
  "archived": integer("archived").notNull(),
  "observed_at_ms": integer("observed_at_ms").notNull(),
  "revision": integer("revision").notNull(),
  "deleted": integer("deleted").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
  index("opencraft_thread_catalog_recency").on(table["archived"], table["deleted"], sql`updated_at DESC`, table["thread_id"]),
  check("opencraft_thread_catalog_check_0", sql`archived IN (0,1)`),
  check("opencraft_thread_catalog_check_1", sql`deleted IN (0,1)`),
]);
