import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionManager, ExtensionSupervisor, MemoryExtensionPersistence, createPersistentExtensionInstallations, provideExtensionInstallationRepository } from "@opencraft/extension-runtime";
import { IDBFactory } from "fake-indexeddb";
import { openIndexedDbExtensionPersistence } from "../apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts";
import { BrowserModuleUrlExtensionLoader } from "../apps/workbench-web/src/runtime/module-url-extension-loader.ts";

function moduleCode(version: string, fail = false) {
  return `export default { manifest: { manifestVersion:1, id:'example.pinned', name:'Pinned', version:'${version}', apiVersion:1, trust:'trusted', platforms:['web'], activationEvents:['onStartupFinished'] }, activate(api) { ${fail ? "throw Error('broken candidate');" : `api.commands.register({id:'example.pinned.run',title:'Run'}, ()=>'${version}');`} } };`;
}

test("pinned module survives offline restart and failed update retains its persisted bytes", async () => {
  const factory = new IDBFactory();
  let code = moduleCode("1.0.0");
  let offline = false;
  let downloads = 0;
  const loader = new BrowserModuleUrlExtensionLoader("https://app.test", Date.now, {
    fetch: async () => { downloads++; if (offline) throw Error("offline"); return new Response(code); },
    importArtifact: async source => import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`),
  });
  async function start() {
    const backend = await openIndexedDbExtensionPersistence("artifact-restart-test", factory);
    const persistence = await createPersistentExtensionInstallations(backend);
    const context = new Context();
    const fiber = context.plugin(provideExtensionInstallationRepository(persistence));
    await fiber;
    const supervisor = new ExtensionSupervisor({ platform: "web" });
    const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, loader });
    return { manager, supervisor, repository: context.extensionInstallations, async close() { await manager.dispose(); await supervisor.dispose(); await fiber.dispose(); await backend.close(); } };
  }
  const first = await start();
  await first.manager.installModuleUrl("https://plugins.test/pinned.mjs");
  const saved = first.repository.getSnapshot().records[0]!;
  assert.ok(saved.artifact?.sha256);
  code = moduleCode("2.0.0", true);
  await assert.rejects(first.manager.reload("example.pinned"), /broken candidate/);
  assert.deepEqual(first.repository.getSnapshot().records[0], saved);
  await first.close();
  offline = true;
  const before = downloads;
  const second = await start();
  try {
    await second.manager.restore();
    assert.equal(downloads, before);
    assert.equal(await second.supervisor.contributions.executeCommand("example.pinned.run"), "1.0.0");
    const damaged = { ...saved.artifact!, code: moduleCode("9.0.0") };
    await assert.rejects(loader.load(saved.source, { artifact: damaged }), /integrity/);
    offline = false;
    code = moduleCode("2.0.0");
    await second.manager.reload("example.pinned");
    assert.equal(await second.supervisor.contributions.executeCommand("example.pinned.run"), "2.0.0");
    assert.notEqual(second.repository.getSnapshot().records[0]!.artifact!.sha256, saved.artifact!.sha256);
  } finally { await second.close(); }
});

test("pinned modules reject external code dependencies before evaluating", async () => {
  for (const code of ["import './other.js';", "export * from './other.js';", "const f=()=>import('https://other.test/module');", "const url=import.meta.url;"]) {
    let executed = false;
    const loader = new BrowserModuleUrlExtensionLoader("https://app.test", Date.now, {
      fetch: async () => new Response(code),
      importArtifact: async () => { executed = true; return {}; },
    });
    await assert.rejects(loader.load({ kind: "module-url", url: "https://plugins.test/module" }), /bundle its dependencies/);
    assert.equal(executed, false);
  }
});

test("a missing artifact fails only its installation without downloading a replacement", async () => {
  const backend = new MemoryExtensionPersistence();
  const manifest = (id: string) => ({ manifestVersion: 1 as const, id, name: id, version: "1.0.0", apiVersion: 1,
    trust: "trusted" as const, platforms: ["web" as const], activationEvents: ["onStartupFinished" as const] });
  const persistence = await createPersistentExtensionInstallations(backend);
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(persistence));
  await fiber;
  for (const id of ["example.missing", "example.good"]) await context.extensionInstallations.put({
    extensionId: id, enabled: true, source: { kind: "module-url", url: `https://plugins.test/${id}` }, installedAt: 1, updatedAt: 1,
    ...(id === "example.missing" ? { artifactRef: "a".repeat(64) } : {}),
  });
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  let downloads = 0;
  const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor,
    loader: { async load(source) { downloads++; assert.ok(source.url.endsWith("example.good")); return { manifest: manifest("example.good"), activate() {} }; } },
  });
  await manager.restore();
  assert.equal(downloads, 1);
  assert.equal(manager.getSnapshot().extensions.find(row => row.installation.extensionId === "example.missing")!.status, "failed");
  assert.equal(manager.getSnapshot().extensions.find(row => row.installation.extensionId === "example.good")!.status, "active");
  await manager.dispose(); await supervisor.dispose(); await fiber.dispose(); await backend.close();
});
