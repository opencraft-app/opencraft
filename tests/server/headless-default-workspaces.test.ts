import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildHeadlessBundle } from "../../scripts/packaging/package-headless-linux.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-application.mjs";
import {
  WORKSPACE_CATALOG_METHOD,
  WORKSPACE_PLACEMENT_EXTENSION,
  WORKSPACE_FILE_SCOPE_METHOD,
  OPENCRAFT_METHOD_ACCESS_EXTENSION,
} from "@opencraft/appserver-protocol";
class Engine {
  status = { state: "idle" as string };
  messages = new Set<(frame: string) => void>();
  statuses = new Set<(status: unknown) => void>();
  frames: string[] = [];
  archived: string[] = [];
  async connect() {
    this.status = { state: "open" };
    for (const l of this.statuses) l(this.status);
  }
  subscribeStatus(l: (status: any) => void) {
    this.statuses.add(l);
    return () => this.statuses.delete(l);
  }
  subscribeMessage(l: (frame: string) => void) {
    this.messages.add(l);
    return () => this.messages.delete(l);
  }
  async send(frame: string) {
    this.frames.push(frame);
    const value = JSON.parse(frame);
    if (value.id === undefined) return;
    const result =
      value.method === "initialize"
        ? {
            capabilities: {
              extensions: {
                [OPENCRAFT_METHOD_ACCESS_EXTENSION]: {
                  version: 1,
                  methods: ["thread/list", "thread/read", "fs/readDirectory", "process/spawn"],
                },
              },
            },
          }
        : value.method === "thread/list"
          ? { data: value.params?.archived ? this.archived.map((id) => ({ id })) : [], nextCursor: null }
          : {};
    for (const l of this.messages)
      l(JSON.stringify({ id: value.id, [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD], result }));
  }
  sendWithContext(frame: string) {
    return this.send(frame);
  }
  async close() {
    this.status = { state: "closed" };
    for (const l of this.statuses) l(this.status);
  }
}
async function fixture(t: test.TestContext, installed = false) {
  const root = await mkdtemp(join(tmpdir(), "default-workspace-")),
    webRoot = join(root, "web"),
    socketPath = join(root, "authority.sock");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Workspace</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "workspace-fixture",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const priorInstallation = process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
  delete process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
  const installation = join(root, "installation.json");
  if (installed) {
    const key = join(root, "key");
    await writeFile(key, "synthetic-default-installation-key", { mode: 0o600 });
    await writeFile(
      installation,
      JSON.stringify({
        schemaVersion: 1,
        backend: "e2b",
        apiUrl: "https://api.e2b.dev",
        sandboxUrl: "https://e2b.dev",
        apiKeyFile: key,
        capacity: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 },
        persistentWorkspaces: true,
        templates: [
          {
            id: "synthetic-default",
            name: "Default configured workspace",
            workspaceRoot: "/workspace",
            resources: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 },
          },
        ],
        lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
      }),
      { mode: 0o600 },
    );
    process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG = installation;
  }
  const prior = process.env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET;
  process.env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET = socketPath;
  t.after(async () => {
    if (prior === undefined) delete process.env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET;
    else process.env.OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET = prior;
    if (priorInstallation === undefined) delete process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
    else process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG = priorInstallation;
    await rm(root, { recursive: true, force: true });
  });
  const engine = new Engine(),
    configurations: any[] = [],
    principal = {
      provider: "workspace-fixture",
      subject: "human",
      displayName: "Fixture",
      expiresAt: Date.now() + 120000,
    };
  const options = {
    root,
    webRoot,
    dataDirectory: join(root, "data"),
    port: 0,
    codexCoreEndpoint: join(root, "nonexistent-core.sock"),
    codexCoreAuthToken: "synthetic-core-authority-token-123456789",
    accessMemberProviders: [principal.provider],
    createCodexTransport: (config) => {
      configurations.push(config);
      return engine;
    },
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", async close() {} }),
  };
  const composition = {
    createIdentity: async () => ({
      providers: [{ authenticate: (r) => (r.headers["x-fixture-proof"] === "verified" ? principal : null) }],
      close() {},
    }),
  };
  return { root, installation, socketPath, engine, configurations, options, composition };
}
async function browser(app: { url: string }, t: test.TestContext) {
  const socket = new WebSocket(app.url.replace(/^http/, "ws") + "/apphost", {
    origin: app.url,
    headers: { "x-fixture-proof": "verified" },
  });
  t.after(() => socket.terminate());
  const frames: any[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const wait = async (predicate: (f: any) => boolean) => {
    for (let i = 0; i < 500; i++) {
      const value = frames.find(predicate);
      if (value) return value;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("AppHost response timed out");
  };
  socket.send(JSON.stringify({ type: "hello", protocolVersion: 2, rendererId: "workspace-fixture" }));
  await wait((f) => f.type === "ready");
  socket.send(
    JSON.stringify({ type: "host/connect", hostId: "local-codex", leaseId: "workspace", requestId: "connect" }),
  );
  const connected = await wait((f) => f.type === "response" && f.requestId === "connect");
  assert.equal(connected.ok, true, JSON.stringify(connected));
  let id = 0;
  return {
    socket,
    async rpc(method: string, params = {}) {
      const requestId = ++id;
      socket.send(
        JSON.stringify({
          type: "host/send",
          requestId: String(requestId),
          hostId: "local-codex",
          leaseId: "workspace",
          generation: connected.result.generation,
          frame: JSON.stringify({ id: requestId, method, params }),
        }),
      );
      const reply = await wait((f) => f.type === "host/frame" && JSON.parse(f.frame).id === requestId);
      return JSON.parse(reply.frame);
    },
  };
}

for (const [packaged, installed] of [
  [false, false],
  [false, true],
  [true, true],
])
  test(`${packaged ? "packaged" : "source"} ${installed ? "configured" : "empty"} default Headless composes canonical workspace catalog/Native hooks from the same Worker, with an honest directory and no controller resource fallback`, async (t) => {
    const f = await fixture(t, installed);
    let start = startHeadlessServer;
    if (packaged) {
      const bundle = join(f.root, "server.mjs");
      const built = await buildHeadlessBundle(bundle);
      const external = Object.values(built.metafile.outputs).flatMap((output: any) =>
        output.imports.filter((item: any) => item.external).map((item: any) => item.path),
      );
      assert.ok(
        !external.some((path) => path.startsWith("@opencraft/")),
        "Compiled first-party owners must not resolve through the source checkout",
      );
      // The bundle contract deliberately ships Pi/native third-party runtimes
      // separately; use the checkout's installed pinned closure for this probe.
      await symlink(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(f.root, "node_modules"), "dir");
      start = (await import(pathToFileURL(bundle).href)).startHeadlessServer;
    }
    const app = await start(f.options, f.composition);
    try {
      assert.equal((await stat(f.socketPath)).isSocket(), true);
      const client = await browser(app, t);
      const initialized = await client.rpc("initialize", { clientInfo: { name: "workspace-fixture", version: "1" } });
      assert.equal(initialized.error, undefined, JSON.stringify(initialized));
      assert.equal(initialized.result.capabilities.extensions[WORKSPACE_PLACEMENT_EXTENSION].version, 1);
      assert.equal(initialized.result.capabilities.extensions["opencraft/terminal"].available, false);
      const catalog = await client.rpc(WORKSPACE_CATALOG_METHOD);
      assert.equal(catalog.error, undefined, JSON.stringify(catalog));
      assert.equal(catalog.result.version, 1);
      assert.deepEqual(catalog.result.libraries, []);
      if (installed) {
        assert.equal(catalog.result.environments.length, 1);
        assert.equal(catalog.result.environments[0].target.templateId, "synthetic-default");
      } else assert.deepEqual(catalog.result.environments, []);
      for (const secret of ["synthetic-default-installation-key", "api.e2b.dev", "installation.json"])
        assert.ok(!JSON.stringify(catalog.result).includes(secret));
      assert.ok(f.configurations.length > 0);
      for (const method of [
        "decorateNativeTransport",
        "finalizeNativeCreation",
        "finalizeNativeResume",
        "requiresWorkspaceResume",
        "restoreProvisionalWorkspace",
        "readWorkspaceArtifact",
        "prepareWorkspaceArtifact",
      ])
        assert.equal(typeof f.configurations[0][method], "function", method);
      const nativeResourceCalls = () =>
        f.engine.frames.filter((frame) => /^(fs|process)\//u.test(JSON.parse(frame).method ?? "")).length;
      const before = nativeResourceCalls();
      assert.ok(
        (
          await client.rpc("process/spawn", {
            processHandle: "no-fallback",
            threadId: "missing-native",
            command: ["/bin/sh"],
            tty: true,
            size: { cols: 80, rows: 24 },
          })
        ).error,
      );
      assert.ok((await client.rpc("fs/readDirectory", { path: "/", workspaceThreadId: "missing-native" })).error);
      assert.ok((await client.rpc("fs/readDirectory", { path: "/" })).error);
      assert.ok((await client.rpc(WORKSPACE_FILE_SCOPE_METHOD, { threadId: "missing-native" })).error);
      assert.equal(
        nativeResourceCalls(),
        before,
        "Unknown or missing Hands resources must not fall through to Native fs/process handlers",
      );
      client.socket.terminate();
    } finally {
      await app.close();
    }
    await assert.rejects(stat(f.socketPath), { code: "ENOENT" });
    // A second fresh default startup acquires the same journal/vault, not a second
    // Main-owned provider or a stale authority listener. No model/cloud work.
    if (installed) {
      await rm(f.installation);
      delete process.env.OPENCRAFT_ASSISTANT_SANDBOX_CONFIG;
    }
    const next = await start(f.options, f.composition);
    try {
      const client = await browser(next, t);
      await client.rpc("initialize", { clientInfo: { name: "restart", version: "1" } });
      const catalog = await client.rpc(WORKSPACE_CATALOG_METHOD);
      assert.equal(catalog.error, undefined);
      assert.equal(catalog.result.environments.length, installed ? 1 : 0);
      client.socket.terminate();
    } finally {
      await next.close();
    }
  });

test("default workspace startup refuses missing instance admission and respects identity-managed configuration ownership", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    startHeadlessServer({ ...f.options, accessMemberProviders: [] }, {}),
    /Human instance authority/,
  );
  await assert.rejects(
    startHeadlessServer(f.options, {
      createIdentity: async () => ({
        ...(await f.composition.createIdentity()),
        assistantEnvironmentConfigurationManaged: true,
      }),
    }),
    /matching identity-owned routing/,
  );
  let invoked = false;
  await assert.rejects(
    startHeadlessServer(f.options, {
      ...f.composition,
      createCodexWorkspaceHooks() {
        invoked = true;
        throw Error("Must not construct before physical attachment");
      },
    }),
    /cannot share custom Native hooks/,
  );
  assert.equal(invoked, false);
});

test("identity-owned workspace routing is the one conversation lifecycle owner: it gets reconciliation and release calls", async (t) => {
  const f = await fixture(t);
  f.engine.archived = ["identity-archived"];
  const scopes: number[] = [],
    released: any[] = [];
  const routing = {
    createCodexWorkspaceHooks: () => ({
      decorateNativeTransport: (native: unknown) => native,
      finalizeNativeCreation: async () => {},
      finalizeNativeResume: async () => {},
      requiresWorkspaceResume: () => false,
    }),
    readCatalog: async () => ({ version: 1, environments: [], libraries: [] }),
    conversationScopes: () => {
      scopes.push(Date.now());
      return [{ hostId: "local-codex", threadId: "identity-archived" }];
    },
    releaseConversation: async (row: unknown) => {
      released.push(row);
    },
  };
  const identity = (extra: object) => async () => ({
    ...(await f.composition.createIdentity()),
    codexWorkspaceRouting: { ...routing, ...extra },
  });
  await assert.rejects(
    startHeadlessServer(f.options, { createIdentity: identity({ conversationScopes: undefined }) }),
    /both lifecycle members/,
  );
  const app = await startHeadlessServer(f.options, { createIdentity: identity({}) });
  try {
    for (let i = 0; i < 500 && !released.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(scopes.length > 0, "Archive reconciliation reads the identity routing's conversation scopes");
    assert.equal(released.length, 1, "The archived conversation is released through the identity routing");
    assert.deepEqual(
      (({ hostId, threadId, state, generation }) => ({ hostId, threadId, state, generation }))(released[0]),
      { hostId: "local-codex", threadId: "identity-archived", state: "archived", generation: 1 },
    );
  } finally {
    await app.close();
  }
  // Routing without lifecycle members still starts, with no workspace owner.
  const { conversationScopes: _scopes, releaseConversation: _release, ...plain } = routing;
  const legacy = await startHeadlessServer(
    { ...f.options, dataDirectory: join(f.root, "data-plain") },
    {
      createIdentity: async () => ({ ...(await f.composition.createIdentity()), codexWorkspaceRouting: plain }),
    },
  );
  await legacy.close();
});
