import assert from "node:assert/strict";
import test from "node:test";

import { createInterruptInteractionResponse, type PendingInteraction } from "@opencraft/chat-runtime";
import { createInteractionResponse } from "@opencraft/workbench-runtime";

const identity = {
  requestId: "request-1",
  turnId: null,
  itemId: "item-1",
  receivedAtMs: 1,
} as const;

test("command and file approvals map to exact AppServer decision vocabulary", () => {
  const command = {
    ...identity,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1,
      environmentId: null,
      command: "pwd",
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(command, { type: "approve-once" }), {
    type: "command-approval", requestId: "request-1", decision: "accept",
  });
  assert.deepEqual(createInteractionResponse(command, { type: "approve-session" }), {
    type: "command-approval", requestId: "request-1", decision: "acceptForSession",
  });
  assert.deepEqual(createInteractionResponse(command, { type: "decline" }), {
    type: "command-approval", requestId: "request-1", decision: "decline",
  });

  const policyCommand = {
    ...command,
    params: {
      ...command.params,
      proposedExecpolicyAmendment: ["npm", "test"],
      proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" as const }],
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(policyCommand, { type: "approve-similar" }), {
    type: "command-approval",
    requestId: "request-1",
    decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } },
  });
  assert.deepEqual(createInteractionResponse(policyCommand, { type: "approve-network-host" }), {
    type: "command-approval",
    requestId: "request-1",
    decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "registry.npmjs.org", action: "allow" } } },
  });

  const file = {
    ...identity,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1 },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(file, { type: "cancel" }), {
    type: "file-change-approval", requestId: "request-1", decision: "cancel",
  });
});

test("permission approval grants only requested capabilities and preserves scope", () => {
  const interaction = {
    ...identity,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      environmentId: null,
      startedAtMs: 1,
      cwd: "/vela",
      reason: "network access",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(interaction, { type: "approve-session" }), {
    type: "permissions-approval",
    requestId: "request-1",
    permissions: { network: { enabled: true } },
    scope: "session",
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "decline" }), {
    type: "permissions-approval", requestId: "request-1", permissions: {}, scope: "turn",
  });
});

test("persistent approval is explicit provider scope, never an implicit Codex grant", () => {
  const command = { ...identity, method: "item/commandExecution/requestApproval" as const,
    params: { kind: "command" as const, threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 0, environmentId: null } };
  assert.throws(() => createInteractionResponse(command, { type: "approve-always" }), /not offered/);
  const scoped = { ...command, params: { ...command.params, approvalScopes: ["once", "always", "deny"] as Array<"once" | "always" | "deny"> } };
  assert.deepEqual(createInteractionResponse(scoped, { type: "approve-always" }), {
    type: "command-approval", requestId: "request-1", decision: "accept", _meta: { persist: "always" },
  });
});

test("request_user_input retains question identity and ordered answers", () => {
  const interaction = {
    ...identity,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "deployment",
          header: "Deploy",
          question: "Where?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Staging", description: "Safe" }],
        },
        {
          id: "note",
          header: "Notes",
          question: "Anything else?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(interaction, {
    type: "answer-questions",
    answers: { deployment: [" Staging "], note: ["Notify QA"], unknown: ["ignored"] },
  }), {
    type: "question",
    requestId: "request-1",
    answers: { deployment: ["Staging"], note: ["Notify QA"] },
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "cancel" }), {
    type: "question", requestId: "request-1", answers: {},
  });
});

test("MCP elicitation accepts JSON form bodies and explicit cancellation", () => {
  const interaction = {
    ...identity,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "fixture",
      mode: "form",
      _meta: null,
      message: "Configure tool",
      requestedSchema: { type: "object", properties: {} },
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(interaction, { type: "answer", values: ['{"enabled":true}'] }), {
    type: "elicitation", requestId: "request-1", action: "accept", content: { enabled: true },
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "accept-elicitation", content: { enabled: true, retries: 2 } }), {
    type: "elicitation", requestId: "request-1", action: "accept", content: { enabled: true, retries: 2 },
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "accept-elicitation", persist: "always" }), {
    type: "elicitation", requestId: "request-1", action: "accept", _meta: { persist: "always" },
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "cancel" }), {
    type: "elicitation", requestId: "request-1", action: "cancel",
  });
  assert.deepEqual(createInteractionResponse(interaction, { type: "decline", persist: "always" }), {
    type: "elicitation", requestId: "request-1", action: "decline", _meta: { persist: "always" },
  });
});

