import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_activity_hours = sqliteTable("activity_hours", {
  "hour": integer("hour").notNull(),
  "actor": text("actor").notNull(),
}, table => [
  primaryKey({ columns: [table["hour"], table["actor"]] }),
]);

export const table_connection_outages = sqliteTable("connection_outages", {
  "recovery_id": text("recovery_id").notNull(),
  "actor": text("actor").notNull(),
  "started": integer("started").notNull(),
  "observed": integer("observed").notNull(),
  "completed": integer("completed").notNull(),
}, table => [
  primaryKey({ columns: [table["recovery_id"]] }),
  index("connection_outage_window").on(table["observed"], table["started"]),
]);

export const table_events = sqliteTable("events", {
  "seq": integer("seq"),
  "event_id": text("event_id").notNull(),
  "at": integer("at").notNull(),
  "received": integer("received").notNull(),
  "kind": text("kind").notNull(),
  "component": text("component").notNull(),
  "actor": text("actor"),
  "body": text("body").notNull(),
}, table => [
  primaryKey({ columns: [table["seq"]] }),
  index("gateway_lifecycle_window").on(table["at"], table["seq"]).where(sql`kind='lifecycle' AND component='gateway'`),
  index("events_availability").on(table["at"], table["seq"]).where(sql`kind='availability'`),
  index("events_incident").on(sql`json_extract(body,'$.incidentRef')`, table["at"]).where(sql`json_extract(body,'$.incidentRef') IS NOT NULL`),
  index("events_received").on(table["received"]),
  index("events_window").on(table["at"], table["received"]),
  unique("legacy_unique_events_1").on(table["event_id"]),
]);

export const table_execution_progress = sqliteTable("execution_progress", {
  "domain_key": text("domain_key").notNull(),
  "engine": text("engine").notNull(),
  "stage": text("stage").notNull(),
  "progress_at": integer("progress_at").notNull(),
  "received": integer("received").notNull(),
  "terminal": integer("terminal").notNull(),
}, table => [
  primaryKey({ columns: [table["domain_key"]] }),
  index("execution_progress_active").on(table["terminal"], table["received"]),
]);

export const table_executions = sqliteTable("executions", {
  "domain_key": text("domain_key").notNull(),
  "started": integer("started"),
  "ended": integer("ended"),
  "outcome": text("outcome").notNull(),
  "updated": integer("updated").notNull(),
}, table => [
  primaryKey({ columns: [table["domain_key"]] }),
  index("executions_window").on(table["started"], table["ended"]),
]);

export const table_metrics = sqliteTable("metrics", {
  "name": text("name").notNull(),
  "dimension": text("dimension").notNull(),
  "value": real("value").notNull(),
}, table => [
  primaryKey({ columns: [table["name"], table["dimension"]] }),
]);

export const table_producers = sqliteTable("producers", {
  "component": text("component").notNull(),
  "producer": text("producer").notNull(),
  "received": integer("received").notNull(),
  "body": text("body").notNull(),
}, table => [
  primaryKey({ columns: [table["component"], table["producer"]] }),
  index("producers_freshness").on(table["component"], sql`received DESC`, sql`producer DESC`),
]);

export const table_queue_samples = sqliteTable("queue_samples", {
  "domain_key": text("domain_key").notNull(),
  "engine": text("engine").notNull(),
  "count": integer("count").notNull(),
  "observed_at": integer("observed_at").notNull(),
  "received": integer("received").notNull(),
}, table => [
  primaryKey({ columns: [table["domain_key"]] }),
]);

export const table_recovery_episodes = sqliteTable("recovery_episodes", {
  "recovery_id": text("recovery_id").notNull(),
  "first_at": integer("first_at").notNull(),
  "last_at": integer("last_at").notNull(),
  "outcome": text("outcome").notNull(),
}, table => [
  primaryKey({ columns: [table["recovery_id"]] }),
  index("recovery_window").on(table["first_at"], table["last_at"]),
]);
