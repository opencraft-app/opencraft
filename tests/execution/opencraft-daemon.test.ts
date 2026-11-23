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

import { openLocalAgentStorageWithWorker } from "../../apps/local-agent-host/src/storage/local-agent-storage.js";
import { seedLegacyHostStorage, seedNewerHostStorage } from "../support/local-agent-storage-fixture.js";
import { OpenCraftDaemonClientManager } from "../../apps/desktop/src/daemon-client.js";
import { readDaemonMachineIdentity } from "../../apps/opencraft-daemon/src/machine-identity.js";
import { startOpenCraftDaemonServer } from "../../apps/opencraft-daemon/src/server.js";
import { daemonLogPath, isDaemonEndpointUnavailable, openDaemonLog } from "../../apps/desktop/src/daemon-client.js";

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
  const source = await readFile(new URL("../../apps/desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(source, /OpenCraftDaemonClientManager/u);
  assert.match(source, /dshCapabilityPlugin:/u);
  assert.match(source, /@opencraft\/headless-server\/serve-workbench-static/u);
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
      const manager = await OpenCraftDaemonClientManager.open({ ...options, tokenPath, tokenMode: "existing", daemonEntry: "unused", executable: process.execPath });
      const connection = await manager.connectAppHost("storage-summary");
      try {
        assert.deepEqual(connection.storage?.map(item => item.status), ["migrated", "migrated", "fresh", "fresh", "adopted", "fresh"]);
        for (const item of connection.storage ?? []) if (item.backupPath) assert.ok((await stat(item.backupPath)).size > 0);
      } finally { connection.close(); }
    }
    await assert.rejects(stat(marker), { code: "ENOENT" });
  } finally { await daemon?.close(); process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test("competing daemon startup has exactly one storage owner before either can open databases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-owners-"));
  const cwd = process.cwd();
  const daemons: Awaited<ReturnType<typeof startOpenCraftDaemon>>[] = [];
  try {
    seedLegacyHostStorage(join(directory, "data"));
    const options = { endpoint: join(directory, "daemon.sock"), runtimeDirectory: cwd, authToken: "x".repeat(48),
      dshExecutable: "unused", dataDirectory: join(directory, "data"), codexExecutable: "unused",
      codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "native") };
    const results = await Promise.allSettled([startOpenCraftDaemon(options), startOpenCraftDaemon(options)]);
    for (const result of results) if (result.status === "fulfilled") daemons.push(result.value);
    assert.equal(daemons.length, 1);
    const failure = results.find(result => result.status === "rejected");
    assert.ok(failure && failure.status === "rejected"); assert.match(failure.reason.message, /already owned/);
    await daemons[0].close(); daemons.length = 0;
    const reopened = await openLocalAgentStorageWithWorker({ dataDirectory: options.dataDirectory });
    try { assert.ok(reopened.summaries.every(row => row.status === "up-to-date")); } finally { await reopened.close(); }
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

test("a Codex bridge stack that cannot start leaves the daemon serving and only Codex unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-bridge-down-"));
  const cwd = process.cwd();
  let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
  let appHost: MessagePortAppHostClient | undefined;
  try {
    const endpoint = join(directory, "daemon.sock"), token = "x".repeat(48);
    // A program directory without the bridge programs: the stack fails to start.
    daemon = await startOpenCraftDaemon({ endpoint, runtimeDirectory: cwd, authToken: token, dshExecutable: "unused",
      dataDirectory: join(directory, "data"), codexExecutable: "unused", codexDataDirectory: join(directory, "codex"),
      nativeCodexHomeDirectory: join(directory, "native"), codexBridgeStack: { programs: join(directory, "no-programs") } });
    // The daemon answers Main without waiting on Codex.
    const channel = await openDaemonChannel(endpoint, token, "bridge-down-renderer");
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const stop = channel.subscribeMessage(value => {
      const message = value as DaemonServerMessage;
      if (message.type === "app-host/message") for (const listener of listeners) listener({ data: message.payload } as MessageEvent<unknown>);
    });
    appHost = new MessagePortAppHostClient({ postMessage: message => channel.send({ type: "app-host/message", payload: message }),
      addEventListener: (_type, listener) => { listeners.add(listener); }, removeEventListener: (_type, listener) => { listeners.delete(listener); },
      start() {}, close() { stop(); channel.close(); } }, "bridge-down-renderer");
    await appHost.waitUntilReady();
    // Each Codex connection retries the stack and reports why Codex is unavailable.
    for (let attempt = 0; attempt < 2; attempt++) {
      const transport = appHost.createTransport("local-codex");
      const client = new JsonRpcAppServerClient({ hostId: "local-codex", transport });
      try {
        await assert.rejects((async () => { await transport.connect(); await client.request("thread/list", {}); })(), /Codex is unavailable/);
      } finally { await client.close(); }
    }
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
    const manager=await OpenCraftDaemonClientManager.open({endpoint,tokenPath,tokenMode:"existing",daemonEntry:"unused",executable:process.execPath,runtimeDirectory:root,dataDirectory:root,dshExecutable:"unused",codexExecutable:"unused",codexDataDirectory:join(root,"codex"),nativeCodexHomeDirectory:join(root,"native")});
    const connection=await manager.connectAppHost("new-client");assert.deepEqual(connection.storage,storage);connection.close();
  }finally{await server.close();await appHost.close();await rm(root,{recursive:true,force:true});}
});

