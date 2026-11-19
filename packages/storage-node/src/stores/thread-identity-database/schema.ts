import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_execution_leases = sqliteTable("execution_leases", {
  "execution_id": text("execution_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "generation": integer("generation").notNull(),
  "turn_id": text("turn_id"),
  "engine_incarnation": text("engine_incarnation"),
  "state": text("state").notNull(),
  "admitted_at_ms": integer("admitted_at_ms").notNull(),
  "ended_at_ms": integer("ended_at_ms"),
  "boot_id": text("boot_id"),
  "admitted_at_boot_ms": real("admitted_at_boot_ms"),
  "ended_at_boot_ms": real("ended_at_boot_ms"),
}, table => [
  primaryKey({ columns: [table["execution_id"]] }),
  index("execution_leases_boot_origin").on(table["thread_id"], table["boot_id"], table["admitted_at_boot_ms"], table["ended_at_boot_ms"]),
  index("execution_leases_origin").on(table["thread_id"], table["admitted_at_ms"], table["ended_at_ms"]),
  unique("legacy_unique_execution_leases_3").on(table["thread_id"], table["turn_id"]),
  unique("legacy_unique_execution_leases_2").on(table["thread_id"], table["generation"]),
  check("execution_leases_check_0", sql`state IN ('pending','active','ended','unknown','rejected')`),
]);

export const table_execution_queue_inputs = sqliteTable("execution_queue_inputs", {
  "thread_id": text("thread_id").notNull(),
  "queue_id": text("queue_id").notNull(),
  "input_id": text("input_id").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["queue_id"]] }),
]);

export const table_execution_submissions = sqliteTable("execution_submissions", {
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "principal_json": text("principal_json"),
  "ownership": text("ownership").notNull(),
  "submitted_at_ms": integer("submitted_at_ms").notNull(),
  "admission": text("admission").notNull().default(sql`'accepted'`),
  "input_kind": text("input_kind").notNull().default(sql`'start'`),
  "admission_token": text("admission_token"),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["input_id"]] }),
  check("execution_submissions_check_0", sql`ownership IN ('human','unowned','unknown')`),
  check("execution_submissions_check_1", sql`admission IN ('pending','accepted','unknown')`),
  check("execution_submissions_check_2", sql`input_kind IN ('start','queue','steer','system')`),
]);

export const table_ioa_message_presence = sqliteTable("ioa_message_presence", {
  "thread_id": text("thread_id").notNull(),
  "client_message_id": text("client_message_id").notNull(),
  "login_name": text("login_name").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["client_message_id"]] }),
  index("ioa_presence_names").on(table["thread_id"], table["login_name"]),
]);

export const table_ioa_participant_state = sqliteTable("ioa_participant_state", {
  "thread_id": text("thread_id").notNull(),
  "revision": integer("revision").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_ioa_presence_sync = sqliteTable("ioa_presence_sync", {
  "thread_id": text("thread_id").notNull(),
  "reconciled_at_ms": integer("reconciled_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_ioa_thread_creators = sqliteTable("ioa_thread_creators", {
  "thread_id": text("thread_id").notNull(),
  "login_name": text("login_name"),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_message_sender_origins = sqliteTable("message_sender_origins", {
  "thread_id": text("thread_id").notNull(),
  "client_message_id": text("client_message_id").notNull(),
  "source_thread_id": text("source_thread_id").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["client_message_id"]] }),
]);

export const table_message_senders = sqliteTable("message_senders", {
  "thread_id": text("thread_id").notNull(),
  "client_message_id": text("client_message_id").notNull(),
  "sender_json": text("sender_json").notNull(),
  "accepted_at_ms": integer("accepted_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["client_message_id"]] }),
]);
