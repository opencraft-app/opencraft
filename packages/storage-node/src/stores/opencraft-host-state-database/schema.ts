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

export const table_opencraft_bot_commands = sqliteTable("opencraft_bot_commands", {
  "command_key": text("command_key"),
  "fingerprint": text("fingerprint").notNull(),
  "result_json": text("result_json"),
}, table => [
  primaryKey({ columns: [table["command_key"]] }),
]);

export const table_opencraft_bot_message_slots = sqliteTable("opencraft_bot_message_slots", {
  "room_id": text("room_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "kind": text("kind").notNull(),
  "ordinal": integer("ordinal").notNull(),
  "native_id": text("native_id"),
}, table => [
  primaryKey({ columns: [table["room_id"], table["turn_id"], table["kind"], table["ordinal"]] }),
  unique("legacy_unique_opencraft_bot_message_slots_2").on(table["room_id"], table["turn_id"], table["kind"], table["native_id"]),
]);

export const table_opencraft_bot_rooms = sqliteTable("opencraft_bot_rooms", {
  "thread_id": text("thread_id"),
  "created_ms": integer("created_ms").notNull(),
  "cwd": text("cwd"),
  "draft": integer("draft").notNull().default(sql`0`),
  "native_thread_id": text("native_thread_id"),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
]);

export const table_opencraft_catalog_sync = sqliteTable("opencraft_catalog_sync", {
  "archived": integer("archived"),
  "last_success_ms": integer("last_success_ms"),
  "watermark": real("watermark"),
  "last_full_ms": integer("last_full_ms"),
  "state": text("state").notNull(),
}, table => [
  primaryKey({ columns: [table["archived"]] }),
  check("opencraft_catalog_sync_check_0", sql`archived IN (0,1)`),
  check("opencraft_catalog_sync_check_1", sql`state IN ('syncing','ready','error')`),
]);

export const table_opencraft_host_queue = sqliteTable("opencraft_host_queue", {
  "id": text("id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "client_id": text("client_id").notNull(),
  "input_json": text("input_json").notNull(),
  "position": integer("position").notNull(),
  "created_at_ms": integer("created_at_ms").notNull(),
  "updated_at_ms": integer("updated_at_ms").notNull(),
  "state": text("state").notNull(),
  "target_turn_id": text("target_turn_id"),
  "paused_reason": text("paused_reason"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("opencraft_host_queue_state").on(table["state"], table["thread_id"]),
  index("opencraft_host_queue_order").on(table["thread_id"], table["position"], table["created_at_ms"]),
  unique("legacy_unique_opencraft_host_queue_2").on(table["thread_id"], table["client_id"]),
  check("opencraft_host_queue_check_0", sql`state IN ('queued','dispatching','steering','unknown','delivered','discarded')`),
]);

export const table_opencraft_thread_catalog = sqliteTable("opencraft_thread_catalog", {
  "thread_id": text("thread_id").notNull(),
  "metadata_json": text("metadata_json").notNull(),
  "updated_at": real("updated_at").notNull(),
  "archived": integer("archived").notNull(),
  "observed_at_ms": integer("observed_at_ms").notNull(),
  "revision": integer("revision").notNull(),
  "deleted": integer("deleted").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["thread_id"]] }),
  index("opencraft_thread_catalog_recency").on(table["archived"], table["deleted"], sql`updated_at DESC`, table["thread_id"]),
  check("opencraft_thread_catalog_check_0", sql`archived IN (0,1)`),
  check("opencraft_thread_catalog_check_1", sql`deleted IN (0,1)`),
]);

export const table_token_usage_actor_daily = sqliteTable("token_usage_actor_daily", {
  "server_id": text("server_id").notNull(),
  "actor_id": text("actor_id").notNull(),
  "day": text("day").notNull(),
  "model_filter": integer("model_filter").notNull(),
  "model_key": text("model_key").notNull(),
  "tokens": text("tokens").notNull(),
  "turns": integer("turns").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["actor_id"], table["day"], table["model_filter"], table["model_key"]] }),
  check("token_usage_actor_daily_check_0", sql`model_filter IN (0,1)`),
  check("token_usage_actor_daily_check_1", sql`turns>=0`),
]);

export const table_token_usage_admissions = sqliteTable("token_usage_admissions", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "observed_ms": integer("observed_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["input_id"]] }),
  index("token_usage_admissions_turn").on(table["server_id"], table["thread_id"], table["turn_id"]),
]);

export const table_token_usage_allocations = sqliteTable("token_usage_allocations", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "model_key": text("model_key").notNull(),
  "provider": text("provider"),
  "model": text("model"),
  "actor_id": text("actor_id").notNull(),
  "tokens": text("tokens").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"], table["model_key"], table["actor_id"]] }),
  index("token_usage_allocations_actor").on(table["server_id"], table["actor_id"], table["thread_id"], table["turn_id"]),
]);

