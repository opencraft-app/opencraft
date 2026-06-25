import assert from "node:assert/strict";
import test from "node:test";

import {
  buildComposerControlsModel,
  buildComposerSetupControlsModel,
} from "../src/components/composer-controls/model";
import type { BackendWire, SessionWire } from "../../vela-chat-client/src";

test("composer controls are not ready before the session wire truth is loaded", () => {
  const controls = buildComposerControlsModel({ session: null, backends: [] });

  assert.equal(controls.ready, false);
  assert.equal(controls.selectedModel, undefined);
  assert.equal(controls.selectedReasoningEffort, undefined);
  assert.equal(controls.selectedPermissionMode, undefined);
  assert.deepEqual(controls.modelOptions, []);
  assert.deepEqual(controls.reasoningEffortOptions, []);
  assert.deepEqual(controls.permissionModeOptions, []);
});

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
      location: { kind: "local", label: "Local" },
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
  assert.equal(controls.selectedReasoningEffort, undefined);
  assert.deepEqual(controls.reasoningEffortOptions, []);
  assert.equal(controls.selectedPermissionMode?.label, "Auto review");
});

test("composer controls disable agent config changes when backend capability is unavailable", () => {
  const session: SessionWire = {
    id: "ses_readonly_backend",
    backend: "acp",
    status: "idle",
    operations: {
      update_agent_config: { available: true },
    },
    agent_config: {
      model: "hermes",
      reasoning_effort: "medium",
      permission_mode: "auto",
    },
  };
  const backends: BackendWire[] = [
    {
      kind: "acp",
      status: "available",
      display_name: "Hermes ACP",
      location: { kind: "local", label: "Local" },
      capabilities: {
        streaming: true,
        cancel: true,
        permission_requests: true,
        structured_diff: false,
        session_agent_config: false,
      },
      models: [{ id: "hermes", label: "Hermes" }],
      permission_modes: [{ id: "auto", label: "Auto" }],
      features: [],
    },
  ];

  const controls = buildComposerControlsModel({ session, backends });

  assert.equal(controls.disabled, true);
  assert.equal(controls.selectedModel?.id, "hermes");
  assert.equal(controls.selectedPermissionMode?.id, "auto");
});

test("composer setup controls use the same model shape as active chat controls", () => {
  const controls = buildComposerSetupControlsModel({
    providerLabel: "Codex",
    selectedModel: "gpt-5.5",
    selectedReasoningEffort: "high",
    selectedPermissionMode: "full_access",
    modelOptions: [{ id: "gpt-5.5", label: "GPT-5.5" }],
    reasoningEffortOptions: [{ id: "high", label: "High" }],
    permissionModeOptions: [
      { id: "auto", label: "Default permissions" },
      { id: "full_access", label: "Full access" },
    ],
  });

  assert.equal(controls.ready, true);
  assert.equal(controls.disabled, false);
  assert.equal(controls.providerLabel, "Codex");
  assert.equal(controls.selectedModel?.id, "gpt-5.5");
  assert.equal(controls.selectedReasoningEffort?.id, "high");
  assert.equal(controls.selectedPermissionMode?.id, "full_access");
  assert.deepEqual(controls.modelOptions[0]?.reasoningEfforts, [
    { id: "high", label: "High", description: undefined },
  ]);
});
