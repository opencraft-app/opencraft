import { AppHostServer } from '@opencraft/app-host-server';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import type { DuplexTransport, TransportStatus } from '@opencraft/appserver-client/transport';
export const flushCleanup = async () => { for (let i = 0; i < 128; i++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
export type CleanupMode = 'success' | 'reject' | 'throw' | 'reject-released' | 'hold';
/** The provider's resource fact is independent of native/observed status. */
export class CleanupPhysical implements DuplexTransport {
  status: TransportStatus = { state: 'idle' };
  released = false;
  closeCalls = 0;
  connectCalls = 0;
  detachCalls = 0;
  mode: CleanupMode = 'success';
  failStart = false;
  holdStart = false;
  throwStatusSubscription = false;
  throwMessageDetach = false;
  throwStatusDetach = false;
  onClose?: () => void;
  readonly startGate = gate();
  readonly closeGate = gate();
  readonly statusCallbacks: ((status: TransportStatus) => void)[] = [];
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private readonly messages = new Set<(frame: string) => void>();
  publish(status: TransportStatus) { this.status = status; for (const listener of this.statuses) listener(status); }
  async connect() {
    this.connectCalls++; this.released = false;
    if (this.holdStart) await this.startGate.promise;
    this.publish({ state: 'open' });
    if (this.failStart) throw Error('synthetic startup failure after allocation');
  }
  async send(frame: string) {
    const request = JSON.parse(frame);
    if (request.id === undefined) return;
    const result = request.method === 'initialize'
      ? { codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'cleanup-fixture' }
      : request.method === 'echo' ? request.params : undefined;
    if (result !== undefined) queueMicrotask(() => {
      const reply = JSON.stringify({ id: request.id, result, [LOGICAL_CLIENT_FIELD]: request[LOGICAL_CLIENT_FIELD] });
      for (const listener of this.messages) listener(reply);
    });
  }
  subscribeMessage(listener: (frame: string) => void) {
    this.messages.add(listener);
    return () => { this.detachCalls++; this.messages.delete(listener); if (this.throwMessageDetach) throw Error('synthetic message detach failure'); };
  }
  subscribeStatus(listener: (status: TransportStatus) => void) {
    if (this.throwStatusSubscription) throw Error('synthetic subscription construction failure');
    this.statusCallbacks.push(listener); this.statuses.add(listener); listener(this.status);
    return () => { this.detachCalls++; this.statuses.delete(listener); if (this.throwStatusDetach) throw Error('synthetic status detach failure'); };
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.onClose?.();
    const release = () => { this.released = true; this.publish({ state: 'closed' }); };
    if (this.mode === 'throw') throw Error('synthetic synchronous close failure');
    if (this.mode === 'reject') return Promise.reject(Error('synthetic rejected close before release'));
    if (this.mode === 'reject-released') { release(); return Promise.reject(Error('synthetic rejected close after release')); }
    if (this.mode === 'hold') return this.closeGate.promise.then(release);
    release(); return Promise.resolve();
  }
}
export function hostCleanupFixture(options: { lifetime?: 'server' | 'last-claim'; onCreate?: (physical: CleanupPhysical, index: number) => void; Server?: typeof AppHostServer } = {}) {
  const physicals: CleanupPhysical[] = [];
  let closed = false;
  const toClient = new Set<(event: MessageEvent<unknown>) => void>(), toServer = new Set<(message: unknown) => void>();
  const server = new (options.Server ?? AppHostServer)({ physicalHostLifetime: options.lifetime ?? 'last-claim', createTransport() {
    const physical = new CleanupPhysical(); physicals.push(physical); options.onCreate?.(physical, physicals.length - 1); return physical;
  } });
  const connection = server.accept({ postMessage(message) { queueMicrotask(() => { if (!closed) for (const l of toClient) l({ data: message } as MessageEvent<unknown>); }); },
    subscribe(listener) { toServer.add(listener); return () => { toServer.delete(listener); }; }, start() {}, close() { closed = true; toClient.clear(); toServer.clear(); },
  }, 'cleanup-fixture');
  const bridge = new MessagePortAppHostClient({ postMessage(message) { queueMicrotask(() => { if (!closed) for (const l of toServer) l(message); }); },
    addEventListener(_type, listener) { toClient.add(listener); }, removeEventListener(_type, listener) { toClient.delete(listener); }, start() {}, close() { connection.close(); },
  }, 'cleanup-fixture');
  const channels: DuplexTransport[] = [];
  return { server, connection, bridge, physicals,
    channel(host = 'a') { const channel = bridge.createTransport(host); channels.push(channel); return channel; },
    async close() {
      // Close callers before explicit fixture recovery; queued work is not a heal.
      bridge.close(); connection.close();
      for (const p of physicals) { p.mode = 'success'; p.throwMessageDetach = p.throwStatusDetach = false; p.startGate.resolve(); p.closeGate.resolve(); }
      await Promise.all(channels.map(c => c.close()));
      await server.close().catch(() => {});
      // The unchanged old Server loses some failed handles. Dispose only the
      // declared fake resources, after every behavior assertion and snapshot.
      for (const p of physicals) if (!p.released) await p.close();
      await flushCleanup();
    },
  };
}
export function trackCleanup<T>(promise: Promise<T>) {
  const result = { state: 'pending', error: undefined as unknown, promise: Promise.resolve() };
  result.promise = promise.then(() => { result.state = 'resolved'; }, error => { result.state = 'rejected'; result.error = error; });
  return result;
}
export const cleanupClient = (transport: DuplexTransport) => new JsonRpcAppServerClient({ hostId: 'a', transport, requestTimeoutMs: 0 });
