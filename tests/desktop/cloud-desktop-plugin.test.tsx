import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { LocaleRuntime } from "@opencraft/i18n";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createCloudDesktopWorkbenchPanelPlugin, DesktopViewController,
  type DesktopAttachment, type DesktopBackend, type DesktopConnection,
  type DesktopConnectionSnapshot, type DesktopControlLease, type DesktopTarget } from "../../plugins/cloud-desktop/src/index";
import { captureFramePreview, validFramePreview } from "../../plugins/cloud-desktop/src/frame-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// Test-only external backend/media boundary. Never used in application bootstrap.
function fixture(timeoutMs = 120_000) {
  const calls: string[] = [];
  let target: DesktopTarget | null = { conversationId: "thread:a", serverId: "server:a",
    environmentId: "env:a", principalId: "account:a" };
  let state: DesktopConnectionSnapshot = { videoReady: false, inputReady: false, controlAvailable: true, ended: false };
  const backendListeners = new Set<() => void>();
  const connectionListeners = new Set<() => void>();
  const revocationListeners = new Set<() => void>();
  let valid = true;
  const lease: DesktopControlLease = {
    isValid: () => valid,
    subscribeRevoked: listener => { revocationListeners.add(listener); return () => revocationListeners.delete(listener); },
    release: () => { calls.push("control:release"); valid = false; },
  };
  const connection: DesktopConnection = {
    getSnapshot: () => state,
    subscribe: listener => { connectionListeners.add(listener); return () => connectionListeners.delete(listener); },
    requestControl: async () => { calls.push("control:request"); return lease; },
    close: () => { calls.push("connection:close"); },
  };
  const attachment: DesktopAttachment = {
    target: target!, resourceId: "machine:a", incarnation: "run:1",
    connect: async () => { calls.push("connection:open"); return connection; },
    release: () => { calls.push("attachment:release"); },
  };
  const backend: DesktopBackend = {
    resolveTarget: id => target?.conversationId === id ? target : null,
    subscribe: listener => { backendListeners.add(listener); return () => backendListeners.delete(listener); },
    prepare: async () => { calls.push("prepare"); return attachment; },
  };
  const surfaces = { mount: () => {
    calls.push("surface:mount");
    return { enableInput: () => { calls.push("input:enable"); }, disableInput: () => { calls.push("input:disable"); },
      setActive: (active: boolean) => { calls.push(`surface:active:${active}`); },
      focus: () => { calls.push("input:focus"); },
      pasteText: async (text: string) => { calls.push(`paste:${text}`); },
      dispose: () => { calls.push("surface:dispose"); } };
  } };
  const controller = new DesktopViewController(backend, surfaces, "thread:a", {} as HTMLElement, timeoutMs);
  return {
    controller, backend, surfaces, attachment, connection, lease, calls, backendListeners, connectionListeners,
    setTarget(next: DesktopTarget | null) { target = next; for (const listener of backendListeners) listener(); },
    setState(patch: Partial<DesktopConnectionSnapshot>) { state = { ...state, ...patch }; for (const listener of connectionListeners) listener(); },
    revoke() { valid = false; for (const listener of revocationListeners) listener(); },
  };
}

test("current connection geometry projects without remounting or granting input and clears with identity", async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush();
    f.setState({ videoReady: true, inputReady: true, mediaAspectRatio: 1.6 });
    assert.equal(f.controller.getSnapshot().mediaAspectRatio, 1.6);
    f.setState({ mediaAspectRatio: .625 });
    assert.equal(f.controller.getSnapshot().mediaAspectRatio, .625);
    assert.equal(f.calls.filter(call => call === 'surface:mount').length, 1);
    assert.equal(f.calls.includes('control:request'), false);
    f.setTarget(null);
    assert.equal(f.controller.getSnapshot().mediaAspectRatio, undefined);
  } finally { f.controller.dispose(); }
});

test("recovery frame is reused only after a fresh matching physical binding, never grants input", async () => {
  const f = fixture();
  const frame = { dataUrl: 'data:image/jpeg;base64,YWJj', aspectRatio: 1.6 };
  try {
    f.connection.capturePreview = () => frame;
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    f.setState({ ended: true });
    const prepared = deferred<DesktopAttachment>();
    f.backend.prepare = () => prepared.promise;
    f.controller.retry();
    assert.equal(f.controller.getSnapshot().preview, undefined, 'new authorization is pending');
    f.setState({ ended: false, videoReady: false, inputReady: false });
    prepared.resolve(f.attachment); await flush();
    assert.deepEqual(f.controller.getSnapshot().preview, frame);
    assert.equal(f.controller.getSnapshot().mediaAspectRatio, 1.6);
    assert.equal(f.controller.getSnapshot().canControl, false);
    assert.equal(f.calls.includes('control:request'), false);
    f.setState({ videoReady: true, inputReady: true });
    assert.equal(f.controller.getSnapshot().control, 'observing');
    f.setTarget(null);
    assert.equal(f.controller.getSnapshot().preview, undefined);
    f.controller.dispose(); assert.equal(f.controller.getSnapshot().preview, undefined);
  } finally { f.controller.dispose(); }
});

