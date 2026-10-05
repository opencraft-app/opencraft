import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { AppHostServer } from "../packages/app-host-server/src/index.ts";
import { parseHeadlessArguments, startHeadlessServer } from "../scripts/headless-server.mjs";
import { assertHeadlessBuildHost, buildHeadlessBundle, headlessWebHostDefinitions } from "../scripts/package-headless-linux.mjs";
import { createWorkbenchWebServer } from "../scripts/serve-workbench-web.mjs";

async function writeHeadlessVersion(webRoot) {
  await writeFile(join(webRoot, "version.json"), JSON.stringify({
    schemaVersion: 1,
    buildId: "headless-test",
    headlessServer: true,
    headlessHostId: "opencraft-server",
  }));
}

test("headless command accepts a private data root and rejects unsupported flags", () => {
  assert.deepEqual(parseHeadlessArguments(["--port", "10001", "--data-dir", "/tmp/opencraft-test"], {}), {
    help: false,
    host: "127.0.0.1",
    port: 10001,
    dataDirectory: "/tmp/opencraft-test",
    allowUnauthenticatedPublic: false,
  });
  assert.deepEqual(parseHeadlessArguments(["--help"]), { help: true });
  assert.throws(() => parseHeadlessArguments(["--listen", "0.0.0.0"]), /Unknown option/u);
  assert.throws(() => parseHeadlessArguments(["--host", "0.0.0.0", "--data-dir", "/tmp/opencraft-test"]), /requires --allow-unauthenticated-public/u);
  assert.throws(() => parseHeadlessArguments(["--allow-unauthenticated-public", "--data-dir", "/tmp/opencraft-test"]), /requires --host 0.0.0.0/u);
  assert.throws(() => parseHeadlessArguments(["--host", "192.0.2.1"]), /--host must be/u);
  assert.equal(parseHeadlessArguments(["--host", "0.0.0.0", "--allow-unauthenticated-public", "--port", "8089", "--data-dir", "/tmp/opencraft-test"]).host, "0.0.0.0");
  assert.throws(() => parseHeadlessArguments(["--port", "-1"]), /--port/u);
  assert.throws(() => parseHeadlessArguments(["--data-dir"]), /requires a path/u);
  assert.equal(parseHeadlessArguments(["--data-dir", "/tmp/explicit"], {}, () => {
    throw new Error("No home directory");
  }).dataDirectory, "/tmp/explicit");
  assert.throws(() => parseHeadlessArguments([], {}, () => {
    throw new Error("No home directory");
  }), /--data-dir is required/u);
});

test("SSH Servers are private backend bindings, never an anonymous public feature", async () => {
  assert.equal(parseHeadlessArguments(["--ssh-servers", "/private/ssh.json", "--data-dir", "/tmp/private"], {}).sshServersFile, "/private/ssh.json");
  assert.throws(() => parseHeadlessArguments(["--ssh-servers", "relative"], {}), /absolute/u);
  assert.throws(() => parseHeadlessArguments(["--ssh-servers", "/private/ssh.json", "--host", "0.0.0.0", "--allow-unauthenticated-public"], {}), /protected listener/u);
  await assert.rejects(startHeadlessServer({ host: "0.0.0.0", allowUnauthenticatedPublic: true, sshServers: [{ descriptor: { serverId: "ssh:fixture" } }] }), /cannot be exposed/u);
});

test("public SSH can explicitly allow changing addresses without removing authentication", () => {
  const argv = ["--host", "0.0.0.0", "--allow-unauthenticated-public", "--ssh-public-access", "--ssh-servers", "/private/ssh.json", "--data-dir", "/tmp/private"];
  assert.equal(parseHeadlessArguments(argv, {}).sshPublicAccess, true);
  assert.throws(() => parseHeadlessArguments([...argv, "--ssh-public-origin", "https://fixture.invalid"], {}), /Choose either/u);
});

