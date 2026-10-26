import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { ChaosViolation, requireThat } from "./recovery-chaos";

export type RetirementMutant = "rearm-old-loss" | "drop-current-loss" | "orphan-connect" | "replay-request";
export interface RetirementEvent { type: "connect" | "renew" | "renew-sample" | "close" | "loss" | "hold" | "reply" | "cancel" | "echo" | "new-loss" | "old-close" | "abort" | "heal"; pick?: number }
const kinds: RetirementEvent["type"][] = ["connect", "renew", "renew-sample", "close", "loss", "hold", "reply", "cancel", "echo", "new-loss", "old-close", "abort", "heal"];
export function parseRetirementTrace(value: unknown): RetirementEvent[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid retirement trace");
  return value.map(e => {
    if (!e || typeof e !== "object" || !kinds.includes(e.type) || (e.pick !== undefined && (!Number.isSafeInteger(e.pick) || e.pick < 0))) throw Error("Invalid retirement event");
    return e as RetirementEvent;
  });
}
export function generateRetirementChaos(seed: number, steps = 120): RetirementEvent[] {
  let state = seed >>> 0; const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const weighted: RetirementEvent["type"][] = ["connect", "connect", "renew", "renew", "renew-sample", "renew-sample", "close", "loss", "hold", "hold", "reply", "cancel", "echo", "echo", "new-loss", "old-close", "abort"];
  const events: RetirementEvent[] = [];
  for (let i = 0; i < steps; i++) events.push({ type: weighted[next() % weighted.length]!, pick: next() });
  events.push({ type: "heal" }); return events;
}
type Outcome = "pending" | "resolved" | "rejected";
interface Call { kind: "connect" | "rpc"; actual: Outcome; value?: unknown; expected: Outcome; nonce?: number; expectedWire?: number; controller?: AbortController; wire?: { id: unknown; peer: InMemoryAppServerPeer; frame: string } }
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

/** Composed actual Client + actual MemoryTransport. Epochs and expected intent
 * outcomes come from the controlled server, not Client-private state. */
