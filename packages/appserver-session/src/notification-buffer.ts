import { Context, Service } from "@deepseek-ai/cordis";
import type { AppServerClient } from "@opencraft/appserver-client";
import type { AppServerNotification } from "@opencraft/appserver-protocol";


declare module "@deepseek-ai/cordis" {
  interface Context {
    resumeNotificationBuffer: ResumeNotificationBufferService;
  }
}

type BufferedAction = { method: string; replay(): void };

function isHistoryDelta(method: string): boolean {
  return method.startsWith("item/") && /(?:\/delta|Delta)$/.test(method);
}
function isSnapshotHistoryNotification(method: string): boolean {
  return isHistoryDelta(method) || ["item/started", "item/completed", "item/updated", "item/fileChange/patchUpdated",
    "item/reasoning/summaryPartAdded", "turn/started", "turn/completed", "thread/status/changed", "thread/started"].includes(method);
}

/** Legacy constructor config; buffering never intercepts this shared Client. */
export interface ResumeNotificationBufferConfig {
  client: AppServerClient;
}

function nestedString(value: unknown, path: readonly string[]): string | null {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}

export function resolveThreadId(value: unknown): string | null {
  return nestedString(value, ["threadId"])
    ?? nestedString(value, ["conversationId"])
    ?? nestedString(value, ["thread", "id"]);
}

export class ResumeNotificationBufferService extends Service {
  private readonly buffers = new Map<string, BufferedAction[]>();

  constructor(ctx: Context, _config?: ResumeNotificationBufferConfig) {
    super(ctx, "resumeNotificationBuffer");
    ctx.effect(() => () => { this.buffers.clear(); });
  }

  /** Only the owning Session's projection subscription enters this buffer.
   * next is a guarded consumer continuation, never the shared Client lane. */
  interceptProjection(notification: AppServerNotification, next: () => void): void {
    const threadId = resolveThreadId(notification.params);
    const buffer = threadId === null ? undefined : this.buffers.get(threadId);
    if (buffer === undefined || ["thread/history/preview", "thread/settings/updated", "serverRequest/resolved"].includes(notification.method)) next();
    else buffer.push({ method: notification.method, replay: next });
  }

  begin(threadId: string): void {
    if (!this.buffers.has(threadId)) this.buffers.set(threadId, []);
  }

  isBuffering(threadId: string): boolean {
    return this.buffers.has(threadId);
  }

  hasDeltas(threadId: string): boolean {
    return this.buffers.get(threadId)?.some(action => isHistoryDelta(action.method)) ?? false;
  }

  /** Snapshot lifecycle updates have no ordering token relative to a Read.
   * Use the same set for invalidation and supersession, including non-deltas. */
  hasSnapshotOverlap(threadId: string): boolean {
    return this.buffers.get(threadId)?.some(action => isSnapshotHistoryNotification(action.method)) ?? false;
  }

  /** A new canonical read supersedes only observations represented by its snapshot. */
  supersedeNotifications(threadId: string): void {
    const actions = this.buffers.get(threadId);
    if (actions) this.buffers.set(threadId, actions.filter(action => !isSnapshotHistoryNotification(action.method)));
  }

  release(threadId: string): number {
    const actions = this.buffers.get(threadId) ?? [];
    this.buffers.delete(threadId);
    for (const action of actions) action.replay();
    return actions.length;
  }

  discard(threadId: string, _error?: Error): number {
    const actions = this.buffers.get(threadId) ?? [];
    this.buffers.delete(threadId);
    return actions.length;
  }

}
