import assert from "node:assert/strict";
import test from "node:test";
import { combineAbortSignals, DeferredDuplexTransport, type DuplexTransport, type TransportStatus } from "@opencraft/appserver-client/transport";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const messages = new Set<(frame: string) => void>();
  const statuses = new Set<(status: TransportStatus) => void>();
  const recovery = new Set<() => void>();
  const sent: unknown[] = [];
  let closed = 0;
  const transport: DuplexTransport = {
    status: { state: "idle" },
    async connect() { (this as { status: TransportStatus }).status = { state: "open" }; for (const listener of statuses) listener(this.status); },
    async send(frame) { sent.push(frame); }, async sendWithContext(frame, context) { sent.push([frame, context]); },
    subscribeMessage(listener) { messages.add(listener); return () => { messages.delete(listener); }; },
    subscribeStatus(listener) { statuses.add(listener); return () => { statuses.delete(listener); }; },
    subscribeRecoveryHint(listener) { recovery.add(listener); return () => { recovery.delete(listener); }; },
    async close() { closed++; },
  };
  return { transport, messages, statuses, recovery, sent, get closed() { return closed; } };
}
test("registration is dormant; connect shares acquisition and forwards context, status and recovery", async () => {
  const real = fixture(); let loads = 0;
  const gate = deferred<DuplexTransport>();
  const transport = new DeferredDuplexTransport(async () => { loads++; return gate.promise; });
  const messages: string[] = [], statuses: string[] = []; let recoveries = 0;
  transport.subscribeMessage(value => messages.push(value)); transport.subscribeStatus(value => statuses.push(value.state)); transport.subscribeRecoveryHint(() => recoveries++);
  assert.equal(loads, 0);
  const connecting = transport.connect(); assert.equal(transport.connect(), connecting);
  await Promise.resolve(); assert.equal(loads, 1);
  gate.resolve(real.transport); await connecting;
  await transport.connect(); assert.equal(loads, 1, "an open connection must not be replaced");
  (real.transport as { status: TransportStatus }).status = { state: "closed" };
  real.statuses.forEach(listener => listener(real.transport.status));
  await transport.connect(); assert.equal(loads, 1, "reconnect reuses the physical transport");
  assert.equal(real.messages.size, 1); assert.equal(real.statuses.size, 1);
  real.messages.forEach(listener => listener("frame")); real.recovery.forEach(listener => listener());
  await transport.sendWithContext("turn", { sender: null });
  assert.deepEqual(messages, ["frame"]); assert.equal(recoveries, 1); assert.deepEqual(real.sent, [["turn", { sender: null }]]);
  assert.equal(statuses[0], "connecting"); assert.equal(transport.status.state, "open");
  await transport.close(); await transport.close(); assert.equal(real.closed, 1); assert.equal(real.messages.size, 0); assert.equal(real.recovery.size, 0);
});
test("close during a held import rejects promptly and closes a late transport without attaching", async () => {
  const real = fixture(), gate = deferred<DuplexTransport>();
  const transport = new DeferredDuplexTransport(() => gate.promise);
  const connecting = transport.connect(); await Promise.resolve();
  const rejected = assert.rejects(connecting, /closed/);
  await transport.close(); await rejected;
  gate.resolve(real.transport); await new Promise(resolve => setImmediate(resolve));
  assert.equal(real.closed, 1); assert.equal(real.messages.size, 0); assert.equal(transport.status.state, "closed");
});
test("aborted acquisition cannot attach after a retry, and a failed import remains retryable", async () => {
  const gate = deferred<DuplexTransport>(), stale = fixture(), current = fixture(); let attempt = 0;
  const transport = new DeferredDuplexTransport(async () => { attempt++; if (attempt === 1) throw Error("offline"); if (attempt === 2) return gate.promise; return current.transport; });
  await assert.rejects(transport.connect(), /offline/);
  const owner = new AbortController(); const connecting = transport.connect(owner.signal); await Promise.resolve();
  owner.abort(new Error("cancelled")); await assert.rejects(connecting, /cancelled/);
  await transport.connect(); gate.resolve(stale.transport); await new Promise(resolve => setImmediate(resolve));
  assert.equal(stale.closed, 1); assert.equal(transport.status.state, "open"); assert.equal(current.closed, 0);
  await transport.close();
});
test("provider failure classification survives lazy acquisition", async () => {
  const real = fixture(); real.transport.connect = async () => { (real.transport as { status: TransportStatus }).status = { state: "failed", failure: { code: "auth", recovery: "manual" } }; throw Error("sign in"); };
  const transport = new DeferredDuplexTransport(async () => real.transport);
  await assert.rejects(transport.connect(), /sign in/); assert.deepEqual(transport.status.failure, { code: "auth", recovery: "manual" }); assert.equal(real.closed, 1);
});

test("connecting reentry shares acquisition and closes every allocated delegate", async () => {
  const delegates: ReturnType<typeof fixture>[] = [];
  const transport = new DeferredDuplexTransport(async () => { const delegate = fixture(); delegates.push(delegate); return delegate.transport; });
  let second: Promise<void> | undefined; let entered = false;
  transport.subscribeStatus(status => { if (status.state === "connecting" && !entered) { entered = true; second = transport.connect(); } });
  try {
    const first = transport.connect();
    assert.equal(second, first);
    await first; await second;
    assert.equal(delegates.length, 1);
  } finally { await transport.close(); }
  assert.deepEqual(delegates.map(delegate => delegate.closed), [1]);
});
test("combined signals work without native AbortSignal.any and keep the first cancellation reason", async t => {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  if (native) Object.defineProperty(AbortSignal, "any", { ...native, value: undefined });
  t.after(() => { if (native) Object.defineProperty(AbortSignal, "any", native); });
  const first = new AbortController(), second = new AbortController();
  const combined = combineAbortSignals([first.signal, second.signal]);
  assert.equal(combined.signal.aborted, false);
  second.abort("second");
  first.abort("first");
  assert.equal(combined.signal.aborted, true);
  assert.equal(combined.signal.reason, "second");
  combined.dispose(); combined.dispose();
  assert.equal(combined.signal.reason, "second");
});
test("pre-cancelled inputs keep the first array reason and dispose is passive", () => {
  const cancelled = new AbortController(); cancelled.abort("first");
  const later = new AbortController(); later.abort("later");
  const combined = combineAbortSignals([later.signal, cancelled.signal]);
  assert.equal(combined.signal.aborted, true);
  assert.equal(combined.signal.reason, "later");
  const passive = combineAbortSignals([new AbortController().signal]);
  passive.dispose(); passive.dispose();
  assert.equal(passive.signal.aborted, false);
});
test("dispose detaches from its inputs without aborting either side", () => {
  const source = new AbortController();
  const combined = combineAbortSignals([source.signal]);
  combined.dispose(); combined.dispose();
  source.abort("after-dispose");
  assert.equal(combined.signal.aborted, false);
  assert.equal(source.signal.reason, "after-dispose");
});
