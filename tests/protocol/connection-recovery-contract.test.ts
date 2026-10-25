import assert from "node:assert/strict";
import test from "node:test";
import { ConnectionLifecycleOwner, type ConnectionAttempt } from "../../packages/workbench-runtime/src/connection-lifecycle";
import { budgets, initialState, transition, type Event, type State } from "./fixtures/recovery-specification";

function specification() {
  let state = initialState();
  const history: Event[] = [];
  return { get state() { return state; }, history,
    send(event: Event) { history.push(event); const result = transition(state, event); state = result.state; return result.effects; },
  };
}
const connect = (f: ReturnType<typeof specification>, at = 0) => f.send({ type: "connect", at });

test("contract: a hint during a progressing attempt is retained and wakes its failed successor", () => {
  const f = specification(); connect(f);
  assert.deepEqual(f.send({ type: "hint", at: 5 }), []);
  assert.equal(f.state.pendingWake, true);
  assert.equal(f.state.attempt?.id, 1);
  assert.deepEqual(f.send({ type: "loss", at: 6, id: 1 }), [{ type: "retire", id: 1 }, { type: "dial", id: 2 }]);
  assert.equal(f.state.failures, 1, "fresh validation retains storm protection history");
  assert.equal(f.state.pendingWake, false);
});

test("contract: foreground replaces a stalled attempt and late ready/expiry cannot affect its successor", () => {
  const f = specification(); connect(f);
  assert.deepEqual(f.send({ type: "hint", at: budgets.stage }), [{ type: "retire", id: 1 }, { type: "dial", id: 2 }]);
  const successor = f.state.attempt;
  assert.deepEqual(f.send({ type: "ready", at: 11, id: 1 }), []);
  assert.deepEqual(f.send({ type: "expire", at: 12, id: 1 }), []);
  assert.deepEqual(f.state.attempt, successor);
  assert.equal(f.state.phase, "attempting");
});

test("contract: real progress extends the stage wait, repeated progress does not", () => {
  const f = specification(); connect(f);
  f.send({ type: "progress", at: 8, id: 1, stage: "bridge" });
  assert.deepEqual(f.send({ type: "hint", at: 10 }), []);
  f.send({ type: "progress", at: 17, id: 1, stage: "bridge" });
  assert.equal(f.state.attempt?.progressed, 8);
  assert.deepEqual(f.send({ type: "tick", at: 18 }), [{ type: "retire", id: 1 }, { type: "dial", id: 2 }]);
});

test("contract: resumed clocks recheck deadlines without waiting for suspended timer callbacks", () => {
  const f = specification(); connect(f);
  const effects = f.send({ type: "hint", at: 300 });
  assert.deepEqual(effects, [{ type: "retire", id: 1 }, { type: "dial", id: 2 }]);
  assert.equal(f.state.now, 300);
});

test("contract: progress cannot renew an expired attempt or extend the total budget", () => {
  const f = specification(); connect(f);
  f.send({ type: "progress", at: 8, id: 1, stage: "bridge" });
  f.send({ type: "progress", at: 16, id: 1, stage: "admission" });
  f.send({ type: "progress", at: 24, id: 1, stage: "initialize" });
  assert.deepEqual(f.send({ type: "ready", at: budgets.attempt, id: 1 }), [{ type: "retire", id: 1 }]);
  assert.equal(f.state.phase, "backoff");
  assert.equal(f.state.hostGeneration, null);
  const late = specification(); connect(late);
  late.send({ type: "progress", at: 11, id: 1, stage: "bridge" });
  assert.equal(late.state.phase, "backoff");
});

test("contract: success covers earlier hints without a second dial", () => {
  const f = specification(); connect(f);
  f.send({ type: "hint", at: 5 });
  assert.deepEqual(f.send({ type: "ready", at: 6, id: 1 }), [{ type: "catch-up", id: 1 }]);
  assert.deepEqual(f.send({ type: "tick", at: 7 }), []);
  assert.equal(f.state.generation, 1);
  assert.equal(f.state.pendingWake, false);
});

