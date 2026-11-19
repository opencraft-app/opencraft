import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_ssh_connections = sqliteTable("ssh_connections", {
  "server_id": text("server_id").notNull(),
  "revision": integer("revision").notNull(),
  "config_json": text("config_json").notNull(),
  "host_key": text("host_key").notNull(),
  "credential": blob("credential").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"]] }),
]);