test("public headless mode requires explicit acknowledgement and keeps one HTTP and WebSocket server", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-public-headless-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Public fixture</title>");
  await writeHeadlessVersion(webRoot);
  const dataDirectory = join(root, "data");
  const startAgentHost = async () => ({ websocketUrl: "ws://127.0.0.1:9988/rpc", close: async () => undefined });
  let webOptions;
  let listenOptions;
  const createWebServer = async (options) => {
    webOptions = options;
    return {
      async listen(options) { listenOptions = options; return { port: options.port }; },
      async close() {},
    };
  };
  await assert.rejects(startHeadlessServer({ root, webRoot, dataDirectory, host: "0.0.0.0", port: 8089, startAgentHost, createWebServer }), /acknowledgement/u);
  const server = await startHeadlessServer({ root, webRoot, dataDirectory, host: "0.0.0.0", port: 8089,
    allowUnauthenticatedPublic: true, startAgentHost, createWebServer });
  context.after(() => server.close());
  assert.deepEqual(listenOptions, { host: "0.0.0.0", port: 8089 });
  assert.equal(webOptions.loopbackOnly, false);
  assert.equal(webOptions.sameOriginOnly, undefined);
  assert.equal(server.url, "http://127.0.0.1:8089");
  await server.close();
  const managed = await startHeadlessServer({ root, webRoot, dataDirectory, host: "0.0.0.0", port: 8089,
    allowUnauthenticatedPublic: true, sshPublicAccess: true, startAgentHost, createWebServer });
  try {
    assert.equal(webOptions.sshManagement.options.publicAccess, true);
    assert.equal(webOptions.sshManagement.authorized({ headers: { host: "preview.invalid" } }), false);
    await access(join(dataDirectory, "ssh", "access.key"));
  } finally { await managed.close(); }
});

test("Linux tar packaging refuses foreign native build hosts before touching outputs", () => {
  assert.doesNotThrow(() => assertHeadlessBuildHost("linux", "x64"));
  assert.throws(() => assertHeadlessBuildHost("darwin", "arm64"), /native Linux x64/u);
  assert.throws(() => assertHeadlessBuildHost("linux", "arm64"), /native Linux x64/u);
});

test("packaged Linux Web Host advertises the remote filesystem browse root", () => {
  assert.deepEqual(headlessWebHostDefinitions().map(({ hostId, workspaceBrowseRoots }) => ({ hostId, workspaceBrowseRoots })), [
    { hostId: "opencraft-server", workspaceBrowseRoots: ["/"] },
  ]);
});

test("headless server refuses a generic Web artifact before claiming its data directory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-generic-web-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Generic Web</title>");
  await writeFile(join(webRoot, "version.json"), JSON.stringify({
    schemaVersion: 1,
    buildId: "generic-test",
    headlessServer: false,
    headlessHostId: null,
  }));
  const dataDirectory = join(root, "data");
  await assert.rejects(
    startHeadlessServer({ root, webRoot, dataDirectory, startAgentHost: async () => { throw new Error("must not start"); } }),
    /requires a Web build with its Codex and opencraft-server Host entry enabled/u,
  );
  await assert.rejects(access(dataDirectory), { code: "ENOENT" });
});

test("bundled headless help exits without starting the imported static gateway", async (context) => {
  const root = new URL("../.runtime/", import.meta.url);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root.pathname, "headless-bundle-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "server.mjs");
  await buildHeadlessBundle(entry);
  const output = execFileSync(process.execPath, [entry, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.match(output, /Usage: opencraft-server/u);
  assert.doesNotMatch(output, /opencraft static|appserver/u);
});

test("headless server serves WebUI through a loopback-only owned AppServer gateway", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-headless-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>OpenCraft headless</title>");
  await writeHeadlessVersion(webRoot);
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolvePromise) => upstream.once("listening", resolvePromise));
  context.after(() => new Promise((resolvePromise) => upstream.close(resolvePromise)));
  upstream.on("connection", (socket) => socket.on("message", (message) => socket.send(message)));
  const address = upstream.address();
  let closed = false;
  const startAgentHost = async () => ({
    websocketUrl: `ws://127.0.0.1:${address.port}/rpc?token=private-test-token`,
    async close() { closed = true; },
  });
  const dataDirectory = join(root, "data");
  const server = await startHeadlessServer({ root, webRoot, dataDirectory, port: 0, startAgentHost });
  context.after(() => server.close());
  assert.ok((await readdir(dataDirectory)).includes("server.lock"));
  await assert.rejects(access(`${dataDirectory}.lock`), { code: "ENOENT" });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(await fetch(server.url).then((response) => response.text()), /OpenCraft headless/u);
  const health = await fetch(`${server.url}/__opencraft_health`).then((response) => response.text());
  assert.doesNotMatch(health, /private-test-token/u);
  const socket = new WebSocket(`${server.url.replace(/^http/u, "ws")}/appserver`, { origin: server.url });
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  socket.send("hello");
  assert.equal((await new Promise((resolvePromise) => socket.once("message", resolvePromise))).toString(), "hello");
  socket.close();
  await assert.rejects(startHeadlessServer({ root, webRoot, dataDirectory, port: 0, startAgentHost }), /already being held/u);
  await server.close();
  assert.equal(closed, true);
  const restarted = await startHeadlessServer({ root, webRoot, dataDirectory, port: 0, startAgentHost });
  await restarted.close();
});

