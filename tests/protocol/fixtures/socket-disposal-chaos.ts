import { connectWebSocketAppHost } from '../../../apps/workbench-web/src/runtime/websocket-app-host';
import { socketDisposalFixture, flushSockets, socketTrack, containsSocketError, type DisposalSocket, type SocketMode } from './socket-disposal';
import { requireThat } from './recovery-chaos';

export type SocketEvent = { type: 'setup' } | { type: 'connect' | 'send'; host: 'a' | 'b' }
  | { type: 'mode'; target: 'oldest' | 'newest'; value: SocketMode }
  | { type: 'loss' | 'late' | 'finish-close'; target: 'oldest' | 'newest' }
  | { type: 'event-fault'; enabled: boolean } | { type: 'close' }
  | { type: 'reenter'; boundary: 'raw-close' | 'event-unsubscribe'; enabled: boolean };
export type SocketMutant = 'forget-debt' | 'admit-before-close' | 'drop-local-close' | 'repeat-close';
export function parseSocketTrace(value: unknown): SocketEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, 'TRACE_SCHEMA', 'expected at most 10000 Socket events');
  for (const item of value) {
    requireThat(!!item && typeof item === 'object', 'TRACE_SCHEMA', 'invalid Socket event'); const e = item as Record<string, unknown>;
    requireThat(['setup', 'connect', 'send', 'mode', 'loss', 'late', 'finish-close', 'event-fault', 'close', 'reenter'].includes(String(e.type)), 'TRACE_SCHEMA', 'invalid Socket event type');
    if (e.type === 'connect' || e.type === 'send') requireThat(['a', 'b'].includes(String(e.host)), 'TRACE_SCHEMA', 'invalid Host');
    if (['mode', 'loss', 'late', 'finish-close'].includes(String(e.type))) requireThat(['oldest', 'newest'].includes(String(e.target)), 'TRACE_SCHEMA', 'invalid Socket target');
    if (e.type === 'mode') requireThat(['ok', 'throw-before', 'throw-after', 'accept-held'].includes(String(e.value)), 'TRACE_SCHEMA', 'invalid Socket provider mode');
    if (e.type === 'event-fault' || e.type === 'reenter') requireThat(typeof e.enabled === 'boolean', 'TRACE_SCHEMA', 'invalid callback control');
    if (e.type === 'reenter') requireThat(['raw-close', 'event-unsubscribe'].includes(String(e.boundary)), 'TRACE_SCHEMA', 'invalid reentry boundary');
  }
  return value as SocketEvent[];
}
export function generateSocketChaos(seed: number, steps: number): SocketEvent[] {
  let state = seed >>> 0; const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
  const events: SocketEvent[] = [{ type: 'setup' }, { type: 'connect', host: 'a' }, { type: 'mode', target: 'newest', value: 'throw-before' },
    { type: 'loss', target: 'newest' }, { type: 'connect', host: 'a' }, { type: 'mode', target: 'newest', value: 'ok' }, { type: 'connect', host: 'a' },
    { type: 'event-fault', enabled: true }, { type: 'close' }, { type: 'event-fault', enabled: false }, { type: 'close' }, { type: 'close' }];
  for (let i = 0; i < steps; i++) {
    const n = next() % 14, target = next() % 2 ? 'oldest' as const : 'newest' as const, host = next() % 2 ? 'a' as const : 'b' as const;
    events.push(n === 0 ? { type: 'setup' } : n < 4 ? { type: 'connect', host } : n === 4 ? { type: 'send', host }
      : n < 7 ? { type: 'mode', target, value: (['ok', 'throw-before', 'throw-after', 'accept-held'] as const)[next() % 4]! }
      : n === 7 ? { type: 'loss', target } : n === 8 ? { type: 'late', target } : n === 9 ? { type: 'finish-close', target }
      : n === 10 ? { type: 'event-fault', enabled: !!(next() % 2) } : n === 11 ? { type: 'reenter', boundary: next() % 2 ? 'raw-close' : 'event-unsubscribe', enabled: !!(next() % 2) }
      : { type: 'close' });
  }
  return events.slice(0, 10000);
}
/** A saved-input ledger and independent provider facts. It never reads or edits
 * private Port/factory state. Close acceptance is not a TCP/native terminal ACK. */