export const table_token_usage_attempts = sqliteTable("token_usage_attempts", {
  "server_id": text("server_id").notNull(),
  "attempt_id": text("attempt_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "mode": text("mode").notNull(),
  "actor_id": text("actor_id"),
  "actor_kind": text("actor_kind").notNull(),
  "source_kind": text("source_kind").notNull(),
  "submitted_ms": integer("submitted_ms").notNull(),
  "outcome": text("outcome").notNull(),
  "turn_id": text("turn_id"),
}, table => [
  primaryKey({ columns: [table["server_id"], table["attempt_id"]] }),
  index("token_usage_attempts_input").on(table["server_id"], table["thread_id"], table["input_id"], table["outcome"]),
  check("token_usage_attempts_check_0", sql`mode IN ('start','steer')`),
  check("token_usage_attempts_check_1", sql`actor_kind IN ('human','session','unknown')`),
  check("token_usage_attempts_check_2", sql`source_kind IN ('human','system','unknown')`),
  check("token_usage_attempts_check_3", sql`outcome IN ('pending','accepted','rejected','unknown')`),
]);

export const table_token_usage_buckets = sqliteTable("token_usage_buckets", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "model_key": text("model_key").notNull(),
  "provider": text("provider"),
  "model": text("model"),
  "tokens": text("tokens").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"], table["model_key"]] }),
  index("token_usage_buckets_query").on(table["server_id"], table["thread_id"], table["turn_id"], table["model_key"], table["tokens"], table["provider"], table["model"]),
  index("token_usage_buckets_model").on(table["server_id"], table["model_key"], table["thread_id"], table["turn_id"]),
]);

export const table_token_usage_checkpoints = sqliteTable("token_usage_checkpoints", {
  "server_id": text("server_id").notNull(),
  "lineage": text("lineage").notNull(),
  "cursor": text("cursor").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["lineage"]] }),
]);

export const table_token_usage_coverage = sqliteTable("token_usage_coverage", {
  "id": integer("id"),
  "server_id": text("server_id").notNull(),
  "starts_ms": integer("starts_ms").notNull(),
  "ends_ms": integer("ends_ms"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("token_usage_coverage_scope").on(table["server_id"], table["starts_ms"], table["ends_ms"]),
]);

export const table_token_usage_daily = sqliteTable("token_usage_daily", {
  "server_id": text("server_id").notNull(),
  "day": text("day").notNull(),
  "model_filter": integer("model_filter").notNull(),
  "model_key": text("model_key").notNull(),
  "allocation_state": text("allocation_state").notNull(),
  "tokens": text("tokens").notNull(),
  "turns": integer("turns").notNull(),
  "missing_usage": integer("missing_usage").notNull(),
  "unknown_models": integer("unknown_models").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["day"], table["model_filter"], table["model_key"], table["allocation_state"]] }),
  check("token_usage_daily_check_0", sql`model_filter IN (0,1)`),
]);

export const table_token_usage_gaps = sqliteTable("token_usage_gaps", {
  "server_id": text("server_id").notNull(),
  "gap_key": text("gap_key").notNull(),
  "thread_id": text("thread_id"),
  "turn_id": text("turn_id"),
  "reason": text("reason").notNull(),
  "starts_ms": integer("starts_ms").notNull(),
  "ends_ms": integer("ends_ms"),
}, table => [
  primaryKey({ columns: [table["server_id"], table["gap_key"]] }),
]);

export const table_token_usage_input_conflicts = sqliteTable("token_usage_input_conflicts", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["input_id"]] }),
]);

export const table_token_usage_inputs = sqliteTable("token_usage_inputs", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "actor_id": text("actor_id"),
  "actor_kind": text("actor_kind").notNull(),
  "mode": text("mode").notNull(),
  "admission": text("admission").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["input_id"]] }),
  index("token_usage_inputs_actor_query").on(table["server_id"], table["actor_id"], table["actor_kind"], table["admission"], table["thread_id"], table["turn_id"]),
  index("token_usage_inputs_participants_query").on(table["server_id"], table["thread_id"], table["turn_id"], table["admission"], table["actor_kind"], table["actor_id"]),
  index("token_usage_inputs_turn").on(table["server_id"], table["thread_id"], table["turn_id"], table["admission"]),
  check("token_usage_inputs_check_0", sql`actor_kind IN ('human','session','unknown')`),
  check("token_usage_inputs_check_1", sql`mode IN ('start','steer')`),
  check("token_usage_inputs_check_2", sql`admission IN ('confirmed','pending','rejected')`),
]);

export const table_token_usage_metadata_scans = sqliteTable("token_usage_metadata_scans", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "cursor": text("cursor"),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"]] }),
]);

