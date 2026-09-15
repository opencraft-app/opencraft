import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecyclePrincipal } from "../types/thread-lifecycle.ts";
import { isThreadCatalogCheckpoint } from "./thread-catalog-checkpoint.ts";

export { isThreadCatalogCheckpoint } from "./thread-catalog-checkpoint.ts";

type Dependencies = "appServer" | "principal" | "threadManager";

export const THREAD_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const THREAD_TOMBSTONE_MAX_RECORDS = 100_000;

export interface ThreadTombstoneRecord {
  threadId: string;
  seq: number;
  archivedAtMs: number;
  replayUntilMs: number;
}

export interface ThreadTombstoneSnapshot {
  version: 1;
  nextSeq: number;
  records: ThreadTombstoneRecord[];
  lastCheckpointAtMs: number | null;
  lastCheckpointSeq: number;
  lastCheckpointClient: string | null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ThreadTombstoneLedger {
  nextSeq = 1;
  readonly records = new Map<string, ThreadTombstoneRecord>();
  lastCheckpointAtMs: number | null = null;
  lastCheckpointSeq = 0;
  lastCheckpointClient: string | null = null;

  constructor(snapshot: unknown, archivedThreadIds: string[] = [], now = Date.now()) {
    const parsed = objectRecord(snapshot);
    if (parsed?.["version"] === 1 && Array.isArray(parsed["records"])) {
      this.nextSeq = Math.max(1, finiteInteger(parsed["nextSeq"], 1));
      this.lastCheckpointAtMs = Number.isFinite(parsed["lastCheckpointAtMs"])
        ? Number(parsed["lastCheckpointAtMs"])
        : null;
      this.lastCheckpointSeq = finiteInteger(parsed["lastCheckpointSeq"], 0);
      this.lastCheckpointClient = typeof parsed["lastCheckpointClient"] === "string"
        ? parsed["lastCheckpointClient"]
        : null;
      for (const candidate of parsed["records"]) {
        const record = objectRecord(candidate);
        if (record === null || typeof record["threadId"] !== "string" || !record["threadId"]) {
          continue;
        }
        const seq = finiteInteger(record["seq"], 0);
        const archivedAtMs = finiteInteger(record["archivedAtMs"], now);
        const replayUntilMs = finiteInteger(
          record["replayUntilMs"],
          archivedAtMs + THREAD_TOMBSTONE_RETENTION_MS,
        );
        const tombstone: ThreadTombstoneRecord = {
          threadId: record["threadId"],
          seq,
          archivedAtMs,
          replayUntilMs,
        };
        this.records.set(tombstone.threadId, tombstone);
        this.nextSeq = Math.max(this.nextSeq, seq + 1);
      }
    } else {
      for (const threadId of archivedThreadIds) this.record(threadId, now);
    }
    this.prune(now);
  }

  record(threadId: string, now = Date.now()): ThreadTombstoneRecord {
    if (!threadId) throw new Error("thread tombstone requires a thread id");
    this.prune(now);
    const existing = this.records.get(threadId);
    if (existing !== undefined) return existing;
    const record: ThreadTombstoneRecord = {
      threadId,
      seq: this.nextSeq++,
      archivedAtMs: now,
      replayUntilMs: now + THREAD_TOMBSTONE_RETENTION_MS,
    };
    this.records.set(threadId, record);
    this.prune(now);
    return record;
  }

  cancel(threadId: string): boolean {
    return this.records.delete(threadId);
  }

  prune(now = Date.now()): void {
    for (const [threadId, record] of this.records) {
      if (record.replayUntilMs <= now) this.records.delete(threadId);
    }
    if (this.records.size <= THREAD_TOMBSTONE_MAX_RECORDS) return;
    const oldest = [...this.records.values()].sort((left, right) => left.seq - right.seq);
    for (const record of oldest.slice(0, oldest.length - THREAD_TOMBSTONE_MAX_RECORDS)) {
      this.records.delete(record.threadId);
    }
  }

  replayable(now = Date.now()): ThreadTombstoneRecord[] {
    this.prune(now);
    return [...this.records.values()].sort((left, right) => left.seq - right.seq);
  }

  checkpoint(seq: number, client: string | null, now = Date.now()): void {
    this.lastCheckpointAtMs = now;
    this.lastCheckpointSeq = Math.max(this.lastCheckpointSeq, finiteInteger(seq, 0));
    this.lastCheckpointClient = typeof client === "string" && client ? client : null;
  }

  snapshot(): ThreadTombstoneSnapshot {
    return {
      version: 1,
      nextSeq: this.nextSeq,
      records: [...this.records.values()].sort((left, right) => left.seq - right.seq),
      lastCheckpointAtMs: this.lastCheckpointAtMs,
      lastCheckpointSeq: this.lastCheckpointSeq,
      lastCheckpointClient: this.lastCheckpointClient,
    };
  }
}

export class ThreadTombstoneService extends Service {
  static inject = ["appServer", "principal", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly principal: ThreadLifecyclePrincipal;
  readonly ledger: ThreadTombstoneLedger;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadTombstone");
    this.principal = ctx.principal.current();
    const encoded = policyStore.get("threadTombstones", this.principal.id);
    let snapshot: unknown = null;
    if (encoded !== null) {
      try {
        snapshot = JSON.parse(encoded) as unknown;
      } catch (error) {
        throw new Error(`invalid persisted thread tombstones: ${errorMessage(error)}`);
      }
    }
    this.ledger = new ThreadTombstoneLedger(
      snapshot,
      ctx.threadManager.list({ archived: true }).map((thread) => thread.id),
    );
    this.persist();

    ctx.effect(() => ctx.threadManager.onArchive((threadId) => {
      this.record(threadId);
    }));
    ctx.effect(() => ctx.threadManager.onUnarchive((threadId) => {
      this.cancel(threadId);
    }));
    ctx.effect(() => ctx.appServer.onInitialize((connection) => {
      this.replay(connection);
    }));
    ctx.effect(() => ctx.appServer.onAfterResponse((connection, message) => {
      if (message.method === "thread/list" && isThreadCatalogCheckpoint(message.params ?? {})) {
        this.checkpoint(connection);
      }
    }));
  }

