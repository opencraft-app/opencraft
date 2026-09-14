import test from "node:test";
import assert from "node:assert/strict";
import { projectDshPermissions } from "../apps/local-agent-host/src/dsh-permission-projection.js";
import { DshAppServerAdapter } from "../apps/local-agent-host/src/dsh-appserver-adapter.js";
import type { DshClient } from "../apps/local-agent-host/src/dsh-client.js";
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
