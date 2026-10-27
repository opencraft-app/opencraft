import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { build, createServer, preview } from "vite";
import { productPublicAssets } from "../../apps/workbench-web/product-public-assets.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-product-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "app/public"), { recursive: true });
  await mkdir(path.join(root, "product/assets"), { recursive: true });
  await writeFile(path.join(root, "app/index.html"), "<!doctype html><title>Public client</title>");
  await writeFile(path.join(root, "app/public/core.txt"), "core public bytes");
  await writeFile(path.join(root, "product/assets/image.svg"), "<svg>original product bytes</svg>");
  await writeFile(path.join(root, "product/worker.js"), "self.fixture = 'original worker';");
  return root;
}

test("public builds exclude unselected product files; selected assets preserve bytes and copyPublicDir semantics", async t => {
  const root = await fixture(t);
  async function compile(selected, copyPublicDir = true) {
    return build({ root: path.join(root, "app"), configFile: false, logLevel: "silent", base: "/nested/",
      plugins: [productPublicAssets(root, selected)],
      build: { write: false, copyPublicDir, outDir: path.join(root, "dist") } });
  }
  assert.equal(productPublicAssets(root, undefined), null);
  let result = await compile(undefined);
  assert.ok(!result.output.some(file => file.fileName === "worker.js"));
  result = await compile("product");
  for (const name of ["assets/image.svg", "worker.js"]) {
    const asset = result.output.find(file => file.fileName === name);
    assert.ok(asset, name);
    assert.equal(asset.type, "asset");
    assert.deepEqual(Buffer.from(asset.source), await readFile(path.join(root, "product", name)));
  }
  result = await compile("product", false);
  assert.ok(!result.output.some(file => ["worker.js", "assets/image.svg"].includes(file.fileName)));
});

test("real dev server serves updated and newly generated product assets at its base without exposing adjacent files", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "outside.txt"), "outside must remain private");
  const server = await createServer({ root: path.join(root, "app"), configFile: false, logLevel: "silent",
    base: "/nested/", plugins: [productPublicAssets(root, "product")],
    server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { noDiscovery: true } });
  t.after(() => server.close());
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let response = await fetch(origin + "/nested/assets/image.svg?v=1");
  assert.match(response.headers.get("content-type"), /image\/svg\+xml/u);
  assert.equal(await response.text(), "<svg>original product bytes</svg>");
  await writeFile(path.join(root, "product/assets/image.svg"), "<svg>changed bytes</svg>");
  await writeFile(path.join(root, "product/new.json"), '{"generated":true}');
  assert.equal(await fetch(origin + "/nested/assets/image.svg").then(r => r.text()), "<svg>changed bytes</svg>");
  assert.deepEqual(await fetch(origin + "/nested/new.json").then(r => r.json()), { generated: true });
  response = await fetch(origin + "/nested/worker.js", { method: "HEAD" });
  assert.match(response.headers.get("content-type"), /javascript/u);
  assert.equal(await response.text(), "");
  assert.notEqual(await fetch(origin + "/nested/%2e%2e/outside.txt").then(r => r.text()), "outside must remain private");
  assert.equal(await fetch(origin + "/nested/core.txt").then(r => r.text()), "core public bytes");
});

test("real preview serves the fixed built assets instead of later product source changes", async t => {
  const root = await fixture(t);
  const config = { root: path.join(root, "app"), configFile: false, logLevel: "silent",
    base: "/nested/", plugins: [productPublicAssets(root, "product")],
    build: { outDir: path.join(root, "dist") } };
  await build(config);
  await writeFile(path.join(root, "product/worker.js"), "changed after packaging");
  const server = await preview({ ...config, preview: { host: "127.0.0.1", port: 0 } });
  t.after(() => new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const response = await fetch(origin + "/nested/worker.js");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "self.fixture = 'original worker';");
});

test("explicit missing, remote, colliding and symbolic-link product assets fail instead of silently replacing other owners", async t => {
  const root = await fixture(t);
  assert.throws(() => productPublicAssets(root, "missing"), /existing directory/u);
  assert.throws(() => productPublicAssets(root, "https://example.invalid/assets"), /local directory/u);
  await writeFile(path.join(root, "product/core.txt"), "overwriting core is forbidden");
  await assert.rejects(build({ root: path.join(root, "app"), configFile: false, logLevel: "silent",
    plugins: [productPublicAssets(root, "product")], build: { write: false } }), /conflicts with the core public directory/u);
  await rm(path.join(root, "product/core.txt"));
  await writeFile(path.join(root, "product/index.html"), "overwriting entry is forbidden");
  await assert.rejects(build({ root: path.join(root, "app"), configFile: false, logLevel: "silent",
    plugins: [productPublicAssets(root, "product")], build: { write: false } }), /conflicts with a build output/u);
  await rm(path.join(root, "product/index.html"));
  if (process.platform !== "win32") {
    await symlink(path.join(root, "app/index.html"), path.join(root, "product/linked.html"));
    await assert.rejects(build({ root: path.join(root, "app"), configFile: false, logLevel: "silent",
      plugins: [productPublicAssets(root, "product")], build: { write: false } }), /symbolic links/u);
  }
});
