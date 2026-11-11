import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_connector_credentials = sqliteTable("connector_credentials", {
  "instance_id": text("instance_id").notNull(),
  "secrets": text("secrets").notNull(),
  "oauth": text("oauth").notNull(),
}, table => [
  primaryKey({ columns: [table["instance_id"]] }),
  foreignKey({ columns: [table["instance_id"]], foreignColumns: [table_connector_instances["id"]] }).onUpdate("no action").onDelete("cascade"),
]);

export const table_connector_instances = sqliteTable("connector_instances", {
  "id": text("id").notNull(),
  "definition_id": text("definition_id").notNull(),
  "title": text("title").notNull(),
  "revision": integer("revision").notNull(),
  "enabled": integer("enabled").notNull(),
  "value": text("value").notNull(),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_connector_oauth_transactions = sqliteTable("connector_oauth_transactions", {
  "id": text("id").notNull(),
  "instance_id": text("instance_id").notNull(),
  "revision": integer("revision").notNull(),
  "state": text("state").notNull(),
  "expires_at": integer("expires_at").notNull(),
  "status": text("status").notNull(),
  "data": text("data").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  unique("legacy_unique_connector_oauth_transactions_2").on(table["state"]),
]);
