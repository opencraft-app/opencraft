import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

/** Fake App Host: echoes host/send frames and streams numbered frames on demand. */
function fakeAppHost() {
  const connections = [];
  return {
    connections,
    accept(port, rendererId) {
      const connection = { rendererId, port, closed: false, received: [],
        close() { this.closed = true; } };
      port.subscribe(message => {
        connection.received.push(message);
        if (message.type === "host/connect") port.postMessage({ type: "response", requestId: message.requestId, ok: true, result: { hostId: message.hostId, generation: 1 } });
        if (message.type === "host/send") port.postMessage({ type: "response", requestId: message.requestId, ok: true, result: null });
      });
      connections.push(connection);
      port.postMessage({ type: "ready", protocolVersion: APP_HOST_PROTOCOL_VERSION, services: ["appserver"], capabilities: { connectionProbe: true } });
      return connection;
    },
    stream(connection, from, to) {
      for (let i = from; i <= to; i++) connection.port.postMessage({ type: "host/frame", hostId: "h", generation: 1, frame: JSON.stringify({ method: "item/delta", params: { i } }) });
    },
  };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "apphost-resume-"));
  const logs = [], host = fakeAppHost();
  const server = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: false,
    webSocketHeartbeatIntervalMs: 0, appHostResumeEnabled: true, onAppHostDiagnostic: event => logs.push(event), appHostServer: host, ...overrides });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { logs, host, url: `ws://127.0.0.1:${address.port}/apphost` };
}

/** Minimal client speaking the resume extension directly over ws. */
async function open(url) {
  const socket = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  socket.on("message", raw => {
    const message = JSON.parse(String(raw));
    inbox.push(message);
    for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  await once(socket, "open");
  return {
    socket, inbox,
    send(message) { socket.send(JSON.stringify(message)); },
    next(test) {
      const found = inbox.find(test);
      if (found) return Promise.resolve(found);
      return new Promise(resolve => waiters.push({ test, resolve }));
    },
  };
}
const until = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate()); };

test("a client that does not ask keeps the legacy model: unnumbered frames, session ends with the socket", async t => {
  const f = await fixture(t);
  const client = await open(f.url);
  client.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1" });
  const ready = await client.next(m => m.type === "ready");
  assert.equal(ready.capabilities.resume, undefined);
  assert.equal("seq" in ready, false);
  f.host.stream(f.host.connections[0], 1, 2);
  await until(() => client.inbox.filter(m => m.type === "host/frame").length === 2);
  assert.ok(client.inbox.every(m => !("seq" in m)));
  client.socket.terminate();
  await until(() => f.host.connections[0].closed);
});

test("a resumed session replays exactly the frames lost with the socket, both directions, once", async t => {
  const f = await fixture(t);
  const first = await open(f.url);
  first.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1", resume: { v: 1 } });
  const ready = await first.next(m => m.type === "ready");
  const grant = ready.capabilities.resume;
  assert.equal(grant.v, 1);
  assert.equal("seq" in ready, false, "ready is the boundary; numbering starts after it");
  const connection = f.host.connections[0];
  first.send({ type: "host/connect", requestId: "c1", hostId: "h", leaseId: "l1", seq: 1 });
  await first.next(m => m.type === "response" && m.requestId === "c1");
  f.host.stream(connection, 1, 3);
  await until(() => first.inbox.filter(m => m.type === "host/frame").length === 3);
  const lastSeen = Math.max(...first.inbox.filter(m => m.seq).map(m => m.seq));
  // The route dies abnormally; the App Host keeps streaming meanwhile.
  first.socket.terminate();
  await until(() => f.logs.some(l => l.event === "resume-detached"));
  assert.equal(connection.closed, false, "the App Host connection survives the socket");
  f.host.stream(connection, 4, 6);

  const second = await open(f.url);
  second.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1",
    resume: { v: 1, sessionId: grant.sessionId, token: grant.token, received: lastSeen } });
  const resumed = await second.next(m => m.type === "connection/resumed");
  assert.equal(resumed.received, 1, "the server saw client frame 1");
  await until(() => second.inbox.filter(m => m.type === "host/frame").length === 3);
  assert.deepEqual(second.inbox.filter(m => m.type === "host/frame").map(m => JSON.parse(m.frame).params.i), [4, 5, 6]);
  assert.equal(f.host.connections.length, 1, "no second App Host connection");
  // Client frames continue the same numbering; a duplicate is dropped.
  second.send({ type: "host/send", requestId: "s2", hostId: "h", leaseId: "l1", generation: 1, frame: "{}", seq: 2 });
  second.send({ type: "host/send", requestId: "s2", hostId: "h", leaseId: "l1", generation: 1, frame: "{}", seq: 2 });
  await second.next(m => m.type === "response" && m.requestId === "s2");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(connection.received.filter(m => m.requestId === "s2").length, 1);
  // Intentional end releases the session at once.
  second.send({ type: "connection/end" });
  await until(() => connection.closed);
});

