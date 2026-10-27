import type { DatabaseSync } from "node:sqlite";
import type { Thread, ThreadListParams, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fields = ["id", "environments", "sessionId", "forkedFromId", "parentThreadId", "preview", "ephemeral", "section", "sectionEnteredAt", "projectId", "historyMode", "modelProvider", "model", "reasoningEffort", "createdAt", "updatedAt", "recencyAt", "status", "path", "cwd", "cliVersion", "originator", "source", "canAcceptDirectInput", "threadSource", "agentNickname", "agentRole", "gitInfo", "name", "daybreakEnabled"];
/** Native metadata only. In particular, never persist turns or implementation-specific extra payloads. */
function metadata(value: unknown): Thread | null {
  const row = object(value);
  if (typeof row.id !== "string" || !row.id || row.id.length > 4096 || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)
    || typeof row.cwd !== "string" || row.ephemeral === true) return null;
  return { ...Object.fromEntries(fields.filter(key => key in row).map(key => [key, row[key]])), preview: typeof row.preview === "string" ? row.preview.slice(0, 512) : "", extra: null, turns: [] } as unknown as Thread;
}
const cursorPrefix = "opencraft-catalog-v1:";
type Sync = { last_success_ms: number | null; watermark: number | null; last_full_ms: number | null; state: string };

