import type { AppHostServer } from '@opencraft/app-host-server';
import { hostForwardingFixture, heldForwardingFrame, flushForwarding } from './host-forwarding';
import { ChaosViolation, requireThat } from './recovery-chaos';

export const forwardingLosses = ['idle', 'connecting', 'closing', 'closed', 'failed'] as const;
export type ForwardingEvent = { type: 'open'; contextual: boolean }
  | { type: 'lose'; state: typeof forwardingLosses[number] }
  | { type: 'settle' | 'old-result'; failure: boolean }
  | { type: 'hold' | 'cycle' | 'renew' | 'sample-open' | 'reset' | 'release-close' | 'fresh-page' | 'heal' };
export type ForwardingMutant = 'orphan-connect' | 'queued-replay' | 'retarget-old';

export function parseForwardingTrace(value: unknown): ForwardingEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 events');
  for (const event of value) {
    requireThat(typeof event === 'object' && event !== null, 'TRACE_SCHEMA', 'invalid forwarding event');
    const e = event as Record<string, unknown>;
    requireThat(['open', 'lose', 'settle', 'old-result', 'hold', 'cycle', 'renew', 'sample-open', 'reset', 'release-close', 'fresh-page', 'heal'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid forwarding discriminant');
    if (e.type === 'open') requireThat(typeof e.contextual === 'boolean', 'TRACE_SCHEMA', 'invalid contextual choice');
    if (e.type === 'lose') requireThat(forwardingLosses.includes(e.state as typeof forwardingLosses[number]), 'TRACE_SCHEMA', 'invalid loss state');
    if (e.type === 'settle' || e.type === 'old-result') requireThat(typeof e.failure === 'boolean', 'TRACE_SCHEMA', 'invalid native outcome');
  }
  return value as ForwardingEvent[];
}

export function generateForwardingChaos(seed: number, steps: number): ForwardingEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state >>> 8; };
  const events: ForwardingEvent[] = [{ type: 'open', contextual: !!(next() % 2) }];
  for (let i = 0; i < steps; i++) {
    const choice = next() % 18;
    if (choice < 4) events.push({ type: 'hold' });
    else if (choice < 6) events.push({ type: 'lose', state: forwardingLosses[next() % forwardingLosses.length]! });
    else if (choice < 8) events.push({ type: 'renew' });
    else if (choice < 10) events.push({ type: 'settle', failure: !!(next() % 2) });
    else if (choice === 10) events.push({ type: 'old-result', failure: !!(next() % 2) });
    else if (choice === 17) events.push({ type: 'open', contextual: !!(next() % 2) });
    else events.push({ type: (['sample-open', 'reset', 'release-close', 'fresh-page', 'cycle', 'heal'] as const)[choice - 11]! });
  }
  events.push({ type: 'heal' }); return events;
}

/** Native admissions, local waits, FIFO and connection generations are predicted
 * from saved input, not from whether production callbacks happen to execute. */
