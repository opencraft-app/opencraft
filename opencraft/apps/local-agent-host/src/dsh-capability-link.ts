import { DshCapabilityBroker } from "./dsh-capability-broker.js";
import { DshExecutionAuthority } from "./dsh-execution-authority.js";
import type { DshSessionRouting } from "./dsh-session-routing.js";

/** Polling transport only; all execution/connection authority remains in the host. */
export class DshCapabilityLink {
  private controller = new AbortController();
  private calls = new Map<string, AbortController>();
  private endpoint: string | null = null;
  private task: Promise<void> | null = null;
  private inFlight = new Set<Promise<void>>();
  constructor(private readonly token: string, private readonly broker: DshCapabilityBroker, private readonly authority: DshExecutionAuthority, private readonly routing?: DshSessionRouting) {}
  attach(url: string) {
    if (this.endpoint === url) return;
    this.endpoint = url;
    for (const call of this.calls.values()) call.abort();
    this.calls.clear();
    if (!this.task) this.task = this.poll();
  }
  private async request(path: string, body?: unknown, endpoint = this.endpoint) {
    if (!endpoint) throw new Error("DSH capability plugin is not ready");
    const response = await fetch(endpoint + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error("DSH capability bridge request failed: " + response.status);
    return response.json();
  }
  async register(threadId: string) {
    return this.request("/register", { sessionId: this.routing?.native(threadId) ?? threadId, capabilities: this.broker.list(threadId) });
  }
  async thread(operation: "create" | "resume" | "fork" | "inject" | "release", params: Record<string, unknown>): Promise<any> {
    return this.request("/thread/" + operation, params);
  }
  async modelInfo(provider: string, model: string): Promise<any> {
    return this.request("/model-info", { provider, model });
  }
  async skills(threadId: string | undefined, cwd: string, forceReload = false) {
    return this.request("/skills", { ...(threadId ? { sessionId: this.routing?.native(threadId) ?? threadId } : {}), cwd, forceReload });
  }
  async permissions(threadId?: string, preset?: string): Promise<any> {
    return this.request("/permissions", { ...(threadId ? { sessionId: this.routing?.native(threadId) ?? threadId } : {}), ...(preset ? { preset } : {}) });
  }
  async resolveGeneration(logicalSessionId: string): Promise<{ sessionId: string; generation: number; seedThroughSeq?: number; seedThroughTurn?: number }> {
    return this.request("/resolve-generation", { logicalSessionId }) as Promise<{ sessionId: string; generation: number; seedThroughSeq?: number; seedThroughTurn?: number }>;
  }
  async checkpoint(sessionId: string) { return this.request("/checkpoint", { sessionId }); }
  async createGeneration(input: { logicalSessionId: string; sourceSessionId: string; cwd: string; provider: string; model: string }): Promise<{ sessionId: string; generation: number; interruptedTurns: number; seedThroughSeq: number; seedThroughTurn: number }> {
    return this.request("/generation", input) as Promise<{ sessionId: string; generation: number; interruptedTurns: number; seedThroughSeq: number; seedThroughTurn: number }>;
  }
  async unregister(threadId: string) {
    await this.request("/unregister", { sessionId: this.routing?.native(threadId) ?? threadId }).catch(() => undefined);
  }
  private async poll() {
    while (!this.controller.signal.aborted) {
      const endpoint = this.endpoint;
      try {
        const batch = await this.request("/events", undefined, endpoint) as {events: any[]};
        if (endpoint !== this.endpoint) continue;
        for (const event of batch.events) {
          if (event.type === "capability-cancel") { this.calls.get(event.id)?.abort(); continue; }
          if (event.type !== "capability-request" || this.calls.has(event.id)) continue;
          const abort = new AbortController();
          this.calls.set(event.id, abort);
          const operation = (async () => {
            try {
              const logicalId = this.routing?.logical(event.sessionId) ?? event.sessionId;
              if (this.routing && this.routing.native(logicalId) !== event.sessionId) throw new Error("Retired capability generation");
              const execution = this.authority.table.get(logicalId);
              if (!execution || execution.state !== "running") throw new Error("No active execution authority");
              const epoch = execution.epoch;
              const result = await this.broker.invoke(logicalId, execution.turnId, event.capabilityId, event.arguments, abort.signal, execution.connection) as any;
              if (abort.signal.aborted || endpoint !== this.endpoint || this.authority.table.get(logicalId)?.epoch !== epoch) return;
              await this.request("/respond", { id: event.id, sessionId: event.sessionId, result }, endpoint);
            } catch {
              if (!this.controller.signal.aborted && endpoint === this.endpoint) await this.request("/respond", { id: event.id, sessionId: event.sessionId, error: true }, endpoint).catch(() => {});
            } finally { if (this.calls.get(event.id) === abort) this.calls.delete(event.id); }
          })();
          this.inFlight.add(operation);
          void operation.finally(() => this.inFlight.delete(operation));
        }
      } catch { /* Process restart closes the old endpoint; the supervisor supplies a new generation. */ }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async close() {
    this.controller.abort();
    for (const call of this.calls.values()) call.abort();
    await this.task;
    await Promise.allSettled(this.inFlight);
  }
}
