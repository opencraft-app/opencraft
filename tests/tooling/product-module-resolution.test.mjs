import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { isBareModuleSpecifier, isExternalWorkspaceSource } from "../../scripts/workspace-dependencies.mjs";
import { workspaceDependencies } from "../../apps/workbench-web/workspace-dependencies.vite.ts";
import { buildHeadlessBundle } from "../../scripts/package-headless-linux.mjs";
import { packageRelay } from "../../scripts/package-relay.mjs";
import { packageWebServer } from "../../scripts/package-web-server.mjs";
import { checkBrowserCompatibility } from "../../scripts/browser-compatibility-checker.mjs";

const core = fileURLToPath(new URL("../../", import.meta.url));
test("fallback only applies to bare dependencies of external filesystem sources", () => {
  for (const source of ["react", "react/jsx-runtime", "@opencraft/browser-core"]) assert.equal(isBareModuleSpecifier(source), true);
  for (const source of ["", "./local", "../parent", "/absolute", "#internal", "\0virtual", "node:fs", "https://example.test/module", "C:\\source"]) assert.equal(isBareModuleSpecifier(source), false);
  assert.equal(isExternalWorkspaceSource(core, path.join(core, "apps/entry.ts")), false);
  assert.equal(isExternalWorkspaceSource(core, path.resolve(core, "../product/entry.ts") + "?query"), true);
  assert.equal(isExternalWorkspaceSource(core, "\0virtual"), false);
});

test("external source retains the type returned by an imported public core API", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-product-types-"));
  try {
    const file = path.join(temporary, "entry.ts");
    const graph = [path.relative(core, file).split(path.sep).join("/")];
    await writeFile(file, 'import { createBrowserHistory } from "@opencraft/browser-core"; export const values = createBrowserHistory().entries.values().map(x => x.title);');
    const unsafe = await checkBrowserCompatibility(core, graph);
    assert.deepEqual(unsafe.results[0].messages.map(message => message.ruleId), ["es-x/no-iterator-prototype-map"]);
    await writeFile(file, 'import { createBrowserHistory } from "@opencraft/browser-core"; export const values = Array.from(createBrowserHistory().entries.values(), x => x.title);');
    assert.deepEqual((await checkBrowserCompatibility(core, graph)).results[0].messages, []);
    await writeFile(file, 'import { values } from "missing-product-dependency-for-test"; values().map(x => x);');
    await assert.rejects(checkBrowserCompatibility(core, graph), /Browser module type resolution failed:[\s\S]*TS2307/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test("real browser, Headless and Relay builds resolve public core exports and prefer product-owned dependencies", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-product-modules-"));
  const local = path.join(core, ".local", path.basename(temporary));
  const packageName = "opencraft-test-" + path.basename(temporary).toLowerCase();
  const hostPackage = path.join(core, "node_modules", packageName);
  try {
    await mkdir(local, { recursive: true });
    const productPackage = path.join(temporary, "node_modules", packageName);
    for (const [directory, value] of [[hostPackage, "host"], [productPackage, "product"]]) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: packageName, type: "module", exports: "./index.js" }));
      await writeFile(path.join(directory, "index.js"), `export const value = ${JSON.stringify(value)};`);
    }
    // Existing React dedupe must still choose the renderer's copy.
    const fakeReact = path.join(temporary, "node_modules/react");
    await mkdir(fakeReact);
    await writeFile(path.join(fakeReact, "package.json"), JSON.stringify({ name: "react", type: "module", exports: "./index.js" }));
    await writeFile(path.join(fakeReact, "index.js"), "export const createElement = () => ({ fake: true });");
    const external = path.join(temporary, "product.tsx");
    await writeFile(external, `import { createElement } from "react";
      import { createBrowserHistory } from "@opencraft/browser-core";
      import { value } from ${JSON.stringify(packageName)};
      export { createElement }; export const result = { size: createBrowserHistory().entries.length, value, node: <span/> };`);
    const entry = path.join(local, "entry.ts");
    await writeFile(entry, `import { createElement } from "react"; import { createElement as productReact, result } from ${JSON.stringify(external)};
      export const verified = { ...result, sameReact: productReact === createElement };`);
    const browser = await build({ root: core, configFile: false, logLevel: "silent",
      plugins: [workspaceDependencies(core)], resolve: { dedupe: ["react", "react-dom"] },
      build: { write: false, minify: false, lib: { entry, formats: ["es"] } },
    });
    const js = (Array.isArray(browser) ? browser : [browser]).flatMap(result => result.output).filter(item => item.type === "chunk");
    assert.equal(js.length, 1);
    const module = await import("data:text/javascript;base64," + Buffer.from(js[0].code).toString("base64"));
    assert.equal(module.verified.sameReact, true);
    assert.equal(module.verified.size, 0);
    assert.equal(module.verified.value, "product");
    assert.equal(module.verified.node.type, "span");
    assert.equal(module.verified.node.fake, undefined);
    const nodeEntry = path.join(temporary, "entry.mjs");
    await writeFile(nodeEntry, `import {createBrowserHistory} from "@opencraft/browser-core";
      import {readFileSync} from "node:fs"; import {value} from ${JSON.stringify(packageName)};
      export const result = { size: createBrowserHistory().entries.length, value, node: typeof readFileSync };`);
    const bundle = path.join(temporary, "out.mjs");
    await buildHeadlessBundle(bundle, { headlessEntry: nodeEntry });
    assert.deepEqual((await import(pathToFileURL(bundle).href)).result, { size: 0, value: "product", node: "function" });
    const relay = await packageRelay({ output: path.join(temporary, "relay"), relayEntry: nodeEntry });
    assert.deepEqual((await import(pathToFileURL(path.join(relay.output, "relay.mjs")).href)).result,
      { size: 0, value: "product", node: "function" });
    const webRoot = path.join(temporary, "web");
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><html><head></head><body></body></html>");
    await writeFile(path.join(webRoot, "version.json"), JSON.stringify({ schemaVersion: 1, buildId: "external-product-fixture",
      headlessServer: true, headlessHostId: "opencraft-server" }));
    const managed = await packageWebServer({ version: "0.1.0-test", webRoot, output: path.join(temporary, "managed"),
      execution: true, executionProfile: "headless", splitResources: false,
      relayEntry: nodeEntry, headlessGatewayEntry: nodeEntry });
    for (const relative of ["runtime/relay.mjs", "execution/gateway.mjs"]) {
      assert.deepEqual((await import(pathToFileURL(path.join(managed.packageRoot, relative)).href)).result,
        { size: 0, value: "product", node: "function" });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(local, { recursive: true, force: true });
    await rm(hostPackage, { recursive: true, force: true });
  }
});
