import { sqliteTable, text, integer, primaryKey, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_ui_preferences = sqliteTable("ui_preferences", {
  "key": text("key").notNull(),
  "value_json": text("value_json").notNull(),
  "revision": integer("revision").notNull(),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);

export const table_connector_configuration = sqliteTable("connector_configuration", {
  "id": integer("id"),
  "revision": integer("revision").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  check("connector_configuration_check_0", sql`id=1`),
]);

export const table_extension_records = sqliteTable("extension_records", {
  "scope": text("scope").notNull(),
  "revision": integer("revision").notNull(),
  "data_version": integer("data_version").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["scope"]] }),
]);

export const table_client_resources = sqliteTable("client_resources", {
  "identity": text("identity").notNull(),
  "namespace": text("namespace").notNull(),
  "authority": text("authority").notNull(),
  "revision": integer("revision").notNull(),
  "version": integer("version").notNull(),
  "saved_at": integer("saved_at").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["identity"]] }),
  index("client_resources_remote").on(table["authority"], table["saved_at"]),
]);

export const table_desktop_client_imports = sqliteTable("desktop_client_imports", {
  "source": text("source").notNull(),
  "row_count": integer("row_count").notNull(),
  "digest": text("digest").notNull(),
  "imported_at": integer("imported_at").notNull(),
}, table => [
  primaryKey({ columns: [table["source"]] }),
]);
