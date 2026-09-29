import test from "node:test";
import assert from "node:assert/strict";
import { projectDshPermissions } from "../apps/local-agent-host/src/dsh-permission-projection.js";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
import { codexPermissionMode, dshPermissionMode, permissionModeProfileId, projectPermissionProfileCatalog } from "@opencraft/appserver-protocol";

test("portable modes require a verified native binding", () => {
  assert.equal(codexPermissionMode(":workspace_roots"), "accept-edits");
  assert.equal(codexPermissionMode("team-custom"), null);
  assert.equal(dshPermissionMode({ mode: "workspace-write", approval: "ask" }), "accept-edits");
  assert.equal(dshPermissionMode({ sandbox: "workspace-write", approval: "ask" }), "accept-edits");
  assert.equal(dshPermissionMode({ mode: "workspace-write", approval: "never" }), null);
  assert.equal(dshPermissionMode({ mode: "danger-full-access", approval: "never" }), "full");
  assert.deepEqual(projectPermissionProfileCatalog([{ id: "custom", description: null, allowed: true }], () => null)[0], {
    id: "custom", description: null, allowed: true,
  });
  assert.equal(permissionModeProfileId("accept-edits"), "opencraft:permission-mode:accept-edits");
});
test("effective DSH policy does not claim Codex workspace sandbox enforcement", () => {
  const scoped = projectDshPermissions({ sandbox: { mode: "workspace-write", workspaceRoot: "/work" }, approval: "ask", preset: "workspace-write", networkPolicy: "not-managed-by-file-sandbox" });
  assert.deepEqual(scoped.sandbox, { type: "externalSandbox", networkAccess: "enabled" });
  assert.equal(scoped.approvalPolicy, "on-request");
  assert.equal(scoped.dshPermissions.workspaceRoot, "/work");
  assert.deepEqual(scoped.activePermissionProfile, { id: "workspace-write", extends: null });
  const full = projectDshPermissions({ sandbox: { mode: "danger-full-access", workspaceRoot: "/work" }, approval: "never", preset: "danger-full-access" });
  assert.equal(full.sandbox.type, "dangerFullAccess");
  assert.equal(full.approvalPolicy, "never");
  assert.throws(() => projectDshPermissions({}), /unavailable/);
});
test("external DSH without effective policy evidence cannot fabricate workspace permissions", async () => {
  const adapter = new DshAppServerAdapter({ call: async () => ({ events: [], hasMore: false }) } as unknown as DshClient);
  (adapter as any).summaries.set("s", { sessionId: "s", cwd: "/work" });
  try { await assert.rejects((adapter as any).effectivePermissions("s"), /unavailable/); }
  finally { adapter.close(); }
});

test("DSH validates and applies the selected preset during Thread creation", async () => {
  let requestedPreset: unknown;
  const client = { call: async (method: string) => {
    if (method === "settings.describe") return { namespaces: [{ ns: "agent-default-model", value: { provider: "fixture", model: "model" } }] };
    if (method === "llm.models") return { groups: [{ id: "fixture", name: "Fixture", models: [{ id: "model", name: "Model" }] }], failures: [] };
    if (method === "llm.providers") return { providers: [] };
    if (method === "session.models") return { current: { provider: "fixture", model: "model" }, groups: [], failures: [] };
    return {};
  } } as unknown as DshClient;
  const permissions = {
    read: async (threadId?: string) => ({
      presets: [
        { id: "workspace-write", name: "Workspace", sandbox: "workspace-write", approval: "ask" },
        { id: "custom-never", name: "Custom", sandbox: "workspace-write", approval: "never" },
      ],
      sandbox: { mode: "workspace-write", workspaceRoot: "/work" }, approval: "ask",
      preset: threadId ? requestedPreset : "workspace-write",
    }),
    set: async () => ({}),
  };
  const adapter = new DshAppServerAdapter(client, undefined, undefined, false, permissions);
  adapter.setThreadEngine({
    create: async (params: Record<string, unknown>) => {
      requestedPreset = params.permissionPreset;
      return { sessionId: "created", cwd: "/work" };
    },
    describe: async () => ({}), resume: async () => ({}), fork: async () => ({}),
    inject: async () => ({}), release: async () => ({}),
  });
  try {
    const catalog = await adapter.dispatch("permissionProfile/list", {});
    assert.deepEqual((catalog as any).data.map((entry: any) => entry.openCraftMode ?? null), ["accept-edits", null]);
    assert.equal((catalog as any).data[0].id, permissionModeProfileId("accept-edits"));
    assert.equal((catalog as any).data[0].openCraftNativeProfileId, "workspace-write");
    await assert.rejects(adapter.dispatch("thread/start", { cwd: "/work", permissions: 42 }), /Invalid permission profile/);
    await assert.rejects(adapter.dispatch("thread/start", { cwd: "/work", approvalPolicy: "never" }), /named permission profile/);
    await assert.rejects(adapter.dispatch("thread/start", { cwd: "/work", permissions: "unknown" }), /unavailable/);
    assert.equal(requestedPreset, undefined);
    const started = await adapter.dispatch("thread/start", { cwd: "/work", permissions: permissionModeProfileId("accept-edits") });
    assert.equal(requestedPreset, "workspace-write");
    assert.equal((started as any).activePermissionProfile.id, "workspace-write");
  } finally { adapter.close(); }
});

test("DSH maps a standard mode to the native preset before Turn admission", async () => {
  let nativePreset = "danger-full-access";
  let prompted = false;
  const client = { call: async (method: string) => {
    if (method === "session.models") return { current: { provider: "fixture", model: "model" }, groups: [], failures: [] };
    if (method === "llm.models") return { groups: [{ id: "fixture", name: "Fixture", models: [{ id: "model", name: "Model" }] }], failures: [] };
    if (method === "llm.providers") return { providers: [] };
    if (method === "session.prompt") { prompted = true; throw new Error("synthetic prompt stop"); }
    return {};
  } } as unknown as DshClient;
  const adapter = new DshAppServerAdapter(client, undefined, undefined, false, {
    read: async () => ({
      presets: [{ id: "workspace-write", sandbox: "workspace-write", approval: "ask" }],
      sandbox: { mode: "workspace-write", workspaceRoot: "/work" },
      approval: "ask", preset: nativePreset,
    }),
    set: async (_threadId, preset) => { nativePreset = preset; return {}; },
  });
  try {
    await assert.rejects(adapter.dispatch("turn/start", { threadId: "s", input: [], permissions: "unknown" }), /unavailable/);
    assert.equal(prompted, false);
    await assert.rejects(adapter.dispatch("turn/start", { threadId: "s", input: [], permissions: permissionModeProfileId("accept-edits") }));
    assert.equal(nativePreset, "workspace-write");
  } finally { adapter.close(); }
});
