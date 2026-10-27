import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { RecordingTransport } from "@opencraft/appserver-transport-replay";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { ChaosViolation, requireThat } from "./recovery-chaos";

export type RecordingMutant = "sample-echo" | "retarget-cleanup" | "orphan-rpc";
export interface RecordingEvent { type: "connect" | "renew" | "close" | "hold" | "reply" | "echo" | "status-noise" | "message-noise" | "sink-noise" | "sample" | "old-token" | "old-close" | "frame-reentry" | "abort" | "heal"; pick?: number }
const kinds: RecordingEvent["type"][] = ["connect", "renew", "close", "hold", "reply", "echo", "status-noise", "message-noise", "sink-noise", "sample", "old-token", "old-close", "frame-reentry", "abort", "heal"];
export function parseRecordingTrace(value: unknown): RecordingEvent[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid recording trace");
  return value.map(e => {
    if (!e || typeof e !== "object" || !kinds.includes(e.type) || (e.pick !== undefined && (!Number.isSafeInteger(e.pick) || e.pick < 0))) throw Error("Invalid recording event");
    return e as RecordingEvent;
  });
}
export function generateRecordingChaos(seed: number, steps = 120): RecordingEvent[] {
  let state = seed >>> 0; const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const weighted: RecordingEvent["type"][] = ["connect", "renew", "renew", "close", "hold", "hold", "reply", "echo", "echo", "status-noise", "message-noise", "sink-noise", "sample", "old-token", "old-close", "frame-reentry", "abort"];
  const trace: RecordingEvent[] = [];
  for (let i = 0; i < steps; i++) trace.push({ type: weighted[next() % weighted.length]!, pick: next() });
  trace.push({ type: "heal" }); return trace;
}
type Outcome = "pending" | "resolved" | "rejected";
interface Call { kind: "connect" | "rpc"; actual: Outcome; expected: Outcome; nonce?: number; value?: unknown; wire?: { id: unknown; peer: InMemoryAppServerPeer }; controller?: AbortController }
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

/** Actual Recording + Client + Memory; oracle owns native frames, registrations
 * and intent outcomes, and never reads production private fields. */
