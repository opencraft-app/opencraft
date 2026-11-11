import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_pool_accounts = sqliteTable("pool_accounts", {
  "id": text("id").notNull(),
  "provider": text("provider").notNull(),
  "label": text("label").notNull(),
  "upstream_account_id": text("upstream_account_id").notNull(),
  "priority": integer("priority").notNull(),
  "enabled": integer("enabled").notNull(),
  "created_at": integer("created_at").notNull(),
  "email": text("email"),
  "subscription_type": text("subscription_type"),
  "rate_limit_tier": text("rate_limit_tier"),
  "last_used_at": integer("last_used_at"),
  "last_used_host_id": text("last_used_host_id"),
  "reset_credit_count": integer("reset_credit_count"),
  "reset_credits_observed_at": integer("reset_credits_observed_at"),
  "allow_credits": integer("allow_credits").notNull().default(sql`1`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  check("pool_accounts_check_0", sql`reset_credit_count >= 0`),
  check("pool_accounts_check_1", sql`allow_credits IN (0,1)`),
]);

export const table_pool_active_account = sqliteTable("pool_active_account", {
  "provider": text("provider").notNull(),
  "account_id": text("account_id").notNull(),
}, table => [
  primaryKey({ columns: [table["provider"]] }),
  foreignKey({ columns: [table["account_id"]], foreignColumns: [table_pool_accounts["id"]] }).onUpdate("no action").onDelete("cascade"),
]);

export const table_pool_affinity = sqliteTable("pool_affinity", {
  "affinity_key": text("affinity_key").notNull(),
  "account_id": text("account_id").notNull(),
  "last_used_at": integer("last_used_at").notNull(),
}, table => [
  primaryKey({ columns: [table["affinity_key"]] }),
  foreignKey({ columns: [table["account_id"]], foreignColumns: [table_pool_accounts["id"]] }).onUpdate("no action").onDelete("cascade"),
]);

export const table_pool_quota = sqliteTable("pool_quota", {
  "account_id": text("account_id").notNull(),
  "utilization": real("utilization"),
  "reset_at": integer("reset_at"),
  "held_until": integer("held_until"),
  "error": text("error"),
  "observed_at": integer("observed_at").notNull(),
  "limit_windows_json": text("limit_windows_json").notNull().default(sql`'[]'`),
}, table => [
  primaryKey({ columns: [table["account_id"]] }),
  foreignKey({ columns: [table["account_id"]], foreignColumns: [table_pool_accounts["id"]] }).onUpdate("no action").onDelete("cascade"),
]);
