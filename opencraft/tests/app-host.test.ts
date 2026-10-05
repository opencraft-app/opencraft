import assert from "node:assert/strict";
import test from "node:test";

import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import { AppHostServer, type AppHostServerPort } from "@opencraft/app-host-server";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

interface BrowserPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start(): void;
  close(): void;
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createPortPair(): { readonly browser: BrowserPort; readonly host: AppHostServerPort } {
  const browserListeners = new Set<(event: MessageEvent<unknown>) => void>();
  const hostListeners = new Set<(message: unknown) => void>();
  let closed = false;
  return {
    browser: {
      postMessage(message) {
        if (!closed) queueMicrotask(() => {
          if (!closed) for (const listener of hostListeners) listener(message);
        });
      },
      addEventListener(_type, listener) { browserListeners.add(listener); },
      removeEventListener(_type, listener) { browserListeners.delete(listener); },
      start() {},
      close() { closed = true; browserListeners.clear(); hostListeners.clear(); },
    },
    host: {
      postMessage(message) {
        if (!closed) queueMicrotask(() => {
          if (!closed) for (const listener of browserListeners) {
            listener({ data: message } as MessageEvent<unknown>);
          }
        });
      },
      subscribe(listener) {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
      start() {},
      close() { closed = true; browserListeners.clear(); hostListeners.clear(); },
    },
  };
}

class TestTransport implements DuplexTransport {
  readonly sent: string[] = [];
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  connectCount = 0;
  closeCount = 0;

  get status(): TransportStatus { return this.currentStatus; }

  async connect(): Promise<void> {
    this.connectCount += 1;
    this.publish({ state: "open" });
  }

  async send(frame: string): Promise<void> { this.sent.push(frame); }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.publish({ state: "closed" });
  }

  receive(frame: string): void {
    for (const listener of this.messageListeners) listener(frame);
  }

  protected publish(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

class ControlledTransport extends TestTransport {
  readonly connectGate = deferred<void>();
  readonly closeGate = deferred<void>();
  waitForConnect = true;
  waitForClose = false;

  override async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.waitForConnect) await this.connectGate.promise;
    this.waitForConnect = false;
    this.publish({ state: "open" });
  }

  override async close(): Promise<void> {
    this.closeCount += 1;
    if (this.waitForClose) await this.closeGate.promise;
    this.waitForClose = false;
    this.publish({ state: "closed" });
  }
}

test("service connection revalidates its authority after waiting for a physical reset", async () => {
  const physical = new ControlledTransport(); physical.waitForConnect = false; physical.waitForClose = true;
  let created = 0; let authorized = true;
  const server = new AppHostServer({ physicalHostLifetime: "server", createTransport: () => { created++; return physical; } });
  try {
    await server.ensureHostConnected("remote");
    const reset = server.resetHost("remote");
    const successor = server.ensureHostConnected("remote", () => { if (!authorized) throw new Error("revoked service admission"); });
    const rejected = assert.rejects(successor, /revoked service admission/);
    authorized = false;
    physical.closeGate.resolve(); await reset; await rejected;
    assert.equal(created, 1, "a revoked control request cannot construct a successor transport");
    assert.equal(server.hostState("remote"), "closed");
  } finally { physical.closeGate.resolve(); await server.close(); }
});

test("service connection shares physical startup, grants no Client lease, and survives page detach", async () => {
  const physical = new ControlledTransport(); let created = 0;
  const server = new AppHostServer({ physicalHostLifetime: "server", createTransport: () => { created++; return physical; } });
  const pair = createPortPair(), connection = server.accept(pair.host, "browser");
  try {
    const first = server.ensureHostConnected("ssh:fixture"), second = server.ensureHostConnected("ssh:fixture");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.hostState("ssh:fixture"), "connecting");
    assert.equal(created, 1);
    physical.connectGate.resolve(); await Promise.all([first, second]);
    assert.equal(server.hostState("ssh:fixture"), "open");
    await assert.rejects(server.handle(connection, { type: "host/send", hostId: "ssh:fixture", leaseId: "guessed", generation: 1, requestId: "unauthorized", frame: "not admitted" }), /does not own/);
    await server.handle(connection, { type: "host/connect", hostId: "ssh:fixture", leaseId: "real", requestId: "connect" });
    assert.equal(created, 1); assert.equal(physical.connectCount, 1);
    connection.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(physical.closeCount, 0);
  } finally { physical.connectGate.resolve(); await server.close(); }
});

