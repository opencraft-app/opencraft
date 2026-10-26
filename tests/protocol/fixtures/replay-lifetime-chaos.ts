import { ReplayTransport, ReplayMismatchError, type RecordedFrame } from "@opencraft/appserver-transport-replay";
import { ChaosViolation, requireThat } from "./recovery-chaos";

export type ReplayMutant = "orphan-connect" | "duplicate-frame" | "cursor-drift";
export interface ReplayEvent { type: "connect" | "connect-send" | "send" | "close" | "release" | "reject-clock" | "abort-send" | "preabort-send" | "preabort-connect" | "abort-start" | "message-noise" | "frame-close" | "mismatch" | "heal"; pick?: number }
const kinds: ReplayEvent["type"][] = ["connect", "connect-send", "send", "close", "release", "reject-clock", "abort-send", "preabort-send", "preabort-connect", "abort-start", "message-noise", "frame-close", "mismatch", "heal"];
export function parseReplayTrace(value: unknown): ReplayEvent[] {
  if (!Array.isArray(value) || value.length > 100000) throw Error("Invalid replay trace");
  return value.map(e => {
    if (!e || typeof e !== "object" || !kinds.includes(e.type) || (e.pick !== undefined && (!Number.isSafeInteger(e.pick) || e.pick < 0))) throw Error("Invalid replay event");
    return e as ReplayEvent;
  });
}
export function generateReplayChaos(seed: number, steps = 120): ReplayEvent[] {
  let state = seed >>> 0; const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const weighted: ReplayEvent["type"][] = ["connect", "connect-send", "send", "send", "close", "release", "release", "reject-clock", "abort-send", "preabort-send", "preabort-connect", "abort-start", "message-noise", "frame-close", "mismatch"];
  const trace: ReplayEvent[] = [];
  // Two LCG draws per event preserve low-bit parity. Use upper bits so one
  // trace can combine cancellation, observer reentry and native clock events.
  for (let i = 0; i < steps; i++) trace.push({ type: weighted[(next() >>> 16) % weighted.length]!, pick: next() });
  trace.push({ type: "heal" }); return trace;
}
type Outcome = "pending" | "resolved" | "rejected";
interface Call { kind: "connect" | "send"; epoch: number; actual: Outcome; native: Outcome; expected: Outcome; error?: unknown; cause?: Error; mismatch?: boolean; controller?: AbortController }
interface Gate { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (cause: unknown) => void; epoch: number; index: number; pending: boolean; retired: boolean }
interface Claim { index: number; payload: string; gate?: Gate }
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };

/** Actual Replay, with externally controlled clock promises. Oracle cursor,
 * epochs, admitted claims and expected outcomes are independent of private fields. */
