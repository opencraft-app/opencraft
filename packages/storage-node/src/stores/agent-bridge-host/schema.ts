import { sqliteTable, text, integer, primaryKey, foreignKey, index, unique, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_meta = sqliteTable("meta", {
  "key": text("key"),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);

export const table_generations = sqliteTable("generations", {
  "id": text("id"),
  "config": text("config").notNull(),
  "retired": integer("retired").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_routes = sqliteTable("routes", {
  "route": text("route"),
  "generation": text("generation").notNull(),
  "archive_state": text("archive_state").notNull().default(sql`'active'`),
}, table => [
  primaryKey({ columns: [table["route"]] }),
  foreignKey({ columns: [table["generation"]], foreignColumns: [table_generations["id"]] }).onUpdate("no action").onDelete("no action"),
]);

export const table_commands = sqliteTable("commands", {
  "id": text("id"),
  "digest": text("digest").notNull(),
  "epoch": integer("epoch").notNull(),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "method": text("method").notNull(),
  "state": text("state").notNull(),
  "response": text("response"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("commands_pending_archive").on(table.route)
    .where(sql`method IN ('session/archive','session/unarchive') AND state IN ('registered','dispatching')`),
]);

export const table_native_sessions = sqliteTable("native_sessions", {
  "route": text("route"),
  "generation": text("generation").notNull(),
  "native_id": text("native_id").notNull(),
  "restorable": integer("restorable").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

export const table_released_routes = sqliteTable("released_routes", {
  "route": text("route"),
  "generation": text("generation").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

const historyIdentities = sql`json_extract(payload,'$.event.kind') IN ('turn.started','item.started','item.completed')`;
const historyTurn = sql`json_extract(payload,'$.event.kind') = 'turn.started'`;
const historyNativeId = sql`(CASE WHEN ${historyTurn}
  THEN json_extract(payload,'$.event.nativeTurnId') ELSE json_extract(payload,'$.event.item.nativeKey') END)`;
const historyPublicTurnId = sql`json_extract(payload,'$.event.turnId')`;

export const table_outbox = sqliteTable("outbox", {
  "seq": integer("seq").primaryKey({ autoIncrement: true }),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "payload": text("payload").notNull(),
}, table => [
  index("outbox_route_history_identities").on(table.route, table.seq)
    .where(sql`json_extract(payload,'$.event.kind') IN ('turn.started','item.started','item.completed')`),
  index("outbox_history_native_id").on(table.route, historyNativeId, table.seq).where(historyIdentities),
  index("outbox_history_public_turn").on(table.route, historyPublicTurnId, table.seq).where(historyTurn),
]);

export const table_checkpoints = sqliteTable("checkpoints", {
  "route": text("route"),
  "state": text("state").notNull(),
  "at_ms": integer("at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table["route"]] }),
]);

export const table_callbacks = sqliteTable("callbacks", {
  "generation": text("generation").notNull(),
  "id": text("id").notNull(),
  "digest": text("digest").notNull(),
}, table => [
  primaryKey({ columns: [table["generation"], table["id"]] }),
]);

export const table_interactions = sqliteTable("interactions", {
  "route": text("route").notNull(),
  "id": text("id").notNull(),
  "generation": text("generation").notNull(),
}, table => [
  primaryKey({ columns: [table["route"], table["id"]] }),
]);

export const table_inbox = sqliteTable("inbox", {
  "seq": integer("seq"),
  "route": text("route").notNull(),
  "generation": text("generation").notNull(),
  "payload": text("payload").notNull(),
  "projection": text("projection").notNull(),
}, table => [
  primaryKey({ columns: [table["seq"]] }),
  index("inbox_route_projection").on(table.route, table.seq).where(sql`(json_extract(payload,'$.event.kind') IN ('turn.started','item.started','item.completed')
    OR json_extract(payload,'$.method') = 'interaction/request')`),
  index("inbox_history_native_id").on(table.route, historyNativeId, table.seq).where(historyIdentities),
  index("inbox_history_public_turn").on(table.route, historyPublicTurnId, table.seq).where(historyTurn),
]);

export const table_automation_scripts = sqliteTable("automation_scripts", {
  "key": text("key"),
  "digest": text("digest").notNull(),
  "state": text("state").notNull(),
  "result": text("result"),
}, table => [
  primaryKey({ columns: [table["key"]] }),
]);

// Shared thread queue (@opencraft/thread-queue) for bridge Threads.
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
  index("opencraft_host_queue_turn").on(table["thread_id"], table["target_turn_id"], table["state"]),
  index("opencraft_host_queue_order").on(table["thread_id"], table["position"], table["created_at_ms"]),
  unique("opencraft_host_queue_client").on(table["thread_id"], table["client_id"]),
  check("opencraft_host_queue_check_0", sql`state IN ('queued','dispatching','steering','unknown','delivered','discarded','closed')`),
]);

export const table_opencraft_input_delivery = sqliteTable("opencraft_input_delivery", {
  "thread_id": text("thread_id").notNull(),
  "client_id": text("client_id").notNull(),
  "native_admission": text("native_admission").notNull(),
  "context_state": text("context_state").notNull(),
  "revision": integer("revision").notNull(),
}, table => [
  primaryKey({ columns: [table.thread_id, table.client_id] }),
  foreignKey({ columns: [table.thread_id, table.client_id], foreignColumns: [table_opencraft_host_queue.thread_id, table_opencraft_host_queue.client_id] }),
  check("opencraft_input_delivery_check_0", sql`native_admission IN ('pending','accepted','unknown','rejected')`),
  check("opencraft_input_delivery_check_1", sql`context_state IN ('unobserved','recorded')`),
]);
export const table_opencraft_turn_delivery = sqliteTable("opencraft_turn_delivery", {
  "thread_id": text("thread_id").notNull(),
  "turn_id": text("turn_id").notNull(),
  "outcome": text("outcome").notNull(),
  "observed_at_ms": integer("observed_at_ms").notNull(),
}, table => [
  primaryKey({ columns: [table.thread_id, table.turn_id] }),
  check("opencraft_turn_delivery_check_0", sql`outcome IN ('completed','interrupted','failed')`),
]);
