import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import test from "node:test";

import { MessagePortAppHostClient } from "@opencraft/app-host-client";
import { AppHostServer } from "@opencraft/app-host-server";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import {
  DaemonJsonLineChannel,
  OPENCRAFT_DAEMON_BUILD_ID,
  OPENCRAFT_DAEMON_PROTOCOL_VERSION,
  type DaemonServerMessage,
} from "@opencraft/daemon-ipc";

import { startOpenCraftDaemonServer } from "../apps/opencraft-daemon/src/server.js";
import { isDaemonEndpointUnavailable } from "../apps/workbench-electron/src/daemon-client.js";

class TestTransport implements DuplexTransport {
  readonly sent: string[] = [];
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  closeCount = 0;

  get status(): TransportStatus { return this.currentStatus; }
  async connect(): Promise<void> { this.publish({ state: "open" }); }
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
  private publish(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

async function openDaemonChannel(
  endpoint: string,
  token: string,
  connectionId: string,
  role: "app-host" | "control" = "app-host",
) {
  const socket = connect(endpoint);
  const channel = new DaemonJsonLineChannel(socket);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("daemon handshake timeout")), 2_000);
    channel.subscribeClose((error) => reject(error ?? new Error("daemon channel closed")));
    channel.subscribeMessage((value) => {
      const message = value as DaemonServerMessage;
      if (message.type === "daemon/fatal") reject(new Error(message.message));
      if (message.type === "daemon/ready") {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.once("connect", () => channel.send({
      type: "daemon/hello",
      protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION,
      buildId: OPENCRAFT_DAEMON_BUILD_ID,
      authToken: token,
      connectionId,
      role,
    }));
  });
  return channel;
}

test("independent OpenCraft Daemon carries App Host frames over authenticated local IPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-daemon-test-"));
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\opencraft-daemon-test-${process.pid}-${Date.now()}`
    : join(directory, "daemon.sock");
  const token = "test-token-that-is-long-enough-for-local-daemon-authentication";
  const physical = new TestTransport();
  const appHost = new AppHostServer({ createTransport: () => physical });
  let shutdownRequested = false;
  const daemon = await startOpenCraftDaemonServer({
    endpoint,
    authToken: token,
    appHost,
    onShutdownRequested() { shutdownRequested = true; },
  });
  try {
    if (process.platform !== "win32") {
      const metadata = await stat(endpoint);
      assert.equal(metadata.isSocket(), true);
      assert.equal(metadata.mode & 0o777, 0o600);
    }
    const channel = await openDaemonChannel(endpoint, token, "renderer-daemon-test");
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const unsubscribe = channel.subscribeMessage((value) => {
      const message = value as DaemonServerMessage;
      if (message.type !== "app-host/message") return;
      for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
    });
    const client = new MessagePortAppHostClient({
      postMessage(message) { channel.send({ type: "app-host/message", payload: message }); },
      addEventListener(_type, listener) { listeners.add(listener); },
      removeEventListener(_type, listener) { listeners.delete(listener); },
      start() {},
      close() { unsubscribe(); channel.close(); },
    }, "renderer-daemon-test");
    await client.waitUntilReady();
    const transport = client.createTransport("local");
    const received: string[] = [];
    transport.subscribeMessage((frame) => received.push(frame));
    await transport.connect();
    await transport.send('{"method":"thread/list"}');
    physical.receive('{"id":1,"result":[]}');
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(physical.sent, ['{"method":"thread/list"}']);
    assert.deepEqual(received, ['{"id":1,"result":[]}']);
    await transport.close();
    client.close();

    const control = await openDaemonChannel(endpoint, token, "control-daemon-test", "control");
    const acknowledged = new Promise<void>((resolve) => {
      control.subscribeMessage((value) => {
        if ((value as DaemonServerMessage).type === "daemon/shutting-down") resolve();
      });
    });
    control.send({ type: "daemon/shutdown" });
    await acknowledged;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownRequested, true);
    control.close();
  } finally {
    await daemon.close();
    await appHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron Main is a process bridge and no longer owns Agent or physical AppServer transports", async () => {
  const source = await readFile(new URL("../apps/workbench-electron/src/main.ts", import.meta.url), "utf8");
  assert.match(source, /OpenCraftDaemonClientManager/u);
  assert.match(source, /dshCapabilityPlugin:/u);
  assert.match(source, /serve-workbench-static\.mjs/u);
  assert.doesNotMatch(source, /AppHostServerSession|AppHostServer\b|WebSocketTransport|startLocalAgentHost/u);
  assert.doesNotMatch(source, /serve-workbench-web\.mjs|OPENCRAFT_APPSERVER_URL|function appServerTarget/u);
});

test("Electron only spawns a daemon for an absent endpoint, never for a failed owner handshake", () => {
  for (const code of ["ENOENT", "ECONNREFUSED", "EPIPE"]) {
    assert.equal(isDaemonEndpointUnavailable(Object.assign(new Error(code), { code })), true);
  }
  for (const code of ["UNAUTHORIZED", "PROTOCOL_MISMATCH", "ETIMEDOUT", "ECONNRESET"]) {
    assert.equal(isDaemonEndpointUnavailable(Object.assign(new Error(code), { code })), false);
  }
  assert.equal(isDaemonEndpointUnavailable(new Error("OpenCraft Daemon protocol/build mismatch")), false);
});
