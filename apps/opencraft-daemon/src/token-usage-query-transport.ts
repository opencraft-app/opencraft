import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from "@opencraft/appserver-protocol";
import { TOKEN_USAGE_QUERY } from "@opencraft/appserver-protocol/token-usage";
import type { DuplexTransport, TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { TokenUsageQueryError } from "./token-usage-query.js";
import type { TokenUsageQueryService } from "./token-usage-query-service.js";
import { labelUsagePeople } from "./token-usage-people.js";

/** Deployment statistics are independent of the currently selected execution
 * engine. This overlay only reads the existing ledger; it never opens a writer,
 * starts collection or forwards a statistics request to the execution engine. */
export class TokenUsageQuerySession {
  private readonly clients = new Map<string, object>();
  private readonly initializing = new Map<string, { client: string; epoch: object }>();
  private closed = false;

  constructor(private readonly queries: Pick<TokenUsageQueryService, "read">,
    private readonly emitFrame: (frame: string) => void,
    private readonly person?: Parameters<typeof labelUsagePeople>[1]) {}
  project(frame: string): string {
    let message;
    try { message = JSON.parse(frame); } catch { return frame; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return frame;
    // A native /appserver socket has one untagged client; /apphost multiplexes.
    const client = message[LOGICAL_CLIENT_FIELD] ?? "";
    const key = JSON.stringify([client, message.id]);
    const pending = this.initializing.get(key);
    if (pending) {
      this.initializing.delete(key);
      if (!message.error && message.result && this.clients.get(pending.client) === pending.epoch) {
        // Retain the native initialization contract; only declare the query
        // provided by this read-only overlay, not collection or configure.
        const capabilities = message.result.capabilities ?? {};
        const extensions = capabilities.extensions ?? {};
        const access = extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION];
        message.result.capabilities = { ...capabilities, extensions: { ...extensions,
          "opencraft/token-usage": { version: 1, query: true, configure: false, policyVersion: "equal-turn-v1", timezone: "Asia/Shanghai" },
          ...(Array.isArray(access?.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, TOKEN_USAGE_QUERY])] } } : {}),
        } };
        frame = JSON.stringify(message);
      } else if (this.clients.get(pending.client) === pending.epoch) this.clients.delete(pending.client);
    }
    return frame;
  }
  async receive(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<boolean> {
    if (this.closed) throw new Error("Transport closed");
    let message;
    try { message = JSON.parse(frame); } catch { return false; }
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const client = message[LOGICAL_CLIENT_FIELD] ?? "";
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (typeof client === "string" && message.method === "runtime/client/disconnect") this.clients.delete(client);
    if (typeof client === "string" && hasId && message.method === "initialize") {
      const epoch = {};
      this.clients.set(client, epoch);
      this.initializing.set(JSON.stringify([client, message.id]), { client, epoch });
    }
    if (message.method !== TOKEN_USAGE_QUERY || !hasId) return false;
    const epoch = this.clients.get(client);
    const emit = (response: object) => {
      if (!this.closed && !signal?.aborted && (!epoch || this.clients.get(client) === epoch)) {
        const reply = JSON.stringify({ id: message.id, [LOGICAL_CLIENT_FIELD]: message[LOGICAL_CLIENT_FIELD], ...response });
        this.emitFrame(reply);
      }
    };
    if (!epoch || [...this.initializing.values()].some(pending => pending.client === client)) {
      emit({ error: { code: -32600, message: "Client is not initialized" } }); return true;
    }
    try {
      const snapshot = await this.queries.read(message.params, context.tokenUsageAuthority ?? (() => null));
      emit({ result: labelUsagePeople(snapshot, this.person) });
    } catch (error) {
      const kind = error instanceof TokenUsageQueryError ? error.code : "unavailable";
      emit({ error: { code: kind === "unauthorized" ? 401 : kind === "forbidden" ? 403 : kind === "stale-snapshot" ? 409 : kind === "invalid-query" ? -32602 : -32000, message: kind } });
    }
    return true;
  }
  reset() { this.clients.clear(); this.initializing.clear(); }
  close() { this.closed = true; this.reset(); }
}

export class TokenUsageQueryTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly session: TokenUsageQuerySession;
  private readonly release: () => void;
  constructor(private readonly inner: DuplexTransport, queries: Pick<TokenUsageQueryService, "read">,
    person?: Parameters<typeof labelUsagePeople>[1]) {
    this.session = new TokenUsageQuerySession(queries, frame => {
      for (const listener of this.listeners) listener(frame);
    }, person);
    this.release = inner.subscribeMessage(frame => {
      const projected = this.session.project(frame);
      for (const listener of this.listeners) listener(projected);
    });
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  subscribeStatus(listener: Parameters<DuplexTransport["subscribeStatus"]>[0]) {
    return this.inner.subscribeStatus(status => {
      if (status.state === "failed" || status.state === "closed") this.session.reset();
      listener(status);
    });
  }
  subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void> {
    if (await this.session.receive(frame, context, signal)) return;
    if (this.inner.sendWithContext) await this.inner.sendWithContext(frame, context, signal);
    else await this.inner.send(frame, signal);
  }
  async close() {
    this.session.close(); this.release(); this.listeners.clear();
    await this.inner.close();
  }
}
