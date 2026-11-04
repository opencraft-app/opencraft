import WebSocket from "ws";
import { ExecutionLeaseTracker } from "./execution-ownership-transport.js";
import type { ExecutionLeaseStore } from "./execution-lease-store.js";
import type { NativeExecutionProcess } from "./native-execution-origin.js";

/** Server-owned, metadata-only native observation. It neither opens a Thread,
 * resumes execution nor acquires a browser platform-tool owner. */
export class GoalExecutionObserver {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private retryDelay = 1000;
  private observations: Promise<void> = Promise.resolve();
  private readonly tracker: ExecutionLeaseTracker;
  constructor(private readonly options: { url(): Promise<string>; store: ExecutionLeaseStore;
    native(threadId: string): Promise<NativeExecutionProcess | null>; onReady?(): void }) {
    this.tracker = new ExecutionLeaseTracker(options.store);
  }
  start(): void { void this.connect(); }
  private retry(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.connect(); }, this.retryDelay);
    this.timer.unref?.();
  }
  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      const url = await this.options.url(); if (this.closed) return;
      const socket = new WebSocket(url); this.socket = socket; this.retryDelay = 1000;
      socket.once("open", () => socket.send(JSON.stringify({ id: "goal-observer-handshake", method: "initialize",
        params: { clientInfo: { name: "goal-execution-observer", version: "1" } } })));
      socket.on("message", frame => {
        this.observations = this.observations.then(async () => {
          const packet = JSON.parse(frame.toString());
          if (packet.id === "goal-observer-handshake") {
            const extensions = packet.result?.capabilities?.extensions ?? {};
            const providers = extensions["opencraft/execution-engines"]?.providers;
            const supported = extensions["opencraft/goal-execution"]?.version === 1
              || Array.isArray(providers) && providers.some(p => p.extensions?.["opencraft/goal-execution"]?.version === 1);
            if (!supported) { this.retryDelay = 30000; socket.close(); return; }
            socket.send(JSON.stringify({ id: "goal-observer", method: "opencraft/goal-observer/initialize", params: {} }));
            return;
          }
          if (packet.id === "goal-observer" && packet.result?.ready === true) { this.options.onReady?.(); return; }
          if (["opencraft/goal-observer/authorize", "opencraft/goal-observer/admit"].includes(packet.method)) {
            const p = packet.params ?? {};
            let admitted = false;
            if (typeof p.threadId === "string" && typeof p.turnId === "string" && typeof p.authorizationId === "string") {
              if (packet.method.endsWith("/authorize")) admitted = this.options.store.authorizeGoalFromTurn(p.threadId, p.turnId, p.authorizationId, typeof p.inputId === "string" ? p.inputId : undefined);
              else {
                const origin = await this.options.native(p.threadId);
                if (origin) admitted = this.options.store.goalContinuation(p.threadId, p.turnId, p, origin.incarnation);
              }
            }
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: packet.id, result: { admitted } }));
            return;
          }
          if (typeof packet.method !== "string") return;
          if (!["turn/started", "turn/completed", "opencraft/goal/authorized", "thread/goal/updated", "thread/goal/cleared"].includes(packet.method)) return;
          const threadId = packet.params?.threadId;
          if (typeof threadId !== "string") return;
          const native = packet.method === "turn/started" ? await this.options.native(threadId) : null;
          this.tracker.observe(packet, native);
        }).catch(() => { /* Unavailable observations never grant credentials. */ });
      });
      socket.once("error", () => socket.close());
      socket.once("close", () => { if (this.socket === socket) this.socket = undefined; this.retry(); });
    } catch { this.retry(); }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer);
    this.socket?.terminate(); await this.observations;
  }
}
