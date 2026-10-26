import type { DuplexTransport } from '@opencraft/appserver-client/transport';
import type { MessagePortAppHostClient } from '@opencraft/app-host-client';
import { hostLifetimeFixture, flushHostLifetime } from './host-delivery-lifetime';
import { ChaosViolation, requireThat } from './recovery-chaos';

export const hostDeliveryActions = ['send', 'lose', 'reconnect', 'ack-old', 'peer', 'close',
  'bridge', 'frame-race', 'status-reentry', 'heal'] as const;
export type HostDeliveryEvent = { type: 'open' | typeof hostDeliveryActions[number] };
export type HostDeliveryMutant = 'observed-ready' | 'stale-send' | 'retained-wait';

export function parseHostDeliveryTrace(value: unknown): HostDeliveryEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 events');
  for (const event of value) requireThat(typeof event === 'object' && event !== null
    && ['open', ...hostDeliveryActions].includes((event as HostDeliveryEvent).type), 'TRACE_SCHEMA', 'invalid Host lifetime event');
  return value as HostDeliveryEvent[];
}

export function generateHostDeliveryChaos(seed: number, steps: number): HostDeliveryEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state >>> 8; };
  return [{ type: 'open' }, ...Array.from({ length: steps }, () => ({ type: hostDeliveryActions[next() % hostDeliveryActions.length]! })), { type: 'heal' }];
}

/** Oracle state changes only from saved input and declared ACK choices. The
 * fixture controls the Port, never the production channel implementation. */
