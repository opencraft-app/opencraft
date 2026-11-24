import assert from "node:assert/strict";
import test from "node:test";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { RESUME_PROTOCOL_VERSION } from "@opencraft/app-host-resume";
import { ResumeRegistry } from "@opencraft/app-host-resume/server";
import { AppHostServer } from "@opencraft/app-host-server";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { acceptAppHostClientSession, type AppHostSessionAuthority } from "@opencraft/client-session/app-host";
import { createMemorySessionSocket, type MemorySessionPeer } from "@opencraft/client-session/memory";

// The session layer runs on the runtime-neutral socket contract alone: a real
// App Host session (hello, Host lease, sequenced frames, detach, resume, end)
// driven without any network socket or `ws` object.

type Frame = Record<string, any>;

const until = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(predicate(), label);
};

async function read(peer: MemorySessionPeer, predicate: (frame: Frame) => boolean = () => true): Promise<Frame> {
  for (;;) {
    const raw = await peer.next();
    assert.equal(typeof raw, "string", "the session sends text frames");
    const frame = JSON.parse(raw as string) as Frame;
    if (frame.type !== "connection/ack" && predicate(frame)) return frame;
  }
}

function fixture(t: import("node:test").TestContext) {
  const hostPeers: InMemoryAppServerPeer[] = [];
  const hostReceived: Frame[] = [];
  const appHostServer = new AppHostServer({
    createTransport: () =>
      new MemoryTransport({
        connected(peer) {
          hostPeers.push(peer);
        },
        receive(frame, peer) {
          const request = JSON.parse(frame) as Frame;
          hostReceived.push(request);
          peer.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { echo: request.method } }));
        },
      }),
  });
  let accepted = 0;
  const acceptor = {
    accept: (...args: Parameters<AppHostServer["accept"]>) => {
      accepted++;
      return appHostServer.accept(...args);
    },
  };
  const registry = new ResumeRegistry({ detachMs: 60_000 });
  const logs: Frame[] = [];
  const authorities = { held: 0, released: 0 };
  const authority = (): AppHostSessionAuthority => ({
    hold() {
      authorities.held++;
      return true;
    },
    release() {
      authorities.released++;
    },
  });
  const connect = () => {
    const memory = createMemorySessionSocket();
    memory.bind(
      acceptAppHostClientSession(memory.socket, {
        appHostServer: acceptor,
        diagnostic: (event, detail) => {
          logs.push({ event, ...detail });
        },
        resume: { registry, identity: "owner", route: null, authority: authority(), deadline: Infinity },
      }),
    );
    return memory.peer;
  };
  t.after(async () => {
    registry.close();
    await appHostServer.close();
  });
  return { connect, logs, hostPeers, hostReceived, registry, authorities, accepted: () => accepted };
}

