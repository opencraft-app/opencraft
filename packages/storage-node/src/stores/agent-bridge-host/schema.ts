import { sqliteTable, text, integer, primaryKey, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_meta = sqliteTable("meta", {
  "key": text("key"),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);

export const table_generations = sqliteTable("generations", {
  "id": text("id"),
  "config": text("config").notNull(),
  "retired": integer("retired").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_routes = sqliteTable("routes", {
  "route": text("route"),
  "generation": text("generation").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
  foreignKey({ columns: [table["generation"]], foreignColumns: [table_generations["id"]] }).onUpdate("no action").onDelete("no action"),
]);

export const table_commands = sqliteTable("commands", {
  "id": text("id"),
  "digest": text("digest").notNull(),
  "epoch": integer("epoch").notNull(),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "method": text("method").notNull(),
  "state": text("state").notNull(),
  "response": text("response"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_native_sessions = sqliteTable("native_sessions", {
  "route": text("route"),
  "generation": text("generation").notNull(),
  "native_id": text("native_id").notNull(),
  "restorable": integer("restorable").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

export const table_released_routes = sqliteTable("released_routes", {
  "route": text("route"),
  "generation": text("generation").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

export const table_outbox = sqliteTable("outbox", {
  "seq": integer("seq").primaryKey({ autoIncrement: true }),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "payload": text("payload").notNull(),
});

export const table_checkpoints = sqliteTable("checkpoints", {
  "route": text("route"),
  "state": text("state").notNull(),
  "at_ms": integer("at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

export const table_callbacks = sqliteTable("callbacks", {
  "generation": text("generation").notNull(),
  "id": text("id").notNull(),
  "digest": text("digest").notNull(),
}, table => [
  primaryKey({ columns: [table["generation"], table["id"]] }),
]);

export const table_interactions = sqliteTable("interactions", {
  "route": text("route").notNull(),
  "id": text("id").notNull(),
  "generation": text("generation").notNull(),
}, table => [
  primaryKey({ columns: [table["route"], table["id"]] }),
]);

export const table_inbox = sqliteTable("inbox", {
  "seq": integer("seq"),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "payload": text("payload").notNull(),
  "projection": text("projection").notNull(),
}, table => [
  primaryKey({ columns: [table["seq"]] }),
]);

export const table_automation_scripts = sqliteTable("automation_scripts", {
  "key": text("key"),
  "digest": text("digest").notNull(),
  "state": text("state").notNull(),
  "result": text("result"),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);
