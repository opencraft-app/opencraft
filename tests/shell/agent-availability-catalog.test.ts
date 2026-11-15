import assert from "node:assert/strict";
import test from "node:test";
import { agentIdForHostLabel, filterModelsForNewDraft, newDraftAgentsDisabled } from "../../apps/workbench-web/src/runtime/agent-availability.ts";

test("a new draft uses the settings host's agent switches for models listed on another host", () => {
  const enabled = (hostId: string, agentId: string) => hostId !== "opencraft-server" || !["codex", "claude", "cursor", "codebuddy", "pi"].includes(agentId);
  const groups = [
    { hostId: "opencraft-server", models: [] as { agentId: string; id: string }[] },
    { hostId: "local-codex", models: [{ agentId: "codex", id: "codex:gpt-5.6-luna" }] },
  ];
  assert.deepEqual(filterModelsForNewDraft(groups[1]!.models, "local-codex", "opencraft-server", enabled), []);
  assert.equal(newDraftAgentsDisabled(groups, "opencraft-server", enabled), true);
  assert.deepEqual(filterModelsForNewDraft(groups[1]!.models, "local-codex", "local-codex", enabled), groups[1]!.models);
});

test("native host models inherit the host group's agent switch", () => {
  const enabled = (hostId: string, agentId: string) => hostId !== "opencraft-server" || agentId !== "codex";
  const hostModel = { agentId: null, id: "gpt-6.1-sol" };
  const groups = [{ hostId: "local-codex", agentId: "codex", models: [hostModel] }];
  assert.equal(agentIdForHostLabel("Codex"), "codex");
  assert.deepEqual(filterModelsForNewDraft([hostModel], "local-codex", "opencraft-server", enabled, "codex"), []);
  assert.equal(newDraftAgentsDisabled(groups, "opencraft-server", enabled), true);
  assert.deepEqual(filterModelsForNewDraft([hostModel], "local-codex", "opencraft-server", enabled), [hostModel]);
  const ownAgent = { agentId: "cursor", id: "cursor:one" };
  assert.deepEqual(filterModelsForNewDraft([ownAgent], "local-codex", "opencraft-server", enabled, "codex"), [ownAgent]);
});