test("the desktop daemon owns and fences the Server database; another process can only borrow it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-server-owner-"));
  const cwd = process.cwd();
  let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
  const { createDesktopAccountHost } = await import("../../plugins/local-account/src/desktop.js");
  try {
    const humanAccountDirectory = join(directory, "human-account");
    daemon = await startOpenCraftDaemon({ endpoint: join(directory, "daemon.sock"), runtimeDirectory: cwd, authToken: "synthetic-" + "x".repeat(48),
      dshExecutable: "unused", dataDirectory: join(directory, "data"), codexExecutable: "unused", codexDataDirectory: join(directory, "codex"),
      nativeCodexHomeDirectory: join(directory, "native"), humanAccountDirectory });
    // The daemon migrated and initialized the installation before listening.
    await stat(join(humanAccountDirectory, "opencraft-server.sqlite"));
    // The previous arrangement, Main opening it as owner, now meets the daemon's fence.
    await assert.rejects(createDesktopAccountHost(humanAccountDirectory, () => ""));
    const main = await createDesktopAccountHost(humanAccountDirectory, () => "", { storageRole: "borrower" });
    try {
      const token = main.createNativeSession();
      assert.ok(main.authenticateSession(token), "Main's native session is accepted against the daemon-owned database");
    } finally { await main.close(); }
  } finally { await daemon?.close(); process.chdir(cwd); await rm(directory, { recursive: true, force: true }); }
});

test("Main forwards account routes to the daemon-owned account service and opens its remote windows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-daemon-account-"));
  const cwd = process.cwd();
  let daemon: Awaited<ReturnType<typeof startOpenCraftDaemon>> | undefined;
  const { createWorkbenchStaticServer } = await import("../../apps/headless-server/src/serve-workbench-static.mjs");
  const { createAccountRouteProxy } = await import("../../apps/desktop/src/account-route-proxy.js");
  let staticServer: Awaited<ReturnType<typeof createWorkbenchStaticServer>> | undefined;
  try {
    const token = "synthetic-" + "x".repeat(48), endpoint = join(directory, "daemon.sock"), tokenPath = join(directory, "token");
    await writeFile(tokenPath, token);
    const options = { endpoint, runtimeDirectory: cwd, authToken: token, dshExecutable: "unused", dataDirectory: join(directory, "data"),
      codexExecutable: "unused", codexDataDirectory: join(directory, "codex"), nativeCodexHomeDirectory: join(directory, "native"),
      humanAccountDirectory: join(directory, "human-account") };
    daemon = await startOpenCraftDaemon(options);
    const manager = await OpenCraftDaemonClientManager.open({ ...options, tokenPath, tokenMode: "existing", daemonEntry: "unused", executable: process.execPath });
    // Main's side: the renderer server forwards account routes to the attached daemon endpoint.
    const renderer = join(directory, "renderer"); await mkdir(renderer); await writeFile(join(renderer, "index.html"), "<!doctype html>");
    let endpointForMain: string | null = null;
    staticServer = await createWorkbenchStaticServer({ root: renderer, accountService: createAccountRouteProxy(() => endpointForMain) });
    const origin = `http://127.0.0.1:${(await staticServer.listen({ host: "127.0.0.1", port: 0 })).port}`;
    const opened: string[] = [];
    const attachment = await manager.attachAccount(origin, async remote => { opened.push(remote); });
    endpointForMain = attachment.endpoint;
    assert.equal(attachment.endpoint, join(directory, "opencraft-account.sock"));
    assert.equal((await stat(attachment.endpoint)).mode & 0o777, 0o600);

    const owner = `oc_desktop_owner=${attachment.browserProof}; oc_human=${attachment.sessionToken}`;
    const status = await (await fetch(origin + "/__opencraft_account/status", { headers: { cookie: owner } })).json() as { native: boolean; actor: unknown };
    assert.equal(status.native, true);
    assert.ok(status.actor, "the native session issued by the daemon signs Main's window in");
    assert.equal((await (await fetch(origin + "/__opencraft_account/status")).json() as { native: boolean }).native, false);

    const connect = await fetch(origin + "/__opencraft_account/connect", { method: "POST",
      headers: { cookie: owner, origin, "content-type": "application/json" }, body: JSON.stringify({ origin: "https://remote.example/" }) });
    assert.equal(connect.status, 200);
    assert.deepEqual(opened, ["https://remote.example"]);

    // The account routes answer only for the origin Main attached.
    const { request: httpRequest } = await import("node:http");
    const foreignStatus = await new Promise<number>((resolve, reject) => {
      const probe = httpRequest(origin + "/__opencraft_account/status", { headers: { host: "127.0.0.1:1" } }, reply => { reply.resume(); resolve(reply.statusCode ?? 0); });
      probe.once("error", reject); probe.end();
    });
    assert.equal(foreignStatus, 404, "a foreign Host is not served, as before the move");

    let closed = false;
    attachment.subscribeClose(() => { closed = true; });
    await daemon.close(); daemon = undefined;
    for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(closed, true, "Main learns that the daemon went away and must reattach");
    assert.equal((await fetch(origin + "/__opencraft_account/status")).status, 503);
  } finally {
    await staticServer?.close(); await daemon?.close(); process.chdir(cwd); await rm(directory, { recursive: true, force: true });
  }
});

