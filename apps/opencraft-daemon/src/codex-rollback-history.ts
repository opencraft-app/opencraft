import { readRollbackIdentityRows, type RollbackIdentityRow } from "@opencraft/agent-bridge-host/storage";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const bridgeId = (id: string) => id.startsWith("bridge:codex:");
const nativeId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const nativeKey = (id: string) => id.toLowerCase().replace(/^urn:uuid:/u, "").replace(/^\{(.*)\}$/u, "$1").replaceAll("-", "");
const historyMethods = new Set([
  "thread/read", "thread/turns/list", "thread/items/list", "thread/searchOccurrences", "thread/history/cancel", "thread/unsubscribe",
]);

export class CodexRollbackHistory {
  private readonly publicIds = new Map<string, string>();
  private readonly readable = new Map<string, string>();

  constructor(serverId: string, rows: readonly RollbackIdentityRow[]) {
    for (const row of rows) {
      const key: unknown = JSON.parse(row.route);
      if (!Array.isArray(key) || key[0] !== serverId || typeof key[1] !== "string" || !bridgeId(key[1])) continue;
      const publicId = key[1];
      const native = nativeKey(row.native_id);
      if (!nativeId.test(row.native_id) || this.publicIds.has(native)) throw new Error("Invalid Codex rollback identity");
      this.publicIds.set(native, publicId);
      if (row.restorable === 1) this.readable.set(publicId, row.native_id);
    }
  }

  toPublic(id: string): string | undefined { return this.publicIds.get(nativeKey(id)); }
  toNative(id: string): string | undefined { return this.readable.get(id); }

  rejection(method: string, params: Value) {
    for (const id of [params.threadId, params.parentThreadId, params.ancestorThreadId, params.sourceThreadId]) {
      if (typeof id !== "string") continue;
      if (this.toPublic(id) !== undefined || (bridgeId(id) && !this.readable.has(id))) {
        return { code: -32600, message: "Thread not found", data: { code: "THREAD_NOT_FOUND" } };
      }
      if (bridgeId(id) && !historyMethods.has(method)) {
        return { code: -32000, message: "Only history is available for this conversation while Codex Bridge is off.",
          data: { notSubmitted: true, submissionOutcome: "rejected" } };
      }
    }
    return undefined;
  }

  nativeRequest(message: Value): Value {
    const params = object(message.params);
    const id = typeof params.threadId === "string" ? this.toNative(params.threadId) : undefined;
    return id === undefined ? message : { ...message, params: { ...params, threadId: id } };
  }

  private projectIds(value: Value, keys: readonly string[]): Value {
    for (const key of keys) {
      const id = value[key], alias = typeof id === "string" ? this.toPublic(id) : undefined;
      if (alias !== undefined) value = { ...value, [key]: alias };
    }
    return value;
  }

  private projectThread(value: unknown): Value {
    return this.projectIds(object(value), ["id", "parentThreadId", "forkedFromId"]);
  }

  publicResponse(message: Value, method: string | undefined): Value {
    if (typeof message.method === "string") {
      const original = object(message.params), params = this.projectIds(original, ["threadId"]);
      if (message.method === "thread/started" && params.thread) return { ...message, params: { ...params, thread: this.projectThread(params.thread) } };
      return params === original ? message : { ...message, params };
    }
    const result = object(message.result);
    if (result.thread) return { ...message, result: { ...result, thread: this.projectThread(result.thread) } };
    if (!Array.isArray(result.data)) return message;
    if (method === "thread/list") return { ...message, result: { ...result, data: result.data.map(row => this.projectThread(row)) } };
    if (method === "thread/search") return { ...message, result: { ...result, data: result.data.map(row => {
      const match = object(row);
      return match.thread ? { ...match, thread: this.projectThread(match.thread) } : row;
    }) } };
    if (method === "thread/loaded/list") return { ...message, result: { ...result, data: result.data.map(id => typeof id === "string" ? this.toPublic(id) ?? id : id) } };
    return message;
  }
}

export async function openCodexRollbackHistory(path: string, serverId: string): Promise<CodexRollbackHistory> {
  return new CodexRollbackHistory(serverId, await readRollbackIdentityRows(path));
}