export async function simulateHostDelivery(events: readonly HostDeliveryEvent[],
  options: { mutant?: HostDeliveryMutant; Client?: typeof MessagePortAppHostClient } = {}) {
  type Wait = { host: string; expected: 'pending' | 'resolved' | 'rejected'; actual: string;
    request: ReturnType<typeof hostLifetimeFixture>['held'][number] | undefined; acknowledged: boolean; done: Promise<void> };
  type Owner = { channel: DuplexTransport; generation: number; active: boolean; closed: boolean };
  let f: ReturnType<typeof hostLifetimeFixture> | undefined, a: Owner | undefined, peer: Owner | undefined;
  let bridged = false, generation = 0, reentry = false, renewal: Promise<void> | undefined, inside = '';
  const readRenewal = (): Promise<void> | undefined => renewal;
  let waits: Wait[] = [];
  const coverage: Record<string, number> = {};
  const metrics = { events: events.length, connectIntents: 0, connectSettled: 0, sendIntents: 0,
    sendSettled: 0, nativeAdmissions: 0, nativeEvents: 0, heals: 0, coverage };
  const hit = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const retire = (host?: string) => {
    for (const wait of waits) if ((!host || wait.host === host) && wait.expected === 'pending') wait.expected = 'rejected';
  };
  const checkWaits = async () => {
    await flushHostLifetime();
    for (const wait of waits) {
      const actual = options.mutant === 'retained-wait' && wait.expected === 'rejected' && wait.request
        && !wait.acknowledged ? 'pending' : wait.actual;
      requireThat(actual === wait.expected, 'HOST_WAIT_RETIREMENT', `expected ${wait.expected}, observed ${actual}`);
    }
  };
  const cleanup = async () => {
    if (!f) return;
    f.client.close(); await a?.channel.close(); await peer?.channel.close();
    await Promise.all(waits.map(w => w.done));
    f = undefined; a = peer = undefined;
  };
  const connect = async (host: string, current?: Owner) => {
    if (!f || bridged) return current;
    // A native control budget occupied by a live forwarding wait legitimately
    // rejects another control. Recovery checks require an input-retired wait.
    if (waits.some(w => w.expected === 'pending')) return current;
    const owner = current && !current.closed ? current : { channel: f.client.createTransport(host), generation: 0, active: false, closed: false };
    metrics.connectIntents++;
    const operation = owner.channel.connect(); void operation.catch(() => {});
    await flushHostLifetime();
    if (!owner.active) { owner.generation = ++generation; f.acknowledge(f.claim(host), owner.generation); }
    let outcome = 'pending'; void operation.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushHostLifetime();
    requireThat(outcome === 'resolved' && owner.channel.status.state === 'open', 'HOST_CONNECT_SETTLEMENT', 'current own ACK did not settle open');
    owner.active = true; metrics.connectSettled++; return owner;
  };
  const open = async () => {
    await cleanup(); waits = []; generation = 0; bridged = false; reentry = false; renewal = undefined;
    f = hostLifetimeFixture({ holdConnect: true, maxPendingRequests: 1, Client: options.Client });
    f.client.subscribeHost('a', event => {
      if (!reentry || event.status?.state !== 'closed') return;
      reentry = false; inside = a!.channel.status.state;
      renewal = a!.channel.connect(); void renewal.catch(() => {});
    });
    a = await connect('a');
  };
  const send = async (host: string, owner: Owner) => {
    const admitted = !bridged && owner.active && !waits.some(w => w.expected === 'pending');
    const before = f!.sent.filter(m => m.type === 'host/send').length;
    const wait: Wait = { host, expected: admitted ? 'pending' : 'rejected', actual: 'pending', request: undefined,
      acknowledged: false, done: Promise.resolve() };
    metrics.sendIntents++;
    wait.done = owner.channel.send(`intent-${metrics.sendIntents}`).then(() => { wait.actual = 'resolved'; metrics.sendSettled++; },
      () => { wait.actual = 'rejected'; metrics.sendSettled++; });
    const after = f!.sent.filter(m => m.type === 'host/send').length;
    requireThat(after - before === Number(admitted), 'HOST_SEND_ADMISSION', 'send crossed a retired or ungranted boundary');
    if (admitted) { wait.request = f!.held.at(-1); metrics.nativeAdmissions++; }
    waits.push(wait); await checkWaits();
  };
  let failure: unknown;
  try {
    for (const event of events) {
      hit(event.type);
      if (event.type === 'open' || event.type === 'heal') {
        await open();
        if (event.type === 'heal') {
          // A heal proves a fresh own claim and locally completed forwarding.
          // It makes no statement about remote execution or initialization.
          await send('a', a!); const wait = waits.at(-1)!;
          wait.expected = 'resolved'; wait.acknowledged = true; f!.acknowledge(wait.request!);
          await checkWaits(); metrics.heals++;
        }
        continue;
      }
      if (!f || !a) continue;
      if (event.type === 'send') await send('a', a);
      else if (event.type === 'ack-old') {
        const wait = waits.find(w => w.request && !w.acknowledged);
        if (wait) { wait.acknowledged = true; if (wait.expected === 'pending') wait.expected = 'resolved'; f.acknowledge(wait.request!); }
      } else if (event.type === 'reconnect') a = await connect('a', a);
      else if (event.type === 'peer') peer = await connect('b', peer);
      else if (event.type === 'bridge') {
        bridged = true; a.active = false; if (peer) peer.active = false; retire(); f.client.close();
      } else if (event.type === 'close') {
        if (!a.closed) { a.closed = true; a.active = false; retire('a'); await a.channel.close(); }
      } else if (!bridged && !a.closed && a.active) {
        if (event.type === 'lose') { a.active = false; retire('a'); f.status('a', a.generation, { state: 'closed' }); metrics.nativeEvents++; }
        else if (event.type === 'status-reentry' && !waits.some(w => w.expected === 'pending')) {
          reentry = true; renewal = undefined; a.active = false; retire('a');
          f.status('a', a.generation, { state: 'closed' }); metrics.nativeEvents++;
          const observed = options.mutant === 'observed-ready' ? 'open' : inside;
          requireThat(observed === 'closed', 'HOST_NATIVE_READINESS', `closed callback observed ${observed}`);
          const connecting = readRenewal();
          requireThat(connecting, 'HOST_CONNECT_SETTLEMENT', 'status callback lost reconnect intent');
          await flushHostLifetime(); a.generation = ++generation; f.acknowledge(f.claim('a'), a.generation);
          let outcome = 'pending'; void connecting.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
          await flushHostLifetime(); requireThat(outcome === 'resolved' && a.channel.status.state === 'open', 'HOST_CONNECT_SETTLEMENT', 'status reconnect falsely completed');
          a.active = true; metrics.connectIntents++; metrics.connectSettled++;
        } else if (event.type === 'frame-race') {
          let crossed = -1, outcome = 'pending';
          const remove = a.channel.subscribeMessage(() => {
            a!.active = false; retire('a'); f!.status('a', a!.generation, { state: 'closed' }); metrics.nativeEvents++;
            const before = f!.sent.filter(m => m.type === 'host/send').length;
            void a!.channel.send('frame-race').then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
            crossed = f!.sent.filter(m => m.type === 'host/send').length - before;
          });
          try { f.frame('a', a.generation); } finally { remove(); }
          await flushHostLifetime();
          requireThat(crossed === 0 && outcome === 'rejected' && options.mutant !== 'stale-send', 'HOST_SEND_ADMISSION', 'frame retirement admitted a send');
        }
      }
      await checkWaits();
      if (peer?.active) requireThat(peer.channel.status.state === 'open', 'HOST_PEER_ISOLATION', 'unrelated Host retired');
    }
  } catch (error) { failure = error; }
  try { await cleanup(); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (failure instanceof ChaosViolation) failure.cleanupFailure = detail;
    else if (!failure) failure = new ChaosViolation('HOST_CLEANUP', detail);
  }
  if (failure) throw failure;
  return metrics;
}
