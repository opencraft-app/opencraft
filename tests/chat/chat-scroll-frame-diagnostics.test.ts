import assert from "node:assert/strict";
import test from "node:test";
import { observeTimelineScrollFrames, setTimelineDiagnosticObserver, type TimelineDiagnosticFields } from "../../packages/timeline-host-web/src/diagnostics";
import { observeScrollFrameDiagnostics, observeWebScrollFrames, type ScrollFrameDiagnosticPort } from "../../packages/timeline-host-web/src/scroll-frame-diagnostics";

function fixture(t: { after: (cleanup: () => void) => void }) {
  setTimelineDiagnosticObserver(undefined);
  let now = 0, sequence = 0, reads = 0, subscriptions = 0, resets = 0;
  let wake: ((scroll?: boolean) => void) | null = null;
  const pending = new Map<number, FrameRequestCallback>();
  const samples: { kind: string; fields: TimelineDiagnosticFields }[] = [];
  let geometry: ReturnType<ScrollFrameDiagnosticPort["read"]> = {
    scrollTop: -1000, scrollHeight: 5000, width: 402, height: 690,
    anchor: { id: 7, top: 200, kind: "text" }, readCostMs: .1,
  };
  const dispose = observeScrollFrameDiagnostics({
    viewport: 1, now: () => now,
    requestFrame: callback => { pending.set(++sequence, callback); return sequence; },
    cancelFrame: id => { pending.delete(id); },
    read: () => { reads++; return geometry; }, reset: () => { resets++; },
    subscribeActivity: listener => { subscriptions++; wake = listener; return () => { subscriptions--; wake = null; }; },
  });
  t.after(() => { dispose(); setTimelineDiagnosticObserver(undefined); });
  const sink = (kind: string, fields: TimelineDiagnosticFields) => { samples.push({ kind, fields }); };
  return { samples, pending, dispose, sink,
    reads: () => reads, subscriptions: () => subscriptions, resets: () => resets,
    enable: () => setTimelineDiagnosticObserver(sink), disable: () => setTimelineDiagnosticObserver(undefined),
    wake: (scroll = false) => wake?.(scroll),
    geometry: (next: typeof geometry) => { geometry = next; },
    current: () => geometry!,
    step: (at: number) => { now = at; const work = [...pending.values()]; pending.clear(); for (const callback of work) callback(at); },
  };
}

test("disabled diagnostics attach no listeners, schedule no frames and read no geometry", t => {
  const f = fixture(t);
  assert.equal(f.pending.size, 0); assert.equal(f.subscriptions(), 0); assert.equal(f.reads(), 0);
  f.wake(); f.step(1000);
  assert.equal(f.reads(), 0); assert.deepEqual(f.samples, []);
  // Even DOM lookup is deferred: no document or window is needed while off.
  const root = new Proxy({}, { get() { throw new Error("disabled DOM read"); } }) as HTMLDivElement;
  const dispose = observeWebScrollFrames(root, {}, () => true);
  dispose();
});

