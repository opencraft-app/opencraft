import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { packageDigest } from "@opencraft/runtime-plugin-host/package-vfs";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import { SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { loadGatewayComposition } from "../../scripts/container-deployment/gateway-composition.mjs";
import { loadGatewayWebRelease, webReleaseFiles } from "../../scripts/container-deployment/gateway-web-release.mjs";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-application.mjs";

import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";

const run = promisify(execFile);
const script = (name) => fileURLToPath(new URL("../../scripts/container-deployment/" + name, import.meta.url));
const gateway = script("gateway.mjs");

async function fixture(t, api = 1, extra = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "composition-vfs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    "composition.mjs": `import { name } from "./sidecar/provider.mjs";
      export const gatewayCompositionApi = ${api};
      export function createGatewayComposition() {
        return { isHuman: principal => principal.provider === name };
      }`,
    "sidecar/provider.mjs": 'export const name = "test";',
    "worker/main.js": 'import { value } from "./sidecar.js"; export default { fetch: () => new Response(value) };',
    "worker/sidecar.js": 'export const value = "workerd composition";',
    ...extra,
  };
  await mkdir(join(directory, "sidecar"));
  await mkdir(join(directory, "worker"));
  if (Object.keys(files).some(name => name.startsWith("workbench/"))) await mkdir(join(directory, "workbench"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  const { stdout: manifest } = await run(process.execPath, [script("gateway-composition-manifest.mjs"), directory]);
  files["manifest.json"] = manifest;
  await writeFile(join(directory, "manifest.json"), manifest);
  const sha256 = await packageDigest(Buffer.from(manifest));
  return {
    directory,
    files,
    sha256,
    env: { OPENCRAFT_GATEWAY_COMPOSITION_DIRECTORY: directory, OPENCRAFT_GATEWAY_COMPOSITION_SHA256: sha256 },
  };
}

test("optional Gateway configuration loads a verified entry and relative sidecar", async (t) => {
  assert.equal(await loadGatewayComposition({}), undefined);
  const pack = await fixture(t);
  const loaded = await loadGatewayComposition(pack.env);
  try {
    assert.equal(loaded.composition.isHuman({ provider: "test" }), true);
    assert.equal(loaded.composition.isHuman({ provider: "other" }), false);
  } finally {
    await loaded.composition.close();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(process.execPath, ["--import", "tsx", gateway, "--check-gateway-composition"], {
      env: { ...process.env, ...pack.env },
    });
    assert.deepEqual(JSON.parse(result.stdout), { gatewayCompositionSha256: pack.sha256 });
  }
});

test("verified Gateway composition accepts the opt-in service ingress factory", async (t) => {
  const pack = await fixture(t, 1, {
    "composition.mjs": `export const gatewayCompositionApi = 1;
      export function createGatewayComposition() {
        return { createServiceIngress: ports => ports.conversation };
      }`,
  });
  const selected = await loadGatewayComposition(pack.env);
  t.after(() => selected.composition.close());
  const conversation = () => {};
  assert.equal(selected.composition.createServiceIngress({ conversation }), conversation);
  const invalid = await fixture(t, 1, {
    "composition.mjs": `export const gatewayCompositionApi = 1;
      export function createGatewayComposition() {
        return { createServiceIngress: {} };
      }`,
  });
  await assert.rejects(loadGatewayComposition(invalid.env), /Invalid Gateway composition property: createServiceIngress/u);
});

test("a locked VFS can add a Workbench Assets plugin without replacing Web or bypassing admission", async (t) => {
  const entry = "workbench/assets-plugin.mjs";
  const code = "export default { apiVersion: 1, create: () => ({}) };";
  const pack = await fixture(t, 1, { [entry]: code });
  const selected = await loadGatewayComposition(pack.env);
  t.after(() => selected.composition.close());
  const digest = await packageDigest(Buffer.from(code));
  assert.equal(selected.workbenchAssetsPlugin.sha256, digest);
  const root = await mkdtemp(join(tmpdir(), "workbench-assets-vfs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<!doctype html><html><head></head><body>Core shell</body></html>");
  const server = await createWorkbenchWebServer({
    root, appServerTarget: null, workbenchAssetsPlugin: selected.workbenchAssetsPlugin,
    identityService: {
      admissionStatus: request => request.headers["x-fixture-admitted"] ? 204 : 403,
      connectionContext: () => ({ sender: null }),
      async handle() { return false; },
    },
  });
  t.after(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const path = `/__opencraft_workbench_assets_plugin/${digest}.mjs`;
  const headers = { "x-fixture-admitted": "1" };
  assert.equal((await fetch(origin + path)).status, 403);
  const html = await (await fetch(origin + "/", { headers })).text();
  assert.match(html, /Core shell/u);
  assert.match(html, new RegExp(`"apiVersion":1,"sha256":"${digest}"`));
  const module = await fetch(origin + path, { headers });
  assert.equal(module.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await module.text(), code);
  assert.equal((await fetch(origin + path, { headers, method: "HEAD" })).status, 200);
  assert.equal((await fetch(origin + path, { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(origin + path + "?stale", { headers })).status, 404);
  assert.equal((await fetch(origin + "/__opencraft_workbench_assets_plugin/composition.mjs", { headers })).status, 404);
  await writeFile(join(pack.directory, entry), code.replace("apiVersion: 1", "apiVersion: 2"));
  await assert.rejects(loadGatewayComposition(pack.env), /VFS package SHA-256 mismatch/u);
});

test("configured Gateway refuses a missing digest, mismatched manifest or incompatible API", async (t) => {
  const pack = await fixture(t, 2);
  await assert.rejects(
    loadGatewayComposition({ OPENCRAFT_GATEWAY_COMPOSITION_DIRECTORY: pack.directory }),
    /directory and its manifest SHA-256/,
  );
  await assert.rejects(
    loadGatewayComposition({ ...pack.env, OPENCRAFT_GATEWAY_COMPOSITION_SHA256: "a".repeat(64) }),
    /SHA-256 mismatch: manifest.json/,
  );
  await assert.rejects(loadGatewayComposition(pack.env), /Incompatible Gateway composition API/);
  await assert.rejects(
    run(process.execPath, ["--import", "tsx", gateway], {
      env: { ...process.env, ...pack.env },
    }),
    /Incompatible Gateway composition API/,
  );
});

test("Gateway refuses changed or linked files listed by the verified manifest", async (t) => {
  const pack = await fixture(t);
  const sidecar = join(pack.directory, "sidecar/provider.mjs");
  await writeFile(sidecar, pack.files["sidecar/provider.mjs"].replace("test", "fail"));
  await assert.rejects(loadGatewayComposition(pack.env), /SHA-256 mismatch: sidecar\/provider.mjs/);
  await rm(sidecar);
  await symlink("../composition.mjs", sidecar);
  await assert.rejects(loadGatewayComposition(pack.env), { code: "ELOOP" });
});

test("Gateway preflight checks the independently pinned Web release", async (t) => {
  const pack = await fixture(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), "composition-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, "web");
  await mkdir(web);
  await writeFile(join(web, "index.html"), "<!doctype html><title>Product</title>");
  await writeFile(
    join(web, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "product-web",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const manifest = JSON.stringify({ schemaVersion: 1, files: await webReleaseFiles(root) });
  await writeFile(join(root, "manifest.json"), manifest);
  const env = {
    ...process.env,
    ...pack.env,
    OPENCRAFT_GATEWAY_WEB_RELEASE_DIRECTORY: root,
    OPENCRAFT_GATEWAY_WEB_RELEASE_SHA256: await packageDigest(Buffer.from(manifest)),
  };
  assert.equal((await loadGatewayWebRelease(env)).webRoot, web);
  const preflight = () => run(process.execPath, ["--import", "tsx", gateway, "--check-gateway-composition"], { env });
  await preflight();
  await writeFile(join(web, "index.html"), "<!doctype html><title>Changed</title>");
  await assert.rejects(preflight(), /Web release files differ from the manifest/);
});

test("Gateway preflight imports extensions and checks private migrations without opening the live database", async (t) => {
  const extensionEntry = `export const gatewayCompositionApi = 1;
    export const createGatewayComposition = () => ({
      extensions: { communication: { module: new URL("./extension.mjs", import.meta.url) } },
    });`;
  const missing = await fixture(t, 1, { "composition.mjs": extensionEntry });
  const broken = await fixture(t, 1, {
    "composition.mjs": extensionEntry,
    "extension.mjs": "export const other = true;",
  });
  const invalidSql = await fixture(t, 1, {
    "composition.mjs": `export const gatewayCompositionApi = 1;
    export const createGatewayComposition = () => ({ serverMigrations: { extensions: [{
      id: "fixture", objectPrefix: "fixture_",
      migrations: [{ version: 1, name: "out_of_scope", sql: "CREATE TABLE outside_scope (id INTEGER)" }],
    }] } });`,
  });
  const coreOverride = await fixture(t, 1, {
    "composition.mjs": `export const gatewayCompositionApi = 1;
    export const createGatewayComposition = () => ({ serverMigrations: { canonical: [] } });`,
  });
  for (const [pack, expected] of [
    [missing, /extension must be listed in the composition manifest/],
    [broken, /does not export communicationExtension/],
    [invalidSql, /not authorized|outside its ownership/],
    [coreOverride, /Invalid product Server migrations/],
  ]) {
    await assert.rejects(
      run(process.execPath, ["--import", "tsx", gateway, "--check-gateway-composition"], {
        env: { ...process.env, ...pack.env },
      }),
      expected,
    );
  }
});

test("Headless startup passes verified product migrations to its worker and keeps legacy rows", async (t) => {
  const migration = {
    version: 1,
    name: "fixture_settings",
    sql: "CREATE TABLE fixture_settings (id INTEGER PRIMARY KEY, value TEXT)",
  };
  const legacy = [...SERVER_MIGRATIONS, { ...migration, version: SERVER_MIGRATIONS.length + 1 }];
  const serverMigrations = {
    extensions: [{ id: "fixture", objectPrefix: "fixture_", migrations: [migration] }],
    lineages: [
      {
        id: "fixture-legacy",
        migrations: legacy,
        adopts: [
          ...SERVER_MIGRATIONS.map(({ version }) => [{ family: "core", version }]),
          [{ family: "fixture", version: 1 }],
        ],
      },
    ],
  };
  const pack = await fixture(t, 1, {
    "composition.mjs": `export const gatewayCompositionApi = 1;
    export const createGatewayComposition = () => ({ serverMigrations: ${JSON.stringify(serverMigrations)} });`,
  });
  const root = await mkdtemp(join(await realpath(tmpdir()), "composition-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = join(root, "data"),
    webRoot = join(root, "web");
  await mkdir(dataDirectory, { mode: 0o700 });
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Test</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "composition-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const path = join(dataDirectory, "opencraft-server.sqlite");
  const seeded = openManagedDatabase({ path, migrations: legacy, legacyPolicy: "reject" });
  seeded.database.exec("INSERT INTO fixture_settings VALUES (1, 'kept')");
  seeded.database.close();
  const selected = await loadGatewayComposition(pack.env);
  try {
    const app = await startHeadlessServer(
      {
        root,
        webRoot,
        dataDirectory,
        port: 0,
        startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
      },
      selected.composition,
    );
    await app.close();
  } finally {
    await selected.composition.close();
  }
  const migrated = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(migrated.prepare("SELECT value FROM fixture_settings WHERE id = 1").get().value, "kept");
    assert.equal(
      migrated.prepare("SELECT max(version) AS version FROM schema_migrations").get().version,
      SERVER_MIGRATIONS.length,
    );
    assert.equal(
      migrated.prepare("SELECT version FROM schema_extension_migrations WHERE family = 'fixture'").get().version,
      1,
    );
  } finally {
    migrated.close();
  }
});

test("a Durable Object loads a dynamic Worker through the same package VFS from R2 files", async (t) => {
  const pack = await fixture(t);
  const result = await build({
    stdin: {
      contents: `
        import { openPackageVfs } from "@opencraft/runtime-plugin-host/package-vfs";
        export class PackageReader {
          constructor(ctx, env) { this.env = env; }
          async fetch() {
            const sha256 = this.env.COMPOSITION_SHA256;
            try {
              const vfs = await openPackageVfs({
                sha256, readFile: async (path, maxBytes) => {
                  const object = await this.env.PACKAGES.get(path);
                  if (!object || object.size > maxBytes) throw Error("Package file unavailable");
                  return new Uint8Array(await object.arrayBuffer());
                },
              });
              const decoder = new TextDecoder("utf-8", { fatal: true });
              const modules = Object.fromEntries(vfs.listFiles()
                .filter(path => path.startsWith("worker/"))
                .map(path => [path, decoder.decode(vfs.readFile(path))]));
              const worker = this.env.LOADER.get(sha256, async () => ({
                compatibilityDate: "2026-07-30", mainModule: "worker/main.js", modules, globalOutbound: null,
              }));
              return await worker.getEntrypoint().fetch("https://package.test/");
            } catch (error) {
              return new Response(error.message, { status: 500 });
            }
          }
        }
        export default { fetch(request, env) {
          return env.READER.get(env.READER.idFromName("test")).fetch(request);
        } };
      `,
      resolveDir: import.meta.dirname,
    },
    bundle: true,
    platform: "neutral",
    format: "esm",
    write: false,
    metafile: true,
  });
  assert.deepEqual(
    Object.values(result.metafile.outputs).flatMap((output) => output.imports),
    [],
  );
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: result.outputFiles[0].text }],
    compatibilityDate: "2026-07-30",
    durableObjects: { READER: { className: "PackageReader", useSQLite: true } },
    r2Buckets: ["PACKAGES"],
    workerLoaders: { LOADER: {} },
    bindings: { COMPOSITION_SHA256: pack.sha256 },
  });
  t.after(() => miniflare.dispose());
  const bucket = await miniflare.getR2Bucket("PACKAGES");
  for (const [path, content] of Object.entries(pack.files)) await bucket.put(path, content);
  const good = await miniflare.dispatchFetch("https://fake.test/");
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "workerd composition");
  await bucket.put("manifest.json", pack.files["manifest.json"] + " ");
  const bad = await miniflare.dispatchFetch("https://fake.test/");
  assert.equal(bad.status, 500);
  assert.match(await bad.text(), /SHA-256 mismatch: manifest.json/);
});