test("a session runs connect → messages → disconnect → resume → end over the in-memory transport", async (t) => {
  const f = fixture(t);
  const first = f.connect();
  first.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: APP_HOST_PROTOCOL_VERSION,
      rendererId: "renderer-1",
      heartbeat: true,
      resume: { v: RESUME_PROTOCOL_VERSION },
    }),
  );
  const ready = await read(first);
  assert.equal(ready.type, "ready");
  assert.equal(ready.seq, undefined, "ready precedes sequencing");
  assert.equal(ready.capabilities.heartbeatMs, 10_000);
  const grant = ready.capabilities.resume;
  assert.match(grant.sessionId, /^[a-f0-9]{32}$/u);

  let received = 0;
  const note = (frame: Frame) => {
    assert.equal(frame.seq, received + 1, "frames are numbered in order");
    received = frame.seq;
    return frame;
  };
  first.send(JSON.stringify({ type: "host/connect", requestId: "connect-1", hostId: "h", leaseId: "lease-1", seq: 1 }));
  const connected = note(await read(first, (frame) => frame.requestId === "connect-1"));
  assert.equal(connected.ok, true);
  const generation = connected.result.generation;
  first.send(
    JSON.stringify({
      type: "host/send",
      requestId: "send-1",
      hostId: "h",
      leaseId: "lease-1",
      generation,
      frame: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "first" }),
      seq: 2,
    }),
  );
  const echoed = [note(await read(first)), note(await read(first))];
  const echo = echoed.find((frame) => frame.type === "host/frame")!;
  assert.deepEqual(JSON.parse(echo.frame).result, { echo: "first" });

  // The route dies abnormally; the logical connection is retained.
  first.disconnect();
  await until(() => f.logs.some((log) => log.event === "resume-detached"), "session detached");
  assert.equal(f.registry.stats.detached, 1);
  // Host output while no socket is attached is retained for replay.
  const retained = f.registry.stats.frames;
  f.hostPeers[0]!.send(JSON.stringify({ jsonrpc: "2.0", method: "while-detached" }));
  await until(() => f.registry.stats.frames === retained + 1, "frame retained");

  const second = f.connect();
  second.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: APP_HOST_PROTOCOL_VERSION,
      rendererId: "renderer-1",
      heartbeat: true,
      resume: { v: RESUME_PROTOCOL_VERSION, sessionId: grant.sessionId, token: grant.token, received },
    }),
  );
  const resumed = await read(second);
  assert.deepEqual(resumed, { type: "connection/resumed", received: 2 });
  const replayed = note(await read(second));
  assert.equal(replayed.type, "host/frame");
  assert.equal(JSON.parse(replayed.frame).method, "while-detached");
  assert.ok(f.logs.some((log) => log.event === "resume-accepted" && log.replayedFrames === 1));

  // The resumed socket continues the same sequence and the same Host lease.
  second.send(
    JSON.stringify({
      type: "host/send",
      requestId: "send-2",
      hostId: "h",
      leaseId: "lease-1",
      generation,
      frame: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "second" }),
      seq: 3,
    }),
  );
  const after = [note(await read(second)), note(await read(second))];
  assert.deepEqual(JSON.parse(after.find((frame) => frame.type === "host/frame")!.frame).result, { echo: "second" });
  assert.equal(f.accepted(), 1, "no new App Host connection");
  assert.deepEqual(
    f.hostReceived.map((request) => request.method),
    ["first", "second"],
    "each request reached the Host once",
  );
  assert.equal(f.hostPeers.length, 1, "the Host connection survived the socket loss");

  // A sequenced duplicate (client replay of something already delivered) is dropped.
  second.send(
    JSON.stringify({
      type: "host/send",
      requestId: "send-2",
      hostId: "h",
      leaseId: "lease-1",
      generation,
      frame: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "second" }),
      seq: 3,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.hostReceived.length, 2);

  second.send(JSON.stringify({ type: "connection/end" }));
  // Ending the session closes the App Host connection, which closes its socket normally.
  assert.equal(second.closedBySession?.code, 1000);
  await until(() => f.registry.stats.sessions === 0, "session ended");
  assert.equal(f.authorities.held, 2, "each socket's authority was held by the session");
  assert.equal(f.authorities.released, 2, "and released when superseded or ended");
});

test("server-initiated and normal closes end the session; only abnormal loss detaches", async (t) => {
  const f = fixture(t);
  const hello = (peer: MemorySessionPeer) =>
    peer.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: APP_HOST_PROTOCOL_VERSION,
        rendererId: "renderer-2",
        resume: { v: RESUME_PROTOCOL_VERSION },
      }),
    );

  const normal = f.connect();
  hello(normal);
  await read(normal);
  normal.close(1000);
  await until(() => f.registry.stats.sessions === 0, "normal close ends the session");
  assert.ok(!f.logs.some((log) => log.event === "resume-detached"));

  const invalid = f.connect();
  hello(invalid);
  await read(invalid);
  invalid.send(JSON.stringify({ type: "host/connect", requestId: "x", hostId: "h", leaseId: "l" }));
  assert.deepEqual(
    invalid.closedBySession,
    { code: 1008, reason: "Invalid App Host request" },
    "unsequenced frame is a policy violation",
  );
  await until(() => f.registry.stats.sessions === 0, "policy close ends the session");

  const binary = f.connect();
  binary.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual(binary.closedBySession, { code: 1003, reason: "Text frames required" });
  assert.ok(!f.logs.some((log) => log.event === "resume-detached"));
});

test("heartbeat frames follow the opt-in and skip a congested socket", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const registry = new ResumeRegistry();
  let buffered = 0;
  const memory = createMemorySessionSocket({ bufferedAmount: () => buffered });
  const ports: Array<{ postMessage(message: unknown): void }> = [];
  memory.bind(
    acceptAppHostClientSession(memory.socket, {
      appHostServer: {
        accept(port) {
          ports.push(port);
          port.subscribe(() => {});
          return { close() {} };
        },
      },
      diagnostic: () => {},
      resume: { registry, identity: "owner", route: null, authority: { hold: () => true, release() {} } },
    }),
  );
  t.after(() => registry.close());
  memory.peer.send(
    JSON.stringify({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "r", heartbeat: true }),
  );
  ports[0]!.postMessage({ type: "ready", protocolVersion: APP_HOST_PROTOCOL_VERSION, capabilities: {} });
  const heartbeats = () =>
    memory.peer.received.filter((frame) => frame === JSON.stringify({ type: "connection/heartbeat" })).length;
  t.mock.timers.tick(10_000);
  assert.equal(heartbeats(), 1);
  buffered = 2 * 1024 * 1024;
  t.mock.timers.tick(10_000);
  assert.equal(heartbeats(), 1, "a congested socket gets no extra heartbeat");
  buffered = 0;
  t.mock.timers.tick(10_000);
  assert.equal(heartbeats(), 2);
});
