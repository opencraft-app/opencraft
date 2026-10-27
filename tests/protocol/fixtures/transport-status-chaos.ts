import { WebSocketTransport } from "@opencraft/appserver-transport-websocket";
import type { TransportStatus } from "@opencraft/appserver-client/transport";
import { StatusSocket } from "./transport-status";
import { flush } from "./execution-channels";
import { ChaosViolation, recoveryChaosRandom } from "./recovery-chaos";

const types = ["begin", "open", "loss", "error", "abort", "close", "late-open", "rotate-a", "rotate-b", "remove-a", "remove-b", "old-a", "old-b", "dedup-a", "dedup-b", "throw-a", "reenter-self", "reenter-peer", "reenter-close", "reenter-connect", "reenter-connect-peer", "pad", "heal"] as const;
export type TransportChaosEvent = { type: typeof types[number] };
export type TransportChaosMutant = "orphan-connect" | "stale-token" | "stale-status" | "drop-peer";
export function parseTransportTrace(value: unknown): TransportChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid transport trace");
  return value.map(e => { if (!e || !types.includes(e.type)) throw Error("Invalid transport event"); return { type: e.type }; });
}
export function generateTransportChaos(seed: number, steps = 120): TransportChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  return [...Array.from({ length: steps }, () => ({ type: types[Math.floor(random() * (types.length - 1))]! })), { type: "heal" }];
}

class ObserverFailure extends Error {}
/** Actual WebSocketTransport; only physical socket events are controlled. Initial
 * subscription samples and publication deliveries have separate admission cuts.
 * Heal is an explicit trace event, never an invisible input suffix. */
