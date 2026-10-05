import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopControlLease } from "../plugins/cloud-desktop/src/contract";
import { createRfbDesktopAdapter, type DesktopRfbSession } from "../plugins/cloud-desktop/src/rfb";
import type { RfbClient } from "../plugins/cloud-desktop/src/rfb-client";
import { resolveRfbClientExport } from "../plugins/cloud-desktop/src/rfb-client";

const element = new EventTarget() as HTMLElement;
const ready = (f: ReturnType<typeof fixture>) => {
  f.client().dispatchEvent(new Event("connect"));
  f.client().dispatchEvent(new Event("firstframe"));
};
test("pinned noVNC CommonJS entry is validated across ESM default interop shapes", () => {
  class Decoder {}
  assert.equal(resolveRfbClientExport(Decoder), Decoder);
  assert.equal(resolveRfbClientExport({ default: Decoder }), Decoder);
  for (const value of [null, {}, { default: {} }, "decoder"]) assert.throws(() => resolveRfbClientExport(value));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(control = true) {
  const calls: string[] = [];
  let available = true;
  const controlListeners = new Set<() => void>();
  const revoked = new Set<() => void>();
  let valid = true;
  const lease: DesktopControlLease = {
    isValid: () => valid,
    subscribeRevoked: listener => { revoked.add(listener); return () => { revoked.delete(listener); }; },
    release: () => { calls.push("lease:release"); valid = false; },
  };
  let client!: RfbClient;
  const channel = Object.assign(new EventTarget(), { readyState: 0, close: () => calls.push("channel:close") });
  class Client extends EventTarget implements RfbClient {
    viewOnly = false; scaleViewport = false; resizeSession = true; focusOnClick = true; background = "";
    constructor(_element: HTMLElement, raw: WebSocket, options: { shared: boolean }) {
      super(); assert.equal(raw, channel); assert.equal(options.shared, true); client = this; calls.push("client:create");
    }
    blur() { calls.push("input:blur"); }
    focus() { calls.push("input:focus"); }
    clearClipboard() { calls.push("clipboard:clear"); }
    clipboardPasteFrom(text: string) { calls.push(`clipboard:${text}`); }
    sendKey(keysym: number, _code?: string, down?: boolean) { calls.push(`key:${keysym}:${down}`); }
    disconnect() { calls.push("client:disconnect"); this.dispatchEvent(new Event("disconnect")); }
  }
  const session: DesktopRfbSession = {
    openChannel: () => { calls.push("channel:open"); return channel as unknown as WebSocket; },
    close: () => { calls.push("session:close"); },
    ...(control ? { control: {
      isAvailable: () => available,
      subscribe: (listener: () => void) => { controlListeners.add(listener); return () => { controlListeners.delete(listener); }; },
      request: async () => lease,
    } } : {}),
  };
  const adapter = createRfbDesktopAdapter(async () => Client);
  return { adapter, session, lease, calls, channel, client: () => client,
    revoke() { valid = false; for (const listener of revoked) listener(); },
    availability(value: boolean) { available = value; for (const listener of controlListeners) listener(); },
    controlListeners, revoked };
}

test("RFB handshake is not a frame; control waits for decoded and presented pixels", async () => {
  const f = fixture(); const signal = new AbortController();
  const connection = await f.adapter.connect(f.session, signal.signal);
  assert.deepEqual(f.calls, [], "do not open before a surface consumes the channel");
  const surface = f.adapter.surfaces.mount(element, connection);
  const client = f.client();
  assert.equal(client.viewOnly, true); assert.equal(client.scaleViewport, true);
  assert.equal(client.resizeSession, false); assert.equal(client.focusOnClick, false);
  assert.equal(connection.getSnapshot().videoReady, false);
  await assert.rejects(connection.requestControl(signal.signal));
  client.dispatchEvent(new Event("connect"));
  assert.deepEqual(connection.getSnapshot(), { videoReady: false, inputReady: true, controlAvailable: true, ended: false });
  await assert.rejects(connection.requestControl(signal.signal));
  client.dispatchEvent(new Event("firstframe"));
  assert.equal(connection.getSnapshot().videoReady, true);
  const lease = await connection.requestControl(signal.signal);
  assert.equal(client.viewOnly, true, "receiving a grant alone does not bind input");
  surface.enableInput(lease); assert.equal(client.viewOnly, false);
  f.revoke(); assert.equal(client.viewOnly, true); assert.equal(client.focusOnClick, false);
  assert.equal(f.calls.filter(call => call === "lease:release").length, 1);
  surface.dispose(); connection.close();
  assert.equal(f.calls.filter(call => call === "session:close").length, 1);
  assert.equal(f.controlListeners.size, 0); assert.equal(f.revoked.size, 0);
});

test("RFB rejects foreign grants, foreign adapters and duplicate mounts", async () => {
  const f = fixture(), other = fixture(); const abort = new AbortController();
  const connection = await f.adapter.connect(f.session, abort.signal);
  const foreign = await other.adapter.connect(other.session, abort.signal);
  const surface = f.adapter.surfaces.mount(element, connection);
  ready(f);
  assert.throws(() => surface.enableInput(f.lease));
  assert.throws(() => f.adapter.surfaces.mount(element, foreign));
  assert.throws(() => f.adapter.surfaces.mount(element, connection));
  assert.equal(f.client().viewOnly, true); connection.close(); foreign.close();
});

test("RFB attachment without a control authority remains observable but cannot control", async () => {
  const f = fixture(false); const abort = new AbortController();
  const connection = await f.adapter.connect(f.session, abort.signal);
  f.adapter.surfaces.mount(element, connection); ready(f);
  assert.equal(connection.getSnapshot().videoReady, true);
  assert.equal(connection.getSnapshot().controlAvailable, false);
  await assert.rejects(connection.requestControl(abort.signal)); connection.close();
});

test("RFB releases late grants after close and does not allow parallel grant requests", async () => {
  const f = fixture(); const pending = deferred<DesktopControlLease>(); const abort = new AbortController();
  f.session.control!.request = () => pending.promise;
  const connection = await f.adapter.connect(f.session, abort.signal);
  f.adapter.surfaces.mount(element, connection); ready(f);
  const request = connection.requestControl(abort.signal);
  await assert.rejects(connection.requestControl(abort.signal));
  connection.close(); pending.resolve(f.lease); await assert.rejects(request);
  assert.equal(f.calls.filter(call => call === "lease:release").length, 1);
  assert.equal(f.client().viewOnly, true);
});

for (const event of ["disconnect", "securityfailure", "credentialsrequired", "serververification"]) {
  test(`RFB ${event} retires only its viewer and fences later ready events`, async () => {
    const f = fixture(); const abort = new AbortController();
    const connection = await f.adapter.connect(f.session, abort.signal);
    f.adapter.surfaces.mount(element, connection);
    f.client().dispatchEvent(new Event(event)); ready(f);
    assert.equal(connection.getSnapshot().ended, true); assert.equal(connection.getSnapshot().videoReady, false);
    assert.equal(f.calls.filter(call => call === "session:close").length, 1);
    assert.equal(f.calls.filter(call => call === "client:disconnect").length, 1);
  });
}

test("cancelled RFB module loading cannot open a channel and releases the session", async () => {
  const f = fixture(); const pending = deferred<never>(); const abort = new AbortController();
  const adapter = createRfbDesktopAdapter(() => pending.promise);
  const operation = adapter.connect(f.session, abort.signal);
  abort.abort(); assert.deepEqual(f.calls, ["session:close"], "cancellation must release before the import completes");
  pending.resolve(undefined as never); await assert.rejects(operation);
  assert.deepEqual(f.calls, ["session:close"]);
});

test("RFB availability withdrawal synchronously disables and releases input", async () => {
  const f = fixture(); const abort = new AbortController();
  const connection = await f.adapter.connect(f.session, abort.signal);
  const surface = f.adapter.surfaces.mount(element, connection); ready(f);
  surface.enableInput(await connection.requestControl(abort.signal));
  f.availability(false); assert.equal(f.client().viewOnly, true);
  assert.equal(connection.getSnapshot().controlAvailable, false);
  assert.equal(f.calls.filter(call => call === "lease:release").length, 1); connection.close();
});

test("RFB retries only classified transport loss after a presented frame", async () => {
  for (const [established, event, expected] of [[true, "disconnect", true], [false, "disconnect", false],
    [true, "securityfailure", false], [true, "credentialsrequired", false]] as const) {
    const f = fixture();
    f.session.getTermination = () => "transport-lost";
    const connection = await f.adapter.connect(f.session, new AbortController().signal);
    f.adapter.surfaces.mount(element, connection);
    if (established) ready(f); else f.client().dispatchEvent(new Event("connect"));
    f.client().dispatchEvent(new Event(event));
    assert.equal(connection.getSnapshot().retryable === true, expected);
    assert.equal(connection.getSnapshot().ended, true);
    assert.equal(f.calls.filter(call => call === "session:close").length, 1);
  }
});

test("clipboard sends no paste keys before text is provided, and revocation fences completion", async () => {
  for (const revoke of [false, true]) {
    const f = fixture(); const abort = new AbortController();
    const connection = await f.adapter.connect(f.session, abort.signal);
    const surface = f.adapter.surfaces.mount(element, connection); ready(f);
    const lease = await connection.requestControl(abort.signal); surface.enableInput(lease);
    const pending = surface.pasteText!("hello", lease, abort.signal);
    assert.equal(f.calls.some(call => call.startsWith("key:")), false);
    if (revoke) f.revoke();
    f.client().dispatchEvent(new Event("clipboardready"));
    if (revoke) {
      await assert.rejects(pending);
      assert.equal(f.calls.some(call => call.startsWith("key:")), false);
    } else {
      await pending;
      assert.deepEqual(f.calls.filter(call => call.startsWith("key:")),
        ["key:65507:true", "key:118:undefined", "key:65507:false"]);
    }
    connection.close();
  }
});

test("clipboard abort and concurrent attempts cannot leak keys into a later grant", async () => {
  const f = fixture(), abort = new AbortController(), pasteAbort = new AbortController();
  const connection = await f.adapter.connect(f.session, abort.signal);
  const surface = f.adapter.surfaces.mount(element, connection); ready(f);
  const lease = await connection.requestControl(abort.signal); surface.enableInput(lease);
  const pending = surface.pasteText!("first", lease, pasteAbort.signal);
  await assert.rejects(surface.pasteText!("second", lease, abort.signal));
  pasteAbort.abort(); await assert.rejects(pending);
  f.client().dispatchEvent(new Event("clipboardready"));
  assert.equal(f.calls.some(call => call.startsWith("key:")), false);
  assert.ok(f.calls.includes("clipboard:clear"));
  connection.close();
});
