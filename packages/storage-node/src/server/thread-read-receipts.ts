import type { SqlDatabase } from "@opencraft/sql";

/** The exact Host, Thread and Turn a person has read. */
export type ThreadReadReceiptIdentity = readonly [hostId: string, threadId: string, turnId: string];

export interface ThreadReadReceiptPage {
  /** The Actor's latest change; a device passes it back as `after` to read only newer receipts. */
  readonly cursor: number;
  /** Oldest first, so a bounded client cache keeps the newest. */
  readonly receipts: readonly ThreadReadReceiptIdentity[];
}

export interface ThreadReadReceiptMethods {
  /**
   * Receipts recorded after `after` (0 reads all). A cursor beyond the Actor's latest
   * change, such as one from before a restored backup, reads all again.
   */
  readThreadReadReceipts(actorId: string, after: number): ThreadReadReceiptPage;
  /**
   * Adds receipts; receipts are never removed or replaced by a merge, so read state
   * only moves forward. Returns the new cursor. Bounds evict the oldest receipts.
   */
  mergeThreadReadReceipts(actorId: string, receipts: readonly ThreadReadReceiptIdentity[]): { readonly cursor: number };
}

/** A Thread keeps its newest receipts; a stale device's late read of an older Turn cannot evict the newest one. */
export const THREAD_READ_RECEIPTS_PER_THREAD = 8;
/** Matches the client's bounded read set. */
export const THREAD_READ_RECEIPTS_PER_ACTOR = 4096;
/** Largest merge one call accepts. */
export const THREAD_READ_RECEIPTS_PER_MERGE = 128;

function actor(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid read receipt Actor");
}

function identity(value: unknown): ThreadReadReceiptIdentity {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((part) => typeof part !== "string" || !part || part.length > 512)
  )
    throw new Error("Invalid read receipt identity");
  return [value[0], value[1], value[2]];
}

/** Invoked only in the Server owner Worker; the network thread reaches it through async calls. */
export function threadReadReceiptMethods(db: SqlDatabase): ThreadReadReceiptMethods {
  const latest = db.prepare("SELECT max(sequence) AS cursor FROM thread_read_receipts WHERE actor_id=?");
  const page = db.prepare(`SELECT host_id, thread_id, turn_id FROM thread_read_receipts
    WHERE actor_id=? AND sequence>? ORDER BY sequence`);
  const insert = db.prepare(`INSERT INTO thread_read_receipts(actor_id, host_id, thread_id, turn_id, sequence, read_at)
    VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(actor_id, host_id, thread_id, turn_id) DO NOTHING`);
  const trimThread = db.prepare(`DELETE FROM thread_read_receipts
    WHERE actor_id=? AND host_id=? AND thread_id=? AND sequence <= (
      SELECT sequence FROM thread_read_receipts WHERE actor_id=? AND host_id=? AND thread_id=?
      ORDER BY sequence DESC LIMIT 1 OFFSET ?)`);
  const trimActor = db.prepare(`DELETE FROM thread_read_receipts
    WHERE actor_id=? AND sequence <= (
      SELECT sequence FROM thread_read_receipts WHERE actor_id=? ORDER BY sequence DESC LIMIT 1 OFFSET ?)`);

  const cursorOf = (actorId: string): number => {
    const value = latest.get(actorId)?.cursor;
    return typeof value === "number" ? value : 0;
  };

  return {
    readThreadReadReceipts(actorId, after) {
      actor(actorId);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid read receipt cursor");
      const cursor = cursorOf(actorId);
      const rows = page.all(actorId, after > cursor ? 0 : after);
      return {
        cursor,
        receipts: rows.map((row) => identity([row.host_id, row.thread_id, row.turn_id])),
      };
    },
    mergeThreadReadReceipts(actorId, input) {
      actor(actorId);
      if (!Array.isArray(input) || input.length > THREAD_READ_RECEIPTS_PER_MERGE)
        throw new Error("Invalid read receipts");
      // Validate everything before the first write: a malformed item leaves the record unchanged.
      const receipts = input.map(identity);
      return db.transaction(() => {
        let cursor = cursorOf(actorId);
        const now = Date.now();
        const threads = new Map<string, readonly [string, string]>();
        for (const [hostId, threadId, turnId] of receipts) {
          if (Number(insert.run(actorId, hostId, threadId, turnId, cursor + 1, now).changes) === 1) {
            cursor += 1;
            threads.set(JSON.stringify([hostId, threadId]), [hostId, threadId]);
          }
        }
        for (const [hostId, threadId] of threads.values())
          trimThread.run(actorId, hostId, threadId, actorId, hostId, threadId, THREAD_READ_RECEIPTS_PER_THREAD);
        if (threads.size) trimActor.run(actorId, actorId, THREAD_READ_RECEIPTS_PER_ACTOR);
        return { cursor };
      });
    },
  };
}
