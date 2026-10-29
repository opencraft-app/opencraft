import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { request, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { AppHostServer } from "../../packages/app-host-server/src/index.ts";
import { parseHeadlessArguments, startHeadlessServer } from "../../scripts/headless-server.mjs";
import { assertHeadlessBuildHost, buildHeadlessBundle, headlessWebHostDefinitions } from "../../scripts/package-headless-linux.mjs";
import { createWorkbenchWebServer } from "../../scripts/serve-workbench-web.mjs";

async function writeHeadlessVersion(webRoot) {
  await writeFile(join(webRoot, "version.json"), JSON.stringify({
    schemaVersion: 1,
    buildId: "headless-test",
    headlessServer: true,
    headlessHostId: "opencraft-server",
  }));
}

test('running headless gateway resolves a new Host address on reconnect and rejects unavailable attachments', { timeout: 10_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-host-reconnect-'));
  const webRoot = join(root, 'web'); await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html><head></head><body>fixture</body></html>');
  await writeHeadlessVersion(webRoot);
  const backends = [];
  let server;
  try {
    for (const identity of ['first', 'recovered']) {
      const backend = new WebSocketServer({ port: 0, host: '127.0.0.1' }); backends.push(backend);
      await new Promise(done => backend.once('listening', done));
      backend.on('connection', socket => socket.send(identity));
    }
    let selected = 0;
    let unavailable = false;
    const target = () => `ws://127.0.0.1:${backends[selected].address().port}/rpc`;
    server = await startHeadlessServer({ root, webRoot, dataDirectory: join(root, 'data'), port: 0, machineName: 'join服务器',
      startAgentHost: async options => { assert.equal(options.machineIdentity.name, 'join服务器'); return { websocketUrl: target(),
        resolveWebsocketUrl: async () => { if (unavailable) throw new Error('private attachment failure'); return target(); },
        async close() {} }; } });
    const reconnect = () => new Promise((accept, reject) => {
      const socket = new WebSocket(`${server.url.replace('http:', 'ws:')}/appserver`, { origin: server.url });
      socket.once('message', value => { socket.terminate(); accept(value.toString()); });
      socket.once('error', reject);
    });
    assert.equal(await reconnect(), 'first');
    selected = 1;
    assert.equal(await reconnect(), 'recovered', 'same gateway must discover a restarted Host');
    unavailable = true;
    await assert.rejects(reconnect(), /503/);
    unavailable = false;
    assert.equal(await reconnect(), 'recovered');
  } finally {
    await server?.close();
    await Promise.all(backends.map(backend => { for (const socket of backend.clients) socket.terminate(); return new Promise(done => backend.close(done)); }));
    await rm(root, { recursive: true, force: true });
  }
});

test("headless machine name supports operator configuration and CLI override", () => {
  assert.equal(parseHeadlessArguments([], { OPENCRAFT_MACHINE_NAME: "join服务器" }).machineName, "join服务器");
  assert.equal(parseHeadlessArguments(["--machine-name", "other"], { OPENCRAFT_MACHINE_NAME: "join服务器" }).machineName, "other");
  assert.throws(() => parseHeadlessArguments(["--machine-name"]), /requires a name/);
});

test("headless command accepts a private data root and rejects unsupported flags", () => {
  assert.throws(() => parseHeadlessArguments(["--enterprise-identity-token-file", "/private/token"]), /Unknown option/);
  assert.throws(() => parseHeadlessArguments(["--enterprise-identity-token-file", "relative"]));
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
  assert.equal(parseHeadlessArguments(["--local-desktop", "--data-dir", "/tmp/local-desktop"]).localDesktop, true);
  assert.throws(() => parseHeadlessArguments(["--local-desktop", "--host", "0.0.0.0", "--allow-unauthenticated-public"]), /loopback-only/u);
  const internal = parseHeadlessArguments(["--trusted-internal-desktop", "--host", "0.0.0.0", "--allow-unauthenticated-public"]);
  assert.equal(internal.localDesktop, true);
  assert.equal(internal.desktopAccess, "trusted-internal");
  assert.throws(() => parseHeadlessArguments(["--local-desktop", "--trusted-internal-desktop"]), /Choose either/u);
  assert.throws(() => parseHeadlessArguments(["--desktop-control"]), /explicit desktop access policy/u);
  assert.equal(parseHeadlessArguments(["--desktop-control", "--trusted-internal-desktop"]).desktopControl, true);
  assert.equal(parseHeadlessArguments(["--local-desktop"]).desktopControl, undefined);
  assert.throws(() => parseHeadlessArguments(["--trusted-internal-desktop", "--host", "0.0.0.0"]), /allow-unauthenticated-public/u);
});

test("local desktop gateway requires loopback, exact Origin and credential-free URL", async context => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-desktop-gateway-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html>");
  let accepted = 0;
  const desktopService = { accept(socket) { accepted++; socket.close(); } };
  await assert.rejects(createWorkbenchWebServer({ root, desktopService }), /loopback-only/u);
  await assert.rejects(startHeadlessServer({ root, host: "0.0.0.0", allowUnauthenticatedPublic: true, localDesktop: true }), /loopback-only/u);
  const web = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: true, desktopService });
  context.after(() => web.close());
  await assert.rejects(web.listen({ host: "0.0.0.0", port: 0 }), /loopback/u);
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin.replace("http", "ws")}/desktop/connect`;
  const connect = (url, options) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("error", reject); socket.once("open", () => resolve(socket));
  });
  await assert.rejects(connect(endpoint, { origin: "https://foreign.example" }), /403/u);
  await assert.rejects(connect(endpoint), /403/u);
  await assert.rejects(connect(`${endpoint}?ticket=must-not-be-in-url`, { origin }));
  assert.equal(accepted, 0);
  const socket = await connect(endpoint, { origin });
  await new Promise(resolve => socket.once("close", resolve));
  assert.equal(accepted, 1);
  assert.equal((await fetch(`${origin}/desktop/connect`)).status, 426);
});

test("trusted-internal desktop is explicit and still requires same-origin, credential-free viewing", async context => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-internal-desktop-gateway-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html>");
  let accepted = 0;
  const desktopService = { accept(socket) { accepted++; setImmediate(() => socket.close()); } };
  await assert.rejects(createWorkbenchWebServer({ root, desktopService, desktopAccess: "public" }), /Invalid desktop access/u);
  await assert.rejects(startHeadlessServer({ desktopAccess: "trusted-internal" }), /requires local desktop/u);
  await assert.rejects(startHeadlessServer({ localDesktop: true, desktopAccess: "public" }), /Invalid desktop access/u);
  const web = await createWorkbenchWebServer({ root, appServerTarget: null, desktopService, desktopAccess: "trusted-internal" });
  context.after(() => web.close());
  const address = await web.listen({ host: "0.0.0.0", port: 0 });
  const endpoint = `ws://127.0.0.1:${address.port}/desktop/connect`;
  const headers = { Host: "workspace.internal" };
  const connect = (url, options = {}) => new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 2000, ...options });
    socket.once("error", reject); socket.once("open", () => resolve(socket));
  });
  for (const origin of [undefined, "null", "https://foreign.internal", "https://workspace.internal/extra", "https://workspace.internal:444"]) {
    await assert.rejects(connect(endpoint, { headers, ...(origin ? { origin } : {}) }), /403/u);
  }
  await assert.rejects(connect(`${endpoint}?ticket=never-in-url`, { headers, origin: "https://workspace.internal" }));
  await assert.rejects(connect(endpoint, { headers: { ...headers, "x-forwarded-host": "foreign.internal" }, origin: "https://foreign.internal" }), /403/u);
  assert.equal(accepted, 0);
  for (const origin of ["http://workspace.internal", "https://workspace.internal"]) {
    const socket = await connect(endpoint, { headers, origin });
    await new Promise(resolve => socket.once("close", resolve));
  }
  assert.equal(accepted, 2, "HTTP and TLS-terminated same-origin pages can view, not cross-site pages");
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
  assert.equal(parseHeadlessArguments([...argv, "--ssh-require-access-key"], {}).sshRequireAccessKey, true);
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
    assert.equal(webOptions.sshManagement.accessMode, "shared");
    await assert.rejects(access(join(dataDirectory, "ssh", "access.key")), { code: "ENOENT" });
  } finally { await managed.close(); }
  const protectedServer = await startHeadlessServer({ root, webRoot, dataDirectory, host: "0.0.0.0", port: 8089,
    allowUnauthenticatedPublic: true, sshPublicAccess: true, sshRequireAccessKey: true, startAgentHost, createWebServer });
  try {
    assert.equal(webOptions.sshManagement.accessMode, "access-key");
    await access(join(dataDirectory, "ssh", "access.key"));
  } finally { await protectedServer.close(); }
});

