import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { ChaosViolation, requireThat } from "./recovery-chaos";

export type MemoryChaosMutant = "orphan-connect" | "stale-peer" | "cleanup-retarget";
export interface MemoryChaosEvent {
  type: "begin" | "admit" | "fail" | "abort" | "close" | "peer-close" | "frame" | "flush" | "ack" | "heal";
  target?: "current" | "old" | "any";
  pick?: number;
}
const kinds: MemoryChaosEvent["type"][] = ["begin", "admit", "fail", "abort", "close", "peer-close", "frame", "flush", "ack", "heal"];
export function parseMemoryTrace(value: unknown): MemoryChaosEvent[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid memory trace");
  return value.map(event => {
    if (!event || typeof event !== "object" || !kinds.includes(event.type) ||
      (event.target !== undefined && !["current", "old", "any"].includes(event.target)) ||
      (event.pick !== undefined && (!Number.isSafeInteger(event.pick) || event.pick < 0))) throw Error("Invalid memory event");
    return event as MemoryChaosEvent;
  });
}
export function generateMemoryChaos(seed: number, steps = 120): MemoryChaosEvent[] {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const weighted: MemoryChaosEvent["type"][] = ["begin", "begin", "admit", "admit", "fail", "abort", "close", "peer-close", "frame", "frame", "flush", "ack", "ack"];
  const events: MemoryChaosEvent[] = [];
  for (let i = 0; i < steps; i++) events.push({ type: weighted[next() % weighted.length]!, target: (["current", "old", "any"] as const)[next() % 3], pick: next() });
  events.push({ type: "heal" }); // Progress is a saved input, never an implicit suffix.
  return events;
}
function held() {
  let resolve!: () => void, reject!: (cause: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
type Outcome = "pending" | "resolved" | "rejected";
type Phase = "idle" | "connecting" | "open" | "closing" | "closed" | "failed";
interface Owner { epoch: number; retired: boolean; admission: Outcome; controller: AbortController; close?: Outcome }
interface Native { owner: Owner; peer: InMemoryAppServerPeer; admission: ReturnType<typeof held>; cleanup: ReturnType<typeof held>; cleanups: number; acked: boolean }
interface Call { owner: Owner; controller?: AbortController; expected: Outcome; actual: Outcome }
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

/** Actual MemoryTransport, controlled server hooks/scheduler, and an independent
 * intent/epoch oracle. No transport-private state or wall clock is inspected. */
export async function simulateMemoryGenerations(events: readonly MemoryChaosEvent[], options: { mutant?: MemoryChaosMutant } = {}) {
  let phase: Phase = "idle", current: Owner | undefined, epoch = 0, measuring = true;
  let nativeEvents = 0, nativeAdmissions = 0, cleanupCalls = 0, messageDeliveries = 0, frameSequence = 0;
  const natives: Native[] = [], peers = new Map<InMemoryAppServerPeer, Native>();
  const connects: Call[] = [], closes: Call[] = [], callbacks: (() => void)[] = [], expectedQueue: { epoch: number; frame: string }[] = [], delivered: string[] = [];
  const coverage: Record<string, number> = {};
  const count = (key: string) => { if (measuring) coverage[key] = (coverage[key] ?? 0) + 1; };
  let issue: ChaosViolation | undefined, failure: unknown;
  const note = (ok: unknown, rule: string, detail: string) => { if (measuring && !ok && !issue) issue = new ChaosViolation(rule, detail); };
  const transport = new MemoryTransport({ schedule: callback => callbacks.push(callback), server: {
    receive() {},
    connected(peer) {
      const owner = current!;
      note(phase === "connecting" && !natives.some(n => n.owner === owner), "MEMORY_ADMISSION_OWNER", "one admission per current connecting owner");
      note(!peers.has(peer), "MEMORY_PEER_IDENTITY", "a successor must have a fresh native peer");
      const native: Native = { owner, peer, admission: held(), cleanup: held(), cleanups: 0, acked: false };
      natives.push(native); if (!peers.has(peer)) peers.set(peer, native);
      if (measuring) nativeAdmissions++;
      return native.admission.promise;
    },
    disconnected(peer) {
      const native = peers.get(peer);
      note(native !== undefined, "MEMORY_CLEANUP_OWNER", "cleanup must name an admitted peer");
      if (!native) return;
      native.cleanups++; if (measuring) cleanupCalls++;
      note(native.owner.retired && native.owner.admission !== "pending", "MEMORY_CLEANUP_OWNER", "cleanup follows retirement and admission completion");
      note(native.cleanups === 1, "MEMORY_CLEANUP_ONCE", "one cleanup per retired peer");
      return native.cleanup.promise;
    },
  } });
  transport.subscribeMessage(frame => { delivered.push(frame); if (measuring) messageDeliveries++; });
  const observe = (promise: Promise<void>, call: Call, corrupt = false) => {
    const watched = corrupt ? promise.then(() => new Promise<void>(() => {})) : promise;
    void watched.then(() => { call.actual = "resolved"; }, () => { call.actual = "rejected"; });
  };
  const retire = (owner: Owner) => {
    owner.retired = true;
    for (const call of connects) if (call.owner === owner && call.expected === "pending") call.expected = "rejected";
  };
  const begin = () => {
    const controller = new AbortController();
    if (phase !== "open" && phase !== "connecting") {
      current = { epoch: ++epoch, retired: false, admission: "pending", controller }; phase = "connecting";
    } else if (phase === "connecting") count("joined-admission");
    const call: Call = { owner: current!, controller, actual: "pending", expected: phase === "open" ? "resolved" : "pending" };
    connects.push(call); observe(transport.connect(controller.signal), call, options.mutant === "orphan-connect");
  };
  const close = () => {
    if (!current) { phase = "closed"; void transport.close(); return; }
    const owner = current;
    if (owner.close === undefined) {
      owner.close = phase === "open" ? "pending" : "resolved";
      retire(owner); phase = owner.close === "pending" ? "closing" : "closed";
    }
    const call: Call = { owner, expected: owner.close, actual: "pending" }; closes.push(call); observe(transport.close(), call);
  };
  const nativeInput = () => { if (measuring) nativeEvents++; };
  const admission = (native: Native, reject = false) => {
    if (native.owner.admission !== "pending") return;
    nativeInput(); native.owner.admission = reject ? "rejected" : "resolved";
    if (native.owner === current && phase === "connecting" && !native.owner.retired) {
      if (reject) { retire(native.owner); phase = "failed"; }
      else { phase = "open"; for (const c of connects) if (c.owner === current && c.expected === "pending") c.expected = "resolved"; }
    } else count("late-admission");
    if (reject) native.admission.reject(new Error("controlled native admission")); else native.admission.resolve();
  };
  const ack = (native: Native) => {
    if (!native.cleanups || native.acked) return;
    nativeInput(); native.acked = true; native.cleanup.resolve();
    if (native.owner.close === "pending") {
      native.owner.close = "resolved";
      for (const c of closes) if (c.owner === native.owner) c.expected = "resolved";
      if (native.owner === current && phase === "closing") phase = "closed";
      else count("old-close-ack");
    }
    if (options.mutant === "cleanup-retarget" && native.owner !== current && phase === "open") {
      count("corrupt-cleanup-binding"); natives.find(n => n.owner === current)?.peer.close("misbound old cleanup");
    }
  };
  const frame = (native: Native) => {
    nativeInput(); const payload = `${native.owner.epoch}:${++frameSequence}`;
    if (native.owner === current && phase === "open") expectedQueue.push({ epoch: native.owner.epoch, frame: payload });
    else count("retired-peer-send");
    const target = options.mutant === "stale-peer" && native.owner !== current && phase === "open"
      ? natives.find(n => n.owner === current) ?? native : native;
    if (target !== native) count("corrupt-peer-binding");
    target.peer.send(payload);
  };
  const drain = () => {
    const pending = expectedQueue.splice(0);
    const expected = pending.filter(f => f.epoch === current?.epoch && phase === "open").map(f => f.frame);
    if (expected.length < pending.length) count("retired-queued-frame");
    callbacks.splice(0).forEach(callback => callback());
    requireThat(JSON.stringify(delivered.splice(0)) === JSON.stringify(expected), "MEMORY_FRAME_OWNER", "delivery must preserve the native epoch at enqueue and dispatch");
  };
  const check = () => {
    requireThat(transport.status.state === phase, "MEMORY_STATUS_OWNER", `expected ${phase}, observed ${transport.status.state}`);
    if (issue) throw issue;
    for (const call of connects) requireThat(call.actual === call.expected, "MEMORY_CONNECT_SETTLEMENT", `owner ${call.owner.epoch}: ${call.actual} != ${call.expected}`);
    for (const call of closes) requireThat(call.actual === call.expected, "MEMORY_CLOSE_SETTLEMENT", "cleanup ACK belongs to its own caller");
    for (const native of natives) requireThat(native.cleanups === Number(native.owner.retired && native.owner.admission !== "pending"), "MEMORY_CLEANUP_ONCE", "retired admitted peer is cleaned exactly once");
  };
  const pickNative = (event: MemoryChaosEvent) => {
    const candidates = natives.filter(n => event.target === "current" ? n.owner === current : event.target === "old" ? n.owner !== current : true);
    return candidates[(event.pick ?? 0) % candidates.length];
  };
  try {
    for (const event of events) {
      if (event.type === "begin") begin();
      else if (event.type === "close") close();
      else if (event.type === "flush") drain();
      else if (event.type === "abort") {
        const candidates = connects.filter(c => event.target === "current" ? c.owner === current : event.target === "old" ? c.owner !== current : true);
        const call = candidates[(event.pick ?? 0) % candidates.length];
        if (call) {
          if (call.owner === current && phase === "connecting" && call.controller === current.controller && !call.controller.signal.aborted) {
            count("abort-pending"); retire(current); phase = "closed";
          }
          call.controller?.abort();
        }
      } else if (event.type === "heal") {
        count("explicit-heal"); close(); await flush(); begin();
        const active = natives.find(n => n.owner === current);
        requireThat(active !== undefined, "MEMORY_RECOVERY", "fresh peer admission cannot wait for retired hook work");
        admission(active); await flush(); frame(active); drain(); check();
        if (natives.some(n => n.owner !== current && n.owner.admission === "pending")) count("healed-with-retired-admission");
        for (const n of natives) if (n !== active) admission(n); await flush();
        for (const n of natives) ack(n); await flush();
        requireThat(phase === "open", "MEMORY_RECOVERY", "explicit healing must admit a fresh usable peer");
      } else {
        const native = pickNative(event);
        if (native) {
          if (event.type === "admit" || event.type === "fail") admission(native, event.type === "fail");
          else if (event.type === "ack") ack(native);
          else if (event.type === "frame") frame(native);
          else if (event.type === "peer-close") {
            nativeInput();
            if (native.owner === current && !native.owner.retired) { retire(native.owner); phase = "closed"; }
            else count("retired-peer-close");
            native.peer.close("controlled native close");
          }
        }
      }
      await flush(); check();
    }
  } catch (error) { failure = error; }
  finally {
    measuring = false;
    // No hidden connection or probe: only revoke and settle existing work.
    for (const call of connects) call.controller?.abort();
    for (let round = 0; round < 3; round++) {
      void transport.close().catch(() => {});
      for (const n of natives) { n.admission.resolve(); n.cleanup.resolve(); }
      await flush();
    }
    callbacks.splice(0).forEach(callback => callback());
    if (closes.some(c => c.actual === "pending")) {
      if (failure instanceof ChaosViolation) failure.cleanupFailure = "owned close remained pending after cleanup";
      else if (failure === undefined) failure = new ChaosViolation("MEMORY_CLOSE_SETTLEMENT", "cleanup must settle close callers");
    }
    if (connects.some(c => c.actual === "pending") && !(failure instanceof ChaosViolation && failure.rule === "MEMORY_CONNECT_SETTLEMENT")) {
      if (failure instanceof ChaosViolation) failure.cleanupFailure = "owned connect remained pending after cleanup";
      else if (failure === undefined) failure = new ChaosViolation("MEMORY_CONNECT_SETTLEMENT", "local cleanup must settle owned connect callers");
    }
  }
  if (failure !== undefined) throw failure;
  return { events: events.length, nativeEvents, nativeAdmissions, cleanupCalls, messageDeliveries,
    connectIntents: connects.length, connectSettled: connects.filter(c => c.actual !== "pending").length, coverage };
}
