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

test("Host activation rejects physical loss before its connect continuation", async () => {
  class LostTransport extends TestTransport {
    override async connect() { await super.connect(); this.publish({ state: "closed", reason: "immediate loss" }); }
  }
  const physical = new LostTransport(); const server = new AppHostServer({ createTransport: () => physical });
  const pair = createPortPair(); server.accept(pair.host, "lost");
  const client = new MessagePortAppHostClient(pair.browser, "lost"); const channel = client.createTransport("host");
  try { await assert.rejects(channel.connect(), /immediate loss|not open|disconnected/); assert.notEqual(channel.status.state, "open"); }
  finally { await channel.close(); client.close(); await server.close(); }
});

test("AppHost channel connecting observers share one owned claim without native AbortSignal.any", async t => {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  if (native) Object.defineProperty(AbortSignal, "any", {...native, value: undefined});
  t.after(() => { if (native) Object.defineProperty(AbortSignal, "any", native); });
  const server = new AppHostServer({ createTransport: () => new TestTransport() });
  const pair = createPortPair(); server.accept(pair.host, "reentry"); let grants = 0;
  const client = new MessagePortAppHostClient({ ...pair.browser, postMessage(message) {
    if (message.type === "host/connect") grants++;
    pair.browser.postMessage(message);
  } }, "reentry");
  const channel = client.createTransport("host"); let second: Promise<void> | undefined; let entered = false;
  channel.subscribeStatus(status => { if (status.state === "connecting" && !entered) { entered = true; second = channel.connect(); } });
  try {
    const first = channel.connect(new AbortController().signal); assert.equal(first, second); await first; await second;
    assert.equal(grants, 1); assert.equal(channel.status.state, "open");
  } finally { await channel.close(); client.close(); await server.close(); }
});

for (const terminal of ["close", "fatal"] as const) test(`bridge ${terminal} after grant delivery cannot revive a channel`, async () => {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const sent: any[] = [];
  const client = new MessagePortAppHostClient({ postMessage(message) { sent.push(message); },
    addEventListener(_type, next) { listener = next; }, removeEventListener() {}, start() {}, close() {},
  }, "terminal-after-grant");
  const receive = (message: unknown) => listener?.({ data: message } as MessageEvent<unknown>);
  const channel = client.createTransport("local");
  try {
    receive({ type: "ready", protocolVersion: 2, services: ["appserver"] });
    const connecting = channel.connect();
    const rejected = assert.rejects(connecting, /closed|retired/);
    await new Promise(resolve => setImmediate(resolve));
    const claim = sent.find(message => message.type === "host/connect");
    receive({ type: "response", requestId: claim.requestId, ok: true, result: { hostId: "local", generation: 1 } });
    if (terminal === "close") client.close();
    else receive({ type: "fatal", error: { code: "SSH_AUTH_EXPIRED", message: "bridge retired", retryable: false } });
    await rejected;
    assert.equal(channel.status.state, "failed");
    if (terminal === "fatal") assert.equal(channel.status.failure?.recovery, "manual");
  } finally { await channel.close(); client.close(); }
});

