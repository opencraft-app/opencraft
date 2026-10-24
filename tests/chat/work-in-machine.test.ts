import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexedDB } from "fake-indexeddb";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { readDaemonMachineIdentity } from "../../apps/opencraft-daemon/src/machine-identity";
import { MachineIdentityTransport } from "../../apps/opencraft-daemon/src/machine-transport";
import { workInAgentHosts, chooseWorkInHost, groupWorkInMachines, workInMachineName, readHostMachineInfo, type HostConnectionProfile, type EnvironmentEntry } from "@opencraft/workbench-runtime";
import { IndexedDbHostConnectionProfileStore } from "../../apps/workbench-web/src/runtime/indexeddb-host-profile-store";

import { ServerManagedProfileStore } from "../../apps/workbench-web/src/runtime/server-managed-profile-store";
import { machineRole } from "../../apps/workbench-web/src/runtime/work-in-presentation";

const machine = { machineId: "12345678-1234-4123-8123-123456789abc", name: "build-machine", platform: "macos" as const };
export function profile(hostId: string, identity: typeof machine | null = machine): HostConnectionProfile {
  return { hostId, machineIdentity: identity, agent: hostId.includes("codex") ? "Codex" : "OpenCraft", displayName: hostId, providerId: "opencraft.builtin-agents", providerConfig: {}, providerConfigVersion: 1, hostKind: "local", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null, transportEndpoint: "same.example", executionLocation: null, workspaceBrowseRoots: ["/default"], revision: 0 };
}

