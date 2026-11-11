import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_usage_events = sqliteTable("usage_events", {
  "seq": integer("seq"),
  "thread_id": text("thread_id").notNull(),
  "event_key": text("event_key").notNull(),
  "at_ms": integer("at_ms").notNull(),
  "kind": text("kind").notNull(),
  "data_json": text("data_json").notNull(),
}, table => [
  primaryKey({ columns: [table["seq"]] }),
  unique("legacy_unique_usage_events_1").on(table["event_key"]),
]);

export const table_usage_files = sqliteTable("usage_files", {
  "thread_id": text("thread_id").notNull(),
  "path": text("path").notNull(),
  "cursor": integer("cursor").notNull(),
  "identity": text("identity"),
  "error": text("error"),
  "complete": integer("complete").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_usage_legacy = sqliteTable("usage_legacy", {
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["turn_id"]] }),
]);
