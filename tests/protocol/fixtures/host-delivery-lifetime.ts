import { MessagePortAppHostClient } from '@opencraft/app-host-client';
import type { RendererToAppHostMessage } from '@opencraft/app-host-protocol';
import type { TransportStatus } from '@opencraft/appserver-client/transport';

export const flushHostLifetime = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

/** Only the declared MessagePort is controlled. ACKs describe forwarding,
 * never remote execution. No production fields or methods are replaced. */
export function hostLifetimeFixture(options: { maxPendingRequests?: number; holdConnect?: boolean;
  Client?: typeof MessagePortAppHostClient } = {}) {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined, generation = 0;
  const sent: RendererToAppHostMessage[] = [], held: RendererToAppHostMessage[] = [];
  const receive = (data: unknown) => listener?.({ data } as MessageEvent<unknown>);
  const acknowledge = (message: RendererToAppHostMessage, grantedGeneration?: number) => {
    if (!('requestId' in message)) throw Error('Only requests have acknowledgements');
    const result = message.type === 'host/connect'
      ? { hostId: message.hostId, generation: grantedGeneration ?? ++generation } : undefined;
    receive({ type: 'response', requestId: message.requestId, ok: true, result });
  };
  const client = new (options.Client ?? MessagePortAppHostClient)({
    postMessage(message) {
      sent.push(message);
      if (message.type === 'host/send' || (options.holdConnect && message.type === 'host/connect')) held.push(message);
      else if ('requestId' in message) queueMicrotask(() => acknowledge(message));
    },
    addEventListener(_type, next) { listener = next; },
    removeEventListener() { listener = undefined; }, start() {}, close() {},
  }, 'host-lifetime', { maxPendingRequests: options.maxPendingRequests ?? 256 });
  receive({ type: 'ready', protocolVersion: 2, services: ['appserver'] });
  return { client, sent, held, receive, acknowledge,
    claim(hostId: string) {
      const message = sent.filter(m => m.type === 'host/connect' && m.hostId === hostId).at(-1);
      if (!message || message.type !== 'host/connect') throw Error('No declared claim');
      return message;
    },
    status(hostId: string, generation: number, status: TransportStatus) {
      receive({ type: 'host/status', hostId, generation, status });
    },
    frame(hostId: string, generation: number, frame = 'pulse') {
      receive({ type: 'host/frame', hostId, generation, leaseId: this.claim(hostId).leaseId, frame });
    },
  };
}
