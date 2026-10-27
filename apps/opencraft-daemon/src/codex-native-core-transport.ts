import { randomUUID } from "node:crypto";
import { CodexCoreReadIsolation, isIsolatedCoreRead } from "./codex-core-read-isolation";
import { CodexCoreSocket } from "./codex-core-socket";
import { CodexCoreControlClient, type CodexGenerationFenceState } from "@opencraft/account-pool-host";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

/** A raw native connection: Host routing and overlays stay in CodexEngineAdapter.
 * Closing this connection never owns/stops the core or its CLI. No request retry. */
export class CodexNativeCoreTransport implements DuplexTransport {
  readonly control: CodexCoreControlClient;
  private readonly hostInstance = randomUUID();
  private readonly lifetime = new AbortController();
  private readEpoch = 0;
  private generationLease: { lease: string; routingEpoch: string } | null = null;
  private usageSequence = 0;
  private usageOperation: Promise<void> | null = null;
  private readonly connection: CodexCoreSocket;
  private readonly reads: CodexCoreReadIsolation;
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private callbackReady = false;
  private ownerIncarnation: string|null = null;
  private routed = false;
  get supportsOrchestrationRouting():boolean{return this.routed;}
  get callbackIncarnation(): string|null {return this.ownerIncarnation;}
  get supportsOrchestration(): boolean { return this.callbackReady; }
  constructor(endpoint: string, token: string, callbackLaneId?: string) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.reads = new CodexCoreReadIsolation(() => this.control.health());
    this.connection = new CodexCoreSocket({
      callbackLaneId,
      health: async signal => { const health = await this.control.health(signal); this.callbackReady = health.callbackProtocolVersion === 1 && !!callbackLaneId && (!health.routingEpoch || health.orchestrationRoutingVersion === 1); this.routed=health.orchestrationRoutingVersion===1; this.ownerIncarnation = health.routingEpoch ? null : health.callbackIncarnation ?? null; return health; },
      message: frame => { for (const listener of this.messages) listener(frame); },
      status: value => { for (const listener of this.statuses) listener(value); },
    });
  }
  get status(): TransportStatus { return this.connection.status; }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  connect(signal?: AbortSignal): Promise<void> { return this.connection.connect(signal); }
  resetConnection(): void { ++this.readEpoch; this.reads.reset(); this.connection.reset(); }
  async send(frame: string): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error("Codex core connection is closed");
    const message = JSON.parse(frame);
    if (isIsolatedCoreRead(message)) {
      const epoch = this.readEpoch;
      // A send acknowledges admission to the bounded reader, not its RPC result.
      // Waiting here would hold AppHost's ordered frame lane behind history.
      void this.reads.read(message).then(reply => {
        if (this.lifetime.signal.aborted || epoch !== this.readEpoch) return;
        for (const listener of this.messages) listener(reply);
      });
    } else this.connection.send(frame);
  }
  publishGenerationUsage(snapshot: () => { routingEpoch: string; blockedThreadIds: readonly string[]; unscopedBusy: boolean; discoveryComplete: boolean; acknowledgedFenceEpoch: number }, apply: (state: CodexGenerationFenceState) => void): Promise<void> {
    if (this.usageOperation) return this.usageOperation;
    const operation = this.sendGenerationUsage(snapshot, apply).finally(() => { if (this.usageOperation === operation) this.usageOperation = null; });
    this.usageOperation = operation; return operation;
  }
  private async sendGenerationUsage(snapshot: () => { routingEpoch: string; blockedThreadIds: readonly string[]; unscopedBusy: boolean; discoveryComplete: boolean; acknowledgedFenceEpoch: number }, apply: (state: CodexGenerationFenceState) => void): Promise<void> {
    const health = await this.control.health(this.lifetime.signal);
    if (!health.routingEpoch || snapshot().routingEpoch !== health.routingEpoch) return;
    if (this.generationLease?.routingEpoch !== health.routingEpoch) this.generationLease = await this.control.claimGenerationHost(this.hostInstance, health.routingEpoch, this.lifetime.signal);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = snapshot();
      const state = await this.control.publishGenerationHost({ ...before, ...this.generationLease, sequence: ++this.usageSequence }, this.lifetime.signal);
      if (!state || state.routingEpoch !== health.routingEpoch || !Number.isSafeInteger(state.fenceEpoch) || !Array.isArray(state.fencedGenerationIds)) throw new Error("Invalid generation admission fence");
      apply(state);
      if (snapshot().acknowledgedFenceEpoch === before.acknowledgedFenceEpoch) return;
      // A new fence is applied synchronously before taking the acknowledgement snapshot.
    }
  }
  async close(): Promise<void> { ++this.readEpoch; this.lifetime.abort(); this.reads.close(); this.connection.close(); }
}
