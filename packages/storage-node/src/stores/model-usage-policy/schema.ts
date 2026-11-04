import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_model_usage_audit = sqliteTable("model_usage_audit", {
  "revision": integer("revision"),
  "actor": text("actor").notNull(),
  "at": integer("at").notNull(),
  "before_rules": text("before_rules").notNull(),
  "after_rules": text("after_rules").notNull(),
}, table => [
  primaryKey({ columns: [table["revision"]] }),
]);

export const table_model_usage_policy = sqliteTable("model_usage_policy", {
  "singleton": integer("singleton"),
  "revision": integer("revision").notNull(),
  "rules": text("rules").notNull(),
}, table => [
  primaryKey({ columns: [table["singleton"]] }),
  check("model_usage_policy_check_0", sql`singleton=1`),
]);