test("Linux tar packaging refuses foreign native build hosts before touching outputs", () => {
  assert.doesNotThrow(() => assertHeadlessBuildHost("linux", "x64"));
  assert.doesNotThrow(() => assertHeadlessBuildHost("linux", "arm64", "arm64"));
  assert.throws(() => assertHeadlessBuildHost("linux", "x64", "arm64"), /native Linux arm64/u);
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
    /requires a headless Web build with the opencraft-server Host entry enabled/u,
  );
  await assert.rejects(access(dataDirectory), { code: "ENOENT" });
});

test("bundled headless help exits without starting the imported static gateway", async (context) => {
  const root = new URL("../../.runtime/", import.meta.url);
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
  assert.equal(await status({ Host: externalHost, Origin: "https://workbench.example.com" }), 200);
  const foreign = new WebSocket(`ws://127.0.0.1:${address.port}/appserver`, {
    headers: { Host: externalHost }, origin: "https://workbench.example.com",
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
    headers: { Host: externalHost }, origin: "https://workbench.example.com",
  });
  context.after(() => appHostSocket.terminate());
  await new Promise((resolvePromise, reject) => {
    appHostSocket.once("open", resolvePromise);
    appHostSocket.once("error", reject);
  });
  appHostSocket.close();
});

test("browser AppHost bridge routes Codex frames through one leased Server transport", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-headless-server-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>AppHost bridge fixture</title>");
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
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: "web-client" }));
  const ready = await waitFor(frame => frame.type === "ready");
  assert.equal(ready.connectionId, "web-client");
  assert.equal(ready.capabilities.connectionProbe, true);
  socket.send(JSON.stringify({ type: "connection/probe", requestId: "foreground-probe" }));
  assert.equal((await waitFor(frame => frame.type === "response" && frame.requestId === "foreground-probe")).ok, true);
  assert.equal(transportCount, 0, "probe must not activate an engine");
  socket.send(JSON.stringify({ type: "host/connect", requestId: "connect", hostId: "local-codex", leaseId: "lease" }));
  const connected = await waitFor(frame => frame.type === "response" && frame.requestId === "connect");
  assert.equal(connected.ok, true);
  assert.equal(transportCount, 0, "an identity-only lease must not allocate an engine");
  const sendRpc = (requestId, id, method) => socket.send(JSON.stringify({
    type: "host/send", requestId, hostId: "local-codex", leaseId: "lease",
    generation: connected.result.generation,
    frame: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
  }));
  sendRpc("identity-probe", "identity", "runtime/machine/read");
  const identity = await waitFor(frame => frame.type === "host/frame" && JSON.parse(frame.frame).id === "identity");
  assert.equal(identity.leaseId, "lease");
  assert.ok(JSON.parse(identity.frame).result.machine.machineId);
  assert.equal(transportCount, 0, "machine discovery is independent of native engine initialization");
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
  reconnected.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: "web-client-awake" }));
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
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: attempts[index] }));
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
  assert.deepEqual(diagnostics.find(item => item.event === "client-failure"), { serverProtocolVersion: 2, event: "client-failure", ...valid });
  const recovery = { kind: "recovery", recoveryId: "recovery-test-1", stage: "history-started", attemptId: attempts[1], eventAtMs: 1792411504000, elapsedMs: 830, requests: 2, responseBytes: 4150, projectionMs: 0.4, extraConversations: 0 };
  const recoveryAccepted = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(recovery),
  });
  assert.equal(recoveryAccepted.status, 202);
  assert.deepEqual(diagnostics.find(item => item.event === "client-recovery"), { serverProtocolVersion: 2, event: "client-recovery", ...recovery });
  const viewport = { kind: "viewport", episode: "viewport-test", sourceRevision: "a".repeat(40),
    layoutHeight: 844, layoutWidth: 390, visualHeight: 440, visualWidth: 390,
    visualTop: 172, visualLeft: 0, pageTop: 232, scrollY: 60, scale: 1,
    shellTop: -8, shellHeight: 440, editorTop: 340, sendBottom: 560, editing: 1 };
  const postViewport = body => fetch(`${origin}/__opencraft_apphost_diagnostic`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await postViewport(viewport)).status, 202);
  assert.deepEqual(diagnostics.find(item => item.event === "client-viewport"), { serverProtocolVersion: 2, event: "client-viewport", ...viewport });
  const projectedViewport = { ...viewport, cssTop: 172, cssHeight: 440, clientHeight: 844,
    rootTop: -60, rootHeight: 844, bodyTop: -60, bodyHeight: 844, fixedTop: -60, fixedLeft: 0 };
  assert.equal((await postViewport(projectedViewport)).status, 202);
  assert.deepEqual(diagnostics.at(-1), { serverProtocolVersion: 2, event: "client-viewport", ...projectedViewport });
  const focusedViewport = { ...projectedViewport, editorBottom: 380, composerTop: 298, composerBottom: 390,
    draftScroll: 29, editorScroll: 7, sendTop: 336, sendHit: 1,
    touchSequence: 1, touchScreenClientY: 100, touchPageClientY: 294 };
  assert.equal((await postViewport(focusedViewport)).status, 202);
  assert.deepEqual(diagnostics.at(-1), { serverProtocolVersion: 2, event: "client-viewport", ...focusedViewport });
  const edgeViewport = { ...focusedViewport, screenHeight: 956, screenWidth: 440, standalone: 1, safeLayoutTop: 1,
    statusBarOverlayRequested: 1, edgeSamplingActive: 0,
    rowTop: 0, rowHeight: 894, headerTop: 62, headerHeight: 44, shellPaddingTop: 0, rowPaddingTop: 62 };
  assert.equal((await postViewport(edgeViewport)).status, 202);
  assert.deepEqual(diagnostics.at(-1), { serverProtocolVersion: 2, event: "client-viewport", ...edgeViewport });
  assert.equal((await postViewport({ ...edgeViewport, standalone: 2 })).status, 400);
  assert.equal((await postViewport({ ...edgeViewport, safeLayoutTop: 2 })).status, 400);
  assert.equal((await postViewport({ ...edgeViewport, statusBarOverlayRequested: 2 })).status, 400);
  assert.equal((await postViewport({ ...edgeViewport, edgeSamplingActive: 2 })).status, 400);
  const missingRequiredViewport = { ...projectedViewport }; delete missingRequiredViewport.visualHeight;
  for (const invalid of [missingRequiredViewport, { ...projectedViewport, cssTop: 1e9 },
    { ...projectedViewport, bodyTop: "private" }, { ...focusedViewport, touchScreenClientY: "private" },
    { ...focusedViewport, touchPageClientY: 1e9 }, { ...viewport, text: "private" }, { ...viewport, route: "/private" },
    { ...viewport, sourceRevision: "private" }, { ...viewport, editorTop: "private" },
    { ...viewport, shellTop: null }, { ...viewport, scale: 0 }, { ...viewport, shellTop: 1e9 }]) {
    assert.equal((await postViewport(invalid)).status, 400, "Viewport diagnostics accept bounded geometry only");
  }
  for (const stage of ["display-load", "display-save", "display-paint"]) {
    const display = { ...recovery, stage, displayVersion: 1, messages: 2, timestamps: 2,
      workClocks: 1, authoritative: 0, cacheHit: 1, storageFailure: 0,
      renderedTimes: 2, visibleTimes: 2, touch: 1, viewportWidth: 390 };
    const acceptedDisplay = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(display),
    });
    assert.equal(acceptedDisplay.status, 202, stage);
    for (const privateField of [{ threadId: "private" }, { cacheKey: "private" }, { timestamps: "private" }]) {
      const rejectedDisplay = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...display, ...privateField }),
      });
      assert.equal(rejectedDisplay.status, 400, "Display diagnostics contain only allowed numeric counts");
    }
  }
  for (const invalid of [{ ...recovery, params: "private-thread-content" }, { ...recovery, requests: -1 }, { ...recovery, stage: "private-thread-content" }]) {
    const rejected = await fetch(`${origin}/__opencraft_apphost_diagnostic`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400);
  }
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