test("failed service activation remains failed, and reset fences its late success", async () => {
  const previous = new ControlledTransport(), successor = new TestTransport(); let created = 0;
  const server = new AppHostServer({ physicalHostLifetime: "server", createTransport: () => ++created === 1 ? previous : successor });
  try {
    const connecting = server.ensureHostConnected("ssh:fixture");
    const rejected = assert.rejects(connecting, /no longer has an owner/);
    await new Promise(resolve => setImmediate(resolve));
    const reset = server.resetHost("ssh:fixture");
    const next = server.ensureHostConnected("ssh:fixture");
    await new Promise(resolve => setImmediate(resolve)); assert.equal(created, 1);
    previous.connectGate.resolve(); await rejected; await reset; await next;
    assert.equal(previous.closeCount, 1); assert.equal(server.hostState("ssh:fixture"), "open");
    assert.equal(created, 2);
  } finally { previous.connectGate.resolve(); await server.close(); }
  const failing = new AppHostServer({ physicalHostLifetime: "server", createTransport: () => { throw new Error("synthetic connection failure"); } });
  try { await assert.rejects(failing.ensureHostConnected("ssh:fixture")); assert.equal(failing.hostState("ssh:fixture"), "failed"); }
  finally { await failing.close(); }
});

test("trusted reset fences old claims and preserves reconnects arriving during close", async () => {
  const previous = new ControlledTransport(); previous.waitForConnect = false; previous.waitForClose = true;
  const successor = new TestTransport(); let created = 0;
  const server = new AppHostServer({ physicalHostLifetime: "server", createTransport: () => ++created === 1 ? previous : successor });
  const pair = createPortPair(); const connection = server.accept(pair.host, "reset-owner");
  try {
    const old = await server.handle(connection, { type: "host/connect", hostId: "ssh:fixture", leaseId: "old", requestId: "first" }) as { generation: number };
    const resetting = server.resetHost("ssh:fixture");
    await assert.rejects(server.handle(connection, { type: "host/send", hostId: "ssh:fixture", leaseId: "old", generation: old.generation, requestId: "stale", frame: "must not send" }), /not connected/);
    let connected = false;
    const arriving = server.handle(connection, { type: "host/connect", hostId: "ssh:fixture", leaseId: "next", requestId: "next" }).then(result => { connected = true; return result as { generation: number }; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connected, false); assert.equal(created, 1); assert.equal(server.hostState("ssh:fixture"), "closing");
    previous.closeGate.resolve(); await resetting; const next = await arriving;
    assert.notEqual(next.generation, old.generation);
    await server.handle(connection, { type: "host/send", hostId: "ssh:fixture", leaseId: "next", generation: next.generation, requestId: "send", frame: "new owner" });
    assert.deepEqual(previous.sent, []); assert.deepEqual(successor.sent, ["new owner"]);
    await assert.rejects(server.handle(connection, { type: "host/send", hostId: "ssh:fixture", leaseId: "old", generation: next.generation, requestId: "lost", frame: "old claim" }), /does not own/);
    assert.equal(previous.closeCount, 1);
  } finally { previous.closeGate.resolve(); await server.close(); }
});

test("SSH failure disposition survives AppHost wire and changes even when state/reason match", async () => {
  class FailingTransport extends TestTransport {
    change(status: TransportStatus) { this.publish(status); }
  }
  const physical = new FailingTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const pair = createPortPair(); server.accept(pair.host, "ssh-client");
  const client = new MessagePortAppHostClient(pair.browser, "ssh-client");
  const transport = client.createTransport("ssh:fixture");
  const states: TransportStatus[] = [];
  transport.subscribeStatus(status => states.push(status));
  try {
    await transport.connect();
    physical.change({ state: "failed", reason: "Remote unavailable", failure: { code: "SSH_LINK_LOST", recovery: "automatic" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    physical.change({ state: "failed", reason: "Remote unavailable", failure: { code: "SSH_HOST_KEY", recovery: "manual" } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(transport.status.failure, { code: "SSH_HOST_KEY", recovery: "manual" });
    assert.equal(states.filter(status => status.state === "failed").length, 2);
  } finally { await client.close(); await server.close(); }
});

test("probe and another Host remain responsive during a slow Host activation", async () => {
  const ports = createPortPair();
  const slow = new ControlledTransport();
  const healthy = new TestTransport();
  const server = new AppHostServer({ createTransport: host => host === "slow" ? slow : healthy });
  const connection = server.accept(ports.host, "probe-owner");
  const client = new MessagePortAppHostClient(ports.browser, "probe-owner");
  await client.waitUntilReady();
  const first = client.createTransport("slow");
  const waiting = first.connect();
  await new Promise(resolve => setImmediate(resolve));
  let probeReturned = false;
  ports.browser.addEventListener("message", event => {
    const message = event.data as { requestId?: string; ok?: boolean };
    if (message.requestId === "probe-1" && message.ok) probeReturned = true;
  });
  ports.browser.postMessage({ type: "connection/probe", requestId: "probe-1" });
  const second = client.createTransport("healthy");
  let connected = false;
  const secondWait = second.connect().then(() => { connected = true; });
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(probeReturned, true);
  assert.equal(connected, true);
  slow.connectGate.resolve();
  await Promise.all([waiting, secondWait]);
  client.close(); connection.close(); await server.close();
});

test("a timed-out Host claim releases its late grant without releasing a successor lease", async () => {
  const ports = createPortPair();
  const physical = new ControlledTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "deadline-owner");
  const client = new MessagePortAppHostClient(ports.browser, "deadline-owner", { controlTimeoutMs: 30 });
  const channel = client.createTransport("local");
  await assert.rejects(channel.connect(), /host\/connect timed out/);
  const successor = channel.connect();
  physical.connectGate.resolve();
  await successor;
  for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(physical.closeCount, 0);
  await channel.send("successor remains attached");
  assert.deepEqual(physical.sent, ["successor remains attached"]);
  await channel.close();
  assert.equal(physical.closeCount, 1);
  client.close(); connection.close(); await server.close();
});

test("local forwarding cancellation clears pending acknowledgements without replaying remote work", async () => {
  const ports = createPortPair();
  const gate = deferred<void>();
  const physical = new TestTransport();
  physical.send = async frame => { physical.sent.push(frame); await gate.promise; };
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "cancel-send");
  const client = new MessagePortAppHostClient(ports.browser, "cancel-send", { maxPendingRequests: 1 });
  const channel = client.createTransport("local");
  await channel.connect();
  const abort = new AbortController();
  const sent = channel.send("admitted work", abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(sent, /aborted/);
  // Capacity is free even while the remote forwarding acknowledgement is pending.
  const next = channel.send("independent next request");
  gate.resolve(); await next;
  assert.deepEqual(physical.sent, ["admitted work", "independent next request"]);
  client.close(); connection.close(); await server.close();
});

test("App Host multiplexes AppServer frames without exposing the physical transport", async () => {
  const ports = createPortPair();
  const physical = new TestTransport();
  let createCount = 0;
  const server = new AppHostServer({
    createTransport(hostId) {
      assert.equal(hostId, "local");
      createCount += 1;
      return physical;
    },
  });
  const connection = server.accept(ports.host, "renderer-1");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-1");
  await client.waitUntilReady();

  const transport = client.createTransport("local");
  const frames: string[] = [];
  transport.subscribeMessage((frame) => frames.push(frame));
  await Promise.all([transport.connect(), transport.connect()]);
  assert.equal(createCount, 1);
  assert.equal(physical.connectCount, 1);
  assert.equal(transport.status.state, "open");

  await transport.send('{"method":"thread/list"}');
  assert.deepEqual(physical.sent, ['{"method":"thread/list"}']);
  physical.receive('{"id":1,"result":[]}');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames, ['{"id":1,"result":[]}']);

  await transport.close();
  assert.equal(physical.closeCount, 1);
  client.close();
  connection.close();
  await server.close();
});

test("App Host generations reject stale Renderer writes after reconnect", async () => {
  const ports = createPortPair();
  const physical: TestTransport[] = [];
  const server = new AppHostServer({
    createTransport() {
      const transport = new TestTransport();
      physical.push(transport);
      return transport;
    },
  });
  const connection = server.accept(ports.host, "renderer-2");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-2");
  await client.waitUntilReady();
  const first = await client.connectHost("local", "lease-1");
  await client.disconnectHost("local", "lease-1", first.generation);
  const second = await client.connectHost("local", "lease-2");
  assert.ok(second.generation > first.generation);
  await assert.rejects(
    client.sendHostFrame("local", "lease-1", first.generation, "stale"),
    /Stale Host generation/,
  );
  assert.deepEqual(physical[1]?.sent, []);

  client.close();
  connection.close();
  await server.close();
});

test("App Host keeps one physical Host alive across Renderer windows until the final lease closes", async () => {
  const firstPorts = createPortPair();
  const secondPorts = createPortPair();
  const physical = new TestTransport();
  const server = new AppHostServer({
    createTransport: () => physical,
  });
  const firstConnection = server.accept(firstPorts.host, "renderer-first");
  const secondConnection = server.accept(secondPorts.host, "renderer-second");
  const firstClient = new MessagePortAppHostClient(firstPorts.browser, "renderer-first");
  const secondClient = new MessagePortAppHostClient(secondPorts.browser, "renderer-second");
  await Promise.all([firstClient.waitUntilReady(), secondClient.waitUntilReady()]);
  const first = firstClient.createTransport("local");
  const second = secondClient.createTransport("local");

  await Promise.all([first.connect(), second.connect()]);
  assert.equal(physical.connectCount, 1);
  await first.close();
  assert.equal(physical.closeCount, 0);
  await second.send("still-open");
  assert.deepEqual(physical.sent, ["still-open"]);
  await second.close();
  assert.equal(physical.closeCount, 1);

  firstClient.close();
  secondClient.close();
  firstConnection.close();
  secondConnection.close();
  await server.close();
});

test("process-owned Host keeps an admitted Turn alive across a lost Renderer and reconnect", async () => {
  const firstPorts = createPortPair();
  const secondPorts = createPortPair();
  const physical = new TestTransport();
  let createCount = 0;
  const server = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport: () => { createCount += 1; return physical; },
  });
  const firstConnection = server.accept(firstPorts.host, "mobile-before-sleep");
  const firstClient = new MessagePortAppHostClient(firstPorts.browser, "mobile-before-sleep");
  await firstClient.waitUntilReady();
  const first = await firstClient.connectHost("local-codex", "before-sleep");
  await firstClient.sendHostFrame("local-codex", "before-sleep", first.generation,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start", params: { threadId: "thread-1" } }));

  firstConnection.close();
  firstClient.close();
  assert.equal(physical.closeCount, 0);
  assert.ok(physical.sent.some(frame => JSON.parse(frame).method === "runtime/client/disconnect"));
  physical.receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1" } }));

  const secondConnection = server.accept(secondPorts.host, "mobile-after-wake");
  const secondClient = new MessagePortAppHostClient(secondPorts.browser, "mobile-after-wake");
  await secondClient.waitUntilReady();
  const second = await secondClient.connectHost("local-codex", "after-wake");
  assert.equal(second.generation, first.generation);
  assert.equal(createCount, 1);
  await secondClient.sendHostFrame("local-codex", "after-wake", second.generation,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-1" } }));
  assert.ok(physical.sent.some(frame => JSON.parse(frame).method === "thread/resume"));

  await secondClient.disconnectHost("local-codex", "after-wake", second.generation);
  assert.equal(physical.closeCount, 0);
  secondConnection.close();
  secondClient.close();
  assert.equal(physical.closeCount, 0);
  await server.close();
  assert.equal(physical.closeCount, 1);
});

test("closing one Renderer during shared startup cannot tear down another Renderer claim", async () => {
  const firstPorts = createPortPair();
  const secondPorts = createPortPair();
  const physical = new ControlledTransport();
  let createCount = 0;
  const server = new AppHostServer({
    createTransport: () => {
      createCount += 1;
      return physical;
    },
  });
  const firstConnection = server.accept(firstPorts.host, "renderer-pending-first");
  const secondConnection = server.accept(secondPorts.host, "renderer-pending-second");
  const firstClient = new MessagePortAppHostClient(firstPorts.browser, "renderer-pending-first");
  const secondClient = new MessagePortAppHostClient(secondPorts.browser, "renderer-pending-second");
  await Promise.all([firstClient.waitUntilReady(), secondClient.waitUntilReady()]);
  const first = firstClient.createTransport("local");
  const second = secondClient.createTransport("local");

  const firstConnect = first.connect();
  const secondConnect = second.connect();
  await new Promise((resolve) => setImmediate(resolve));
  firstClient.close();
  firstConnection.close();
  await assert.rejects(firstConnect, /closed/);
  physical.connectGate.resolve();
  await secondConnect;

  assert.equal(createCount, 1);
  assert.equal(physical.closeCount, 0);
  await second.send("survived-shared-startup");
  assert.deepEqual(physical.sent, ["survived-shared-startup"]);
  await second.close();
  assert.equal(physical.closeCount, 1);
  secondClient.close();
  secondConnection.close();
  await server.close();
});

test("a new claim waits for the previous physical Host to finish closing", async () => {
  const firstPorts = createPortPair();
  const secondPorts = createPortPair();
  const physical: ControlledTransport[] = [];
  const server = new AppHostServer({
    createTransport: () => {
      const transport = new ControlledTransport();
      transport.waitForConnect = false;
      physical.push(transport);
      return transport;
    },
  });
  const firstConnection = server.accept(firstPorts.host, "renderer-close-first");
  const secondConnection = server.accept(secondPorts.host, "renderer-close-second");
  const firstClient = new MessagePortAppHostClient(firstPorts.browser, "renderer-close-first");
  const secondClient = new MessagePortAppHostClient(secondPorts.browser, "renderer-close-second");
  await Promise.all([firstClient.waitUntilReady(), secondClient.waitUntilReady()]);
  const first = firstClient.createTransport("local");
  await first.connect();
  physical[0]!.waitForClose = true;

  const closing = first.close();
  await new Promise((resolve) => setImmediate(resolve));
  const second = secondClient.createTransport("local");
  const reopening = second.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(physical.length, 1);
  physical[0]!.closeGate.resolve();
  await closing;
  await reopening;
  assert.equal(physical.length, 2);

  await second.close();
  firstClient.close();
  secondClient.close();
  firstConnection.close();
  secondConnection.close();
  await server.close();
});

test("server shutdown drains a transport factory that is still starting", async () => {
  const ports = createPortPair();
  const factory = deferred<DuplexTransport>();
  const physical = new TestTransport();
  const server = new AppHostServer({ createTransport: () => factory.promise });
  const connection = server.accept(ports.host, "renderer-server-close");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-server-close");
  await client.waitUntilReady();
  const transport = client.createTransport("local");
  const connecting = transport.connect();
  await new Promise((resolve) => setImmediate(resolve));
  client.close();
  await assert.rejects(connecting, /closed/);

  const closing = server.close();
  factory.resolve(physical);
  await closing;
  assert.equal(physical.connectCount, 0);
  assert.equal(physical.closeCount, 1);
  connection.close();
});

test("aborting a Renderer connect releases its claim after shared startup acknowledges it", async () => {
  const ports = createPortPair();
  const physical = new ControlledTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "renderer-abort");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-abort");
  await client.waitUntilReady();
  const controller = new AbortController();
  const connecting = client.connectHost("local", "aborted-lease", controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(connecting, { name: "AbortError" });
  physical.connectGate.resolve();
  for (let attempt = 0; attempt < 20 && physical.closeCount === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(physical.closeCount, 1);

  client.close();
  connection.close();
  await server.close();
});

test("a fatal App Host message terminalizes every transport and future request", async () => {
  const ports = createPortPair();
  const server = new AppHostServer({ createTransport: () => new TestTransport() });
  const connection = server.accept(ports.host, "renderer-fatal");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-fatal");
  await client.waitUntilReady();
  const transport = client.createTransport("local");
  await transport.connect();

  ports.host.postMessage({
    type: "fatal",
    error: { code: "DAEMON_GONE", message: "daemon disappeared", retryable: true },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.status, { state: "failed", reason: "daemon disappeared" });
  await assert.rejects(transport.send("must-not-hang"), /not open|closed/);
  await assert.rejects(client.connectHost("local", "late-lease"), /daemon disappeared|closed/);

  await transport.close();
  connection.close();
  await server.close();
});