test("contract: probes, Host readiness and Thread authority are separate facts", () => {
  const f = specification(); connect(f);
  f.send({ type: "probe-ok", at: 1, id: 1 });
  assert.equal(f.state.phase, "attempting");
  assert.equal(f.state.hostGeneration, null);
  f.send({ type: "ready", at: 2, id: 1 });
  assert.equal(f.state.phase, "usable");
  assert.equal(f.state.baselineGeneration, null);
  f.send({ type: "baseline", at: 3, id: 1 });
  assert.equal(f.state.baselineGeneration, 1);
  f.send({ type: "loss", at: 4, id: 1 });
  f.send({ type: "baseline", at: 4, id: 1 });
  assert.equal(f.state.baselineGeneration, null);
});

test("contract: repeated hints share a finite validation budget and preserve server Retry-After", () => {
  const f = specification(); connect(f);
  f.send({ type: "hint", at: 1 });
  f.send({ type: "loss", at: 1, id: 1, retryAfter: 20 });
  for (let at = 2; at < 20; at++) {
    assert.deepEqual(f.send({ type: "hint", at }), []);
    assert.equal(f.state.generation, 1);
  }
  assert.deepEqual(f.send({ type: "tick", at: 20 }), [{ type: "dial", id: 2 }]);
  f.send({ type: "hint", at: 21 });
  assert.deepEqual(f.send({ type: "loss", at: 21, id: 2 }), [{ type: "retire", id: 2 }]);
  assert.deepEqual(f.send({ type: "hint", at: 22 }), []);
  assert.equal(f.state.generation, 2);
});

test("contract: a recovered page validates as promptly as cold connect without erasing outage history", () => {
  const warm = specification(); connect(warm);
  for (let failure = 0; failure < 7; failure++) {
    warm.send({ type: "loss", at: failure * 6, id: warm.state.attempt!.id });
    if (failure < 6) warm.send({ type: "hint", at: (failure + 1) * 6 });
  }
  assert.equal(warm.state.retryAt, 96);
  assert.deepEqual(warm.send({ type: "hint", at: 42 }), [{ type: "dial", id: 8 }]);
  const cold = specification(); connect(cold, 42);
  assert.equal(warm.state.attempt?.started, cold.state.attempt?.started);
  assert.equal(warm.state.failures, 7);
});

test("contract: hidden demand and an unsettled physical barrier cannot admit a competing generation", () => {
  const f = specification(); connect(f);
  f.send({ type: "barrier", at: 1, value: false });
  f.send({ type: "demand", at: 2, value: false });
  f.send({ type: "hint", at: 10 });
  assert.equal(f.state.attempt, null);
  assert.equal(f.state.generation, 1);
  f.send({ type: "demand", at: 11, value: true });
  assert.equal(f.state.generation, 1);
  assert.deepEqual(f.send({ type: "barrier", at: 12, value: true }), [{ type: "dial", id: 2 }]);
});

test("contract: manual rejection remains blocked across hints, time and late completions", () => {
  const f = specification(); connect(f);
  f.send({ type: "loss", at: 1, id: 1, manual: true });
  for (const event of [{ type: "hint", at: 50 }, { type: "ready", at: 51, id: 1 }, { type: "tick", at: 100 }] as Event[]) {
    assert.deepEqual(f.send(event), []); assert.equal(f.state.phase, "blocked");
  }
  assert.deepEqual(connect(f, 101), [{ type: "dial", id: 2 }]);
});

test("contract: dispose is terminal, including queued hints and old deadlines", () => {
  const f = specification(); connect(f); f.send({ type: "hint", at: 1 });
  f.send({ type: "dispose", at: 2 });
  const disposed = f.state;
  for (const event of [{ type: "hint", at: 100 }, { type: "expire", at: 100, id: 1 }, { type: "ready", at: 100, id: 1 }] as Event[]) {
    assert.deepEqual(f.send(event), []); assert.equal(f.state, disposed);
  }
});

