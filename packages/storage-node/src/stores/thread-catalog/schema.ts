import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_opencraft_threads = sqliteTable("opencraft_threads", {
  "id": text("id"),
  "document": text("document").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);