export async function simulateReplayLifetime(events: readonly ReplayEvent[], options: { mutant?: ReplayMutant } = {}) {
  const recording: RecordedFrame[] = [];
  for (let i = 0; i < events.length + 2; i++) {
    for (const [direction, payload] of [
      ["client-to-server", JSON.stringify({ id: "recorded", method: "echo", params: { nonce: i } })],
      ["server-to-client", JSON.stringify({ id: "recorded", result: { nonce: i } })],
    ] as const) { const sequence = recording.length; recording.push({ sequence, direction, timestampMs: sequence * (sequence + 1), payload }); }
  }
  let epoch = 0, cursor = 0, sequence = 0, status = "idle", claim: Claim | null = null;
  let measuring = true, noisy = false, nativeCloseFrame = false, expectedCloseFrame = false, driftObserved = false;
  let abortConnecting: { controller: AbortController; cause: Error } | null = null;
  let expectedClockRequests = 0, clockReleases = 0, retiredFrames = 0;
  const calls: Call[] = [], gates: Gate[] = [], observed: string[] = [], expected: string[] = [], coverage: Record<string, number> = {};
  const count = (key: string) => { if (measuring) coverage[key] = (coverage[key] ?? 0) + 1; };
  const replay = new ReplayTransport({ recording, timing: "recorded", clock: { sleep(delay) {
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((r, j) => { resolve = r; reject = j; }); void promise.catch(() => undefined);
    const gate: Gate = { promise, resolve, reject, epoch, index: claim?.index ?? -1, pending: true, retired: false };
    gates.push(gate); if (claim) claim.gate = gate;
    requireThat(claim !== null && delay === claim.index * 2, "REPLAY_CLOCK_ADMISSION", "clock request belongs to the current admitted tape frame");
    return promise;
  } } });
  replay.subscribeStatus(s => {
    if (s.state === "connecting" && abortConnecting) {
      const owner = abortConnecting; abortConnecting = null; owner.controller.abort(owner.cause);
    }
  });
  replay.subscribeMessage(() => {
    if (nativeCloseFrame) { nativeCloseFrame = false; void replay.close(); count("frame-reentry-close"); }
    if (noisy) { count("observer-exception"); throw Error("controlled observer"); }
  });
  replay.subscribeMessage(frame => { observed.push(frame); if (options.mutant === "duplicate-frame") observed.push(frame); });
  const watch = (promise: Promise<void>, call: Call) => {
    calls.push(call);
    void promise.then(() => { call.native = "resolved"; if (!(options.mutant === "orphan-connect" && call.kind === "connect")) call.actual = "resolved"; },
      error => { call.native = call.actual = "rejected"; call.error = error; });
    return call;
  };
  const settle = (outcome: Outcome, cause?: Error) => {
    for (const call of calls) if (call.epoch === epoch && call.expected === "pending") { call.expected = outcome; if (cause) call.cause = cause; }
  };
  const retire = (nextStatus: "closed" | "failed", cause?: Error) => {
    if (claim) { cursor++; if (claim.gate) claim.gate.retired = true; claim = null; if (measuring) retiredFrames++; }
    settle("rejected", cause); status = nextStatus;
  };
  const close = async () => { retire("closed"); await replay.close(); await flush(); };
  const connect = (mode: "normal" | "preabort" | "abort-start" = "normal") => {
    const controller = new AbortController(), cause = Error("controlled startup cancellation");
    if (mode === "preabort") controller.abort(cause);
    else if (status !== "open") { epoch++; status = mode === "abort-start" ? "failed" : "open"; }
    if (mode === "abort-start") abortConnecting = { controller, cause };
    const call: Call = { kind: "connect", epoch, actual: "pending", native: "pending", expected: mode === "normal" ? "resolved" : "rejected", ...(mode === "normal" ? {} : { cause }) };
    return watch(replay.connect(controller.signal), call);
  };
  const send = (mode: "normal" | "mismatch" | "preabort" = "normal") => {
    const controller = new AbortController(), cause = Error("controlled send cancellation"), nonce = Math.floor((cursor + 1) / 2), id = `live-${++sequence}`;
    const accepted = mode === "normal" && status === "open" && cursor % 2 === 0;
    const call: Call = { kind: "send", epoch, actual: "pending", native: "pending", expected: accepted ? "pending" : "rejected", controller,
      mismatch: mode !== "preabort" && status === "open" && (!accepted), ...(mode === "preabort" ? { cause } : {}) };
    if (mode === "preabort") controller.abort(cause);
    if (accepted) { cursor++; claim = { index: cursor, payload: JSON.stringify({ id, result: { nonce } }) }; expectedClockRequests++; }
    return watch(replay.send(JSON.stringify({ id, method: "echo", params: { nonce: mode === "mismatch" ? -nonce - 1 : nonce } }), controller.signal), call);
  };
  const release = (gate: Gate | undefined, rejectClock = false) => {
    if (!gate?.pending) return;
    const current = status === "open" && claim?.gate === gate && gate.epoch === epoch;
    const cause = Error("controlled clock failure");
    if (current) {
      if (rejectClock) { retire("failed", cause); count("current-clock-failure"); }
      else {
        const payload = claim!.payload; cursor++; claim = null;
        if (expectedCloseFrame) { expectedCloseFrame = false; retire("closed"); }
        else { expected.push(payload); settle("resolved"); }
      }
    } else { count("retired-clock-wake"); if (gate.retired) driftObserved = true; }
    gate.pending = false; if (measuring) clockReleases++;
    if (rejectClock) gate.reject(cause); else gate.resolve();
  };
  const currentGate = (): Gate | undefined => claim?.gate;
  const check = () => {
    const reported = replay.remainingFrames - Number(options.mutant === "cursor-drift" && driftObserved);
    requireThat(reported === recording.length - cursor && reported >= 0, "REPLAY_CURSOR_OWNERSHIP", "only committed or retired admitted frames advance the tape once");
    requireThat(replay.status.state === status, "REPLAY_NATIVE_STATE", `${replay.status.state} != ${status}`);
    requireThat(gates.length === expectedClockRequests, "REPLAY_CLOCK_ADMISSION", "one clock wait per admitted native frame");
    requireThat(JSON.stringify(observed) === JSON.stringify(expected), "REPLAY_FRAME_SEQUENCE", "only current admitted frames reach observers once with their own IDs");
    for (const call of calls) {
      requireThat(call.actual === call.expected, call.kind === "connect" ? "REPLAY_CONNECT_PROGRESS" : "REPLAY_SEND_SETTLEMENT", `${call.kind} ${call.actual} != ${call.expected}`);
      if (call.actual === "rejected" && call.cause) requireThat(call.error === call.cause, "REPLAY_CANCEL_CAUSE", "the cancellation or clock cause belongs to its own operation");
      if (call.actual === "rejected" && call.mismatch) requireThat(call.error instanceof ReplayMismatchError, "REPLAY_MATCHING", "out-of-order or domain-mismatched client frames are rejected without tape mutation");
    }
  };
  let failure: unknown, traceDeliveries = 0, traceClockWaits = 0;
  try {
    for (const event of events) {
      if (event.type === "connect") connect();
      else if (event.type === "connect-send") { connect(); send(); count("synchronous-connect-send"); }
      else if (event.type === "send") send();
      else if (event.type === "close") await close();
      else if (event.type === "mismatch") { send("mismatch"); count("mismatch-attempt"); }
      else if (event.type === "preabort-send") send("preabort");
      else if (event.type === "preabort-connect") connect("preabort");
      else if (event.type === "abort-start") { await close(); connect("abort-start"); count("startup-revocation"); }
      else if (event.type === "release" || event.type === "reject-clock") release(gates[(event.pick ?? 0) % gates.length], event.type === "reject-clock");
      else if (event.type === "abort-send") {
        const sends = calls.filter(c => c.kind === "send"); const call = sends[(event.pick ?? 0) % sends.length];
        if (call) {
          const cause = Error("explicit local cancellation");
          if (call.expected === "pending") { call.expected = "rejected"; call.cause = cause; count("local-send-cancel"); }
          call.controller!.abort(cause);
        }
      } else if (event.type === "message-noise") noisy = !noisy;
      else if (event.type === "frame-close") { nativeCloseFrame = expectedCloseFrame = true; }
      else if (event.type === "heal") {
        count("explicit-heal");
        nativeCloseFrame = expectedCloseFrame = false;
        await close();
        if (gates.some(g => g.pending && g.retired)) count("healed-with-held-retired-clock");
        const started = connect(); await flush();
        requireThat(started.actual === "resolved", "REPLAY_CONNECT_PROGRESS", "healing does not wait for a retired clock"); check();
        const echo = send(); await flush(); release(currentGate()); await flush();
        requireThat(echo.actual === "resolved", "REPLAY_HEAL_RPC", "explicit heal performs a usable matching request and response");
      }
      await flush(); check();
    }
    traceDeliveries = observed.length; traceClockWaits = gates.length;
  } catch (error) { failure = error; }
  finally {
    const beforeCleanupDeliveries = observed.length;
    measuring = false; noisy = false; nativeCloseFrame = expectedCloseFrame = false; abortConnecting = null;
    try {
      retire("closed"); await replay.close(); await flush();
      requireThat(calls.every(c => c.native !== "pending"), "REPLAY_CLEANUP_SETTLEMENT", "native callers settle before releasing retired fixture clocks");
      for (const gate of gates) if (gate.pending) { gate.pending = false; gate.resolve(); }
      await flush();
      requireThat(replay.status.state === "closed" && replay.remainingFrames === recording.length - cursor, "REPLAY_CLEANUP_CURSOR", "old cleanup continuations cannot mutate a closed tape");
      requireThat(observed.length === beforeCleanupDeliveries, "REPLAY_CLEANUP_DELIVERY", "releasing retired fixture clocks creates no late observer deliveries");
    } catch (error) {
      // Teardown has its own rule, so shrinking a trace rule cannot replace
      // explicit close/release inputs with hidden teardown work.
      if (failure === undefined) failure = new ChaosViolation("REPLAY_CLEANUP", String(error));
      else if (failure instanceof ChaosViolation) failure.cleanupFailure = String(error);
      for (const gate of gates) if (gate.pending) { gate.pending = false; gate.resolve(); } await flush();
    }
  }
  if (failure !== undefined) throw failure;
  return { events: events.length, connectIntents: calls.filter(c => c.kind === "connect").length,
    connectSettled: calls.filter(c => c.kind === "connect" && c.actual !== "pending").length,
    sendIntents: calls.filter(c => c.kind === "send").length, sendSettled: calls.filter(c => c.kind === "send" && c.actual !== "pending").length,
    messageDeliveries: traceDeliveries, clockWaits: traceClockWaits, clockReleases, retiredFrames, coverage };
}