export async function simulateHostForwarding(events: readonly ForwardingEvent[], options: { mutant?: ForwardingMutant; Server?: typeof AppHostServer } = {}) {
  type Wait = { tag: string; expected: 'pending' | 'resolved' | 'rejected'; actual: string;
    admitted: boolean; nativeDone: boolean; retired: boolean; promise: Promise<void> };
  let f: ReturnType<typeof hostForwardingFixture> | undefined, page: ReturnType<ReturnType<typeof hostForwardingFixture>['renderer']> | undefined;
  let connected = false, generation = 0, barrier = false, needsFactory = false, expectedFactories = 0;
  let resetPhysical: ReturnType<typeof hostForwardingFixture>['physical'] | undefined;
  let resetting: Promise<void> | undefined, pendingConnect: Promise<unknown> | undefined, pendingOutcome = 'pending';
  let waits: Wait[] = [], queue: Wait[] = [], admitted = new Set<string>(), retiredQueued = false, corruptWait: Wait | undefined;
  const coverage: Record<string, number> = {};
  const metrics = { events: events.length, connectIntents: 0, connectSettled: 0, sendIntents: 0, sendSettled: 0,
    nativeAdmissions: 0, nativeEvents: 0, rpcIntents: 0, rpcFrames: 0, heals: 0, coverage };
  const params = { clientInfo: { name: 'forwarding-chaos', version: '1' } };
  const hit = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const finish = (wait: Wait, outcome: 'resolved' | 'rejected') => {
    if (wait.expected === 'pending') { wait.expected = outcome; metrics.sendSettled++; }
  };
  const admitHead = () => {
    const head = queue[0];
    if (head && !head.admitted) { head.admitted = true; admitted.add(head.tag); metrics.nativeAdmissions++; }
  };
  const retire = () => {
    retiredQueued ||= queue.some(w => !w.admitted);
    for (const wait of queue) { wait.retired = true; finish(wait, 'rejected'); }
    queue = []; connected = false;
  };
  const check = async () => {
    await flushForwarding(); if (!f) return;
    const actual = f.physicals.flatMap(p => p.held.map(w => w.tag));
    if (options.mutant === 'queued-replay' && retiredQueued) actual.push('tool-observation-retired-queue');
    requireThat(JSON.stringify([...actual].sort()) === JSON.stringify([...admitted].sort()), 'FORWARD_ADMISSION', `expected native tags ${[...admitted]}, observed ${actual}`);
    for (const wait of waits) {
      const observed = options.mutant === 'retarget-old' && wait === corruptWait ? 'rejected' : wait.actual;
      requireThat(observed === wait.expected, 'FORWARD_WAIT_OWNERSHIP', `${wait.tag}: expected ${wait.expected}, observed ${observed}`);
    }
    requireThat(f.physicals.length === expectedFactories, 'FORWARD_PHYSICAL_BARRIER', 'physical generation crossed a held close barrier');
  };
  const echo = async (client = page!.client) => {
    const token = ++metrics.rpcIntents; let outcome = 'pending', value: unknown;
    const operation = client.requestRaw('echo', { token }).then(result => { outcome = 'resolved'; value = result; }, () => { outcome = 'rejected'; });
    await flushForwarding();
    requireThat(outcome === 'resolved' && JSON.stringify(value) === JSON.stringify({ token }), 'FORWARD_RPC_PROGRESS', 'current initialized Client did not deliver its own echo');
    await operation; metrics.rpcFrames++;
  };
  const checkConnected = async (operation: Promise<unknown>, renewed: boolean) => {
    let outcome = 'pending'; void operation.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushForwarding();
    if (options.mutant === 'orphan-connect' && renewed) outcome = 'pending';
    requireThat(outcome === 'resolved' && page!.transport.status.state === 'open', 'FORWARD_CONNECT_SETTLEMENT', 'own Host ACK did not lead to current Client initialization');
    requireThat(page!.client.connectionGeneration === generation, 'FORWARD_CONNECT_SETTLEMENT', 'Client initialized a different native generation');
    metrics.connectSettled++; await echo();
  };
  const cleanup = async () => {
    if (!f) return;
    const current = f; f = undefined; await current.close(); await resetting?.catch(() => {}); await pendingConnect?.catch(() => {});
    await Promise.all(waits.map(w => w.promise));
  };
  const open = async (contextual: boolean) => {
    await cleanup(); waits = []; queue = []; admitted = new Set(); retiredQueued = false; corruptWait = undefined;
    connected = false; generation = 1; barrier = false; needsFactory = false; expectedFactories = 1;
    resetting = pendingConnect = undefined; resetPhysical = undefined;
    f = hostForwardingFixture({ contextual, Server: options.Server }); page = f.renderer(); metrics.connectIntents++;
    const operation = page.client.connect(params); void operation.catch(() => {}); await checkConnected(operation, false); connected = true;
  };
  let failure: unknown;
  try {
    for (const event of events) {
      hit(event.type);
      if (event.type === 'open' || event.type === 'heal') {
        await open(event.type === 'open' ? event.contextual : false); if (event.type === 'heal') metrics.heals++; await check(); continue;
      }
      if (!f || !page) continue;
      if (event.type === 'hold' || event.type === 'cycle') {
        // A cycle is compound: an admitted provider call reports close/open
        // synchronously. It cannot jump ahead of a live FIFO dependency.
        if (event.type === 'cycle' && (queue.length > 0 || !connected || barrier)) { hit('cycle.blocked-live'); continue; }
        const wait: Wait = { tag: `saved-${++metrics.sendIntents}`, expected: connected && !barrier ? 'pending' : 'rejected',
          actual: 'pending', admitted: false, nativeDone: false, retired: false, promise: Promise.resolve() };
        if (wait.expected === 'pending') { queue.push(wait); admitHead(); } else metrics.sendSettled++;
        waits.push(wait);
        const frame = event.type === 'cycle' ? JSON.stringify({ method: 'cycle', params: { tag: wait.tag } }) : heldForwardingFrame(wait.tag);
        wait.promise = page.transport.send(frame).then(() => { wait.actual = 'resolved'; }, () => { wait.actual = 'rejected'; });
        if (event.type === 'cycle') { retire(); metrics.nativeEvents++; }
      } else if (event.type === 'settle') {
        const head = queue[0];
        if (head) { head.nativeDone = true; finish(head, event.failure ? 'rejected' : 'resolved'); queue.shift(); f.physical.settle(head.tag, event.failure); admitHead(); }
      } else if (event.type === 'old-result') {
        const old = waits.find(w => w.admitted && w.retired && !w.nativeDone);
        if (old) {
          old.nativeDone = true;
          const physical = f.physicals.find(p => p.held.some(entry => entry.tag === old.tag));
          requireThat(physical, 'FORWARD_ADMISSION', 'saved admitted operation never reached the native boundary');
          physical.settle(old.tag, event.failure); corruptWait = queue[0];
        }
      } else if (event.type === 'lose' && !barrier) {
        retire(); metrics.nativeEvents++; f.physical.publish({ state: event.state }); f.physical.publish({ state: 'open' }); hit(`loss.${event.state}`);
      } else if (event.type === 'sample-open' && !barrier) f.physical.publish({ state: 'open' });
      else if (event.type === 'renew') {
        // Only saved live work may legitimately hold FIFO. A retired worker is
        // absent from this oracle and can never excuse production stalling.
        if (barrier || queue.length) { hit('renew.blocked-live'); continue; }
        const renewing = !connected; if (renewing) generation++;
        if (needsFactory) { expectedFactories++; needsFactory = false; }
        metrics.connectIntents++; const operation = page.client.connect(params); void operation.catch(() => {});
        await checkConnected(operation, renewing); connected = true;
      } else if (event.type === 'reset' && !barrier) {
        retire(); metrics.nativeEvents++; barrier = true; needsFactory = true; resetPhysical = f.physical; resetPhysical.holdClose = true;
        resetting = f.server.resetHost('a'); void resetting.catch(() => {}); await flushForwarding();
        pendingOutcome = 'pending'; metrics.connectIntents++;
        pendingConnect = page.client.connect(params); void pendingConnect.then(() => { pendingOutcome = 'resolved'; }, () => { pendingOutcome = 'rejected'; });
        await flushForwarding(); requireThat(pendingOutcome === 'pending', 'FORWARD_PHYSICAL_BARRIER', 'Client crossed an unreleased physical close');
      } else if (event.type === 'release-close' && barrier) {
        barrier = false; needsFactory = false; expectedFactories++; generation++;
        resetPhysical!.closeGate.resolve(); await flushForwarding(); await checkConnected(pendingConnect!, true); connected = true;
      } else if (event.type === 'fresh-page' && !barrier) {
        if (needsFactory) { expectedFactories++; needsFactory = false; }
        const fresh = f.renderer(); let outcome = 'pending'; metrics.connectIntents++;
        const operation = fresh.client.connect(params).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
        await flushForwarding(); requireThat(outcome === 'resolved', 'FORWARD_FRESH_PAGE', 'an unrelated fresh page did not initialize');
        await echo(fresh.client); metrics.connectSettled++; await operation; await fresh.close();
      }
      await check();
    }
  } catch (error) { failure = error; }
  try { await cleanup(); } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (failure instanceof ChaosViolation) failure.cleanupFailure = detail;
    else if (!failure) failure = new ChaosViolation('FORWARD_CLEANUP', detail);
  }
  if (failure) throw failure; return metrics;
}
