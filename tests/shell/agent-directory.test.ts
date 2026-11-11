import assert from "node:assert/strict";
import test from "node:test";
import type { OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";
import { projectAgentDirectory } from "../../apps/workbench-web/src/components/agent-directory.js";

const native = (values: Partial<OnboardingAgentSnapshot>): OnboardingAgentSnapshot => ({
  id: "claude", engineId: "claude-code", displayName: "Claude Code", installed: false, authenticated: false,
  version: null, account: null, activity: null, installUrl: "https://example.invalid/install", canInstallPackage: false, ...values,
});

test("one Agent row combines server models and native status, with readiness independent of source", () => {
  const rows = projectAgentDirectory([
    { agentId: "pi", agentLabel: "Pi", id: "pi:one", name: "One", isDefault: true },
    { agentId: "dsh-acp", agentLabel: "DSH", id: "dsh:one", name: "One", isDefault: false },
    { agentId: "claude-code", agentLabel: "Claude Code", id: "claude:one", name: "One", isDefault: false },
  ], [native({})], () => "Agent");
  assert.deepEqual(rows.map(row => [row.label, row.ready]), [["Pi", true], ["DSH", true], ["Claude Code", false]]);
  assert.equal(rows[2]?.models.length, 1, "native observation merges into the same engine row");
  assert.equal(projectAgentDirectory([], [native({ installed: true })], () => "Agent")[0]?.ready, false);
  assert.equal(projectAgentDirectory([], [native({ installed: true, authenticated: true })], () => "Agent")[0]?.ready, true);
});
