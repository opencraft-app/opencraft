import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";
import { hash, installRuntimePlugin } from "../../packages/runtime-plugin-host/store.mjs";

async function fixture(t) {
  const runtime = fileURLToPath(new URL("../../.runtime/", import.meta.url));
  await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(join(runtime, "headless-runtime-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Public workbench</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "runtime-plugin-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const store = join(root, "selections"),
    packages = join(root, "packages");
  await mkdir(packages);
  const options = {
    root,
    webRoot,
    dataDirectory: join(root, "data"),
    port: 0,
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
  };
  /** Install and enable one synthetic gateway plugin through the real data-only installer. */
  const install = async (id, code, routes) => {
    const directory = join(packages, id);
    await mkdir(directory);
    await writeFile(join(directory, "gateway.mjs"), code);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version: "1.0.0",
        hostApi: 1,
        nodeMajor: 26,
        sourceRevision: "a".repeat(40),
        roles: { gateway: { entry: "gateway.mjs", routes: routes.map((path) => ({ path, methods: ["GET"] })) } },
        files: [{ path: "gateway.mjs", size: Buffer.byteLength(code), sha256: hash(code) }],
      }),
    );
    return installRuntimePlugin(directory, store, { enable: true });
  };
  return { root, store, options, install };
}

/** Plugin replies carry a marker; a route that never reached plugin code cannot contain it. */
const notServedByPlugin = async (response, message) =>
  assert.ok(!(await response.text()).includes('"plugin"'), message);
/** Generated plugin source only ever embeds a lowercase fixture name, never arbitrary text. */
const replying = (body) => {
  if (!/^[a-z]+$/.test(body)) throw Error("fixture plugin names are lowercase words");
  return `export async function activate(context){return {handle(_q,r){r.setHeader('content-type','application/json');r.end(JSON.stringify({plugin:'${body}',hostApi:context.hostApi}));},close(){}};}`;
};

/** A verified external identity: members come from one provider; another provider is authenticated but not admitted. */
function identity(events = []) {
  const principals = {
    member: { provider: "fixture-directory", subject: "member", displayName: "Member", expiresAt: Date.now() + 60_000 },
    outsider: {
      provider: "fixture-outside",
      subject: "outsider",
      displayName: "Outsider",
      expiresAt: Date.now() + 60_000,
    },
  };
  return {
    options: { accessMemberProviders: ["fixture-directory"] },
    createIdentity: async () => ({
      providers: [
        {
          authenticate: (request) =>
            principals[request.headers["x-fixture-proof"]]?.provider === "fixture-directory" ? principals.member : null,
        },
        { authenticate: (request) => (request.headers["x-fixture-proof"] === "outsider" ? principals.outsider : null) },
      ],
      close() {
        events.push("identity-close");
      },
    }),
  };
}

test("runtime plugin routes mount behind the instance admission owner", async (t) => {
  const f = await fixture(t),
    id = identity();
  await f.install("fixture.gateway", replying("gateway"), ["/__fixture_gateway"]);
  const app = await startHeadlessServer(
    { ...f.options, ...id.options },
    { createIdentity: id.createIdentity, runtimePlugins: { directory: f.store } },
  );
  t.after(() => app.close());
  const member = { "x-fixture-proof": "member" };
  const served = await fetch(app.url + "/__fixture_gateway", { headers: member });
  assert.equal(served.status, 200);
  assert.deepEqual(await served.json(), { plugin: "gateway", hostApi: 1 });
  assert.equal(served.headers.get("content-type"), "application/json");
  // The core pipeline rejects before plugin code; the plugin host would reject the same way.
  assert.equal((await fetch(app.url + "/__fixture_gateway")).status, 401);
  assert.equal(
    (await fetch(app.url + "/__fixture_gateway", { headers: { "x-fixture-proof": "outsider" } })).status,
    403,
  );
  const post = await fetch(app.url + "/__fixture_gateway", { method: "POST", headers: member });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  const health = await (await fetch(app.url + "/__opencraft_health")).json();
  assert.deepEqual(health.plugins["opencraft.runtime-plugins"], {
    role: "gateway",
    selected: [{ id: "fixture.gateway", version: "1.0.0" }],
    skipped: [],
  });
});

test("core, product-protected and duplicate routes are rejected without stopping healthy plugins", async (t) => {
  const f = await fixture(t),
    id = identity();
  await f.install("fixture.first", replying("first"), ["/__fixture_shared"]);
  await f.install("fixture.duplicate", replying("duplicate"), ["/__fixture_shared"]);
  // Not in the store's reserved set; the Headless composition still owns it.
  await f.install("fixture.core", replying("core"), ["/__opencraft_ssh_servers"]);
  await f.install("fixture.product", replying("product"), ["/__product_session/state"]);
  const app = await startHeadlessServer(
    { ...f.options, ...id.options },
    {
      createIdentity: id.createIdentity,
      runtimePlugins: { directory: f.store, protectedPaths: ["/__product_session"] },
    },
  );
  t.after(() => app.close());
  const headers = { "x-fixture-proof": "member" };
  assert.deepEqual((await (await fetch(app.url + "/__fixture_shared", { headers })).json()).plugin, "first");
  const core = await fetch(app.url + "/__opencraft_ssh_servers", { headers });
  assert.equal(core.status, 200);
  assert.deepEqual(await core.json(), []);
  await notServedByPlugin(
    await fetch(app.url + "/__product_session/state", { headers }),
    "a protected route never reaches plugin code",
  );
  const health = (await (await fetch(app.url + "/__opencraft_health")).json()).plugins["opencraft.runtime-plugins"];
  assert.deepEqual(
    health.selected.map((plugin) => plugin.id),
    ["fixture.first"],
  );
  assert.deepEqual(health.skipped.map((row) => [row.id, row.reason]).sort(), [
    ["fixture.core", "verification_failed"],
    ["fixture.duplicate", "activation_or_runtime_failed"],
    ["fixture.product", "verification_failed"],
  ]);
});

