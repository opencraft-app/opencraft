import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopWireSession } from "../plugins/cloud-desktop/src/session-wire";

class Socket extends EventTarget {
  readyState = 0; binaryType = "blob"; bufferedAmount = 0;
  readonly sent: unknown[] = [];
  closes = 0;
  send(data: unknown) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  close() { this.closes++; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "object" && !(data instanceof ArrayBuffer) ? JSON.stringify(data) : data })); }
}
function fixture(controlAvailable = true, timeoutMs = 1000, controlTimeoutMs = 1000,
  renewal?: { expiresAt: number; confirmed(expiresAt: number): void }, renewable?: boolean) {
  const socket = new Socket(), abort = new AbortController();
  const session = createDesktopWireSession({ attachmentId: "viewer", signal: abort.signal, timeoutMs, controlTimeoutMs, renewal,
    openSocket: () => socket as unknown as WebSocket,
    authenticate: send => send({ event: "desktop/attach", attachmentId: "viewer", ticket: "synthetic" }) });
  const channel = session.openChannel();
  socket.open();
  const ready = () => socket.receive({ event: "desktop/ready", version: 1, attachmentId: "viewer", controlAvailable,
    ...(renewable === undefined ? {} : { renewable }) });
  return { socket, abort, session, channel, ready };
}
test("wire waits for bound ready and sends only binary media to noVNC", t => {
  const f = fixture(false); t.after(() => f.session.close());
  let opens = 0; const messages: unknown[] = [];
  f.channel.onopen = () => opens++;
  f.channel.onmessage = event => messages.push(event.data);
  assert.equal(f.channel.readyState, 0); assert.equal(opens, 0);
  assert.deepEqual(f.socket.sent, [{ event: "desktop/attach", attachmentId: "viewer", ticket: "synthetic" }]);
  f.ready(); assert.equal(opens, 1);
  const media = new Uint8Array([1, 2, 3]).buffer;
  f.socket.receive(media); assert.deepEqual(messages, [media]);
  assert.equal(f.session.control!.isAvailable(), false);
});

test("viewer renewal requires both capabilities, preserves a grant, and stops on retirement", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const confirmed: number[] = [];
  for (const enabled of [false, true]) {
    const f = fixture(true, 1000, 1000, { expiresAt: Date.now() + 300_000,
      confirmed: expiresAt => confirmed.push(expiresAt) }, enabled);
    f.ready();
    const operation = f.session.control!.request(new AbortController().signal);
    f.socket.receive({ event: "control/locked", requestId: "1" }); const lease = await operation;
    t.mock.timers.tick(270_000);
    const renewals = f.socket.sent.filter((m: any) => m.event === "desktop/renew") as any[];
    assert.equal(renewals.length, enabled ? 1 : 0);
    if (enabled) {
      const expiresAt = Date.now() + 300_000;
      f.socket.receive({ event: "desktop/renewed", requestId: renewals[0].requestId, expiresAt });
      assert.deepEqual(confirmed, [expiresAt]); assert.equal(lease.isValid(), true);
      t.mock.timers.tick(30_001); assert.equal(f.channel.readyState, 1, "old viewing deadline cannot close the renewed stream");
    }
    f.session.close(); const count = f.socket.sent.length;
    t.mock.timers.tick(600_000); assert.equal(f.socket.sent.length, count);
  }
  const old = fixture(true, 1000, 1000, undefined, true); old.ready();
  t.mock.timers.tick(300_000); assert.equal(old.socket.sent.length, 1, "old client never sends unsupported renewal"); old.session.close();
});

