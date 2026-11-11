import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_extension_records = sqliteTable("extension_records", {
  "scope": text("scope").notNull(),
  "revision": integer("revision").notNull(),
  "data_version": integer("data_version").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["scope"]] }),
]);