test("a failing plugin, missing admission or unreadable selection never prevents server startup", async (t) => {
  const f = await fixture(t),
    id = identity();
  await f.install("fixture.broken", 'export async function activate(){throw Error("synthetic activation failure")}', [
    "/__fixture_broken",
  ]);
  await f.install("fixture.healthy", replying("healthy"), ["/__fixture_healthy"]);
  const app = await startHeadlessServer(
    { ...f.options, ...id.options },
    { createIdentity: id.createIdentity, runtimePlugins: { directory: f.store } },
  );
  t.after(() => app.close());
  const headers = { "x-fixture-proof": "member" };
  assert.equal((await (await fetch(app.url + "/__fixture_healthy", { headers })).json()).plugin, "healthy");
  await notServedByPlugin(
    await fetch(app.url + "/__fixture_broken", { headers }),
    "a failed plugin route is unmounted",
  );
  assert.deepEqual(
    (await (await fetch(app.url + "/__opencraft_health")).json()).plugins["opencraft.runtime-plugins"].skipped,
    [{ id: "fixture.broken", reason: "activation_or_runtime_failed" }],
  );
  await app.close();
  // Without instance admission nothing is loaded, so no route can bypass authorization.
  const anonymous = await startHeadlessServer(f.options, { runtimePlugins: { directory: f.store } });
  try {
    await notServedByPlugin(
      await fetch(anonymous.url + "/__fixture_healthy"),
      "no plugin loads without instance admission",
    );
    assert.deepEqual(
      (await (await fetch(anonymous.url + "/__opencraft_health")).json()).plugins["opencraft.runtime-plugins"],
      { role: "gateway", selected: [], skipped: [{ reason: "admission_unavailable" }] },
    );
  } finally {
    await anonymous.close();
  }
  const corrupt = join(f.root, "corrupt-selections");
  await mkdir(corrupt, { mode: 0o750 });
  await writeFile(join(corrupt, "installed.json"), '{"schemaVersion":1,"plugins":', { mode: 0o640 });
  const unreadable = await startHeadlessServer(
    { ...f.options, ...id.options },
    { createIdentity: id.createIdentity, runtimePlugins: { directory: corrupt } },
  );
  try {
    assert.deepEqual(
      (await (await fetch(unreadable.url + "/__opencraft_health")).json()).plugins["opencraft.runtime-plugins"].skipped,
      [{ reason: "catalogue_unavailable" }],
    );
  } finally {
    await unreadable.close();
  }
  await assert.rejects(
    startHeadlessServer(f.options, { runtimePlugins: { directory: "relative" } }),
    /runtime plugin configuration/,
  );
  await assert.rejects(
    startHeadlessServer(f.options, { runtimePlugins: { directory: f.store, unknown: true } }),
    /runtime plugin configuration/,
  );
});

test("absent configuration keeps the existing pipeline without plugin health", async (t) => {
  const f = await fixture(t),
    id = identity();
  await f.install("fixture.unused", replying("unused"), ["/__fixture_unused"]);
  const app = await startHeadlessServer({ ...f.options, ...id.options }, { createIdentity: id.createIdentity });
  t.after(() => app.close());
  await notServedByPlugin(
    await fetch(app.url + "/__fixture_unused", { headers: { "x-fixture-proof": "member" } }),
    "an enabled selection stays inert without the option",
  );
  assert.equal(
    (await (await fetch(app.url + "/__opencraft_health")).json()).plugins?.["opencraft.runtime-plugins"],
    undefined,
  );
});

test("shutdown drains accepted plugin requests and closes plugins before identity and composition owners", async (t) => {
  const f = await fixture(t),
    events = [],
    id = identity(events);
  let release;
  globalThis.__headlessRuntimePluginFixture = {
    events,
    held: new Promise((resolve) => {
      release = resolve;
    }),
  };
  t.after(() => {
    delete globalThis.__headlessRuntimePluginFixture;
  });
  await f.install(
    "fixture.lifecycle",
    `export async function activate(){const f=globalThis.__headlessRuntimePluginFixture;f.events.push('plugin-activate');
    return {async handle(_q,r){f.events.push('request-start');await f.held;f.events.push('request-end');r.end('done');},close(){f.events.push('plugin-close');}};}`,
    ["/__fixture_lifecycle"],
  );
  const app = await startHeadlessServer(
    { ...f.options, ...id.options },
    {
      createIdentity: id.createIdentity,
      close: () => {
        events.push("composition-close");
      },
      runtimePlugins: { directory: f.store },
    },
  );
  t.after(() => {
    release();
    return app.close();
  });
  const pending = fetch(app.url + "/__fixture_lifecycle", { headers: { "x-fixture-proof": "member" } });
  while (!events.includes("request-start")) await new Promise((resolve) => setTimeout(resolve, 5));
  const closed = app.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!events.includes("plugin-close"), "an accepted request finishes before its plugin closes");
  release();
  assert.equal(await (await pending).text(), "done");
  await closed;
  assert.deepEqual(events, [
    "plugin-activate",
    "request-start",
    "request-end",
    "plugin-close",
    "identity-close",
    "composition-close",
  ]);
});