export async function simulateClientRetirement(events: readonly RetirementEvent[], options: { mutant?: RetirementMutant } = {}) {
  let ready = false, measuring = true, holdInit = false, dropLoss = false, sourceRetired = true, sequence = 0;
  let nativeEvents = 0, nativeAdmissions = 0, nativeInitializations = 0, rpcFrames = 0, statusSamples = 0;
  const peers: InMemoryAppServerPeer[] = [], calls: Call[] = [], requests = new Map<number, Call>(), wires = new Map<number, number>();
  const listeners = new Set<(s: TransportStatus) => void>(), coverage: Record<string, number> = {};
  const count = (key: string) => { if (measuring) coverage[key] = (coverage[key] ?? 0) + 1; };
  const input = () => { if (measuring) nativeEvents++; };
  const raw = new MemoryTransport({ connected(peer) { peers.push(peer); if (measuring) nativeAdmissions++; input(); }, disconnected() { input(); }, receive(frame, peer) {
    const message = JSON.parse(frame);
    if (message.method === "initialize") {
      if (measuring) nativeInitializations++;
      if (holdInit) { holdInit = false; return; }
      input(); peer.send(JSON.stringify({ id: message.id, result: { codexHome: `/native-${peers.indexOf(peer) + 1}`, platformFamily: "unix", platformOs: "linux", userAgent: "retirement-chaos" } })); return;
    }
    if (measuring) rpcFrames++;
    const nonce = message.params.nonce as number; wires.set(nonce, (wires.get(nonce) ?? 0) + 1);
    const call = requests.get(nonce);
    if (call && !call.wire) call.wire = { id: message.id, peer, frame };
    if (message.method !== "held") { input(); peer.send(JSON.stringify({ id: message.id, result: message.params })); }
  } });
  const bridge: DuplexTransport = {
    get status() { return raw.status; }, connect: signal => raw.connect(signal), send: frame => raw.send(frame), close: () => raw.close(), subscribeMessage: l => raw.subscribeMessage(l),
    subscribeStatus(listener) {
      listeners.add(listener); let setup = true;
      const remove = raw.subscribeStatus(status => {
        const terminal = ["closing", "closed", "failed"].includes(status.state);
        if (setup && measuring) statusSamples++;
        if (options.mutant === "rearm-old-loss" && terminal && sourceRetired) { count("corrupt-old-loss-rearm"); listener({ state: "connecting" }); }
        if (status.state === "connecting" || status.state === "open") sourceRetired = false;
        if (terminal) sourceRetired = true;
        if (dropLoss && terminal && options.mutant === "drop-current-loss") { count("corrupt-current-loss-delivery"); return; }
        listener(status);
      }); setup = false;
      return () => { listeners.delete(listener); remove(); };
    },
  };
  const client = new JsonRpcAppServerClient({ hostId: "retirement-chaos", transport: bridge, requestTimeoutMs: 0 });
  const params = { clientInfo: { name: "retirement-chaos", version: "1" } };
  const observe = (promise: Promise<unknown>, call: Call, corrupt = false) => {
    const watched = corrupt ? promise.then(() => new Promise<unknown>(() => {})) : promise;
    void watched.then(value => { call.actual = "resolved"; call.value = value; }, error => { call.actual = "rejected"; call.value = error; });
    calls.push(call); return call;
  };
  const retire = () => { ready = false; for (const c of calls) if (c.expected === "pending") c.expected = "rejected"; };
  const begin = () => observe(client.connect(params), { kind: "connect", actual: "pending", expected: "resolved" }, options.mutant === "orphan-connect");
  const check = () => {
    for (const [nonce, call] of requests) requireThat((wires.get(nonce) ?? 0) === call.expectedWire, "RETIREMENT_WIRE_ONCE", "one native submission per admitted RPC intent, no retired replay");
    for (const call of calls) requireThat(call.actual === call.expected, call.kind === "connect" ? "RETIREMENT_CONNECT_PROGRESS" : "RETIREMENT_RPC_SETTLEMENT", `${call.kind} ${call.actual} != ${call.expected}`);
    requireThat((client.initializeResult !== null) === ready, "RETIREMENT_READINESS", "readiness must match the current admitted native activity");
    if (ready) requireThat(client.initializeResult!.codexHome === `/native-${peers.length}`, "RETIREMENT_READY_OWNER", "initialization must name the current server peer");
    requireThat(client.getPendingRequestCount() === calls.filter(c => c.kind === "rpc" && c.expected === "pending").length, "RETIREMENT_PENDING", "no hidden initialization or retired RPC remains pending");
  };
  const connect = async (renew: boolean, sample = false) => {
    const wasReady = ready, beforeGeneration = client.connectionGeneration, beforeInit = nativeInitializations;
    let closing: Promise<void> | undefined;
    if (renew) { retire(); closing = raw.close(); count("overlapping-close-connect"); }
    const call = begin();
    if (sample) queueMicrotask(() => {
      const status = raw.status;
      if (["closing", "closed", "failed"].includes(status.state)) { if (measuring) statusSamples++; count("repeated-terminal-sample"); for (const l of listeners) l(status); }
    });
    await flush();
    requireThat(call.actual === "resolved", "RETIREMENT_CONNECT_PROGRESS", "healthy connect must finish without an extra retry or waiting for an old terminal chain");
    ready = true;
    requireThat(client.connectionGeneration === beforeGeneration + Number(renew || !wasReady), "RETIREMENT_GENERATION", "one initialization generation per fresh connect");
    requireThat(nativeInitializations === beforeInit + Number(renew || !wasReady), "RETIREMENT_INITIALIZE_ONCE", "no hidden retry or duplicate initialization");
    await closing;
    if (renew && options.mutant === "replay-request") {
      const old = calls.find(c => c.kind === "rpc" && c.expected === "rejected" && c.wire);
      if (old?.wire) { count("corrupt-retired-replay"); await raw.send(old.wire.frame); await flush(); }
    }
  };
  let failure: unknown;
  try {
    for (const event of events) {
      if (event.type === "connect" || event.type === "heal") { if (event.type === "heal") count("explicit-heal"); await connect(false); }
      else if (event.type === "renew" || event.type === "renew-sample") await connect(true, event.type === "renew-sample");
      else if (event.type === "close") { retire(); await raw.close(); }
      else if (event.type === "loss") { if (peers.length && ready) { retire(); input(); peers.at(-1)!.close("controlled current loss"); } }
      else if (event.type === "old-close") { const old = peers[(event.pick ?? 0) % Math.max(1, peers.length - 1)]; if (old && old !== peers.at(-1)) { input(); count("retired-peer-close"); old.close("controlled old loss"); } }
      else if (event.type === "hold" || event.type === "echo") {
        if (event.type === "hold" && (!ready || calls.filter(c => c.expected === "pending").length >= 16)) continue;
        const nonce = ++sequence, controller = new AbortController();
        const call: Call = { kind: "rpc", actual: "pending", expected: ready ? event.type === "hold" ? "pending" : "resolved" : "rejected", nonce, expectedWire: Number(ready), controller };
        requests.set(nonce, call); observe(client.requestRaw(event.type === "hold" ? "held" : "echo", { nonce }, { signal: controller.signal }), call);
        await flush(); if (ready && event.type === "echo") requireThat(JSON.stringify(call.value) === JSON.stringify({ nonce }), "RETIREMENT_RPC_VALUE", "echo must match its own request");
      } else if (event.type === "reply" || event.type === "cancel") {
        const held = calls.filter(c => c.kind === "rpc" && c.controller); const call = held[(event.pick ?? 0) % held.length];
        if (call) {
          if (event.type === "cancel") { if (call.expected === "pending") call.expected = "rejected"; call.controller!.abort(); }
          else if (call.wire) { input(); if (call.expected === "pending" && call.wire.peer === peers.at(-1) && ready) call.expected = "resolved"; else count("late-retired-reply"); call.wire.peer.send(JSON.stringify({ id: call.wire.id, result: { nonce: call.nonce } })); }
        }
      } else if (event.type === "abort") {
        const controller = new AbortController(); controller.abort(); const call = observe(client.connect(params, controller.signal), { kind: "connect", actual: "pending", expected: "rejected" }); await flush();
        requireThat((call.value as { code?: string })?.code === "ABORTED", "RETIREMENT_CANCEL_OWNER", "explicit cancellation retains its cause");
      } else if (event.type === "new-loss") {
        retire(); const closing = raw.close(); holdInit = true; const call = begin(); call.expected = "pending"; await flush();
        requireThat(call.actual === "pending" && client.getPendingRequestCount() === 1, "RETIREMENT_NEW_ADMISSION", "new initialization reaches its own held native reply");
        call.expected = "rejected"; dropLoss = true; input(); peers.at(-1)!.close("new native loss"); await flush(); dropLoss = false;
        requireThat(call.actual === "rejected", "RETIREMENT_CURRENT_LOSS", "a genuinely new native loss must retire its initialization"); await closing; count("new-native-loss");
      }
      await flush(); check();
    }
  } catch (error) { failure = error; }
  finally {
    measuring = false; dropLoss = false; holdInit = false;
    try {
      await client.close(); await flush();
      const pending = calls.some(c => c.actual === "pending");
      if (pending && !(failure instanceof ChaosViolation && failure.rule === "RETIREMENT_CONNECT_PROGRESS")) {
        if (failure instanceof ChaosViolation) failure.cleanupFailure = "owned promise remained pending after Client close";
        else if (failure === undefined) failure = new ChaosViolation("RETIREMENT_CONNECT_PROGRESS", "cleanup must settle existing operations");
      }
      requireThat(client.getPendingRequestCount() === 0, "RETIREMENT_PENDING", "cleanup leaves no pending RPC");
    } catch (error) { if (failure === undefined) failure = error; else if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error); }
  }
  if (failure !== undefined) throw failure;
  return { events: events.length, nativeEvents, nativeAdmissions, nativeInitializations, rpcFrames, rpcIntents: calls.filter(c => c.kind === "rpc").length,
    connectIntents: calls.filter(c => c.kind === "connect").length, connectSettled: calls.filter(c => c.kind === "connect" && c.actual !== "pending").length, statusSamples, coverage };
}