for (const matching of [false, true]) for (const manual of [false, true]) {
  test(`pre-acknowledgement terminal status only revokes its granted generation (matching=${matching}, manual=${manual})`, async () => {
    const granted = deferred<void>(); const release = deferred<void>();
    class HeldServer extends AppHostServer {
      override async handle(connection: Parameters<AppHostServer["handle"]>[0], message: Parameters<AppHostServer["handle"]>[1]) {
        const result = await super.handle(connection, message);
        if (message.type === "host/connect") { granted.resolve(); await release.promise; }
        return result;
      }
    }
    const physical = new TestTransport(); const server = new HeldServer({ createTransport: () => physical });
    const pair = createPortPair(); server.accept(pair.host, "grant");
    const client = new MessagePortAppHostClient(pair.browser, "grant"); const channel = client.createTransport("host");
    try {
      const connecting = channel.connect(); const outcome = connecting.then(() => null, error => error as Error);
      await granted.promise;
      pair.host.postMessage({ type: "host/status", hostId: "host", generation: matching ? 1 : 99,
        status: { state: "closed", reason: "grant retired", ...(manual ? { failure: { code: "SSH_AUTH_EXPIRED", recovery: "manual" } } : {}) } });
      await new Promise<void>(resolve => setImmediate(resolve)); release.resolve();
      const error = await outcome;
      if (matching) {
        assert.ok(error); assert.match(error.message, /grant retired/); assert.equal(channel.status.state, "failed");
        assert.equal(channel.status.failure?.recovery, manual ? "manual" : "automatic");
      } else {
        assert.equal(error, null); assert.equal(channel.status.state, "open");
        await channel.send("current"); assert.deepEqual(physical.sent, ["current"]);
      }
    } finally { release.resolve(); await channel.close(); client.close(); await server.close(); }
  });
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
  const first = await firstClient.connectHost("process-host", "before-sleep");
  await firstClient.sendHostFrame("process-host", "before-sleep", first.generation,
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn/start", params: { threadId: "thread-1" } }));

  firstConnection.close();
  firstClient.close();
  assert.equal(physical.closeCount, 0);
  assert.ok(physical.sent.some(frame => JSON.parse(frame).method === "runtime/client/disconnect"));
  physical.receive(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1" } }));

  const secondConnection = server.accept(secondPorts.host, "mobile-after-wake");
  const secondClient = new MessagePortAppHostClient(secondPorts.browser, "mobile-after-wake");
  await secondClient.waitUntilReady();
  const second = await secondClient.connectHost("process-host", "after-wake");
  assert.equal(second.generation, first.generation);
  assert.equal(createCount, 1);
  await secondClient.sendHostFrame("process-host", "after-wake", second.generation,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId: "thread-1" } }));
  assert.ok(physical.sent.some(frame => JSON.parse(frame).method === "thread/resume"));

  await secondClient.disconnectHost("process-host", "after-wake", second.generation);
  assert.equal(physical.closeCount, 0);
  secondConnection.close();
  secondClient.close();
  assert.equal(physical.closeCount, 0);
  await server.close();
  assert.equal(physical.closeCount, 1);
});

test("closing a Renderer does not disconnect a logical client still active on another connection", async () => {
  const physical = new TestTransport();
  const server = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport: () => physical });
  const firstPorts = createPortPair(), secondPorts = createPortPair();
  const firstConnection = server.accept(firstPorts.host, "first-renderer");
  const secondConnection = server.accept(secondPorts.host, "second-renderer");
  const firstClient = new MessagePortAppHostClient(firstPorts.browser, "first-renderer");
  await firstClient.waitUntilReady();
  await firstClient.connectHost("process-host", "shared-lease");
  const key = [...(server as unknown as { slots: Map<string, { claims: Map<string, unknown> }> }).slots.get("process-host")!.claims.keys()][0]!;
  secondConnection.rememberLogicalClient(key, "process-host");
  try {
    firstConnection.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(physical.sent.filter(frame => JSON.parse(frame).method === "runtime/client/disconnect").length, 0,
      "the surviving connection still owns this logical client");
    secondConnection.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(physical.sent.filter(frame => JSON.parse(frame).method === "runtime/client/disconnect").length, 1,
      "the last connection releases the logical client");
  } finally { firstClient.close(); firstConnection.close(); secondConnection.close(); await server.close(); }
});

test("a failed explicit logical disconnect is retried when its Renderer WebSocket closes", async () => {
  class FailingDisconnectTransport extends TestTransport {
    attempts = 0;
    override async send(frame: string): Promise<void> {
      if (JSON.parse(frame).method === "runtime/client/disconnect") {
        this.attempts += 1;
        throw new Error("synthetic logical disconnect failure");
      }
      return super.send(frame);
    }
  }
  const physical = new FailingDisconnectTransport();
  const server = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport: () => physical });
  const ports = createPortPair(), connection = server.accept(ports.host, "disconnect-retry");
  const client = new MessagePortAppHostClient(ports.browser, "disconnect-retry");
  await client.waitUntilReady();
  const host = await client.connectHost("process-host", "retry-lease");
  try {
    await assert.rejects(client.disconnectHost("process-host", "retry-lease", host.generation), /synthetic logical disconnect failure/);
    assert.equal(physical.attempts, 1);
    const slot = (server as unknown as { slots: Map<string, { claims: Map<string, unknown> }> }).slots.get("process-host");
    assert.equal(slot?.claims.size, 0, "the local claim is released even when notification fails");
    connection.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(physical.attempts, 2, "the closing Renderer retries the retained logical client once");
    assert.equal(physical.closeCount, 0, "a process-owned Host survives Renderer closure");
  } finally { client.close(); connection.close(); await server.close(); }
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

