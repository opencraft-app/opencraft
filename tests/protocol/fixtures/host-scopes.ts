import { AppHostServer } from '@opencraft/app-host-server';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import type { AppHostToRendererMessage, RendererToAppHostMessage } from '@opencraft/app-host-protocol';
import { NotificationPhysical, flushCleanup } from './host-notifications';

/** Independent provider state: a logical disconnect revokes only that native client. */
export class ScopePhysical extends NotificationPhysical {
  readonly initializedClients = new Set<string>();
  constructor(readonly hostId: string) { super(); }
  override send(frame: string, signal?: AbortSignal): Promise<void> {
    const request = JSON.parse(frame), key = String(request.__opencraftClient);
    if (request.method === 'initialize') this.initializedClients.add(key);
    if (request.method === 'echo' && !this.initializedClients.has(key)) return Promise.reject(Error('synthetic native client was not initialized or was retired'));
    return super.send(frame, signal).then(() => {
      if (request.method === 'runtime/client/disconnect') this.initializedClients.delete(key);
    });
  }
  override close(): Promise<void> {
    return super.close().then(() => { this.initializedClients.clear(); });
  }
}

export function hostScopeFixture(options: { Server?: typeof AppHostServer; lifetime?: 'server' | 'last-claim'; routing?: boolean } = {}) {
  const physicals = new Map<string, ScopePhysical[]>(), clocks = new Map<object, () => void>();
  const server = new (options.Server ?? AppHostServer)({ logicalClientRouting: options.routing ?? true,
    physicalHostLifetime: options.lifetime ?? 'server', lifecycleTimeoutMs: 20,
    lifecycleClock: { setTimeout(callback) { const id = {}; clocks.set(id, callback); return id; }, clearTimeout(id) { clocks.delete(id as object); } },
    createTransport(hostId) { const physical = new ScopePhysical(hostId); const group = physicals.get(hostId) ?? []; group.push(physical); physicals.set(hostId, group); return physical; },
  });
  let pageSequence = 0, rpcSequence = 0;
  const pages: { bridge: MessagePortAppHostClient; connection: ReturnType<AppHostServer['accept']> }[] = [];
  function page() {
    const id = `scope-page-${++pageSequence}`, wire: RendererToAppHostMessage[] = [], replies: AppHostToRendererMessage[] = [];
    const toClient = new Set<(event: MessageEvent<unknown>) => void>(), toServer = new Set<(message: unknown) => void>();
    let closed = false;
    const connection = server.accept({ postMessage(message) { replies.push(message); queueMicrotask(() => { if (!closed) for (const l of toClient) l({ data: message } as MessageEvent<unknown>); }); },
      subscribe(listener) { toServer.add(listener); return () => { toServer.delete(listener); }; }, start() {},
      close() { closed = true; toClient.clear(); toServer.clear(); },
    }, id);
    const bridge = new MessagePortAppHostClient({ postMessage(message) { wire.push(message); queueMicrotask(() => { if (!closed) for (const l of toServer) l(message); }); },
      addEventListener(_type, listener) { toClient.add(listener); }, removeEventListener(_type, listener) { toClient.delete(listener); }, start() {}, close() { connection.close(); },
    }, id);
    pages.push({ bridge, connection });
    async function rpc(hostId: string, leaseId: string, generation: number, method: 'initialize' | 'echo', params: unknown = {}) {
      const requestId = `scope-rpc-${++rpcSequence}`;
      let result: { id: string; result?: unknown; error?: unknown } | undefined;
      const remove = bridge.subscribeHost(hostId, event => {
        if (event.generation !== generation || event.frame === undefined || (event.leaseId !== undefined && event.leaseId !== leaseId)) return;
        const frame = JSON.parse(event.frame); if (frame.id === requestId) result = frame;
      });
      try { await bridge.sendHostFrame(hostId, leaseId, generation, JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })); await flushCleanup(); return result; }
      finally { remove(); }
    }
    return { bridge, connection, rpc, wire, replies };
  }
  return { server, physicals, page, current(hostId: string) { const list = physicals.get(hostId); if (!list?.length) throw Error('Host has not allocated a provider'); return list[list.length - 1]!; },
    async deadline() { for (const [id, callback] of [...clocks]) if (clocks.delete(id)) callback(); await flushCleanup(); },
    async close() {
      // Explicit fixture repair follows every behavior assertion/snapshot.
      for (const group of physicals.values()) for (const p of group) { p.notifyMode = 'success'; p.onNotify = undefined; p.releaseNotifications(); p.mode = 'success'; p.closeGate.resolve(); }
      await flushCleanup(); for (const p of pages) { p.bridge.close(); p.connection.close(); }
      await server.close(); await flushCleanup();
    },
  };
}
