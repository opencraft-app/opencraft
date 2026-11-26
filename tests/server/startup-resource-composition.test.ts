import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync, brotliDecompressSync } from "node:zlib";
import { build } from "vite";
import { gzipAsset, startupResources } from "../../apps/workbench-web/startup-resources.vite";

test("bounded gzip precompression preserves bytes and never grows the former encoding", () => {
  const corpus = [Buffer.alloc(0), Buffer.from("small asset"),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => `export const item${i} = "${i % 71}:shared-content";\n`).join("")),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => `.item-${i}{color:var(--text-${i % 13});padding:0 ${i % 17}px}\n`).join(""))];
  for (const raw of corpus) {
    const encoded = gzipAsset(raw);
    assert.deepEqual(gunzipSync(encoded), raw);
    assert.deepEqual(gzipAsset(raw), encoded, "same input yields the same sidecar");
    assert.equal(encoded.length, Math.min(...[3, 4, 5, 6, 7, 8, 9].map(memLevel => gzipSync(raw, { level: 9, memLevel }).length)));
    assert.ok(encoded.length <= gzipSync(raw, { level: 9 }).length);
  }
});

test("startup gzip accounting equals the emitted lossless sidecars", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-startup-encoding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "main.ts"), `globalThis.payload = ${JSON.stringify("preserve the original runtime bytes; ".repeat(1024))};`);
  await build({ root, configFile: false, logLevel: "silent", plugins: [startupResources()],
    build: { outDir: join(root, "dist"), minify: false, rollupOptions: { input: join(root, "main.ts") } } });
  const report = JSON.parse(await readFile(join(root, ".startup/dist/resources.json"), "utf8"));
  let total = 0, sidecars = 0;
  for (const file of report.critical) {
    const raw = await readFile(join(root, "dist", file));
    if (raw.length < 1024 || gzipAsset(raw).length >= raw.length) { total += raw.length; continue; }
    const encoded = await readFile(join(root, "dist", file + ".gz"));
    assert.deepEqual(gunzipSync(encoded), raw);
    assert.deepEqual(encoded, gzipAsset(raw));
    assert.deepEqual(brotliDecompressSync(await readFile(join(root, "dist", file + ".br"))), raw);
    total += encoded.length; sidecars++;
  }
  assert.ok(sidecars > 0);
  assert.equal(report.totals.gzip, total, "gate uses emitted bytes, not a discounted estimate");
});

test("trusted composition adds a deferred provider root and gates its static closure", async t => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-startup-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "sample-provider/settings"), { recursive: true });
  await writeFile(join(root, "main.ts"), "globalThis.loadProvider = () => import('./sample-provider/runtime-entry');");
  await writeFile(join(root, "sample-provider/runtime-entry.ts"), "export { text } from './settings/view';");
  await writeFile(join(root, "sample-provider/settings/view.ts"), "export const text = 'Provider settings';");
  const run = (output: string, policy = {}) => build({
    root, configFile: false, logLevel: "silent", plugins: [startupResources(policy)],
    build: { outDir: join(root, output), minify: false, rollupOptions: { input: join(root, "main.ts") } },
  });
  const report = async (output: string) => JSON.parse(await readFile(join(root, ".startup", output, "resources.json"), "utf8"));
  await run("public");
  const plain = await report("public");
  assert.equal(plain.roots.length, 1);
  const requiredModules = [/\/sample-provider\/runtime-entry\.ts$/];
  await run("product", { requiredModules });
  const product = await report("product");
  assert.equal(product.roots.length, 2);
  assert.ok(product.totals.javascript > plain.totals.javascript);
  await assert.rejects(run("rejected", {
    requiredModules, demandOnlyModules: [/\/sample-provider\/settings\//],
  }), /Demand-only startup module/);
});

test("startup leaf consolidation excludes optional implementations and recursive dependencies", async () => {
  const { startupLeafGroups } = await import("../../apps/workbench-web/startup-leaf-groups.vite");
  const matches = (path: string) => startupLeafGroups.some(group => group.test.test("/fixture/node_modules/" + path));
  for (const path of ["framer-motion/dist/es/context/PresenceContext.mjs",
    "framer-motion/dist/es/utils/reduced-motion/use-reduced-motion.mjs", "aria-hidden/dist/es2015/index.js",
    "react-use-event-hook/dist/esm/useEvent.js", "tslib/tslib.es6.mjs", "w3c-keyname/index.js"]) assert.ok(matches(path), path);
  for (const path of ["framer-motion/dist/es/index.mjs", "motion-dom/dist/es/animation/animate.mjs",
    "react-dom/server.browser.js", "mermaid/dist/mermaid.js"]) assert.equal(matches(path), false, path);
  assert.ok(startupLeafGroups.every(group => group.includeDependenciesRecursively === false));
  assert.ok(startupLeafGroups.some(group => group.test.test("/fixture/apps/workbench-web/src/runtime/mobile-container.ts")));
  assert.equal(startupLeafGroups.some(group => group.test.test("/fixture/apps/workbench-web/src/components/conversation-search-dialog.tsx")), false);
  assert.equal(startupLeafGroups.some(group => group.test.test("/fixture/apps/workbench-web/src/runtime/conversation-content-search.ts")), false);
});
