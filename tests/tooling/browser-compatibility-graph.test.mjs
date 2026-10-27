import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { checkBrowserCompatibility } from "../../scripts/browser-compatibility-checker.mjs";
import { browserCompatibility, browserSourcePath } from "../../apps/workbench-web/browser-compatibility.vite.ts";

for (const paths of [path.posix, path.win32]) {
  test(`browser graph excludes dependencies, declarations and non-runtime modules (${paths.sep})`, () => {
    const root = paths.resolve("workspace");
    const file = name => paths.join(root, name);
    assert.equal(browserSourcePath(root, file("packages/chat/src/view.tsx"), paths), "packages/chat/src/view.tsx");
    assert.equal(browserSourcePath(root, paths.resolve(root, "../product/entry.ts"), paths), "../product/entry.ts");
    assert.equal(browserSourcePath(root, file("src/entry.mts"), paths), "src/entry.mts");
    assert.equal(browserSourcePath(root, file("types.d.mts"), paths), null);
    assert.equal(browserSourcePath(root, paths.resolve(root, "../product/node_modules/vendor/index.js"), paths), null);
    for (const id of [file("node_modules/vendor/index.js"), file("types.d.ts"), file("style.css"), "node:fs", "\0virtual"]) {
      assert.equal(browserSourcePath(root, id, paths), null, id);
    }
  });
}
test("a real build includes lazy runtime modules but excludes type-only server imports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencraft-browser-graph-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/main.ts"), 'import type { Server } from "./server"; globalThis.load = () => import("./lazy");');
    await writeFile(path.join(root, "src/server.ts"), 'export interface Server { id: string }; Promise.withResolvers();');
    await writeFile(path.join(root, "src/lazy.ts"), 'export const data = new Map().values().map(x => x);');
    await build({ root, configFile: false, logLevel: "silent", plugins: [browserCompatibility(root)],
      build: { write: false, minify: false, rollupOptions: { input: path.join(root, "src/main.ts") } } });
    const files = JSON.parse(await readFile(path.join(root, "node_modules/.cache/opencraft/browser-modules.json"), "utf8"));
    assert.deepEqual(files, ["apps/workbench-web/public/opencraft-host-proxy-sw.js", "src/lazy.ts", "src/main.ts"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("real product graph and CLI retain typed checks outside the core workspace", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-external-product-"));
  const core = fileURLToPath(new URL("../../", import.meta.url));
  const root = path.join(temporary, "core");
  const product = path.join(temporary, "external product");
  const run = promisify(execFile);
  try {
    await mkdir(root);
    await mkdir(product);
    await writeFile(path.join(root, "main.ts"), `import { load } from "../external product/entry.ts"; globalThis.loadProduct = load;`);
    await writeFile(path.join(product, "entry.ts"), `import type { Server } from "./server.ts"; export const load = () => import("./lazy.mts");`);
    await writeFile(path.join(product, "server.ts"), `import "node:fs"; export interface Server { id: string }; Promise.withResolvers(); AbortSignal.any([new AbortController().signal]);`);
    await writeFile(path.join(product, "tsconfig.json"), JSON.stringify({ compilerOptions: { lib: ["ES2022"] } }));
    await writeFile(path.join(product, "lazy.mts"), `import { value } from "./view.tsx"; export function values(tabs: Map<string, number>) { return tabs.values().map(x => x + value); } export function employeeRequest(request: AbortController) { return AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]); }`);
    await writeFile(path.join(product, "view.tsx"), `import { value } from "./plain.js"; export { value }; export const View = (input: number) => input;`);
    await writeFile(path.join(product, "plain.js"), `export const value = Promise.withResolvers();`);
    await build({ root, configFile: false, logLevel: "silent", plugins: [browserCompatibility(root)],
      build: { write: false, minify: false, rollupOptions: { input: path.join(root, "main.ts") } } });
    const captured = JSON.parse(await readFile(path.join(root, "node_modules/.cache/opencraft/browser-modules.json"), "utf8"));
    assert.deepEqual(captured, ["../external product/entry.ts", "../external product/lazy.mts", "../external product/plain.js", "../external product/view.tsx", "apps/workbench-web/public/opencraft-host-proxy-sw.js", "main.ts"]);
    assert.ok(!captured.some(file => file.endsWith("server.ts")), "the type-only server module must stay outside the browser graph");
    const graph = path.join(temporary, "graph.json");
    const files = captured.map(file => file.startsWith("apps/") ? file : path.relative(core, path.resolve(root, file)).split(path.sep).join("/"));
    await writeFile(graph, JSON.stringify(files));
    const command = [path.join(core, "scripts/check-browser-compatibility.mjs"), graph];
    await assert.rejects(run(process.execPath, command, { cwd: core }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /es-x\/no-iterator-prototype-map/);
      assert.match(error.stdout, /es-x\/no-promise-withresolvers/);
      assert.match(error.stdout, /no-restricted-properties/);
      assert.match(error.stdout, /AbortSignal\.any/u);
      assert.doesNotMatch(error.stdout + error.stderr, /Parsing error|outside of the base path|File ignored|was not found|provided project/);
      return true;
    });
    await writeFile(path.join(product, "lazy.mts"), `import { value } from "./view.tsx"; export function values(tabs: Map<string, number>) { return Array.from(tabs.values(), x => x + value); } export function employeeRequest(request: AbortController) { return request.signal; }`);
    await writeFile(path.join(product, "plain.js"), `export const value = 1;`);
    const safe = await run(process.execPath, command, { cwd: core });
    assert.match(safe.stdout, /6 runtime source files, 0 issues/);
    assert.ok(!captured.includes("../external product/server.ts"), "the type-only server may use the same API without entering the browser runtime graph");
    // A lookalike downstream path does not inherit the core replay-clock exception.
    const lookalike = path.join(product, "plugins/bot-chat/src");
    await mkdir(lookalike, { recursive: true });
    const file = path.join(lookalike, "motion-replay.ts");
    await writeFile(file, "window.scheduler.postTask(() => {});");
    await writeFile(graph, JSON.stringify([path.relative(core, file).split(path.sep).join("/")]));
    await assert.rejects(run(process.execPath, command, { cwd: core }), error => {
      assert.match(error.stdout, /compat\/compat/);
      assert.doesNotMatch(error.stdout + error.stderr, /Parsing error|File ignored/);
      return true;
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test("external runtime files retain core ambient browser declarations", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-browser-ambient-"));
  const root = path.join(temporary, "core");
  try {
    await mkdir(path.join(root, "config"), { recursive: true });
    await writeFile(path.join(root, "config/tsconfig.browser-compatibility.json"), JSON.stringify({
      compilerOptions: { lib: ["ESNext", "DOM"], strict: true, noEmit: true }, include: ["../browser.d.ts"],
    }));
    await writeFile(path.join(root, "browser.d.ts"), "declare const browserOnlyMap: Map<string, number>;");
    await writeFile(path.join(temporary, "product.ts"), "browserOnlyMap.values().map(x => x);");
    const unsafe = await checkBrowserCompatibility(root, ["../product.ts"]);
    assert.deepEqual(unsafe.results[0].messages.map(message => message.ruleId), ["es-x/no-iterator-prototype-map"]);
    await writeFile(path.join(temporary, "product.ts"), "Array.from(browserOnlyMap.values(), x => x);");
    assert.deepEqual((await checkBrowserCompatibility(root, ["../product.ts"])).results[0].messages, []);
    for (const graph of [[], null, ["../node_modules/dependency.ts"], ["../x/../product.ts"], ["browser.d.ts"], ["../product.ts?raw"], [123]]) {
      await assert.rejects(checkBrowserCompatibility(root, graph), /Invalid browser module graph/);
    }
    await assert.rejects(checkBrowserCompatibility(root, ["../missing.ts"]), /No files matching/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test("a symlinked workspace root records canonical modules as workspace-owned", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "opencraft-browser-root-alias-"));
  const root = path.join(temporary, "core"), alias = path.join(temporary, "alias");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "main.ts"), "globalThis.fixtureValue = 1;");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    await build({ root: alias, configFile: false, logLevel: "silent", plugins: [browserCompatibility(alias)],
      build: { write: false, minify: false, rollupOptions: { input: path.join(alias, "main.ts") } } });
    const files = JSON.parse(await readFile(path.join(root, "node_modules/.cache/opencraft/browser-modules.json"), "utf8"));
    assert.deepEqual(files, ["apps/workbench-web/public/opencraft-host-proxy-sw.js", "main.ts"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