test("resumption rejects a wrong token or unavailable replay window without stealing another session", async t => {
  const f = await fixture(t);
  const first = await open(f.url);
  first.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1", resume: { v: 1 } });
  const grant = (await first.next(m => m.type === "ready")).capabilities.resume;
  f.host.stream(f.host.connections[0], 1, 2);
  await until(() => first.inbox.filter(m => m.type === "host/frame").length === 2);
  first.socket.terminate();
  await until(() => f.logs.some(l => l.event === "resume-detached"));

  const wrong = await open(f.url);
  wrong.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1",
    resume: { v: 1, sessionId: grant.sessionId, token: "B".repeat(43), received: 2 } });
  assert.equal((await wrong.next(m => m.type === "connection/resume-failed")).reason, "unknown-session");
  assert.equal(f.host.connections[0].closed, false, "a failed guess cannot end someone else's session");

  const ahead = await open(f.url);
  ahead.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1",
    resume: { v: 1, sessionId: grant.sessionId, token: grant.token, received: 99 } });
  assert.equal((await ahead.next(m => m.type === "connection/resume-failed")).reason, "gap");
  await until(() => f.host.connections[0].closed);
});

test("a normal close ends the session immediately without detaching", async t => {
  const f = await fixture(t);
  const first = await open(f.url);
  first.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1", resume: { v: 1 } });
  await first.next(m => m.type === "ready");
  first.socket.close(1000);
  await until(() => f.host.connections[0].closed);
  assert.equal(f.logs.some(l => l.event === "resume-detached"), false);
});

test("resumption can be disabled on the server", async t => {
  const f = await fixture(t, { appHostResumeEnabled: false });
  const client = await open(f.url);
  client.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1", resume: { v: 1 } });
  const ready = await client.next(m => m.type === "ready");
  assert.equal(ready.capabilities.resume, undefined);
});

test("a server-initiated close (access revoked) ends the session and cannot be resumed", async t => {
  let allowed = true;
  const f = await fixture(t, { actorService: {
    isSessionRequest: () => false, authenticate: () => null, legacyAdmissionStatus: () => allowed ? 204 : 403,
    watch: () => () => {}, usageAuthority: () => null,
  } });
  const first = await open(f.url);
  first.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1", resume: { v: 1 } });
  const grant = (await first.next(m => m.type === "ready")).capabilities.resume;
  const connection = f.host.connections[0];
  allowed = false;
  // The next outgoing frame fails authorization; the bridge closes the socket (1008).
  f.host.stream(connection, 1, 1);
  await until(() => connection.closed);
  assert.equal(f.logs.some(l => l.event === "resume-detached"), false, "revocation never detaches");
  allowed = true;
  const second = await open(f.url);
  second.send({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r1",
    resume: { v: 1, sessionId: grant.sessionId, token: grant.token, received: 0 } });
  assert.equal((await second.next(m => m.type === "connection/resume-failed")).reason, "unknown-session");
});