test("direct public gateway accepts proxy HTTPS Origin for static WebUI and WebSockets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-public-origin-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Public fixture</title>");
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolvePromise => upstream.once("listening", resolvePromise));
  context.after(() => new Promise(resolvePromise => upstream.close(resolvePromise)));
  upstream.on("connection", socket => socket.on("message", message => socket.send(message)));
  const appHost = new AppHostServer({ logicalClientRouting: true,
    createTransport() { throw new Error("The transport is not needed for a handshake test"); } });
  context.after(() => appHost.close());
  const host = await createWorkbenchWebServer({ root,
    appServerTarget: `ws://127.0.0.1:${upstream.address().port}/rpc`, appHostServer: appHost });
  context.after(() => host.close());
  const address = await host.listen({ host: "127.0.0.1", port: 0 });
  const externalHost = `remote.example:${address.port}`;
  const externalOrigin = `http://${externalHost}`;
  const status = headers => new Promise((resolvePromise, reject) => {
    const client = request({ hostname: "127.0.0.1", port: address.port, path: "/", headers }, response => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode));
    });
    client.once("error", reject);
    client.end();
  });
  assert.equal(await status({ Host: externalHost, Origin: externalOrigin }), 200);
  assert.equal(await status({ Host: externalHost, Origin: "https://join.devcloud.woa.com" }), 200);
  const foreign = new WebSocket(`ws://127.0.0.1:${address.port}/appserver`, {
    headers: { Host: externalHost }, origin: "https://join.devcloud.woa.com",
  });
  context.after(() => foreign.terminate());
  await new Promise((resolvePromise, reject) => {
    foreign.once("open", resolvePromise);
    foreign.once("error", reject);
  });
  foreign.close();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/appserver`, {
    headers: { Host: externalHost }, origin: externalOrigin,
  });
  context.after(() => socket.terminate());
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  socket.send("same-port-websocket");
  assert.equal((await new Promise(resolvePromise => socket.once("message", resolvePromise))).toString(), "same-port-websocket");
  socket.close();
  const appHostSocket = new WebSocket(`ws://127.0.0.1:${address.port}/apphost`, {
    headers: { Host: externalHost }, origin: "https://join.devcloud.woa.com",
  });
  context.after(() => appHostSocket.terminate());
  await new Promise((resolvePromise, reject) => {
    appHostSocket.once("open", resolvePromise);
    appHostSocket.once("error", reject);
  });
  appHostSocket.close();
});

