import { AppHostServer } from '@opencraft/app-host-server';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import type { AppHostToRendererMessage, RendererToAppHostMessage } from '@opencraft/app-host-protocol';
import { CleanupPhysical, flushCleanup, trackCleanup } from './host-cleanup';
export { flushCleanup, trackCleanup };
interface NotificationChannel { transport: DuplexTransport; client: JsonRpcAppServerClient; open(): ReturnType<JsonRpcAppServerClient['connect']> }
interface NotificationPage { bridge: MessagePortAppHostClient; connection: ReturnType<AppHostServer['accept']>; channel(): NotificationChannel; channels: NotificationChannel[]; wire: RendererToAppHostMessage[]; replies: AppHostToRendererMessage[] }
const gate = () => {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
export class NotificationPhysical extends CleanupPhysical {
  notifyMode: 'success' | 'reject' | 'throw' | 'hold' = 'success';
  onNotify?: () => void;
  readonly notifications: { key: string; signal?: AbortSignal; gate: ReturnType<typeof gate> }[] = [];
  override send(frame: string, signal?: AbortSignal): Promise<void> {
    const input = JSON.parse(frame);
    if (input.method !== 'runtime/client/disconnect') return super.send(frame);
    const item = { key: String(input.__opencraftClient), signal, gate: gate() };
    this.notifications.push(item); this.onNotify?.();
    if (this.notifyMode === 'throw') throw Error('synthetic synchronous notification failure');
    if (this.notifyMode === 'reject') return Promise.reject(Error('synthetic rejected notification'));
    if (this.notifyMode === 'hold') return item.gate.promise; // Deliberately ignores abort.
    return Promise.resolve();
  }
  releaseNotifications() { for (const n of this.notifications) n.gate.resolve(); }
}
export function notificationFixture(options: {
  lifetime?: 'server' | 'last-claim'; Server?: typeof AppHostServer;
  onCreate?: (physical: NotificationPhysical, index: number) => void;
} = {}) {
  const physicals: NotificationPhysical[] = [], clocks = new Map<object, () => void>();
  const server = new (options.Server ?? AppHostServer)({ logicalClientRouting: true,
    physicalHostLifetime: options.lifetime ?? 'last-claim', lifecycleTimeoutMs: 20,
    lifecycleClock: { setTimeout(callback) { const id = {}; clocks.set(id, callback); return id; }, clearTimeout(id) { clocks.delete(id as object); } },
    createTransport() { const p = new NotificationPhysical(); physicals.push(p); options.onCreate?.(p, physicals.length - 1); return p; },
  });
  let pageSequence = 0;
  const pages: NotificationPage[] = [];
  function page(): NotificationPage {
    const id = `notification-page-${++pageSequence}`;
    const wire: RendererToAppHostMessage[] = [], replies: AppHostToRendererMessage[] = [];
    const toClient = new Set<(event: MessageEvent<unknown>) => void>(), toServer = new Set<(message: unknown) => void>();
    let closed = false;
    const connection = server.accept({
      postMessage(message) { replies.push(message); queueMicrotask(() => { if (!closed) for (const l of toClient) l({ data: message } as MessageEvent<unknown>); }); },
      subscribe(l) { toServer.add(l); return () => { toServer.delete(l); }; }, start() {},
      close() { closed = true; toClient.clear(); toServer.clear(); },
    }, id);
    const bridge = new MessagePortAppHostClient({
      postMessage(message) { wire.push(message); queueMicrotask(() => { if (!closed) for (const l of toServer) l(message); }); },
      addEventListener(_type, l) { toClient.add(l); }, removeEventListener(_type, l) { toClient.delete(l); }, start() {}, close() { connection.close(); },
    }, id);
    const channels: NotificationChannel[] = [];
    function channel(): NotificationChannel {
      const transport = bridge.createTransport('a');
      const client = new JsonRpcAppServerClient({ hostId: 'a', transport, requestTimeoutMs: 0 });
      const c = { transport, client, open: () => client.connect({ clientInfo: { name: 'notification-fixture', version: '1' } }) }; channels.push(c); return c;
    }
    const result = { bridge, connection, channel, channels, wire, replies }; pages.push(result); return result;
  }
  return { server, page, physicals, clocks,
    async deadline() { for (const [id, callback] of [...clocks]) { if (clocks.delete(id)) callback(); } await flushCleanup(); },
    async close() {
      // Assertions precede these explicit provider repairs and gate releases.
      for (const p of physicals) { p.notifyMode = 'success'; p.onNotify = undefined; p.releaseNotifications(); p.mode = 'success'; p.closeGate.resolve(); }
      await flushCleanup();
      for (const p of pages) { p.bridge.close(); p.connection.close(); }
      for (const p of physicals) p.releaseNotifications();
      await Promise.all(pages.flatMap(p => p.channels.map(c => c.client.close())));
      await server.close(); await flushCleanup();
    },
  };
}