test("new physical incarnation, principal, or denied authorization cannot reuse a frame", async () => {
  for (const reason of ['incarnation', 'principal', 'authorization'] as const) {
    const f = fixture();
    try {
      f.connection.capturePreview = () => ({ dataUrl: 'data:image/jpeg;base64,YWJj', aspectRatio: 1.6 });
      f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
      f.setState({ ended: true, failure: reason === 'authorization' ? 'authorization' : 'transport' });
      const next = { ...f.attachment, incarnation: reason === 'incarnation' ? 'run:2' : 'run:1' };
      if (reason === 'principal') {
        const target = { ...f.attachment.target, principalId: 'account:b' };
        f.backend.prepare = async () => ({ ...next, target });
        f.setTarget(target);
      } else { f.backend.prepare = async () => next; f.controller.retry(); }
      f.setState({ ended: false, videoReady: false, inputReady: false }); await flush();
      assert.equal(f.controller.getSnapshot().preview, undefined, reason);
    } finally { f.controller.dispose(); }
  }
});

test("invalid and reentrant frame capture cannot poison a successor view", async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    f.connection.capturePreview = () => { f.setTarget(null); return { dataUrl: 'data:image/jpeg;base64,YWJj', aspectRatio: 1.6 }; };
    f.setState({ ended: true });
    assert.equal(f.controller.getSnapshot().phase, 'unavailable');
    assert.equal(f.controller.getSnapshot().preview, undefined);
    assert.equal(validFramePreview({ dataUrl: 'https://external/image.jpg', aspectRatio: 1 }), false);
    assert.equal(validFramePreview({ dataUrl: 'data:image/jpeg;base64,YWJj', aspectRatio: Infinity }), false);
  } finally { f.controller.dispose(); }
});

test("frame capture uses bounded backing pixels and failure is optional", () => {
  const calls: unknown[] = [];
  const copy = { width: 0, height: 0, getContext: () => ({ drawImage: (...args: unknown[]) => calls.push(args) }),
    toDataURL: (type: string, quality: number) => { calls.push([type, quality]); return 'data:image/jpeg;base64,YWJj'; } };
  const canvas = { width: 3840, height: 2160, ownerDocument: { createElement: () => copy } } as unknown as HTMLCanvasElement;
  assert.deepEqual(captureFramePreview(canvas), { dataUrl: 'data:image/jpeg;base64,YWJj', aspectRatio: 3840 / 2160 });
  assert.equal(copy.width, 1280); assert.equal(copy.height, 720);
  assert.deepEqual(calls[1], ['image/jpeg', .85]);
  copy.toDataURL = () => { throw new Error('tainted'); };
  assert.equal(captureFramePreview(canvas), null);
});

test("control activations are single-use fixed actions and cannot affect a successor intent", async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    const take = f.controller.prepareControlAction("take");
    take(); take(); await flush();
    assert.equal(f.calls.filter(call => call === "control:request").length, 1);
    const stop = f.controller.prepareControlAction("stop");
    f.controller.releaseControl(); // A null focusout can retire input before click.
    stop();
    assert.equal(f.controller.getSnapshot().control, "observing");
    assert.equal(f.calls.filter(call => call === "control:request").length, 1);
    const withdrawnTake = f.controller.prepareControlAction("take");
    f.setState({ controlAvailable: false }); f.setState({ controlAvailable: true });
    withdrawnTake();
    assert.equal(f.controller.getSnapshot().control, "observing", "restored readiness cannot revive an old take press");
    const pending = deferred<DesktopControlLease>();
    f.connection.requestControl = () => pending.promise;
    const newRequest = f.controller.requestControl();
    const cancel = f.controller.prepareControlAction("stop");
    stop(); // The old stop cannot cancel a later explicit take.
    assert.equal(f.controller.getSnapshot().control, "requesting");
    const freshLease = { ...f.lease, isValid: () => true };
    pending.resolve(freshLease); await newRequest;
    assert.equal(f.controller.getSnapshot().control, "controlling");
    cancel(); // A grant confirmation does not replace the original intent.
    assert.equal(f.controller.getSnapshot().control, "observing");
    const oldTake = f.controller.prepareControlAction("take");
    f.setState({ ended: true }); f.controller.retry(); await flush();
    oldTake();
    assert.equal(f.controller.getSnapshot().control, "observing", "connection replacement fences old presses");
  } finally { f.controller.dispose(); }
});

test("revocation retires a held stop before a successor control grant", async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    await f.controller.requestControl();
    const stop = f.controller.prepareControlAction("stop");
    f.revoke();
    f.connection.requestControl = async () => ({ ...f.lease, isValid: () => true });
    await f.controller.requestControl(); stop();
    assert.equal(f.controller.getSnapshot().control, "controlling");
  } finally { f.controller.dispose(); }
});