test("browser AppHost bridge routes Codex frames through one leased Server transport", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-headless-codex-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Codex bridge</title>");
  await writeHeadlessVersion(root);
  const messageListeners = new Set();
  const statusListeners = new Set();
  let transportCount = 0;
  let transportClosed = false;
  const host = await startHeadlessServer({
    root,
    webRoot: root,
    dataDirectory: join(root, "data"),
    port: 0,
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9988/rpc", close: async () => undefined }),
    createCodexTransport() {
      transportCount += 1;
      return {
        status: { state: "idle" },
        async connect() {
          this.status = { state: "open" };
          for (const listener of statusListeners) listener(this.status);
        },
        async send(frame) {
          const message = JSON.parse(frame);
          if (message.method !== "initialize" && message.method !== "opencraft/codex/accounts/list") return;
          const result = message.method === "initialize" ? { serverInfo: { name: "Codex fixture" } } : { accounts: [] };
          for (const listener of messageListeners) listener(JSON.stringify({
            jsonrpc: "2.0", id: message.id, result,
            __opencraftClient: message.__opencraftClient,
          }));
        },
        subscribeMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
        subscribeStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
        async close() { transportClosed = true; this.status = { state: "closed" }; },
      };
    },
  });
  context.after(() => host.close());
  const origin = host.url;
  const appHostUrl = `${origin.replace(/^http/u, "ws")}/apphost`;
  const foreign = new WebSocket(appHostUrl, { origin: "https://evil.example" });
  await assert.rejects(new Promise((resolvePromise, reject) => {
    foreign.once("open", resolvePromise);
    foreign.once("error", reject);
  }), /403/u);
  const invalid = new WebSocket(appHostUrl, { origin });
  await new Promise((resolvePromise, reject) => {
    invalid.once("open", resolvePromise);
    invalid.once("error", reject);
  });
  invalid.send(JSON.stringify({ type: "host/connect", hostId: "local-codex" }));
  assert.equal(await new Promise(resolvePromise => invalid.once("close", resolvePromise)), 1008);
  const socket = new WebSocket(appHostUrl, { origin });
  context.after(() => socket.terminate());
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  const frames = [];
  socket.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = frames.find(predicate);
      if (found) return found;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    throw new Error(`Missing AppHost frame: ${JSON.stringify(frames)}`);
  };
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, rendererId: "web-client" }));
  const ready = await waitFor(frame => frame.type === "ready");
  assert.equal(ready.connectionId, "web-client");
  assert.equal(ready.capabilities.connectionProbe, true);
  socket.send(JSON.stringify({ type: "connection/probe", requestId: "foreground-probe" }));
  assert.equal((await waitFor(frame => frame.type === "response" && frame.requestId === "foreground-probe")).ok, true);
  assert.equal(transportCount, 0, "probe must not activate an engine");
  socket.send(JSON.stringify({ type: "host/connect", requestId: "connect", hostId: "local-codex", leaseId: "lease" }));
  const connected = await waitFor(frame => frame.type === "response" && frame.requestId === "connect");
  assert.equal(connected.ok, true);
  assert.equal(transportCount, 1);
  const sendRpc = (requestId, id, method) => socket.send(JSON.stringify({
    type: "host/send", requestId, hostId: "local-codex", leaseId: "lease",
    generation: connected.result.generation,
    frame: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
  }));
  sendRpc("send-init", "rpc-init", "initialize");
  const initialized = await waitFor(frame => frame.type === "host/frame" && frame.frame.includes("rpc-init"));
  assert.equal(JSON.parse(initialized.frame).result.serverInfo.name, "Codex fixture");
  sendRpc("send-accounts", "rpc-accounts", "opencraft/codex/accounts/list");
  const accounts = await waitFor(frame => frame.type === "host/frame" && frame.frame.includes("rpc-accounts"));
  assert.deepEqual(JSON.parse(accounts.frame).result, { accounts: [] });
  socket.close();
  await new Promise(resolvePromise => socket.once("close", resolvePromise));
  assert.equal(transportClosed, false);
  const reconnected = new WebSocket(appHostUrl, { origin });
  context.after(() => reconnected.terminate());
  await new Promise((resolvePromise, reject) => {
    reconnected.once("open", resolvePromise);
    reconnected.once("error", reject);
  });
  const reconnectFrames = [];
  reconnected.on("message", raw => reconnectFrames.push(JSON.parse(raw.toString())));
  const waitForReconnect = async predicate => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = reconnectFrames.find(predicate);
      if (found) return found;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    throw new Error(`Missing reconnected AppHost frame: ${JSON.stringify(reconnectFrames)}`);
  };
  reconnected.send(JSON.stringify({ type: "hello", protocolVersion: 1, rendererId: "web-client-awake" }));
  await waitForReconnect(frame => frame.type === "ready");
  reconnected.send(JSON.stringify({ type: "host/connect", requestId: "reconnect", hostId: "local-codex", leaseId: "new-lease" }));
  const resumed = await waitForReconnect(frame => frame.type === "response" && frame.requestId === "reconnect");
  assert.equal(resumed.result.generation, connected.result.generation);
  assert.equal(transportCount, 1);
  reconnected.close();
  await new Promise(resolvePromise => reconnected.once("close", resolvePromise));
  await host.close();
  assert.equal(transportClosed, true);
});

