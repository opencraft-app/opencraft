import { AppHostServer } from '@opencraft/app-host-server';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import { LOGICAL_CLIENT_FIELD, type RendererToAppHostMessage } from '@opencraft/app-host-protocol';
import type { DuplexTransport, TransportStatus, TransportSubmissionContext } from '@opencraft/appserver-client/transport';

export const flushForwarding = async () => { for (let i = 0; i < 96; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
export const heldForwardingFrame = (tag: string) => JSON.stringify({ method: 'hold', params: { tag } });
export interface ForwardingRenderer {
  readonly bridge: MessagePortAppHostClient;
  readonly client: JsonRpcAppServerClient;
  readonly transport: DuplexTransport;
  readonly connection: ReturnType<AppHostServer['accept']>;
  readonly wire: RendererToAppHostMessage[];
  close(): Promise<void>;
}

/** Declared native boundary. A held operation has already crossed this boundary;
 * it deliberately need not cooperate with cancellation of its local waiter. */
export class ForwardingPhysical implements DuplexTransport {
  private current: TransportStatus = { state: 'idle' };
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  readonly held: { tag: string; gate: ReturnType<typeof deferred>; signal?: AbortSignal }[] = [];
  readonly entries: { method: string; tag?: string; signal?: AbortSignal; context?: TransportSubmissionContext }[] = [];
  readonly closeGate = deferred();
  closeCalls = 0;
  holdClose = false;
  readonly sendWithContext?: (frame: string, context: TransportSubmissionContext, signal?: AbortSignal) => Promise<void>;
  constructor(contextual: boolean) {
    if (contextual) this.sendWithContext = (frame, context, signal) => { this.checkThrow(frame); return this.forward(frame, signal, context); };
  }
  get status(): TransportStatus { return this.current; }
  async connect(): Promise<void> { this.publish({ state: 'open' }); }
  send(frame: string, signal?: AbortSignal): Promise<void> { this.checkThrow(frame); return this.forward(frame, signal); }
  private checkThrow(frame: string): void { if (JSON.parse(frame).method === 'sync-throw') throw Error('synthetic synchronous forwarding failure'); }
  private async forward(frame: string, signal?: AbortSignal, context?: TransportSubmissionContext): Promise<void> {
    const request = JSON.parse(frame);
    this.entries.push({ method: request.method, tag: request.params?.tag, signal, context });
    if (request.method === 'hold' || request.method === 'cycle') {
      const gate = deferred(); this.held.push({ tag: request.params.tag, gate, signal });
      if (request.method === 'cycle') { this.publish({ state: 'closed' }); this.publish({ state: 'open' }); }
      await gate.promise; return;
    }
    if (request.id === undefined) return;
    const result = request.method === 'initialize'
      ? { codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'forwarding-fixture' }
      : request.method === 'echo' ? request.params : undefined;
    if (result !== undefined) queueMicrotask(() => {
      const reply = JSON.stringify({ id: request.id, result, [LOGICAL_CLIENT_FIELD]: request[LOGICAL_CLIENT_FIELD] });
      for (const listener of this.messages) listener(reply);
    });
  }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener); listener(this.current); return () => { this.statuses.delete(listener); };
  }
  publish(status: TransportStatus): void { this.current = status; for (const listener of this.statuses) listener(status); }
  async close(): Promise<void> {
    this.closeCalls++; this.publish({ state: 'closing' }); if (this.holdClose) await this.closeGate.promise;
    this.publish({ state: 'closed' });
  }
  settle(tag: string, failure = false): void {
    const entry = this.held.find(item => item.tag === tag);
    if (!entry) throw Error(`No declared forwarding ${tag}`);
    if (failure) entry.gate.reject(Error('synthetic retired forwarding failure')); else entry.gate.resolve();
  }
  releaseAll(): void { this.closeGate.resolve(); for (const entry of this.held) entry.gate.resolve(); }
}

/** Actual Server and Clients. Only declared Port delivery and physical adapter
 * are controlled; no private fields, prototype hooks or class replacements. */
export function hostForwardingFixture(options: { contextual?: boolean; Server?: typeof AppHostServer } = {}) {
  const physicals: ForwardingPhysical[] = [], renderers: ForwardingRenderer[] = [];
  const server = new (options.Server ?? AppHostServer)({ physicalHostLifetime: 'server', logicalClientRouting: true,
    createTransport() { const physical = new ForwardingPhysical(options.contextual ?? false); physicals.push(physical); return physical; } });
  let sequence = 0;
  function renderer(hostId = 'a'): ForwardingRenderer {
    const id = `forwarding-renderer-${++sequence}`, wire: RendererToAppHostMessage[] = [];
    const toClient = new Set<(event: MessageEvent<unknown>) => void>(), toServer = new Set<(message: unknown) => void>();
    let closed = false;
    const connection = server.accept({
      postMessage(message) { queueMicrotask(() => { if (!closed) for (const listener of toClient) listener({ data: message } as MessageEvent<unknown>); }); },
      subscribe(listener) { toServer.add(listener); return () => { toServer.delete(listener); }; },
      start() {}, close() { closed = true; toClient.clear(); toServer.clear(); },
    }, id);
    const bridge = new MessagePortAppHostClient({
      postMessage(message) { wire.push(message); queueMicrotask(() => { if (!closed) for (const listener of toServer) listener(message); }); },
      addEventListener(_type, listener) { toClient.add(listener); }, removeEventListener(_type, listener) { toClient.delete(listener); },
      start() {}, close() { connection.close(); },
    }, id);
    const transport = bridge.createTransport(hostId), client = new JsonRpcAppServerClient({ hostId, transport, requestTimeoutMs: 0 });
    const result = { bridge, client, transport, connection, wire, async close() { bridge.close(); connection.close(); await client.close(); } };
    renderers.push(result); return result;
  }
  return { server, physicals, renderer,
    get physical() { const physical = physicals.at(-1); if (!physical) throw Error('No native Host'); return physical; },
    async close() {
      // Retire callers before releasing synthetic dependencies: teardown must
      // not admit an otherwise queued mutation as implicit progress or healing.
      for (const current of renderers) await current.close();
      for (const physical of physicals) physical.releaseAll();
      await server.close(); await flushForwarding();
    },
  };
}