test("inactive presentation keeps viewing but retires control intent and late grants", async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    const oldTake = f.controller.prepareControlAction("take");
    f.controller.setActive(false); f.controller.setActive(true); oldTake(); await flush();
    assert.equal(f.calls.includes("control:request"), false, "reopening cannot replay a Take captured before hiding");
    await f.controller.requestControl();
    f.controller.setActive(false);
    assert.equal(f.controller.getSnapshot().phase, "ready");
    assert.equal(f.controller.getSnapshot().control, "observing");
    assert.ok(f.calls.includes("input:disable")); assert.ok(f.calls.includes("control:release"));
    assert.equal(f.calls.at(-1), "surface:active:false", "logical hide retires overlays before exit animation");
    assert.equal(f.calls.includes("connection:close"), false);
    assert.equal(f.calls.includes("attachment:release"), false);
    const count = f.calls.filter(call => call === "control:request").length;
    await f.controller.requestControl(); assert.equal(f.calls.filter(call => call === "control:request").length, count);
    f.controller.setActive(true);
    assert.equal(f.calls.at(-1), "surface:active:true", "reopening restores presentation, not input");
    const grant = deferred<DesktopControlLease>(); f.connection.requestControl = () => grant.promise;
    const take = f.controller.prepareControlAction("take");
    const pending = f.controller.requestControl(); f.controller.setActive(false); f.controller.setActive(true);
    const callsBefore = f.calls.length;
    grant.resolve({ ...f.lease, isValid: () => true }); await pending;
    take(); await flush();
    assert.equal(f.controller.getSnapshot().control, "observing");
    assert.equal(f.calls.slice(callsBefore).includes("input:enable"), false);
    assert.equal(f.calls.filter(call => call === "surface:mount").length, 1);
  } finally { f.controller.dispose(); }
});

test("media arriving while hidden receives current presentation activity without dropping viewing", async () => {
  const f = fixture();
  const prepared = deferred<DesktopAttachment>(); f.backend.prepare = () => prepared.promise;
  try {
    f.controller.start(); f.controller.setActive(false);
    prepared.resolve(f.attachment); await flush();
    assert.equal(f.calls.filter(x => x.startsWith("surface:active:")).at(-1), "surface:active:false");
    assert.equal(f.calls.includes("connection:close"), false);
    f.controller.setActive(true);
    assert.equal(f.calls.at(-1), "surface:active:true");
    assert.equal(f.calls.includes("input:enable"), false);
    assert.equal(f.calls.filter(x => x === "surface:mount").length, 1);
  } finally { f.controller.dispose(); }
});

test("Take acquires focus before requesting; late confirmation cannot reclaim departed focus", async () => {
  const f = fixture(); let focused = true;
  const grant = deferred<DesktopControlLease>();
  f.connection.requestControl = () => { f.calls.push("control:request"); return grant.promise; };
  const controller = new DesktopViewController(f.backend, f.surfaces, "thread:a", {} as HTMLElement,
    undefined, undefined, () => focused);
  try {
    controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    const pending = controller.requestControl();
    assert.equal(controller.getSnapshot().control, "requesting");
    assert.ok(f.calls.indexOf("input:focus") < f.calls.indexOf("control:request"));
    assert.equal(f.calls.includes("input:enable"), false);
    focused = false; // An adapter may miss focusout; derived eligibility still fences the grant.
    grant.resolve(f.lease); await pending;
    assert.equal(controller.getSnapshot().control, "observing");
    assert.equal(f.calls.includes("input:enable"), false);
    assert.equal(f.calls.filter(call => call === "input:focus").length, 1);
    assert.ok(f.calls.includes("control:release"));
  } finally { controller.dispose(); }
});

test("failed or synchronously cancelled focus does not request control", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture();
    const controller = new DesktopViewController(f.backend, { mount() {
      return { ...f.surfaces.mount(), focus() { if (cancelled) controller.releaseControl(); } };
    } }, "thread:a", {} as HTMLElement, undefined, undefined, () => false);
    try {
      controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
      await controller.requestControl();
      assert.equal(controller.getSnapshot().control, "observing");
      assert.equal(f.calls.includes("control:request"), false);
    } finally { controller.dispose(); }
  }
});

test("paste availability is a surface capability, not an exclusive control state", async () => {
  for (const supported of [true, false]) {
    const f = fixture();
    const controller = new DesktopViewController(f.backend, { mount() {
      const surface = f.surfaces.mount();
      return { ...surface, pasteText: supported ? surface.pasteText : undefined };
    } }, "thread:a", {} as HTMLElement);
    try {
      controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
      assert.equal(controller.getSnapshot().pasteAvailable, supported);
      assert.equal(Boolean(controller.getSnapshot().canPaste), false);
      await controller.requestControl();
      assert.equal(controller.getSnapshot().canPaste, supported);
      controller.releaseControl();
      assert.equal(controller.getSnapshot().pasteAvailable, supported);
    } finally { controller.dispose(); }
  }
});

test("first-frame timeout retains its stage and emits only safe diagnostic fields", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(20);
  const records: unknown[] = [];
  const controller = new DesktopViewController(f.backend, f.surfaces, "thread:a", {} as HTMLElement, 20, record => records.push(record));
  controller.start(); await flush(); f.setState({ inputReady: true });
  assert.equal(controller.getSnapshot().stage, "video");
  t.mock.timers.tick(20);
  assert.equal(controller.getSnapshot().phase, "failed");
  assert.equal(controller.getSnapshot().stage, "video");
  assert.equal(controller.getSnapshot().failure, "timeout");
  assert.deepEqual(Object.keys(records[0] as object).sort(), ["elapsedMs", "generation", "operation", "reason", "stage"]);
  f.setState({ videoReady: true });
  assert.equal(controller.getSnapshot().phase, "failed", "late frame cannot resurrect a failed attempt");
  controller.dispose();
});