test("renewal timeout is bounded liveness loss; forged and late receipts never extend a viewer", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  for (const bad of ["timeout", "wrong-id", "invalid-expiry", "retired"] as const) {
    let confirmations = 0;
    const f = fixture(true, 1000, 1000, { expiresAt: Date.now() + 300_000, confirmed: () => confirmations++ }, true);
    f.ready(); t.mock.timers.tick(270_000);
    const request = f.socket.sent.at(-1) as any;
    if (bad === "timeout") t.mock.timers.tick(10_000);
    else {
      if (bad === "retired") f.session.close();
      f.socket.receive({ event: "desktop/renewed", requestId: bad === "wrong-id" ? "999" : request.requestId,
        expiresAt: bad === "invalid-expiry" ? Date.now() + 1 : Date.now() + 300_000 });
    }
    assert.equal(confirmations, 0); assert.equal(f.channel.readyState, 3);
    assert.equal(f.session.getTermination!(), bad === "timeout" ? "transport-lost" : "retired");
  }
});
test("wire advertises absent clipboard execution independently from mouse/keyboard control", t => {
  const f = fixture(); t.after(() => f.session.close());
  f.socket.receive({ event: "desktop/ready", version: 1, attachmentId: "viewer", controlAvailable: true, clipboardAvailable: false });
  assert.equal(f.session.control!.isAvailable(), true); assert.equal(f.session.control!.canPaste!(), false);
});
test("control requires remote confirmation and remote revocation invalidates it synchronously", async t => {
  const f = fixture(); t.after(() => f.session.close()); f.ready();
  let confirmed = false;
  const request = f.session.control!.request(new AbortController().signal).then(lease => { confirmed = true; return lease; });
  await Promise.resolve(); assert.equal(confirmed, false);
  f.socket.receive({ event: "control/locked", requestId: "1" });
  const lease = await request; assert.equal(lease.isValid(), true);
  let revoked = 0; lease.subscribeRevoked(() => revoked++);
  f.socket.receive({ event: "control/release", requestId: "1" });
  assert.equal(lease.isValid(), false); assert.equal(revoked, 1);
});
test("cancelled request's late confirmation is released without enabling input", async t => {
  const f = fixture(); t.after(() => f.session.close()); f.ready();
  const abort = new AbortController(); const rejected = assert.rejects(f.session.control!.request(abort.signal));
  abort.abort(); await rejected;
  f.socket.receive({ event: "control/locked", requestId: "1" });
  assert.deepEqual(f.socket.sent.slice(-2), [{ event: "control/release", requestId: "1" }, { event: "control/release", requestId: "1" }]);
  const next = f.session.control!.request(new AbortController().signal);
  f.socket.receive({ event: "control/locked", requestId: "1" });
  f.socket.receive({ event: "control/locked", requestId: "2" });
  assert.equal((await next).isValid(), true);
});
test("duplicate confirmation does not release the current grant", async t => {
  const f = fixture(); t.after(() => f.session.close()); f.ready();
  const request = f.session.control!.request(new AbortController().signal);
  f.socket.receive({ event: "control/locked", requestId: "1" }); const lease = await request;
  f.socket.receive({ event: "control/locked", requestId: "1" });
  assert.equal(lease.isValid(), true); assert.equal(f.socket.sent.length, 2);
});
test("denial, grant timeout and close reject pending requests", async t => {
  const f = fixture(true, 1000, 5); t.after(() => f.session.close()); f.ready();
  let rejected = assert.rejects(f.session.control!.request(new AbortController().signal));
  f.socket.receive({ event: "control/denied", requestId: "1" }); await rejected;
  await assert.rejects(f.session.control!.request(new AbortController().signal));
  rejected = assert.rejects(f.session.control!.request(new AbortController().signal));
  f.session.close(); await rejected;
  assert.equal(f.socket.closes, 1); assert.equal(f.channel.readyState, 3);
});
for (const bad of [
  { event: "desktop/ready", version: 2, attachmentId: "viewer", controlAvailable: false },
  { event: "desktop/ready", version: 1, attachmentId: "wrong", controlAvailable: false },
  { event: "control/locked", requestId: "1" }, new Uint8Array([1]).buffer,
]) test("wire rejects unbound or early frames", () => {
  const f = fixture(); f.socket.receive(bad); assert.equal(f.socket.closes, 1);
});
test("bootstrap timeout, signal retirement and output backpressure close only this viewer", async () => {
  const timed = fixture(false, 5); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(timed.socket.closes, 1);
  const cancelled = fixture(); cancelled.abort.abort(); assert.equal(cancelled.socket.closes, 1);
  const full = fixture(); full.ready(); full.socket.bufferedAmount = (1 << 20) + 1;
  assert.throws(() => full.channel.send(new Uint8Array([1]))); assert.equal(full.socket.closes, 1);
});

test("only an established abnormal transport end is classified for recovery", () => {
  for (const [ready, code, expected] of [
    [true, 1006, "transport-lost"], [false, 1006, "retired"], [true, 1000, "retired"],
    [true, 1008, "retired"],
  ] as const) {
    const f = fixture();
    if (ready) f.ready();
    let causeAtClose: unknown;
    f.channel.onclose = () => { causeAtClose = f.session.getTermination!(); };
    f.socket.dispatchEvent(Object.assign(new Event("close"), { code }));
    assert.equal(f.session.getTermination!(), expected);
    assert.equal(causeAtClose, expected, "noVNC must see classification before its close handler");
  }
  const malformed = fixture(); malformed.ready(); malformed.socket.receive("invalid");
  assert.equal(malformed.session.getTermination!(), "retired");
  const cancelled = fixture(); cancelled.ready(); cancelled.abort.abort();
  assert.equal(cancelled.session.getTermination!(), "retired");
  const errored = fixture(); errored.ready(); errored.socket.dispatchEvent(new Event("error"));
  assert.equal(errored.session.getTermination!(), "transport-lost");
});
