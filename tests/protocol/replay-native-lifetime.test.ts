import test from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { ReplayTransport, ReplayMismatchError, type RecordedFrame } from "@opencraft/appserver-transport-replay";
const flush = async () => { for (let i = 0; i < 64; i++) await Promise.resolve(); };
function held() { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function observe(p: Promise<unknown>) { const s = { outcome: "pending", error: undefined as unknown }; void p.then(() => { s.outcome = "resolved"; }, e => { s.outcome = "rejected"; s.error = e; }); return s; }
const tape = (...entries: [RecordedFrame["direction"], string][]): RecordedFrame[] => entries.map(([direction, payload], sequence) => ({ sequence, direction, timestampMs: sequence * 10, payload }));
function delayed(recording = tape(["client-to-server", "first"], ["server-to-client", "old"], ["client-to-server", "next"], ["server-to-client", "new"])) {
  const gate = held(), sleeps: number[] = [], frames: string[] = [];
  const replay = new ReplayTransport({ recording, match: "exact", timing: "recorded", clock: { sleep(ms) { sleeps.push(ms); return sleeps.length === 1 ? gate.promise : Promise.resolve(); } } });
  replay.subscribeMessage(frame => frames.push(frame)); return { replay, gate, sleeps, frames };
}
test("connecting close rejects Replay startup instead of resurrecting open", async () => {
  const r = new ReplayTransport([]); r.subscribeStatus(s => { if (s.state === "connecting") void r.close(); });
  const call = observe(r.connect()); await flush(); assert.equal(call.outcome, "rejected"); assert.equal(r.status.state, "closed");
});
test("delayed old frame cannot deliver while closed", async () => {
  const f = delayed(); await f.replay.connect(); const call = observe(f.replay.send("first"));
  await f.replay.close(); f.gate.resolve(); await flush();
  assert.deepEqual(f.frames, []); assert.equal(call.outcome, "rejected"); assert.equal(f.replay.remainingFrames, 2);
});
test("close settles delayed send before an uncooperative clock wakes", async () => {
  const f = delayed(); await f.replay.connect(); const call = observe(f.replay.send("first")); await f.replay.close(); await flush();
  try { assert.equal(call.outcome, "rejected"); assert.deepEqual(f.frames, []); } finally { f.gate.resolve(); await flush(); }
});
test("successor resumes without old sleep and old wake cannot overrun cursor", async () => {
  const f = delayed(); await f.replay.connect(); const old = observe(f.replay.send("first")); await f.replay.close();
  try {
    const connecting = observe(f.replay.connect()); await flush(); assert.equal(connecting.outcome, "resolved");
    const next = observe(f.replay.send("next")); await flush(); assert.equal(next.outcome, "resolved"); assert.equal(old.outcome, "rejected");
    assert.deepEqual(f.frames, ["new"]); assert.equal(f.replay.remainingFrames, 0);
    f.gate.resolve(); await flush(); assert.deepEqual(f.frames, ["new"]); assert.equal(f.replay.remainingFrames, 0);
  } finally { f.gate.resolve(); await f.replay.close(); }
});
test("same-epoch reserved server frame blocks a later client frame", async () => {
  const f = delayed(); await f.replay.connect(); const first = f.replay.send("first");
  try {
    assert.equal(f.replay.remainingFrames, 3); await assert.rejects(f.replay.send("next"), ReplayMismatchError); assert.equal(f.replay.remainingFrames, 3);
    f.gate.resolve(); await first; await f.replay.send("next"); assert.deepEqual(f.frames, ["old", "new"]); assert.equal(f.replay.remainingFrames, 0);
  } finally { f.gate.resolve(); await f.replay.close(); }
});
test("retiring before a frame claim preserves the tape", async () => {
  const r = new ReplayTransport(tape(["client-to-server", "first"])); let once = false;
  r.subscribeStatus(s => { if (s.state === "connecting" && !once) { once = true; void r.close(); } });
  observe(r.connect()); await flush(); assert.equal(r.remainingFrames, 1); await r.connect(); await r.send("first"); assert.equal(r.remainingFrames, 0); await r.close();
});
test("connect signal abort releases startup without clock completion", async () => {
  const f = delayed(tape(["server-to-client", "initial"], ["server-to-client", "waiting"], ["client-to-server", "next"])), c = new AbortController(), reason = Error("startup cancelled");
  const call = observe(f.replay.connect(c.signal)); await flush(); assert.deepEqual(f.frames, ["initial"]); c.abort(reason); await flush();
  try { assert.equal(call.outcome, "rejected"); assert.equal(call.error, reason); assert.equal(f.replay.remainingFrames, 1); assert.notEqual(f.replay.status.state, "open"); }
  finally { f.gate.resolve(); await flush(); await f.replay.close(); }
});
test("completed startup detaches its initiating signal", async () => {
  const r = new ReplayTransport([]), c = new AbortController(); await r.connect(c.signal); c.abort(); await flush(); assert.equal(r.status.state, "open"); await r.close();
});
test("send cancellation releases only its caller and preserves native delivery", async () => {
  const f = delayed(), c = new AbortController(), reason = Error("local send cancelled"); await f.replay.connect(); const call = observe(f.replay.send("first", c.signal));
  c.abort(reason); await flush();
  try {
    assert.equal(call.outcome, "rejected"); assert.equal(call.error, reason); assert.equal(f.replay.status.state, "open"); assert.equal(f.replay.remainingFrames, 3);
    f.gate.resolve(); await flush(); assert.deepEqual(f.frames, ["old"]); await f.replay.send("next"); assert.deepEqual(f.frames, ["old", "new"]);
  } finally { f.gate.resolve(); await f.replay.close(); }
});
test("pre-aborted send cannot consume a tape frame", async () => {
  const r = new ReplayTransport(tape(["client-to-server", "first"])), c = new AbortController(); await r.connect(); c.abort();
  try { await assert.rejects(r.send("first", c.signal)); assert.equal(r.remainingFrames, 1); } finally { await r.close(); }
});
test("message observer failures cannot stop peers or subsequent frames", async () => {
  const r = new ReplayTransport(tape(["server-to-client", "a"], ["server-to-client", "b"])), seen: string[] = [];
  r.subscribeMessage(() => { throw Error("observer"); }); r.subscribeMessage(frame => seen.push(frame)); const call = observe(r.connect()); await flush();
  try { assert.equal(call.outcome, "resolved"); assert.deepEqual(seen, ["a", "b"]); assert.equal(r.remainingFrames, 0); } finally { await r.close(); }
});
test("frame delivery stops when an earlier observer retires its owner", async () => {
  const r = new ReplayTransport(tape(["server-to-client", "old"])), seen: string[] = [];
  r.subscribeMessage(() => { void r.close(); }); r.subscribeMessage(frame => seen.push(frame)); observe(r.connect()); await flush();
  assert.deepEqual(seen, []); assert.equal(r.status.state, "closed"); assert.equal(r.remainingFrames, 0);
});
test("old message unsubscribe cannot remove a replacement", async () => {
  const r = new ReplayTransport(tape(["server-to-client", "a"])), seen: string[] = []; const fn = (frame: string) => seen.push(frame);
  const old = r.subscribeMessage(fn); old(); r.subscribeMessage(fn); old();
  try { await r.connect(); assert.deepEqual(seen, ["a"]); } finally { await r.close(); }
});
test("message registration during fanout starts on the next frame", async () => {
  const r = new ReplayTransport(tape(["server-to-client", "a"], ["server-to-client", "b"])), seen: string[] = []; const later = (frame: string) => seen.push("late-" + frame);
  r.subscribeMessage(frame => { seen.push(frame); r.subscribeMessage(later); });
  try { await r.connect(); assert.deepEqual(seen, ["a", "b", "late-b"]); } finally { await r.close(); }
});
test("synchronous clock reentry retires only its claimed frame", async () => {
  let r!: ReplayTransport, closing: Promise<void> | undefined; const seen: string[] = [];
  r = new ReplayTransport({ recording: tape(["client-to-server", "first"], ["server-to-client", "old"], ["client-to-server", "next"]), timing: "recorded", clock: { sleep() { closing = r.close(); return Promise.resolve(); } } });
  r.subscribeMessage(frame => seen.push(frame)); await r.connect(); const call = observe(r.send("first")); await flush(); await closing;
  assert.equal(call.outcome, "rejected"); assert.deepEqual(seen, []); assert.equal(r.remainingFrames, 1); await r.connect(); await r.send("next"); await r.close();
});
test("retired clock rejection cannot fail or advance its successor", async () => {
  const f = delayed(); await f.replay.connect(); observe(f.replay.send("first")); await f.replay.close(); await f.replay.connect();
  try { await f.replay.send("next"); f.gate.reject(Error("old sleep")); await flush(); assert.equal(f.replay.status.state, "open"); assert.equal(f.replay.remainingFrames, 0); assert.deepEqual(f.frames, ["new"]); }
  finally { f.gate.resolve(); await f.replay.close(); }
});
test("reentrant outgoing send joins one drain without duplicate consumption", async () => {
  const r = new ReplayTransport(tape(["client-to-server", "first"], ["server-to-client", "old"], ["client-to-server", "next"], ["server-to-client", "new"])), seen: string[] = []; let next: Promise<void> | undefined;
  r.subscribeMessage(frame => { seen.push(frame); if (frame === "old") next = r.send("next"); });
  try { await r.connect(); await r.send("first"); await next; assert.deepEqual(seen, ["old", "new"]); assert.equal(r.remainingFrames, 0); } finally { await r.close(); }
});
test("json-rpc replay preserves domain IDs and maps current envelope IDs", async () => {
  const r = new ReplayTransport({ recording: tape(["client-to-server", JSON.stringify({ id: "recorded", method: "thread/read", params: { id: "thread-a" } })], ["server-to-client", JSON.stringify({ id: "recorded", result: { id: "thread-a" } })]) }), seen: unknown[] = [];
  r.subscribeMessage(frame => seen.push(JSON.parse(frame))); await r.connect();
  try {
    await assert.rejects(r.send(JSON.stringify({ id: "live", method: "thread/read", params: { id: "thread-b" } })), ReplayMismatchError); assert.equal(r.remainingFrames, 2);
    await r.send(JSON.stringify({ id: "live", method: "thread/read", params: { id: "thread-a" } })); assert.deepEqual(seen, [{ id: "live", result: { id: "thread-a" } }]);
  } finally { await r.close(); }
});
test("current clock failure retires its claim and preserves the original cause", async () => {
  const f = delayed(), reason = Error("current clock failed"); await f.replay.connect(); const call = observe(f.replay.send("first"));
  f.gate.reject(reason); await flush();
  try {
    assert.equal(call.outcome, "rejected"); assert.equal(call.error, reason); assert.equal(f.replay.status.state, "failed"); assert.equal(f.replay.remainingFrames, 2);
    await f.replay.connect(); await f.replay.send("next"); assert.deepEqual(f.frames, ["new"]);
  } finally { await f.replay.close(); }
});
test("synchronous clock throw retires one reservation without masking its cause", async () => {
  const reason = Error("clock admission failed");
  const r = new ReplayTransport({ recording: tape(["client-to-server", "first"], ["server-to-client", "old"], ["client-to-server", "next"]), timing: "recorded", clock: { sleep() { throw reason; } } });
  await r.connect(); await assert.rejects(r.send("first"), e => e === reason); assert.equal(r.status.state, "failed"); assert.equal(r.remainingFrames, 1);
  await r.connect(); await r.send("next"); await r.close();
});
test("retirement removes old response ID bindings from successor native traffic", async () => {
  const gate = held(); let sleeps = 0;
  const r = new ReplayTransport({ recording: tape(["client-to-server", JSON.stringify({ id: "saved", method: "first" })], ["server-to-client", JSON.stringify({ id: "saved", result: "old" })], ["server-to-client", JSON.stringify({ id: "saved", result: "unclaimed" })]), timing: "recorded", clock: { sleep() { return ++sleeps === 1 ? gate.promise : Promise.resolve(); } } }), seen: unknown[] = [];
  r.subscribeMessage(frame => seen.push(JSON.parse(frame))); await r.connect(); observe(r.send(JSON.stringify({ id: "live-old", method: "first" }))); await r.close();
  try { await r.connect(); assert.deepEqual(seen, [{ id: "saved", result: "unclaimed" }]); gate.resolve(); await flush(); assert.equal(seen.length, 1); assert.equal(r.remainingFrames, 0); }
  finally { gate.resolve(); await r.close(); }
});
test("connecting reentry joins one startup instead of creating another activity", async () => {
  const r = new ReplayTransport([]); let joined: Promise<void> | undefined, connecting = 0;
  r.subscribeStatus(s => { if (s.state === "connecting") { connecting++; if (!joined) joined = r.connect(); } });
  try { await r.connect(); await joined; assert.equal(connecting, 1); assert.equal(r.status.state, "open"); }
  finally { await r.close(); }
});
test("old close finishing after a closing observer cannot overwrite its successor", async () => {
  const r = new ReplayTransport(tape(["client-to-server", "next"])); let successor: Promise<void> | undefined, once = false;
  await r.connect(); r.subscribeStatus(s => { if (s.state === "closing" && !once) { once = true; successor = r.connect(); } });
  try { await r.close(); await successor; assert.equal(r.status.state, "open"); await r.send("next"); assert.equal(r.remainingFrames, 0); }
  finally { await r.close(); }
});
test("current clock failure callback can recover before old drain cleanup returns", async () => {
  const f = delayed(), reason = Error("current delivery failed"); let successor: Promise<void> | undefined, next: Promise<void> | undefined;
  await f.replay.connect();
  f.replay.subscribeStatus(s => { if (s.state === "failed" && !successor) { successor = f.replay.connect(); next = f.replay.send("next"); } });
  const old = observe(f.replay.send("first")); f.gate.reject(reason); await flush();
  try {
    assert.equal(old.outcome, "rejected"); assert.equal(old.error, reason); assert.ok(successor); await successor; await next;
    assert.equal(f.replay.status.state, "open"); assert.deepEqual(f.frames, ["new"]); assert.equal(f.replay.remainingFrames, 0);
  } finally { await f.replay.close(); }
});
test("microtask send after frame delivery acquires a fresh drain before old completion", async () => {
  const gate = held(), seen: string[] = []; let sleeps = 0, next: ReturnType<typeof observe> | undefined;
  const r = new ReplayTransport({ recording: tape(["client-to-server", "first"], ["server-to-client", "old"], ["client-to-server", "next"], ["server-to-client", "new"]), timing: "recorded", clock: { sleep() { return ++sleeps === 2 ? gate.promise : Promise.resolve(); } } });
  r.subscribeMessage(frame => { seen.push(frame); if (frame === "old") queueMicrotask(() => { next = observe(r.send("next")); }); });
  await r.connect(); const first = observe(r.send("first")); await flush();
  try {
    assert.equal(first.outcome, "resolved"); assert.equal(sleeps, 2); assert.equal(next?.outcome, "pending"); assert.equal(r.remainingFrames, 1);
    gate.resolve(); await flush(); assert.equal(next?.outcome, "resolved"); assert.deepEqual(seen, ["old", "new"]); assert.equal(r.remainingFrames, 0);
  } finally { gate.resolve(); await r.close(); }
});
test("close clears its real default timer rather than only abandoning its Promise", async () => {
  let measuring = false;
  const handles = new Map<number, NodeJS.Timeout>(), pending = new Set<number>();
  const hook = createHook({ init(id, type, _trigger, resource) {
    if (measuring && type === "Timeout") { handles.set(id, resource as NodeJS.Timeout); pending.add(id); }
  }, destroy(id) { pending.delete(id); } });
  const r = new ReplayTransport({ recording: [
    { sequence: 0, direction: "client-to-server", timestampMs: 0, payload: "first" },
    { sequence: 1, direction: "server-to-client", timestampMs: 60000, payload: "old" },
  ], timing: "recorded" });
  hook.enable();
  try {
    await r.connect(); measuring = true; observe(r.send("first")); measuring = false;
    assert.equal(handles.size, 1); await r.close();
    await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(pending.size, 0);
  } finally {
    measuring = false; await r.close();
    // Only timers created by this fixture's scoped native send are released.
    for (const handle of handles.values()) clearTimeout(handle); hook.disable();
  }
});