test("clipboard reads are user initiated, coalesced and fenced by the original control grant", async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); f.controller.start(); await flush();
    const pending = deferred<string>(); let reads = 0;
    await f.controller.pasteClipboard(async () => { reads++; return "unexpected"; });
    assert.equal(reads, 0, "observe mode cannot read local clipboard");
    f.setState({ videoReady: true, inputReady: true }); await f.controller.requestControl();
    assert.ok(f.calls.indexOf("input:focus") < f.calls.indexOf("control:request"));
    assert.ok(f.calls.indexOf("input:enable") > f.calls.indexOf("control:request"));
    const paste = f.controller.pasteClipboard(() => { reads++; return pending.promise; });
    await f.controller.pasteClipboard(async () => { reads++; return "duplicate"; });
    assert.equal(reads, 1);
    if (revoke) f.revoke();
    pending.resolve("test clipboard"); await paste;
    assert.equal(f.calls.includes("paste:test clipboard"), !revoke);
    f.controller.dispose();
  }
});

test("clipboard denial, empty and oversized text do not send remote input", async () => {
  const f = fixture(); f.controller.start(); await flush();
  f.setState({ videoReady: true, inputReady: true }); await f.controller.requestControl();
  await f.controller.pasteClipboard(async () => { throw new Error("sensitive clipboard permission payload"); });
  assert.equal(f.controller.getSnapshot().clipboardFailed, true);
  await f.controller.pasteClipboard(async () => "");
  await f.controller.pasteClipboard(async () => "a".repeat(16_385));
  assert.equal(f.calls.some(call => call.startsWith("paste:")), false);
  f.controller.dispose();
});

test("clipboard permission wait is bounded; blur retires a never-resolving read", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [false, true]) {
    const f = fixture(); f.controller.start(); await flush();
    f.setState({ videoReady: true, inputReady: true }); await f.controller.requestControl();
    const pending = f.controller.pasteClipboard(() => new Promise<string>(() => {}));
    if (cancel) f.controller.releaseControl(); else t.mock.timers.tick(5_000);
    await pending;
    assert.equal(f.controller.getSnapshot().clipboardBusy, false);
    assert.equal(f.controller.getSnapshot().clipboardFailed, !cancel);
    assert.equal(f.calls.some(call => call.startsWith("paste:")), false);
    f.controller.dispose();
  }
});

for (const first of ["videoReady", "inputReady"] as const) test(`readiness is order-independent: ${first} first`, async () => {
  const f = fixture();
  try {
    f.controller.start(); await flush();
    f.setState({ [first]: true });
    assert.equal(f.controller.getSnapshot().phase, "connecting");
    await f.controller.requestControl();
    assert.equal(f.calls.includes("control:request"), false);
    f.setState({ videoReady: true, inputReady: true });
    assert.equal(f.controller.getSnapshot().phase, "ready");
    await f.controller.requestControl();
    assert.equal(f.controller.getSnapshot().control, "controlling");
    assert.equal(f.calls.filter(x => x === "input:enable").length, 1);
    f.revoke();
    assert.equal(f.controller.getSnapshot().control, "observing");
    assert.deepEqual(f.calls.slice(-2), ["input:disable", "control:release"]);
  } finally { f.controller.dispose(); }
});

test("unavailable and wrong-conversation targets never prepare a desktop", async () => {
  const f = fixture();
  f.backend.resolveTarget = () => ({ ...f.attachment.target, conversationId: "thread:b" });
  f.controller.start(); await flush();
  assert.equal(f.controller.getSnapshot().phase, "unavailable");
  assert.deepEqual(f.calls, []);
  f.controller.dispose();
});

test("late preparation after unmount only releases the viewer attachment", async () => {
  const f = fixture(); const pending = deferred<DesktopAttachment>();
  f.backend.prepare = (_target, signal) => { signal.addEventListener("abort", () => f.calls.push("aborted")); return pending.promise; };
  f.controller.start(); f.controller.dispose(); pending.resolve(f.attachment); await flush();
  assert.deepEqual(f.calls, ["aborted", "attachment:release"]);
  assert.equal(f.backendListeners.size, 0);
});

test("a retired connection is closed when connect completes late", async () => {
  const f = fixture(); const pending = deferred<DesktopConnection>();
  f.attachment.connect = () => pending.promise;
  f.controller.start(); await flush(); f.setTarget(null);
  pending.resolve(f.connection); await flush();
  assert.equal(f.controller.getSnapshot().phase, "unavailable");
  assert.equal(f.calls.includes("surface:mount"), false);
  assert.equal(f.calls.filter(x => x === "attachment:release").length, 1);
  assert.equal(f.calls.filter(x => x === "connection:close").length, 1);
  f.controller.dispose();
});

test("changing principal fences old bootstrap without changing the tab identity", async () => {
  const f = fixture(); const pending = deferred<DesktopAttachment>();
  const second = { ...f.attachment, target: { ...f.attachment.target, principalId: "account:b" },
    incarnation: "run:2", release: () => f.calls.push("second:release") };
  let attempts = 0;
  f.backend.prepare = async () => ++attempts === 1 ? pending.promise : second;
  f.controller.start(); f.setTarget(second.target); await flush();
  f.setState({ videoReady: true, inputReady: true });
  pending.resolve(f.attachment); await flush();
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.calls.filter(x => x === "surface:mount").length, 1);
  assert.equal(f.calls.filter(x => x === "attachment:release").length, 1);
  f.controller.dispose(); assert.ok(f.calls.includes("second:release"));
});

test("bootstrap identity mismatch fails closed and releases its attachment", async () => {
  const f = fixture();
  f.backend.prepare = async () => ({ ...f.attachment, target: { ...f.attachment.target, serverId: "other" } });
  f.controller.start(); await flush();
  assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.deepEqual(f.calls, ["attachment:release"]);
  f.controller.dispose();
});

