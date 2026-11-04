import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
