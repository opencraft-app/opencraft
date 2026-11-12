import { ThreadDirectory } from "@opencraft/app-host-server/thread-directory";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
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
  directory?: ThreadDirectory;
  private readonly temporary = new Map<string, RecordValue>();
  private readonly manualTitles = new Map<string, string | null>();
  /** In-memory projection for notifications; never performs database IO. */
  manualTitle(id: string): string | null | undefined { return this.manualTitles.get(id); }

  constructor(path = ":memory:") {
    const managed = openManagedDatabase({ schemaId: "thread-catalog",
      path,
      migrations: [{ version: 1, name: "thread-catalog", sql: BASELINE }],
    });
    this.database = managed.database;
    this.outcome = managed.outcome;
  }

  attachDirectory(port: ConstructorParameters<typeof ThreadDirectory>[1]): ThreadDirectory {
    const directory = this.createProjection({ ...port, archivePartitioned: false,
      retain: id => this.read(id) !== null,
      archived: id => this.isArchived(id),
      project: thread => {
        const record = this.read(thread.id);
        return { ...thread,
          ...(record ? { createdAt: record.snapshot.createdAt,
            forkedFromId: record.snapshot.forkedFromId, parentThreadId: record.snapshot.parentThreadId } : {}),
          ...(record?.manualTitle ? { name: record.manualTitle, preview: record.manualTitle } : {}),
        } as Thread;
      },
    });
    // Legacy documents are authority, including manual-only and locally archived rows.
    // Seed once at owner startup; page reads never walk or rewrite these documents.
    for (const archived of [false, true]) for (const thread of this.list(archived)) {
      directory.observe("thread/started", { thread });
      if (archived) directory.observe("thread/archived", { threadId: thread.id });
    }
    return directory;
  }

  createProjection(port: ConstructorParameters<typeof ThreadDirectory>[1]): ThreadDirectory {
    if (this.directory) throw new Error("Thread directory already attached");
    return this.directory = new ThreadDirectory(this.database, port);
  }

  directoryFailed(): boolean {
    return this.database.prepare("SELECT 1 FROM opencraft_catalog_sync WHERE state='error'").get() != null;
  }

  directoryState(): number | null {
    const row = this.database.prepare("SELECT last_success_ms FROM opencraft_catalog_sync WHERE archived=0").get();
    return row?.last_success_ms == null ? null : Number(row.last_success_ms);
  }

  private decodeDocument(raw: string): RecordValue {
    const parsed = JSON.parse(raw);
    const version = parsed.version ?? 1;
    if (typeof version !== "number" || version > 1 || !Number.isSafeInteger(version) || version < 1) {
      throw new Error(`Unsupported thread document version: ${version}`);
    }
    const record = parsed as RecordValue;
    this.manualTitles.set(record.snapshot.id, record.manualTitle ?? null);
    return record;
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
    else this.database.prepare("INSERT INTO opencraft_threads(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document WHERE document<>excluded.document")
      .run(record.snapshot.id, JSON.stringify(payload));
    this.manualTitles.set(record.snapshot.id, record.manualTitle);
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
    this.write(record);
    this.directory?.observe("thread/started", { thread: next });
    return structuredClone(next);
  }

  get(id: string): Snapshot | null {
    const record = this.read(id);
    if (record) return record.snapshot;
    if (!this.directory) return null;
    const row = this.database.prepare("SELECT metadata_json FROM opencraft_thread_catalog WHERE thread_id=? AND deleted=0").get(id);
    return row ? JSON.parse(String(row.metadata_json)) : null;
  }
  configuration(id: string): Record<string, unknown> { return this.read(id)?.configuration ?? {}; }
  isArchived(id: string): boolean { return this.read(id)?.archived ?? false; }

  rename(id: string, name: string): Snapshot {
    if (typeof name !== "string" || !name.trim() || name.length > 1024) throw new Error("Invalid thread name");
    let record = this.read(id);
    if (!record) { const snapshot = this.get(id); if (snapshot) { this.upsert(snapshot); record = this.read(id); } }
    if (!record) throw new Error("Unknown thread");
    record.manualTitle = name.trim(); record.snapshot.name = record.manualTitle; record.snapshot.preview = record.manualTitle;
    this.write(record);
    this.directory?.observe("thread/name/updated", { threadId: id, threadName: record.manualTitle });
    return structuredClone(record.snapshot);
  }

  archive(id: string, archived: boolean): Snapshot {
    let record = this.read(id);
    if (!record) { const snapshot = this.get(id); if (snapshot) { this.upsert(snapshot); record = this.read(id); } }
    if (!record) throw new Error("Unknown thread");
    if (record.snapshot.ephemeral) throw new Error("Temporary threads cannot be archived");
    record.archived = archived; this.write(record);
    this.directory?.observe(archived ? "thread/archived" : "thread/unarchived", { threadId: id });
    return structuredClone(record.snapshot);
  }

  list(archived: boolean): Snapshot[] {
    return (this.database.prepare("SELECT document FROM opencraft_threads").all() as unknown as Array<{ document: string }>)
      .map(row => this.decodeDocument(row.document)).filter(record => record.archived === archived).map(record => record.snapshot);
  }

  forgetTemporary(id: string): void { this.temporary.delete(id); this.manualTitles.delete(id); }
  temporaryIds(): string[] { return [...this.temporary.keys()]; }
  close(): void { this.directory?.close(); this.temporary.clear(); this.manualTitles.clear(); this.database.close(); }
}