test("Web host terminates a half-open AppHost socket after missed heartbeat", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-apphost-heartbeat-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Heartbeat fixture</title>");
  const appHost = new AppHostServer({
    createTransport() { throw new Error("Host activation is not expected"); },
  });
  const web = await createWorkbenchWebServer({
    root,
    appServerTarget: null,
    appHostServer: appHost,
    webSocketHeartbeatIntervalMs: 10,
  });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`${origin.replace(/^http/u, "ws")}/apphost`, { origin });
  context.after(() => socket.terminate());
  context.after(() => web.close());
  context.after(() => appHost.close());
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 35));
  assert.equal(socket.readyState, WebSocket.OPEN, "a healthy peer survives repeated heartbeats");
  // Browsers answer protocol Ping frames below JavaScript. Replacing ws.pong
  // gives the fixture the equivalent of a network path that silently vanished.
  socket.pong = () => {};
  const closeCode = await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("Half-open AppHost socket was not terminated")), 500);
    socket.once("close", code => { clearTimeout(timeout); resolvePromise(code); });
  });
  assert.equal(closeCode, 1006);
});

test("AppHost diagnostics correlate two browser sockets and reject payload fields", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-apphost-diagnostics-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Diagnostics fixture</title>");
  const appHost = new AppHostServer({
    createTransport() {
      return {
        status: { state: "idle" },
        async connect() { this.status = { state: "open" }; },
        async send() {},
        subscribeMessage() { return () => undefined; },
        subscribeStatus() { return () => undefined; },
        async close() { this.status = { state: "closed" }; },
      };
    },
  });
  const diagnostics = [];
  let resolveBothClosed;
  const bothClosed = new Promise(resolve => { resolveBothClosed = resolve; });
  const web = await createWorkbenchWebServer({
    root,
    appServerTarget: null,
    appHostServer: appHost,
    onAppHostDiagnostic: diagnostic => {
      diagnostics.push(diagnostic);
      if (diagnostic.event === "closed" &&
        diagnostics.filter(item => item.event === "closed").length === 2) {
        resolveBothClosed();
      }
    },
  });
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  context.after(() => web.close());
  context.after(() => appHost.close());
  const attempts = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const sockets = attempts.map(attempt => new WebSocket(`${origin.replace(/^http/u, "ws")}/apphost?attempt=${attempt}`, { origin }));
  context.after(() => sockets.forEach(socket => socket.terminate()));
  await Promise.all(sockets.map((socket, index) => new Promise((resolvePromise, reject) => {
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1, rendererId: attempts[index] }));
    });
    socket.once("message", raw => {
      try {
        assert.equal(JSON.parse(raw.toString()).type, "ready");
        resolvePromise();
      } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  })));
  assert.deepEqual(diagnostics.filter(item => item.event === "upgrade-accepted").map(item => item.active), [1, 2]);
  assert.deepEqual(diagnostics.filter(item => item.event === "hello-accepted").map(item => item.attemptId).sort(), attempts);
  await Promise.all(sockets.map((socket, index) => new Promise((resolvePromise, reject) => {
    const requestId = `connect-${index}`;
    socket.once("message", raw => {
      try {
        const response = JSON.parse(raw.toString());
        assert.equal(response.requestId, requestId);
        assert.equal(response.ok, true);
        resolvePromise();
      } catch (error) { reject(error); }
    });
    socket.send(JSON.stringify({ type: "host/connect", requestId, hostId: "local-codex", leaseId: `lease-${index}` }));
  })));
  assert.deepEqual(diagnostics.filter(item => item.event === "host-connect").map(item => item.attemptId).sort(), attempts);

  const valid = { attemptId: attempts[1], failure: "socket-error", phase: "connecting", readyState: 0, ageMs: 43 };
  const accepted = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(diagnostics.find(item => item.event === "client-failure"), { event: "client-failure", ...valid });
  const rejected = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...valid, conversation: "private-thread-content" }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(diagnostics).includes("private-thread-content"), false);
  await Promise.all(sockets.map(socket => new Promise(resolvePromise => {
    socket.once("close", resolvePromise);
    socket.close();
  })));
  let closeTimeout;
  try {
    await Promise.race([
      bothClosed,
      new Promise((_, reject) => {
        closeTimeout = setTimeout(() => reject(new Error("Server close diagnostics were not emitted")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(closeTimeout);
  }
  assert.deepEqual(diagnostics.filter(item => item.event === "closed").map(item => item.active).sort(), [0, 1]);
});
