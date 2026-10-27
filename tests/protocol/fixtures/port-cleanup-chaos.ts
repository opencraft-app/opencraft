import { MessagePortAppHostClient } from '../../../packages/app-host-client/src/index';
import { AppHostServer } from '../../../packages/app-host-server/src/index';
import { APP_HOST_PROTOCOL_VERSION } from '../../../packages/app-host-protocol/src/index';
import type { TransportStatus } from '@opencraft/appserver-client/transport';
import { requireThat } from './recovery-chaos';

export type PortFault = 'none' | 'remove' | 'close' | 'both';
export type PortEvent = { type: 'setup'; side: 'client' | 'connection' | 'server'; ready: boolean; peer: boolean; lifetime: 'last-claim' | 'server' }
  | { type: 'fault'; value: PortFault } | { type: 'stop' } | { type: 'late' } | { type: 'reenter'; enabled: boolean };
export type PortMutant = 'orphan-wait' | 'orphan-native' | 'forget-handle' | 'duplicate-terminal';
export function parsePortTrace(value: unknown): PortEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 Port events');
  for (const item of value) {
    requireThat(!!item && typeof item === 'object', 'TRACE_SCHEMA', 'invalid Port event');
    const e = item as Record<string, unknown>;
    requireThat(['setup', 'fault', 'stop', 'late', 'reenter'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid Port event type');
    if (e.type === 'setup') requireThat(['client', 'connection', 'server'].includes(String(e.side)) && typeof e.ready === 'boolean'
      && typeof e.peer === 'boolean' && ['last-claim', 'server'].includes(String(e.lifetime)), 'TRACE_SCHEMA', 'invalid Port owner');
    if (e.type === 'fault') requireThat(['none', 'remove', 'close', 'both'].includes(String(e.value)), 'TRACE_SCHEMA', 'invalid Port fault');
    if (e.type === 'reenter') requireThat(typeof e.enabled === 'boolean', 'TRACE_SCHEMA', 'invalid Port reentry');
  }
  return value as PortEvent[];
}
export function generatePortChaos(seed: number, steps: number): PortEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
  const setup = (): PortEvent => ({ type: 'setup', side: (['client', 'connection', 'server'] as const)[next() % 3]!, ready: !!(next() % 2), peer: !!(next() % 2), lifetime: next() % 2 ? 'last-claim' : 'server' });
  const events: PortEvent[] = [setup(), { type: 'fault', value: 'both' }, { type: 'stop' }, { type: 'late' }, { type: 'fault', value: 'none' }, { type: 'stop' }];
  for (let i = 0; i < steps; i++) {
    const choice = next() % 9;
    events.push(choice === 0 ? setup() : choice < 4 ? { type: 'fault', value: (['none', 'remove', 'close', 'both'] as const)[next() % 4]! }
      : choice < 7 ? { type: 'stop' } : choice === 7 ? { type: 'late' } : { type: 'reenter', enabled: !!(next() % 2) });
  }
  return events.slice(0, 10000);
}
export async function flushPorts() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
export function trackPort<T>(promise: Promise<T>) {
  const value: { state: 'pending' | 'resolved' | 'rejected'; error?: unknown; promise: Promise<void> } = { state: 'pending', promise: Promise.resolve() };
  value.promise = promise.then(() => { value.state = 'resolved'; }, error => { value.state = 'rejected'; value.error = error; });
  return value;
}
export class FaultPort {
  readonly listeners = new Set<(value: unknown) => void>();
  readonly domListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly sent: unknown[] = [];
  readonly removeError = Error('synthetic Port remove failure');
  readonly closeError = Error('synthetic Port close failure');
  fault: PortFault = 'none';
  startError: Error | null = null;
  helloError: Error | null = null;
  removes = 0;
  closes = 0;
  onDispose: (() => void) | undefined;
  postMessage(message: unknown) { if (this.helloError) throw this.helloError; this.sent.push(message); }
  start() { if (this.startError) throw this.startError; }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) { this.domListeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void) { this.removes++; this.onDispose?.(); if (this.fault === 'remove' || this.fault === 'both') throw this.removeError; this.domListeners.delete(listener); }
  subscribe(listener: (value: unknown) => void) { this.listeners.add(listener); return () => { this.removes++; this.onDispose?.(); if (this.fault === 'remove' || this.fault === 'both') throw this.removeError; this.listeners.delete(listener); }; }
  close() { this.closes++; this.onDispose?.(); if (this.fault === 'close' || this.fault === 'both') throw this.closeError; }
  emit(message: unknown) { for (const l of [...this.listeners]) l(message); for (const l of [...this.domListeners]) l({ data: message } as MessageEvent<unknown>); }
}
export function errorContains(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (value instanceof AggregateError && value.errors.some(e => errorContains(e, target))) return true;
  return value instanceof Error && value.cause !== undefined && errorContains(value.cause, target);
}
/** Inputs predict logical retirement and each disposer attempt independently.
 * Only actual constructors, Port callbacks and public close/hello/connect APIs
 * run. Observation controls are separate from injecting an immutable old class. */
