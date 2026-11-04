import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

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
  index("token_usage_gaps_thread").on(table["server_id"], table["thread_id"], table["ends_ms"]),
  index("token_usage_gaps_open").on(table["server_id"], table["ends_ms"], table["starts_ms"]),
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

export const table_token_usage_legacy_import = sqliteTable("token_usage_legacy_import", {
  "singleton": integer("singleton"),
  "legacy_revision_json": text("legacy_revision_json").notNull(),
}, table => [
  primaryKey({ columns: [table["singleton"]] }),
  check("token_usage_legacy_import_check_0", sql`singleton=1`),
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
  index("token_usage_sources_observed_query").on(table["server_id"], table["observed_ms"]),
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
  index("token_usage_turns_thread_query").on(table["server_id"], table["thread_id"], table["started_ms"], table["turn_id"]),
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
