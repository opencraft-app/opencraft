import { sqliteTable, text, integer, primaryKey, unique, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const metadata = sqliteTable(
  "workspace_journal_meta",
  {
    key: text("key"),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key] })],
);
export const workspaces = sqliteTable(
  "ordinary_workspaces",
  {
    authorityKey: text("authority_key").notNull(),
    principalId: text("principal_id").notNull(),
    hostId: text("host_id").notNull(),
    intentId: text("intent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    selectionDigest: text("selection_digest").notNull(),
    threadId: text("thread_id"),
    generation: integer("generation").notNull().default(0),
    phase: text("phase").notNull().default("idle"),
    instanceId: text("instance_id"),
    privateVolumeId: text("private_volume_id"),
  },
  (table) => [
    primaryKey({ columns: [table.authorityKey, table.intentId] }),
    unique("legacy_unique_ordinary_workspaces_workspace_id").on(table.workspaceId),
    unique("legacy_unique_ordinary_workspaces_host_thread").on(table.hostId, table.threadId),
    check("ordinary_workspaces_phase", sql`phase IN ('idle','creating','live','releasing','uncertain')`),
  ],
);
export const selections = sqliteTable(
  "ordinary_workspace_selections",
  {
    workspaceId: text("workspace_id"),
    selectionJson: text("selection_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId] })],
);
export const starts = sqliteTable(
  "ordinary_workspace_thread_starts",
  {
    workspaceId: text("workspace_id"),
    generation: integer("generation").notNull(),
    phase: text("phase").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId] }),
    check("ordinary_workspace_thread_starts_phase", sql`phase IN ('dispatched','confirmed')`),
  ],
);