export async function simulatePortCleanup(events: readonly PortEvent[], options: { Client?: typeof MessagePortAppHostClient; Server?: typeof AppHostServer; mutant?: PortMutant } = {}) {
  type Fixture = Awaited<ReturnType<typeof setup>>;
  let current: Fixture | undefined;
  let cleanupCalls = 0, connectIntents = 0, observerEvents = 0;
  const coverage: Record<string, number> = {};
  const cover = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  async function setup(e: Extract<PortEvent, { type: 'setup' }>) {
    const port = new FaultPort(), peerPort = new FaultPort();
    let terminals = 0, physicalCloses = 0, factories = 0, reenter = false;
    const status = new Set<(value: TransportStatus) => void>();
    const physical = { status: { state: 'idle' } as TransportStatus,
      async connect() { physical.status = { state: 'open' }; for (const l of status) l(physical.status); },
      async send(_frame: string) {}, async close() { physicalCloses++; physical.status = { state: 'closed' }; },
      subscribeMessage(_listener: (frame: string) => void) { return () => {}; }, subscribeStatus(l: (value: TransportStatus) => void) { status.add(l); return () => { status.delete(l); }; } };
    const client = e.side === 'client' ? new (options.Client ?? MessagePortAppHostClient)(port, 'page', { controlTimeoutMs: 30000 }) : undefined;
    if (e.ready && client) port.emit({ type: 'ready', protocolVersion: APP_HOST_PROTOCOL_VERSION });
    const waits = client ? [trackPort(client.waitUntilReady()), trackPort(client.connectHost('host', 'lease')), trackPort(client.sendHostFrame('host', 'lease', 1, '{}')), trackPort(client.disconnectHost('host', 'lease', 1))] : [];
    client?.subscribeHost('host', event => { if (event.terminalReason !== undefined) { terminals++; observerEvents++; if (reenter) client.close(); } });
    const server = client ? undefined : new (options.Server ?? AppHostServer)({ physicalHostLifetime: e.lifetime, createTransport() { factories++; return physical; } });
    const connection = server?.accept(port, 'page');
    if (server) {
      port.emit({ type: 'hello', rendererId: 'page', protocolVersion: APP_HOST_PROTOCOL_VERSION });
      port.emit({ type: 'host/connect', hostId: 'host', leaseId: 'lease', requestId: 'open' }); connectIntents++;
      if (e.peer) { server.accept(peerPort, 'peer'); peerPort.emit({ type: 'hello', rendererId: 'peer', protocolVersion: APP_HOST_PROTOCOL_VERSION }); peerPort.emit({ type: 'host/connect', hostId: 'host', leaseId: 'peer', requestId: 'peer-open' }); connectIntents++; }
    }
    await flushPorts();
    if (server) requireThat(port.sent.some((x: any) => x.type === 'response' && x.requestId === 'open' && x.ok), 'PORT_FIXTURE_ADMISSION', 'real Host claim was not admitted');
    const f = { e, port, peerPort, client, server, connection, waits, stopped: false, readyAccepted: e.ready, expectedRemove: 0, expectedClose: 0, removeDone: false, closeDone: false,
      async stop() {
        f.stopped = true;
        if (!f.removeDone) { f.expectedRemove++; if (port.fault !== 'remove' && port.fault !== 'both') f.removeDone = true; }
        if (!f.closeDone) { f.expectedClose++; if (port.fault !== 'close' && port.fault !== 'both') f.closeDone = true; }
        let caught: unknown;
        try { if (client) client.close(); else if (e.side === 'connection') connection!.close(); else await server!.close(); } catch (error) { caught = error; }
        await flushPorts();
        for (const [failed, error] of [[!f.removeDone, port.removeError], [!f.closeDone, port.closeError]] as const)
          requireThat(!failed || errorContains(caught, error), 'PORT_CLEANUP_HONEST', 'failed disposer lost its original error');
        requireThat(!f.removeDone || !f.closeDone || caught === undefined, 'PORT_CLEANUP_HONEST', 'successful cleanup reported failure');
        cleanupCalls++;
      },
      reentry(enabled: boolean) { reenter = enabled; port.onDispose = enabled ? () => { if (client) client.close(); else if (e.side === 'connection') connection!.close(); } : undefined; },
      observe() {
        if (!f.stopped) return;
        cover(e.side); cover('fault:' + port.fault);
        if (client) {
          const states = waits.map(w => w.state);
          if (options.mutant === 'orphan-wait' && !f.removeDone) states[1] = 'pending';
          requireThat(states[0] === (f.readyAccepted ? 'resolved' : 'rejected') && states.slice(1).every(x => x === 'rejected'), 'PORT_LOCAL_SETTLEMENT', 'closed Port left an admitted local wait pending');
          const seen = options.mutant === 'duplicate-terminal' ? terminals + 1 : terminals;
          requireThat(seen === 1, 'PORT_TERMINAL_ONCE', 'terminal publication was missing or repeated');
        } else {
          const shouldClose = e.side === 'server' || (!e.peer && e.lifetime === 'last-claim');
          const observed = options.mutant === 'orphan-native' && shouldClose ? 0 : physicalCloses;
          requireThat(observed === (shouldClose ? 1 : 0), 'PORT_NATIVE_RETIREMENT', 'Port disposal skipped native retirement or closed a healthy peer/service');
          requireThat(factories === 1, 'PORT_NATIVE_RETIREMENT', 'cleanup replaced the original native handle');
        }
        const removes = options.mutant === 'forget-handle' && f.expectedRemove > 1 ? port.removes - 1 : port.removes;
        requireThat(removes === f.expectedRemove && port.closes === f.expectedClose, 'PORT_HANDLE_RETRY', 'a failed disposer was forgotten or successful work repeated');
      },
      async repair() {
        port.fault = 'none'; peerPort.fault = 'none'; reenter = false; port.onDispose = undefined;
        try { client?.close(); } finally {
          // Explicit external fixture cleanup after all behavior observations.
          port.emit({ type: 'ready', protocolVersion: APP_HOST_PROTOCOL_VERSION });
          for (const sent of [...port.sent] as { requestId?: string }[]) if (sent.requestId)
            port.emit({ type: 'response', requestId: sent.requestId, ok: false, error: { code: 'APP_HOST_FIXTURE_END', message: 'fixture ended', retryable: false } });
          await server?.close(); await flushPorts();
        }
      },
    };
    return f;
  }
  try {
    for (const event of events) {
      if (event.type === 'setup') { await current?.repair(); current = await setup(event); }
      else if (current) {
        if (event.type === 'fault') current.port.fault = event.value;
        else if (event.type === 'reenter') current.reentry(event.enabled);
        else if (event.type === 'stop') await current.stop();
        else if (event.type === 'late') {
          if (!current.stopped) current.readyAccepted = true;
          current.port.emit({ type: 'ready', protocolVersion: APP_HOST_PROTOCOL_VERSION });
          current.port.emit({ type: 'hello', protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: 'page' });
          current.port.emit({ type: 'host/connect', hostId: 'host', leaseId: 'late', requestId: 'late' });
          current.port.emit({ type: 'host/frame', hostId: 'host', generation: 1, frame: '{}' });
          await flushPorts();
        }
        current.observe();
      }
    }
    return { events: events.length, cleanupCalls, connectIntents, observerEvents, coverage };
  } finally { await current?.repair(); }
}