export async function simulateSocketDisposal(events: readonly SocketEvent[], options: { Factory?: typeof connectWebSocketAppHost; mutant?: SocketMutant } = {}) {
  let f: ReturnType<typeof socketDisposalFixture> | undefined;
  let disposed = false, eventFault = false, serial = 0, connectIntents = 0, connectSettled = 0, sendIntents = 0, sendSettled = 0, nativeEvents = 0, cleanupCalls = 0;
  const retired = new Set<number>(), failed = new Set<number>(), active = new Map<string, number>(), coverage: Record<string, number> = {};
  let rawReentry = false;
  const cover = (name: string) => { coverage[name] = (coverage[name] ?? 0) + 1; };
  const select = (target: 'oldest' | 'newest') => target === 'oldest' ? f?.sockets[0] : f?.sockets.at(-1);
  const close = () => { disposed = true; active.clear(); f!.factory.close(); };
  const observe = async () => {
    if (!f) return;
    for (const socket of f.sockets) {
      if (socket.closeCalls && !socket.closeAccepted) failed.add(socket.id);
      let calls = socket.closeCalls;
      if (options.mutant === 'repeat-close' && disposed && socket.closeAccepted) calls++;
      requireThat(!socket.closeAccepted || calls === socket.callsAtAcceptance, 'SOCKET_SUCCESS_ONCE', 'successful raw Socket disposal was repeated');
    }
    requireThat(!f.eventAccepted || f.eventCalls === f.eventCallsAtAcceptance, 'SOCKET_SUCCESS_ONCE', 'successful recovery-event disposal was repeated');
    if (disposed) {
      for (const transport of f.transports.values()) {
        const state = options.mutant === 'drop-local-close' && eventFault ? 'open' : transport.status.state;
        requireThat(state === 'closed' || state === 'failed', 'SOCKET_LOCAL_RETIREMENT', 'external disposal left a local Host channel writable');
      }
    }
  };
  try {
    for (const event of events) {
      if (event.type === 'setup') {
        if (f) { cleanupCalls += f.sockets.reduce((sum, s) => sum + s.closeCalls, 0); await f.repair(); }
        f = socketDisposalFixture({ Factory: options.Factory }); disposed = false; eventFault = false; rawReentry = false;
        retired.clear(); failed.clear(); active.clear(); cover('setup'); continue;
      }
      if (!f) continue;
      if (event.type === 'mode') { const socket = select(event.target); if (socket) { socket.mode = event.value; cover('mode:' + event.value); } }
      else if (event.type === 'event-fault') { eventFault = event.enabled; f.eventFault(eventFault); }
      else if (event.type === 'reenter') {
        if (event.boundary === 'raw-close') rawReentry = event.enabled;
        else f.onEventUnsubscribe(event.enabled ? () => close() : () => {});
      } else if (event.type === 'close') {
        if (rawReentry && f.sockets.length) { f.sockets.at(-1)!.onClose = () => close(); rawReentry = false; }
        const eventWasAccepted = f.eventAccepted;
        let error: unknown;
        try { close(); } catch (cause) { error = cause; }
        await flushSockets();
        if (eventFault && !eventWasAccepted) requireThat(containsSocketError(error, f.eventError), 'SOCKET_CLEANUP_HONEST', 'event disposal failure lost its original error');
        if (!eventFault && f.sockets.every(s => !s.mode.startsWith('throw'))) {
          requireThat(error === undefined, 'SOCKET_CLEANUP_HONEST', 'recovered cleanup still rejected');
          const accepted = f.sockets.every(s => s.closeAccepted && !(options.mutant === 'forget-debt' && failed.has(s.id)));
          requireThat(accepted && f.eventAccepted, 'SOCKET_CLEANUP_PROGRESS', 'recovered explicit retry forgot a failed underlying handle');
        }
      } else if (event.type === 'connect') {
        const old = f.sockets.at(-1), before = f.sockets.length;
        const providerBlocked = old !== undefined && retired.has(old.id) && !old.closeAccepted && old.mode.startsWith('throw');
        if (old && rawReentry) { old.onClose = () => close(); rawReentry = false; }
        connectIntents++;
        const attempt = socketTrack(Promise.resolve().then(() => f!.connect(event.host)));
        await flushSockets(); await flushSockets();
        const blocked = old !== undefined && retired.has(old.id) && !old.closeAccepted;
        const allocated = f.sockets.length + (options.mutant === 'admit-before-close' && blocked ? 1 : 0);
        requireThat(!blocked || allocated === before, 'SOCKET_RENEWAL_BARRIER', 'successor allocation crossed unaccepted old Socket disposal');
        requireThat(!disposed || f.sockets.length === before, 'SOCKET_DISPOSED_ALLOCATION', 'reentrant disposal still allocated a new Socket');
        requireThat(attempt.state !== 'pending', 'SOCKET_CALLER_PROGRESS', 'a local connect wait was stranded'); connectSettled++;
        if (disposed || providerBlocked) requireThat(attempt.state === 'rejected', 'SOCKET_CALLER_RESULT', 'retired or blocked connection falsely succeeded');
        else { requireThat(attempt.state === 'resolved', 'SOCKET_CALLER_RESULT', 'healthy current connection failed'); active.set(event.host, f.sockets.at(-1)!.id); }
        cover('connect:' + attempt.state);
      } else if (event.type === 'send') {
        sendIntents++; const token = ++serial, counts = f.sockets.map(s => s.sent.filter(m => m.type === 'host/send').length);
        const expected = !disposed && active.has(event.host) && !retired.has(active.get(event.host)!);
        const attempt = socketTrack(Promise.resolve().then(() => f!.transport(event.host).send(JSON.stringify({ token }))));
        await flushSockets(); await flushSockets();
        requireThat(attempt.state === (expected ? 'resolved' : 'rejected'), 'SOCKET_WRITE_ADMISSION', 'local send crossed the factory/Socket retirement cut');
        f.sockets.forEach((s, i) => requireThat(s.sent.filter(m => m.type === 'host/send').length - (counts[i] ?? 0) === (expected && s.id === active.get(event.host) ? 1 : 0), 'SOCKET_WRITE_ADMISSION', 'send reached an unowned raw Socket'));
        sendSettled++;
      } else if (event.type === 'loss' || event.type === 'late' || event.type === 'finish-close') {
        const socket = select(event.target); if (socket) {
          if ((event.type === 'loss' || event.type === 'finish-close') && rawReentry) { socket.onClose = () => close(); rawReentry = false; }
          const before = f.deliveries.length;
          if (event.type !== 'late') retired.add(socket.id);
          try {
            if (event.type === 'loss') socket.emit('error'); else if (event.type === 'finish-close') socket.finishClose(); else socket.lateFrames();
          } catch { /* This declared error event can expose the external close failure. Its retained debt is checked on retry. */ }
          await flushSockets(); nativeEvents++;
          requireThat(!(disposed || retired.has(socket.id)) || f.deliveries.length === before, 'SOCKET_RETIRED_DELIVERY', 'old Socket delivered through a retired local owner');
          cover(event.type);
        }
      }
      await observe();
    }
    if (f) cleanupCalls += f.sockets.reduce((sum, s) => sum + s.closeCalls, 0);
    return { events: events.length, cleanupCalls, connectIntents, connectSettled, sendIntents, sendSettled, nativeEvents, coverage };
  } finally { await f?.repair(); }
}
