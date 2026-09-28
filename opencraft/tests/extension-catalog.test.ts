import assert from "node:assert/strict";
import test from "node:test";
import { projectExtensionCatalog, ExtensionSupervisor } from "@opencraft/extension-runtime";

test("catalog combines built-in and disabled installed rows without making enabled equal running", async () => {
  const supervisor = new ExtensionSupervisor({ platform: "web" });
  const manifest = { manifestVersion: 1 as const, id: "example.builtin", name: "Built in", version: "1.0.0", apiVersion: 1,
    trust: "trusted" as const, platforms: ["web" as const], activationEvents: ["onStartupFinished" as const] };
  await supervisor.activate({ manifest, activate(api) { api.commands.register({ id: "example.builtin.run", title: "Run" }, () => {}); } });
  const rows = projectExtensionCatalog(supervisor.getSnapshot(), { revision: 1, installationLoadErrors: [], extensions: [{
    installation: { extensionId: "example.external", source: { kind: "module-url", url: "https://test.test/module" }, enabled: true, installedAt: 1, updatedAt: 1 },
    status: "incompatible", error: "Unsupported API",
  }] }, supervisor.contributions.getSnapshot());
  assert.equal(rows.length, 2);
  const builtin = rows.find(row => row.id === manifest.id)!;
  assert.deepEqual(builtin.capabilities, ["命令"]);
  assert.equal(builtin.canManage, false);
  const external = rows.find(row => row.id === "example.external")!;
  assert.equal(external.enabled, true);
  assert.equal(external.status, "incompatible");
  assert.equal(external.canManage, true);
  assert.equal(external.error, "Unsupported API");
  await supervisor.dispose();
});
