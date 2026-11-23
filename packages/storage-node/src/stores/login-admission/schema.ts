import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export const table_login_admission_policies = sqliteTable(
  "login_admission_policies",
  {
    policy: text("policy").notNull(),
    revision: integer("revision").notNull(),
    rules: text("rules").notNull(),
    updated_at: integer("updated_at").notNull(),
    operator: text("operator").notNull(),
  },
  (table) => [primaryKey({ columns: [table["policy"]] })],
);

export const table_login_admission_versions = sqliteTable(
  "login_admission_versions",
  {
    policy: text("policy").notNull(),
    revision: integer("revision").notNull(),
    rules: text("rules").notNull(),
    at: integer("at").notNull(),
    operator: text("operator").notNull(),
  },
  (table) => [primaryKey({ columns: [table["policy"], table["revision"]] })],
);

export const table_login_admission_audit = sqliteTable(
  "login_admission_audit",
  {
    id: integer("id"),
    policy: text("policy").notNull(),
    revision: integer("revision").notNull(),
    action: text("action").notNull(),
    at: integer("at").notNull(),
    operator: text("operator").notNull(),
    detail: text("detail").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table["id"]] }),
    index("login_admission_audit_policy").on(table["policy"], table["id"]),
  ],
);

export const table_login_admission_identities = sqliteTable(
  "login_admission_identities",
  {
    policy: text("policy").notNull(),
    subject: text("subject").notNull(),
    attributes: text("attributes").notNull(),
    seen_at: integer("seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table["policy"], table["subject"]] })],
);

export const table_login_admission_imports = sqliteTable(
  "login_admission_imports",
  {
    policy: text("policy").notNull(),
    source: text("source").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [primaryKey({ columns: [table["policy"], table["source"]] })],
);