test("a permanent AppHost fatal preserves its disposition on every already-open channel", async () => {
  const ports = createPortPair();
  const server = new AppHostServer({ createTransport: () => new TestTransport() });
  const connection = server.accept(ports.host, "renderer-incompatible");
  const client = new MessagePortAppHostClient(ports.browser, "renderer-incompatible");
  const a = client.createTransport("a"), b = client.createTransport("b");
  try {
    await Promise.all([a.connect(), b.connect()]);
    ports.host.postMessage({ type: "fatal", error: {
      code: "APP_HOST_PROTOCOL_MISMATCH", message: "Update required", retryable: false,
    } });
    await new Promise(resolve => setImmediate(resolve));
    for (const transport of [a, b]) {
      assert.equal(transport.status.state, "failed");
      assert.deepEqual(transport.status.failure, { code: "APP_HOST_PROTOCOL_MISMATCH", recovery: "manual" });
      await assert.rejects(transport.send("must not replay"), /not open/);
    }
  } finally {
    await Promise.all([a.close(), b.close()]); client.close(); connection.close(); await server.close();
  }
});

test("targeted frames stay inside their lease even when same-page RPC IDs collide", async () => {
  const ports = createPortPair();
  const physical = new TestTransport();
  const server = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport: () => physical });
  const connection = server.accept(ports.host, "same-page");
  const client = new MessagePortAppHostClient(ports.browser, "same-page");
  await client.waitUntilReady();
  const probe = client.createTransport("local"), runtime = client.createTransport("local");
  const probeFrames: string[] = [], runtimeFrames: string[] = [];
  probe.subscribeMessage(frame => probeFrames.push(frame));
  runtime.subscribeMessage(frame => runtimeFrames.push(frame));
  try {
    await Promise.all([probe.connect(), runtime.connect()]);
    await probe.send(JSON.stringify({ id: "same-id", method: "runtime/machine/read" }));
    await runtime.send(JSON.stringify({ id: "same-id", method: "initialize" }));
    const target = JSON.parse(physical.sent[0]!).__opencraftClient;
    physical.receive(JSON.stringify({ id: "same-id", error: { code: -32601, message: "unsupported" }, __opencraftClient: target }));
    physical.receive(JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: {}, __opencraftClient: target }));
    physical.receive(JSON.stringify({ method: "thread/started", params: {} }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probeFrames.length, 3);
    assert.equal(runtimeFrames.length, 1);
    assert.equal(JSON.parse(runtimeFrames[0]!).method, "thread/started");
    physical.receive(JSON.stringify({ id: "unowned-response", result: {} }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtimeFrames.length, 1, "an unowned response must never be broadcast");
    await probe.close();
    physical.receive(JSON.stringify({ id: "same-id", result: {}, __opencraftClient: target }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtimeFrames.length, 1, "retired lease reply must not reach a successor or sibling");
  } finally { await probe.close(); await runtime.close(); client.close(); connection.close(); await server.close(); }
});