test("target invalidation during lease cleanup cannot resurrect an intermediate account", async () => {
  const f = fixture();
  const second = { ...f.attachment.target, principalId: "account:b" };
  const third = { ...f.attachment.target, principalId: "account:c" };
  const prepared: string[] = [];
  f.backend.prepare = async target => {
    prepared.push(target.principalId);
    return { ...f.attachment, target, incarnation: target.principalId };
  };
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  await f.controller.requestControl();
  const release = f.lease.release;
  f.lease.release = () => { release(); f.setTarget(third); };
  f.setTarget(second); await flush();
  assert.deepEqual(prepared, ["account:a", "account:c"]);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.controller.getSnapshot().control, "observing"); f.controller.dispose();
});

test("control cancellation releases late grants without enabling input", async () => {
  const f = fixture(); const pending = deferred<DesktopControlLease>();
  f.connection.requestControl = () => pending.promise;
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  const request = f.controller.requestControl();
  assert.equal(f.controller.getSnapshot().control, "requesting");
  f.controller.releaseControl(); pending.resolve(f.lease); await request;
  assert.equal(f.calls.includes("input:enable"), false);
  assert.equal(f.controller.getSnapshot().control, "observing");
  assert.ok(f.calls.includes("control:release")); f.controller.dispose();
});

test("connection failure retires control, transport and attachment; retry is explicit", async () => {
  const f = fixture();
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  await f.controller.requestControl(); f.setState({ ended: true });
  assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.equal(f.connectionListeners.size, 0);
  assert.ok(f.calls.indexOf("control:release") < f.calls.indexOf("connection:close"));
  assert.ok(f.calls.includes("attachment:release"));
  f.setTarget(f.attachment.target); await flush();
  assert.equal(f.calls.filter(x => x === "prepare").length, 1);
  f.setState({ ended: false }); f.controller.retry(); await flush();
  assert.equal(f.controller.getSnapshot().phase, "ready"); f.controller.dispose();
});

test("opted-in transport recovery retires old ownership and obtains a new viewer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); Object.assign(f.backend, { recoverTransport: true });
  t.after(() => f.controller.dispose());
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  await f.controller.requestControl();
  f.setState({ ended: true, retryable: true });
  assert.equal(f.controller.getSnapshot().phase, "connecting");
  assert.equal(f.controller.getSnapshot().control, "observing");
  assert.equal(f.connectionListeners.size, 0);
  assert.ok(f.calls.indexOf("control:release") < f.calls.indexOf("connection:close"));
  assert.equal(f.calls.filter(x => x === "attachment:release").length, 1);
  // Backend refreshes and repeated user gestures cannot create parallel grants.
  f.controller.retry(); f.setTarget(f.attachment.target);
  t.mock.timers.tick(999); await flush();
  assert.equal(f.calls.filter(x => x === "prepare").length, 1);
  f.setState({ ended: false, retryable: false });
  t.mock.timers.tick(1); await flush();
  assert.equal(f.calls.filter(x => x === "prepare").length, 2);
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(f.calls.filter(x => x === "control:request").length, 1, "input must not be reacquired");
});

test("flapping recovery has bounded backoff and stable viewing resets its budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); Object.assign(f.backend, { recoverTransport: true });
  t.after(() => f.controller.dispose());
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  for (const delay of [1_000, 2_000, 4_000]) {
    f.setState({ ended: true, retryable: true });
    f.setState({ ended: false, retryable: false });
    t.mock.timers.tick(delay - 1); await flush();
    assert.equal(f.controller.getSnapshot().phase, "connecting");
    t.mock.timers.tick(1); await flush();
    assert.equal(f.controller.getSnapshot().phase, "ready");
  }
  f.setState({ ended: true, retryable: true });
  assert.equal(f.controller.getSnapshot().phase, "failed");
  t.mock.timers.tick(60_000); await flush();
  assert.equal(f.calls.filter(x => x === "prepare").length, 4);
  f.setState({ ended: false, retryable: false }); f.controller.retry(); await flush();
  f.setState({ ended: true, retryable: true });
  f.setState({ ended: false, retryable: false }); t.mock.timers.tick(1_000); await flush();
  t.mock.timers.tick(30_000); await flush();
  f.setState({ ended: true, retryable: true });
  f.setState({ ended: false, retryable: false }); t.mock.timers.tick(1_000); await flush();
  assert.equal(f.controller.getSnapshot().phase, "ready", "sustained viewing starts a new episode");
});

test("automatic recovery requires both safe backend opt-in and classified transport loss", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [optedIn, retryable] of [[false, true], [true, false]] as const) {
    const f = fixture(); Object.assign(f.backend, { recoverTransport: optedIn });
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    f.setState({ ended: true, retryable }); t.mock.timers.tick(10_000); await flush();
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.calls.filter(x => x === "prepare").length, 1);
    f.controller.dispose();
  }
});

test("prepare failure stops recovery; target withdrawal and disposal cancel its backoff", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["fail", "withdraw", "dispose"] as const) {
    const f = fixture(); Object.assign(f.backend, { recoverTransport: true });
    f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
    f.setState({ ended: true, retryable: true });
    if (action === "fail") f.backend.prepare = async () => { f.calls.push("prepare:failed"); throw new Error("private"); };
    if (action === "withdraw") f.setTarget(null);
    if (action === "dispose") f.controller.dispose();
    t.mock.timers.tick(60_000); await flush();
    assert.equal(f.calls.filter(x => x === "prepare").length, 1);
    assert.equal(f.calls.filter(x => x === "prepare:failed").length, action === "fail" ? 1 : 0);
    assert.equal(f.controller.getSnapshot().phase, action === "fail" ? "failed" : "unavailable");
    f.controller.dispose();
  }
});

