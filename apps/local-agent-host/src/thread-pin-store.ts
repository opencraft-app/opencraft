import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface ThreadPinRecord {
  version: 1;
  threadIds: string[];
}

/**
 * Ordered sidebar placement for sessions owned by one engine. The engine's
 * native session store remains authoritative for existence; this index only
 * remembers which sessions a person pinned and in what order.
 */
export class ThreadPinStore {
  private threadIds: string[] | null = null;
  private loading: Promise<string[]> | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<string[]> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      // An absent index is empty. A damaged index cannot block the catalog;
      // the next accepted write replaces it with a complete record.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || (value as ThreadPinRecord).version !== 1 || !Array.isArray((value as ThreadPinRecord).threadIds)) return [];
    const seen = new Set<string>();
    return (value as ThreadPinRecord).threadIds.filter((id): id is string => {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  private async current(): Promise<string[]> {
    if (this.threadIds !== null) return this.threadIds;
    this.loading ??= this.read().then(threadIds => {
      this.threadIds = threadIds;
      return threadIds;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }

  async list(): Promise<string[]> {
    return [...await this.current()];
  }

  async set(threadId: string, pinned: boolean): Promise<void> {
    if (threadId.length === 0) throw new Error("Thread pin target is empty");
    const operation = this.writes.catch(() => {}).then(async () => {
      const current = await this.current();
      const index = current.indexOf(threadId);
      const next = pinned
        ? index < 0 ? [...current, threadId] : current
        : index < 0 ? current : current.filter(id => id !== threadId);
      if (next === current) return;
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const record: ThreadPinRecord = { version: 1, threadIds: [...next] };
      try {
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      this.threadIds = [...next];
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
