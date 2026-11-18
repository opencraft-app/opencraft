import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_push_deliveries = sqliteTable("push_deliveries", {
  "id": text("id").notNull(),
  "device_id": text("device_id").notNull(),
  "binding_id": text("binding_id").notNull(),
  "host_id": text("host_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "status": text("status").notNull(),
  "attempts": integer("attempts").notNull().default(sql`0`),
  "next_at": integer("next_at").notNull(),
  "created_at": integer("created_at").notNull(),
  "state": text("state").notNull().default(sql`'pending'`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("push_deliveries_due").on(table["state"], table["next_at"]),
]);

export const table_push_devices = sqliteTable("push_devices", {
  "id": text("id").notNull(),
  "actor_id": text("actor_id").notNull(),
  "binding_id": text("binding_id").notNull(),
  "authorization": text("authorization").notNull(),
  "subscription": text("subscription").notNull(),
  "origin": text("origin").notNull(),
  "base_path": text("base_path").notNull(),
  "locale": text("locale").notNull(),
  "messages": text("messages").notNull(),
  "target": text("target"),
  "enabled": integer("enabled").notNull().default(sql`1`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("push_devices_actor").on(table["actor_id"]),
]);

export const table_push_keys = sqliteTable("push_keys", {
  "id": integer("id"),
  "public_key": text("public_key").notNull(),
  "private_key": text("private_key").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  check("push_keys_check_0", sql`id=1`),
]);

export const table_push_watches = sqliteTable("push_watches", {
  "id": text("id").notNull(),
  "actor_id": text("actor_id").notNull(),
  "server_id": text("server_id").notNull(),
  "host_id": text("host_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "turn_id": text("turn_id"),
  "created_at": integer("created_at").notNull(),
  "done": integer("done").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("push_watches_pending").on(table["done"], table["created_at"]),
]);

export const table_push_preferences = sqliteTable("push_preferences", {
  "defaults_blocked": integer("defaults_blocked").notNull().default(sql`0`),
  "actor_id": text("actor_id").notNull(),
  "enabled": integer("enabled").notNull(),
}, table => [primaryKey({ columns: [table["actor_id"]] })]);

export const pushDefaultDecisions = sqliteTable("push_default_decisions", {
  actorId: text("actor_id").notNull(), policyId: text("policy_id").notNull(),
}, table => [primaryKey({columns:[table.actorId,table.policyId]})]);
export const pushTargetOptOuts = sqliteTable("push_target_opt_outs", {
  actorId: text("actor_id").notNull(), targetKey: text("target_key").notNull(),
}, table => [primaryKey({columns:[table.actorId,table.targetKey]})]);