test("disable and viewport retirement revoke a pending lazy sampler attachment", async t => {
  setTimelineDiagnosticObserver(undefined);
  let reads = 0;
  const root = new Proxy({}, { get() { reads++; throw new Error("retired viewport read"); } }) as HTMLDivElement;
  const stop = observeTimelineScrollFrames(root, {}, () => true);
  t.after(() => { stop(); setTimelineDiagnosticObserver(undefined); });
  setTimelineDiagnosticObserver(() => undefined);
  setTimelineDiagnosticObserver(undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  setTimelineDiagnosticObserver(() => undefined);
  stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});

test("opt-in frames distinguish physical scroll from text reflow without writing position", t => {
  const f = fixture(t); f.enable();
  assert.equal(f.subscriptions(), 1); assert.equal(f.pending.size, 1); assert.equal(f.reads(), 0);
  f.step(16);
  f.geometry({ ...f.current(), scrollTop: -1040, anchor: { id: 7, top: 240, kind: "text" } });
  f.wake(true); f.step(80);
  let frame = f.samples.at(-1)!.fields;
  assert.equal(frame.scrollDelta, -40); assert.equal(frame.textDelta, 40); assert.equal(frame.layoutDelta, 0);
  assert.equal(frame.scrollEvents, 1); assert.equal(frame.frameGap, true);
  f.geometry({ ...f.current(), anchor: { id: 7, top: 270, kind: "text" } }); f.step(96);
  frame = f.samples.at(-1)!.fields;
  assert.equal(frame.layoutDelta, 30); assert.equal(frame.textShift, true);
  assert.equal(f.current().scrollTop, -1040);
  assert.ok(Object.values(frame).every(value => typeof value !== "object" || value === null));
});

test("anchor replacement and viewport resize never invent text continuity", t => {
  const f = fixture(t); f.enable(); f.step(16);
  f.geometry({ ...f.current(), anchor: { id: 8, top: 500, kind: "block" } }); f.step(80);
  assert.equal(f.samples.at(-1)!.fields.sameAnchor, false);
  assert.equal(f.samples.at(-1)!.fields.layoutDelta, null);
  f.geometry({ ...f.current(), height: 650, anchor: { id: 8, top: 400, kind: "block" } }); f.step(144);
  assert.equal(f.samples.at(-1)!.fields.layoutDelta, null);
});

test("large steps and long frames are recorded immediately rather than labelled as proven jumps", t => {
  const f = fixture(t); f.enable(); f.step(16);
  f.geometry({ ...f.current(), scrollTop: -1728, anchor: { id: 7, top: 928, kind: "text" } }); f.step(32);
  const fields = f.samples.at(-1)!.fields;
  assert.equal(fields.largeStep, true); assert.equal(fields.frameMs, 16); assert.equal(fields.layoutDelta, 0);
  f.step(132);
  assert.equal(f.samples.at(-1)!.fields.frameGap, true);
  assert.equal(f.samples.at(-1)!.fields.maxFrameMs, 100);
});

test("disable cancels queued work and stale callbacks cannot enter a later recording", t => {
  const f = fixture(t); f.enable(); f.step(16);
  const stale = [...f.pending.values()][0]!;
  f.disable(); const reads = f.reads(), count = f.samples.length;
  assert.equal(f.pending.size, 0); assert.equal(f.subscriptions(), 0);
  stale(32); f.wake(true); f.step(48);
  assert.equal(f.reads(), reads); assert.equal(f.samples.length, count);
  f.enable(); stale(64);
  assert.equal(f.reads(), reads, "old generation cannot read the new session");
  assert.equal(f.pending.size, 1); f.step(80);
  assert.equal(f.samples.at(-1)!.fields.frameMs, null);
  assert.equal(f.samples.at(-1)!.fields.sameAnchor, false);
  f.dispose(); f.disable(); f.enable();
  assert.equal(f.pending.size, 0); assert.equal(f.subscriptions(), 0);
});

test("idle and parked viewports stop frames; activity resumes a fresh anchor", t => {
  const f = fixture(t); f.enable(); f.step(16);
  for (let at = 32; at <= 320; at += 16) f.step(at);
  assert.equal(f.pending.size, 0);
  const reads = f.reads(); f.step(1000); assert.equal(f.reads(), reads);
  f.wake(); assert.equal(f.pending.size, 1); f.geometry(null); f.step(1016);
  assert.equal(f.pending.size, 0);
  f.geometry({ scrollTop: -2000, scrollHeight: 5000, width: 402, height: 690, anchor: null, readCostMs: 0 });
  f.wake(); f.step(1032);
  assert.equal(f.samples.at(-1)!.fields.frameMs, null);
  assert.equal(f.samples.at(-1)!.fields.anchor, null);
});

test("a sink disabling collection inside a sample cannot revive the frame loop", t => {
  const f = fixture(t);
  setTimelineDiagnosticObserver((kind, fields) => { f.sink(kind, fields); f.disable(); });
  f.step(16);
  assert.equal(f.samples.length, 1); assert.equal(f.pending.size, 0); assert.equal(f.subscriptions(), 0);
});