test('authenticated provider membership is explicit, validated and requires authentication configuration', () => {
  const args = ['--relay-connect-file','/private/relay.json','--access-member-provider','enterprise-identity'];
  const parsed = parseHeadlessArguments(args, {});assert.deepEqual(parsed.accessMemberProviders,['enterprise-identity']);assert.equal(parsed.accessControl,true);
  assert.deepEqual(parseHeadlessArguments(['--access-member-provider','enterprise-identity'],{}).accessMemberProviders,['enterprise-identity']); // persisted Hub trust is validated at startup
  assert.throws(()=>parseHeadlessArguments([...args,'--access-member-provider','enterprise-identity'],{}),/unique provider/);
  assert.throws(()=>parseHeadlessArguments(['--access-member-provider','*'],{}),/provider identifier/);
});

test('Headless provider policy reaches Actor admission and accepts an unenrolled verified employee', async t => {
  const { generateKeyPairSync, randomBytes } = await import('node:crypto');
  const { once } = await import('node:events');
  const { AssertionSigner, ASSERTION_HEADER } = await import("../../packages/identity-core/src/node.ts");
  const { createRelayServer } = await import("../../apps/relay-server/src/server.ts");
  const dir=await mkdtemp(join(tmpdir(),'headless-employee-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const webRoot=join(dir,'web');await mkdir(webRoot);await writeFile(join(webRoot,'index.html'),'Employee workbench');await writeHeadlessVersion(webRoot);
  const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
  const scope={issuer:'fixture',instanceId:'fixture',origin:'http://fixture.test'},credential=randomBytes(32).toString('base64url');
  const signer=new AssertionSigner(scope,privateKey),relay=createRelayServer([{...scope,credential,signer,identityProvider:{authenticate:()=>null}}]);
  relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const relayFile=join(dir,'relay.json');await writeFile(relayFile,JSON.stringify({schemaVersion:1,...scope,credential,publicKey,relay:`http://127.0.0.1:${relay.server.address().port}`,allowLoopbackInsecure:true}),{mode:0o600});
  await assert.rejects(startHeadlessServer({root:dir,webRoot,dataDirectory:join(dir,'misconfigured'),accessMemberProviders:['enterprise-identity'],startAgentHost:async()=>{throw new Error('must not start');}}),/identity provider/);
  const options=parseHeadlessArguments(['--data-dir',join(dir,'instance'),'--relay-connect-file',relayFile,'--access-member-provider','enterprise-identity'],{});
  const server=await startHeadlessServer({...options,port:0,root:dir,webRoot,startAgentHost:async()=>({websocketUrl:'ws://127.0.0.1:1',close:async()=>{}})});t.after(()=>server.close());
  const identity={provider:'enterprise-identity',subject:'777777',displayName:'fixture.employee',expiresAt:Date.now()+60000};
  const read=(path,signed=true)=>new Promise((resolve,reject)=>{
    const req=request(server.url+path,{headers:{host:'fixture.test',accept:'text/html',...(signed?{[ASSERTION_HEADER]:signer.issue(identity,'GET',path)}:{staffid:'777777'})}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();
  });
  const document=await read('/');assert.equal(document.status,200);assert.match(document.body,/Employee workbench/);
  const session=await read('/__opencraft_access/session');assert.equal(JSON.parse(session.body).role,'member');
  assert.equal((await read('/__opencraft_actors/me')).status,200,'verified employee resolves a human Actor');
  assert.equal((await read('/__opencraft_access/members')).status,403,'ordinary employee is not an administrator');
  assert.ok([401,403].includes((await read('/',false)).status),'employee headers without a verified assertion are rejected by identity or private-origin admission');
});


test('incompatible independent Core does not prevent HTTP startup or another Host connection', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-incompatible-core-'));
  let app, core, backend;
  try {
    const webRoot = join(root, 'web'); await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><head></head><body>available</body></html>');
    await writeHeadlessVersion(webRoot);
    const endpoint = join(root, 'core.sock');
    core = createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer synthetic-token');
      res.end(JSON.stringify({ protocolVersion: 999, pid: 123, codexPid: 456, nativeSocket: join(root, 'native.sock') }));
    });
    await new Promise(done => core.listen(endpoint, done));
    backend = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(done => backend.once('listening', done));
    backend.on('connection', socket => socket.send('independent-host-alive'));
    app = await startHeadlessServer({ root, webRoot, dataDirectory: join(root, 'data'), port: 0,
      codexCoreEndpoint: endpoint, codexCoreAuthToken: 'synthetic-token',
      codexExecutable: '/must-not-spawn-fallback', runtimeDirectory: root,
      startAgentHost: async () => ({ websocketUrl: `ws://127.0.0.1:${backend.address().port}`, close: async () => {} }),
    });
    assert.equal((await fetch(app.url)).status, 200);
    let health;
    // Overlay storage opens asynchronously before Core negotiation. Parallel
    // suites may delay that work; observe the failed handshake within a bounded
    // deadline instead of assuming it finishes in the first second.
    const readinessDeadline = Date.now() + 5_000;
    while (Date.now() < readinessDeadline) {
      health = await (await fetch(app.url + '/__opencraft_health')).json();
      if (health.hosts['local-codex'].state === 'unavailable') break;
      await new Promise(done => setTimeout(done, 10));
    }
    assert.equal(health.ok, false);
    assert.equal((await fetch(app.url + '/__opencraft_health')).status, 503);
    assert.equal(health.hosts['local-codex'].state, 'unavailable');
    assert.equal(health.hosts['local-codex'].code, 'codex-host-unavailable');
    assert.ok(!health.storage.some(row => row.name === 'account-pool'), 'gateway must not become a second account writer');
    const result = await new Promise((accept, reject) => {
      const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/appserver', { origin: app.url });
      socket.once('message', frame => { accept(String(frame)); socket.terminate(); }); socket.once('error', reject);
    });
    assert.equal(result, 'independent-host-alive');
  } finally {
    await app?.close();
    if (core) await new Promise(done => core.close(done));
    if (backend) { for (const client of backend.clients) client.terminate(); await new Promise(done => backend.close(done)); }
    await rm(root, { recursive: true, force: true });
  }
});


test("headless Hub target is an explicit nonzero loopback port", async () => {
  assert.equal(parseHeadlessArguments(["--hub-target-port", "18080"], {}).hubTargetPort, 18080);
  assert.equal(parseHeadlessArguments([], {}).hubTargetPort, undefined);
  assert.equal(parseHeadlessArguments([], {OPENCRAFT_HUB_TARGET_PORT:"18082"}).hubTargetPort, 18082);
  assert.equal(parseHeadlessArguments(["--hub-target-port","18083"], {OPENCRAFT_HUB_TARGET_PORT:"invalid"}).hubTargetPort, 18083);
  for (const value of ["0", "-1", "65536", "1.5", "invalid"]) {
    assert.throws(() => parseHeadlessArguments([], {OPENCRAFT_HUB_TARGET_PORT:value}));
  }
  for (const value of ["0", "-1", "65536", "1.5", "invalid"]) {
    assert.throws(() => parseHeadlessArguments(["--hub-target-port", value], {}));
  }
  assert.throws(() => parseHeadlessArguments(["--hub-target-port"], {}));
  for (const value of [0, -1, 65536, 1.5, "invalid"]) {
    await assert.rejects(startHeadlessServer({ hubTargetPort: value }));
  }
});
