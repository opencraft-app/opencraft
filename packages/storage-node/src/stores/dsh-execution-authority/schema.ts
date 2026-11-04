import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_hypernode_thread_execution_epochs = sqliteTable("hypernode_thread_execution_epochs", {
  "thread_id": text("thread_id"),
  "epoch": integer("epoch").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_hypernode_thread_queue_state = sqliteTable("hypernode_thread_queue_state", {
  "thread_id": text("thread_id"),
  "paused_reason": text("paused_reason"),
  "updated_at_ms": integer("updated_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_hypernode_thread_queue_submissions = sqliteTable("hypernode_thread_queue_submissions", {
  "thread_id": text("thread_id").notNull(),
  "submission_id": text("submission_id").notNull(),
  "client_user_message_id": text("client_user_message_id").notNull(),
  "actor_user_id": text("actor_user_id"),
  "input_json": text("input_json").notNull(),
  "state": text("state").notNull(),
  "position": integer("position").notNull(),
  "created_at_ms": integer("created_at_ms").notNull(),
  "updated_at_ms": integer("updated_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["submission_id"]] }),
  index("hypernode_thread_queue_actor").on(table["actor_user_id"], table["state"]),
  index("hypernode_thread_queue_pending").on(table["thread_id"], table["state"], table["position"]),
  unique("legacy_unique_hypernode_thread_queue_submissions_2").on(table["thread_id"], table["client_user_message_id"]),
]);

export const table_hypernode_turn_execution_attempts = sqliteTable("hypernode_turn_execution_attempts", {
  "execution_id": text("execution_id"),
  "thread_id": text("thread_id").notNull(),
  "epoch": integer("epoch").notNull(),
  "request_id": text("request_id"),
  "turn_id": text("turn_id"),
  "actor_user_id": text("actor_user_id"),
  "actor_username": text("actor_username"),
  "account_identity": text("account_identity"),
  "execution_profile_json": text("execution_profile_json"),
  "runtime_id": text("runtime_id"),
  "native_turn_id": text("native_turn_id"),
  "state": text("state").notNull(),
  "owner_boot_id": text("owner_boot_id").notNull(),
  "started_at_ms": integer("started_at_ms").notNull(),
  "updated_at_ms": integer("updated_at_ms").notNull(),
  "terminal_at_ms": integer("terminal_at_ms"),
  "terminal_reason": text("terminal_reason"),
}, table => [
  primaryKey({ columns: [table["execution_id"]] }),
  index("hypernode_turn_execution_thread_epoch").on(table["thread_id"], table["epoch"]),
]);

export const table_opencraft_execution_inputs = sqliteTable("opencraft_execution_inputs", {
  "execution_id": text("execution_id"),
  "thread_id": text("thread_id").notNull(),
  "native_rpc_id": text("native_rpc_id").notNull(),
  "client_message_id": text("client_message_id"),
  "actor_id": text("actor_id").notNull(),
}, table => [
  primaryKey({ columns: [table["execution_id"]] }),
  unique("legacy_unique_opencraft_execution_inputs_2").on(table["native_rpc_id"]),
]);

export const table_opencraft_queue_inputs = sqliteTable("opencraft_queue_inputs", {
  "native_rpc_id": text("native_rpc_id"),
  "thread_id": text("thread_id").notNull(),
  "client_message_id": text("client_message_id").notNull(),
  "request_id": text("request_id").notNull(),
  "owner_id": text("owner_id").notNull(),
  "owner_username": text("owner_username").notNull(),
  "connection_id": text("connection_id").notNull(),
  "consumed": integer("consumed").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["native_rpc_id"]] }),
]);
