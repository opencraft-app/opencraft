import { connectWebSocketAppHost } from '../../../apps/workbench-web/src/runtime/websocket-app-host';
import type { DuplexTransport } from '@opencraft/appserver-client/transport';

export type SocketMode = 'ok' | 'throw-before' | 'throw-after' | 'accept-held';
export const flushSockets = () => new Promise<void>(resolve => setImmediate(resolve));
export function socketTrack<T>(promise: Promise<T>) {
  const track: { state: 'pending' | 'resolved' | 'rejected'; error?: unknown; promise: Promise<void> } = { state: 'pending', promise: Promise.resolve() };
  track.promise = promise.then(() => { track.state = 'resolved'; }, error => { track.state = 'rejected'; track.error = error; });
  return track;
}
export function containsSocketError(error: unknown, expected: unknown): boolean {
  return error === expected || (error instanceof AggregateError && error.errors.some(e => containsSocketError(e, expected)))
    || (error instanceof Error && error.cause !== undefined && containsSocketError(error.cause, expected));
}
/** A declared external Socket provider, with close acceptance independent of
 * observed readyState, a delivered close event and the underlying resource. */
export class DisposalSocket {
  readyState = 0;
  mode: SocketMode = 'ok';
  resourceLive = true;
  closeAccepted = false;
  closeCalls = 0;
  callsAtAcceptance = 0;
  readonly closeError = Error('synthetic raw Socket close failure');
  readonly sent: any[] = [];
  readonly claims: { hostId: string; leaseId: string; generation: number }[] = [];
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  onClose: (() => void) | undefined;
  constructor(readonly id: number) {}
  addEventListener(type: string, listener: (event: any) => void) {
    let list = this.listeners.get(type); if (!list) { list = new Set(); this.listeners.set(type, list); } list.add(listener);
  }
  emit(type: string, event: any = {}) { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
  receive(message: unknown) { this.emit('message', { data: JSON.stringify(message) }); }
  open() { this.readyState = 1; this.emit('open'); }
  send(frame: string) {
    const message = JSON.parse(frame); this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'hello') this.receive({ type: 'ready', protocolVersion: 2, services: ['appserver'], capabilities: { connectionProbe: true } });
      else if (message.type === 'host/connect') {
        const claim = { hostId: message.hostId, leaseId: message.leaseId, generation: this.id };
        this.claims.push(claim);
        this.receive({ type: 'response', requestId: message.requestId, ok: true, result: { hostId: claim.hostId, generation: claim.generation } });
      } else if (message.requestId) {
        this.receive({ type: 'response', requestId: message.requestId, ok: true, result: null });
      }
    });
  }
  close() {
    this.closeCalls++;
    const action = this.onClose; this.onClose = undefined; action?.();
    if (this.mode === 'throw-before') throw this.closeError;
    if (this.mode === 'accept-held') this.readyState = 2;
    else this.finishClose();
    if (this.mode === 'throw-after') throw this.closeError;
    if (!this.closeAccepted) this.callsAtAcceptance = this.closeCalls;
    this.closeAccepted = true;
  }
  finishClose() { this.resourceLive = false; this.readyState = 3; this.emit('close', { code: 1000 }); }
  lateFrames() {
    for (const claim of this.claims) this.receive({ type: 'host/frame', ...claim, frame: JSON.stringify({ source: this.id, late: true }) });
  }
}
export function socketDisposalFixture(options: { Factory?: typeof connectWebSocketAppHost } = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { href: 'https://fixture.invalid/' } } });
  const sockets: DisposalSocket[] = [], transports = new Map<string, DuplexTransport>();
  const deliveries: string[] = [], recoveryListeners = new Set<() => void>();
  const eventError = Error('synthetic recovery unsubscribe failure');
  let eventFault = false, eventAccepted = false, eventCalls = 0, eventCallsAtAcceptance = 0;
  let onEventUnsubscribe: (() => void) | undefined;
  const factory = (options.Factory ?? connectWebSocketAppHost)(() => {
    const socket = new DisposalSocket(sockets.length + 1); sockets.push(socket); queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
  }, { reportFailure: () => {}, recoveryEvents: { isVisible: () => true,
    subscribe(listener) { recoveryListeners.add(listener); return () => {
      eventCalls++; const action = onEventUnsubscribe; onEventUnsubscribe = undefined; action?.();
      if (eventFault) throw eventError;
      recoveryListeners.delete(listener); if (!eventAccepted) eventCallsAtAcceptance = eventCalls; eventAccepted = true;
    }; } } });
  return {
    factory, sockets, transports, deliveries, eventError,
    get eventCalls() { return eventCalls; }, get eventAccepted() { return eventAccepted; }, get eventCallsAtAcceptance() { return eventCallsAtAcceptance; },
    eventFault(value: boolean) { eventFault = value; },
    onEventUnsubscribe(action: () => void) { onEventUnsubscribe = action; },
    transport(host: string) {
      let transport = transports.get(host);
      if (!transport) { transport = factory.createTransport(host); transports.set(host, transport); transport.subscribeMessage(frame => deliveries.push(frame)); }
      return transport;
    },
    async connect(host = 'a') { await this.transport(host).connect(); },
    async repair() {
      eventFault = false; onEventUnsubscribe = undefined;
      for (const socket of sockets) { socket.mode = 'ok'; socket.onClose = undefined; }
      try { factory.close(); } finally {
        // Only explicit external fixture repair, after behavior observations.
        for (const socket of sockets) if (!socket.closeAccepted) socket.close();
        for (const socket of sockets) if (socket.resourceLive) socket.finishClose();
        await flushSockets();
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete (globalThis as { window?: unknown }).window;
      }
    },
  };
}