test("a hung physical cleanup settles admission as manual failure while preserving its barrier", async () => {
  const timers = new Set<() => void>(), physical: ControlledTransport[] = [];
  const server = new AppHostServer({ lifecycleTimeoutMs: 100,
    lifecycleClock: {setTimeout(callback) {timers.add(callback); return callback;},clearTimeout(handle) {timers.delete(handle as () => void);}},
    createTransport: () => {const value = new ControlledTransport();value.waitForConnect = false;physical.push(value);return value;},
  });
  const pair = createPortPair(), connection = server.accept(pair.host,"bounded-cleanup"), client = new MessagePortAppHostClient(pair.browser,"bounded-cleanup");
  try {
    const first = client.createTransport("local");await first.connect();physical[0]!.waitForClose = true;
    const closing = first.close();await new Promise(resolve=>setImmediate(resolve));
    const second = client.createTransport("local");const pending = second.connect();
    const failed = assert.rejects(pending, (error: any) => error.code === "APP_HOST_CLEANUP_TIMEOUT");
    await new Promise(resolve=>setImmediate(resolve));for(const timer of [...timers]) timer();await failed;
    assert.equal(second.status.failure?.recovery,"manual");assert.equal(physical.length,1);
    assert.equal(server.hostState("local"),"closing");
    physical[0]!.closeGate.resolve();await closing;await second.close();
    const third = client.createTransport("local");await third.connect();assert.equal(physical.length,2);assert.equal(third.status.state,"open");await third.close();
  }finally{physical[0]?.closeGate.resolve();client.close();connection.close();await server.close();}
});

test("a hung physical startup settles admission without opening a concurrent transport", async () => {
  const timers = new Set<() => void>(), physical: ControlledTransport[] = [];
  const server = new AppHostServer({physicalHostLifetime:"server",lifecycleClock:{setTimeout(callback){timers.add(callback);return callback;},clearTimeout(handle){timers.delete(handle as () => void);}},
    createTransport:()=>{const value=new ControlledTransport();physical.push(value);return value;}});
  const pair=createPortPair(),connection=server.accept(pair.host,"bounded-start"),client=new MessagePortAppHostClient(pair.browser,"bounded-start");
  try {
    const channel=client.createTransport("local"),pending=channel.connect();const rejected=assert.rejects(pending,(error:any)=>error.code==='APP_HOST_START_TIMEOUT');
    await new Promise(resolve=>setImmediate(resolve));for(const timer of [...timers])timer();await rejected;
    assert.equal(channel.status.failure?.recovery,"manual");assert.equal(physical.length,1);
    physical[0]!.connectGate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.notEqual(server.hostState('local'),'open','late startup has no admitted claim');await channel.close();
  }finally{physical[0]?.connectGate.resolve();client.close();connection.close();await server.close();}
});



test("expired claim saturation retires the bridge, preserves service Hosts and fences old grants", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ports = createPortPair(), slow = new ControlledTransport(), healthy = new TestTransport();
  const server = new AppHostServer({ physicalHostLifetime: "server", lifecycleTimeoutMs: 120_000, createTransport: id => id === "slow" ? slow : healthy });
  const connection = server.accept(ports.host, "saturated");
  const client = new MessagePortAppHostClient({ ...ports.browser, close() { ports.browser.close(); connection.close(); } }, "saturated", { maxPendingRequests: 2 });
  const peer = client.createTransport("healthy");
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let successor: MessagePortAppHostClient | undefined;
  let successorConnection: ReturnType<AppHostServer["accept"]> | undefined;
  try {
    await peer.connect();
    for (let index = 0; index < 2; index++) {
      const expired = assert.rejects(client.connectHost("slow", client.createLeaseId()), /host\/connect timed out/);
      await flush(); context.mock.timers.tick(30_000); await expired;
    }
    const limitFailure = (error: unknown) => error instanceof Error && (error as Error & { code?: string; retryable?: boolean }).code === "APP_HOST_REQUEST_LIMIT" && (error as Error & { retryable?: boolean }).retryable === true;
    await assert.rejects(client.connectHost("healthy", client.createLeaseId()), limitFailure);
    assert.equal(peer.status.state, "failed");
    assert.deepEqual(peer.status.failure, { code: "APP_HOST_REQUEST_LIMIT", recovery: "automatic" });
    await assert.rejects(client.waitUntilReady(), limitFailure);
    assert.equal(healthy.closeCount, 0, "revoking Client attachments cannot stop a service-owned physical Host");
    const nextPorts = createPortPair();
    successorConnection = server.accept(nextPorts.host, "successor");
    successor = new MessagePortAppHostClient(nextPorts.browser, "successor");
    const next = successor.createTransport("healthy");
    await next.connect(); await next.send("healthy work after bridge renewal");
    slow.connectGate.resolve(); for (let index = 0; index < 5; index++) await flush();
    assert.equal(peer.status.state, "failed", "late startup cannot revive a revoked bridge");
    assert.equal(next.status.state, "open");
    assert.deepEqual(healthy.sent, ["healthy work after bridge renewal"]);
    assert.equal(healthy.connectCount, 1);
  } finally { slow.connectGate.resolve(); successor?.close(); successorConnection?.close(); client.close(); connection.close(); await server.close(); }
});

