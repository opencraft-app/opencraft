import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  splitProductPluginPacks,
  prepareProductPluginPacks,
  openProductPluginAssets,
} from "../../scripts/web-deployment/product-plugin-packs.mjs";
import { createWorkbenchWebServer } from "../../scripts/workbench-web-server.mjs";
import { createWorkbenchWebServer as createHeadlessWebServer } from "../../scripts/serve-workbench-web.mjs";
import { startHeadlessServer } from "../../scripts/headless-server.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp("/tmp/product-plugin-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    cache: join(root, "cache"),
    async release(version, shared = "shared original") {
      const web = join(root, version, "web"),
        source = join(root, version, "runtime/product-plugins");
      const entry = `__opencraft_product_plugins/${version}/fixture.app/entry-hash.js`,
        manifest = `__opencraft_product_plugins/${version}/fixture.app/manifest.json`;
      const content = {
        "index.html": "<!doctype html><title>Core</title>",
        "assets/shared-hash.js": shared,
        [entry]: `export default '${version}'`,
        [manifest]: JSON.stringify({ schemaVersion: 1, id: "fixture.app", version, entry, css: [] }),
      };
      for (const [path, bytes] of Object.entries(content)) {
        await mkdir(dirname(join(web, path)), { recursive: true });
        await writeFile(join(web, path), bytes);
      }
      const files = Object.entries(content)
        .filter(([path]) => path !== "index.html")
        .map(([path, bytes]) => ({ path, sha256: sha(bytes), bytes: Buffer.byteLength(bytes) }));
      await writeFile(
        join(web, "product-plugins.json"),
        JSON.stringify({
          schemaVersion: 1,
          packages: [{ id: "fixture.app", manifest, files, external: [entry, manifest] }],
        }),
      );
      return { web, source, entry, manifest, files };
    },
  };
}
test("split artifacts load from persistent code snapshots; old URLs survive a new release and restart", async (t) => {
  const f = await fixture(t),
    one = await f.release("one");
  await splitProductPluginPacks(one.web, one.source);
  await assert.rejects(access(join(one.web, one.entry)), { code: "ENOENT" });
  assert.equal(await readFile(join(one.web, "assets/shared-hash.js"), "utf8"), "shared original");
  await prepareProductPluginPacks({ sourceDirectory: one.source, cacheDirectory: f.cache, webRoot: one.web });
  const two = await f.release("two");
  await splitProductPluginPacks(two.web, two.source);
  await prepareProductPluginPacks({ sourceDirectory: two.source, cacheDirectory: f.cache, webRoot: two.web });
  await rm(join(f.root, "one"), { recursive: true });
  for (const createServer of [createWorkbenchWebServer, createHeadlessWebServer])
    for (let boot = 0; boot < 2; boot++) {
      const assets = await openProductPluginAssets(f.cache),
        server = await createServer({ root: two.web, appServerTarget: null, productPluginAssets: assets });
      const address = await server.listen({ host: "127.0.0.1", port: 0 }),
        base = `http://127.0.0.1:${address.port}`;
      try {
        assert.equal(await (await fetch(base + "/" + one.entry)).text(), "export default 'one'");
        assert.equal(await (await fetch(base + "/" + two.entry)).text(), "export default 'two'");
        assert.equal((await fetch(base + "/__opencraft_product_plugins/unknown")).status, 404);
        assert.equal(assets.has("../inventory.json"), false);
      } finally {
        await server.close();
      }
    }
});
test("Headless startup prepares its manifest-selected pack in persistent data and rejects a missing selected inventory", async (t) => {
  const f = await fixture(t),
    release = await f.release("headless"),
    root = dirname(release.web);
  const productPlugins = await splitProductPluginPacks(release.web, release.source);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ productPlugins }));
  await writeFile(
    join(release.web, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "fixture-headless",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  const options = {
    root,
    webRoot: release.web,
    dataDirectory: join(f.root, "data"),
    port: 0,
    startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:1/rpc", async close() {} }),
  };
  for (let boot = 0; boot < 2; boot++) {
    const app = await startHeadlessServer(options);
    try {
      const response = await fetch(app.url + "/" + release.entry);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "export default 'headless'");
    } finally {
      await app.close();
    }
  }
  assert.equal((await readdir(join(options.dataDirectory, "product-plugin-packs"))).length, 1);
  await rm(join(release.source, "inventory.json"));
  await assert.rejects(startHeadlessServer(options), /unavailable or changed/);
});
test("corrupt payload, missing shared dependency and incompatible URL reject before publication", async (t) => {
  const f = await fixture(t),
    one = await f.release("one");
  await splitProductPluginPacks(one.web, one.source);
  const options = { sourceDirectory: one.source, cacheDirectory: f.cache, webRoot: one.web };
  await writeFile(join(one.source, "public", one.entry), "corrupt");
  await assert.rejects(prepareProductPluginPacks(options), /integrity/);
  assert.equal((await readdir(f.cache)).length, 0);
  await writeFile(join(one.source, "public", one.entry), "export default 'one'");
  await rm(join(one.web, "assets/shared-hash.js"));
  await assert.rejects(prepareProductPluginPacks(options), { code: "ENOENT" });
  await writeFile(join(one.web, "assets/shared-hash.js"), "shared original");
  await prepareProductPluginPacks(options);
  const two = await f.release("two", "incompatible");
  await splitProductPluginPacks(two.web, two.source);
  await assert.rejects(
    prepareProductPluginPacks({ sourceDirectory: two.source, cacheDirectory: f.cache, webRoot: two.web }),
    /collision/,
  );
  assert.equal((await readdir(f.cache)).length, 1);
});
test("symlink escape and unlisted paths never enter a code snapshot", async (t) => {
  const f = await fixture(t),
    one = await f.release("one");
  const outside = join(f.root, "outside");
  await writeFile(outside, "export default 'one'");
  await rm(join(one.web, one.entry));
  await symlink(outside, join(one.web, one.entry));
  await assert.rejects(splitProductPluginPacks(one.web, one.source), /escaped/);
  await writeFile(
    join(one.web, "product-plugins.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        {
          id: "fixture.app",
          manifest: one.manifest,
          external: [one.manifest],
          files: [{ path: "../outside", sha256: sha(""), bytes: 0 }],
        },
      ],
    }),
  );
  await assert.rejects(splitProductPluginPacks(one.web, one.source), /Invalid/);
});
test("packaged Web worker prepares code using the existing controller environment, then survives restart", async (t) => {
  const f = await fixture(t),
    release = await f.release("worker");
  const productPlugins = await splitProductPluginPacks(release.web, release.source),
    packageRoot = dirname(release.web);
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@opencraft-app/opencraft",
      version: "0.1.0",
      opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: "fixture-worker", productPlugins },
    }),
  );
  await writeFile(join(release.web, "version.json"), JSON.stringify({ buildId: "fixture-worker" }));
  await writeFile(
    join(release.web, "index.html"),
    '<!doctype html><html><head><meta name="opencraft-build-id" content="fixture-worker"></head><body>Core</body></html>',
  );
  const entry = join(packageRoot, "runtime/worker.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../../scripts/web-deployment/worker.mjs", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["bufferutil", "utf-8-validate", "*.node"],
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
    },
    logLevel: "silent",
  });
  const persistent = join(f.root, "persistent-deployment");
  for (let boot = 0; boot < 2; boot++) {
    const child = fork(entry, [], {
      execArgv: [],
      env: {
        ...process.env,
        OPENCRAFT_RELEASE_ROOT: packageRoot,
        OPENCRAFT_USER_PLUGIN_DIRECTORY: join(persistent, "user-plugins"),
        OPENCRAFT_PRODUCT_PLUGIN_CACHE_DIRECTORY: "",
        OPENCRAFT_APPSERVER_URL: "",
        OPENCRAFT_CODEX_APPSERVER_URL: "",
        OPENCRAFT_HEADLESS_BACKEND_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr.on("data", (bytes) => {
      errors += bytes;
    });
    try {
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker readiness timeout: " + errors)), 10000);
        child.once("message", (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error("Worker exited " + code + ": " + errors));
        });
      });
      assert.equal(ready.buildId, "fixture-worker");
      const response = await fetch(`http://127.0.0.1:${ready.port}/${release.entry}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "export default 'worker'");
    } finally {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  assert.equal((await readdir(join(persistent, "product-plugin-packs"))).length, 1);
  await rm(join(release.source, "inventory.json"));
  await assert.rejects(
    prepareProductPluginPacks({
      sourceDirectory: release.source,
      cacheDirectory: f.cache,
      webRoot: release.web,
      expectedInventory: productPlugins.inventorySha256,
    }),
    /unavailable or changed/,
  );
});

test("exclusive CSS keeps verified precompression through split, cache preparation and old URL serving", async (t) => {
  const { gzipSync, brotliCompressSync } = await import("node:zlib");
  const f = await fixture(t),
    one = await f.release("compressed");
  const css = "assets/fixture-compressed.css",
    original = Buffer.from(".fixture { color: rebeccapurple; }\n".repeat(2000));
  await writeFile(join(one.web, css), original);
  const gz = gzipSync(original, { level: 9 }),
    br = brotliCompressSync(original);
  await writeFile(join(one.web, css + ".gz"), gz);
  await writeFile(join(one.web, css + ".br"), br);
  const inventory = JSON.parse(await readFile(join(one.web, "product-plugins.json")));
  inventory.packages[0].files.push({ path: css, sha256: sha(original), bytes: original.length });
  inventory.packages[0].external.push(css);
  await writeFile(join(one.web, "product-plugins.json"), JSON.stringify(inventory));
  await splitProductPluginPacks(one.web, one.source);
  const split = JSON.parse(await readFile(join(one.source, "inventory.json")));
  for (const suffix of [".gz", ".br"]) {
    const record = split.packages[0].files.find((file) => file.path === css + suffix);
    assert(record);
    assert(split.packages[0].external.includes(record.path));
    assert.equal(sha(await readFile(join(one.source, "public", record.path))), record.sha256);
    await assert.rejects(access(join(one.web, record.path)), { code: "ENOENT" });
  }
  await prepareProductPluginPacks({ sourceDirectory: one.source, cacheDirectory: f.cache, webRoot: one.web });
  const two = await f.release("later");
  await splitProductPluginPacks(two.web, two.source);
  await prepareProductPluginPacks({ sourceDirectory: two.source, cacheDirectory: f.cache, webRoot: two.web });
  for (const createServer of [createWorkbenchWebServer, createHeadlessWebServer]) {
    const server = await createServer({
      root: two.web,
      appServerTarget: null,
      productPluginAssets: await openProductPluginAssets(f.cache),
    });
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    try {
      for (const encoding of ["gzip", "br", "identity"]) {
        const response = await fetch("http://127.0.0.1:" + address.port + "/" + css, {
          headers: { "accept-encoding": encoding },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-encoding"), encoding === "identity" ? null : encoding);
        assert.equal(
          response.headers.get("content-length"),
          String(encoding === "gzip" ? gz.length : encoding === "br" ? br.length : original.length),
        );
        assert.match(response.headers.get("content-type"), /text\/css/);
        assert.match(response.headers.get("vary"), /Accept-Encoding/);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
      }
    } finally {
      await server.close();
    }
  }
});

test("corrupt or escaped compression files fail closed and missing sidecars remain supported", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const f = await fixture(t),
    bad = await f.release("bad-compression");
  await writeFile(join(bad.web, bad.entry + ".gz"), gzipSync(Buffer.from("x".repeat(200))));
  await assert.rejects(splitProductPluginPacks(bad.web, bad.source));
  const escaped = await f.release("escaped-compression"),
    outside = join(f.root, "outside.gz");
  await writeFile(outside, gzipSync(Buffer.from("x")));
  await symlink(outside, join(escaped.web, escaped.entry + ".gz"));
  await assert.rejects(splitProductPluginPacks(escaped.web, escaped.source), /escaped/);
  const plain = await f.release("no-compression");
  assert(await splitProductPluginPacks(plain.web, plain.source));
});

test("a sidecar shared by another pack remains with its original Web asset", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const f = await fixture(t),
    one = await f.release("shared-compression");
  const path = "assets/shared-style.css",
    raw = Buffer.from(".shared { color: blue; }".repeat(500));
  await writeFile(join(one.web, path), raw);
  await writeFile(join(one.web, path + ".gz"), gzipSync(raw));
  const inventory = JSON.parse(await readFile(join(one.web, "product-plugins.json"))),
    record = { path, bytes: raw.length, sha256: sha(raw) };
  inventory.packages[0].files.push(record);
  inventory.packages[0].external.push(path);
  const manifest = "__opencraft_product_plugins/shared-compression/other.app/manifest.json",
    data = "{}";
  await mkdir(dirname(join(one.web, manifest)), { recursive: true });
  await writeFile(join(one.web, manifest), data);
  inventory.packages.push({
    id: "other.app",
    manifest,
    files: [record, { path: manifest, bytes: 2, sha256: sha(data) }],
    external: [manifest],
  });
  await writeFile(join(one.web, "product-plugins.json"), JSON.stringify(inventory));
  await splitProductPluginPacks(one.web, one.source);
  assert.deepEqual(await readFile(join(one.web, path)), raw);
  await access(join(one.web, path + ".gz"));
  await prepareProductPluginPacks({ sourceDirectory: one.source, cacheDirectory: f.cache, webRoot: one.web });
});
