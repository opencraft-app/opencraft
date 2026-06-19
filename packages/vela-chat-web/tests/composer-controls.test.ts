import assert from "node:assert/strict";
import test from "node:test";

import { buildComposerControlsModel } from "../src/components/composer-controls/model";
import type { BackendWire, SessionWire } from "../../vela-chat-client/src";

test("composer controls derive selected model, reasoning effort, and permission from session capability data", () => {
  const session: SessionWire = {
    id: "ses_1",
    backend: "pi",
    status: "idle",
    agent_config: {
      model: "minimax-m2.7",
      reasoning_effort: "high",
      permission_mode: "full_access",
    },
  };
  const backends: BackendWire[] = [
    {
      kind: "pi",
      status: "available",
      display_name: "Pi Coding",
      capabilities: { session_agent_config: true },
      models: [
        {
          id: "minimax-m2.7",
          label: "MiniMax M2.7",
          description: "CloudAgents MiniMax",
          reasoning_efforts: [
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
      permission_modes: [
        { id: "auto", label: "Default permissions" },
        { id: "full_access", label: "Full access" },
      ],
      features: [],
    },
  ];

  const controls = buildComposerControlsModel({ session, backends });

  assert.equal(controls.providerLabel, "Pi Coding");
  assert.equal(controls.selectedModel?.id, "minimax-m2.7");
  assert.equal(controls.selectedReasoningEffort?.id, "high");
  assert.equal(controls.selectedPermissionMode?.id, "full_access");
  assert.deepEqual(controls.modelOptions.map((option) => option.id), ["minimax-m2.7"]);
  assert.deepEqual(controls.reasoningEffortOptions.map((option) => option.id), ["medium", "high"]);
  assert.deepEqual(controls.permissionModeOptions.map((option) => option.id), [
    "auto",
    "full_access",
  ]);
});

test("composer controls keep current session values selectable when backend catalog is sparse", () => {
  const controls = buildComposerControlsModel({
    session: {
      id: "ses_1",
      backend: "codex",
      status: "running",
      agent_config: {
        model: "gpt-5.3-codex-spark",
        reasoning_effort: "high",
        permission_mode: "auto_review",
      },
    },
    backends: [],
  });

  assert.equal(controls.disabled, false);
  assert.equal(controls.providerLabel, "codex");
  assert.equal(controls.selectedModel?.label, "gpt-5.3-codex-spark");
  assert.equal(controls.selectedReasoningEffort?.label, "High");
  assert.equal(controls.selectedPermissionMode?.label, "Auto review");
});
