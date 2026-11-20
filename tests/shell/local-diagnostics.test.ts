import assert from "node:assert/strict";
import test from "node:test";
import { captureLocalDiagnostics, getLocalDiagnosticsState, isLocalDiagnosticsEnabled,
  LOCAL_DIAGNOSTICS_BYTES, LOCAL_DIAGNOSTICS_FRAME_BYTES, LOCAL_DIAGNOSTICS_FRAME_LIMIT,
  LOCAL_DIAGNOSTICS_KEY, LOCAL_DIAGNOSTICS_LIMIT, recordLocalDiagnostic,
  setLocalDiagnosticsEnabled } from "../../apps/workbench-web/src/runtime/local-diagnostics";
import { clearRuntimeDiagnostics, getRuntimeDiagnosticsSnapshot, recordRuntimeDiagnosticConsole,
  startRuntimeDiagnosticCollection } from "../../apps/workbench-web/src/runtime-diagnostics";
import { captureViewportHistory, recordViewportDiagnostic } from "../../apps/workbench-web/src/runtime/viewport-history";
import { createViewportDiagnostics } from "../../apps/workbench-web/src/runtime/viewport-diagnostics";

test("off by default, device-local opt-in, oldest eviction and frozen evidence on disable", t => {
  assert.equal(isLocalDiagnosticsEnabled(), false);
  const values = new Map<string,string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
  } });
  t.after(() => { setLocalDiagnosticsEnabled(false); if (previous) Object.defineProperty(globalThis,"window",previous); else Reflect.deleteProperty(globalThis,"window"); });
  recordLocalDiagnostic("off", { value: 1 });
  assert.equal(captureLocalDiagnostics().samples.length, 0);
  setLocalDiagnosticsEnabled(true);
  assert.equal(values.get(LOCAL_DIAGNOSTICS_KEY), "true");
  assert.ok(getLocalDiagnosticsState().enabledSince);
  for (let i = 0; i < LOCAL_DIAGNOSTICS_LIMIT + 10; i++) recordLocalDiagnostic("sample", { sequence: i });
  let report = captureLocalDiagnostics();
  assert.equal(report.samples.length, LOCAL_DIAGNOSTICS_LIMIT);
  assert.equal(report.samples[0]!.fields.sequence, 10);
  for (let i = 0; i < 500; i++) recordLocalDiagnostic("large", { sequence: i, a: "界".repeat(512), b: "界".repeat(512) });
  report = captureLocalDiagnostics();
  assert.ok(report.bytes <= LOCAL_DIAGNOSTICS_BYTES);
  assert.ok(report.samples.length < LOCAL_DIAGNOSTICS_LIMIT);
  assert.equal(report.samples.at(-1)!.fields.sequence, 499);
  recordViewportDiagnostic({ editing: 1, visualHeight: 300, clientHeight: 800 });
  setLocalDiagnosticsEnabled(false);
  const length = captureLocalDiagnostics().samples.length;
  const viewport = captureViewportHistory();
  recordLocalDiagnostic("off-again", { value: 2 });
  recordViewportDiagnostic({ editing: 0, visualHeight: 900 });
  // No document exists: disabled sampling must not perform any geometry/probe read.
  createViewportDiagnostics()();
  assert.equal(captureLocalDiagnostics().samples.length, length);
  assert.deepEqual(captureViewportHistory(), viewport);
  assert.ok(getLocalDiagnosticsState().stoppedAt);
  assert.equal(captureLocalDiagnostics().upload, false);
  setLocalDiagnosticsEnabled(true);
  assert.equal(captureLocalDiagnostics().samples.length, 0);
  assert.equal(captureViewportHistory().samples.length, 0);
});

test("frame evidence has an isolated, bounded partition under the existing total byte cap", t => {
  setLocalDiagnosticsEnabled(false); setLocalDiagnosticsEnabled(true);
  t.after(() => setLocalDiagnosticsEnabled(false));
  recordLocalDiagnostic("scroll-write", { sequence: 1 });
  const events = captureLocalDiagnostics().samples;
  for (let i = 0; i < LOCAL_DIAGNOSTICS_FRAME_LIMIT + 10; i++) recordLocalDiagnostic("scroll-frame", { sequence: i });
  let report = captureLocalDiagnostics();
  assert.deepEqual(report.samples, events, "frame sampling must not evict measurement/write evidence");
  assert.equal(report.frames.samples.length, LOCAL_DIAGNOSTICS_FRAME_LIMIT);
  assert.equal(report.frames.samples[0]!.fields.sequence, 10);
  assert.equal(report.frames.evicted, 10);
  for (let i = 0; i < 500; i++) recordLocalDiagnostic("scroll-frame", { sequence: i, a: "界".repeat(512), b: "界".repeat(512) });
  for (let i = 0; i < 500; i++) recordLocalDiagnostic("sample", { sequence: i, a: "界".repeat(512), b: "界".repeat(512) });
  report = captureLocalDiagnostics();
  assert.ok(report.frames.bytes <= LOCAL_DIAGNOSTICS_FRAME_BYTES);
  assert.ok(report.bytes <= LOCAL_DIAGNOSTICS_BYTES);
  assert.ok(report.frames.samples.length < LOCAL_DIAGNOSTICS_FRAME_LIMIT);
  assert.equal(report.frames.samples.at(-1)!.fields.sequence, 499);
  setLocalDiagnosticsEnabled(false);
  const frozen = captureLocalDiagnostics();
  recordLocalDiagnostic("scroll-frame", { sequence: 999 });
  assert.deepEqual(captureLocalDiagnostics(), frozen);
  setLocalDiagnosticsEnabled(true);
  assert.equal(captureLocalDiagnostics().frames.samples.length, 0);
  assert.equal(captureLocalDiagnostics().frames.bytes, 0);
});

test("runtime wrappers detach on disable and discard delayed fetch failures across collection sessions", async t => {
  setLocalDiagnosticsEnabled(false); clearRuntimeDiagnostics();
  const originalFetch = globalThis.fetch, originalError = console.error, originalWarn = console.warn;
  let resolve!: (response: Response) => void;
  const request = new Promise<Response>(done => { resolve = done; });
  const fake = (() => request) as typeof fetch;
  globalThis.fetch = fake;
  t.after(() => { setLocalDiagnosticsEnabled(false); globalThis.fetch = originalFetch; clearRuntimeDiagnostics(); });
  startRuntimeDiagnosticCollection();
  assert.equal(globalThis.fetch, fake);
  assert.equal(console.warn, originalWarn);
  recordRuntimeDiagnosticConsole("console.warn", ["ignored"]);
  assert.equal(getRuntimeDiagnosticsSnapshot().errors.length, 0);
  setLocalDiagnosticsEnabled(true);
  assert.notEqual(globalThis.fetch, fake);
  assert.notEqual(console.warn, originalWarn);
  const pending = fetch("https://local.test/request?token=private");
  recordRuntimeDiagnosticConsole("console.warn", [new Error("x".repeat(20000))]);
  assert.equal(getRuntimeDiagnosticsSnapshot().errors.at(-1)!.message.length, 2048);
  assert.ok(getRuntimeDiagnosticsSnapshot().errors.at(-1)!.stack!.length <= 4096);
  setLocalDiagnosticsEnabled(false);
  assert.equal(globalThis.fetch, fake);
  assert.equal(console.error, originalError);
  assert.equal(console.warn, originalWarn);
  setLocalDiagnosticsEnabled(true);
  resolve(new Response("failure", { status: 503 })); await pending;
  assert.equal(getRuntimeDiagnosticsSnapshot().network.length, 0, "an old request cannot leak into a new recording");
});