test("ordinary pending-request backpressure does not revoke a healthy bridge", async () => {
  const ports = createPortPair(), physical = new TestTransport(), gate = deferred<void>();
  physical.send = async frame => { physical.sent.push(frame); await gate.promise; };
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "busy");
  const client = new MessagePortAppHostClient(ports.browser, "busy", { maxPendingRequests: 1 });
  const channel = client.createTransport("healthy");
  try {
    await channel.connect(); const first = channel.send("in flight");
    await assert.rejects(channel.send("over capacity"), /pending request limit reached/);
    assert.equal(channel.status.state, "open");
    gate.resolve(); await first; await channel.send("capacity restored");
    assert.deepEqual(physical.sent, ["in flight", "capacity restored"]);
  } finally { gate.resolve(); client.close(); connection.close(); await server.close(); }
});


test("closing a pending channel releases its late grant without disturbing its peer", async () => {
  const ports = createPortPair();
  const physical = new ControlledTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "pending-channel-close");
  const client = new MessagePortAppHostClient(ports.browser, "pending-channel-close");
  const retired = client.createTransport("local"), peer = client.createTransport("local");
  try {
    const retiring = assert.rejects(retired.connect(), /closed|aborted/);
    const surviving = peer.connect();
    await new Promise(resolve => setImmediate(resolve));
    await retired.close();
    physical.connectGate.resolve();
    await Promise.all([retiring, surviving]);
    await new Promise(resolve => setImmediate(resolve));
    await peer.send("peer-stays-open");
    assert.equal(physical.closeCount, 0);
    await peer.close();
    assert.equal(physical.closeCount, 1, "the retired channel must not retain a late claim");
    assert.equal(retired.status.state, "closed", "late completion must not overwrite terminal close");
  } finally {
    physical.connectGate.resolve();
    client.close(); connection.close(); await server.close();
  }
});

test("closing before ready cancels only that channel's queued claim", async () => {
  const ports = createPortPair();
  const claims: string[] = [];
  const post = ports.browser.postMessage;
  ports.browser.postMessage = message => {
    const input = message as { type: string; leaseId: string };
    if (input.type === "host/connect") claims.push(input.leaseId);
    post(message);
  };
  const physical = new TestTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "before-ready-close");
  const client = new MessagePortAppHostClient(ports.browser, "before-ready-close");
  const retired = client.createTransport("local"), peer = client.createTransport("local");
  try {
    const rejected = assert.rejects(retired.connect(), /aborted|closed/);
    await retired.close();
    await peer.connect(); await rejected;
    assert.equal(claims.length, 1, "only the surviving channel may request a claim");
    assert.equal(retired.status.state, "closed");
    await peer.send("still-usable");
    await peer.close();
    assert.equal(physical.closeCount, 1);
  } finally {
    client.close(); connection.close(); await server.close();
  }
});

