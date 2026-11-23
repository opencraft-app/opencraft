import { CodexCoreReadIsolation, isIsolatedCoreRead } from "./codex-core-read-isolation";
import { CodexCoreSocket } from "./codex-core-socket";
import { observeStandaloneCodexExecution } from "./native-execution-origin";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

/** Where the runtime owner (Codex AppServer) is reached when it is not behind the
 * account Core: its control endpoint and token, and the native socket to dial. A
 * WorkspaceHost passes local endpoint listeners here; the in-environment paths in
 * the owner's health are never dialled. */
export interface CodexRuntimeEndpoints {
  readonly endpoint: string;
  /** A function when the credential belongs to the runtime owner's incarnation. */
  readonly token: string | (() => Promise<string>);
  readonly nativeSocket?: string;
}

/** A raw native connection: Host routing and overlays stay in CodexEngineAdapter.
 * Closing this connection never owns/stops the core or its CLI. No request retry. */
export class CodexNativeCoreTransport implements DuplexTransport {
  /** Account plane (accounts, subscriptions); also the runtime plane when no runtime is given. */
  readonly control: CodexCoreControlClient;
  private readonly runtimeEndpoints: CodexRuntimeEndpoints | undefined;
  private runtimeClient: { token: string; client: CodexCoreControlClient } | undefined;
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
  constructor(endpoint: string, token: string, callbackLaneId?: string, runtime?: CodexRuntimeEndpoints) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.runtimeEndpoints = runtime;
    this.reads = new CodexCoreReadIsolation(signal => this.health(signal, "native"));
    this.connection = new CodexCoreSocket({
      callbackLaneId,
      health: async signal => {
        const health = await this.health(signal, "native");
        this.standaloneExecution = undefined;
        if (process.platform === "linux") {
          this.standaloneExecution = (await observeStandaloneCodexExecution(health)).incarnation;
        }
        this.callbackReady = health.callbackProtocolVersion === 1 && !!callbackLaneId;
        this.titleToolReady = health.threadTitleToolVersion === 1;
        this.ownerIncarnation = health.callbackIncarnation ?? null;
        return health;
      },
      message: frame => { for (const listener of this.messages) listener(frame); },
      status: value => { for (const listener of this.statuses) listener(value); },
    });
  }
  /** Runtime owner health; `nativeSocket` is the socket this Host can dial. */
  async health(signal?: AbortSignal, observation: "execution" | "native" = "execution") {
    const runtime = this.runtimeEndpoints;
    if (!runtime) return this.control.health(signal, observation);
    const token = typeof runtime.token === "function" ? await runtime.token() : runtime.token;
    if (this.runtimeClient?.token !== token) this.runtimeClient = { token, client: new CodexCoreControlClient(runtime.endpoint, token) };
    const health = await this.runtimeClient.client.health(signal, observation);
    return runtime.nativeSocket ? { ...health, nativeSocket: runtime.nativeSocket } : health;
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
  async close(): Promise<void> { ++this.readEpoch; this.lifetime.abort(); this.reads.close(); this.connection.close(); }
}
