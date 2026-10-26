import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import type { AppServerNotification } from "@opencraft/appserver-protocol";
import { executionChannelsFixture, flush } from "./execution-channels";
import { ChaosViolation, recoveryChaosRandom, requireThat } from "./recovery-chaos";

const types = ["wire", "hold-global", "hold-scoped", "release", "rotate-a", "rotate-b", "remove-a", "remove-b", "old-token-a", "old-token-b", "dedup-a", "loss", "connect", "reenter-self", "reenter-peer", "reenter-loss", "bad-listener", "pad"] as const;
export type FanoutChaosEvent = { type: typeof types[number] };
export type FanoutChaosMutant = "live-admission" | "stale-token" | "lost-continuation";
export function parseFanoutTrace(value: unknown): FanoutChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid notification fanout trace");
  return value.map(e => { if (!e || !types.includes(e.type)) throw Error("Invalid notification fanout event"); return { type: e.type }; });
}
export function generateFanoutChaos(seed: number, steps = 120): FanoutChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  return Array.from({ length: steps }, () => ({ type: types[Math.floor(random() * types.length)]! }));
}

/** Real Client/MemoryTransport. The oracle records native inputs and registration
 * incarnations independently; it does not inspect the Client's private Set.
 * Each callback has at most one scripted synchronous reentry per native input. */
