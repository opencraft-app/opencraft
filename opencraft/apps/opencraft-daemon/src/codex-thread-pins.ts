import { parseThreadPinsSnapshot, type ThreadPinsSnapshot } from "@opencraft/appserver-protocol";

// Native reserved section used by Codex 26.930.31428. Never match its translated name.
export const CODEX_PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const unsupported = (error: unknown) => record(error).code === -32601
  || (record(error).code === -32602 && /^invalid params$/iu.test(error instanceof Error ? error.message : ""))
  || /unknown variant.*threadSection\/list|(?:unknown variant|unsupported|invalid).*(?:section_position|sort)|method not found|unsupported app-server method/iu.test(error instanceof Error ? error.message : "");

/** Metadata-only native adapter; lifetime is one physical Codex incarnation. */
export class CodexThreadPins {
  private discovery: Promise<boolean> | null = null;
  constructor(private readonly request: Request) {}

  private discover(): Promise<boolean> {
    if (this.discovery !== null) return this.discovery;
    const operation = (async () => {
      let cursor: string | null = null;
      const seen = new Set<string>();
      try {
        do {
          const page = record(await this.request("threadSection/list", { cursor, limit: 100 }));
          if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("Invalid native section catalog");
          if (page.data.some(row => record(row).id === CODEX_PINNED_SECTION_ID)) {
            await this.request("thread/list", { sectionId: CODEX_PINNED_SECTION_ID, limit: 1, sortKey: "section_position", useStateDbOnly: true });
            return true;
          }
          cursor = page.nextCursor;
          if (cursor !== null && seen.has(cursor)) throw new Error("Repeated native section cursor");
          if (cursor !== null) seen.add(cursor);
        } while (cursor !== null);
        return false;
      } catch (error) {
        if (unsupported(error)) return false;
        throw error;
      }
    })();
    this.discovery = operation;
    void operation.catch(() => { if (this.discovery === operation) this.discovery = null; });
    return operation;
  }

  async list(): Promise<ThreadPinsSnapshot> {
    if (!await this.discover()) return { supported: false, data: [] };
    const data: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = record(await this.request("thread/list", {
        sectionId: CODEX_PINNED_SECTION_ID, archived: false, cursor, limit: 100,
        sortKey: "section_position", sortDirection: "asc", useStateDbOnly: true,
      }));
      if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("Invalid native pin page");
      data.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== null && seen.has(cursor)) throw new Error("Repeated native pin cursor");
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return parseThreadPinsSnapshot({ supported: true, data });
  }

  async set(threadId: string, pinned: boolean): Promise<{ pinned: boolean }> {
    if (!threadId || typeof pinned !== "boolean") throw new Error("Invalid pin command");
    if (!await this.discover()) throw new Error("此服务器不支持置顶");
    const response = record(await this.request("thread/read", { threadId, includeTurns: false }));
    const thread = record(response.thread);
    if (thread.id !== threadId) throw new Error("Invalid native thread identity");
    const currentlyPinned = record(thread.section).id === CODEX_PINNED_SECTION_ID;
    // A stale unpin must never pull a thread out of an unrelated custom section.
    if (currentlyPinned !== pinned) {
      if (pinned || currentlyPinned) await this.request("thread/section/move", {
        threadId, sectionId: pinned ? CODEX_PINNED_SECTION_ID : null,
      });
    }
    return { pinned };
  }
}
