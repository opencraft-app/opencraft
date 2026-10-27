import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { startOpenCraftDaemon } from "../../apps/opencraft-daemon/src/main.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
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

import { DshSessionRouting } from "../../apps/local-agent-host/src/dsh-session-routing.js";
import { seedLegacyHostStorage, seedNewerHostStorage } from "../support/local-agent-storage-fixture.js";
import { OpenCraftDaemonClientManager } from "../../apps/workbench-electron/src/daemon-client.js";
import { readDaemonMachineIdentity } from "../../apps/opencraft-daemon/src/machine-identity.js";
import { startOpenCraftDaemonServer } from "../../apps/opencraft-daemon/src/server.js";
import { isDaemonEndpointUnavailable } from "../../apps/workbench-electron/src/daemon-client.js";

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
  onReady?: (message: Extract<DaemonServerMessage, { type: "daemon/ready" }>) => void,
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
        onReady?.(message);
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
  const source = await readFile(new URL("../../apps/workbench-electron/src/main.ts", import.meta.url), "utf8");
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

test("a deployment machine name changes only the display name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-daemon-machine-name-"));
  try {
    const detected = await readDaemonMachineIdentity(directory);
    const named = await readDaemonMachineIdentity(directory, "  我的服务器  ");
    assert.equal(named.name, "我的服务器");
    assert.equal(named.machineId, detected.machineId);
    assert.equal(named.platform, detected.platform);
    assert.equal((await readDaemonMachineIdentity(directory, "   ")).name, detected.name);
    for (const invalid of ["x".repeat(65), "line\nbreak"]) {
      await assert.rejects(readDaemonMachineIdentity(directory, invalid), /--machine-name/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("one real daemon reports the same machine for DSH and Codex without an engine executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-daemon-machine-"));
  const previousCwd = process.cwd();
  const runtimeDirectory = join(directory, "runtime");
  await mkdir(runtimeDirectory);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\opencraft-machine-${process.pid}-${Date.now()}` : join(directory, "daemon.sock");
  const daemon = await startOpenCraftDaemon({ endpoint, runtimeDirectory, authToken: "identity-test-token-long-enough-for-daemon-authentication", dataDirectory: join(directory, "data"), dshExecutable: "/missing-engine", codexExecutable: "/missing-engine", codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "empty-native-home") });
  try {
    const channel = await openDaemonChannel(endpoint, "identity-test-token-long-enough-for-daemon-authentication", "identity-renderer");
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const stop = channel.subscribeMessage(value => {
      const message = value as DaemonServerMessage;
      if (message.type === "app-host/message") for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
    });
    const appHost = new MessagePortAppHostClient({ postMessage: message => channel.send({ type: "app-host/message", payload: message }), addEventListener: (_type, listener) => { listeners.add(listener); }, removeEventListener: (_type, listener) => { listeners.delete(listener); }, start() {}, close() { stop(); channel.close(); } }, "identity-renderer");
    await appHost.waitUntilReady();
    const identities = [];
    for (const hostId of ["local", "local-codex"]) {
      const transport = appHost.createTransport(hostId);
      const client = new JsonRpcAppServerClient({ hostId, transport });
      await transport.connect();
      identities.push(await client.request("runtime/machine/read", {}));
      await client.close();
    }
    assert.deepEqual(identities[0]!.machine, identities[1]!.machine);
    assert.deepEqual(identities.map(identity => identity.agent), ["OpenCraft", "Codex"]);
    appHost.close();
  } finally { await daemon.close(); process.chdir(previousCwd); await rm(directory, { recursive: true, force: true }); }
});

for (const failing of [true, false]) test(`daemon storage ${failing ? "failure prevents IPC" : "migration is visible before lazy engine startup"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-storage-"));
  const cwd = process.cwd();
  let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
  try {
    const dataDirectory = join(directory, "data");
    if (failing) seedNewerHostStorage(dataDirectory); else seedLegacyHostStorage(dataDirectory);
    const marker = join(directory, "engine-started");
    const executable = join(directory, "fake-dsh.cjs");
    await writeFile(executable, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`);
    const endpoint = join(directory, "daemon.sock");
    const token = "synthetic-" + "x".repeat(48);
    const options = { endpoint, runtimeDirectory: cwd, authToken: token, dshExecutable: executable,
      dataDirectory, codexExecutable: "unused", codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "native") };
    if (failing) {
      await assert.rejects(startOpenCraftDaemon(options), /executions.*newer-schema/);
      await assert.rejects(stat(endpoint), { code: "ENOENT" });
    } else {
      daemon = await startOpenCraftDaemon(options);
      const tokenPath = join(directory, "token"); await writeFile(tokenPath, token);
      const manager = new OpenCraftDaemonClientManager({ ...options, tokenPath, tokenMode: "existing", daemonEntry: "unused", executable: process.execPath });
      const connection = await manager.connectAppHost("storage-summary");
      try {
        assert.deepEqual(connection.storage?.map(item => item.status), ["migrated", "adopted", "fresh", "fresh", "adopted", "fresh"]);
        for (const item of connection.storage ?? []) if (item.backupPath) assert.ok((await stat(item.backupPath)).size > 0);
      } finally { connection.close(); }
    }
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally { await daemon?.close(); process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test("competing daemon startup has exactly one storage owner before either can open databases", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-owners-"));
  const cwd = process.cwd();
  const daemons: Awaited<ReturnType<typeof startOpenCraftDaemon>>[] = [];
  try {
    seedLegacyHostStorage(join(directory, "data"));
    const opened = t.mock.method(DshSessionRouting.prototype, "close");
    const options = { endpoint: join(directory, "daemon.sock"), runtimeDirectory: cwd, authToken: "x".repeat(48),
      dshExecutable: "unused", dataDirectory: join(directory, "data"), codexExecutable: "unused",
      codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "native") };
    const results = await Promise.allSettled([startOpenCraftDaemon(options), startOpenCraftDaemon(options)]);
    for (const result of results) if (result.status === "fulfilled") daemons.push(result.value);
    assert.equal(daemons.length, 1);
    const failure = results.find(result => result.status === "rejected");
    assert.ok(failure && failure.status === "rejected"); assert.match(failure.reason.message, /already owned/);
    assert.equal(opened.mock.callCount(), 0, "loser must not acquire and close stores");
    await daemons[0].close(); daemons.length = 0;
    assert.equal(opened.mock.callCount(), 1);
    // The claim protects the data directory even with a different IPC endpoint.
    const first = await startOpenCraftDaemon(options); daemons.push(first);
    await assert.rejects(startOpenCraftDaemon({ ...options, endpoint: join(directory, "other.sock") }), /already owned/);
  } finally { await Promise.all(daemons.map(daemon => daemon.close())); process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test("lazy Host can retry after engine startup failure with reopened storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-retry-"));
  const cwd = process.cwd();
  let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
  let appHost: MessagePortAppHostClient | undefined;
  try {
    const executable = join(directory, "fake-dsh.cjs");
    await writeFile(executable, "process.exit(1)");
    const endpoint = join(directory, "daemon.sock"), token = "x".repeat(48);
    daemon = await startOpenCraftDaemon({ endpoint, runtimeDirectory: cwd, authToken: token, dshExecutable: executable,
      dataDirectory: join(directory, "data"), codexExecutable: "unused", codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "native") });
    const channel = await openDaemonChannel(endpoint, token, "retry-renderer");
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const stop = channel.subscribeMessage(value => {
      const message = value as DaemonServerMessage;
      if (message.type === "app-host/message") for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
    });
    appHost = new MessagePortAppHostClient({ postMessage: message => channel.send({ type: "app-host/message", payload: message }),
      addEventListener: (_type, listener) => { listeners.add(listener); }, removeEventListener: (_type, listener) => { listeners.delete(listener); },
      start() {}, close() { stop(); channel.close(); } }, "retry-renderer");
    await appHost.waitUntilReady();
    const firstTransport = appHost.createTransport("local");
    const firstClient = new JsonRpcAppServerClient({ hostId: "local", transport: firstTransport });
    await firstTransport.connect();
    await assert.rejects(firstClient.request("project/list", {}), /DSH exited/);
    await firstClient.close();
    await writeFile(executable, 'console.log("dsh web: http://127.0.0.1:1"); setInterval(() => {}, 1000);');
    const secondTransport = appHost.createTransport("local");
    const secondClient = new JsonRpcAppServerClient({ hostId: "local", transport: secondTransport });
    try {
      await secondTransport.connect();
      assert.deepEqual(await secondClient.request("project/list", {}), { data: [], nextCursor: null });
    } finally { await secondClient.close(); }
  } finally { appHost?.close(); await daemon?.close(); process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test("explicit core mode fails closed without creating embedded Host stores or spawning an engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-core-unavailable-"));
  const dataDirectory = join(directory, "must-not-be-created");
  let spawned = false;
  const engine = new CodexEngineAdapter({
    coreEndpoint: join(directory, "missing.sock"), coreAuthToken: "synthetic-test-token",
    executable: "unused", runtimeDirectory: directory, dataDirectory,
    nativeCodexHomeDirectory: join(directory, "native"),
    spawnAppServer: () => { spawned = true; throw new Error("Unexpected embedded fallback"); },
  });
  try {
    await assert.rejects(engine.connect(), /Codex core unavailable/);
    assert.equal(engine.status.state, "failed");
    assert.equal(spawned, false);
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});


test("daemon wire keeps the old five-name projection and exposes complete scoped outcomes to new clients", async () => {
  const root=await mkdtemp(join(tmpdir(),"oc-summary-compat-")),endpoint=join(root,"daemon.sock"),token="synthetic-"+"x".repeat(48);
  const appHost=new AppHostServer({createTransport:()=>new TestTransport()});
  const rows=["session-routing","threads","executions","host-documents","managed-connectors","tasks"].map(name=>({name,status:"fresh" as const,appliedVersion:1,movedAside:false}));
  const storage=[...rows,{hostId:"local-codex",name:"opencraft-host-state",status:"adopted" as const,appliedVersion:1,movedAside:false}];
  const server=await startOpenCraftDaemonServer({endpoint,authToken:token,appHost,storage});
  try {
    let ready: Extract<DaemonServerMessage,{type:"daemon/ready"}> | undefined;
    const old=await openDaemonChannel(endpoint,token,"old-client","control",message=>{ready=message});
    assert.deepEqual(ready?.storage?.map(row=>row.name),rows.slice(0,5).map(row=>row.name));
    assert.deepEqual(ready?.storageOutcomes,storage);old.close();
    const tokenPath=join(root,"token");await writeFile(tokenPath,token);
    const manager=new OpenCraftDaemonClientManager({endpoint,tokenPath,tokenMode:"existing",daemonEntry:"unused",executable:process.execPath,runtimeDirectory:root,dataDirectory:root,dshExecutable:"unused",codexExecutable:"unused",codexDataDirectory:join(root,"codex"),nativeCodexHomeDirectory:join(root,"native")});
    const connection=await manager.connectAppHost("new-client");assert.deepEqual(connection.storage,storage);connection.close();
  }finally{await server.close();await appHost.close();await rm(root,{recursive:true,force:true});}
});

test("closing a daemon JSON line channel destroys its socket instead of only half-closing", () => {
  const socket = new PassThrough();
  const channel = new DaemonJsonLineChannel(socket as unknown as import("node:net").Socket);
  assert.equal(socket.destroyed, false);
  channel.close();
  assert.equal(socket.destroyed, true, "short-lived probes must release their descriptor immediately");
});
