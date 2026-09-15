import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DshHistoryEntry } from "./dsh-client.js";
export interface NativeHistoryPage { events: DshHistoryEntry[]; hasMore: boolean; projections?: unknown }

/** Rebuildable index of immutable native events; never an execution authority. */
export class DshHistoryIndex {
  private readonly db: DatabaseSync;
  private readonly refreshing = new Map<string, Promise<void>>();
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_history_events(session_id TEXT NOT NULL,seq INTEGER NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS native_history_heads(session_id TEXT PRIMARY KEY,complete INTEGER NOT NULL,projection_json TEXT)`);
  }
  complete(sessionId: string): boolean { return this.db.prepare("SELECT complete FROM native_history_heads WHERE session_id=?").get(sessionId)?.complete === 1; }
  async refresh(sessionId: string, fetchPage: (before?: number) => Promise<NativeHistoryPage>, immutable = false): Promise<void> {
    const prior = this.refreshing.get(sessionId);
    if (prior) return prior;
    if (immutable && this.complete(sessionId)) return;
    const operation = this.synchronize(sessionId, fetchPage).finally(() => { if (this.refreshing.get(sessionId) === operation) this.refreshing.delete(sessionId); });
    this.refreshing.set(sessionId, operation);
    return operation;
  }
  private async synchronize(sessionId: string, fetchPage: (before?: number) => Promise<NativeHistoryPage>): Promise<void> {
    const covered = this.complete(sessionId);
    const oldMax = this.db.prepare("SELECT MAX(seq) AS watermark FROM native_history_events WHERE session_id=?").get(sessionId)?.watermark;
    let before: number | undefined;
    let projection: unknown;
    const insert = this.db.prepare("INSERT OR IGNORE INTO native_history_events VALUES(?,?,?)");
    const get = this.db.prepare("SELECT event_json FROM native_history_events WHERE session_id=? AND seq=?");
    for (;;) {
      const page = await fetchPage(before);
      if (before === undefined) {
        projection = page.projections;
        const max = Math.max(-1, ...page.events.map(entry => entry.event.seq));
        if (covered && typeof oldMax === "number" && max < oldMax) throw new Error("Native history watermark regressed");
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const { event } of page.events) {
          const existing = get.get(sessionId, event.seq);
          if (existing && !isDeepStrictEqual(JSON.parse(String(existing.event_json)), event)) throw new Error("Immutable native event changed");
          insert.run(sessionId, event.seq, JSON.stringify(event));
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      if (!page.hasMore || (covered && typeof oldMax === "number" && page.events.some(entry => entry.event.seq <= oldMax))) break;
      const next = Math.min(...page.events.map(entry => entry.event.seq));
      if (!Number.isFinite(next) || (before !== undefined && next >= before)) throw new Error("Native history index made no progress");
      before = next;
    }
    this.db.prepare("INSERT INTO native_history_heads VALUES(?,1,?) ON CONFLICT(session_id) DO UPDATE SET complete=1,projection_json=excluded.projection_json")
      .run(sessionId, projection === undefined ? null : JSON.stringify(projection));
  }
  read(sessionId: string, before: number | undefined, limit: number): DshHistoryEntry[] {
    if (!this.complete(sessionId)) throw new Error("Native history index is incomplete");
    const rows = before === undefined
      ? this.db.prepare("SELECT event_json FROM native_history_events WHERE session_id=? ORDER BY seq DESC LIMIT ?").all(sessionId, limit)
      : this.db.prepare("SELECT event_json FROM native_history_events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?").all(sessionId, before, limit);
    return rows.map(row => ({ event: JSON.parse(String(row.event_json)) }));
  }
  projections(sessionId: string): unknown {
    const value = this.db.prepare("SELECT projection_json FROM native_history_heads WHERE session_id=?").get(sessionId)?.projection_json;
    return typeof value === "string" ? JSON.parse(value) : undefined;
  }
  close(): void { this.db.close(); }
}
