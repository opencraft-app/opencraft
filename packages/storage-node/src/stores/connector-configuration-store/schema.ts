import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_connector_configuration = sqliteTable("connector_configuration", {
  "id": integer("id"),
  "revision": integer("revision").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  check("connector_configuration_check_0", sql`id=1`),
]);
