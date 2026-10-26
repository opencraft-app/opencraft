import { JsonRpcAppServerClient, type AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { executionChannelsFixture, flush } from "./execution-channels";
import { ChaosViolation, recoveryChaosRandom, requireThat } from "./recovery-chaos";

const types = ["error", "request", "rotate-da", "rotate-db", "rotate-la", "rotate-lb", "remove-da", "remove-la", "old-da", "old-la", "dedup-da", "dedup-la", "reenter-self", "reenter-peer", "reenter-cancel", "reenter-close", "throw-observer", "pad"] as const;
export type ObserverChaosEvent = { type: typeof types[number] };
export type ObserverChaosMutant = "live-admission" | "stale-token" | "drop-terminal";
export function parseObserverTrace(value: unknown): ObserverChaosEvent[] {
  if (!Array.isArray(value) || value.length > 10001) throw Error("Invalid observer trace");
  return value.map(e => { if (!e || !types.includes(e.type)) throw Error("Invalid observer event"); return { type: e.type }; });
}
export function generateObserverChaos(seed: number, steps = 120): ObserverChaosEvent[] {
  const random = recoveryChaosRandom(seed);
  return Array.from({ length: steps }, () => ({ type: types[Math.floor(random() * types.length)]! }));
}

/** Real Client, two diagnostic and two lifecycle consumers. An inert first
 * subscriber records each actual emission's admission cut before scripted
 * consumers run. No private registry state or synthetic extra input is read. */
export async function simulateObserverAdmission(events: readonly ObserverChaosEvent[], options: { mutant?: ObserverChaosMutant } = {}) {
  const f = executionChannelsFixture(), client = new JsonRpcAppServerClient({ hostId: "observers", transport: f.transport });
  await client.connect({ clientInfo: { name: "observer-admission-chaos", version: "1" } });
  type Key = "da" | "db" | "la" | "lb";
  type Value = Error | AppServerRequestLifecycleEvent;
  type Registration = { id: number; key: Key; remove: () => void };
  type Token = { registration: Registration; remove: () => void };
  type Observed = { value: Value; admission: Map<Key, Registration>; delivered: Set<number>; terminal: boolean };
  const keys: Key[] = ["da", "db", "la", "lb"], active = new Map<Key, Registration>();
  const tokens = Object.fromEntries(keys.map(k => [k, []])) as Record<Key, Token[]>;
  const observed: Observed[] = [], byValue = new WeakMap<Value, Observed>(), bad = new Set<Key>();
  const coverage: Record<string, number> = {}, closing: Promise<void>[] = [];
  let sequence = 0, nativeErrors = 0, rpcIntents = 0, rpcFrames = 0, observerDeliveries = 0;
  let closed = false, primary: unknown, inCallback: Value | undefined;
  let reentry: "self" | "peer" | "cancel" | "close" | undefined;
  let currentIntent: { controller: AbortController; frames: number; cancelled: boolean; closed: boolean } | undefined;
  const count = (key: string) => { coverage[key] = (coverage[key] ?? 0) + 1; };
  const fail = (rule: string, message: string) => { primary ??= new ChaosViolation(rule, message); };
  const terminal = (v: Value) => !(v instanceof Error) && ["completed", "failed", "aborted", "timed-out"].includes(v.type);
  const capture = (value: Value, lane: "d" | "l") => {
    const e: Observed = { value, admission: new Map([...active].filter(([key]) => key.startsWith(lane))), delivered: new Set(), terminal: terminal(value) };
    observed.push(e); byValue.set(value, e); count(lane === "d" ? "diagnostic-emission" : "lifecycle-emission");
  };
  const removeCapture = [client.subscribeProtocolError(e => capture(e, "d")), client.subscribeRequestLifecycle(e => capture(e, "l"))];
  const send = f.transport.send.bind(f.transport);
  f.transport.send = (frame, signal) => {
    if (JSON.parse(frame).method === "fixture/observer-chaos") {
      rpcFrames++;
      if (!currentIntent || ++currentIntent.frames > 1 || currentIntent.cancelled || currentIntent.closed) fail("OBSERVER_RPC_ADMISSION", "observer reentry admitted a duplicate or retired native request");
    }
    return send(frame, signal);
  };
  const close = () => {
    if (closed) return; closed = true;
    if (currentIntent) currentIntent.closed = true;
    // close publishes pending-request termination before clearing its observers.
    const before = observed.length;
    closing.push(client.close().catch(error => { primary ??= error; }));
    for (const e of observed.slice(before)) if (e.terminal) for (const [key, r] of e.admission) {
      if (active.get(key) === r && !e.delivered.has(r.id)) fail("OBSERVER_TERMINAL", "close cannot hide a lost termination by subsequently retiring its observers");
    }
    active.clear(); count("effective-close");
  };
  const retire = (token: Token) => {
    const current = active.get(token.registration.key);
    if (current === token.registration) active.delete(token.registration.key);
    else if (current) count("old-token-with-successor");
    if (options.mutant === "stale-token" && current && current !== token.registration) current.remove();
    else token.remove();
  };
  const callbacks = Object.fromEntries(keys.map(key => [key, (value: Value) => {
    if (options.mutant === "drop-terminal" && key.startsWith("l") && terminal(value)) return;
    receive(key, value);
  }])) as Record<Key, (value: Value) => void>;
  const subscribe = (key: Key) => key.startsWith("d") ? client.subscribeProtocolError(callbacks[key]) : client.subscribeRequestLifecycle(callbacks[key]);
  function register(key: Key, duplicate = false) {
    const previous = active.get(key);
    if (previous && !duplicate) retire({ registration: previous, remove: previous.remove });
    const r = duplicate && previous ? previous : { id: ++sequence, key, remove: () => {} };
    active.set(key, r); const remove = subscribe(key);
    if (!duplicate || !previous) r.remove = remove;
    tokens[key].push({ registration: r, remove }); count(duplicate && previous ? "effective-dedup" : "registration");
    if (inCallback && options.mutant === "live-admission" && !primary) callbacks[key](inCallback);
  }
  function receive(key: Key, value: Value) {
    if (primary) return;
    const e = byValue.get(value), r = active.get(key);
    if (!e || !r || e.admission.get(key) !== r) { fail("OBSERVER_ADMISSION", "a replacement inherited an already-admitted observer event"); return; }
    if (e.delivered.has(r.id)) { fail("OBSERVER_ONCE", "one emission repeatedly visited its registration"); return; }
    e.delivered.add(r.id); observerDeliveries++; count(`delivery-${key}`);
    const before = inCallback; inCallback = value;
    try {
      const action = reentry;
      const cancellable = currentIntent && !(value instanceof Error) && (value.type === "queued" || value.type === "started");
      if (action !== "cancel" || cancellable) reentry = undefined;
      if (action === "self") { count("effective-self-reentry"); register(key); }
      if (action === "peer") { count("effective-peer-reentry"); register((key[0] + (key[1] === "a" ? "b" : "a")) as Key); }
      if (action === "cancel" && cancellable) { count("effective-cancel-reentry"); currentIntent!.cancelled = true; currentIntent!.controller.abort(); }
      if (action === "close") { count("effective-close-reentry"); close(); }
    } finally { inCallback = before; }
    if (bad.delete(key)) { count("isolated-observer-throw"); throw Error("Synthetic isolated observer failure"); }
  }
  const removeSource = client.subscribeNotification(() => { throw Error("Synthetic observer diagnostic source"); });
  const inspect = () => {
    if (primary) throw primary;
    for (const e of observed) for (const [key, r] of e.admission) if (active.get(key) === r) {
      requireThat(e.delivered.has(r.id), e.terminal ? "OBSERVER_TERMINAL" : "OBSERVER_CONSERVED", "a current admitted observer lost its event");
    }
    requireThat((coverage["diagnostic-emission"] ?? 0) === nativeErrors, "OBSERVER_SOURCE", "observer exceptions must not create extra diagnostic emissions");
    requireThat(client.getPendingRequestCount() === 0 && f.reads === 0 && f.activations === 0 && f.replies.length === 0, "OBSERVER_RPC_SETTLEMENT", "observer dispatch must preserve read-only request settlement without execution or native answers");
  };
  async function request() {
    if (closed) return; rpcIntents++;
    const intent = { controller: new AbortController(), frames: 0, cancelled: false, closed: false }; currentIntent = intent;
    try {
      await client.requestRaw("fixture/observer-chaos", {}, { signal: intent.controller.signal });
      requireThat(!intent.cancelled && !intent.closed && intent.frames === 1, "OBSERVER_RPC_RESULT", "a successful request must own exactly one frame");
    } catch (error) {
      const code = (error as { code?: string }).code;
      requireThat((intent.cancelled && code === "ABORTED") || (intent.closed && code === "CLOSED"), "OBSERVER_RPC_RESULT", "observer failure cannot fail an otherwise current request");
      requireThat(intent.frames === 0, "OBSERVER_RPC_ADMISSION", "synchronous queued/started retirement cannot cross native admission");
    } finally { currentIntent = undefined; }
    await flush();
  }
  let result: { events: number; coverage: Record<string, number>; observerEvents: number; observerDeliveries: number; nativeEvents: number; rpcIntents: number; rpcFrames: number } | undefined;
  try {
    for (const key of keys) register(key);
    for (const event of events) {
      count(event.type);
      if (event.type === "error" && !closed) { nativeErrors++; f.emit("fixture/observer-error", {}); await flush(); }
      else if (event.type === "request") await request();
      else if (event.type.startsWith("rotate-")) register(event.type.slice(7) as Key);
      else if (event.type.startsWith("remove-")) { const r = active.get(event.type.slice(7) as Key); if (r) retire({ registration: r, remove: r.remove }); }
      else if (event.type.startsWith("old-")) { const token = tokens[event.type.slice(4) as Key][0]; if (token) retire(token); }
      else if (event.type.startsWith("dedup-")) register(event.type.slice(6) as Key, true);
      else if (event.type === "reenter-self") reentry = "self";
      else if (event.type === "reenter-peer") reentry = "peer";
      else if (event.type === "reenter-cancel") reentry = "cancel";
      else if (event.type === "reenter-close") reentry = "close";
      else if (event.type === "throw-observer") for (const key of keys) bad.add(key);
      inspect();
    }
    reentry = undefined; await request(); inspect();
    result = { events: events.length + 1, coverage, observerEvents: observed.length, observerDeliveries, nativeEvents: nativeErrors, rpcIntents, rpcFrames };
  } catch (error) { primary = error; }
  try { removeSource(); for (const remove of removeCapture) remove(); for (const key of keys) for (const token of tokens[key]) token.remove(); await Promise.all(closing); await client.close(); }
  catch (error) { if (primary instanceof ChaosViolation) primary.cleanupFailure = String(error); else primary ??= error; }
  if (primary) throw primary;
  return result!;
}