test("close between grant delivery and its promise callback releases exactly that grant", async () => {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const sent: Array<{ type: string; requestId: string; leaseId: string; generation?: number }> = [];
  const client = new MessagePortAppHostClient({
    postMessage: message => { sent.push(message as typeof sent[number]); },
    addEventListener: (_type, next) => { listener = next; },
    removeEventListener: () => { listener = undefined; }, start() {}, close() {},
  }, "grant-close-microtask");
  const receive = (message: unknown) => listener?.({ data: message } as MessageEvent<unknown>);
  const transport = client.createTransport("local");
  try {
    receive({ type: "ready", protocolVersion: 2, services: ["appserver"] });
    const rejected = assert.rejects(transport.connect(), /closed|aborted/);
    await new Promise(resolve => setImmediate(resolve));
    const claim = sent.find(message => message.type === "host/connect")!;
    receive({ type: "response", requestId: claim.requestId, ok: true, result: { hostId: "local", generation: 17 } });
    await transport.close(); await rejected;
    await new Promise(resolve => setImmediate(resolve));
    const releases = sent.filter(message => message.type === "host/disconnect");
    assert.equal(releases.length, 1);
    assert.equal(releases[0]!.leaseId, claim.leaseId);
    assert.equal(releases[0]!.generation, 17);
    assert.equal(transport.status.state, "closed");
    receive({ type: "response", requestId: releases[0]!.requestId, ok: true });
  } finally { client.close(); }
});


test("closing a pending channel releases its late grant without disturbing its peer", async () => {
  const ports = createPortPair();
  const physical = new ControlledTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "pending-channel-close");
  const client = new MessagePortAppHostClient(ports.browser, "pending-channel-close");
  const retired = client.createTransport("local"), peer = client.createTransport("local");
  try {
    const retiring = assert.rejects(retired.connect(), /closed|aborted/);
    const surviving = peer.connect();
    await new Promise(resolve => setImmediate(resolve));
    await retired.close();
    physical.connectGate.resolve();
    await Promise.all([retiring, surviving]);
    await new Promise(resolve => setImmediate(resolve));
    await peer.send("peer-stays-open");
    assert.equal(physical.closeCount, 0);
    await peer.close();
    assert.equal(physical.closeCount, 1, "the retired channel must not retain a late claim");
    assert.equal(retired.status.state, "closed", "late completion must not overwrite terminal close");
  } finally {
    physical.connectGate.resolve();
    client.close(); connection.close(); await server.close();
  }
});

test("closing before ready cancels only that channel's queued claim", async () => {
  const ports = createPortPair();
  const claims: string[] = [];
  const post = ports.browser.postMessage;
  ports.browser.postMessage = message => {
    const input = message as { type: string; leaseId: string };
    if (input.type === "host/connect") claims.push(input.leaseId);
    post(message);
  };
  const physical = new TestTransport();
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "before-ready-close");
  const client = new MessagePortAppHostClient(ports.browser, "before-ready-close");
  const retired = client.createTransport("local"), peer = client.createTransport("local");
  try {
    const rejected = assert.rejects(retired.connect(), /aborted|closed/);
    await retired.close();
    await peer.connect(); await rejected;
    assert.equal(claims.length, 1, "only the surviving channel may request a claim");
    assert.equal(retired.status.state, "closed");
    await peer.send("still-usable");
    await peer.close();
    assert.equal(physical.closeCount, 1);
  } finally {
    client.close(); connection.close(); await server.close();
  }
});

test("close between grant delivery and its promise callback releases exactly that grant", async () => {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  const sent: Array<{ type: string; requestId: string; leaseId: string; generation?: number }> = [];
  const client = new MessagePortAppHostClient({
    postMessage: message => { sent.push(message as typeof sent[number]); },
    addEventListener: (_type, next) => { listener = next; },
    removeEventListener: () => { listener = undefined; }, start() {}, close() {},
  }, "grant-close-microtask");
  const receive = (message: unknown) => listener?.({ data: message } as MessageEvent<unknown>);
  const transport = client.createTransport("local");
  try {
    receive({ type: "ready", protocolVersion: 2, services: ["appserver"] });
    const rejected = assert.rejects(transport.connect(), /closed|aborted/);
    await new Promise(resolve => setImmediate(resolve));
    const claim = sent.find(message => message.type === "host/connect")!;
    receive({ type: "response", requestId: claim.requestId, ok: true, result: { hostId: "local", generation: 17 } });
    await transport.close(); await rejected;
    await new Promise(resolve => setImmediate(resolve));
    const releases = sent.filter(message => message.type === "host/disconnect");
    assert.equal(releases.length, 1);
    assert.equal(releases[0]!.leaseId, claim.leaseId);
    assert.equal(releases[0]!.generation, 17);
    assert.equal(transport.status.state, "closed");
    receive({ type: "response", requestId: releases[0]!.requestId, ok: true });
  } finally { client.close(); }
});


