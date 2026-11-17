import assert from "node:assert/strict";
import test from "node:test";
import {
  ResumeLink, parseResumeAttempt, parseResumeGrant, utf8Length, RESUME_ACK_FRAMES,
} from "../../packages/app-host-resume/src/index";
import { ResumeRegistry } from "../../packages/app-host-resume/src/server";

test("link numbers, retains, acknowledges and replays exactly the unseen frames", () => {
  const link = new ResumeLink<string>({ maxBytes: 1_000 });
  for (const text of ["a", "b", "c", "d"]) { const seq = link.next(); link.retain(seq, text, 10); }
  assert.equal(link.sent, 4);
  assert.equal(link.bytes, 40);
  assert.ok(link.acknowledge(2));
  assert.equal(link.bytes, 20);
  assert.deepEqual(link.replay(2), [{ seq: 3, data: "c" }, { seq: 4, data: "d" }]);
  assert.deepEqual(link.replay(4), []);
  assert.equal(link.bytes, 0);
  assert.equal(link.acknowledge(9), false, "cannot acknowledge unsent frames");
  assert.equal(link.replay(9), null);
});

test("evicting an unacknowledged frame makes resumption from before it impossible", () => {
  const evicted: number[] = [];
  const link = new ResumeLink<string>({ maxBytes: 30, onEvict: () => evicted.push(1) });
  for (let i = 1; i <= 4; i++) link.retain(link.next(), String(i), 10);
  assert.equal(link.frames, 3);
  assert.equal(evicted.length, 1);
  assert.equal(link.replay(0), null, "frame 1 is gone");
  assert.deepEqual(link.replay(1)?.map(f => f.seq), [2, 3, 4]);
  // A single frame larger than the window is never retained.
  link.retain(link.next(), "huge", 31);
  assert.equal(link.frames, 0);
  assert.equal(link.replay(4), null);
});

test("incoming frames are delivered once and in order; acknowledgements batch", () => {
  const link = new ResumeLink<string>({ maxBytes: 10 });
  assert.equal(link.accept(1), "deliver");
  assert.equal(link.accept(1), "duplicate");
  assert.equal(link.accept(3), "gap");
  assert.equal(link.accept(2), "deliver");
  assert.equal(link.acknowledgementDue, "later");
  assert.equal(link.acknowledged(), 2);
  assert.equal(link.acknowledgementDue, null);
  for (let seq = 3; seq < 3 + RESUME_ACK_FRAMES; seq++) link.accept(seq);
  assert.equal(link.acknowledgementDue, "now");
});

test("wire parsers reject malformed and oversized values", () => {
  assert.deepEqual(parseResumeAttempt({ v: 1 }), { v: 1 });
  const ok = { v: 1, sessionId: "a".repeat(32), token: "A".repeat(43), received: 5 };
  assert.deepEqual(parseResumeAttempt(ok), ok);
  for (const bad of [null, [], { v: 2 }, { ...ok, received: -1 }, { ...ok, token: "short" }, { ...ok, sessionId: "Z".repeat(32) }, { ...ok, extra: 1 }])
    assert.equal(parseResumeAttempt(bad), null);
  assert.equal(parseResumeGrant({ v: 1, sessionId: "a".repeat(32), token: "A".repeat(43), detachMs: 10 }), null);
  assert.equal(utf8Length("aé中😀"), 1 + 2 + 3 + 4);
});

function clock() {
  let now = 0, id = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => { const key = ++id; timers.set(key, { at: now + ms, run }); return key; },
    clearTimeout: (key: unknown) => { timers.delete(key as number); },
    advance(ms: number) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.run(); } },
  };
}

test("registry authenticates by token and identity and expires detached sessions", () => {
  const time = clock(), ended: string[] = [];
  const registry = new ResumeRegistry<string>({ detachMs: 1_000, ...time });
  const session = registry.create("alice", "payload", reason => ended.push(reason));
  const grant = session.grant();
  const attempt = { v: 1 as const, sessionId: grant.sessionId, token: grant.token, received: 0 };
  assert.deepEqual(registry.find(attempt, "bob"), { failure: "identity" });
  assert.deepEqual(registry.find({ ...attempt, token: "B".repeat(43) }, "alice"), { failure: "unknown-session" });
  assert.equal((registry.find(attempt, "alice") as { session: unknown }).session, session);
  session.detach();
  assert.equal(registry.stats.detached, 1);
  time.advance(999); assert.deepEqual(ended, []);
  session.attach(); time.advance(5_000); assert.deepEqual(ended, [], "attaching cancels expiry");
  session.detach(time.now() + 200); time.advance(200);
  assert.deepEqual(ended, ["detach-expired"], "the identity deadline shortens the window");
  assert.deepEqual(registry.find(attempt, "alice"), { failure: "unknown-session" });
  assert.equal(registry.stats.sessions, 0);
});

test("global budget evicts the largest session's oldest frames and ends it only if detached", async () => {
  const time = clock(), ended: string[] = [];
  const registry = new ResumeRegistry<string>({ maxBytes: 100, sessionMaxBytes: 80, ...time });
  const big = registry.create("a", "big", reason => ended.push("big:" + reason));
  const small = registry.create("b", "small", reason => ended.push("small:" + reason));
  for (let i = 0; i < 7; i++) big.link.retain(big.link.next(), null, 10);
  for (let i = 0; i < 2; i++) small.link.retain(small.link.next(), null, 10);
  assert.equal(registry.stats.bytes, 90);
  for (let i = 0; i < 2; i++) small.link.retain(small.link.next(), null, 10);
  assert.equal(registry.stats.bytes, 100);
  assert.equal(small.link.frames, 4, "the smaller session keeps its frames");
  assert.equal(big.link.frames, 6);
  await Promise.resolve();
  assert.deepEqual(ended, [], "an attached session survives eviction");
  big.detach();
  small.link.retain(small.link.next(), null, 10);
  await Promise.resolve();
  assert.deepEqual(ended, ["big:window-overflow"], "a detached session whose replay was evicted ends");
  assert.equal(big.link.bytes, 0);
});