function invariant(state: State) {
  assert.equal(state.attempt !== null, state.phase === "attempting");
  assert.equal(state.hostGeneration !== null, state.phase === "usable");
  if (state.baselineGeneration !== null) assert.equal(state.baselineGeneration, state.hostGeneration);
  if (state.attempt) {
    assert.equal(state.attempt.id, state.generation);
    assert.ok(state.attempt.progressed >= state.attempt.started);
  }
  if (state.phase === "blocked" || state.phase === "disposed") assert.equal(state.pendingWake, false);
}

test("contract: bounded event enumeration preserves authority and single-attempt invariants after every prefix", () => {
  const explore = (state: State, prefix: Event[], depth: number) => {
    invariant(state);
    if (!depth) return;
    const at = state.now + 5, id = state.attempt?.id ?? state.hostGeneration ?? state.generation;
    const events: Event[] = [{ type: "hint", at }, { type: "tick", at }, { type: "ready", at, id },
      { type: "ready", at, id: id - 1 }, { type: "loss", at, id }, { type: "loss", at, id, manual: true },
      { type: "progress", at, id, stage: "bridge" }, { type: "baseline", at, id }, { type: "dispose", at }];
    for (const event of events) {
      try { explore(transition(state, event).state, [...prefix, event], depth - 1); }
      catch (error) { throw new Error(`trace=${JSON.stringify([...prefix, event])}`, { cause: error }); }
    }
  };
  explore(transition(initialState(), { type: "connect", at: 0 }).state, [], 4);
});

// Assertions below exercise the real owner, independent of the specification.
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function actual() {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; fn(): void }>();
  const runs: (ConnectionAttempt & { resolve(value: object): void })[] = [];
  const owner = new ConnectionLifecycleOwner<object>({
    clock: { now: () => now, setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout(id) { timers.delete(id as number); } },
    jitter: false, run: attempt => new Promise(resolve => runs.push({ ...attempt, resolve })),
    valid: () => true, invalidate() {}, changed() {}, usable() {}, manual: () => false, backoff() {},
  });
  return { owner, runs,
    async advance(to: number, suspended = false) {
      now = to;
      if (!suspended) for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await flush();
    },
    hint() { if (owner.admitRecoveryHint()) void owner.connect(true).catch(() => undefined); },
  };
}

test("implementation: foreground during backoff advances retry without clearing failure history", async () => {
  const f = actual();
  try {
    const start = f.owner.connect(); await flush(); f.owner.lost(new Error("synthetic loss")); await assert.rejects(start);
    f.hint(); await flush();
    assert.equal(f.runs.length, 2); assert.equal(f.owner.reconnectAttempt, 1);
  } finally { f.owner.dispose(); }
});

test("RECOVERY-GAP-01: pending hint must survive an attempt failure", async () => {
  const f = actual();
  try {
    const start = f.owner.connect(); await flush(); await f.advance(5_000);
    f.hint();
    f.owner.lost(new Error("synthetic loss")); await assert.rejects(start); await flush();
    assert.equal(f.runs.length, 2, "a recorded foreground hint should allow one immediate successor");
  } finally { f.owner.dispose(); }
});

test("RECOVERY-GAP-02: foreground must re-evaluate an attempt whose absolute deadline elapsed while frozen", async () => {
  const f = actual();
  try {
    void f.owner.connect(); await flush(); await f.advance(120_000, true);
    f.hint(); await flush();
    assert.equal(f.runs[0]!.signal.aborted, true, "expired ownership cannot survive until a delayed timer callback");
    assert.equal(f.runs.length, 2);
  } finally { f.owner.dispose(); }
});

test("RECOVERY-GAP-03: a no-progress attempt needs a stage deadline before its aggregate deadline", async () => {
  const f = actual();
  try {
    void f.owner.connect(); await flush(); await f.advance(30_000);
    f.hint(); await flush();
    assert.equal(f.runs[0]!.signal.aborted, true, "this run produced no progress for 30s; aggregate timeout is still 60s");
    assert.equal(f.runs.length, 2);
  } finally { f.owner.dispose(); }
});