test("the daemon log is private and keeps one previous generation once large", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-daemon-log-"));
  try {
    const runtime = join(root, "runtime");
    let log = await openDaemonLog(runtime); await log.write("first\n"); await log.close();
    assert.equal((await stat(daemonLogPath(runtime))).mode & 0o777, 0o600);
    await writeFile(daemonLogPath(runtime), "x".repeat(5 * 1024 * 1024 + 1));
    log = await openDaemonLog(runtime); await log.write("second\n"); await log.close();
    assert.equal(await readFile(daemonLogPath(runtime), "utf8"), "second\n");
    assert.equal((await stat(daemonLogPath(runtime) + ".1")).size, 5 * 1024 * 1024 + 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a daemon that fails to start leaves its output in the log the error names", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-daemon-fail-"));
  try {
    const entry = join(root, "failing-daemon.cjs");
    await writeFile(entry, 'process.stderr.write("synthetic daemon startup failure\\n"); process.exit(1);');
    const runtimeDirectory = join(root, "runtime"), tokenPath = join(root, "token");
    await writeFile(tokenPath, "synthetic-" + "x".repeat(48));
    const manager = await OpenCraftDaemonClientManager.open({ endpoint: join(root, "daemon.sock"), tokenPath, tokenMode: "existing", daemonEntry: entry,
      executable: process.execPath, runtimeDirectory, dataDirectory: join(root, "data"), dshExecutable: "unused", codexExecutable: "unused",
      codexDataDirectory: join(root, "codex"), nativeCodexHomeDirectory: join(root, "native") });
    await assert.rejects(manager.ensureStarted(), error => error instanceof Error && error.message.includes(daemonLogPath(runtimeDirectory)));
    assert.match(await readFile(daemonLogPath(runtimeDirectory), "utf8"), /synthetic daemon startup failure/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a daemon left by another build is stopped and a compatible daemon is adopted", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-daemon-build-")), endpoint = join(root, "daemon.sock"), token = "synthetic-" + "x".repeat(48);
  const tokenPath = join(root, "token"); await writeFile(tokenPath, token);
  const appHost = new AppHostServer({ createTransport: () => new TestTransport() });
  const { createServer } = await import("node:net");
  let shutdownRequests = 0;
  let replacement: Awaited<ReturnType<typeof startOpenCraftDaemonServer>> | undefined;
  const sockets = new Set<import("node:net").Socket>();
  // An older daemon: authenticates the same token but reports another build.
  const old = createServer(socket => {
    sockets.add(socket);
    const channel = new DaemonJsonLineChannel(socket);
    channel.subscribeMessage(value => {
      const message = value as { type?: string };
      if (message.type === "daemon/hello") channel.send({ type: "daemon/ready", protocolVersion: OPENCRAFT_DAEMON_PROTOCOL_VERSION, buildId: "older-build", pid: 1 });
      if (message.type === "daemon/shutdown") {
        shutdownRequests++;
        channel.send({ type: "daemon/shutting-down" });
        for (const open of sockets) open.destroy();
        old.close(() => { void startOpenCraftDaemonServer({ endpoint, authToken: token, appHost }).then(server => { replacement = server; }); });
      }
    });
  });
  await new Promise<void>(resolve => old.listen(endpoint, resolve));
  try {
    const manager = await OpenCraftDaemonClientManager.open({ endpoint, tokenPath, tokenMode: "existing", daemonEntry: "unused", executable: process.execPath,
      runtimeDirectory: root, dataDirectory: root, dshExecutable: "unused", codexExecutable: "unused", codexDataDirectory: join(root, "codex"),
      nativeCodexHomeDirectory: join(root, "native") });
    await manager.ensureStarted();
    assert.equal(shutdownRequests, 1);
    const connection = await manager.connectAppHost("after-replacement"); connection.close();
  } finally {
    await replacement?.close(); await appHost.close(); old.close(); await rm(root, { recursive: true, force: true });
  }
});

test("closing a daemon JSON line channel destroys its socket instead of only half-closing", () => {
  const socket = new PassThrough();
  const channel = new DaemonJsonLineChannel(socket as unknown as import("node:net").Socket);
  assert.equal(socket.destroyed, false);
  channel.close();
  assert.equal(socket.destroyed, true, "short-lived probes must release their descriptor immediately");
});