export async function simulateNotificationFanout(events: readonly FanoutChaosEvent[], options: { mutant?: FanoutChaosMutant } = {}) {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "fanout", transport: f.transport });
  const initialize = { clientInfo: { name: "notification-fanout-chaos", version: "1" } };
  type Slot = "a" | "b";
  type Registration = { id: number; slot: Slot; remove: () => void };
  type Token = { registration: Registration; remove: () => void };
  type Observation = { id: number; epoch: number; admission: Map<Slot, Registration>; delivered: Set<number>; globalPending: boolean; scopedPending: Set<number> };
  const active = new Map<Slot, Registration>(), tokens: Record<Slot, Token[]> = { a: [], b: [] };
  const observations = new Map<number, Observation>(), deferred: (() => void)[] = [], errors: Error[] = [];
  const coverage: Record<string, number> = {}, asynchronousCloses: Promise<void>[] = [];
  let sequence = 0, registrationSequence = 0, epoch = 1, connected = true, holdGlobal = false, holdScoped = false;
  let reentry: "self" | "peer" | "loss" | undefined, inCallback: AppServerNotification | undefined;
  let primary: unknown, syntheticErrors = 0, notificationDeliveries = 0;
  const bad = new Set<Slot>();
  const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const fail = (rule: string, message: string) => { primary ??= new ChaosViolation(rule, message); };
  const observation = (n: AppServerNotification) => observations.get((n.params as { token: number }).token)!;
  const current = (e: Observation) => connected && e.epoch === epoch;
  const lose = () => {
    if (!connected) return;
    connected = false; epoch++; count("effective-loss");
    asynchronousCloses.push(f.transport.close().catch(error => { primary ??= error; }));
  };
  const retire = (token: Token) => {
    const successor = active.get(token.registration.slot);
    if (successor === token.registration) active.delete(token.registration.slot);
    else if (successor) count("retired-token-with-successor");
    if (options.mutant === "stale-token" && successor && successor !== token.registration) successor.remove();
    else token.remove();
  };
  const callbacks: Record<Slot, (n: AppServerNotification) => void> = {
    a: n => receive("a", n), b: n => receive("b", n),
  };
  function register(slot: Slot, duplicate = false) {
    const existing = active.get(slot);
    if (existing && !duplicate) retire({ registration: existing, remove: existing.remove });
    const registration = duplicate && existing ? existing : { id: ++registrationSequence, slot, remove: () => {} };
    active.set(slot, registration);
    const remove = client.subscribeNotification(callbacks[slot], slot === "b" ? { intercept(n, next) {
      if (!holdScoped) { next(); return; }
      const e = observation(n); e.scopedPending.add(registration.id); count("scoped-deferral");
      deferred.push(() => {
        e.scopedPending.delete(registration.id);
        // Deliberate test-only corruption: replace the guarded continuation
        // with the original consumer after loss, without another wire input.
        if (options.mutant === "lost-continuation" && !current(e)) callbacks[slot](n);
        else next();
      });
    } } : undefined);
    if (!duplicate || !existing) registration.remove = remove;
    tokens[slot].push({ registration, remove });
    count(duplicate && existing ? "effective-dedup" : `registration-${slot}`);
    // Deliberate adapter mutation of the admission boundary, not a fake native
    // input or a second invocation of the simulator's oracle.
    if (inCallback && options.mutant === "live-admission" && !primary) callbacks[slot](inCallback);
  }
  function receive(slot: Slot, n: AppServerNotification) {
    if (primary) return;
    const e = observation(n), registration = active.get(slot);
    if (!current(e)) { fail("FANOUT_PHYSICAL", "a retired physical observation reached a consumer"); return; }
    if (!registration || e.admission.get(slot) !== registration) { fail("FANOUT_ADMISSION", "a replacement inherited an observation admitted before its registration"); return; }
    if (e.delivered.has(registration.id)) { fail("FANOUT_ONCE", "one native input invoked the same registration twice"); return; }
    e.delivered.add(registration.id); notificationDeliveries++; count(`delivery-${slot}`);
    const previous = inCallback; inCallback = n;
    try {
      const action = reentry; reentry = undefined;
      if (action === "self") { count("effective-self-reentry"); register(slot); }
      if (action === "peer") { count("effective-peer-reentry"); register(slot === "a" ? "b" : "a"); }
      if (action === "loss") { count("effective-loss-reentry"); lose(); }
    } finally { inCallback = previous; }
    if (bad.delete(slot)) { syntheticErrors++; throw Error("Synthetic fanout consumer failure"); }
  }
  const removeError = client.subscribeProtocolError(error => errors.push(error));
  const removeGate = client.interceptNotification((n, next) => {
    if (!holdGlobal) { next(); return; }
    const e = observation(n); e.globalPending = true; count("global-deferral");
    deferred.push(() => { e.globalPending = false; next(); });
  });
  const inspect = () => {
    if (primary) throw primary;
    for (const e of observations.values()) for (const [slot, registration] of e.admission) {
      if (current(e) && active.get(slot) === registration && !e.globalPending && !e.scopedPending.has(registration.id)) {
        requireThat(e.delivered.has(registration.id), "FANOUT_CONSERVED", "a still-current admitted registration lost its native input");
      }
    }
    requireThat(errors.length === syntheticErrors && errors.every(error => error.cause instanceof Error && error.cause.message === "Synthetic fanout consumer failure"), "FANOUT_ERRORS", "consumer failures must be isolated and reported exactly once");
    requireThat(f.reads === 0 && f.activations === 0 && f.replies.length === 0, "READ_ONLY", "subscription dispatch cannot read history, acquire execution or answer a native request");
  };
  const emit = async () => {
    if (!connected) return;
    const e: Observation = { id: ++sequence, epoch, admission: new Map(active), delivered: new Set(), globalPending: false, scopedPending: new Set() };
    observations.set(e.id, e); count("wire-input");
    f.emit("fixture/fanout", { token: e.id }); await flush();
  };
  const release = async () => {
    holdGlobal = false; holdScoped = false;
    for (const next of deferred.splice(0)) next();
    await flush();
  };
  let result: { events: number; coverage: Record<string, number>; nativeEvents: number; notificationDeliveries: number } | undefined;
  try {
    await client.connect(initialize); register("a"); register("b");
    for (const event of events) {
      count(event.type);
      switch (event.type) {
        case "wire": await emit(); break;
        case "hold-global": holdGlobal = true; break;
        case "hold-scoped": holdScoped = true; break;
        case "release": await release(); break;
        case "rotate-a": register("a"); break;
        case "rotate-b": register("b"); break;
        case "remove-a": case "remove-b": {
          const slot = event.type === "remove-a" ? "a" : "b", r = active.get(slot);
          if (r) retire({ registration: r, remove: r.remove }); break;
        }
        case "old-token-a": case "old-token-b": {
          const slot = event.type === "old-token-a" ? "a" : "b";
          // The oldest handle deliberately survives arbitrarily many replacements.
          const token = tokens[slot][0]; if (token) retire(token); break;
        }
        case "dedup-a": register("a", true); break;
        case "loss": lose(); await flush(); break;
        case "connect": if (!connected) { await Promise.all(asynchronousCloses); await client.connect(initialize); connected = true; count("effective-connect"); } break;
        case "reenter-self": reentry = "self"; break;
        case "reenter-peer": reentry = "peer"; break;
        case "reenter-loss": reentry = "loss"; break;
        case "bad-listener": bad.add("a"); bad.add("b"); break;
      }
      inspect();
    }
    // A fair suffix releases current continuations and sends one fresh input.
    await release(); await Promise.all(asynchronousCloses);
    if (!connected) { await client.connect(initialize); connected = true; count("healthy-suffix-connect"); }
    reentry = undefined; await emit(); inspect();
    result = { events: events.length + 1, coverage, nativeEvents: sequence, notificationDeliveries };
  } catch (error) { primary = error; }
  try {
    removeGate(); removeError(); for (const slot of ["a", "b"] as const) for (const token of tokens[slot]) token.remove();
    await Promise.all(asynchronousCloses); await client.close();
  } catch (error) {
    if (primary instanceof ChaosViolation) primary.cleanupFailure = error instanceof Error ? error.message : String(error);
    else primary ??= error;
  }
  if (primary) throw primary;
  return result!;
}
