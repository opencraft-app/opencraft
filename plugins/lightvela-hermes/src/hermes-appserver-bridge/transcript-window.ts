import type { HermesHistoryClient } from "./history-client";
import type { HermesMessage, HermesMessagesPage } from "./types";

/** Hermes Desktop api/sessions.ts: paging is in rows, not AppServer Turns. */
export const LATEST_SESSION_MESSAGES_LIMIT = 120;

function rowId(row: HermesMessage): number | undefined {
  return row.row_id ?? row._row_id ?? (typeof row.id === "number" ? row.id : undefined);
}

export interface HermesTranscriptWindowSnapshot {
  readonly messages: readonly HermesMessage[];
  readonly nextOffset: number;
  readonly possiblyTruncated: boolean;
}

function pageState(page: HermesMessagesPage) {
  const pagination = page.pagination;
  return {
    nextOffset: (pagination?.offset ?? 0) + page.messages.length,
    // Desktop treats absent pagination as a legacy full-transcript response.
    possiblyTruncated: pagination !== undefined && pagination.limit > 0
      && page.messages.length >= pagination.limit,
  };
}

/** One stored-session / connection / profile scope. The adapter owns this
 * cache; it is neither execution authority nor a source of synthetic Turns.
 * Mirrors Desktop transcript-backfill's merge and stale-read boundaries. */
export class HermesTranscriptWindow {
  private snapshot: HermesTranscriptWindowSnapshot = { messages: [], nextOffset: 0, possiblyTruncated: false };
  private generation = 0;
  private older: Promise<HermesTranscriptWindowSnapshot> | null = null;

  constructor(private readonly history: HermesHistoryClient, private readonly storedSessionId: string, private readonly profile?: string | null,
    initial?: HermesTranscriptWindowSnapshot) {
    if (initial) this.snapshot = initial;
  }

  getSnapshot(): HermesTranscriptWindowSnapshot { return this.snapshot; }

  invalidate(): void { this.generation++; this.older = null; }

  async readTail(signal?: AbortSignal): Promise<HermesTranscriptWindowSnapshot> {
    const generation = ++this.generation;
    this.older = null;
    const page = await this.fetch(0, signal);
    if (generation !== this.generation) return this.snapshot;
    const first = page.messages[0];
    const anchor = first && rowId(first);
    const index = anchor === undefined ? -1 : this.snapshot.messages.findIndex(row => rowId(row) === anchor);
    // A refreshed tail retains the previously backfilled prefix only where
    // the authoritative response has a matching durable anchor.
    const messages = index > 0
      ? [...this.snapshot.messages.slice(0, index), ...page.messages]
      : page.messages;
    this.snapshot = { messages, ...pageState(page) };
    return this.snapshot;
  }

  readOlder(signal?: AbortSignal, expectedOffset = this.snapshot.nextOffset): Promise<HermesTranscriptWindowSnapshot> {
    signal?.throwIfAborted();
    if (expectedOffset < this.snapshot.nextOffset) return Promise.resolve(this.snapshot);
    if (expectedOffset > this.snapshot.nextOffset) return Promise.reject(new Error("Stale Hermes history cursor; resume the transcript window"));
    if (this.older !== null) return this.older;
    if (!this.snapshot.possiblyTruncated) return Promise.resolve(this.snapshot);
    const generation = this.generation;
    const operation = this.fetch(this.snapshot.nextOffset, signal).then(page => {
      if (generation !== this.generation) return this.snapshot;
      const existing = this.snapshot.messages;
      // Never install a backfill as the whole transcript after a session reset.
      if (existing.length === 0) return this.snapshot;
      const ids = new Set(existing.map(rowId).filter(id => id !== undefined));
      const fresh = page.messages.filter(row => {
        const id = rowId(row);
        return id === undefined || !ids.has(id);
      });
      this.snapshot = { messages: fresh.length === 0 ? existing : [...fresh, ...existing], ...pageState(page) };
      return this.snapshot;
    }).finally(() => { if (this.older === operation) this.older = null; });
    this.older = operation;
    return operation;
  }

  private async fetch(offset: number, signal?: AbortSignal): Promise<HermesMessagesPage> {
    signal?.throwIfAborted();
    const page = await this.history.readMessages(this.storedSessionId, {
      limit: LATEST_SESSION_MESSAGES_LIMIT, offset, order: "latest", includeCompacted: true,
      ...(this.profile ? { profile: this.profile } : {}),
    }, signal);
    signal?.throwIfAborted();
    return page;
  }
}
