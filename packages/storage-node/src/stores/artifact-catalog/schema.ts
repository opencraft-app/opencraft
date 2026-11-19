import { sqliteTable, text, integer, primaryKey, unique, index, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
export const table_artifact_ingestions = sqliteTable(
  "artifact_ingestions",
  {
    id: text("id").notNull(),
    artifact_id: text("artifact_id").notNull(),
    path: text("path").notNull(),
    phase: text("phase").notNull(),
    created_ms: integer("created_ms").notNull(),
  },
  (table) => [primaryKey({ columns: [table["id"]] })],
);
export const table_artifact_leases = sqliteTable(
  "artifact_leases",
  {
    owner: text("owner").notNull(),
    artifact_id: text("artifact_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table["owner"], table["artifact_id"]] }),
    foreignKey({ columns: [table["artifact_id"]], foreignColumns: [table_artifacts["id"]] })
      .onDelete("no action")
      .onUpdate("no action"),
  ],
);
export const table_artifact_references = sqliteTable(
  "artifact_references",
  {
    owner: text("owner").notNull(),
    slot: text("slot").notNull(),
    artifact_id: text("artifact_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table["owner"], table["slot"]] }),
    index("artifact_reference_target").on(table["artifact_id"]),
    foreignKey({ columns: [table["artifact_id"]], foreignColumns: [table_artifacts["id"]] })
      .onDelete("no action")
      .onUpdate("no action"),
  ],
);
export const table_artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").notNull(),
    scope: text("scope").notNull(),
    source_key: text("source_key").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    path: text("path").notNull(),
    origin: text("origin").notNull(),
    created_ms: integer("created_ms").notNull(),
    deleting: integer("deleting")
      .notNull()
      .default(sql`0`),
  },
  (table) => [
    primaryKey({ columns: [table["id"]] }),
    unique("legacy_unique_artifacts_scope_source_key").on(table["scope"], table["source_key"]),
  ],
);