test("permission withdrawal and synchronous revocation cannot grant control", async () => {
  const f = fixture();
  f.controller.start(); await flush(); f.setState({ videoReady: true, inputReady: true });
  f.lease.subscribeRevoked = listener => { f.revoke(); listener(); return () => f.calls.push("revoke:unsubscribe"); };
  await f.controller.requestControl();
  assert.equal(f.calls.includes("input:enable"), false);
  assert.ok(f.calls.includes("revoke:unsubscribe"));
  f.setState({ controlAvailable: false });
  assert.equal(f.controller.getSnapshot().canControl, false); f.controller.dispose();
});

test("bootstrap timeout cancels, with late attachments reconciled", async () => {
  const f = fixture(5); const pending = deferred<DesktopAttachment>();
  f.backend.prepare = () => pending.promise;
  f.controller.start(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.controller.getSnapshot().phase, "failed");
  pending.resolve(f.attachment); await flush();
  assert.deepEqual(f.calls, ["attachment:release"]); f.controller.dispose();
});

test("one faulty disposer does not skip remaining release steps", async () => {
  const f = fixture();
  f.connection.close = () => { throw new Error("private backend details"); };
  f.controller.start(); await flush(); f.controller.dispose(); f.controller.dispose();
  assert.equal(f.calls.filter(x => x === "attachment:release").length, 1);
  assert.ok(f.calls.includes("surface:dispose"));
});

test("synchronously ended connection subscriptions are still unsubscribed", async () => {
  const f = fixture();
  f.connection.subscribe = listener => {
    f.setState({ ended: true }); listener();
    return () => f.calls.push("connection:unsubscribe");
  };
  f.controller.start(); await flush();
  assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.ok(f.calls.includes("connection:unsubscribe"));
  assert.equal(f.calls.filter(x => x === "attachment:release").length, 1); f.controller.dispose();
});

test("backend subscription failures fail closed and can be retried without throwing into React", async () => {
  const f = fixture(); const subscribe = f.backend.subscribe;
  f.backend.subscribe = () => { throw new Error("private transport details"); };
  f.controller.start(); assert.equal(f.controller.getSnapshot().phase, "failed");
  assert.deepEqual(f.calls, []);
  f.backend.subscribe = subscribe; f.controller.retry(); await flush();
  f.setState({ videoReady: true, inputReady: true });
  assert.equal(f.controller.getSnapshot().phase, "ready");
  assert.equal(JSON.stringify(f.controller.getSnapshot()).includes("private"), false); f.controller.dispose();
});

test("self-registration is capability-gated; opening twice focuses one tab per conversation", async () => {
  const runtime = await createWorkbenchPanelReactRuntime(); const f = fixture();
  try {
    const empty = await runtime.install(createCloudDesktopWorkbenchPanelPlugin());
    assert.equal(runtime.panels.getToolbarActionSnapshot().length, 0); await empty.dispose();
    const installed = await runtime.install(createCloudDesktopWorkbenchPanelPlugin(f));
    const action = runtime.panels.getToolbarActionSnapshot()[0]!;
    assert.equal(action.id, "opencraft.cloud-desktop.open", "neutral desktop entry is not owned by the downstream product");
    const context = { ownerId: "panel:a", resourceOwnerId: "thread:a", hostId: "legacy-route", cwd: null };
    assert.equal(action.isAvailable?.({ ...context, resourceOwnerId: "thread:b" }), false);
    await action.run(context); await action.run(context);
    const tabs = runtime.panels.getOwnerSnapshot(context.ownerId).right.tabs;
    assert.equal(tabs.length, 1); assert.equal(tabs[0]!.resource, "thread:a");
    assert.equal(tabs[0]!.showTabIcon, true);
    assert.equal("token" in tabs[0]!, false);
    let notifications = 0;
    const unsubscribe = runtime.panels.subscribeToolbarActions(() => ++notifications);
    f.setTarget(null); assert.ok(notifications > 0);
    assert.equal(runtime.panels.getToolbarActionSnapshot()[0]!.isAvailable?.(context), false);
    unsubscribe(); await installed.dispose();
    assert.equal(runtime.panels.getOwnerSnapshot(context.ownerId).right.tabs.length, 0);
    assert.equal(f.backendListeners.size, 0);
  } finally { await runtime.dispose(); }
});

