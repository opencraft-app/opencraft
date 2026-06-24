import assert from "node:assert/strict";
import test from "node:test";

import { buildVelaSessionSetupSelection } from "../../vela-chat-controller/src/setupModel";
import type { BackendWire } from "../../vela-chat-client/src";

test("workbench setup does not invent reasoning options for ACP backends", () => {
  const backends: BackendWire[] = [
    {
      kind: "acp",
      status: "available",
      display_name: "Hermes ACP",
      capabilities: { session_agent_config: true },
      models: [
        {
          id: "minimax-m2.7",
          label: "minimax-m2.7",
          reasoning_efforts: [],
        },
      ],
      permission_modes: [{ id: "auto", label: "Auto" }],
      features: [],
    },
  ];

  const selection = buildVelaSessionSetupSelection({
    backends,
    selectedBackend: "acp",
    selectedModel: "",
    selectedReasoningEffort: "medium",
    selectedPermissionMode: "",
  });

  assert.deepEqual(selection.setupReasoningOptions, []);
  assert.equal(selection.setupSelectedReasoningEffort, "");
  assert.deepEqual(selection.setupAgentConfig, {
    model: "minimax-m2.7",
    permission_mode: "auto",
  });
});

test("workbench setup does not select errored backends", () => {
  const backends: BackendWire[] = [
    {
      kind: "codex",
      status: "error",
      status_message: "model discovery failed",
      display_name: "Codex",
      capabilities: { session_agent_config: true },
      models: [],
      permission_modes: [{ id: "auto", label: "Auto" }],
      features: [],
    },
  ];

  const selection = buildVelaSessionSetupSelection({
    backends,
    selectedBackend: "codex",
    selectedModel: "gpt-5.4",
    selectedReasoningEffort: "high",
    selectedPermissionMode: "auto",
  });

  assert.equal(selection.resolvedSelectedBackend, "");
  assert.equal(selection.setupSelectedModel, "");
  assert.deepEqual(selection.setupModelOptions, []);
  assert.equal(selection.setupSelectedPermissionMode, "");
  assert.deepEqual(selection.setupPermissionOptions, []);
  assert.deepEqual(selection.setupAgentConfig, {});
});
