import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_admission = sqliteTable("admission", {
  "singleton": integer("singleton"),
  "generation_id": text("generation_id"),
  "epoch": integer("epoch").notNull(),
}, table => [
  primaryKey({ columns: [table["singleton"]] }),
  check("admission_check_0", sql`singleton=1`),
]);

export const table_creation_claims = sqliteTable("creation_claims", {
  "id": text("id").notNull(),
  "generation_id": text("generation_id").notNull(),
  "epoch": integer("epoch").notNull(),
  "state": text("state").notNull(),
  "thread_id": text("thread_id"),
  "incarnation": integer("incarnation"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  foreignKey({ columns: [table["generation_id"]], foreignColumns: [table_generations["id"]] }).onUpdate("no action").onDelete("no action"),
]);

export const table_generations = sqliteTable("generations", {
  "id": text("id").notNull(),
  "definition": text("definition").notNull(),
  "runtime_root": text("runtime_root").notNull(),
  "endpoint": text("endpoint").notNull(),
  "state": text("state").notNull(),
  "incarnation": integer("incarnation").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  unique("legacy_unique_generations_3").on(table["endpoint"]),
  unique("legacy_unique_generations_2").on(table["runtime_root"]),
]);

export const table_routing_metadata = sqliteTable("routing_metadata", {
  "key": text("key").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);

export const table_thread_routes = sqliteTable("thread_routes", {
  "thread_id": text("thread_id").notNull(),
  "generation_id": text("generation_id").notNull(),
  "epoch": integer("epoch").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
  foreignKey({ columns: [table["generation_id"]], foreignColumns: [table_generations["id"]] }).onUpdate("no action").onDelete("no action"),
]);
