import { Context, Service } from "@deepseek-ai/cordis";
import type { AppServerClient } from "@opencraft/appserver-client";


declare module "@deepseek-ai/cordis" {
  interface Context {
    resumeNotificationBuffer: ResumeNotificationBufferService;
  }
}

type BufferedAction =
  | { type: "notification"; method: string; replay(): void }
  | { type: "request"; replay(): void; reject(error: Error): void };

function isHistoryDelta(method: string): boolean {
  return method.startsWith("item/") && /(?:\/delta|Delta)$/.test(method);
}
function isSnapshotHistoryNotification(method: string): boolean {
  return isHistoryDelta(method) || ["item/started", "item/completed", "item/fileChange/patchUpdated",
    "item/reasoning/summaryPartAdded", "turn/started", "turn/completed", "thread/status/changed", "thread/started"].includes(method);
}

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

  constructor(ctx: Context, config: ResumeNotificationBufferConfig) {
    super(ctx, "resumeNotificationBuffer");
    const removeNotification = config.client.interceptNotification((notification, next) => {
      const threadId = resolveThreadId(notification.params);
      const buffer = threadId === null ? undefined : this.buffers.get(threadId);
      // Request-scoped paint data is not execution replay. The coordinator
      // checks its token; buffering it would make REST paint wait for Resume.
      if (buffer === undefined || notification.method === "thread/history/preview") next();
      else buffer.push({ type: "notification", method: notification.method, replay: next });
    });
    const removeRequest = config.client.interceptServerRequest((request, next) => {
      const threadId = resolveThreadId(request.params);
      const buffer = threadId === null ? undefined : this.buffers.get(threadId);
      if (buffer === undefined || request.method === "currentTime/read") return next();
      return new Promise<unknown>((resolve, reject) => {
        buffer.push({
          type: "request",
          replay: () => void next().then(resolve, reject),
          reject: (error) => reject(error),
        });
      });
    });
    ctx.effect(() => () => {
      removeNotification();
      removeRequest();
      this.rejectAll(new Error("Resume notification buffer disposed"));
    });
  }

  begin(threadId: string): void {
    if (!this.buffers.has(threadId)) this.buffers.set(threadId, []);
  }

  isBuffering(threadId: string): boolean {
    return this.buffers.has(threadId);
  }

  hasDeltas(threadId: string): boolean {
    return this.buffers.get(threadId)?.some(action => action.type === "notification" && isHistoryDelta(action.method)) ?? false;
  }

  /** A new canonical read supersedes earlier notifications, but never drops requests. */
  supersedeNotifications(threadId: string): void {
    const actions = this.buffers.get(threadId);
    if (actions) this.buffers.set(threadId, actions.filter(action => action.type === "request" || !isSnapshotHistoryNotification(action.method)));
  }

  release(threadId: string): number {
    const actions = this.buffers.get(threadId) ?? [];
    this.buffers.delete(threadId);
    for (const action of actions) action.replay();
    return actions.length;
  }

  discard(threadId: string, error = new Error(`Resume for ${threadId} was discarded`)): number {
    const actions = this.buffers.get(threadId) ?? [];
    this.buffers.delete(threadId);
    for (const action of actions) if (action.type === "request") action.reject(error);
    return actions.length;
  }

  private rejectAll(error: Error): void {
    for (const threadId of [...this.buffers.keys()]) this.discard(threadId, error);
  }
}
