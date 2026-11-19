import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_opencraft_cache_blobs = sqliteTable("opencraft_cache_blobs", {
  "thread_id": text("thread_id").notNull(),
  "turn_seq": integer("turn_seq").notNull(),
  "blob_sha256": text("blob_sha256").notNull(),
  "byte_size": integer("byte_size").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["turn_seq"], table["blob_sha256"]] }),
]);

export const table_opencraft_cache_meta = sqliteTable("opencraft_cache_meta", {
  "thread_id": text("thread_id").notNull(),
  "projection_schema_version": integer("projection_schema_version").notNull(),
  "native_watermark": text("native_watermark").notNull(),
  "source_cursor": integer("source_cursor").notNull(),
  "source_identity": text("source_identity").notNull(),
  "source_path": text("source_path").notNull(),
  "epoch": text("epoch").notNull(),
  "total_turns": integer("total_turns").notNull(),
  "updated_at_ms": integer("updated_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_opencraft_turn_offset_index = sqliteTable("opencraft_turn_offset_index", {
  "thread_id": text("thread_id").notNull(),
  "turn_seq": integer("turn_seq").notNull(),
  "turn_id": text("turn_id").notNull(),
  "byte_offset": integer("byte_offset").notNull(),
  "byte_length": integer("byte_length").notNull(),
  "content_sha256": text("content_sha256").notNull(),
  "status": text("status").notNull(),
  "updated_at_ms": integer("updated_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["turn_seq"]] }),
  unique("legacy_unique_opencraft_turn_offset_index_2").on(table["thread_id"], table["turn_id"]),
]);