test("request_option_picker keeps its distinct submit, skip and dismiss vocabulary", () => {
  const interaction = {
    ...identity,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "option-call",
      namespace: null,
      tool: "request_option_picker",
      arguments: {
        question: "Choose platforms",
        options: [{ label: "Web" }, { label: "iOS" }],
        allowMultiple: true,
      },
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(interaction, {
    type: "submit-option-picker",
    action: "submit",
    selectedOptions: ["Web", "iOS"],
    freeformAnswer: "visionOS",
  }), {
    type: "option-picker",
    requestId: "request-1",
    action: "submit",
    selectedOptions: ["Web", "iOS"],
    freeformAnswer: "visionOS",
  });
  assert.throws(() => createInteractionResponse(interaction, { type: "answer", values: ["Web"] }), /option-picker response/);
});

test("Codex onboarding dynamic tools retain their tool-specific response models", () => {
  const onboarding = {
    ...identity,
    method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: "onboarding", namespace: null,
      tool: "request_onboarding_input",
      arguments: { questions: [{ id: "goal", question: "What first?", options: [{ label: "Build" }, { label: "Fix" }] }] },
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(onboarding, { type: "answer-questions", answers: { goal: [" Build "] } }), {
    type: "question", requestId: "request-1", answers: { goal: ["Build"] },
  });

  const role = {
    ...identity,
    method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: "role", namespace: null,
      tool: "setup_codex_step", arguments: { step: "role" },
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(role, { type: "submit-setup-role", action: "submit", selectedRoles: ["engineering"] }), {
    type: "setup-codex-step", requestId: "request-1", step: "role", action: "submit", selectedRoles: ["engineering"],
  });
  assert.throws(() => createInteractionResponse(role, { type: "submit-setup-task", action: "skip", answers: {} }), /matching response/);

  const task = { ...role, params: { ...role.params, callId: "task", arguments: { step: "task" } } } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(task, { type: "submit-setup-task", action: "submit", answers: { first_task: ["Fix tests"] } }), {
    type: "setup-codex-step", requestId: "request-1", step: "task", action: "submit",
    answers: { first_task: { answers: ["Fix tests"] } },
  });
});

test("setup context picker deduplicates sources and adapts dynamic and compatibility routes", () => {
  const dynamic = {
    ...identity,
    method: "item/tool/call",
    params: {
      threadId: "thread-1", turnId: "turn-1", callId: "context", namespace: null,
      tool: "setup_codex_context_picker", arguments: {},
    },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(dynamic, { type: "submit-setup-context", action: "continue", selectedSources: ["slack", "slack", "gmail"] }), {
    type: "setup-context-picker", requestId: "request-1", action: "continue", selectedSources: ["slack", "gmail"],
  });
  const dedicated = {
    ...identity,
    method: "item/tool/requestSetupCodexContextPicker",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "context" },
  } satisfies PendingInteraction;
  assert.deepEqual(createInteractionResponse(dedicated, { type: "submit-setup-context", action: "skip", selectedSources: ["ignored"] }), {
    type: "setup-context-picker", requestId: "request-1", action: "dismiss", selectedSources: [],
  });
});

test("turn interruption clears legacy blocking requests but lets AppServer resolve dynamic tools", () => {
  const command = {
    ...identity,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "command", startedAtMs: 1, environmentId: null, command: "npm test" },
  } satisfies PendingInteraction;
  assert.deepEqual(createInterruptInteractionResponse(command), {
    type: "command-approval", requestId: "request-1", decision: "decline",
  });
  const context = {
    ...identity,
    method: "item/tool/requestSetupCodexContextPicker",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "context" },
  } satisfies PendingInteraction;
  assert.deepEqual(createInterruptInteractionResponse(context), {
    type: "setup-context-picker", requestId: "request-1", action: "dismiss", selectedSources: [],
  });
  const dynamic = {
    ...identity,
    method: "item/tool/call",
    params: { threadId: "thread-1", turnId: "turn-1", callId: "dynamic", namespace: null, tool: "request_option_picker", arguments: {} },
  } satisfies PendingInteraction;
  assert.equal(createInterruptInteractionResponse(dynamic), null);
});
