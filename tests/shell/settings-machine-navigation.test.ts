import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchDraftLocation, groupWorkInMachines, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import { createApplicationNavigation } from "../../apps/workbench-web/src/runtime/workbench-navigation";
import { machineSettingsSection, replacementMachineSettingsSection } from "../../apps/workbench-web/src/runtime/settings-machine-route";

const profile = (hostId: string, known = true): HostConnectionProfile => ({
  hostId, displayName: hostId, providerId: "opencraft.websocket", providerConfig: {}, providerConfigVersion: 1,
  hostKind: "remote", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null,
  transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [], revision: 0,
  machineIdentity: known ? { machineId: "12345678-1234-4123-8123-123456789abc", name: "服务器", platform: "linux" } : null,
});
const machines = groupWorkInMachines([profile("local"), profile("local-codex")]);
const section = machineSettingsSection(machines[0]!);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("legacy routes for both Agents resolve to one machine; absent Hosts fall back to the list", () => {
  assert.equal(replacementMachineSettingsSection("execution-local", machines), section);
  assert.equal(replacementMachineSettingsSection("execution-local-codex", machines), section);
  assert.equal(replacementMachineSettingsSection("execution-missing", machines), "machines");
  assert.equal(replacementMachineSettingsSection("execution-local", []), "machines");
  assert.equal(replacementMachineSettingsSection("appearance", machines), null);
  const escaped = groupWorkInMachines([profile("host/a %")]);
  assert.equal(replacementMachineSettingsSection(`execution-${encodeURIComponent("host/a %")}`, escaped), machineSettingsSection(escaped[0]!));
});

test("reported identity arriving after an unknown machine bookmark corrects its destination", () => {
  const unknown = groupWorkInMachines([profile("local", false)])[0]!;
  assert.equal(replacementMachineSettingsSection(machineSettingsSection(unknown), [unknown]), null);
  assert.equal(replacementMachineSettingsSection(machineSettingsSection(unknown), machines), section);
  assert.equal(replacementMachineSettingsSection(section, machines), null);
});

for (const mode of ["connected", "hostless"] as const) test(`${mode}: PUSH, legacy REPLACE and POP restore list/machine/Agent destinations`, async () => {
  const nav = createApplicationNavigation(mode === "hostless" ? null : createWorkbenchDraftLocation("local", "settings-test"), { mode: "memory", initialEntries: ["/"] });
  try {
    nav.openSettings("machines");
    nav.openSettings("execution-local-codex");
    const index = nav.getSnapshot().historyIndex;
    nav.openSettings(replacementMachineSettingsSection("execution-local-codex", machines)!, "replace");
    assert.equal(nav.getSnapshot().action, "replace");
    assert.equal(nav.getSnapshot().historyIndex, index);
    assert.deepEqual(nav.getSnapshot().applicationRoute, { kind: "settings", slug: section });
    nav.openSettings("opencraft.builtin-agents.codex-accounts");
    nav.back(); await settle();
    assert.deepEqual(nav.getSnapshot().applicationRoute, { kind: "settings", slug: section });
    nav.back(); await settle();
    assert.equal(nav.getSnapshot().url, "/settings/machines");
    nav.forward(); await settle();
    assert.deepEqual(nav.getSnapshot().applicationRoute, { kind: "settings", slug: section });
    nav.openSettings("machines"); nav.openSettings(section); nav.openSettings("appearance");
    assert.equal(nav.getSnapshot().url, "/settings/appearance");
    assert.equal(nav.getSnapshot().location === null, mode === "hostless");
  } finally { nav.dispose(); }
});
