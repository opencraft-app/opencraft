import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type {
  DuplexTransport,
  TransportStatus,
  TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import { OPENCRAFT_DESKTOP_EXTENSION } from "@opencraft/appserver-protocol/desktop";
import {
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
} from "@opencraft/appserver-protocol";
import type { CodexNativeRequests } from "./codex-host-services.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};

/** What the fallback needs from its native connection. */
export interface CodexNativeFallbackPort extends CodexNativeRequests {
  initializeResult(): Promise<unknown>;
  subscribeNotification(listener: (method: string, params: Value) => void): () => void;
}

/**
 * Requests for a Thread the bridge could not adopt (archived, or never started
 * natively): reads, and metadata changes native Codex makes alone since no
 * Host runs that Thread. Nothing here executes.
 */
export const CODEX_FALLBACK_THREAD_READS = Object.freeze([
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/delete",
]);
export const CODEX_FALLBACK_THREAD_NOTIFICATIONS = Object.freeze([
  "thread/name/updated",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
]);
/** Thread-independent native methods answered for every client; everything else is refused. */
export const CODEX_FALLBACK_NATIVE_METHODS = Object.freeze([
  "thread/list",
  "thread/loaded/list",
  "thread/search",
  "thread/searchOccurrences",
  "config/read",
  "configRequirements/read",
  "skills/list",
  "experimentalFeature/list",
  "collaborationMode/list",
  "fs/readDirectory",
  "fs/getMetadata",
  "fs/readFile",
]);

/**
 * The bottom of the local Codex Host when every Thread runs through the
 * provider bridge: native Codex's own initialize, the Thread catalog, reads of
 * Threads not yet moved to the bridge, and a fixed set of Thread-independent
 * native reads. It never executes anything and owns no state; a request it
 * cannot answer is refused rather than sent anywhere else.
 */
export class CodexNativeFallback implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly clients = new Set<string>();
  private current: TransportStatus = { state: "idle" };
  private unsubscribe?: () => void;

  constructor(private readonly native: CodexNativeFallbackPort) {}

  get status(): TransportStatus {
    return this.current;
  }
  private publish(status: TransportStatus): void {
    this.current = status;
    for (const listener of this.statusListeners) listener(status);
  }
  subscribeStatus(listener: (status: TransportStatus) => void) {
    this.statusListeners.add(listener);
    listener(this.current);
    return () => void this.statusListeners.delete(listener);
  }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async connect(): Promise<void> {
    if (this.current.state === "open") return;
    this.publish({ state: "connecting" });
    try {
      await this.native.initializeResult();
    } catch (error) {
      this.publish({ state: "failed", reason: error instanceof Error ? error.message : "Codex unavailable" });
      throw error;
    }
    // Thread-independent native notifications (rate limits, account, config) reach every client.
    this.unsubscribe ??= this.native.subscribeNotification((method, params) => {
      // Of Thread notifications only the catalog changes this connection made itself (see CODEX_FALLBACK_THREAD_READS).
      if (params.threadId !== undefined && !CODEX_FALLBACK_THREAD_NOTIFICATIONS.includes(method)) return;
      // Threads this connection starts are Host-private (title inference), never conversations.
      if (params.thread !== undefined) return;
      for (const client of this.clients) this.emit({ method, params }, client);
    });
    this.publish({ state: "open" });
  }
  private emit(frame: Value, client?: string): void {
    const value = JSON.stringify({ jsonrpc: "2.0", ...frame, ...(client ? { [LOGICAL_CLIENT_FIELD]: client } : {}) });
    for (const listener of this.listeners) listener(value);
  }
  send(frame: string): Promise<void> {
    return this.sendWithContext(frame, { sender: null });
  }
  async sendWithContext(raw: string, _context: TransportSubmissionContext): Promise<void> {
    const frame = object(JSON.parse(raw)),
      method = typeof frame.method === "string" ? frame.method : "";
    const client =
      typeof frame[LOGICAL_CLIENT_FIELD] === "string" ? (frame[LOGICAL_CLIENT_FIELD] as string) : undefined;
    if (method === "runtime/client/disconnect") {
      if (client) this.clients.delete(client);
      return;
    }
    if (frame.id === undefined) return;
    const reply = (body: Value) => this.emit({ id: frame.id, ...body }, client);
    try {
      if (method === "initialize") {
        if (client) this.clients.add(client);
        return reply({ result: projectNativeInitialize(await this.native.initializeResult()) });
      }
      if (!client || !this.clients.has(client))
        return reply({ error: { code: -32600, message: "Client is not initialized" } });
      const params = object(frame.params);
      // Nothing of a Thread is watched or held here.
      if (method === "thread/unsubscribe") return reply({ result: {} });
      if (method === "thread/history/cancel") return reply({ result: { cancelled: false } });
      if (CODEX_FALLBACK_THREAD_READS.includes(method) || CODEX_FALLBACK_NATIVE_METHODS.includes(method))
        return reply({ result: (await this.native.request(method, params)) ?? null });
      return reply({
        error: {
          code: -32601,
          message:
            typeof params.threadId === "string"
              ? "This conversation is not available for that operation"
              : `Method unavailable: ${method}`,
        },
      });
    } catch (cause) {
      const error = cause as Error & { code?: unknown };
      reply({
        error: {
          code: typeof error.code === "number" ? error.code : -32000,
          message: error.message || "Codex request failed",
        },
      });
    }
  }
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.clients.clear();
    this.publish({ state: "closed" });
  }
}

/**
 * Native Codex's initialize as this Host's base: native capabilities stay,
 * extensions native may claim for stores this machine owns are removed. Each
 * layer above (bridge, Host services) adds the extensions it serves.
 */
export function projectNativeInitialize(value: unknown): Value {
  const result = object(value),
    capabilities = object(result.capabilities);
  const extensions = { ...object(capabilities.extensions) };
  delete extensions[OPENCRAFT_DESKTOP_EXTENSION];
  extensions["opencraft/read-history"] = { version: 1, initialTurnsPage: false };
  // Native Codex persists a new Thread at its first turn; the bridge adds itself as an engine provider.
  extensions[OPENCRAFT_THREAD_START_DURABILITY_EXTENSION] = OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY;
  extensions["opencraft/thread-orchestration-view"] = { version: 1 };
  extensions["opencraft/execution-engines"] = { version: 1, defaultEngine: "codex", providers: [] };
  return { ...result, capabilities: { ...capabilities, extensions } };
}