test("expired claim saturation retires the bridge, preserves service Hosts and fences old grants", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const ports = createPortPair(), slow = new ControlledTransport(), healthy = new TestTransport();
  const server = new AppHostServer({ physicalHostLifetime: "server", lifecycleTimeoutMs: 120_000, createTransport: id => id === "slow" ? slow : healthy });
  const connection = server.accept(ports.host, "saturated");
  const client = new MessagePortAppHostClient({ ...ports.browser, close() { ports.browser.close(); connection.close(); } }, "saturated", { maxPendingRequests: 2 });
  const peer = client.createTransport("healthy");
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  let successor: MessagePortAppHostClient | undefined;
  let successorConnection: ReturnType<AppHostServer["accept"]> | undefined;
  try {
    await peer.connect();
    for (let index = 0; index < 2; index++) {
      const expired = assert.rejects(client.connectHost("slow", client.createLeaseId()), /host\/connect timed out/);
      await flush(); context.mock.timers.tick(30_000); await expired;
    }
    const limitFailure = (error: unknown) => error instanceof Error && (error as Error & { code?: string; retryable?: boolean }).code === "APP_HOST_REQUEST_LIMIT" && (error as Error & { retryable?: boolean }).retryable === true;
    await assert.rejects(client.connectHost("healthy", client.createLeaseId()), limitFailure);
    assert.equal(peer.status.state, "failed");
    assert.deepEqual(peer.status.failure, { code: "APP_HOST_REQUEST_LIMIT", recovery: "automatic" });
    await assert.rejects(client.waitUntilReady(), limitFailure);
    assert.equal(healthy.closeCount, 0, "revoking Client attachments cannot stop a service-owned physical Host");
    const nextPorts = createPortPair();
    successorConnection = server.accept(nextPorts.host, "successor");
    successor = new MessagePortAppHostClient(nextPorts.browser, "successor");
    const next = successor.createTransport("healthy");
    await next.connect(); await next.send("healthy work after bridge renewal");
    slow.connectGate.resolve(); for (let index = 0; index < 5; index++) await flush();
    assert.equal(peer.status.state, "failed", "late startup cannot revive a revoked bridge");
    assert.equal(next.status.state, "open");
    assert.deepEqual(healthy.sent, ["healthy work after bridge renewal"]);
    assert.equal(healthy.connectCount, 1);
  } finally { slow.connectGate.resolve(); successor?.close(); successorConnection?.close(); client.close(); connection.close(); await server.close(); }
});

test("ordinary pending-request backpressure does not revoke a healthy bridge", async () => {
  const ports = createPortPair(), physical = new TestTransport(), gate = deferred<void>();
  physical.send = async frame => { physical.sent.push(frame); await gate.promise; };
  const server = new AppHostServer({ createTransport: () => physical });
  const connection = server.accept(ports.host, "busy");
  const client = new MessagePortAppHostClient(ports.browser, "busy", { maxPendingRequests: 1 });
  const channel = client.createTransport("healthy");
  try {
    await channel.connect(); const first = channel.send("in flight");
    await assert.rejects(channel.send("over capacity"), /pending request limit reached/);
    assert.equal(channel.status.state, "open");
    gate.resolve(); await first; await channel.send("capacity restored");
    assert.deepEqual(physical.sent, ["in flight", "capacity restored"]);
  } finally { gate.resolve(); client.close(); connection.close(); await server.close(); }
});

