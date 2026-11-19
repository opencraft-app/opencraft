import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_employee_policy = sqliteTable("employee_policy", {
  "singleton": integer("singleton"),
  "revision": integer("revision").notNull(),
  "active": text("active").notNull(),
  "draft": text("draft").notNull(),
}, table => [
  primaryKey({ columns: [table["singleton"]] }),
  check("employee_policy_check_0", sql`singleton=1`),
]);

export const table_employee_policy_audit = sqliteTable("employee_policy_audit", {
  "id": integer("id"),
  "revision": integer("revision").notNull(),
  "action": text("action").notNull(),
  "at": integer("at").notNull(),
  "operator": text("operator").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_employee_policy_identities = sqliteTable("employee_policy_identities", {
  "subject": text("subject").notNull(),
  "login_name": text("login_name").notNull(),
}, table => [
  primaryKey({ columns: [table["subject"]] }),
]);

export const table_employee_policy_versions = sqliteTable("employee_policy_versions", {
  "revision": integer("revision"),
  "config": text("config").notNull(),
  "at": integer("at").notNull(),
  "operator": text("operator").notNull(),
}, table => [
  primaryKey({ columns: [table["revision"]] }),
]);