  persist(): void {
    policyStore.set("threadTombstones", this.principal.id, JSON.stringify(this.ledger.snapshot()));
  }

  record(threadId: string, now = Date.now()): ThreadTombstoneRecord {
    const before = this.ledger.records.get(threadId);
    const record = this.ledger.record(threadId, now);
    if (record !== before) this.persist();
    return record;
  }

  cancel(threadId: string): void {
    if (this.ledger.cancel(threadId)) this.persist();
  }

  replay(connection: AppServerConnection, now = Date.now()): ThreadTombstoneRecord[] {
    const records = this.ledger.replayable(now);
    const replayedThroughSeq = records.at(-1)?.seq ?? 0;
    connection.threadTombstoneReplay = {
      replayedAtMs: now,
      replayedCount: records.length,
      replayedThroughSeq,
      checkpointed: false,
    };
    for (const record of records) {
      this.ctx.appServer.notifyAfter(connection, "thread/archived", { threadId: record.threadId });
    }
    this.persist();
    return records;
  }

  checkpoint(connection: AppServerConnection, now = Date.now()): boolean {
    const replay = connection.threadTombstoneReplay;
    if (replay === undefined || replay.checkpointed) return false;
    replay.checkpointed = true;
    replay.checkpointedAtMs = now;
    this.ledger.checkpoint(
      replay.replayedThroughSeq,
      connection.clientInfo?.name ?? null,
      now,
    );
    this.persist();
    this.ctx.appServer.audit(connection, "thread_tombstones.checkpoint", {
      replayedCount: replay.replayedCount,
      replayedThroughSeq: replay.replayedThroughSeq,
      checkpointKind: "root-thread-list",
    });
    return true;
  }
}