export const table_token_usage_native_counters = sqliteTable("token_usage_native_counters", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "epoch": text("epoch").notNull(),
  "turn_id": text("turn_id"),
  "baseline_json": text("baseline_json").notNull(),
  "cumulative_json": text("cumulative_json").notNull(),
  "source_version": integer("source_version").notNull(),
  "broken": integer("broken").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"]] }),
  check("token_usage_native_counters_check_0", sql`broken IN (0,1)`),
]);

export const table_token_usage_native_terminals = sqliteTable("token_usage_native_terminals", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"]] }),
]);

export const table_token_usage_projection_state = sqliteTable("token_usage_projection_state", {
  "server_id": text("server_id").notNull(),
  "ready": integer("ready").notNull(),
  "cursor_thread": text("cursor_thread").notNull(),
  "cursor_turn": text("cursor_turn").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"]] }),
  check("token_usage_projection_state_check_0", sql`ready IN (0,1)`),
]);

export const table_token_usage_rollouts = sqliteTable("token_usage_rollouts", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "path": text("path").notNull(),
  "cursor": text("cursor").notNull(),
  "last_success_ms": integer("last_success_ms"),
  "error_kind": text("error_kind"),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"]] }),
]);

export const table_token_usage_scopes = sqliteTable("token_usage_scopes", {
  "server_id": text("server_id").notNull(),
  "enabled_at_ms": integer("enabled_at_ms").notNull(),
  "enabled": integer("enabled").notNull(),
  "revision": integer("revision").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"]] }),
  check("token_usage_scopes_check_0", sql`enabled IN (0,1)`),
]);

export const table_token_usage_sources = sqliteTable("token_usage_sources", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "lineage": text("lineage").notNull(),
  "source_id": text("source_id").notNull(),
  "source_kind": text("source_kind").notNull(),
  "source_version": integer("source_version").notNull(),
  "provider": text("provider"),
  "model": text("model"),
  "counts_json": text("counts_json").notNull(),
  "observed_ms": integer("observed_ms").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"], table["lineage"], table["source_kind"], table["source_id"]] }),
  check("token_usage_sources_check_0", sql`source_kind IN ('response','turn-snapshot')`),
]);

export const table_token_usage_submissions = sqliteTable("token_usage_submissions", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "input_id": text("input_id").notNull(),
  "actor_id": text("actor_id"),
  "actor_kind": text("actor_kind").notNull(),
  "mode": text("mode").notNull(),
  "source_kind": text("source_kind").notNull(),
  "submitted_ms": integer("submitted_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["input_id"]] }),
  check("token_usage_submissions_check_0", sql`actor_kind IN ('human','session','unknown')`),
  check("token_usage_submissions_check_1", sql`mode IN ('start','steer')`),
  check("token_usage_submissions_check_2", sql`source_kind IN ('human','system','unknown')`),
]);

export const table_token_usage_turn_actor_projections = sqliteTable("token_usage_turn_actor_projections", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"]] }),
]);

export const table_token_usage_turn_projections = sqliteTable("token_usage_turn_projections", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "value_json": text("value_json").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"]] }),
]);

export const table_token_usage_turns = sqliteTable("token_usage_turns", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "started_ms": integer("started_ms").notNull(),
  "execution_state": text("execution_state").notNull(),
  "source_kind": text("source_kind").notNull(),
  "participants_complete": integer("participants_complete").notNull(),
  "usage_complete": integer("usage_complete").notNull(),
  "responses_complete": integer("responses_complete").notNull(),
  "frozen": integer("frozen").notNull().default(sql`0`),
  "observed_tokens": text("observed_tokens"),
  "allocation_state": text("allocation_state").notNull(),
  "revision": integer("revision").notNull(),
  "unknown_model": integer("unknown_model").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"], table["turn_id"]] }),
  index("token_usage_turns_query").on(table["server_id"], table["started_ms"], table["thread_id"], table["turn_id"], table["frozen"], table["allocation_state"], table["observed_tokens"], table["unknown_model"]),
  index("token_usage_turns_date").on(table["server_id"], table["started_ms"], table["thread_id"], table["turn_id"]),
  check("token_usage_turns_check_0", sql`execution_state IN ('running','completed','failed','interrupted')`),
  check("token_usage_turns_check_1", sql`source_kind IN ('human','system','unknown')`),
  check("token_usage_turns_check_2", sql`participants_complete IN (0,1)`),
  check("token_usage_turns_check_3", sql`usage_complete IN (0,1)`),
  check("token_usage_turns_check_4", sql`responses_complete IN (0,1)`),
  check("token_usage_turns_check_5", sql`frozen IN (0,1)`),
  check("token_usage_turns_check_6", sql`allocation_state IN ('settled','provisional','pending','system','unknown')`),
  check("token_usage_turns_check_7", sql`unknown_model IN (0,1)`),
]);
