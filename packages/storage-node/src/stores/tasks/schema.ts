import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_task_conversations = sqliteTable("task_conversations", {
  "task_id": text("task_id").notNull(),
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "created_at": integer("created_at").notNull(),
}, table => [
  primaryKey({ columns: [table["task_id"], table["server_id"], table["thread_id"]] }),
  index("conversations_by_thread").on(table["server_id"], table["thread_id"], table["task_id"]),
  foreignKey({ columns: [table["task_id"]], foreignColumns: [table_tasks["id"]] }).onUpdate("no action").onDelete("no action"),
]);

export const table_task_events = sqliteTable("task_events", {
  "seq": integer("seq").primaryKey({ autoIncrement: true }),
  "event_id": text("event_id").notNull(),
  "task_id": text("task_id").notNull(),
  "type": text("type").notNull(),
  "task_revision": integer("task_revision").notNull(),
  "actor": text("actor"),
  "channel": text("channel").notNull(),
  "payload": text("payload").notNull(),
  "created_at": integer("created_at").notNull(),
}, table => [
  index("task_progress_by_task").on(table["task_id"], sql`seq DESC`).where(sql`type='progress'`),
  index("task_events_by_task").on(table["task_id"], sql`seq DESC`),
  unique("legacy_unique_task_events_1").on(table["event_id"]),
  foreignKey({ columns: [table["task_id"]], foreignColumns: [table_tasks["id"]] }).onUpdate("no action").onDelete("no action"),
  check("task_events_check_0", sql`type IN ('created','updated','status_changed','linked','unlinked','deleted','restored','progress')`),
  check("task_events_check_1", sql`task_revision>0`),
]);

export const table_task_members = sqliteTable("task_members", {
  "id": text("id").notNull(),
  "name": text("name").notNull(),
  "revision": integer("revision").notNull(),
  "identity_kind": text("identity_kind"),
  "identity_id": text("identity_id"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  check("task_members_check_0", sql`length(trim(name))>0`),
  check("task_members_check_1", sql`revision>0`),
  check("task_members_check_2", sql`
 (identity_kind IS NULL AND identity_id IS NULL) OR
 (identity_kind IS NOT NULL AND identity_id IS NOT NULL AND length(trim(identity_kind)) BETWEEN 1 AND 64 AND length(trim(identity_id)) BETWEEN 1 AND 256)
`),
]);

export const table_tasks = sqliteTable("tasks", {
  "id": text("id").notNull(),
  "title": text("title").notNull(),
  "description": text("description").notNull(),
  "status": text("status").notNull(),
  "project_server_id": text("project_server_id"),
  "project_id": text("project_id"),
  "sort_order": integer("sort_order").notNull(),
  "revision": integer("revision").notNull(),
  "created_at": integer("created_at").notNull(),
  "updated_at": integer("updated_at").notNull(),
  "deleted_at": integer("deleted_at"),
  "assignee_id": text("assignee_id"),
  "priority": text("priority").notNull().default(sql`'none'`),
  "due_date": text("due_date"),
  "kind": text("kind").notNull().default(sql`'unclassified'`),
  "acceptance_criteria": text("acceptance_criteria").notNull().default(sql`''`),
  "archived_at": integer("archived_at"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  index("tasks_active_order").on(table["status"], table["sort_order"], table["id"]).where(sql`archived_at IS NULL AND deleted_at IS NULL`),
  index("tasks_archive_page").on(sql`archived_at DESC`, sql`id DESC`).where(sql`archived_at IS NOT NULL AND deleted_at IS NULL`),
  index("tasks_by_assignee").on(table["assignee_id"], table["status"], table["sort_order"]).where(sql`deleted_at IS NULL`),
  index("tasks_by_status").on(table["status"], table["sort_order"], table["id"]).where(sql`deleted_at IS NULL`),
  foreignKey({ columns: [table["assignee_id"]], foreignColumns: [table_task_members["id"]] }).onUpdate("no action").onDelete("no action"),
  check("tasks_check_0", sql`length(trim(title))>0`),
  check("tasks_check_1", sql`status IN ('backlog','todo','in_progress','in_review','done','canceled')`),
  check("tasks_check_2", sql`revision>0`),
  check("tasks_check_3", sql`priority IN ('none','low','normal','high','urgent')`),
  check("tasks_check_4", sql`(project_server_id IS NULL AND project_id IS NULL) OR (project_server_id IS NOT NULL AND project_id IS NOT NULL)`),
]);