test("acknowledgements and eviction release payload references before queue compaction", () => {
  const link = new ResumeLink<Buffer>({ maxBytes: 32 });
  // Inspect strong references: a byte counter alone cannot prove a memory bound.
  const storage = () => (link as unknown as { retained: Array<{ data: Buffer } | undefined> }).retained;
  link.retain(link.next(), Buffer.alloc(16), 16);
  link.retain(link.next(), Buffer.alloc(16), 16);
  const first = storage()[0]!.data;
  link.acknowledge(1);
  assert.equal(storage().some(frame => frame?.data === first), false);
  for (let i = 0; i < 256; i++) link.retain(link.next(), Buffer.alloc(16), 16);
  assert.equal(link.frames, 2);
  assert.equal(storage().filter(Boolean).length, 2, "evicted buffers are unreachable even below the compaction threshold");
  assert.equal(storage().reduce((sum, frame) => sum + (frame?.data.length ?? 0), 0), link.bytes);
  assert.deepEqual(link.replay(256)?.map(frame => frame.seq), [257,258]);
});

test('UTF-8 accounting handles isolated high surrogates without skipping the following character', () => {
  for (const value of ['\ud800é', '\ud800中', '\ud800\ud800', '\udfff', '\ud800', '😀', 'a\ud800é中']) {
    assert.equal(utf8Length(value), new TextEncoder().encode(value).byteLength, JSON.stringify(value));
  }
});

test('zero-byte retained records have a frame-count bound independent of the byte budget', () => {
  const link = new ResumeLink<null>({ maxBytes: 10 });
  for (let index = 0; index < 9_000; index++) link.retain(link.next(), null, 0);
  assert.ok(link.frames <= 8_192, `retained ${link.frames} zero-byte records`);
  assert.equal(link.replay(0), null, 'evicted sequence is not resumable');
});

test('a zero-byte oldest frame cannot stop global byte-budget enforcement', () => {
  const registry = new ResumeRegistry<null>({ maxBytes: 5, sessionMaxBytes: 100 });
  const session = registry.create('identity', null, () => {});
  session.link.retain(session.link.next(), null, 0);
  session.link.retain(session.link.next(), Buffer.alloc(10), 10);
  assert.ok(registry.stats.bytes <= 5, `retained ${registry.stats.bytes} bytes over a 5-byte budget`);
  registry.close();
});

test('registry shutdown fences reentrant and subsequent session admission', () => {
  const registry = new ResumeRegistry<null>();
  let rejected = false;
  registry.create('identity', null, () => {
    try { registry.create('reentrant', null, () => {}); } catch { rejected = true; }
  });
  registry.close();
  assert.equal(rejected, true); assert.equal(registry.stats.sessions, 0);
  assert.throws(() => registry.create('late', null, () => {}), /closed/);
});

test('session count is bounded independently of byte occupancy and closing a session releases capacity', () => {
  const registry = new ResumeRegistry<null>({ maxSessions: 1 });
  const first = registry.create('identity', null, () => {});
  assert.throws(() => registry.create('another', null, () => {}), /capacity/);
  assert.equal(registry.stats.sessions, 1); assert.equal(first.isEnded, false);
  first.end('intentional');
  assert.doesNotThrow(() => registry.create('replacement', null, () => {})); registry.close();
});

test('invalid budgets and invalid frame accounting cannot disable resource enforcement', () => {
  for (const invalid of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => new ResumeLink({ maxBytes: invalid }), /budget/);
    assert.throws(() => new ResumeRegistry({ maxBytes: invalid }), /limits/);
    const link = new ResumeLink<null>({ maxBytes: 10 });
    assert.throws(() => link.retain(link.next(), null, invalid), /size/);
    assert.equal(link.bytes, 0);
  }
  const link = new ResumeLink<null>({ maxBytes: 0, maxFrames: 2 });
  for (let index = 0; index < 3; index++) link.retain(link.next(), null, 0);
  assert.equal(link.frames, 2); assert.equal(link.replay(0), null);
});

test('global frame accounting bounds empty records across sessions and releases them atomically', () => {
  const registry = new ResumeRegistry<null>({ maxFrames: 3 });
  const first = registry.create('first', null, () => {}), second = registry.create('second', null, () => {});
  for (let index = 0; index < 10; index++) {
    const owner = index % 2 ? first : second;
    owner.link.retain(owner.link.next(), null, 0);
    assert.ok(registry.stats.frames <= 3);
    assert.equal(registry.stats.frames, first.link.frames + second.link.frames);
  }
  registry.close(); assert.equal(registry.stats.frames, 0); assert.equal(registry.stats.bytes, 0);
});

test('ending a session fences late writers so forgotten owners cannot retain orphaned bytes', () => {
  const registry = new ResumeRegistry<null>();
  const session = registry.create('identity', null, () => {});
  const seq = session.link.next(); session.link.retain(seq, Buffer.alloc(10), 10);
  session.end('ended');
  assert.throws(() => session.link.retain(seq, Buffer.alloc(10), 10), /closed/);
  assert.throws(() => session.link.next(), /closed/);
  assert.equal(session.link.replay(0), null);
  assert.deepEqual(registry.stats, { sessions: 0, detached: 0, bytes: 0, frames: 0 });
});
