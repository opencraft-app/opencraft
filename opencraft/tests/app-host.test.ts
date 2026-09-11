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