export async function simulateTransportStatus(events: readonly TransportChaosEvent[], options: { mutant?: TransportChaosMutant } = {}) {
  type Key = "a" | "b";
  type Registration = { id: number; key: Key; remove: () => void };
  type Token = { registration: Registration; remove: () => void };
  type Attempt = { controller: AbortController; outcome: "pending" | "resolved" | "rejected"; terminal: boolean; retired: boolean };
  type Physical = { socket: StatusSocket; opened: boolean; retired: boolean; attempt: Attempt };
  type Emission = { sequence: number; status: TransportStatus; admission: Map<Key, Registration>; delivered: Set<number> };
  const active = new Map<Key, Registration>(), tokens: Record<Key, Token[]> = { a: [], b: [] };
  const emissions: Emission[] = [], byStatus = new WeakMap<TransportStatus, Emission>(), physical: Physical[] = [], attempts: Attempt[] = [];
  const lastPublication = new Map<number, number>();
  const coverage: Record<string, number> = {}, closes: Promise<void>[] = [];
  let currentAttempt: Attempt | undefined, current: Physical | undefined, lastOpen: TransportStatus | undefined;
  let sequence = 0, sampling: Key | undefined, bad = false, measuring = true, nativeEvents = 0, deliveries = 0, samples = 0;
  let reentry: "self" | "peer" | "close" | "connect" | "connect-peer" | undefined, boundaryErrors = 0, primary: ChaosViolation | undefined, failure: unknown;
  const count = (key: string) => { if (measuring) coverage[key] = (coverage[key] ?? 0) + 1; };
  const fail = (rule: string, message: string) => { primary ??= new ChaosViolation(rule, message); };
  const boundary = (run: () => void) => {
    try { run(); } catch (error) { if (error instanceof ObserverFailure) boundaryErrors++; else throw error; }
  };
  const retirePhysical = () => {
    if (current) { current.retired = true; current.attempt.retired = true; current.attempt.terminal = true; }
    if (currentAttempt?.outcome === "pending") { currentAttempt.retired = true; currentAttempt.terminal = true; }
  };
  const transport = new WebSocketTransport({ url: "ws://fixture.invalid/rpc", closeTimeoutMs: 20, createSocket() {
    if (!currentAttempt) throw Error("Socket allocation without a connect input");
    const socket = new class extends StatusSocket {
      override close() {
        rememberStatus();
        if (measuring) nativeEvents++; count("native-close-ack"); super.close();
        rememberStatus();
      }
    }();
    current = { socket, opened: false, retired: false, attempt: currentAttempt }; physical.push(current);
    count("physical-allocation"); return socket;
  } });
  const terminal = (status: TransportStatus) => ["closing", "closed", "failed"].includes(status.state);
  const rememberStatus = (status = transport.status) => {
    if (!measuring) return;
    if (byStatus.has(status)) return;
    const e: Emission = { sequence: emissions.length + 1, status, admission: new Map(active), delivered: new Set() };
    emissions.push(e); byStatus.set(status, e); count(`publication-${status.state}`);
    if (status.state === "open") lastOpen = status;
  };
  let captureSample = true;
  const removeCapture = transport.subscribeStatus(status => {
    if (captureSample || !measuring) return;
    rememberStatus(status);
  });
  captureSample = false;
  const close = () => {
    retirePhysical();
    boundary(() => {
      const promise = transport.close().catch(error => {
        if (error instanceof ObserverFailure) boundaryErrors++; else throw error;
      });
      void promise.catch(() => {}); closes.push(promise);
    });
    rememberStatus();
  };
  const callbacks = Object.fromEntries((["a", "b"] as const).map(key => [key, (status: TransportStatus) => {
    if (!measuring || primary) return;
    if (sampling === key) { samples++; count("initial-sample"); }
    else {
      const e = byStatus.get(status), registration = active.get(key);
      if (!terminal(status) && status !== transport.status) fail("STATUS_CURRENT", "a synchronous state change revokes an older nonterminal publication");
      else if (!e || !registration || e.admission.get(key) !== registration) fail("STATUS_ADMISSION", "a replacement belongs to its own sample and future publications");
      else if (e.delivered.has(registration.id)) fail("STATUS_ONCE", "a registration cannot receive one publication twice");
      else if (e.sequence < (lastPublication.get(registration.id) ?? 0)) fail("STATUS_ORDER", "old terminal publications cannot arrive after a successor publication");
      else if (!(options.mutant === "drop-peer" && key === "b" && status.state === "closed")) {
        e.delivered.add(registration.id); lastPublication.set(registration.id, e.sequence); deliveries++; count(`delivery-${key}`);
      }
      if (primary) return;
      if (status.state === "closed" && (reentry === "connect" || reentry === "connect-peer")) {
        const action = reentry; reentry = undefined; begin();
        if (action === "connect-peer") rotate(key === "a" ? "b" : "a");
        count(`effective-reentrant-${action}`);
      } else if (status.state === "open" && reentry && reentry !== "connect" && reentry !== "connect-peer") {
        const action = reentry; reentry = undefined;
        if (action === "close") { close(); count("effective-reentrant-close"); }
        else { rotate(action === "self" ? key : key === "a" ? "b" : "a"); count(`effective-reentrant-${action}`); }
      }
    }
    if (key === "a" && bad && status.state === "open") {
      count("observer-throw"); throw new ObserverFailure("Synthetic transport status observer failure");
    }
  }])) as Record<Key, (status: TransportStatus) => void>;
  const remove = (token: Token) => {
    const now = active.get(token.registration.key);
    if (now === token.registration) active.delete(token.registration.key); else if (now) count("old-token-with-successor");
    if (options.mutant === "stale-token" && now && now !== token.registration) now.remove(); else token.remove();
  };
  function subscribe(key: Key, dedup = false) {
    const previous = active.get(key), r = dedup && previous ? previous : { id: ++sequence, key, remove: () => {} };
    active.set(key, r); const before = sampling; sampling = key;
    let cleanup = () => {}; const beforeSamples = samples;
    try { boundary(() => { cleanup = transport.subscribeStatus(callbacks[key]); }); }
    finally { sampling = before; }
    if (!dedup || !previous) r.remove = cleanup;
    tokens[key].push({ registration: r, remove: cleanup });
    if (!primary && samples !== beforeSamples + 1) fail("STATUS_SAMPLE", "each WebSocket status subscription gets exactly its own current sample");
    count(dedup && previous ? "same-function-dedup" : "registration");
  }
  function rotate(key: Key) { const previous = active.get(key); if (previous) remove({ registration: previous, remove: previous.remove }); subscribe(key); }
  const begin = () => {
    if (currentAttempt?.outcome === "pending" && !currentAttempt.retired) { count("shared-begin"); return; }
    const attempt: Attempt = { controller: new AbortController(), outcome: "pending", terminal: transport.status.state === "open", retired: false };
    attempts.push(attempt); currentAttempt = attempt; count("connect-intent");
    boundary(() => {
      let promise = transport.connect(attempt.controller.signal);
      if (options.mutant === "orphan-connect") promise = promise.then(() => new Promise<void>(() => {}));
      void promise.then(() => { attempt.outcome = "resolved"; }, () => { attempt.outcome = "rejected"; });
    });
    rememberStatus();
  };
  const open = (p = current) => {
    if (!p) return; if (measuring) nativeEvents++; count("native-open");
    if (!p.retired && p === current) { p.opened = true; p.attempt.terminal = true; }
    boundary(() => p.socket.emitOpen());
  };
  const check = () => {
    if (primary) throw primary;
    if (transport.status.state === "open" && (!current?.opened || current.retired)) {
      fail("STATUS_NATIVE_OWNER", "only the current, unretired native socket can publish open");
    }
    for (const a of attempts) if (a.terminal) {
      if (a.outcome === "pending") fail("STATUS_CONNECT_SETTLEMENT", "native open, cancellation or close must settle the owned connect promise");
      else if (!a.retired && a.outcome !== "resolved") fail("STATUS_CONNECT_SUCCESS", "a status consumer cannot fail a native connection");
    }
    if (boundaryErrors) fail("STATUS_ISOLATION", "a status observer exception escaped the transport boundary");
    for (const e of emissions) if (terminal(e.status) || e.status === transport.status) for (const [key, r] of e.admission) {
      if (active.get(key) === r && !e.delivered.has(r.id)) fail("STATUS_DELIVERY", "an unchanged peer must receive the current publication");
    }
    if (primary) throw primary;
  };
  try {
    subscribe("a"); subscribe("b");
    for (const e of events) {
      count(e.type);
      if (e.type === "begin") begin();
      else if (e.type === "open") open();
      else if (e.type === "loss" || e.type === "error") {
        retirePhysical(); if (current) { nativeEvents++; count(`native-${e.type}`); boundary(() => e.type === "loss" ? current!.socket.emitClose(1006, "Synthetic loss") : current!.socket.emitError()); }
      } else if (e.type === "abort") {
        if (currentAttempt?.outcome === "pending") { retirePhysical(); currentAttempt.controller.abort(); count("effective-abort"); }
      } else if (e.type === "close") close();
      else if (e.type === "late-open") { const old = physical.find(p => p.retired && p !== current); if (old) { count("late-native-open"); open(old); } }
      else if (e.type === "rotate-a" || e.type === "rotate-b") rotate(e.type === "rotate-a" ? "a" : "b");
      else if (e.type === "remove-a" || e.type === "remove-b") { const r = active.get(e.type === "remove-a" ? "a" : "b"); if (r) remove({ registration: r, remove: r.remove }); }
      else if (e.type === "old-a" || e.type === "old-b") { const token = tokens[e.type === "old-a" ? "a" : "b"][0]; if (token) remove(token); }
      else if (e.type === "dedup-a" || e.type === "dedup-b") subscribe(e.type === "dedup-a" ? "a" : "b", true);
      else if (e.type === "throw-a") bad = !bad;
      else if (e.type === "reenter-self") reentry = "self";
      else if (e.type === "reenter-peer") reentry = "peer";
      else if (e.type === "reenter-close") reentry = "close";
      else if (e.type === "reenter-connect") reentry = "connect";
      else if (e.type === "reenter-connect-peer") reentry = "connect-peer";
      else if (e.type === "heal") { reentry = undefined; bad = false; if (transport.status.state !== "open") { begin(); await flush(); open(); } }
      await flush();
      if (closes.length) await Promise.all(closes);
      if (options.mutant === "stale-status" && lastOpen && lastOpen !== transport.status && active.has("b")) {
        count("corrupt-status-delivery"); boundary(() => callbacks.b(lastOpen!));
      }
      check();
    }
    return { events: events.length, nativeEvents, connectIntents: attempts.length, connectSettled: attempts.filter(a => a.outcome !== "pending").length,
      statusEvents: emissions.length, statusDeliveries: deliveries, statusSamples: samples, coverage };
  } catch (error) { failure = error; throw error; }
  finally {
    measuring = false; bad = false; removeCapture(); for (const r of active.values()) r.remove();
    try {
      await transport.close(); await Promise.all(closes); await flush();
      if (attempts.some(a => a.outcome === "pending")) {
        if (failure === undefined) throw new ChaosViolation("STATUS_CONNECT_SETTLEMENT", "cleanup must retire an outstanding connect promise");
        if (failure instanceof ChaosViolation && failure.rule !== "STATUS_CONNECT_SETTLEMENT") failure.cleanupFailure = "connect promise remained pending after close";
      }
    }
    catch (error) { if (failure === undefined) throw error; if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error); }
  }
}
