import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "vite";
import { startupResources } from "../../apps/workbench-web/startup-resources.vite";

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

test("startup owner consolidation excludes optional engines and recursive dependencies", async () => {
  const { startupLeafGroups } = await import("../../apps/workbench-web/startup-leaf-groups.vite");
  const matchesPath = (path: string) => startupLeafGroups.some(group => typeof group.test === "function" ? group.test(path) : group.test.test(path));
  const matches = (path: string) => matchesPath("/fixture/node_modules/" + path);
  for (const path of ["framer-motion/dist/es/context/PresenceContext.mjs",
    "framer-motion/dist/es/utils/reduced-motion/use-reduced-motion.mjs", "aria-hidden/dist/es2015/index.js",
    "react-use-event-hook/dist/esm/useEvent.js", "tslib/tslib.es6.mjs", "w3c-keyname/index.js",
    "framer-motion/dist/es/index.mjs", "motion-dom/dist/es/animation/animate.mjs"]) assert.ok(matches(path), path);
  for (const path of ["react-dom/server.browser.js", "mermaid/dist/mermaid.js", "@tanstack/react-virtual/dist/index.js",
    "@excalidraw/excalidraw/node_modules/@radix-ui/react-slot/dist/index.mjs"]) assert.equal(matches(path), false, path);
  assert.ok(startupLeafGroups.every(group => group.includeDependenciesRecursively === false));
  assert.ok(matchesPath("/fixture/apps/workbench-web/src/runtime/mobile-container.ts"));
  assert.equal(matchesPath("/fixture/apps/workbench-web/src/components/conversation-search-dialog.tsx"), false);
});
