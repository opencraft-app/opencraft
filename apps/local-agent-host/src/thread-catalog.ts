import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";

const BASELINE = "CREATE TABLE opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL)";

type Snapshot = Record<string, any> & { id: string };
interface RecordValue {
  version?: number;
  snapshot: Snapshot;
  manualTitle: string | null;
  archived: boolean;
  configuration: Record<string, unknown>;
}
export interface ThreadCatalogOptions {
  ephemeral?: boolean;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  configuration?: Record<string, unknown>;
}

/** OpenCraft metadata authority. Engine logs remain behind the execution/history port. */
export class ThreadCatalog {
  private readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  private readonly temporary = new Map<string, RecordValue>();

  constructor(path = ":memory:") {
    const managed = openManagedDatabase({
      path,
      migrations: [{ version: 1, name: "thread-catalog", sql: BASELINE }],
    });
    this.database = managed.database;
    this.outcome = managed.outcome;
  }

  private decodeDocument(raw: string): RecordValue {
    const parsed = JSON.parse(raw);
    const version = parsed.version ?? 1;
    if (typeof version !== "number" || version > 1 || !Number.isSafeInteger(version) || version < 1) {
      throw new Error(`Unsupported thread document version: ${version}`);
    }
    return parsed as RecordValue;
  }

  private read(id: string): RecordValue | null {
    const temporary = this.temporary.get(id);
    if (temporary) return structuredClone(temporary);
    const row = this.database.prepare("SELECT document FROM opencraft_threads WHERE id=?").get(id) as { document: string } | undefined;
    return row ? this.decodeDocument(row.document) : null;
  }

  private write(record: RecordValue): void {
    const payload = { ...record, version: 1 };
    if (record.snapshot.ephemeral === true) this.temporary.set(record.snapshot.id, structuredClone(payload));
    else this.database.prepare("INSERT INTO opencraft_threads(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(record.snapshot.id, JSON.stringify(payload));
  }

  upsert(snapshot: Snapshot, options: ThreadCatalogOptions = {}): Snapshot {
    const previous = this.read(snapshot.id);
    const next = { ...snapshot, turns: [],
      createdAt: previous?.snapshot.createdAt ?? snapshot.createdAt,
      ephemeral: options.ephemeral ?? previous?.snapshot.ephemeral ?? snapshot.ephemeral ?? false,
      forkedFromId: options.forkedFromId !== undefined ? options.forkedFromId : previous?.snapshot.forkedFromId ?? snapshot.forkedFromId ?? null,
      parentThreadId: options.parentThreadId !== undefined ? options.parentThreadId : previous?.snapshot.parentThreadId ?? snapshot.parentThreadId ?? null,
      name: previous?.manualTitle ?? snapshot.name ?? null } as Snapshot;
    const record = { snapshot: next, manualTitle: previous?.manualTitle ?? null, archived: previous?.archived ?? false,
      configuration: { ...previous?.configuration, ...options.configuration } };
    this.write(record); return structuredClone(next);
  }

  get(id: string): Snapshot | null { return this.read(id)?.snapshot ?? null; }
  configuration(id: string): Record<string, unknown> { return this.read(id)?.configuration ?? {}; }
  isArchived(id: string): boolean { return this.read(id)?.archived ?? false; }

  rename(id: string, name: string): Snapshot {
    if (typeof name !== "string" || !name.trim() || name.length > 1024) throw new Error("Invalid thread name");
    const record = this.read(id); if (!record) throw new Error("Unknown thread");
    record.manualTitle = name.trim(); record.snapshot.name = record.manualTitle; record.snapshot.preview = record.manualTitle;
    this.write(record); return structuredClone(record.snapshot);
  }

  archive(id: string, archived: boolean): Snapshot {
    const record = this.read(id); if (!record) throw new Error("Unknown thread");
    if (record.snapshot.ephemeral) throw new Error("Temporary threads cannot be archived");
    record.archived = archived; this.write(record); return structuredClone(record.snapshot);
  }

  list(archived: boolean): Snapshot[] {
    return (this.database.prepare("SELECT document FROM opencraft_threads").all() as unknown as Array<{ document: string }>)
      .map(row => this.decodeDocument(row.document)).filter(record => record.archived === archived).map(record => record.snapshot);
  }

  forgetTemporary(id: string): void { this.temporary.delete(id); }
  temporaryIds(): string[] { return [...this.temporary.keys()]; }
  close(): void { this.temporary.clear(); this.database.close(); }
}
