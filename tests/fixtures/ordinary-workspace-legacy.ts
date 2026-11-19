import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { workspaceJournalMigrations } from "../../apps/local-agent-host/src/ordinary-workspace-journal";
/** Synthetic unledgered predecessor, not a mutation of an installed database. */
export function legacyWorkspaceJournal(directory: string, version: 1 | 3) {
  const database = new DatabaseSync(join(directory, "ordinary-workspaces.sqlite"));
  try {
    const rows = database.prepare("SELECT * FROM ordinary_workspaces").all();
    database.exec(
      "DROP TABLE schema_migrations; DROP TABLE ordinary_workspace_selections; DROP TABLE ordinary_workspace_thread_starts; DROP TABLE ordinary_workspaces; DROP TABLE workspace_journal_meta;",
    );
    for (const migration of workspaceJournalMigrations.slice(0, version)) database.exec(migration.sql);
    database.prepare("INSERT INTO workspace_journal_meta VALUES ('deployment','deployment')").run();
    database.prepare("INSERT INTO workspace_journal_meta VALUES ('schema',?)").run(String(version));
    const columns = database
      .prepare("PRAGMA table_info(ordinary_workspaces)")
      .all()
      .map((row) => String(row.name));
    const insert = database.prepare(
      `INSERT INTO ordinary_workspaces (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    );
    for (const row of rows) insert.run(...columns.map((column) => row[column]!));
  } finally {
    database.close();
  }
}
