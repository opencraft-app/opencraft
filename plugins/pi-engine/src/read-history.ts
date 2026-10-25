import { DatabaseSync, backup } from "node:sqlite";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, InboxDoc, LiveDoc, UsageDoc, ROOT_CONVERSATION_ID, type Cursor, type Page } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PiSnapshot } from "./session.js";

/** No Harness, writer lock, watcher, configuration or execution owner is opened.
 * A consistent disposable SQLite snapshot lets the native Storage reader own
 * document materialization and entry semantics, including live partial output.
 */
export async function readPiSnapshot(file: string, cacheDirectory: string): Promise<PiSnapshot> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cacheDirectory, "pi-read-"));
  try {
    const source = new DatabaseSync(file, { readOnly: true });
    try { await backup(source, join(directory, "snapshot.sqlite")); } finally { source.close(); }
    await chmod(join(directory, "snapshot.sqlite"), 0o600);
    const storage = await openNodeSqliteStorage(join(directory, "snapshot.sqlite"));
    try {
      const pages = async <T>(read: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> => {
        const records: T[] = []; let cursor: Cursor | undefined;
        do { const page = await read(cursor); records.push(...page.items); cursor = page.next; } while (cursor !== undefined);
        return records;
      };
      const scope = { kind: "conversation" as const, conversationId: ROOT_CONVERSATION_ID };
      const doc = async (kind: string, fallback: object) => {
        const record = await storage.findDocument({ kind, scope }, "current", context);
        return record ? (await storage.document(record.id, "current", context))!.value : fallback;
      };
      const entries = await pages(cursor => storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 100, cursor, context));
      const submissions = await pages(cursor => storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 100, cursor, context));
      const tasks = await pages(cursor => storage.scanTasks({}, 100, cursor, context));
      return { entries, submissions, tasks: new Map(tasks.map(task => [task.id, task])),
        agent: await doc(AgentDoc.definition.kind, {}) as PiSnapshot["agent"],
        live: await doc(LiveDoc.definition.kind, {}) as PiSnapshot["live"],
        usage: await doc(UsageDoc.definition.kind, { models: {}, tools: {} }) as PiSnapshot["usage"],
        inbox: (await doc(InboxDoc.definition.kind, { items: [] }) as { items: Record<string, any>[] }).items,
      };
    } finally { await storage.close(context); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
