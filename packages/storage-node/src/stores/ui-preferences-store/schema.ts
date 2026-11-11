import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_ui_preferences = sqliteTable("ui_preferences", {
  "key": text("key").notNull(),
  "value_json": text("value_json").notNull(),
  "revision": integer("revision").notNull(),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);