test("daemon identity survives restart and is shared by multiple Host leases without starting engines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-machine-test-"));
  try {
    const [first, concurrent] = await Promise.all([readDaemonMachineIdentity(directory), readDaemonMachineIdentity(directory)]);
    assert.deepEqual(first, concurrent);
    const restarted = await readDaemonMachineIdentity(directory);
    assert.deepEqual(restarted, first);
    assert.equal((await readFile(join(directory, "machine-id"), "utf8")).trim(), first.machineId);
    let starts = 0;
    for (const agent of ["OpenCraft", "Codex"] as const) {
      const transport = new MachineIdentityTransport(first, agent, () => { starts++; throw new Error("engine must stay cold"); });
      const client = new JsonRpcAppServerClient({ hostId: agent, transport });
      await transport.connect();
      assert.deepEqual(await client.request("runtime/machine/read", {}), { machine: first, agent });
      await client.close();
    }
    assert.equal(starts, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("old Hosts and malformed responses remain unknown rather than blocking connection", async () => {
  assert.equal(await readHostMachineInfo(() => Promise.reject({ code: -32601 })), null);
  assert.equal(await readHostMachineInfo(() => Promise.resolve({ machineId: "bad" })), null);
  assert.deepEqual(await readHostMachineInfo(() => Promise.resolve({ machine, agent: "Codex" })), { machine, agent: "Codex" });
});

test("reported IDs group engines, physical address and labels do not; cloud stays separate", () => {
  const a = profile("local"), b = profile("local-codex"), c = profile("other", { ...machine, machineId: "22345678-1234-4123-8123-123456789abc" });
  const unknown = { ...profile("unknown", null), providerId: "opencraft.ssh", hostKind: "remote-ssh" as const }, unknown2 = { ...profile("unknown2", null), providerId: "opencraft.websocket", hostKind: "remote-control" as const }, cloud = { ...profile("cloud"), enabled: false };
  const entry: EnvironmentEntry = { id: "cloud", sourceId: "fixture-cloud", name: "cloud", location: "region", profile: cloud, connectable: true,
    resource: { providerId: "fixture-cloud", phase: "suspended", rawPhase: "stopped", message: null, capabilities: { suspend: false, resume: true, remove: true } } };
  const groups = groupWorkInMachines([unknown, cloud, a, unknown2, b, c], [entry]);
  assert.equal(groups.length, 5);
  assert.deepEqual(groups[0]!.hosts.map(host => host.hostId), ["local", "local-codex"]);
  assert.deepEqual(groups.map(group => group.hosts[0]!.hostId), ["local", "other", "unknown", "unknown2", "cloud"]);
  assert.equal(groups.at(-1)!.cloud, true);
  assert.equal(groups.at(-1)!.resource?.phase, "suspended");
});

test("This Mac/This computer belongs only to the desktop's builtin daemon", () => {
  const labels = { thisMac: "这台 Mac", thisComputer: "这台电脑", unknown: "未知机器" };
  const group = groupWorkInMachines([profile("local")])[0]!;
  assert.equal(workInMachineName(group, "electron", labels), "这台 Mac");
  assert.equal(workInMachineName(group, "web", labels), machine.name);
  const linux = groupWorkInMachines([{ ...profile("local"), machineIdentity: { ...machine, platform: "linux" } }])[0]!;
  assert.equal(workInMachineName(linux, "electron", labels), "这台电脑");
  const remote = groupWorkInMachines([{ ...profile("remote"), providerId: "opencraft.websocket" }])[0]!;
  assert.equal(workInMachineName(remote, "electron", labels), machine.name);
});

test("cached identity and Agent survive reload for saved and activation-owned profiles, then update", async () => {
  const databaseName = `machine-${crypto.randomUUID()}`;
  const options = { factory: indexedDB, databaseName, seed: [profile("saved", null)], ephemeral: [profile("local", null), profile("local-codex", null)] };
  let store = await IndexedDbHostConnectionProfileStore.open(options);
  await store.recordMachineIdentity("local", machine, "OpenCraft");
  await store.recordMachineIdentity("local-codex", machine, "Codex");
  await store.recordMachineIdentity("saved", machine, "OpenCraft");
  store.close();
  store = await IndexedDbHostConnectionProfileStore.open(options);
  assert.equal(groupWorkInMachines(store.getSnapshot().profiles).length, 1);
  assert.equal(store.getSnapshot().profiles.find(profile => profile.hostId === "local-codex")!.agent, "Codex");
  const next = { ...machine, machineId: "22345678-1234-4123-8123-123456789abc" };
  await store.recordMachineIdentity("saved", next, "Codex");
  assert.equal(groupWorkInMachines(store.getSnapshot().profiles).length, 2);
  store.close();
  store = await IndexedDbHostConnectionProfileStore.open(options);
  assert.equal(store.getSnapshot().profiles.find(profile => profile.hostId === "saved")!.machineIdentity!.machineId, next.machineId);
  store.close();
});

test("machine selection retains the current Agent or falls back to its first Agent", () => {
  const group = groupWorkInMachines([profile("other-opencraft"), profile("other-codex")])[0]!;
  assert.equal(chooseWorkInHost(group, "Codex").hostId, "other-codex");
  const only = groupWorkInMachines([profile("other-opencraft")])[0]!;
  assert.equal(chooseWorkInHost(only, "Codex").hostId, "other-opencraft");
});

test("one reported Agent uses the current connection without merging logical Hosts", () => {
  const group = groupWorkInMachines([profile("alias"), profile("local"), profile("local-codex")])[0]!;
  assert.equal(chooseWorkInHost(group, "OpenCraft", "local").hostId, "local");
  assert.deepEqual(workInAgentHosts(group, "local").map(host => host.hostId), ["local", "local-codex"]);
  assert.equal(group.hosts.length, 3);
});

test("model menu agent groups place the active agent first while preserving relative order", () => {
  const group = groupWorkInMachines([profile("local-codex"), profile("local")])[0]!;
  assert.deepEqual(
    workInAgentHosts(group, "local").map(host => host.hostId),
    ["local", "local-codex"],
  );
  assert.deepEqual(
    workInAgentHosts(group, "local-codex").map(host => host.hostId),
    ["local-codex", "local"],
  );

  const multiGroup = groupWorkInMachines([
    { ...profile("other-agent"), agent: "OtherAgent" },
    profile("local-codex"),
    profile("local"),
  ])[0]!;
  assert.deepEqual(
    workInAgentHosts(multiGroup, "local").map(host => host.hostId),
    ["local", "other-agent", "local-codex"],
  );
  assert.deepEqual(
    workInAgentHosts(multiGroup, "local-codex").map(host => host.hostId),
    ["local-codex", "other-agent", "local"],
  );
});

test("machine icons distinguish desktop local, daemon servers and cloud resources", () => {
  const local = groupWorkInMachines([profile("local")])[0]!;
  assert.equal(machineRole(local, "electron"), "local");
  assert.equal(machineRole(local, "web"), "server");
  const remote = groupWorkInMachines([{ ...profile("remote"), providerId: "opencraft.websocket" }])[0]!;
  assert.equal(machineRole(remote, "electron"), "server");
  assert.equal(machineRole({ ...local, cloud: true }, "electron"), "cloud");
  assert.equal(machineRole({ ...local, cloud: true }, "web"), "cloud");
});


test("server-managed recipes preserve local machine observations through reload without editing recipes", async () => {
  const databaseName = `managed-machine-${crypto.randomUUID()}`;
  const seed = [profile("local", null), profile("local-codex", null)];
  const remote = { ...profile("ssh:saved", null), displayName: "remote server" };
  const open = async () => new ServerManagedProfileStore(
    await IndexedDbHostConnectionProfileStore.open({ databaseName, factory: indexedDB, seed }),
    { subscribe: () => () => {} }, () => [remote]);
  let store = await open();
  await store.recordMachineIdentity("local", machine, "OpenCraft");
  await store.recordMachineIdentity("local-codex", machine, "Codex");
  await store.recordMachineIdentity("ssh:saved", machine, "Codex");
  store.close();
  store = await open();
  try {
    const profiles = store.getSnapshot().profiles;
    assert.equal(groupWorkInMachines(profiles).length, 2);
    assert.deepEqual(profiles.find(p => p.hostId === "local")?.machineIdentity, machine);
    assert.equal(profiles.find(p => p.hostId === "local-codex")?.agent, "Codex");
    assert.equal(profiles.find(p => p.hostId === "local")?.revision, seed[0].revision);
    assert.equal(profiles.find(p => p.hostId === "ssh:saved")?.machineIdentity, null);
    await assert.rejects(store.put(remote));
  } finally { store.close(); }
});


test("configured unknown-machine labels preserve connection names and never establish grouping", () => {
  const hosts = [profile("ssh:a", null), profile("ssh:b", null)];
  const machines = groupWorkInMachines(hosts);
  const labels = { thisMac: "This Mac", thisComputer: "This computer", unknown: "Unknown machine" };
  const names = { "ssh:a": "Server", "ssh:b": "Server" };
  assert.equal(machines.length, 2);
  assert.equal(workInMachineName(machines[0]!, "web", labels, names), "Server · ssh:a");
  assert.equal(workInMachineName(machines[1]!, "web", labels, names), "Server · ssh:b");
  assert.equal(workInMachineName(machines[0]!, "web", labels), "Unknown machine · ssh:a");
  const known = groupWorkInMachines([profile("ssh:a")])[0]!;
  assert.equal(workInMachineName(known, "web", labels, names), machine.name);
});
