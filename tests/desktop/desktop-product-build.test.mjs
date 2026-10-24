import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { bundleDesktopHost, resolveDesktopProductEntries } from "../../apps/workbench-electron/build-host.mjs";

test("desktop product entries are an explicit local set, never silently dropped", async t => {
  const directory = await mkdtemp(join(tmpdir(), "desktop product ")); t.after(() => rm(directory, { recursive: true, force: true }));
  const main = join(directory, "main.ts"), preload = join(directory, "preload.ts"), identity = join(directory, "identity.ts");
  await writeFile(main, "export {};\n"); await writeFile(preload, "export {};\n"); await writeFile(identity, "export {};\n");
  const environment = { OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY: main, OPENCRAFT_DESKTOP_PRODUCT_PRELOAD_ENTRY: preload, OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_ENTRY: identity };
  assert.deepEqual(resolveDesktopProductEntries(environment), [main, preload, identity]);
  assert.throws(() => resolveDesktopProductEntries({ OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY: main }), /Main, Preload and Identity/);
  for (const invalid of ["https://example.invalid/main.ts", "data:text/javascript,", "missing.ts", directory]) {
    assert.throws(() => resolveDesktopProductEntries({ ...environment, OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY: invalid }), /OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY/);
  }
});

test("real desktop bundles exclude private accounts by default and package selected local entries", async t => {
  const directory = await mkdtemp(join(tmpdir(), "desktop composition ")); t.after(() => rm(directory, { recursive: true, force: true }));
  const plain = await bundleDesktopHost({ environment: {}, outdir: join(directory, "plain") });
  for (const result of [plain.main, plain.preload]) {
    const sourceRoots = ["apps/workbench-electron/src/", "packages/", "node_modules/"];
    const unexpectedInputs = Object.keys(result.metafile.inputs).filter(file =>
      file !== "scripts/serve-workbench-static.mjs" && !sourceRoots.some(root => file.startsWith(root)));
    assert.deepEqual(unexpectedInputs, [], "Standalone desktop bundles only its core owners and dependencies");
  }
  const loadPreload = async name => {
    const exports = {};
    const context = vm.createContext({ process: { platform: "linux", versions: { electron: "fixture" } },
      window: { addEventListener() {} },
      require(name) { assert.equal(name, "electron"); return {
        ipcRenderer: { invoke: async () => "fixture-identity" },
        contextBridge: { exposeInMainWorld(name, bridge) { exports[name] = bridge; } },
      }; },
    });
    vm.runInContext(await readFile(join(directory, name, "preload.cjs"), "utf8"), context);
    return exports.opencraftDesktop;
  };
  const publicBridge = await loadPreload("plain");
  assert.equal(publicBridge.kind, "electron"); assert.equal(publicBridge.exampleAccount, undefined);
  const main = join(directory, "product-main.ts"), preload = join(directory, "product-preload.ts"), identity = join(directory, "product-identity.ts");
  await writeFile(main, 'export const createDesktopProduct = api => { api.handle("example:identity", () => "fixture-identity"); return {receiveUrl:()=>null,cancelInteractions(){},dispose(){}}; };');
  await writeFile(preload, 'export const createDesktopPreload = port => ({exampleAccount:{read:()=>port.invoke("example:identity")}});');
  await writeFile(identity, 'export const resolveDesktopProduct = () => ({displayName:"Example",profileDirectoryName:"Example",legacyProfileDirectoryNames:[],applicationId:"example.desktop"});');
  const identityConfig = join(directory, "identity.json");
  await writeFile(identityConfig, JSON.stringify({ production: { displayName: "Example", applicationId: "example.desktop", speechHelperId: "example.desktop.speech" }, preview: { displayName: "Example Preview", applicationId: "example.desktop.preview" } }));
  const selected = await bundleDesktopHost({ environment: { OPENCRAFT_DESKTOP_PRODUCT_MAIN_ENTRY: main, OPENCRAFT_DESKTOP_PRODUCT_PRELOAD_ENTRY: preload, OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_ENTRY: identity, OPENCRAFT_DESKTOP_PRODUCT_IDENTITY_CONFIG: identityConfig }, outdir: join(directory, "product") });
  assert.ok(Object.keys(selected.main.metafile.inputs).some(file => resolve(file) === main));
  assert.ok(Object.keys(selected.main.metafile.inputs).some(file => resolve(file) === identity));
  assert.equal(JSON.parse(await readFile(join(directory, "product", "desktop-identity.json"), "utf8")).production.applicationId, "example.desktop");
  assert.ok(Object.keys(selected.preload.metafile.inputs).some(file => resolve(file) === preload));
  const productBridge = await loadPreload("product");
  assert.equal(productBridge.kind, "electron"); assert.equal(await productBridge.exampleAccount.read(), "fixture-identity");
  assert.deepEqual(Object.keys(productBridge).sort(), [...Object.keys(publicBridge), "exampleAccount"].sort());
});