test("implementation: distinct progress renews only the stage budget and old progress is fenced", async () => {
  const f = actual();
  try {
    void f.owner.connect(); await flush();
    await f.advance(20_000, true); f.runs[0]!.progress("bridge");
    await f.advance(30_000); f.hint(); await flush();
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0]!.signal.aborted, false);
    await f.advance(45_000, true); f.runs[0]!.progress("bridge");
    await f.advance(50_000); await flush();
    assert.equal(f.runs.length, 2, "the earlier retained hint validates once when the original stage budget expires");
    assert.throws(() => f.runs[0]!.progress("initialize"));
    f.runs[0]!.resolve({}); await flush();
    assert.equal(f.owner.snapshot.phase, "attempting");
  } finally { f.owner.dispose(); }
});

test("implementation: late success after total expiry is rejected before readiness even without timer callbacks", async () => {
  const f = actual();
  try {
    const first = f.owner.connect(); await flush();
    await f.advance(20_000, true); f.runs[0]!.progress("bridge");
    await f.advance(40_000, true); f.runs[0]!.progress("host");
    await f.advance(60_000, true); f.runs[0]!.resolve({});
    await assert.rejects(first, /timed out \(total\)/);
    assert.equal(f.owner.snapshot.phase, "backoff");
    assert.equal(f.runs[0]!.signal.aborted, true);
  } finally { f.owner.dispose(); }
});

test("implementation: success consumes its earlier hint and manual blocks discard retained wake", async () => {
  const f = actual();
  try {
    const first = f.owner.connect(); await flush(); f.hint(); f.runs[0]!.resolve({}); await first;
    f.owner.lost(new Error("new loss")); await flush();
    assert.equal(f.runs.length, 1, "successful initialization covered the old signal");
    void f.owner.connect(true); await flush(); f.hint(); f.owner.lost(new Error("manual"), true);
    await f.advance(120_000); f.hint();
    assert.equal(f.owner.snapshot.phase, "blocked"); assert.equal(f.runs.length, 2);
  } finally { f.owner.dispose(); }
});

test("implementation: hint storms conserve one wake until the validation budget replenishes", async () => {
  const f = actual();
  try {
    // Escalate to a long backoff independently of foreground validation.
    for (let n = 0; n < 7; n++) {
      void f.owner.connect(true); await flush(); f.owner.lost(new Error("outage"));
    }
    f.hint(); await flush(); const count = f.runs.length;
    await f.advance(1_000);
    for (let n = 0; n < 100; n++) f.hint();
    f.owner.lost(new Error("still unavailable")); await flush();
    assert.equal(f.runs.length, count);
    await f.advance(4_999); assert.equal(f.runs.length, count);
    await f.advance(5_000); assert.equal(f.runs.length, count + 1);
    assert.equal(f.owner.reconnectAttempt, 8, "validation does not erase outage history");
    f.owner.lost(new Error("another loss")); await flush();
    await f.advance(6_000); for (let n = 0; n < 100; n++) f.hint();
    await f.advance(9_999); assert.equal(f.runs.length, count + 1);
    await f.advance(10_000); assert.equal(f.runs.length, count + 2, "a backoff hint also survives throttling");
  } finally { f.owner.dispose(); }
});

for (const reentry of ["dispose", "connect"] as const) test(`implementation: abort observer ${reentry} wins over retired retry accounting`, async () => {
  const f = actual();
  try {
    void f.owner.connect(); await flush();
    f.runs[0]!.signal.addEventListener("abort", () => {
      if (reentry === "dispose") f.owner.dispose();
      else void f.owner.connect(true);
    }, { once: true });
    f.owner.lost(new Error("outage")); await flush();
    assert.equal(f.owner.snapshot.phase, reentry === "dispose" ? "disposed" : "attempting");
    await f.advance(120_000);
    if (reentry === "dispose") assert.equal(f.runs.length, 1);
    else assert.equal(f.runs[1]!.signal.aborted, true, "only the successor's own deadline can revoke it");
  } finally { f.owner.dispose(); }
});
