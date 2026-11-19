import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_employee_git_credentials = sqliteTable("employee_git_credentials", {
  "account": text("account").notNull(),
  "host": text("host").notNull(),
  "revision": integer("revision").notNull(),
  "credential": blob("credential"),
}, table => [
  primaryKey({ columns: [table["account"], table["host"]] }),
  check("employee_git_credentials_check_0", sql`revision>0`),
]);
