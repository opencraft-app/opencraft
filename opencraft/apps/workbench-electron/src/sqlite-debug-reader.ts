import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

const DATABASES = Object.freeze([
  { id: "session-routing", label: "Session routing", file: "opencraft-session-routing.sqlite" },
  { id: "history-index", label: "History index", file: "opencraft-history-index.sqlite" },
  { id: "thread-catalog", label: "Thread catalog", file: "opencraft-threads.sqlite" },
  { id: "execution-authority", label: "Execution authority", file: "opencraft-executions.sqlite" },
] as const);

export interface SqliteDebugDatabase {
  readonly id: string;
  readonly label: string;
  readonly exists: boolean;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number | null;
}

export interface SqliteDebugTable {
  readonly name: string;
  readonly columns: readonly { readonly name: string; readonly type: string; readonly nullable: boolean; readonly primaryKey: boolean }[];
  readonly rowCount: number;
}

export interface SqliteDebugRows {
  readonly databaseId: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
}

type Definition = (typeof DATABASES)[number];

function definition(id: unknown): Definition {
  if (typeof id !== "string") throw new Error("Invalid database id");
  const value = DATABASES.find((candidate) => candidate.id === id);
  if (!value) throw new Error("Unknown OpenCraft database");
  return value;
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function cell(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `[Blob · ${value.byteLength} bytes]`;
  const text = String(value);
  return text.length <= 2_000 ? text : `${text.slice(0, 2_000)}…`;
}

export class SqliteDebugReader {
  constructor(private readonly directory: string) {}

  list(): readonly SqliteDebugDatabase[] {
    return DATABASES.map((database) => {
      try {
        const stat = statSync(join(this.directory, database.file));
        return { id: database.id, label: database.label, exists: stat.isFile(), sizeBytes: stat.isFile() ? stat.size : 0,
          modifiedAtMs: stat.isFile() ? stat.mtimeMs : null };
      } catch {
        return { id: database.id, label: database.label, exists: false, sizeBytes: 0, modifiedAtMs: null };
      }
    });
  }

  tables(databaseId: unknown): readonly SqliteDebugTable[] {
    return this.withDatabase(databaseId, (database) => {
      const names = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as unknown as Array<{ name: string }>;
      return names.map(({ name }) => ({
        name,
        columns: (database.prepare(`PRAGMA table_info(${quotedIdentifier(name)})`).all() as unknown as Array<{
          name: string; type: string; notnull: number; pk: number;
        }>).map((column) => ({ name: column.name, type: column.type || "ANY", nullable: column.notnull === 0, primaryKey: column.pk > 0 })),
        rowCount: Number((database.prepare(`SELECT COUNT(*) AS count FROM ${quotedIdentifier(name)}`).get() as { count: number | bigint }).count),
      }));
    });
  }

  rows(databaseId: unknown, tableName: unknown, rawOffset: unknown, rawLimit: unknown): SqliteDebugRows {
    if (typeof tableName !== "string" || tableName.length === 0 || tableName.length > 128) throw new Error("Invalid table name");
    const offset = typeof rawOffset === "number" && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;
    return this.withDatabase(databaseId, (database, selected) => {
      const known = database.prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=? AND name NOT LIKE 'sqlite_%'",
      ).get(tableName) as { present: number } | undefined;
      if (!known) throw new Error("Unknown OpenCraft database table");
      const columns = (database.prepare(`PRAGMA table_info(${quotedIdentifier(tableName)})`).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
      const total = Number((database.prepare(`SELECT COUNT(*) AS count FROM ${quotedIdentifier(tableName)}`).get() as { count: number | bigint }).count);
      const values = database.prepare(`SELECT * FROM ${quotedIdentifier(tableName)} LIMIT ? OFFSET ?`).all(limit, offset) as unknown as Array<Record<string, unknown>>;
      return { databaseId: selected.id, table: tableName, columns, rows: values.map((row) => Object.freeze(Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, cell(value)]),
      ))), offset, limit, total };
    });
  }

  private withDatabase<T>(databaseId: unknown, use: (database: DatabaseSync, selected: Definition) => T): T {
    const selected = definition(databaseId);
    const path = join(this.directory, selected.file);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      return use(database, selected);
    } finally {
      database.close();
    }
  }
}