test("real panel component mounts observe-only, releases on blur, and cleans up on unload", async t => {
  // JSDOM verifies behavior; the real stylesheet is checked by browser smokes.
  const styles = registerHooks({ resolve(specifier, context, next) {
    return specifier.endsWith(".scss") ? { url: "data:text/javascript,export {}", shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => styles.deregister());
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
    url: "https://example.test", pretendToBeVisual: true,
  });
  const values = { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const runtime = await createWorkbenchPanelReactRuntime(); const f = fixture();
  const root = createRoot(dom.window.document.getElementById("root")!);
  const locale = new LocaleRuntime([]); await locale.update({ ideLocale: "en-US" });
  try {
    const installed = await runtime.install(createCloudDesktopWorkbenchPanelPlugin({ ...f,
      surfaces: { mount(element) {
        const surface = f.surfaces.mount();
        return { ...surface, focus() { surface.focus(); element.focus({ preventScroll: true }); } };
      } },
    }));
    const tab = runtime.panels.open("panel:a", "cloud-desktop", { conversationId: "thread:a" });
    const Panel = runtime.renderers.getSnapshot()[0]!.Component;
    assert.equal(runtime.renderers.getSnapshot()[0]!.residency, "while-tab-open");
    await act(async () => { root.render(<IntlRuntimeProvider runtime={locale}>
      <Panel tab={tab} ownerId="panel:a" presentationId="view:a" />
    </IntlRuntimeProvider>); await flush(); });
    for (let attempt = 0; attempt < 50 && !dom.window.document.querySelector(".cloud-desktop-panel"); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    assert.ok(dom.window.document.body.textContent?.includes("Connecting"));
    const surface = dom.window.document.querySelector(".cloud-desktop-panel__surface");
    assert.ok(dom.window.document.querySelector(".ui-empty-state__title")?.textContent?.includes("Connecting to desktop"));
    assert.equal(dom.window.document.querySelector("button")!.disabled, true);
    const controls = dom.window.document.querySelector('.ui-desktop-view__controls')!;
    assert.equal(controls.getAttribute('data-visible'), 'false');
    assert.equal(controls.getAttribute('aria-hidden'), 'true');
    assert.equal(controls.hasAttribute('inert'), true);
    await act(async () => { f.setState({ videoReady: true, inputReady: true }); });
    assert.equal(controls.getAttribute('data-visible'), 'true');
    assert.equal(controls.hasAttribute('aria-hidden'), false);
    assert.equal(controls.hasAttribute('inert'), false);
    const button = dom.window.document.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
    assert.equal(button.getAttribute("aria-pressed"), "false");
    const touch = (name: string, id: number, x: number, primary = true) => {
      const event = new dom.window.MouseEvent(name, { bubbles: true, button: 0, clientX: x, clientY: 20 });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" }, isPrimary: { value: primary } });
      surface!.dispatchEvent(event);
    };
    await act(async () => {
      touch("pointerdown", 10, 20); touch("pointermove", 10, 40); touch("pointerup", 10, 40);
      touch("pointerdown", 11, 20); touch("pointerdown", 12, 30, false);
      touch("pointerup", 11, 20); touch("pointerup", 12, 30, false);
      touch("pointerdown", 13, 20); touch("pointercancel", 13, 20); touch("pointerup", 13, 20);
      await flush();
    });
    assert.equal(f.calls.includes("control:request"), false, "drag, second finger and cancellation never take control");
    const grant = deferred<DesktopControlLease>();
    f.connection.requestControl = () => grant.promise;
    const toolbarPointer = (name: string) => {
      const event = new dom.window.MouseEvent(name, { bubbles: true, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 20 }, pointerType: { value: "touch" }, isPrimary: { value: true } });
      button.dispatchEvent(event);
    };
    await act(async () => {
      toolbarPointer("pointerdown"); toolbarPointer("lostpointercapture");
      toolbarPointer("pointerup");
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
      await flush();
    });
    assert.equal(button.getAttribute("aria-pressed"), "false", "capture lost before release cancels the held take");
    await act(async () => {
      toolbarPointer("pointerdown"); toolbarPointer("pointerup");
      toolbarPointer("lostpointercapture");
      await flush();
    });
    assert.equal(button.getAttribute("aria-pressed"), "false", "toolbar authorization waits for the native click");
    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 })); await flush();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true", "pressed projects control intent, not authorization");
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__toolbar")!.getAttribute("aria-busy"), "true");
    assert.equal(button.getAttribute("aria-busy"), null, "stop intent remains actionable while awaiting authorization");
    assert.equal(button.querySelector('[data-current="true"]')!.textContent, "Stop controlling");
    assert.equal(f.calls.includes("input:enable"), false);
    assert.equal(dom.window.document.querySelector('.ui-desktop-view')!.getAttribute('data-owned'), 'false',
      "requesting cannot paint confirmed control");
    await act(async () => { grant.resolve(f.lease); await flush(); });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(dom.window.document.querySelector('.ui-desktop-view')!.getAttribute('data-owned'), 'true');
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__surface"), surface,
      "presentation phases cannot replace the media owner DOM");
    await act(async () => {
      button.focus();
      (dom.window.document.querySelector(".cloud-desktop-panel__surface") as HTMLElement).focus();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true", "toolbar to media focus stays in the desktop owner");
    await act(async () => {
      const down = new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 });
      Object.defineProperties(down, { pointerId: { value: 1 }, isPrimary: { value: true } });
      button.dispatchEvent(down);
      (surface as HTMLElement).blur();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true", "an unknown focus destination does not reinterpret a held stop");
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 })); await flush(); });
    assert.equal(button.getAttribute("aria-pressed"), "false", "a held stop cannot flip into take after null blur");
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__toolbar")!.getAttribute("aria-busy"), "false");
    // Independent accessibility click still starts a new request.
    const freshGrant = deferred<DesktopControlLease>();
    f.connection.requestControl = () => freshGrant.promise;
    await act(async () => { button.click(); await flush(); });
    assert.equal(button.querySelector('[data-current="true"]')!.textContent, "Stop controlling");
    await act(async () => {
      button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: " " }));
      freshGrant.resolve({ ...f.lease, isValid: () => true }); await flush();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    await act(async () => { button.click(); await flush(); });
    assert.equal(button.getAttribute("aria-pressed"), "false", "Space cancel keeps its action across grant confirmation");
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event("blur")); });
    assert.equal(button.getAttribute("aria-pressed"), "false");
    const pointer = (name: string, target: Element = button) => {
      const event = new dom.window.MouseEvent(name, { bubbles: true, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 2 }, isPrimary: { value: true } });
      target.dispatchEvent(event);
    };
    for (const cancel of ["pointercancel", "outside", "window-blur"]) {
      await act(async () => {
        pointer("pointerdown");
        if (cancel === "outside") pointer("pointerup", dom.window.document.body);
        else if (cancel === "pointercancel") pointer("pointercancel");
        else dom.window.dispatchEvent(new dom.window.Event("blur"));
        button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
        await flush();
      });
      assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__toolbar")!.getAttribute("aria-busy"), "false",
        `${cancel} retires the held take activation, not just its control grant`);
    }
    await act(async () => {
      button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      const repeat = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", repeat: true });
      button.dispatchEvent(repeat);
      assert.equal(repeat.defaultPrevented, true, "held Enter cannot alternate take and stop");
      dom.window.dispatchEvent(new dom.window.Event("blur"));
      button.click(); await flush();
    });
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__toolbar")!.getAttribute("aria-busy"), "false");
    // Logical hiding retains the media DOM and connection, but revokes input
    // before an animated Shell has physically hidden its aperture.
    f.connection.requestControl = async () => ({ ...f.lease, isValid: () => true });
    await act(async () => { button.click(); await flush(); });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    const renderActive = async (active: boolean) => act(async () => {
      root.render(<IntlRuntimeProvider runtime={locale}><Panel tab={tab} ownerId="panel:a" presentationId="view:a" active={active} /></IntlRuntimeProvider>);
      await flush();
    });
    await renderActive(false);
    assert.equal(button.disabled, true); assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__surface"), surface);
    assert.equal(f.calls.includes("connection:close"), false);
    await renderActive(true);
    assert.equal(button.disabled, false); assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(f.calls.filter(call => call === "surface:mount").length, 1);
    // Logical close revokes before an animated Shell has physically unmounted.
    await act(async () => { runtime.panels.close("panel:a", "right", tab.id); });
    assert.ok(dom.window.document.body.textContent?.includes("not available"));
    assert.equal(dom.window.document.querySelector(".cloud-desktop-panel__surface"), surface);
    assert.equal(dom.window.document.querySelector(".ui-empty-state__title")!.textContent, "Desktop unavailable");
    assert.ok(f.calls.includes("attachment:release"));
    await act(async () => { await installed.dispose(); });
    assert.equal(f.connectionListeners.size, 0);
    assert.ok(f.calls.includes("connection:close")); assert.ok(f.calls.includes("attachment:release"));
    await act(async () => root.unmount());
    assert.equal(f.calls.filter(x => x === "attachment:release").length, 1);
  } finally {
    await act(async () => root.unmount());
    await runtime.dispose(); locale.dispose(); dom.window.close();
    for (const key of Object.keys(values)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});


