import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { appHostFrameRejection, createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

const hello = { type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "renderer-secret" };
const send = { type: "host/send", requestId: "request-secret", hostId: "host-secret", leaseId: "lease-secret", generation: 1, frame: "message-secret" };

test("frame rejection identifies protocol/field failures without echoing values", () => {
  for (const frame of [hello, send, { ...send, type: "host/connect", generation: undefined }, { ...send, type: "host/disconnect", frame: undefined }, { type: "connection/probe", requestId: "probe" }]) {
    assert.equal(appHostFrameRejection(frame), null);
  }
  const cases = [
    [null, "not-object"], [[], "not-object"],
    [{ ...hello, protocolVersion: 1 }, "protocol-version"],
    [{ ...hello, protocolVersion: "token-secret" }, "protocol-version"],
    [{ ...hello, rendererId: "" }, "renderer-id"],
    [{ ...send, requestId: "" }, "request-id"],
    [{ ...send, hostId: 7 }, "host-id"],
    [{ ...send, leaseId: undefined }, "lease-id"],
    [{ ...send, generation: -1 }, "generation"],
    [{ ...send, frame: {} }, "frame-type"],
    [{ ...send, type: "token-secret" }, "message-type"],
  ];
  for (const [frame, reason] of cases) {
    const result = appHostFrameRejection(frame);
    assert.equal(result.reason, reason);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(appHostFrameRejection({ ...hello, protocolVersion: 1 }).receivedProtocolVersion, 1);
});

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "apphost-diagnostics-"));
  const logs = [];
  const host = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: false,
    webSocketHeartbeatIntervalMs: 0, onAppHostDiagnostic: event => logs.push(event),
    appHostServer: { accept(port) {
      port.postMessage({ type: "ready", protocolVersion: APP_HOST_PROTOCOL_VERSION });
      return { close() {} };
    } }, ...overrides });
  const address = await host.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { logs, url: `ws://127.0.0.1:${address.port}` };
}

async function invalidConnection(url, frames) {
  const socket = new WebSocket(url, { origin: "https://fixture.invalid", headers: { cookie: "token-secret", authorization: "Bearer token-secret" } });
  await once(socket, "open");
  const closed = once(socket, "close");
  for (const frame of frames) socket.send(frame);
  const [code] = await closed;
  return code;
}

test("real sockets classify malformed JSON, binary, protocol, and post-hello failures", async t => {
  const { logs, url } = await fixture(t);
  for (const [frames, reason, code, phase, sequence] of [
    [["{message-secret"], "json", 1003, "awaiting-hello", 1],
    [[Buffer.from("message-secret")], "binary", 1003, "awaiting-hello", 1],
    [[JSON.stringify({ ...hello, protocolVersion: 1 })], "protocol-version", 1008, "awaiting-hello", 1],
    [[JSON.stringify(hello), JSON.stringify({ ...send, leaseId: undefined })], "lease-id", 1008, "ready", 2],
  ]) {
    const start = logs.length;
    assert.equal(await invalidConnection(`${url}/apphost?attempt=client-1760500000000-test`, frames), code);
    const events = logs.slice(start);
    const failure = events.find(event => event.event === "invalid-frame");
    assert.equal(failure.reason, reason);
    assert.equal(failure.phase, phase);
    assert.equal(failure.frameSequence, sequence);
    assert.equal(failure.serverProtocolVersion, APP_HOST_PROTOCOL_VERSION);
    assert.equal(failure.attemptId, "client-1760500000000-test");
    assert.equal(failure.channel, "public");
    assert.doesNotMatch(JSON.stringify(events), /secret|Bearer|fixture\.invalid/);
  }
});

test("private upgrade diagnostics distinguish origin/session/management without exposing credentials", async t => {
  for (const [management, reason] of [
    [null, "management-unavailable"],
    [{ sameOrigin: () => false, authorized: () => true }, "origin"],
    [{ sameOrigin: () => true, authorized: () => false }, "session"],
  ]) {
    const { logs, url } = await fixture(t, { sshManagement: management && { onRevocation: () => () => {}, ...management } });
    const socket = new WebSocket(`${url}/ssh-apphost?attempt=client-1760500000000-private`, { origin: "https://fixture.invalid", headers: { cookie: "token-secret" } });
    const failure = await new Promise(resolve => {
      socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.on("error", () => {});
    });
    assert.equal(failure, 403);
    const rejection = logs.find(event => event.event === "upgrade-rejected");
    assert.equal(rejection.reason, reason);
    assert.equal(rejection.channel, "private");
    assert.equal(rejection.attemptId, "client-1760500000000-private");
    assert.doesNotMatch(JSON.stringify(logs), /secret|fixture\.invalid/);
  }
});

test("diagnostic sink failure cannot interrupt valid handshakes", async t => {
  const { url } = await fixture(t, { onAppHostDiagnostic() { throw new Error("sink unavailable"); } });
  const socket = new WebSocket(`${url}/apphost`, { origin: "https://fixture.invalid" });
  await once(socket, "open");
  const ready = once(socket, "message");
  socket.send(JSON.stringify(hello));
  assert.equal(JSON.parse(String((await ready)[0])).type, "ready");
  const closed = once(socket, "close"); socket.close(); await closed;
});

test("incompatible hello receives a permanent fatal before close without accepting a Host", async t => {
  let accepted = 0;
  const { logs, url } = await fixture(t, { appHostServer: { accept() { accepted++; throw new Error("must not accept"); } } });
  for (const protocolVersion of [1, 3, "token-secret"]) {
    const socket = new WebSocket(`${url}/apphost`);
    await once(socket, "open");
    const frames = [];
    socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ ...hello, protocolVersion }));
    assert.equal((await closed)[0], 1008);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, "fatal");
    assert.equal(frames[0].error.code, "APP_HOST_PROTOCOL_MISMATCH");
    assert.equal(frames[0].error.retryable, false);
    assert.doesNotMatch(JSON.stringify({ frames, logs }), /secret/);
  }
  assert.equal(accepted, 0);
});