export async function simulateRecordingLifetime(events: readonly RecordingEvent[], options: { mutant?: RecordingMutant } = {}) {
  let ready = false, measuring = true, badStatus = false, badMessage = false, badSink = false, sequence = 0;
  let reenterStatus = false, reenterFrame = false, nativeEvents = 0, nativeAdmissions = 0, received = 0, messageDeliveries = 0, cleanupCalls = 0, statusSamples = 0;
  let reentryClose: Promise<void> | undefined, reentryConnect: Promise<void> | undefined;
  const peers: InMemoryAppServerPeer[] = [], calls: Call[] = [], requests = new Map<number, Call>(), wires = new Map<number, number>(), coverage: Record<string, number> = {};
  const nativeStatuses: string[] = [], observedStatuses: string[] = [], removers = new Set<() => void>();
  let latestRemove: (() => void) | undefined;
  const count = (key: string) => { if (measuring) coverage[key] = (coverage[key] ?? 0) + 1; };
  const input = () => { if (measuring) nativeEvents++; };
  const raw = new MemoryTransport({ connected(peer) { peers.push(peer); if (measuring) nativeAdmissions++; input(); }, disconnected() { input(); }, receive(frame, peer) {
    const m = JSON.parse(frame); if (measuring) received++;
    if (m.method === "initialize") { input(); peer.send(JSON.stringify({ id: m.id, result: { codexHome: `/recording-${peers.length}`, platformFamily: "unix", platformOs: "linux", userAgent: "recording-chaos" } })); return; }
    const call = requests.get(m.params.nonce); if (call) call.wire = { id: m.id, peer };
    wires.set(m.params.nonce, (wires.get(m.params.nonce) ?? 0) + 1);
    if (m.method !== "held") { input(); peer.send(JSON.stringify({ id: m.id, result: m.params })); }
  } });
  const removeNativeStatus = raw.subscribeStatus(s => nativeStatuses.push(s.state));
  const bridge: DuplexTransport = {
    get status() { return raw.status; }, connect: signal => raw.connect(signal), send: (frame, signal) => raw.send(frame, signal), close: () => raw.close(),
    subscribeStatus: listener => raw.subscribeStatus(listener),
    subscribeMessage(listener) {
      const removeRaw = raw.subscribeMessage(frame => { if (measuring) messageDeliveries++; listener(frame); });
      const release = () => { if (!removers.delete(release)) return; if (measuring) cleanupCalls++; removeRaw(); };
      removers.add(release); latestRemove = release;
      return () => (options.mutant === "retarget-cleanup" ? latestRemove : release)?.();
    },
  };
  const recording = new RecordingTransport({ transport: bridge, sink() { if (badSink) { count("sink-exception"); throw Error("controlled sink"); } } });
  recording.subscribeStatus(s => {
    if (reenterStatus && s.state === "closing") { reenterStatus = false; reentryConnect = recording.connect(); count("status-reentry"); }
    if (badStatus && ["closing", "closed", "failed"].includes(s.state)) { count("status-exception"); throw Error("controlled status observer"); }
  });
  const removeObservedStatus = recording.subscribeStatus(s => { observedStatuses.push(s.state); if (options.mutant === "sample-echo" && s.state === "open") observedStatuses.push(s.state); });
  recording.subscribeMessage(() => {
    if (reenterFrame) { reenterFrame = false; ready = false; retire(); reentryClose = recording.close(); reentryConnect = recording.connect(); count("message-reentry"); }
    if (badMessage) { count("message-exception"); throw Error("controlled message observer"); }
  });
  const client = new JsonRpcAppServerClient({ hostId: "recording-chaos", transport: recording, requestTimeoutMs: 0 });
  const params = { clientInfo: { name: "recording-chaos", version: "1" } };
  function retire() { ready = false; for (const call of calls) if (call.expected === "pending") call.expected = "rejected"; }
  const observe = (promise: Promise<unknown>, call: Call, corrupt = false) => {
    const watched = corrupt ? promise.then(() => new Promise<unknown>(() => {})) : promise;
    void watched.then(value => { call.actual = "resolved"; call.value = value; }, error => { call.actual = "rejected"; call.value = error; }); calls.push(call); return call;
  };
  const check = () => {
    requireThat(JSON.stringify(observedStatuses) === JSON.stringify(nativeStatuses), "RECORDING_STATUS_SOURCE", "only native publications and this subscriber's one initial sample");
    for (const call of calls) requireThat(call.actual === call.expected, call.kind === "connect" ? "RECORDING_CONNECT_PROGRESS" : "RECORDING_RPC_SETTLEMENT", `${call.kind} ${call.actual} != ${call.expected}`);
    for (const [nonce, call] of requests) requireThat((wires.get(nonce) ?? 0) === Number(call.wire !== undefined), "RECORDING_WIRE_ONCE", "each admitted intent is submitted once");
    requireThat((client.initializeResult !== null) === ready, "RECORDING_READINESS", "current native readiness");
    if (ready) requireThat(client.initializeResult!.codexHome === `/recording-${peers.length}`, "RECORDING_READY_OWNER", "current native peer owns initialization");
    requireThat(recording.recording.length === received + messageDeliveries, "RECORDING_FRAME_CONSERVATION", "one record per outgoing attempt or admitted incoming native frame");
  };
  const connect = async (renew: boolean) => {
    let closing: Promise<void> | undefined;
    if (renew) {
      retire(); reenterStatus = true; closing = recording.close();
      // Memory publishes closing synchronously when there is live work. A close
      // from idle/closed has no such callback; do not arm a later unrelated close.
      reenterStatus = false; count("overlapping-close-connect");
    }
    const call = observe(client.connect(params), { kind: "connect", actual: "pending", expected: "resolved" });
    await flush(); requireThat(call.actual === "resolved", "RECORDING_CONNECT_PROGRESS", "usable connection without retry or old cleanup retargeting");
    ready = true; await closing; await reentryConnect; reentryConnect = undefined; await flush();
  };
  const rpc = async (held: boolean, expected?: Outcome) => {
    if (held && (!ready || calls.filter(c => c.expected === "pending").length >= 16)) return;
    const nonce = ++sequence, controller = new AbortController();
    const call: Call = { kind: "rpc", actual: "pending", expected: expected ?? (ready ? held ? "pending" : "resolved" : "rejected"), nonce, controller };
    requests.set(nonce, call); observe(client.requestRaw(held ? "held" : "echo", { nonce }, { signal: controller.signal }), call, !held && ready && options.mutant === "orphan-rpc");
    await flush(); return call;
  };
  let failure: unknown;
  try {
    for (const event of events) {
      if (event.type === "connect" || event.type === "renew" || event.type === "heal") {
        if (event.type === "heal") count("explicit-heal"); await connect(event.type === "renew");
        if (event.type === "heal") await rpc(false);
      } else if (event.type === "close") { retire(); await recording.close(); }
      else if (event.type === "hold" || event.type === "echo") await rpc(event.type === "hold");
      else if (event.type === "status-noise") badStatus = !badStatus;
      else if (event.type === "message-noise") badMessage = !badMessage;
      else if (event.type === "sink-noise") badSink = !badSink;
      else if (event.type === "sample") {
        const sample: TransportStatus[] = []; const remove = recording.subscribeStatus(s => sample.push(s)); remove(); if (measuring) statusSamples++;
        requireThat(sample.length === 1 && sample[0] === raw.status, "RECORDING_INITIAL_SAMPLE", "only this registration receives the native initial snapshot");
      } else if (event.type === "old-token") {
        let seen = 0; const listener = () => { seen++; }; const old = recording.subscribeMessage(listener); old(); const current = recording.subscribeMessage(listener); old();
        if (ready) { await rpc(false); requireThat(seen === 1, "RECORDING_REGISTRATION_OWNER", "old token cannot remove the replacement callback"); count("stale-message-token"); } current();
      } else if (event.type === "reply") {
        const held = calls.filter(c => c.wire); const call = held[(event.pick ?? 0) % held.length];
        if (call?.wire) { input(); if (ready && call.wire.peer === peers.at(-1) && call.expected === "pending") call.expected = "resolved"; else count("late-retired-reply");
          call.wire.peer.send(JSON.stringify({ id: call.wire.id, result: { nonce: call.nonce } })); }
      } else if (event.type === "old-close") {
        const peer = peers[(event.pick ?? 0) % Math.max(1, peers.length - 1)]; if (peer && peer !== peers.at(-1)) { input(); count("old-peer-close"); peer.close(); }
      } else if (event.type === "frame-reentry" && ready) {
        reenterFrame = true; await rpc(false, "rejected"); await reentryClose; await reentryConnect; reentryClose = undefined; reentryConnect = undefined; await connect(false);
      } else if (event.type === "abort") {
        const controller = new AbortController(); controller.abort(); observe(client.connect(params, controller.signal), { kind: "connect", actual: "pending", expected: "rejected" });
      }
      await flush(); check();
    }
  } catch (error) { failure = error; }
  finally {
    measuring = false; badStatus = badMessage = badSink = reenterStatus = reenterFrame = false;
    try {
      await client.close(); await flush();
      requireThat(client.getPendingRequestCount() === 0, "RECORDING_PENDING", "cleanup settles existing native RPC work");
      // The harness also owns the deliberately corrupted adapter registrations.
      for (const remove of [...removers]) remove(); removeObservedStatus(); removeNativeStatus();
    } catch (error) { if (failure === undefined) failure = error; else if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error); }
  }
  if (failure !== undefined) throw failure;
  return { events: events.length, nativeEvents, nativeAdmissions, messageDeliveries, cleanupCalls, statusSamples, recordedFrames: recording.recording.length,
    rpcIntents: calls.filter(c => c.kind === "rpc").length, rpcFrames: [...wires.values()].reduce((a, b) => a + b, 0),
    connectIntents: calls.filter(c => c.kind === "connect").length, connectSettled: calls.filter(c => c.kind === "connect" && c.actual !== "pending").length, coverage };
}