test("stale send admission retires the channel and proves only that RPC was not dispatched", async () => {
  const { JsonRpcAppServerClient } = await import("@opencraft/appserver-client");
  const { asHostId } = await import("@opencraft/chat-core");
  class Native extends TestTransport {
    override async send(frame: string) {
      await super.send(frame);
      const request = JSON.parse(frame);
      if (request.id === undefined || request.method === "turn/start") return;
      const result = request.method === "initialize" ? { userAgent: "admission-fixture" }
        : request.method === "thread/start" ? { thread: { id: "new-thread" } } : {};
      this.receive(JSON.stringify({ id: request.id, result }));
    }
  }
  const physical: Native[] = [];
  const server = new AppHostServer({ createTransport: () => { const native = new Native(); physical.push(native); return native; } });
  const pair = createPortPair();
  let loseTerminal = false;
  server.accept({ ...pair.host, postMessage: message => {
    if (loseTerminal && message.type === "host/status") return;
    pair.host.postMessage(message);
  } }, "admission-fixture");
  const bridge = new MessagePortAppHostClient(pair.browser, "admission-fixture");
  const transport = bridge.createTransport("local");
  const client = new JsonRpcAppServerClient({ hostId: asHostId("local"), transport });
  const initialize = { clientInfo: { name: "admission-fixture", version: "1" } };
  try {
    await client.connect(initialize);
    const accepted = client.request("turn/start", { threadId: "existing", input: [] });
    const acceptedFailure = assert.rejects(accepted, (error: any) => error.code === "TRANSPORT_ERROR");
    while (!physical[0]!.sent.some(frame => JSON.parse(frame).method === "turn/start")) await new Promise(resolve => setImmediate(resolve));
    loseTerminal = true;
    await server.resetHost("local");
    assert.equal(transport.status.state, "open", "lost status leaves the original stale snapshot");
    await assert.rejects(client.request("thread/start", {}), (error: any) => error.code === "NOT_DISPATCHED");
    await acceptedFailure;
    assert.equal(transport.status.state, "failed", "the send rejection must reach the existing recovery owner");
    assert.equal(physical[0]!.sent.filter(frame => JSON.parse(frame).method === "thread/start").length, 0);
    loseTerminal = false;
    await client.connect(initialize);
    assert.equal((await client.request("thread/start", {})).thread.id, "new-thread");
    assert.equal(physical[1]!.sent.filter(frame => JSON.parse(frame).method === "thread/start").length, 1);
    assert.equal(physical[1]!.sent.filter(frame => JSON.parse(frame).method === "turn/start").length, 0, "an earlier admitted write cannot be replayed");
  } finally { client.close(); bridge.close(); await server.close(); }
});

test("New chat recovers a stale Host claim once without recreating an accepted Thread", async () => {
  const { createAppServerWorkbenchRuntime } = await import("@opencraft/workbench-runtime");
  const { createHarness, intent } = await import("../fixtures/workbench-draft-harness");
  for (const durable of [false, true]) {
    const physical: ReturnType<typeof createHarness>[] = [];
    const server = new AppHostServer({ createTransport: () => {
      const harness = createHarness(false, false, [], false, undefined, false, false, durable);
      physical.push(harness);
      return harness.transport;
    } });
    const { browser: rendererPort, host: hostPort } = createPortPair();
    let loseTerminal = false;
    const post = hostPort.postMessage.bind(hostPort);
    hostPort.postMessage = message => { if (!loseTerminal || message.type !== "host/status") post(message); };
    server.accept(hostPort, "new-chat-recovery");
    const bridge = new MessagePortAppHostClient(rendererPort, "new-chat-recovery");
    const runtime = createAppServerWorkbenchRuntime({ hostId: "local", createTransport: () => bridge.createTransport("local"), autoReconnect: false });
    try {
      await runtime.connect();
      loseTerminal = true;
      await server.resetHost("local");
      assert.equal(runtime.getSnapshot().phase, "ready", "the missing terminal event preserves the stale view");
      const receipt = await runtime.createThread(intent({ type: "new-thread", draftId: "recovered-draft",
        execution: { hostId: "local", workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] } } }));
      assert.equal(receipt.threadId, "thread-created");
      assert.equal(receipt.turnId, durable ? "turn-created" : null);
      assert.equal(physical.length, 2);
      assert.equal(physical[0]!.requests.filter(request => request.method === "thread/start").length, 0);
      assert.equal(physical[1]!.requests.filter(request => request.method === "thread/start").length, 1);
      assert.equal(physical[1]!.requests.filter(request => request.method === "turn/start").length, durable ? 1 : 0);
    } finally { await runtime.dispose(); bridge.close(); await server.close(); }
  }
});