/** One Hub-owned projection per existing stable Server directory. Native history/execution remains remote. */
export class DurableThreadCatalog {
  #closed = false;
  #revision: number;
  #timer?: ReturnType<typeof setTimeout>;
  #job: Promise<void> | null = null;
  #lastAttempt = -Infinity;
  #abort = new AbortController();
  constructor(readonly database: DatabaseSync, readonly port: {
    list(params: ThreadListParams, signal: AbortSignal): Promise<unknown>;
    changed(): void;
    observed?(threadIds: readonly string[]): void;
  }, readonly now = Date.now, readonly intervalMs = 60_000) {
    this.#revision = Number(database.prepare("SELECT MAX(revision) AS revision FROM opencraft_thread_catalog").get()?.revision ?? 0);
  }
  /** Preserve native semantics for advanced filters and native cursors. */
  supports(params: Record<string, unknown>): boolean {
    return Object.keys(params).every(key => ["cursor", "limit", "archived", "sortKey", "sortDirection", "useStateDbOnly"].includes(key))
      && params.sortKey === "updated_at" && (params.sortDirection == null || params.sortDirection === "desc")
      && (params.archived == null || typeof params.archived === "boolean")
      && (params.cursor == null || typeof params.cursor === "string" && params.cursor.startsWith(cursorPrefix))
      && (params.limit == null || Number.isSafeInteger(params.limit) && Number(params.limit) > 0 && Number(params.limit) <= 1000)
      && params.useStateDbOnly !== false;
  }
  start(): void { if (!this.#closed && this.now() - this.#lastAttempt >= this.intervalMs) void this.refresh().catch(() => {}); }
  async list(params: Record<string, unknown>): Promise<ThreadListResponse & { catalog: { lastSuccessAt: number | null; state: string } }> {
    if (!this.supports(params) || this.#closed) throw new Error("Unsupported catalog query");
    const archived = params.archived === true ? 1 : 0;
    let sync = this.#state(archived);
    if (sync?.last_success_ms == null) {
      try { await this.refresh(); } catch (error) { if (this.#state(archived)?.last_success_ms == null) throw error; }
      sync = this.#state(archived);
    }
    else if (sync.state === "error" && this.now() - this.#lastAttempt >= 5_000) void this.refresh().catch(() => {});
    else this.start();
    const limit = Number(params.limit ?? 30);
    let anchor: { updatedAt: number; id: string } | null = null;
    if (params.cursor) {
      try {
        const parsed = JSON.parse((params.cursor as string).slice(cursorPrefix.length));
        if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== archived || !Number.isFinite(parsed[1]) || typeof parsed[2] !== "string") throw Error();
        anchor = { updatedAt: parsed[1], id: parsed[2] };
      } catch { throw new Error("Invalid catalog cursor"); }
    }
    const rows = this.database.prepare(`SELECT metadata_json,updated_at,thread_id FROM opencraft_thread_catalog
      WHERE archived=? AND deleted=0 ${anchor ? "AND (updated_at < ? OR (updated_at = ? AND thread_id > ?))" : ""}
      ORDER BY updated_at DESC,thread_id ASC LIMIT ?`).all(archived, ...(anchor ? [anchor.updatedAt, anchor.updatedAt, anchor.id] : []), limit + 1);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    const last = rows.at(-1);
    return { data: rows.map(row => JSON.parse(String(row.metadata_json)) as Thread),
      nextCursor: more && last ? cursorPrefix + JSON.stringify([archived, last.updated_at, last.thread_id]) : null,
      backwardsCursor: null, catalog: { lastSuccessAt: sync?.last_success_ms ?? null, state: sync?.state ?? "syncing" } };
  }
  #state(archived: number): Sync | undefined { return this.database.prepare("SELECT * FROM opencraft_catalog_sync WHERE archived=?").get(archived) as Sync | undefined; }
  refresh(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Catalog closed"));
    if (this.#job) return this.#job;
    clearTimeout(this.#timer);
    this.#lastAttempt = this.now();
    const job = this.#refresh(); this.#job = job;
    void job.finally(() => {
      if (this.#job === job) this.#job = null;
      if (!this.#closed) { this.#timer = setTimeout(() => this.start(), this.intervalMs); this.#timer.unref?.(); }
    }).catch(() => {});
    return job;
  }
  async #refresh(): Promise<void> {
    let failed = false;
    for (const archived of [0, 1]) {
      if (this.#closed) return;
      const previous = this.#state(archived), startedRevision = this.#revision;
      const full = !previous?.last_full_ms || this.now() - previous.last_full_ms > 3_600_000;
      this.database.prepare(`INSERT INTO opencraft_catalog_sync(archived,state) VALUES(?,'syncing')
        ON CONFLICT(archived) DO UPDATE SET state='syncing'`).run(archived);
      try {
        const seen = new Set<string>(), cursors = new Set<string>();
        const staged: Thread[] = [];
        let cursor: string | null = null, watermark = previous?.watermark ?? 0, complete = false;
        for (let page = 0; page < 1000; page++) {
          const response = object(await this.port.list({ archived: archived === 1, limit: 200,
            sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true, cursor }, this.#abort.signal));
          if (this.#closed) return;
          if (!Array.isArray(response.data) || !(response.nextCursor == null || typeof response.nextCursor === "string")) throw new Error("Invalid catalog page");
          let oldest = Infinity;
          for (const value of response.data) {
            const row = metadata(value);
            if (!row) { if (object(value).ephemeral === true) continue; throw new Error("Invalid catalog metadata"); }
            watermark = Math.max(watermark, row.updatedAt); oldest = Math.min(oldest, row.updatedAt);
            if (!seen.has(row.id)) { staged.push(row); seen.add(row.id); }
          }
          if (response.nextCursor == null || !full && oldest < (previous?.watermark ?? 0)) { complete = true; break; }
          if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error("Catalog cursor did not advance");
          cursor = response.nextCursor; cursors.add(cursor);
        }
        if (!complete) throw new Error("Catalog synchronization limit exceeded");
        this.database.exec("SAVEPOINT catalog_sync");
        try {
          for (const row of staged) this.#put(row, archived, startedRevision);
          if (full) {
            const rows = this.database.prepare("SELECT thread_id FROM opencraft_thread_catalog WHERE archived=? AND revision<=? AND deleted=0").all(archived, startedRevision);
            for (const row of rows) if (!seen.has(String(row.thread_id))) this.database.prepare("UPDATE opencraft_thread_catalog SET deleted=1,revision=? WHERE thread_id=?").run(++this.#revision, row.thread_id);
          }
          this.database.prepare("UPDATE opencraft_catalog_sync SET last_success_ms=?,watermark=?,last_full_ms=?,state='ready' WHERE archived=?")
            .run(this.now(), watermark, full ? this.now() : previous?.last_full_ms ?? null, archived);
          this.database.exec("RELEASE catalog_sync");
        } catch (error) { this.database.exec("ROLLBACK TO catalog_sync; RELEASE catalog_sync"); throw error; }
        this.port.observed?.(this.database.prepare("SELECT thread_id FROM opencraft_thread_catalog WHERE deleted=0").all().map(row => String(row.thread_id)));
      } catch {
        if (this.#closed) return;
        this.database.prepare("UPDATE opencraft_catalog_sync SET state='error' WHERE archived=?").run(archived); failed = true;
      }
    }
    if (!this.#closed) this.port.changed();
    if (failed) throw new Error("Remote catalog refresh failed");
  }
  #put(row: Thread, archived: number, fence?: number): void {
    const old = this.database.prepare("SELECT revision FROM opencraft_thread_catalog WHERE thread_id=?").get(row.id);
    if (fence !== undefined && old && Number(old.revision) > fence) return;
    this.database.prepare(`INSERT INTO opencraft_thread_catalog VALUES(?,?,?,?,?,?,0) ON CONFLICT(thread_id) DO UPDATE SET
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,archived=excluded.archived,
      observed_at_ms=excluded.observed_at_ms,revision=excluded.revision,deleted=0`)
      .run(row.id, JSON.stringify(row), row.recencyAt ?? row.updatedAt, archived, this.now(), ++this.#revision);
  }
  observe(method: string, params: unknown, result?: unknown): void {
    if (this.#closed) return;
    // Read/resume results have no event revision. An old read must not overwrite
    // a newer title/status; only the fenced synchronizer imports read metadata.
    if (!["thread/start", "thread/started", "thread/fork", "thread/archive", "thread/archived", "thread/unarchive", "thread/unarchived", "thread/delete", "thread/deleted", "thread/name/set", "thread/name/updated", "thread/status/changed"].includes(method)) return;
    const input = object(params), output = object(result);
    const row = metadata(output.thread ?? input.thread);
    if (row) {
      const old = this.database.prepare("SELECT archived FROM opencraft_thread_catalog WHERE thread_id=?").get(row.id);
      this.#put(row, Number(old?.archived ?? 0));
    }
    const id = row?.id ?? input.threadId;
    if (typeof id !== "string" || !id) return;
    const stored = this.database.prepare("SELECT metadata_json,archived FROM opencraft_thread_catalog WHERE thread_id=?").get(id);
    if (method === "thread/delete" || method === "thread/deleted") {
      this.database.prepare(`INSERT INTO opencraft_thread_catalog VALUES(?,'{}',0,0,?,?,1)
        ON CONFLICT(thread_id) DO UPDATE SET deleted=1,revision=excluded.revision`).run(id, this.now(), ++this.#revision);
      this.port.changed();
      return;
    }
    if (!stored) return;
    const current = JSON.parse(String(stored.metadata_json)) as Thread;
    let archived = Number(stored.archived);
    if (["thread/archive", "thread/archived"].includes(method)) archived = 1;
    else if (["thread/unarchive", "thread/unarchived"].includes(method)) archived = 0;
    else if (["thread/name/set", "thread/name/updated"].includes(method) && typeof (input.name ?? input.threadName) === "string") current.name = String(input.name ?? input.threadName);
    else if (method === "thread/status/changed" && typeof object(input.status).type === "string") current.status = input.status as Thread["status"];
    else if (!row) return;
    this.#put(current, archived);
    if (["thread/start", "thread/started", "thread/fork", "thread/archive", "thread/archived", "thread/unarchive", "thread/unarchived", "thread/name/set", "thread/name/updated", "thread/status/changed"].includes(method)) this.port.changed();
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); this.#abort.abort(); }
}