test("intentional release obtains a new observe-only viewer without retry opt-in or input", async () => {
  const f = fixture(); let prepares = 0;
  f.backend.prepare = async () => {
    prepares++;
    if (prepares > 1) f.setState({ ended: false, videoReady: false, inputReady: false, resumeObserving: undefined, controlAvailable: false });
    return f.attachment;
  };
  try {
    f.controller.start(); await flush();
    f.setState({ videoReady: true, inputReady: true });
    await f.controller.requestControl();
    assert.equal(f.controller.getSnapshot().control, "controlling");
    f.setState({ ended: true, resumeObserving: true }); await flush();
    assert.equal(prepares, 2);
    assert.equal(f.controller.getSnapshot().phase, "connecting");
    assert.equal(f.controller.getSnapshot().control, "observing");
    f.setState({ videoReady: true, inputReady: true });
    assert.equal(f.controller.getSnapshot().phase, "ready");
    assert.equal(f.controller.getSnapshot().canControl, false);
    assert.equal(f.calls.filter(call => call === "control:request").length, 1, "fresh attachment never replays the old input intent");
  } finally { f.controller.dispose(); }
});

test("an already-ended bootstrap cannot loop through observe-only reattachment", async () => {
  const f = fixture();
  try {
    f.setState({ ended: true, resumeObserving: true });
    f.controller.start(); await flush();
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.calls.filter(call => call === "prepare").length, 1);
  } finally { f.controller.dispose(); }
});

test("the declared preparation budget never extends the independent media deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(50); const pending = deferred<DesktopAttachment>();
  Object.assign(f.backend, { prepareTimeoutMs: 1000 });
  f.backend.prepare = () => pending.promise;
  try {
    f.controller.start(); t.mock.timers.tick(500);
    assert.equal(f.controller.getSnapshot().phase, "connecting", "resource preparation can outlast the media budget");
    pending.resolve(f.attachment); await flush();
    t.mock.timers.tick(50);
    assert.equal(f.controller.getSnapshot().phase, "failed");
    assert.equal(f.controller.getSnapshot().failure, "timeout");
  } finally { f.controller.dispose(); }
});
