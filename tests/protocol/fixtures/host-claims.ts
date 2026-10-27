import { AppHostServer } from '@opencraft/app-host-server';
import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';
import type { AppHostToRendererMessage, RendererToAppHostMessage } from '@opencraft/app-host-protocol';
import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import { ForwardingPhysical, flushForwarding } from './host-forwarding';
export { flushForwarding as flushClaims, heldForwardingFrame } from './host-forwarding';
export const claimInitialize = { clientInfo: { name: 'claim-reclamation', version: '1' } };
export interface ClaimChannel { readonly transport: DuplexTransport; readonly client: JsonRpcAppServerClient }
export interface ClaimRenderer {
  readonly bridge: MessagePortAppHostClient;
  readonly connection: ReturnType<AppHostServer['accept']>;
  readonly wire: RendererToAppHostMessage[];
  readonly channels: ClaimChannel[];
  readonly heldReplies: AppHostToRendererMessage[];
  readonly withheld: Set<string>;
  readonly throwOnPost: Set<string>;
  channel(hostId?: string): ClaimChannel;
  releaseReplies(): void;
  close(): void;
}

/** Actual Server, bridge, channel and RPC Client. Only the declared Port and
 * physical boundaries can withhold delivery; no internal ledger is inspected. */
export function hostClaimFixture(options: { lifetime?: 'server' | 'last-claim'; logical?: boolean; maxPending?: number;
  Server?: typeof AppHostServer; Client?: typeof MessagePortAppHostClient } = {}) {
  const physicals: ForwardingPhysical[] = [];
  const renderers: ClaimRenderer[] = [];
  const server = new (options.Server ?? AppHostServer)({ physicalHostLifetime: options.lifetime ?? 'last-claim',
    logicalClientRouting: options.logical ?? true,
    createTransport() { const physical = new ForwardingPhysical(false); physicals.push(physical); return physical; } });
  let sequence = 0;
  function renderer(): ClaimRenderer {
    const id = `claims-renderer-${++sequence}`, wire: RendererToAppHostMessage[] = [];
    const heldReplies: AppHostToRendererMessage[] = [], withheld = new Set<string>(), throwOnPost = new Set<string>();
    const toClient = new Set<(event: MessageEvent<unknown>) => void>();
    const toServer = new Set<(message: unknown) => void>();
    let closed = false;
    const deliver = (message: AppHostToRendererMessage) => queueMicrotask(() => {
      if (!closed) for (const listener of toClient) listener({ data: message } as MessageEvent<unknown>);
    });
    const connection = server.accept({
      postMessage(message) {
        const intent = message.type === 'response' ? wire.find(m => 'requestId' in m && m.requestId === message.requestId) : undefined;
        if (intent && withheld.has(intent.type)) heldReplies.push(message); else deliver(message);
      },
      subscribe(listener) { toServer.add(listener); return () => { toServer.delete(listener); }; },
      start() {}, close() { closed = true; toClient.clear(); toServer.clear(); },
    }, id);
    const bridge = new (options.Client ?? MessagePortAppHostClient)({
      postMessage(message) { wire.push(message);
        if (throwOnPost.has(message.type)) throw Error('synthetic Port write failure');
        queueMicrotask(() => {
        if (!closed) for (const listener of toServer) listener(message);
      }); },
      addEventListener(_type, listener) { toClient.add(listener); },
      removeEventListener(_type, listener) { toClient.delete(listener); },
      start() {}, close() { connection.close(); },
    }, id, { maxPendingRequests: options.maxPending, controlTimeoutMs: 30_000 });
    const channels: ClaimChannel[] = [];
    function channel(hostId = 'a'): ClaimChannel {
      const transport = bridge.createTransport(hostId);
      const client = new JsonRpcAppServerClient({ hostId, transport, requestTimeoutMs: 0 });
      const item = { transport, client }; channels.push(item); return item;
    }
    const current: ClaimRenderer = { bridge, connection, wire, channel, channels, heldReplies, withheld, throwOnPost,
      releaseReplies() { for (const message of heldReplies.splice(0)) deliver(message); },
      close() { bridge.close(); connection.close(); },
    };
    renderers.push(current); return current;
  }
  return { server, physicals, renderer,
    get physical() { const value = physicals.at(-1); if (!value) throw Error('No physical Host'); return value; },
    async close() {
      for (const renderer of renderers) renderer.close();
      for (const physical of physicals) physical.releaseAll();
      await Promise.all(renderers.flatMap(r => r.channels.map(c => c.client.close())));
      await server.close(); await flushForwarding();
    },
  };
}
