import { PiQueueDoc, type PiQueueState } from "./queue.js";
import { DatabaseSync, backup } from "node:sqlite";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, InboxDoc, LiveDoc, UsageDoc, ROOT_CONVERSATION_ID, type Cursor, type Page } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PiSnapshot } from "./session.js";
import { TranscriptReadCache, observeNativeTranscriptFiles } from "@opencraft/native-history-node";
import type { AppServerThread, AppServerTurn } from "@opencraft/appserver-protocol";

/** The Host supplies metadata and the canonical read-only projection. The
 * shared cache owns offsets/blobs; the Pi native database remains authority. */
export function createPiTranscriptCache(options: {
  dataDirectory: string;
  directory: string;
  readThread(threadId: string): Promise<AppServerThread>;
  readTurns(threadId: string, signal?: AbortSignal): Promise<AppServerTurn[]>;
}): TranscriptReadCache {
  const snapshots = new Map<string, { promise: Promise<AppServerTurn[]>; signal?: AbortSignal }>();
  return new TranscriptReadCache(options.dataDirectory, {
    readThread: options.readThread,
    async observeSnapshotSource(threadId) {
      snapshots.delete(threadId);
      const file = join(options.directory, `${threadId}.sqlite`);
      return observeNativeTranscriptFiles(options.directory, [file, `${file}-wal`], JSON.stringify(["pi", options.directory, threadId]));
    },
    async listTurns(threadId, cursor, limit, signal, sortDirection = "desc") {
      let snapshot = snapshots.get(threadId);
      if (!snapshot || snapshot.signal !== signal) {
        snapshot = { promise: options.readTurns(threadId, signal), signal };
        snapshots.set(threadId, snapshot);
      }
      try {
        const turns = (await snapshot.promise).slice();
        if (sortDirection !== "asc") turns.reverse();
        const offset = cursor === null ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid Pi native transcript cursor");
        const nextCursor = offset + limit < turns.length ? String(offset + limit) : null;
        if (nextCursor === null && snapshots.get(threadId) === snapshot) snapshots.delete(threadId);
        return { data: turns.slice(offset, offset + limit), nextCursor };
      } catch (error) { if (snapshots.get(threadId) === snapshot) snapshots.delete(threadId); throw error; }
    },
  });
}

/** No Harness, writer lock, watcher, configuration or execution owner is opened.
 * A consistent disposable SQLite snapshot lets the native Storage reader own
 * document materialization and entry semantics, including live partial output.
 */
export async function readPiSnapshot(file: string, cacheDirectory: string, signal?: AbortSignal): Promise<PiSnapshot> {
  const deadline = performance.now() + 30_000;
  const throwIfAborted = () => {
    if (performance.now() >= deadline) throw new Error("Pi history read timed out");
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new Error("Pi history read cancelled");
  };
  throwIfAborted();
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cacheDirectory, "pi-read-"));
  try {
    const source = new DatabaseSync(file, { readOnly: true });
    try { await backup(source, join(directory, "snapshot.sqlite"), { rate: 100, progress: throwIfAborted }); }
    finally { source.close(); }
    throwIfAborted();
    await chmod(join(directory, "snapshot.sqlite"), 0o600);
    const storage = await openNodeSqliteStorage(join(directory, "snapshot.sqlite"));
    try {
      const pages = async <T>(read: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> => {
        const records: T[] = []; let cursor: Cursor | undefined;
        do {
          throwIfAborted();
          const page = await read(cursor); records.push(...page.items); cursor = page.next;
          // Native SQLite materialization may resolve synchronously. Yield so
          // connection cancellation and timers can reach this read between pages.
          await setImmediate();
        } while (cursor !== undefined);
        throwIfAborted();
        return records;
      };
      const scope = { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID };
      const doc = async (kind: string, fallback: object) => {
        throwIfAborted();
        const record = await storage.findDocument({ kind, scope }, "current", context);
        return record ? (await storage.document(record.id, "current", context))!.value : fallback;
      };
      const entries = await pages(cursor => storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 100, cursor, context));
      const submissions = await pages(cursor => storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 100, cursor, context));
      const tasks = await pages(cursor => storage.scanTasks({}, 100, cursor, context));
      return { entries, submissions, queue: await doc(PiQueueDoc.definition.kind, { items: [], paused: false }) as unknown as PiQueueState, tasks: new Map(tasks.map(task => [task.id, task])),
        agent: await doc(AgentDoc.definition.kind, {}) as PiSnapshot["agent"],
        live: await doc(LiveDoc.definition.kind, {}) as PiSnapshot["live"],
        usage: await doc(UsageDoc.definition.kind, { models: {}, tools: {} }) as PiSnapshot["usage"],
        inbox: (await doc(InboxDoc.definition.kind, { items: [] }) as { items: Record<string, any>[] }).items,
      };
    } finally { await storage.close(context); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
