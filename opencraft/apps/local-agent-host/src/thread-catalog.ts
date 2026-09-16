import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type Snapshot = Record<string, any> & { id: string };
interface RecordValue { snapshot: Snapshot; manualTitle: string | null; archived: boolean; configuration: Record<string, unknown> }
export interface ThreadCatalogOptions {
  ephemeral?: boolean;
  forkedFromId?: string | null;
  parentThreadId?: string | null;
  configuration?: Record<string, unknown>;
}

/** OpenCraft metadata authority. Engine logs remain behind the execution/history port. */
export class ThreadCatalog {
  private readonly database: DatabaseSync;
  private readonly temporary = new Map<string, RecordValue>();
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("CREATE TABLE IF NOT EXISTS opencraft_threads (id TEXT PRIMARY KEY, document TEXT NOT NULL)");
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  private read(id: string): RecordValue | null {
    const temporary = this.temporary.get(id);
    if (temporary) return structuredClone(temporary);
    const row = this.database.prepare("SELECT document FROM opencraft_threads WHERE id=?").get(id) as { document: string } | undefined;
    return row ? JSON.parse(row.document) : null;
  }
  private write(record: RecordValue): void {
    if (record.snapshot.ephemeral === true) this.temporary.set(record.snapshot.id, structuredClone(record));
    else this.database.prepare("INSERT INTO opencraft_threads(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document")
      .run(record.snapshot.id, JSON.stringify(record));
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
      .map(row => JSON.parse(row.document) as RecordValue).filter(record => record.archived === archived).map(record => record.snapshot);
  }
  forgetTemporary(id: string): void { this.temporary.delete(id); }
  temporaryIds(): string[] { return [...this.temporary.keys()]; }
  close(): void { this.temporary.clear(); this.database.close(); }
}
