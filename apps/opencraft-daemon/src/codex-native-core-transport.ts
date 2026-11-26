import { CodexCoreReadIsolation, isIsolatedCoreRead } from "@opencraft/account-pool-host/codex-core-read-isolation";
import { CodexCoreSocket } from "./codex-core-socket";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import type { CodexRollbackHistory } from "./codex-rollback-history";

/** Where the runtime owner (Codex AppServer) is reached when it is not behind the
 * account Core: its control endpoint and token, and the native socket to dial. A
 * WorkspaceHost passes local endpoint listeners here; the in-environment paths in
 * the owner's health are never dialled. */
export interface CodexRuntimeEndpoints {
  readonly endpoint: string;
  /** A function when the credential belongs to the runtime owner's incarnation. */
  readonly token: string | (() => Promise<string>);
  readonly nativeSocket?: string;
  /** Runs one owner read inside the environment's current agent incarnation: the result
   * is returned only when the same agent was bound before and after (a WorkspaceHost's
   * placement fence). Absent for an owner on this machine. */
  readonly fence?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Resolve owner health and the native socket reachable from this Host. */
export function createCodexRuntimeHealthReader(control: CodexCoreControlClient, runtime?: CodexRuntimeEndpoints) {
  let runtimeClient: { token: string; client: CodexCoreControlClient } | undefined;
  return async (signal?: AbortSignal, observation: "execution" | "native" = "execution") => {
    if (!runtime) return control.health(signal, observation);
    const token = typeof runtime.token === "function" ? await runtime.token() : runtime.token;
    if (runtimeClient?.token !== token) runtimeClient = { token, client: new CodexCoreControlClient(runtime.endpoint, token) };
    const client = runtimeClient.client;
    const health = runtime.fence ? await runtime.fence(() => client.health(signal, observation)) : await client.health(signal, observation);
    return runtime.nativeSocket ? { ...health, nativeSocket: runtime.nativeSocket } : health;
  };
}

/** The runtime owner attests its native child in its own PID namespace and reports the
 * incarnation; this Host never reads the owner's process tree. Missing means unknown. */
export function reportedCodexExecution(health: { executionIncarnation?: string }): string | undefined {
  return typeof health.executionIncarnation === "string" && health.executionIncarnation ? health.executionIncarnation : undefined;
}

/** A raw native connection: Host routing and overlays stay in CodexEngineAdapter.
 * Closing this connection never owns/stops the core or its CLI. No request retry. */
export class CodexNativeCoreTransport implements DuplexTransport {
  /** Account plane (accounts, subscriptions); also the runtime plane when no runtime is given. */
  readonly control: CodexCoreControlClient;
  /** Runtime owner health; `nativeSocket` is the socket this Host can dial. */
  readonly health: ReturnType<typeof createCodexRuntimeHealthReader>;
  private readonly lifetime = new AbortController();
  private readEpoch = 0;
  private readonly connection: CodexCoreSocket;
  private readonly reads: CodexCoreReadIsolation;
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private callbackReady = false;
  private titleToolReady = false;
  private ownerIncarnation: string|null = null;
  private standaloneExecution: string | undefined;
  get executionIncarnation(): string | undefined { return this.connection.status.state === "open" ? this.standaloneExecution : undefined; }
  get callbackIncarnation(): string|null {return this.ownerIncarnation;}
  get supportsOrchestration(): boolean { return this.callbackReady; }
  get supportsThreadTitle(): boolean { return this.callbackReady && this.titleToolReady; }
  constructor(endpoint: string, token: string, callbackLaneId?: string, runtime?: CodexRuntimeEndpoints,
    private readonly rollback?: { identities: CodexRollbackHistory; methodFor(id: string | number): string | undefined }) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.health = createCodexRuntimeHealthReader(this.control, runtime);
    this.reads = new CodexCoreReadIsolation(signal => this.health(signal, "native"));
    this.connection = new CodexCoreSocket({
      callbackLaneId,
      health: async signal => {
        const health = await this.health(signal, "native");
        this.standaloneExecution = reportedCodexExecution(health);
        this.callbackReady = health.callbackProtocolVersion === 1 && !!callbackLaneId;
        this.titleToolReady = health.threadTitleToolVersion === 1;
        this.ownerIncarnation = health.callbackIncarnation ?? null;
        return health;
      },
      message: frame => this.publishMessage(frame),
      status: value => { for (const listener of this.statuses) listener(value); },
    });
  }
  get status(): TransportStatus { return this.connection.status; }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  connect(signal?: AbortSignal): Promise<void> { return this.connection.connect(signal); }
  resetConnection(): void { ++this.readEpoch; this.reads.reset(); this.connection.reset(); }
  private publishMessage(frame: string): void {
    if (this.rollback) {
      try {
        const message = JSON.parse(frame);
        const id = message.id;
        const projected = this.rollback.identities.publicResponse(message,
          typeof id === "string" || typeof id === "number" ? this.rollback.methodFor(id) : undefined);
        if (projected !== message) frame = JSON.stringify(projected);
      } catch {
        return;
      }
    }
    for (const listener of this.messages) listener(frame);
  }
  async send(frame: string): Promise<void> {
    if (this.lifetime.signal.aborted) throw new Error("Codex core connection is closed");
    const message = JSON.parse(frame);
    const outgoing = this.rollback?.identities.nativeRequest(message) ?? message;
    if (isIsolatedCoreRead(outgoing)) {
      const epoch = this.readEpoch;
      // A send acknowledges admission to the bounded reader, not its RPC result.
      // Waiting here would hold AppHost's ordered frame lane behind history.
      void this.reads.read(outgoing).then(reply => {
        if (this.lifetime.signal.aborted || epoch !== this.readEpoch) return;
        this.publishMessage(reply);
      });
    } else this.connection.send(outgoing === message ? frame : JSON.stringify(outgoing));
  }
  async close(): Promise<void> { ++this.readEpoch; this.lifetime.abort(); this.reads.close(); this.connection.close(); }
}
