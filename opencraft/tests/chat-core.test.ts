import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateUserInputQuestionAnswers,
  aggregateToolCallStatistics,
  agentActivityHeaderAccessibleLabel,
  asItemId,
  createAgentActivityContentUnits,
  createAssistantTurnPresentationPlan,
  createTimelineTurnPresentationPlan,
  codexAppThreadNavigationTarget,
  createConversationKey,
  createdThreadToolResult,
  createDefaultTimelineProjectorRegistry,
  createDefaultToolActivityPresenterRegistry,
  createOlderHistoryGap,
  createMcpElicitationDraft,
  createUserInputQuestionDrafts,
  deriveAgentActivityHeaderPresentation,
  deriveSubagentActivityGroupPresentation,
  deriveSubagentActivityPresentation,
  deriveTimelineLatestTurnActivityKey,
  deriveTimelineLatestTurnPhase,
  extractToolCallContentParts,
  formatCodexToolDuration,
  formatCommandActivitySummary,
  formatThreadHandoffStepLabel,
  formatAutomaticApprovalReviewSummary,
  formatAutomaticApprovalReviewTitle,
  findPendingInteraction,
  groupTimelineFramesByTurn,
  indexAttachedInteractions,
  isCodexAppThreadTool,
  isVisibleAgentActivityRow,
  isToolActivityPresentationSuppressed,
  hasContinuingLiveDynamicToolActivity,
  shouldRenderAgentThinkingPlaceholder,
  shouldAllowAgentActivityCollapse,
  presentToolActivity,
  parseUnifiedDiff,
  parseSkillPath,
  parseRealtimeDelegation,
  presentApprovalRequest,
  presentAutomationUpdate,
  presentReasoning,
  normalizeMcpElicitationMetadata,
  normalizeMcpElicitationSchema,
  normalizeCodexTurnUserMessages,
  projectTimeline,
  resolveAgentActivityDisclosure,
  resolveAgentActivityLayout,
  summarizeAutomaticApprovalReviewAction,
  summarizeHookRuns,
  summarizeTurnDiff,
  threadHandoffToolResult,
  TimelineProjectorRegistry,
  ToolActivityPresenterRegistry,
  validateMcpElicitationDraft,
  visibleThreadHandoffSteps,
  type TimelineProjectionSource,
  type TimelineBlock,
  type AssistantTurnPresentationPlan,
  type ReasoningRenderUnit,
} from "@opencraft/chat-core";

function activityHeaderFor(
  blocks: readonly TimelineBlock[],
  status: "pending" | "streaming" | "complete" | "failed" | "interrupted",
) {
  const group = createAgentActivityContentUnits(blocks, status).find((unit) => unit.type === "group");
  if (group === undefined) throw new Error("Expected grouped Agent Activity");
  return deriveAgentActivityHeaderPresentation(group);
}

test("Hook lifecycle summaries match Codex counts, filtering, and adjacent-run coalescing", () => {
  const stats = summarizeHookRuns([
    {
      id: "lint",
      run: {
        id: "lint",
        eventName: "userPromptSubmit",
        source: "project",
        status: "blocked",
        statusMessage: "Policy check",
        entries: [
          { kind: "context", text: "hidden context" },
          { kind: "warning", text: "shown only in run details" },
          { kind: "feedback", text: "Please add a test." },
        ],
      },
    },
    {
      id: "lint:1",
      run: {
        id: "lint",
        eventName: "userPromptSubmit",
        source: "project",
        status: "blocked",
        statusMessage: "Policy check",
        entries: [
          { kind: "context", text: "different hidden context" },
          { kind: "warning", text: "shown only in run details" },
          { kind: "feedback", text: "Please add a test." },
        ],
      },
    },
    {
      id: "audit",
      run: {
        id: "audit",
        eventName: "afterToolUse",
        source: "user",
        status: "failed",
        statusMessage: null,
        entries: [{ kind: "error", text: "Audit process exited." }],
      },
    },
    {
      id: "stop",
      run: {
        id: "stop",
        eventName: "stop",
        source: "plugin",
        status: "stopped",
        statusMessage: null,
        entries: [
          { kind: "feedback", text: "Remember the release note." },
          { kind: "stop", text: "Stopped by hook." },
        ],
      },
    },
  ]);

  assert.equal(stats?.count, 4);
  assert.equal(stats?.blockedCount, 2);
  assert.equal(stats?.errorCount, 1);
  assert.deepEqual(stats?.blockedSources, ["project", "project"]);
  assert.deepEqual(stats?.blockedMessages, ["Please add a test.", "Please add a test."]);
  assert.deepEqual(stats?.feedbackMessages, [{ source: "plugin", text: "Remember the release note." }]);
  assert.deepEqual(stats?.entries, [
    { kind: "feedback", text: "Please add a test." },
    { kind: "feedback", text: "Please add a test." },
    { kind: "error", text: "Audit process exited." },
    { kind: "feedback", text: "Remember the release note." },
    { kind: "stop", text: "Stopped by hook." },
  ]);
  assert.equal(stats?.runs.length, 3);
  assert.equal(stats?.runs[0]?.count, 2);
  assert.deepEqual(stats?.runs[0]?.entries, [
    { tone: "warning", text: "shown only in run details" },
    { tone: "error", text: "Please add a test." },
  ]);
});

function source(turns: TimelineProjectionSource["turns"]): TimelineProjectionSource {
  return {
    key: createConversationKey("ssh:fixture", "thread:one"),
    revision: 7,
    phase: "live",
    authoritative: true,
    turns,
  };
}

function reasoningUnits(plan: AssistantTurnPresentationPlan | null | undefined): readonly ReasoningRenderUnit[] {
  return plan?.slots.flatMap<ReasoningRenderUnit>(slot => slot.type === "agent-activity"
    ? slot.contentUnits.filter((unit): unit is ReasoningRenderUnit => unit.type === "reasoning")
    : slot.type === "reasoning" ? [slot] : []) ?? [];
}

test("Timeline projection groups consecutive assistant Items into a stable Frame", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-1",
    status: "streaming",
    items: [
      { id: "user-1", type: "userMessage", payload: { content: [{ type: "text", text: "Inspect it" }] } },
      { id: "reasoning-1", type: "reasoning", payload: { summary: "Reading files", status: "inProgress" } },
      { id: "exec-1", type: "commandExecution", payload: { callId: "call-1", command: "rg --files", status: "completed" } },
      { id: "assistant-1", type: "agentMessage", payload: { text: "I found the boundary.", completed: false } },
    ],
  }]), createDefaultTimelineProjectorRegistry());

  assert.equal(snapshot.frames.length, 2);
  assert.equal(snapshot.frames[0]?.type, "user");
  assert.deepEqual(snapshot.frames[1]?.blocks.map((block) => block.type), [
    "reasoning",
    "command-execution",
    "text",
  ]);
  assert.equal(snapshot.frames[1]?.id, "turn-1:assistant:reasoning-1");
  assert.equal(snapshot.anchorFrameIds.get("call:call-1"), snapshot.frames[1]?.id);
});

test("a Turn retains interaction boundaries and arbitrates Thinking to its latest Activity group", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-split-assistant",
    status: "streaming",
    items: [
      { id: "user", type: "userMessage", payload: { content: [{ type: "text", text: "Inspect it" }] } },
      { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed", exitCode: 0 } },
      { id: "settled", type: "interaction:approval", payload: { requestId: "rpc-settled", title: "Run command", state: "accepted" } },
      { id: "reasoning", type: "reasoning", payload: { summary: ["Checking the result"] } },
      { id: "inspect", type: "dynamicToolCall", payload: { namespace: "custom", tool: "inspect_state", status: "completed", success: true, arguments: {} } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant", "interaction", "assistant"]);
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.equal(plan.assistantFrame?.id, "turn-split-assistant:assistant-surface");
  assert.deepEqual(plan.assistantFrame?.blocks.map((block) => block.type), [
    "command-execution",
    "approval",
    "reasoning",
    "tool-call",
  ]);
  assert.equal(plan.assistant?.slots.filter((slot) => slot.type === "agent-activity").length, 2);
  assert.equal(plan.assistant?.slots[0]?.id, "turn-split-assistant:slot:agent-activity");
  assert.equal(plan.thinkingOwner.type, "activity");
  if (plan.thinkingOwner.type !== "activity") throw new Error("Expected Activity Thinking owner");
  assert.equal(plan.thinkingOwner.activityId, plan.assistant?.slots.at(-1)?.id);
});

test("only the most recent Turn may materialize transient Thinking chrome", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-awaiting-first-item",
    status: "streaming",
    items: [
      { id: "user", type: "userMessage", payload: { content: [{ type: "text", text: "Begin" }] } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const latest = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.equal(latest.assistantFrame?.id, "turn-awaiting-first-item:assistant-surface");
  assert.deepEqual(latest.thinkingOwner, {
    type: "turn",
    placeholderId: "turn-awaiting-first-item:slot:thinking-placeholder",
    label: "Thinking",
  });
  assert.equal(latest.topLevelSlotCount, 2);

  const historical = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: false });
  assert.equal(historical.assistantFrame, null);
  assert.deepEqual(historical.thinkingOwner, { type: "none" });
  assert.equal(historical.topLevelSlotCount, 1);
});

test("a pending Composer-owned interaction suppresses generic Turn Thinking", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-awaiting-approval",
    status: "streaming",
    items: [
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed", exitCode: 0 } },
      {
        id: "approval",
        type: "permissionRequest",
        payload: { requestId: "rpc-approval", itemId: "command", method: "item/commandExecution/requestApproval", title: "Run command", command: "npm test" },
      },
      { id: "inspect", type: "dynamicToolCall", payload: { namespace: "custom", tool: "inspect_state", status: "completed", success: true, arguments: {} } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.equal(plan.assistant?.slots.filter((slot) => slot.type === "agent-activity").length, 2);
  assert.notEqual(plan.thinkingOwner.type, "turn");
});

test("final answer actions remain owned by one synthesized assistant surface", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-final-surface",
    status: "complete",
    items: [
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed", exitCode: 0 } },
      { id: "settled", type: "interaction:approval", payload: { requestId: "rpc-settled", title: "Run command", state: "accepted" } },
      { id: "answer", type: "agentMessage", payload: { text: "All checks pass.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.equal(plan.assistantFrame?.blocks.filter((block) => block.type === "text").length, 1);
  assert.deepEqual(plan.assistant?.slots.map((slot) => slot.type), ["agent-activity", "assistant-content", "assistant-content"]);
  assert.notEqual(plan.thinkingOwner.type, "turn");
});

test("UserMessage projection preserves the typed AppServer input union and message kinds", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-user-input",
    status: "complete",
    startedAtMs: 1_728_000_000_000,
    items: [
      {
        id: "user-input",
        type: "userMessage",
        payload: {
          clientId: "client-user-input",
          content: [
            { type: "text", text: "Inspect @src", text_elements: [{ byteRange: { start: 8, end: 12 }, placeholder: "@src" }] },
            { type: "image", url: "https://example.test/image.png", detail: "high" },
            { type: "localImage", path: "/workspace/shot.png" },
            { type: "audio", url: "https://example.test/audio.wav" },
            { type: "localAudio", path: "/workspace/audio.wav" },
            { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
            { type: "mention", name: "src", path: "/workspace/src" },
          ],
        },
      },
      {
        id: "steering-input",
        type: "steeringUserMessage",
        payload: { status: "accepted", input: [{ type: "text", text: "Continue" }] },
      },
      {
        id: "hook-input",
        type: "hookPrompt",
        payload: { fragments: [{ text: "First hook fragment" }, { text: "Second hook fragment" }] },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());

  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  assert.deepEqual(blocks.map((block) => block.type), ["user-message", "user-message", "user-message"]);
  const user = blocks[0];
  assert.equal(user?.type, "user-message");
  if (user?.type !== "user-message") throw new Error("Expected user message");
  assert.equal(user.message, "Inspect @src");
  assert.equal(user.messageKind, "user");
  assert.equal(user.clientId, "client-user-input");
  assert.equal(user.sentAtMs, 1_728_000_000_000);
  assert.equal(user.hasExternalAttachments, true);
  assert.equal(user.deliveryStatus, null);
  assert.deepEqual(user.content, [
    { type: "text", text: "Inspect @src", textElements: [{ byteRange: { start: 8, end: 12 }, placeholder: "@src" }] },
    { type: "image", source: "https://example.test/image.png", detail: "high" },
    { type: "local-image", source: "/workspace/shot.png", detail: null },
    { type: "audio", source: "https://example.test/audio.wav" },
    { type: "local-audio", source: "/workspace/audio.wav" },
    { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    { type: "mention", name: "src", path: "/workspace/src" },
  ]);
  assert.equal(snapshot.anchorFrameIds.get("message:client-user-input"), snapshot.frames[0]?.id);
  const steering = blocks[1];
  assert.equal(steering?.type === "user-message" ? steering.messageKind : null, "steering");
  assert.equal(steering?.type === "user-message" ? steering.steeringStatus : null, "accepted");
  assert.equal(steering?.type === "user-message" ? steering.sentAtMs : null, null);
  const hook = blocks[2];
  assert.equal(hook?.type === "user-message" ? hook.messageKind : null, "hook-prompt");
  assert.equal(hook?.type === "user-message" ? hook.message : null, "First hook fragment\nSecond hook fragment");
  assert.equal(hook?.type === "user-message" ? hook.hookFeedback : null, true);
});

test("staged file locator remains in typed content but not the visible user bubble", () => {
  const locator = 'The user attached "受众广.md" at "/host/受众广.md".';
  const snapshot = projectTimeline(source([{
    id: "turn-attachment", status: "complete", items: [{
      id: "file-user", type: "userMessage", payload: { content: [
        { type: "text", text: "看看这个文件" },
        { type: "text", text: locator, text_elements: [{
          byteRange: { start: 0, end: new TextEncoder().encode(locator).length }, placeholder: "",
        }] },
        { type: "mention", name: "受众广.md", path: "/host/受众广.md" },
      ] },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap(frame => frame.blocks).find(block => block.type === "user-message");
  assert.equal(message?.type === "user-message" ? message.message : null, "看看这个文件");
  assert.equal(message?.type === "user-message" ? message.hasExternalAttachments : null, true);
  assert.equal(message?.type === "user-message" ? message.content.some(part => part.type === "text" && part.text === locator) : null, true);
});

test("Host-marked staged mention projects as a file while an ordinary mention stays context", () => {
  const name = "受众广.md";
  const path = "/host/受众广.md";
  const locator = `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
  const snapshot = projectTimeline(source([{
    id: "turn-staged-file", status: "complete", items: [{
      id: "staged-file-user", type: "userMessage", payload: { content: [
        { type: "text", text: "看看文件" },
        { type: "text", text: locator, text_elements: [{
          byteRange: { start: 0, end: new TextEncoder().encode(locator).length },
          placeholder: "opencraft:staged-file:v1",
        }] },
        { type: "mention", name, path },
        { type: "mention", name: "src", path: "/workspace/src" },
      ] },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap(frame => frame.blocks).find(block => block.type === "user-message");
  if (message?.type !== "user-message") throw new Error("Expected user message");
  assert.equal(message.message, "看看文件");
  assert.deepEqual(message.attachments.filter(part => part.type === "file").map(part => part.name), [name]);
  assert.deepEqual(message.content.filter(part => part.type === "mention").map(part => part.name), [name, "src"]);
});

test("only the exact prior Host locator can restore a legacy staged file", () => {
  const name = "受众广.md";
  const path = "/host/受众广.md";
  const locator = `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
  const project = (text: string) => projectTimeline(source([{
    id: "turn-legacy-file", status: "complete", items: [{
      id: "legacy-file-user", type: "userMessage", payload: { content: [
        { type: "text", text, text_elements: [{ byteRange: { start: 0, end: new TextEncoder().encode(text).length }, placeholder: "" }] },
        { type: "mention", name, path },
      ] },
    }],
  }]), createDefaultTimelineProjectorRegistry()).frames.flatMap(frame => frame.blocks).find(block => block.type === "user-message");
  const legacy = project(locator);
  const arbitrary = project(`Look at the file ${name} at ${path}`);
  assert.equal(legacy?.type === "user-message" ? legacy.attachments.filter(part => part.type === "file").length : null, 1);
  assert.equal(arbitrary?.type === "user-message" ? arbitrary.attachments.filter(part => part.type === "file").length : null, 0);
});

test("UserMessage projection owns Codex request wrappers, semantic chips, Goal, and blocked delivery", () => {
  const rawMessage = [
    "## Code review guidelines:",
    "Review only the changed files.",
    "## Prior conversation with Codex:",
    "Earlier context that should not become the visible bubble.",
    "## Auto resolve merge:",
    "enabled",
    "## My request for Codex:",
    "/goal Implement the typed projection",
  ].join("\n");
  const snapshot = projectTimeline(source([{
    id: "turn-semantic-user",
    status: "complete",
    startedAtMs: 1_729_000_000_000,
    hookStats: summarizeHookRuns([{
      id: "blocked-prompt",
      run: {
        id: "blocked-prompt",
        eventName: "userPromptSubmit",
        source: "project",
        status: "blocked",
        entries: [{ kind: "feedback", text: "Add the release note." }],
      },
    }]),
    items: [{
      id: "semantic-user",
      type: "userMessage",
      payload: {
        clientId: "client-semantic-user",
        content: [{ type: "text", text: rawMessage }],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "user-message");
  if (block?.type !== "user-message") throw new Error("Expected UserMessage block");
  assert.equal(block.message, "Implement the typed projection");
  assert.equal(block.goal, true);
  assert.equal(block.reviewMode, true);
  assert.equal(block.pullRequestFixMode, false);
  assert.equal(block.autoResolveSync, true);
  assert.equal(block.referencesPriorConversation, false);
  assert.equal(block.deliveryStatus, "not-sent");
  assert.equal(block.sentAtMs, 1_729_000_000_000);
});

test("Turn params own the canonical Composer message and acknowledge the matching server Item", () => {
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-composer-owner",
    status: "complete",
    startedAtMs: 1_730_000_000_000,
    params: {
      clientUserMessageId: "client-composer-owner",
      input: [{ type: "text", text: "Canonical Composer input" }],
      attachments: [{ type: "localImage", path: "/workspace/reference.png" }],
    },
    items: [
      {
        id: "server-composer-owner",
        type: "userMessage",
        payload: {
          clientId: "client-composer-owner",
          content: [{ type: "text", text: "Server echo that must not win" }],
        },
      },
      { id: "assistant-composer-owner", type: "agentMessage", payload: { text: "Acknowledged." } },
    ],
  };
  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.equal(normalized.items.length, 2);
  assert.equal(normalized.items[0]?.id, "server-composer-owner");
  assert.deepEqual((normalized.items[0]?.payload as { content?: unknown }).content, [
    { type: "text", text: "Canonical Composer input" },
  ]);

  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  const messages = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message");
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected canonical UserMessage");
  assert.equal(message.message, "Canonical Composer input");
  assert.equal(message.clientId, "client-composer-owner");
  assert.equal(message.sentAtMs, 1_730_000_000_000);
  assert.deepEqual(message.sourceItemIds, ["server-composer-owner"]);
  assert.equal(snapshot.anchorFrameIds.get("item:server-composer-owner"), snapshot.frames[0]?.id);
});

test("acknowledged Host-staged files render as attachments without exposing their model locator", () => {
  const path = "/host/attachments/a/content-受众广.md";
  const locator = `The user attached a file named ${JSON.stringify("受众广.md")}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-host-staged-file", status: "complete",
    params: {
      clientUserMessageId: "client-host-staged-file",
      input: [{ type: "text", text: ".." }, { type: "mention", name: "受众广.md", path }],
    },
    items: [{
      id: "server-host-staged-file", type: "userMessage", payload: {
        clientId: "client-host-staged-file",
        content: [
          { type: "text", text: "..", text_elements: [] },
          { type: "text", text: locator, text_elements: [{
            byte_range: { start: 0, end: new TextEncoder().encode(locator).length },
            placeholder: "opencraft:staged-file:v1",
          }] },
          { type: "mention", name: "受众广.md", path },
        ],
      },
    }],
  };
  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.deepEqual((normalized.items[0]?.payload as { content?: unknown }).content,
    (turn.items[0]?.payload as { content?: unknown }).content);
  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap((frame) => frame.blocks)
    .find((block) => block.type === "user-message");
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected UserMessage block");
  assert.equal(message.message, "..");
  assert.equal(message.attachments.length, 1);
  assert.deepEqual(message.attachments[0], {
    type: "file", id: path, name: "受众广.md", target: path,
    mimeType: null, startLine: null, endLine: null,
  });

  const attachmentOnly = projectTimeline(source([{
    ...turn,
    id: "turn-only-host-staged-file",
    params: { ...turn.params, input: [{ type: "mention", name: "受众广.md", path }] },
    items: [{ ...turn.items[0]!, payload: {
      ...turn.items[0]!.payload,
      content: (turn.items[0]!.payload as { content: unknown[] }).content.slice(1),
    } }],
  }]), createDefaultTimelineProjectorRegistry());
  const fileOnlyMessage = attachmentOnly.frames.flatMap((frame) => frame.blocks)
    .find((block) => block.type === "user-message");
  assert.equal(fileOnlyMessage?.type, "user-message");
  if (fileOnlyMessage?.type !== "user-message") throw new Error("Expected file-only UserMessage block");
  assert.equal(fileOnlyMessage.message, "");
  assert.equal(fileOnlyMessage.attachments.length, 1);
});

test("durable typed attachment metadata owns a file mention without parsing a locator", () => {
  const path = "/host/attachments/durable/content-file.pdf";
  const snapshot = projectTimeline(source([{
    id: "turn-durable-file", status: "complete",
    params: {
      clientUserMessageId: "client-durable-file",
      input: [{ type: "mention", name: "file.pdf", path }],
      attachments: [{ id: "durable", name: "file.pdf", path, mimeType: "application/pdf" }],
    },
    items: [{ id: "server-durable-file", type: "userMessage", payload: {
      clientId: "client-durable-file",
      content: [{ type: "mention", name: "file.pdf", path }],
    } }],
  }]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap(frame => frame.blocks)
    .find(block => block.type === "user-message");
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected UserMessage block");
  assert.equal(message.message, "");
  assert.deepEqual(message.attachments, [{
    type: "file", id: "durable", name: "file.pdf", target: path,
    mimeType: "application/pdf", startLine: null, endLine: null,
  }]);
});

test("pre-sidecar Host file history still restores through its exact legacy locator", () => {
  const path = "/host/attachments/legacy/content-notes.md";
  const name = "notes.md";
  const locator = `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-legacy-file", status: "complete",
    params: { clientUserMessageId: "client-legacy-file", input: [{ type: "mention", name, path }] },
    items: [{ id: "server-legacy-file", type: "userMessage", payload: {
      clientId: "client-legacy-file", content: [
        { type: "text", text: locator, text_elements: [{
          byte_range: { start: 0, end: new TextEncoder().encode(locator).length }, placeholder: "",
        }] },
        { type: "mention", name, path },
      ],
    } }],
  };
  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap(frame => frame.blocks)
    .find(block => block.type === "user-message");
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected UserMessage block");
  assert.equal(message.message, "");
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]?.type, "file");
});

test("additional server UserMessages become accepted steering after the canonical Composer message", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-server-steering",
    status: "complete",
    params: {
      clientUserMessageId: "client-leading",
      input: [{ type: "text", text: "Leading request" }],
    },
    items: [
      {
        id: "server-leading",
        type: "userMessage",
        payload: { clientId: "client-leading", content: [{ type: "text", text: "Leading request" }] },
      },
      { id: "assistant-before-steer", type: "agentMessage", payload: { text: "Working." } },
      {
        id: "server-steer",
        type: "userMessage",
        payload: { clientId: "client-steer", content: [{ type: "text", text: "Also check the fallback" }] },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  const messages = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.type === "user-message" ? messages[0].messageKind : null, "user");
  assert.equal(messages[1]?.type === "user-message" ? messages[1].messageKind : null, "steering");
  assert.equal(messages[1]?.type === "user-message" ? messages[1].steeringStatus : null, "accepted");
});

test("paginated history without Turn params promotes a later client UserMessage to accepted steering", () => {
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-history-without-params",
    status: "complete",
    items: [
      {
        id: "history-leading-user",
        type: "userMessage",
        payload: { clientId: "client-leading-history", content: [{ type: "text", text: "Initial request" }] },
      },
      { id: "history-reasoning", type: "reasoning", payload: { summary: "First pass" } },
      { id: "history-assistant", type: "agentMessage", payload: { text: "First result" } },
      {
        id: "history-server-steer",
        type: "userMessage",
        payload: { clientId: "client-history-steer", content: [{ type: "text", text: "Also inspect mobile" }] },
      },
      { id: "history-assistant-after-steer", type: "agentMessage", payload: { text: "Inspecting mobile" } },
    ],
  };

  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.equal(normalized.items.length, 5);
  const firstSource = normalized.items[0]?.payload as { __velaMessageKind?: string };
  const steeringSource = normalized.items[3]?.payload as {
    __velaMessageKind?: string;
    __velaSteeringStatus?: string;
  };
  assert.equal(firstSource.__velaMessageKind, "user");
  assert.equal(steeringSource.__velaMessageKind, "steering");
  assert.equal(steeringSource.__velaSteeringStatus, "accepted");

  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  const messages = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message");
  assert.deepEqual(messages.map((message) => message.messageKind), ["user", "steering"]);
  assert.deepEqual(messages.map((message) => message.steeringStatus), [null, "accepted"]);
});

test("paginated history keeps an unidentifiable post-assistant UserMessage as a non-visual steered boundary", () => {
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-history-hidden-steered",
    status: "complete",
    items: [
      {
        id: "history-primary",
        type: "userMessage",
        payload: { clientId: "client-history-primary", content: [{ type: "text", text: "Primary" }] },
      },
      { id: "history-answer", type: "agentMessage", payload: { text: "Answer" } },
      {
        id: "history-unidentified-steered",
        type: "userMessage",
        payload: { clientId: null, content: [{ type: "text", text: "Server-only acknowledgement" }] },
      },
      { id: "history-explicit-steered", type: "steered", payload: {} },
    ],
  };

  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.deepEqual(normalized.nonVisualItemIds, [
    "history-unidentified-steered",
    "history-explicit-steered",
  ]);
  assert.deepEqual(normalized.items.map((item) => item.id), ["history-primary", "history-answer"]);

  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  assert.equal(snapshot.frames.flatMap((frame) => frame.blocks).some((block) => block.type === "unknown"), false);
});

test("an explicit steered marker closes the leading-user ownership segment even without assistant UI", () => {
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-steered-display-boundary",
    status: "complete",
    items: [
      {
        id: "boundary-leading-user",
        type: "userMessage",
        payload: { clientId: "client-boundary-leading", content: [{ type: "text", text: "Primary" }] },
      },
      { id: "boundary-steered-marker", type: "steered", payload: {} },
      {
        id: "boundary-follow-up-user",
        type: "userMessage",
        payload: { clientId: "client-boundary-follow-up", content: [{ type: "text", text: "Follow up" }] },
      },
    ],
  };

  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.deepEqual(normalized.nonVisualItemIds, ["boundary-steered-marker"]);
  assert.deepEqual(normalized.items.map((item) => item.id), ["boundary-leading-user", "boundary-follow-up-user"]);
  const followUp = normalized.items[1]?.payload as {
    __velaMessageKind?: string;
    __velaSteeringStatus?: string;
  };
  assert.equal(followUp.__velaMessageKind, "steering");
  assert.equal(followUp.__velaSteeringStatus, "accepted");
});

test("UserMessage projection retains file, comment and MCP context attachments as typed domain values", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-typed-user-attachments",
    status: "complete",
    params: {
      clientUserMessageId: "client-typed-user-attachments",
      input: [{ type: "text", text: "Inspect the attached context" }],
      attachments: [{
        id: "file-attachment",
        fsPath: "/workspace/src/index.ts",
        startLine: 12,
        endLine: 18,
        mimeType: "text/typescript",
      }],
      commentAttachments: [{
        id: "comment-attachment",
        body: "This branch is unreachable",
        position: { path: "/workspace/src/index.ts", line: 15 },
      }],
    },
    mcpAppModelContextAttachments: [{
      id: "mcp-context",
      name: "Issue context",
      uri: "https://example.test/issues/42",
      serverName: "issues",
    }],
    items: [{
      id: "server-typed-user-attachments",
      type: "userMessage",
      payload: {
        clientId: "client-typed-user-attachments",
        content: [{ type: "text", text: "Inspect the attached context" }],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "user-message");
  if (block?.type !== "user-message") throw new Error("Expected typed UserMessage");
  assert.deepEqual(block.attachments, [
    {
      type: "file",
      id: "file-attachment",
      name: "index.ts",
      target: "/workspace/src/index.ts",
      mimeType: "text/typescript",
      startLine: 12,
      endLine: 18,
    },
    {
      type: "comment",
      id: "comment-attachment",
      label: "index.ts",
      target: "/workspace/src/index.ts",
      body: "This branch is unreachable",
      line: 15,
    },
    {
      type: "mcp-context",
      id: "mcp-context",
      label: "Issue context",
      target: "https://example.test/issues/42",
      provider: "issues",
    },
  ]);
  assert.equal(block.commentCount, 1);
  assert.equal(block.hasExternalAttachments, true);
});

test("a steering restore message owns its matching server UserMessage and both IDs stay searchable", () => {
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-steering-owner",
    status: "streaming",
    items: [
      { id: "assistant-prework", type: "agentMessage", payload: { text: "First pass" } },
      {
        id: "local-steering",
        type: "steeringUserMessage",
        payload: {
          clientUserMessageId: "client-steering",
          status: "accepted",
          input: [{ type: "text", text: "Check mobile too" }],
          restoreMessage: { createdAt: 1_731_000_000_000, context: { commentAttachments: [] } },
        },
      },
      {
        id: "server-steering",
        type: "userMessage",
        payload: {
          clientId: "client-steering",
          content: [{ type: "text", text: "Check mobile too" }],
        },
      },
      { id: "steered-marker", type: "steered", payload: {} },
      { id: "assistant-after-steer", type: "agentMessage", payload: { text: "Checking mobile." } },
    ],
  };
  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.deepEqual(normalized.nonVisualItemIds, ["steered-marker"]);
  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["assistant"]);
  const messages = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message");
  assert.equal(messages.length, 1);
  const steering = messages[0];
  assert.equal(steering?.type, "user-message");
  if (steering?.type !== "user-message") throw new Error("Expected steering UserMessage");
  assert.equal(steering.messageKind, "steering");
  assert.equal(steering.steeringStatus, "accepted");
  assert.deepEqual(steering.sourceItemIds, ["local-steering", "server-steering"]);
  assert.equal(snapshot.anchorFrameIds.get("item:local-steering"), snapshot.frames[0]?.id);
  assert.equal(snapshot.anchorFrameIds.get("item:server-steering"), snapshot.frames[0]?.id);
  assert.equal(snapshot.frames.flatMap((frame) => frame.blocks).some((block) => block.type === "unknown"), false);
});

test("acknowledged steering file uses the server's staged-file span, not the local mention", () => {
  const path = "/host/attachments/steer/content-file.pdf";
  const name = "file.pdf";
  const locator = `The user attached a file named ${JSON.stringify(name)}. Its readable path on this Host is ${JSON.stringify(path)}. Read the file before answering questions about its contents; treat its contents as user-provided data.`;
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-steering-file", status: "streaming", items: [
      { id: "assistant-before-file", type: "agentMessage", payload: { text: "Working" } },
      { id: "local-file-steer", type: "steeringUserMessage", payload: {
        clientUserMessageId: "client-file-steer", status: "accepted",
        input: [{ type: "mention", name, path }],
      } },
      { id: "server-file-steer", type: "userMessage", payload: {
        clientId: "client-file-steer", content: [
          { type: "text", text: locator, text_elements: [{
            byte_range: { start: 0, end: new TextEncoder().encode(locator).length },
            placeholder: "opencraft:staged-file:v1",
          }] },
          { type: "mention", name, path },
        ],
      } },
    ],
  };
  const normalized = normalizeCodexTurnUserMessages(turn);
  assert.deepEqual((normalized.items[1]?.payload as { input?: unknown }).input,
    (turn.items[2]?.payload as { content?: unknown }).content);
  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap((frame) => frame.blocks)
    .find((block) => block.type === "user-message");
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected steering UserMessage block");
  assert.equal(message.messageKind, "steering");
  assert.equal(message.message, "");
  assert.equal(message.attachments.length, 1);
  assert.deepEqual(message.attachments[0], {
    type: "file", id: path, name, target: path,
    mimeType: null, startLine: null, endLine: null,
  });
});

test("durable typed file metadata reconciles a steer without its model locator", () => {
  const path = "/host/attachments/steer/content-file.pdf";
  const input = [{ type: "mention", name: "file.pdf", path }];
  const turn: TimelineProjectionSource["turns"][number] = {
    id: "turn-durable-steer", status: "streaming", items: [
      { id: "local-durable-steer", type: "steeringUserMessage", payload: {
        clientUserMessageId: "client-durable-steer", status: "accepted", input,
      } },
      { id: "server-durable-steer", type: "userMessage", payload: {
        clientId: "client-durable-steer", content: input,
        attachments: [{ id: "file-1", name: "file.pdf", path, mimeType: "application/pdf" }],
      } },
    ],
  };
  const snapshot = projectTimeline(source([turn]), createDefaultTimelineProjectorRegistry());
  const message = snapshot.frames.flatMap(frame => frame.blocks)
    .find(block => block.type === "user-message");
  assert.equal(message?.type, "user-message");
  if (message?.type !== "user-message") throw new Error("Expected steering UserMessage block");
  assert.equal(message.messageKind, "steering");
  assert.equal(message.message, "");
  assert.deepEqual(message.attachments, [{
    type: "file", id: "file-1", name: "file.pdf", target: path,
    mimeType: "application/pdf", startLine: null, endLine: null,
  }]);
});

test("TurnDiff stays distinct from patch Activity and aggregates renamed files", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 80%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1,2 +1,3 @@",
    "-old",
    "+new",
    "+added",
    " context",
    "diff --git a/docs/readme.md b/docs/readme.md",
    "--- a/docs/readme.md",
    "+++ b/docs/readme.md",
    "@@ -1 +1 @@",
    "-before",
    "+after",
  ].join("\n");
  assert.deepEqual(summarizeTurnDiff(diff), {
    files: [
      { path: "src/new.ts", additions: 2, deletions: 1 },
      { path: "docs/readme.md", additions: 1, deletions: 1 },
    ],
    additions: 3,
    deletions: 2,
  });

  const snapshot = projectTimeline(source([{
    id: "turn-diff",
    status: "complete",
    items: [
      { id: "patch-item", type: "fileChange", payload: { status: "completed", changes: [{ path: "src/new.ts", kind: "modify" }] } },
      { id: "turn-diff:aggregate", type: "turnDiff", payload: { diff } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  assert.deepEqual(blocks.map((block) => block.type), ["patch"]);
  const turnDiff = snapshot.frames[0]?.changeSummary;
  assert.equal(turnDiff?.type, "turn-diff");
  if (turnDiff?.type === "turn-diff") {
    assert.equal(turnDiff.status, "complete");
    assert.equal(turnDiff.files.length, 2);
    assert.equal(turnDiff.additions, 3);
    assert.equal(turnDiff.deletions, 2);
  }
});

test("automatic approval reviews use Codex labels, attach facts, and obey Activity grouping", () => {
  const review = {
    reviewId: "review-one",
    targetItemId: "command-one",
    startedAtMs: 10,
    completedAtMs: 20,
    status: "denied",
    riskLevel: "high",
    userAuthorization: "low",
    rationale: "The command can expose repository metadata.",
    action: { type: "command", source: "shell", command: "git status", cwd: "/workspace" },
    decisionSource: "agent",
  };
  const snapshot = projectTimeline(source([{
    id: "turn-review",
    status: "complete",
    items: [
      { id: "command-one", type: "commandExecution", payload: { command: "git status", status: "completed", automaticApprovalReviews: [review] } },
      { id: "review-network", type: "automaticApprovalReview", payload: { ...review, reviewId: "review-network", targetItemId: null, status: "timedOut", riskLevel: null, rationale: null, action: { type: "networkAccess", target: "api.example.com", host: "api.example.com", protocol: "https", port: 443 } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  const command = frame?.blocks[0];
  assert.equal(command?.type, "command-execution");
  if (command?.type !== "command-execution") throw new Error("Expected command block");
  assert.equal(command.automaticApprovalReviews[0]?.id, "review-one");
  assert.equal(formatAutomaticApprovalReviewTitle(command.automaticApprovalReviews[0]!), "Auto-review denied high risk");
  assert.equal(formatAutomaticApprovalReviewSummary(command.automaticApprovalReviews[0]!), "The command can expose repository metadata.");
  assert.equal(summarizeAutomaticApprovalReviewAction(command.automaticApprovalReviews[0]!.action), "git status");
  assert.equal(frame?.type, "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.deepEqual(units.map((unit) => unit.type), ["agent-activity"]);
  assert.deepEqual(units[0]?.type === "agent-activity"
    ? units[0].contentUnits.map((unit) => unit.type)
    : [], ["standalone", "standalone"]);
  const standalone = frame.blocks[1];
  assert.equal(standalone?.type, "automatic-approval-review");
  if (standalone?.type === "automatic-approval-review") {
    assert.equal(formatAutomaticApprovalReviewTitle(standalone.review), "Auto-review timed out");
    assert.equal(formatAutomaticApprovalReviewSummary(standalone.review), "A carefully prompted reviewer agent timed out before ChatGPT ran this request");
    assert.equal(summarizeAutomaticApprovalReviewAction(standalone.review.action), "Network access to api.example.com");
  }
});

test("an in-progress auto-review becomes aborted when its Turn is interrupted", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-interrupted-review",
    status: "interrupted",
    items: [{
      id: "review-interrupted",
      type: "automaticApprovalReview",
      payload: {
        reviewId: "review-interrupted",
        targetItemId: null,
        startedAtMs: 10,
        completedAtMs: null,
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
        action: { type: "requestPermissions", reason: null, permissions: {} },
        decisionSource: null,
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "automatic-approval-review");
  if (block?.type === "automatic-approval-review") assert.equal(block.review.status, "aborted");
});

test("Codex tool facts survive projection and statistics deduplicate item updates", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-tools",
    status: "complete",
    items: [
      {
        id: "mcp-1",
        type: "mcpToolCall",
        payload: {
          server: "github",
          tool: "search_code",
          status: "failed",
          arguments: { query: "repo:opencraft" },
          error: { message: "rate limited" },
          durationMs: 1250,
          readOnlyHint: true,
          appContext: { resourceUri: null },
        },
      },
      {
        id: "dynamic-1",
        type: "dynamicToolCall",
        payload: {
          namespace: "browser",
          tool: "open",
          status: "completed",
          success: true,
          contentItems: [{ type: "inputText", text: "opened" }],
          durationMs: 80,
        },
      },
      { id: "search-1", type: "webSearch", payload: { query: "Codex activity rows", results: [] } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const mcp = blocks.find((block) => block.type === "tool-call" && block.kind === "mcp");
  assert.equal(mcp?.type, "tool-call");
  if (mcp?.type !== "tool-call") throw new Error("Expected MCP block");
  assert.equal(mcp.callId, "mcp-1");
  assert.equal(mcp.errorMessage, "rate limited");
  assert.equal(mcp.durationMs, 1250);
  assert.equal(presentToolActivity(mcp).summary, "Search code");
  assert.equal(presentToolActivity(mcp).detail, null);
  assert.deepEqual(extractToolCallContentParts(mcp), [
    { kind: "text", role: "error", text: "rate limited" },
    { kind: "json", role: "input", value: { query: "repo:opencraft" } },
  ]);
  assert.deepEqual(aggregateToolCallStatistics([...blocks, mcp]), {
    totalCount: 3,
    failedCount: 1,
    commandCount: 0,
    patchCount: 0,
    mcpCount: 1,
    dynamicCount: 1,
    webSearchCount: 1,
    subagentCount: 0,
    imageGenerationCount: 0,
    imageViewCount: 0,
    sleepCount: 0,
    durationCount: 2,
    durationSumMs: 1330,
    durationMaxMs: 1250,
  });
});

test("MCP activity labels preserve Codex generic, browser, app-prefix, and node-repl semantics", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-mcp-labels",
    status: "complete",
    items: [
      { id: "generic", type: "mcpToolCall", payload: { server: "tools", tool: "open_api_url", status: "completed", arguments: {}, result: null } },
      { id: "prefixed", type: "mcpToolCall", payload: { server: "github", tool: "github_search_pull_requests", status: "completed", arguments: {}, appContext: { appName: "GitHub" }, result: null } },
      { id: "browser", type: "mcpToolCall", payload: { server: "node_repl", tool: "browser_click", status: "completed", arguments: {}, result: { content: [], structuredContent: null, _meta: { "codex/toolSurface": { kind: "browserUse", backend: "chrome" } } } } },
      { id: "browser-iab", type: "mcpToolCall", payload: { server: "node_repl", tool: "browser_click", status: "completed", arguments: {}, result: { content: [], structuredContent: null, _meta: { "codex/toolSurface": { kind: "browserUse", backend: "iab" } } } } },
      { id: "js", type: "mcpToolCall", payload: { server: "node_repl", tool: "js", status: "completed", arguments: { title: "Inspect the active browser tab" }, result: null } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const labels = snapshot.frames.flatMap((frame) => frame.blocks).filter((block) => block.type === "tool-call").map((block) => presentToolActivity(block).summary);
  assert.deepEqual(labels, ["Open API URL", "Search pull requests", "Used Chrome", "Used the browser", "Inspect the active browser tab"]);
});

test("computer-use tool surfaces preserve app identity and exact active/completed action labels", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-computer-use",
    status: "streaming",
    items: [
      {
        id: "scroll",
        type: "mcpToolCall",
        payload: {
          server: "computer-use",
          tool: "scroll",
          status: "completed",
          arguments: { direction: "DOWN", app: "com.apple.Safari" },
          appContext: { appName: "Safari" },
          result: {
            content: [], structuredContent: null,
            _meta: { "codex/toolSurface": { kind: "computerUse", app: { kind: "appId", appId: "com.apple.Safari" } } },
          },
        },
      },
      {
        id: "typing",
        type: "mcpToolCall",
        payload: {
          server: "computer-use",
          tool: "type_text",
          status: "inProgress",
          arguments: { text: "hello   world" },
          result: {
            content: [], structuredContent: null,
            _meta: { "codex/toolSurface": { kind: "computerUse", app: { kind: "displayName", displayName: "Notes" } } },
          },
        },
      },
      {
        id: "browser-page",
        type: "mcpToolCall",
        payload: {
          server: "node_repl",
          tool: "browser_click",
          status: "completed",
          arguments: {},
          result: {
            content: [], structuredContent: null,
            _meta: { "codex/toolSurface": {
              kind: "browserUse",
              backend: "iab",
              screenshot: { pageUrl: "https://example.com/path" },
              webMcpCalls: [
                { kind: "listTools", name: "webmcp_list_tools", sourceHostname: "example.com", outputJson: "[{\"name\":\"lookup\"}]" },
                { kind: "invokeTool", name: "lookup_item", title: "Lookup item", description: "Find one item", readOnlyHint: true, sourceHostname: "example.com", inputJson: "{\"id\":7}", outputJson: "partial result", outputTruncated: true },
                { kind: "invalid", name: "ignored" },
              ],
            } },
          },
        },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks).filter((block) => block.type === "tool-call");
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).summary), [
    "Scrolled down in Safari",
    "Typing text “hello world” in Notes",
    "Used the browser",
  ]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).icon), ["computer", "computer", "browser"]);
  assert.deepEqual(blocks[0]?.sourceApp, { kind: "appId", appId: "com.apple.Safari" });
  assert.deepEqual(blocks[1]?.sourceApp, { kind: "displayName", displayName: "Notes" });
  assert.equal(blocks[2]?.sourcePageUrl, "https://example.com/path");
  assert.deepEqual(blocks[2]?.webMcpCalls, [
    {
      kind: "listTools", name: "webmcp_list_tools", title: null, description: null, readOnlyHint: null,
      sourceHostname: "example.com", inputJson: null, inputTruncated: false,
      outputJson: "[{\"name\":\"lookup\"}]", outputTruncated: false,
    },
    {
      kind: "invokeTool", name: "lookup_item", title: "Lookup item", description: "Find one item", readOnlyHint: true,
      sourceHostname: "example.com", inputJson: "{\"id\":7}", inputTruncated: false,
      outputJson: "partial result", outputTruncated: true,
    },
  ]);
  assert.equal(
    agentActivityHeaderAccessibleLabel(activityHeaderFor(blocks, "complete").summary),
    "Used Safari, Notes, and the browser",
  );
});

test("generic dynamic tools use Codex compact labels and never invent a raw body", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-dynamic-labels",
    status: "complete",
    items: [
      { id: "generic", type: "dynamicToolCall", payload: { namespace: "custom", tool: "inspect_workspaceState", status: "completed", success: true, arguments: { verbose: true }, contentItems: [{ type: "outputText", text: "ok" }] } },
      { id: "terminal", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "read_thread_terminal", status: "completed", success: true } },
      { id: "deps", type: "dynamicToolCall", payload: { namespace: "custom", tool: "load_workspace_dependencies", status: "inProgress", success: null } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks).filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  const presentations = blocks.filter((block) => !isToolActivityPresentationSuppressed(block)).map((block) => presentToolActivity(block));
  assert.deepEqual(presentations.map(({ summary }) => summary), ["Inspect workspace state", "Read chat terminal"]);
  assert.deepEqual(presentations.map(({ canExpand }) => canExpand), [false, false]);
  assert.deepEqual(presentations.map(({ icon }) => icon), ["none", "agent"]);
  assert.equal(isToolActivityPresentationSuppressed(blocks[2]!), true);
});

test("DSH deepseek-harness tools get a semantic icon, detail, and expandable body", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-dsh-harness",
    status: "complete",
    items: [
      { id: "read", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "read", status: "completed", success: true, arguments: { file_path: "src/main.ts" }, contentItems: [{ type: "inputText", text: "console.log(1)" }] } },
      { id: "grep", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "grep", status: "running", success: null, arguments: { pattern: "TODO" } } },
      { id: "ask", type: "dynamicToolCall", payload: { namespace: "deepseek-harness", tool: "ask_user_question", status: "completed", success: true, arguments: { question: "Which target?" } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks).filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).icon), ["read", "search", "wrench"]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).summary), ["Read", "Searching", "Ask user question"]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).detail), ["src/main.ts", "TODO", null]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).canExpand), [true, true, true]);
  assert.deepEqual(extractToolCallContentParts(blocks[0]!).map((part) => part.role), ["input", "output"]);
});

test("adjacent imageView tool calls coalesce into one expandable visual activity", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-image-views",
    status: "complete",
    items: [
      { id: "image-1", type: "imageView", payload: { path: "data:image/png;base64,first" } },
      { id: "image-2", type: "imageView", payload: { path: "/tmp/second.png" } },
      { id: "terminal", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "read_thread_terminal", status: "completed", success: true } },
      { id: "image-3", type: "imageView", payload: { path: "https://example.com/third.png" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const first = blocks[0];
  const third = blocks[2];
  assert.equal(first?.type, "tool-call");
  assert.equal(third?.type, "tool-call");
  if (first?.type !== "tool-call" || third?.type !== "tool-call") return;
  assert.deepEqual(first.imagePaths, ["data:image/png;base64,first", "/tmp/second.png"]);
  assert.deepEqual(first.sourceItemIds, [asItemId("image-1"), asItemId("image-2")]);
  assert.equal(presentToolActivity(first).summary, "Viewed 2 images");
  assert.equal(presentToolActivity(first).canExpand, true);
  assert.deepEqual(third.imagePaths, ["https://example.com/third.png"]);
  assert.equal(presentToolActivity(third).summary, "Viewed an image");
});

test("node_repl MCP calls use Codex's terminal activity icon", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-node-repl",
    status: "complete",
    items: [{
      id: "node-repl",
      type: "mcpToolCall",
      payload: {
        server: "node_repl",
        tool: "js",
        arguments: { title: "Inspecting the workspace" },
        status: "completed",
        result: { content: [{ type: "text", text: "ok" }] },
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "tool-call");
  if (block?.type !== "tool-call") return;
  assert.equal(presentToolActivity(block).summary, "Inspecting the workspace");
  assert.equal(presentToolActivity(block).icon, "terminal");
});

test("successful automation_update is promoted to a Scheduled task resource while transient and invalid calls stay hidden", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-automation",
    status: "complete",
    items: [
      { id: "automation-running", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "automation_update", status: "inProgress", success: null, arguments: { mode: "view", id: "daily-check" } } },
      { id: "automation-invalid", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "automation_update", status: "completed", success: true, arguments: { mode: "create", name: "Missing body" } } },
      {
        id: "automation-complete",
        type: "dynamicToolCall",
        payload: {
          callId: "automation-call",
          namespace: "codex_app",
          tool: "automation_update",
          status: "completed",
          success: true,
          arguments: {
            mode: "suggested_create",
            kind: "heartbeat",
            name: "Review ChatUI drift",
            prompt: "Compare the latest ChatUI behavior.",
            rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30",
            status: "ACTIVE",
          },
          contentItems: [{ type: "inputText", text: JSON.stringify({ automationId: "automation-7", mode: "create" }) }],
        },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const hidden = blocks.filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.equal(hidden.length, 2);
  assert.deepEqual(hidden.map((block) => isToolActivityPresentationSuppressed(block)), [true, true]);
  const automation = blocks.find((block): block is Extract<TimelineBlock, { type: "automation-update" }> => block.type === "automation-update");
  assert.ok(automation);
  assert.equal(automation.mode, "suggested-create");
  assert.equal(automation.automationId, "automation-7");
  assert.deepEqual(presentAutomationUpdate(automation), {
    title: "Review ChatUI drift",
    subtitle: "Every Monday at 9:30 AM",
    actionLabel: "Created",
    scheduleLabel: "Every Monday at 9:30 AM",
    canOpen: true,
  });
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  assert.deepEqual(createAssistantTurnPresentationPlan(frame).slots.flatMap((unit) => unit.type === "assistant-content" ? [unit.block.type] : []), ["automation-update"]);
});

test("Codex settings and Chrome tab tools use source-specific Activity semantics", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-host-tools",
    status: "streaming",
    items: [
      { id: "settings-read", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "read_settings", status: "completed", success: true, arguments: {} } },
      { id: "settings-write", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "write_settings", status: "inProgress", success: null, arguments: { config: { web_search: "live" } } } },
      { id: "tab", type: "dynamicToolCall", payload: { namespace: "chrome_extension", tool: "getTabContext", status: "completed", success: true, arguments: { tabId: 17 } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).summary), [
    "Read settings",
    "Waiting for approval",
    "Read tab",
  ]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).icon), ["wrench", "wrench", "browser"]);
});

test("invalid Chrome tab arguments stay in protocol state but do not leak generic Activity rows", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-invalid-tab-tools",
    status: "streaming",
    items: [
      { id: "negative-tab", type: "dynamicToolCall", payload: { namespace: "chrome_extension", tool: "getTabContext", status: "failed", success: false, arguments: { tabId: -1 } } },
      { id: "fractional-tab", type: "dynamicToolCall", payload: { namespace: "chrome_extension", tool: "getTabContext", status: "inProgress", success: null, arguments: { tabId: 2.5 } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const blocks = frame.blocks.filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => isToolActivityPresentationSuppressed(block)), [true, true]);
  assert.deepEqual(createAssistantTurnPresentationPlan(frame).slots, []);
  assert.equal(shouldRenderAgentThinkingPlaceholder(frame), true);
});

test("source-specific dynamic tool titles remain completion labels when the call fails", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-host-tool-failures",
    status: "complete",
    items: [
      { id: "settings-read", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "read_settings", status: "failed", success: false, arguments: {} } },
      { id: "tab", type: "dynamicToolCall", payload: { namespace: "chrome_extension", tool: "getTabContext", status: "failed", success: false, arguments: { tabId: 17 } } },
      { id: "list", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "list_threads", status: "failed", success: false, arguments: {} } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).summary), [
    "Read settings",
    "Read tab",
    "Listed chats",
  ]);
  assert.deepEqual(blocks.map((block) => presentToolActivity(block).state), ["failed", "failed", "failed"]);
});

test("completed list/read tool suffix bridges live calls without a transient Thinking row", () => {
  const projectAssistant = (items: readonly Record<string, unknown>[]) => {
    const frame = projectTimeline(source([{
      id: "turn-live-gap",
      status: "streaming",
      items,
    }]), createDefaultTimelineProjectorRegistry()).frames[0];
    if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
    return frame;
  };

  const listFrame = projectAssistant([
    { id: "list", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "list_threads", status: "completed", success: true, arguments: {} } },
  ]);
  assert.equal(hasContinuingLiveDynamicToolActivity(listFrame.blocks, listFrame.status), true);
  assert.equal(shouldRenderAgentThinkingPlaceholder(listFrame), false);
  assert.deepEqual(activityHeaderFor(listFrame.blocks, listFrame.status), {
    state: "thinking",
    summaryKey: "thinking",
    icon: null,
    summary: { kind: "text", text: "Thinking" },
    active: true,
  });

  const genericFrame = projectAssistant([
    { id: "inspect", type: "dynamicToolCall", payload: { namespace: "custom", tool: "inspect_state", status: "completed", success: true, arguments: {} } },
  ]);
  assert.equal(hasContinuingLiveDynamicToolActivity(genericFrame.blocks, genericFrame.status), false);
  assert.equal(shouldRenderAgentThinkingPlaceholder(genericFrame), true);

  const brokenSuffixFrame = projectAssistant([
    { id: "list", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "list_threads", status: "completed", success: true, arguments: {} } },
    { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed", exitCode: 0 } },
  ]);
  assert.equal(hasContinuingLiveDynamicToolActivity(brokenSuffixFrame.blocks, brokenSuffixFrame.status), false);
  assert.equal(shouldRenderAgentThinkingPlaceholder(brokenSuffixFrame), true);
  const brokenSuffixGroup = createAgentActivityContentUnits(
    brokenSuffixFrame.blocks,
    brokenSuffixFrame.status,
  ).find((unit) => unit.type === "group");
  if (brokenSuffixGroup === undefined) throw new Error("Expected completed Activity group");
  assert.equal(brokenSuffixGroup.lifecycle.inProgress, true);
  assert.equal(deriveAgentActivityHeaderPresentation(brokenSuffixGroup).state, "thinking");
});

test("Turn gap and Activity group never both own Thinking", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-single-thinking-owner",
    status: "streaming",
    items: [
      { id: "command-a", type: "commandExecution", payload: { command: "pwd", status: "completed", exitCode: 0 } },
      { id: "command-b", type: "commandExecution", payload: { command: "git status", status: "completed", exitCode: 0 } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  const activity = plan.assistant?.slots.find((slot) => slot.type === "agent-activity");
  if (activity?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  const group = activity.contentUnits.find((unit) => unit.type === "group");
  if (group?.type !== "group") throw new Error("Expected Activity group");

  assert.equal(plan.thinkingOwner.type, "activity");
  if (plan.thinkingOwner.type !== "activity") throw new Error("Expected Activity Thinking owner");
  assert.equal(plan.thinkingOwner.activityId, activity.id);
  assert.equal(plan.thinkingOwner.groupId, group.id);
  assert.equal(group.lifecycle.inProgress, true);
  assert.equal(deriveAgentActivityHeaderPresentation(group).state, "thinking");
});

test("reasoning-only live Turn gives Thinking ownership to its independent disclosure", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-reasoning-thinking-owner",
    status: "streaming",
    items: [
      { id: "reasoning", type: "reasoning", payload: { summary: ["Inspecting"], status: "inProgress" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0];
  if (turn === undefined) throw new Error("Expected Turn");

  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  const activity = plan.assistant?.slots.find((slot) => slot.type === "agent-activity");
  assert.equal(activity?.type, "agent-activity");
  const reasoning = reasoningUnits(plan.assistant)[0];
  if (reasoning?.type !== "reasoning") throw new Error("Expected reasoning disclosure");
  assert.equal(reasoning.active, true);
  assert.equal(reasoning.presentation.content, "Inspecting");
  assert.equal(reasoning.presentation.initiallyCollapsed, true);
  assert.deepEqual(plan.thinkingOwner, {
    type: "reasoning",
    reasoningId: reasoning.id,
  });
  assert.equal(plan.topLevelSlotCount, 1, "the expandable Thinking row replaces, rather than duplicates, the placeholder");
});

test("unfinished read, search and list commands stay retrospective until authority finishes them", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-running-exploration",
    status: "streaming",
    items: [
      { id: "read", type: "commandExecution", payload: { command: "cat README.md", commandActions: [{ type: "read", command: "cat README.md", name: "README.md", path: "/vela/README.md" }], status: "inProgress" } },
      { id: "search", type: "commandExecution", payload: { command: "rg Replica src", commandActions: [{ type: "search", command: "rg Replica src", query: "Replica", path: "src" }], status: "inProgress" } },
      { id: "list", type: "commandExecution", payload: { command: "find src", commandActions: [{ type: "listFiles", command: "find src", path: "src" }], status: "inProgress" } },
      { id: "shell", type: "commandExecution", payload: { command: "npm test", commandActions: [{ type: "unknown", command: "npm test" }], status: "inProgress" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  assert.deepEqual(frame.blocks.map((block) => isVisibleAgentActivityRow(block)), [false, false, false, true]);
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.equal(units.length, 1);
  assert.equal(units[0]?.type, "agent-activity");
  if (units[0]?.type === "agent-activity") {
    assert.deepEqual(units[0].blocks.map((block) => block.id), [
      "command-execution:read",
      "command-execution:search",
      "command-execution:list",
      "command-execution:shell",
    ]);
    assert.deepEqual(units[0].blocks.filter((block) => isVisibleAgentActivityRow(block)).map((block) => block.id), ["command-execution:shell"]);
  }

  const explorationOnly = { ...frame, blocks: frame.blocks.slice(0, 3) };
  const explorationUnits = createAssistantTurnPresentationPlan(explorationOnly).slots;
  assert.equal(explorationUnits[0]?.type, "agent-activity");
  if (explorationUnits[0]?.type !== "agent-activity") throw new Error("Expected live exploration Activity");
  const explorationGroup = explorationUnits[0].contentUnits[0];
  assert.equal(explorationGroup?.type, "group");
  if (explorationGroup?.type !== "group") throw new Error("Expected exploration group");
  assert.equal(explorationGroup.lifecycle.isExploring, true);
  assert.equal(deriveAgentActivityHeaderPresentation(explorationGroup).state, "active");
  assert.equal(shouldRenderAgentThinkingPlaceholder(explorationOnly), false);
});

test("an unfinished SKILL.md read owns active state but row visibility follows detail mode", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-live-skill-read",
    status: "streaming",
    items: [{
      id: "skill-read",
      type: "commandExecution",
      payload: {
        command: "cat .agents/skills/review/SKILL.md",
        cwd: "/workspace",
        commandActions: [{ type: "read", command: "cat", name: "SKILL.md", path: "/workspace/.agents/skills/review/SKILL.md" }],
        status: "inProgress",
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const block = frame.blocks[0];
  if (block?.type !== "command-execution") throw new Error("Expected command block");
  assert.equal(isVisibleAgentActivityRow(block), false);
  assert.equal(isVisibleAgentActivityRow(block, undefined, "STEPS_PROSE"), true);
  const group = createAgentActivityContentUnits(frame.blocks, frame.status)[0];
  if (group?.type !== "group") throw new Error("Expected active Activity group");
  const header = deriveAgentActivityHeaderPresentation(group);
  assert.equal(header.state, "active");
  assert.equal(agentActivityHeaderAccessibleLabel(header.summary), "Reading Review skill");
});

test("image generation and image viewing retain Codex operational tool semantics", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-images",
    status: "complete",
    items: [
      { id: "generated", type: "imageGeneration", payload: {
        result: "aGVsbG8=",
        revisedPrompt: "A paper-glass iPad workspace",
        savedPath: "/workspace/generated.png",
        transparentBackground: true,
        failure: null,
        status: "completed",
      } },
      { id: "viewed", type: "imageView", payload: { path: "/workspace/preview.png" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const generated = blocks.find((block) => block.type === "image");
  const viewed = blocks.find((block) => block.type === "tool-call" && block.kind === "image-view");
  assert.equal(generated?.type, "image");
  if (generated?.type !== "image") throw new Error("Expected generated image");
  assert.equal(generated.uri, "data:image/png;base64,aGVsbG8=");
  assert.equal(generated.alt, "A paper-glass iPad workspace");
  assert.equal(generated.savedPath, "/workspace/generated.png");
  assert.equal(generated.transparentBackground, true);
  assert.equal(generated.failure, null);
  assert.equal(generated.status, "complete");
  assert.equal(viewed?.type, "tool-call");
  if (viewed?.type !== "tool-call") throw new Error("Expected image view");
  assert.equal(presentToolActivity(viewed).summary, "Viewed an image");
  assert.equal(presentToolActivity(viewed).grouping, "standalone");
  assert.equal(presentToolActivity(viewed).canExpand, true);
  assert.deepEqual(aggregateToolCallStatistics(blocks), {
    totalCount: 2,
    failedCount: 0,
    commandCount: 0,
    patchCount: 0,
    mcpCount: 0,
    dynamicCount: 0,
    webSearchCount: 0,
    subagentCount: 0,
    imageGenerationCount: 1,
    imageViewCount: 1,
    sleepCount: 0,
    durationCount: 0,
    durationSumMs: 0,
    durationMaxMs: 0,
  });

  const pending = projectTimeline(source([{
    id: "turn-pending-image",
    status: "streaming",
    items: [{ id: "pending", type: "imageGeneration", payload: { src: null, status: "in_progress" } }],
  }]), createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  assert.equal(pending?.type, "image");
  if (pending?.type === "image") {
    assert.equal(pending.uri, null);
    assert.equal(pending.status, "running");
  }
});

test("standalone image view and empty Web Search preserve Codex render topology", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-tool-topology",
    status: "complete",
    items: [
      { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed", exitCode: 0 } },
      { id: "empty-search", type: "webSearch", payload: { query: "" } },
      { id: "image-view", type: "imageView", payload: { path: "/workspace/result.png" } },
      { id: "command-2", type: "commandExecution", payload: { command: "ls", status: "completed", exitCode: 0 } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.deepEqual(units.map((unit) => unit.type), ["agent-activity"]);
  const contentUnits = units[0]?.type === "agent-activity" ? units[0].contentUnits : [];
  assert.deepEqual(contentUnits.map((unit) => unit.type), ["standalone", "standalone", "standalone"]);
  assert.equal(contentUnits[1]?.type === "standalone" ? contentUnits[1].block.type : null, "tool-call");
  assert.equal(contentUnits[1]?.type === "standalone" && contentUnits[1].block.type === "tool-call" ? contentUnits[1].block.kind : null, "image-view");
  assert.equal(contentUnits.some((unit) => unit.type === "standalone" && unit.block.type === "tool-call" && unit.block.kind === "web-search"), false);
});

test("approved automatic review is topology-transparent between tool rows", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-approved-review-topology",
    status: "complete",
    items: [
      { id: "command-a", type: "commandExecution", payload: { command: "pwd", status: "completed", exitCode: 0 } },
      {
        id: "review-approved",
        type: "automaticApprovalReview",
        payload: {
          status: "approved",
          reviewId: "review-approved",
          startedAtMs: 10,
          completedAtMs: 20,
          action: { type: "command", command: "pwd" },
        },
      },
      { id: "command-b", type: "commandExecution", payload: { command: "ls", status: "completed", exitCode: 0 } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.equal(units.length, 1);
  assert.equal(units[0]?.type, "agent-activity");
  assert.deepEqual(units[0]?.type === "agent-activity" ? units[0].blocks.map((block) => block.type) : [], [
    "command-execution",
    "command-execution",
  ]);
});

test("command failure follows exit code even when transport status completed", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-command-failure",
    status: "complete",
    items: [{
      id: "exec-failed",
      type: "commandExecution",
      payload: { command: "false", status: "completed", exitCode: 1, durationMs: 10 },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "command-execution");
  if (block?.type !== "command-execution") throw new Error("Expected command block");
  assert.equal(presentToolActivity(block).state, "failed");
  // Codex keeps the completed action wording and communicates failure through
  // row status plus the shell footer's exit code.
  assert.equal(presentToolActivity(block).summary, "Ran command");
  assert.equal(formatCommandActivitySummary(block, "failed", { expanded: false, elapsedLabel: null }), "Ran false");
});

test("command labels reproduce Codex disclosure, elapsed, date, and background terminal states", () => {
  const projected = projectTimeline(source([{
    id: "turn-command-labels",
    status: "complete",
    items: [
      { id: "normal", type: "commandExecution", payload: { command: "npm test", status: "completed", durationMs: 62_000 } },
      { id: "background-running", type: "commandExecution", payload: { command: "npm run dev", processId: "pty-1", status: "inProgress" } },
      { id: "background-finished", type: "commandExecution", payload: { command: "npm run build", processId: "pty-2", status: "completed" } },
      { id: "date", type: "commandExecution", payload: { command: "/bin/date -u", status: "completed", durationMs: 1_500 } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = projected.frames.flatMap((frame) => frame.blocks).filter((block): block is Extract<TimelineBlock, { type: "command-execution" }> => block.type === "command-execution");
  assert.equal(formatCodexToolDuration(999), null);
  assert.equal(formatCodexToolDuration(62_000), "1m 2s");
  assert.equal(formatCommandActivitySummary(blocks[0]!, "completed", { expanded: false, elapsedLabel: "1m 2s" }), "Ran npm test in 1m 2s");
  assert.equal(formatCommandActivitySummary(blocks[0]!, "completed", { expanded: true, elapsedLabel: "1m 2s" }), "Ran command in 1m 2s");
  assert.equal(formatCommandActivitySummary(blocks[1]!, "running", { expanded: true, elapsedLabel: "9s" }), "Started background terminal with npm run dev");
  assert.equal(formatCommandActivitySummary(blocks[2]!, "completed", { expanded: false, elapsedLabel: "9s" }), "Ran npm run build");
  assert.equal(formatCommandActivitySummary(blocks[3]!, "completed", { expanded: false, elapsedLabel: "1s" }), "Checked the current date and time in 1s");
});

test("Codex command actions and patch diffs survive projection for semantic Activity rows", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-semantic-exec",
    status: "complete",
    items: [
      {
        id: "exec-read",
        type: "commandExecution",
        payload: {
          command: "sed -n '1,20p' src/app.ts",
          commandActions: [{ type: "read", command: "sed", name: "app.ts", path: "src/app.ts" }],
          status: "completed",
        },
      },
      {
        id: "patch-update",
        type: "fileChange",
        payload: {
          status: "completed",
          changes: [{ path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }],
        },
      },
      {
        id: "exec-search",
        type: "commandExecution",
        payload: {
          command: "rg TODO src",
          commandActions: [{ type: "search", command: "rg", query: "TODO", path: "src" }],
          status: "inProgress",
        },
      },
      {
        id: "exec-list",
        type: "commandExecution",
        payload: {
          command: "find src -maxdepth 1",
          commandActions: [{ type: "listFiles", command: "find", path: "src" }],
          status: "completed",
        },
      },
      {
        id: "exec-stopped",
        type: "commandExecution",
        payload: {
          command: "sleep 20",
          commandActions: [{ type: "unknown", command: "sleep" }],
          status: "interrupted",
        },
      },
      {
        id: "exec-read-running",
        type: "commandExecution",
        payload: {
          command: "cat src/live.ts",
          commandActions: [{ type: "read", command: "cat", name: "live.ts", path: "src/live.ts" }],
          status: "inProgress",
        },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const command = blocks[0];
  const patch = blocks[1];
  const search = blocks[2];
  assert.equal(command?.type, "command-execution");
  assert.equal(patch?.type, "patch");
  if (command?.type !== "command-execution" || patch?.type !== "patch") throw new Error("Expected semantic blocks");
  assert.equal(presentToolActivity(command).summary, "Read");
  assert.equal(presentToolActivity(command).detail, "app.ts");
  assert.equal(presentToolActivity(command).icon, "read");
  assert.equal(search?.type, "command-execution");
  if (search?.type === "command-execution") {
    assert.equal(presentToolActivity(search).summary, "Searching");
    assert.equal(presentToolActivity(search).detail, "for TODO in src");
    assert.equal(presentToolActivity(search).icon, "search");
  }
  const list = blocks[3];
  const stopped = blocks[4];
  assert.equal(list?.type === "command-execution" ? presentToolActivity(list).icon : null, "files");
  assert.equal(stopped?.type === "command-execution" ? presentToolActivity(stopped).icon : null, "stop");
  const runningRead = blocks[5];
  assert.equal(runningRead?.type === "command-execution" ? isVisibleAgentActivityRow(runningRead) : true, false);
  if (runningRead?.type !== "command-execution") throw new Error("Expected running read command");
  const assistantFrame = snapshot.frames[0];
  if (assistantFrame?.type !== "assistant") throw new Error("Expected assistant frame");
  const restoredRunningRead = createAssistantTurnPresentationPlan({ ...assistantFrame, blocks: [runningRead] }).slots;
  assert.equal(restoredRunningRead[0]?.type, "agent-activity");
  if (restoredRunningRead[0]?.type !== "agent-activity") throw new Error("Expected retrospective Activity summary");
  const restoredRunningGroup = restoredRunningRead[0].contentUnits[0];
  assert.equal(restoredRunningGroup?.type, "group");
  if (restoredRunningGroup?.type !== "group") throw new Error("Expected grouped running read");
  assert.equal(restoredRunningGroup.lifecycle.isActivitySliceClosed, true);
  assert.equal(deriveAgentActivityHeaderPresentation(restoredRunningGroup).state, "summary");
  assert.equal(restoredRunningGroup.blocks.filter((block) => isVisibleAgentActivityRow(block)).length, 0);
  assert.deepEqual(patch.changes[0], {
    path: "src/app.ts",
    kind: "modify",
    additions: 1,
    deletions: 1,
    unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
    movePath: null,
  });
});

test("multi-action command Items fan out into source-faithful exec rows without duplicating provenance", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-multi-action-command",
    status: "complete",
    items: [{
      id: "multi-action-command",
      type: "commandExecution",
      payload: {
        command: "sed -n '1,10p' src/a.ts && rg TODO src",
        status: "completed",
        aggregatedOutput: "src/a.ts:1:TODO",
        exitCode: 0,
        commandActions: [
          { type: "read", command: "sed -n '1,10p' src/a.ts", name: "a.ts", path: "src/a.ts" },
          { type: "search", command: "rg TODO src", query: "TODO", path: "src" },
        ],
        automaticApprovalReviews: [{
          id: "multi-action-review",
          status: "denied",
          startedAtMs: 10,
          completedAtMs: 12,
          action: { type: "command", command: "sed -n '1,10p' src/a.ts && rg TODO src" },
        }],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames[0]?.blocks ?? [];
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => block.type === "command-execution" ? {
    id: block.id,
    callId: block.callId,
    command: block.command,
    action: block.actions[0]?.type,
    reviewCount: block.automaticApprovalReviews.length,
    sourceItemIds: block.sourceItemIds,
  } : null), [
    {
      id: "command-execution:multi-action-command:0",
      callId: "multi-action-command:0",
      command: "sed -n '1,10p' src/a.ts",
      action: "read",
      reviewCount: 1,
      sourceItemIds: ["multi-action-command"],
    },
    {
      id: "command-execution:multi-action-command:1",
      callId: "multi-action-command:1",
      command: "rg TODO src",
      action: "search",
      reviewCount: 0,
      sourceItemIds: ["multi-action-command"],
    },
  ]);
  assert.equal(snapshot.frames[0]?.anchors.filter((anchor) => anchor.type === "item").length, 1);
});

test("Codex app tools use recovered labels and standalone grouping", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-codex-tools",
    status: "streaming",
    items: [
      {
        id: "list-threads",
        type: "dynamicToolCall",
        payload: { namespace: "codex_app", tool: "list_threads", status: "inProgress", arguments: {} },
      },
      {
        id: "handoff-thread",
        type: "dynamicToolCall",
        payload: {
          namespace: "codex_app",
          tool: "handoff_thread",
          status: "completed",
          success: true,
          arguments: { threadId: "thread-child", destinationHostId: "ssh:one" },
        },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const list = blocks[0];
  const handoff = blocks[1];
  assert.equal(list?.type, "tool-call");
  assert.equal(handoff?.type, "tool-call");
  if (list?.type !== "tool-call" || handoff?.type !== "tool-call") throw new Error("Expected tool calls");
  assert.deepEqual(presentToolActivity(list), {
    state: "running",
    grouping: "groupable",
    icon: "agent",
    summary: "Listing chats",
    detail: null,
    canExpand: false,
    durationMs: null,
    summaryKey: "codex_app:list_threads",
    continuesLiveActivityBetweenCalls: true,
    summaryOnlyInConversationGroup: false,
  });
  assert.equal(presentToolActivity(handoff).summary, "Handed off chat");
  assert.equal(presentToolActivity(handoff).grouping, "standalone");
  assert.equal(presentToolActivity(handoff).summaryKey, "codex_app:handoff_thread:thread-child:ssh:one");

  const worktree = projectTimeline(source([{
    id: "turn-worktree",
    status: "complete",
    items: [{
      id: "fork-worktree",
      type: "dynamicToolCall",
      payload: {
        namespace: "codex_app",
        tool: "fork_thread",
        status: "completed",
        success: true,
        arguments: { environment: { type: "worktree" } },
      },
    }],
  }]), createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  assert.equal(worktree?.type === "tool-call" ? presentToolActivity(worktree).summary : null, "Forked chat in new worktree");

  const created = projectTimeline(source([{
    id: "turn-created-thread",
    status: "complete",
    items: [{
      id: "create-thread",
      type: "dynamicToolCall",
      payload: {
        namespace: "codex_app",
        tool: "create_thread",
        status: "completed",
        success: true,
        arguments: { prompt: "Review the UI", target: { type: "project" } },
        contentItems: [{ type: "inputText", text: JSON.stringify({ clientThreadId: "client-thread-1", hostId: "ssh:one" }) }],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  assert.equal(created?.type, "tool-call");
  if (created?.type !== "tool-call") throw new Error("Expected created thread tool call");
  assert.deepEqual(createdThreadToolResult(created), {
    kind: "codex",
    threadId: "client-thread-1",
    hostId: "ssh:one",
    pending: true,
    title: "Worktree chat",
  });

  const threadTargets = projectTimeline(source([{
    id: "turn-thread-targets",
    status: "complete",
    items: [
      { id: "read-thread", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "read_thread", status: "completed", success: true, arguments: { threadId: "thread-read" } } },
      { id: "send-thread", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "send_message_to_thread", status: "completed", success: true, arguments: { thread_id: "thread-send", message: "Continue" } } },
    ],
  }]), createDefaultTimelineProjectorRegistry()).frames.flatMap((frame) => frame.blocks);
  assert.equal(threadTargets[0]?.type, "tool-call");
  assert.equal(threadTargets[1]?.type, "tool-call");
  if (threadTargets[0]?.type !== "tool-call" || threadTargets[1]?.type !== "tool-call") throw new Error("Expected thread tool calls");
  assert.equal(isCodexAppThreadTool(threadTargets[0]), true);
  assert.deepEqual(codexAppThreadNavigationTarget(threadTargets[0]), { threadId: "thread-read", displayName: "Chat" });
  assert.deepEqual(codexAppThreadNavigationTarget(threadTargets[1]), { threadId: "thread-send", displayName: "Chat" });

  const handoffStatus = projectTimeline(source([{
    id: "turn-handoff-status",
    status: "complete",
    items: [{
      id: "handoff-status",
      type: "dynamicToolCall",
      payload: {
        namespace: "codex_app",
        tool: "get_handoff_status",
        status: "completed",
        success: true,
        arguments: { operationId: "handoff-7" },
        contentItems: [{ type: "inputText", text: JSON.stringify({
          operationId: "handoff-7",
          status: "warning",
          threadTitle: "Review the UI",
          destinationHostDisplayName: "Build Mac",
          destinationHostId: "ssh:build",
          destinationThreadId: "thread-build",
          destinationCwd: "/workspace/build",
          revision: 4,
          direction: "to-host-worktree",
          sourceBranch: "main",
          worktreeBranch: "review-ui",
          warningMessage: "The target setup script needs attention.",
          retryable: true,
          steps: [
            { id: "prepare-host-transfer", status: "done" },
            { id: "transfer-host-artifacts", status: "failed" },
            { id: "create-new-worktree", status: "pending" },
          ],
        }) }],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry()).frames[0]?.blocks[0];
  assert.equal(handoffStatus?.type === "tool-call" ? presentToolActivity(handoffStatus).summary : null, "Handoff to Build Mac needs attention");
  if (handoffStatus?.type !== "tool-call") throw new Error("Expected handoff status tool call");
  assert.equal(presentToolActivity(handoffStatus).state, "completed");
  assert.equal(presentToolActivity(handoffStatus).summaryOnlyInConversationGroup, true);
  assert.equal(isVisibleAgentActivityRow(handoffStatus), false);
  const handoffResult = threadHandoffToolResult(handoffStatus);
  assert.equal(handoffResult?.destinationThreadId, "thread-build");
  assert.equal(handoffResult?.revision, 4);
  assert.equal(handoffResult?.retryable, true);
  assert.deepEqual(handoffResult === null ? [] : visibleThreadHandoffSteps(handoffResult), [
    { id: "prepare-host-transfer", status: "done" },
    { id: "transfer-host-artifacts", status: "failed" },
    { id: "rolling-back-changes", status: "running" },
  ]);
  assert.equal(handoffResult === null ? null : formatThreadHandoffStepLabel("switching-thread", handoffResult), "Moving chat to the destination worktree");
});

test("registered Codex thread tools reject malformed arguments without a generic fallback row", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-invalid-codex-tools",
    status: "complete",
    items: [
      { id: "fork", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "fork_thread", status: "failed", success: false, arguments: null } },
      { id: "create", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "create_thread", status: "failed", success: false, arguments: { prompt: "missing target" } } },
      { id: "handoff", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "handoff_thread", status: "failed", success: false, arguments: { threadId: "" } } },
      { id: "poll", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "get_handoff_status", status: "failed", success: false, arguments: {} } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const blocks = frame.blocks.filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.deepEqual(blocks.map((block) => isToolActivityPresentationSuppressed(block)), [true, true, true, true]);
  assert.deepEqual(createAssistantTurnPresentationPlan(frame).slots, []);
});

test("tool call transport envelopes become typed renderer-neutral content", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-tool-content",
    status: "complete",
    items: [{
      id: "tool-content",
      type: "mcpToolCall",
      payload: {
        server: "media",
        tool: "inspect",
        status: "completed",
        arguments: { assetId: "asset-1" },
        result: {
          content: [
            { type: "text", text: "Ready", annotations: { audience: ["assistant"], priority: 0.8, lastModified: "2026-08-30" } },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png", name: "preview" },
            { type: "resource_link", uri: "resource://asset-1", name: "Artifact", mimeType: "text/plain" },
            { type: "embedded_resource", resource: { uri: "resource://log", mimeType: "text/plain", text: "trace", annotations: { audience: ["user"] } } },
            { type: "future_content", payload: { enabled: true } },
          ],
          structuredContent: { width: 120 },
          _meta: { hidden: true },
        },
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "tool-call");
  if (block?.type !== "tool-call") throw new Error("Expected tool call");
  assert.deepEqual(extractToolCallContentParts(block), [
    { kind: "json", role: "input", value: { assetId: "asset-1" } },
    { kind: "text", role: "output", text: "Ready", annotations: { audience: ["assistant"], priority: 0.8, lastModified: "2026-08-30" } },
    { kind: "image", role: "output", source: "data:image/png;base64,aGVsbG8=", alt: "preview" },
    { kind: "resource-link", role: "output", uri: "resource://asset-1", name: "Artifact", mimeType: "text/plain" },
    { kind: "embedded-resource", role: "output", uri: "resource://log", mimeType: "text/plain", content: "trace", annotations: { audience: ["user"], priority: null, lastModified: null } },
    { kind: "unknown", role: "output", value: { type: "future_content", payload: { enabled: true } } },
    { kind: "json", role: "output", value: { width: 120 } },
  ]);
  assert.equal(presentToolActivity(block).canExpand, true);
});

test("MCP JSON text is promoted and deduplicated exactly like Codex", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-mcp-json",
    status: "complete",
    items: [
      { id: "json-text", type: "mcpToolCall", payload: { server: "data", tool: "read", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: null, _meta: null } } },
      { id: "duplicate", type: "mcpToolCall", payload: { server: "data", tool: "read", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "{\"ok\":true}" }], structuredContent: { ok: true }, _meta: null } } },
      { id: "empty-structured", type: "mcpToolCall", payload: { server: "data", tool: "read", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "{}" }], structuredContent: {}, _meta: null } } },
      { id: "annotated", type: "mcpToolCall", payload: { server: "data", tool: "read", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "{\"ok\":true}", annotations: { audience: ["assistant"] } }], structuredContent: { ok: true }, _meta: null } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks).filter((block): block is Extract<TimelineBlock, { type: "tool-call" }> => block.type === "tool-call");
  assert.deepEqual(extractToolCallContentParts(blocks[0]!).filter((part) => part.role === "output"), [{ kind: "json", role: "output", value: { ok: true } }]);
  assert.deepEqual(extractToolCallContentParts(blocks[1]!).filter((part) => part.role === "output"), [{ kind: "json", role: "output", value: { ok: true } }]);
  assert.deepEqual(extractToolCallContentParts(blocks[2]!).filter((part) => part.role === "output"), [{ kind: "json", role: "output", value: {} }]);
  assert.deepEqual(extractToolCallContentParts(blocks[3]!).filter((part) => part.role === "output"), [
    { kind: "text", role: "output", text: "{\"ok\":true}", annotations: { audience: ["assistant"], priority: null, lastModified: null } },
    { kind: "json", role: "output", value: { ok: true } },
  ]);
});

test("Agent Activity reproduces active labels and deterministic completed summary order", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-activity-summary",
    status: "complete",
    durationMs: 64_000,
    items: [
      { id: "read", type: "commandExecution", payload: { command: "sed app.ts", commandActions: [{ type: "read", path: "app.ts", name: "app.ts", command: "sed" }], status: "completed" } },
      { id: "run", type: "commandExecution", payload: { command: "npm test", status: "completed" } },
      { id: "patch", type: "fileChange", payload: { status: "completed", changes: [{ path: "app.ts", kind: "update" }, { path: "style.css", kind: "update" }] } },
      { id: "mcp", type: "mcpToolCall", payload: { server: "github", tool: "search", status: "completed", result: {} } },
      { id: "web", type: "webSearch", payload: { query: "Codex activity" } },
      { id: "list", type: "dynamicToolCall", payload: { namespace: "codex_app", tool: "list_threads", status: "completed", success: true } },
      { id: "answer", type: "agentMessage", payload: { text: "Done", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const unit = createAssistantTurnPresentationPlan(frame).slots[0];
  if (unit?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.equal(unit.workedDurationMs, 64_000);
  const completedHeader = activityHeaderFor(unit.blocks, unit.status);
  assert.equal(completedHeader.state, "summary");
  assert.equal(completedHeader.summaryKey, "summary");
  assert.equal(completedHeader.icon, "wrench");
  assert.equal(agentActivityHeaderAccessibleLabel(completedHeader.summary),
    "Used GitHub integration, edited files, read files, ran a command, searched the web, and listed chats");
  assert.deepEqual(completedHeader.summary.kind === "parts"
    ? completedHeader.summary.parts.map((part) => part.kind)
    : [], ["sources", "files", "exploration", "commands", "web-search", "dynamic"]);

  const active = projectTimeline(source([{
    id: "turn-active-search",
    status: "streaming",
    items: [{ id: "web-live", type: "webSearch", payload: { query: "Replica protocol", action: { type: "search", query: "Replica protocol" } } }],
  }]), createDefaultTimelineProjectorRegistry()).frames[0]?.blocks ?? [];
  assert.deepEqual(activityHeaderFor(active, "streaming"), {
    state: "active",
    summaryKey: "active:tool-call:web-live",
    icon: "browser",
    summary: { kind: "text", text: "Searching the web for Replica protocol" },
    active: true,
  });
  const web = active[0];
  assert.equal(web?.type, "tool-call");
  if (web?.type === "tool-call") {
    const presentation = presentToolActivity(web);
    assert.equal(web.status, "running");
    assert.equal(presentation.detail, "for Replica protocol");
    assert.equal(presentation.canExpand, false);
  }
});

test("Web Search action details match Codex search, open-page, and find-in-page labels", () => {
  const blocks = projectTimeline(source([{
    id: "turn-web-actions",
    status: "complete",
    items: [
      { id: "search", type: "webSearch", payload: { query: "fallback", action: { type: "search", query: "replica site:openai.com OR site:github.com" } } },
      { id: "multi", type: "webSearch", payload: { query: "fallback", action: { type: "search", queries: ["first query", "second query"] } } },
      { id: "open", type: "webSearch", payload: { query: "fallback", action: { type: "openPage", url: "https://openai.com/codex" } } },
      { id: "find", type: "webSearch", payload: { query: "fallback", action: { type: "findInPage", pattern: "resume", url: "https://openai.com/codex" } } },
    ],
  }]), createDefaultTimelineProjectorRegistry()).frames.flatMap((frame) => frame.blocks);
  const details = blocks.map((block) => block.type === "tool-call" ? presentToolActivity(block).detail : null);
  assert.deepEqual(blocks.map((block) => block.type === "tool-call" ? presentToolActivity(block).icon : null), [
    "browser", "browser", "browser", "browser",
  ]);
  assert.deepEqual(details, [
    "for replica | openai.com · github.com",
    "for first query ...",
    "for https://openai.com/codex",
    "for 'resume' in https://openai.com/codex",
  ]);
});

test("collaboration and clock tools retain native Codex semantics", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-native-tools",
    status: "complete",
    items: [
      {
        id: "spawn",
        type: "collabAgentToolCall",
        payload: {
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "thread-root",
          receiverThreadIds: ["thread-agent"],
          prompt: "Audit the renderer",
          model: "gpt-5.2-codex",
          reasoningEffort: "high",
          agentsStates: { "thread-agent": { status: "completed" } },
        },
      },
      { id: "sleep", type: "sleep", payload: { durationMs: 2_000 } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  const spawn = blocks[0];
  const sleep = blocks[1];
  assert.equal(spawn?.type, "subagent");
  if (spawn?.type !== "subagent") throw new Error("Expected collaboration tool");
  assert.equal(spawn.tool, "spawnAgent");
  assert.equal(spawn.agentId, "thread-agent");
  assert.equal(spawn.prompt, "Audit the renderer");
  assert.equal(presentToolActivity(spawn).summary, "Created");
  assert.equal(presentToolActivity(spawn).grouping, "standalone");
  assert.deepEqual(deriveSubagentActivityPresentation(spawn), {
    actionLabel: "Created",
    agents: [{
      displayName: "Agent",
      displayStatus: "done",
      model: "gpt-5.2-codex",
      role: null,
      status: "done",
      statusLabel: "completed",
      statusMessage: null,
      threadId: "thread-agent",
    }],
    expandable: true,
    groupStatusLabel: "finished",
  });
  assert.equal(sleep?.type, "tool-call");
  if (sleep?.type !== "tool-call") throw new Error("Expected clock tool");
  assert.equal(presentToolActivity(sleep).summary, "Waited");
  assert.equal(presentToolActivity(sleep).durationMs, 2_000);
  assert.equal(presentToolActivity(sleep).canExpand, false);
  const assistantFrame = snapshot.frames.find((frame) => frame.type === "assistant");
  if (assistantFrame?.type !== "assistant") throw new Error("Expected assistant frame");
  assert.equal(createAssistantTurnPresentationPlan({ ...assistantFrame, blocks: [sleep] }).slots.length, 0);
});

test("consecutive collaboration calls aggregate by stable child Thread identity", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-agent-run",
    status: "complete",
    items: [
      { id: "spawn-a", type: "collabAgentToolCall", payload: { tool: "spawnAgent", status: "completed", receiverThreadIds: ["agent-a"], prompt: "Audit UI", agentsStates: { "agent-a": { status: "running", displayName: "UI auditor" } } } },
      { id: "message-a", type: "collabAgentToolCall", payload: { tool: "sendInput", status: "completed", receiverThreadIds: ["agent-a"], prompt: "Check motion", agentsStates: { "agent-a": { status: "running" } } } },
      { id: "spawn-b", type: "collabAgentToolCall", payload: { tool: "spawnAgent", status: "completed", receiverThreadIds: ["agent-b"], prompt: "Audit tools", agentsStates: { "agent-b": { status: "completed", displayName: "Tool auditor" } } } },
      { id: "wait", type: "collabAgentToolCall", payload: { tool: "wait", status: "completed", receiverThreadIds: ["agent-a", "agent-b"], agentsStates: { "agent-a": { status: "completed" }, "agent-b": { status: "completed" } } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const blocks = frame.blocks.filter((block) => block.type === "subagent");
  const presentation = deriveSubagentActivityGroupPresentation(blocks);
  assert.deepEqual(presentation.agents.map((agent) => [agent.threadId, agent.displayName, agent.status]), [
    ["agent-a", "UI auditor", "done"],
    ["agent-b", "Tool auditor", "done"],
  ]);
  assert.equal(presentation.actionLabel, "Finished waiting for");
  assert.equal(presentation.groupStatusLabel, "finished");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.equal(units.length, 1);
  assert.equal(units[0]?.type, "agent-activity");
  assert.equal(units[0]?.type === "agent-activity" ? units[0].inlineSubagentActivity?.blocks.length : 0, 4);
});

test("unified diff projection preserves line numbers and highlights paired edits", () => {
  const lines = parseUnifiedDiff([
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -8,3 +8,3 @@",
    " const stable = true;",
    "-const answer = 41;",
    "+const answer = 42;",
    " export { answer };",
  ].join("\n"));
  const deletion = lines.find((line) => line.kind === "deletion");
  const addition = lines.find((line) => line.kind === "addition");
  assert.equal(deletion?.oldLine, 9);
  assert.equal(deletion?.newLine, null);
  assert.equal(addition?.oldLine, null);
  assert.equal(addition?.newLine, 9);
  assert.deepEqual(deletion?.oldSegments?.filter((segment) => segment.changed).map((segment) => segment.text), ["1"]);
  assert.deepEqual(addition?.newSegments?.filter((segment) => segment.changed).map((segment) => segment.text), ["2"]);
});

test("tool presentation registry is priority ordered and reversibly extensible", () => {
  const registry = createDefaultToolActivityPresenterRegistry();
  let publications = 0;
  const unsubscribe = registry.subscribe(() => { publications += 1; });
  const versionBeforeRegistration = registry.getSnapshot();
  const remove = registry.register({
    name: "fixture-tool",
    priority: 1_000,
    matches: (block) => block.namespace === "fixture",
    present: (block, state) => ({
      state,
      grouping: "standalone",
      icon: "wrench",
      summary: "Fixture rendered",
      detail: null,
      canExpand: false,
      durationMs: block.durationMs,
      summaryKey: "fixture",
      continuesLiveActivityBetweenCalls: false,
      summaryOnlyInConversationGroup: false,
    }),
  });
  assert.equal(publications, 1);
  assert.equal(registry.getSnapshot(), versionBeforeRegistration + 1);
  const registryTypeCheck: ToolActivityPresenterRegistry = registry;
  assert.equal(registryTypeCheck, registry);
  const snapshot = projectTimeline(source([{
    id: "turn-fixture-tool",
    status: "complete",
    items: [{
      id: "fixture-tool",
      type: "dynamicToolCall",
      payload: { namespace: "fixture", tool: "inspect", status: "completed", success: true },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  const block = frame?.blocks[0];
  assert.equal(block?.type, "tool-call");
  if (block?.type !== "tool-call") throw new Error("Expected tool call");
  assert.equal(presentToolActivity(block, registry).summary, "Fixture rendered");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const registeredUnits = createAssistantTurnPresentationPlan(frame, registry).slots;
  assert.equal(registeredUnits[0]?.type, "agent-activity");
  assert.equal(registeredUnits[0]?.type === "agent-activity" ? registeredUnits[0].contentUnits[0]?.type : null, "standalone");
  remove();
  assert.equal(publications, 2);
  unsubscribe();
  assert.equal(presentToolActivity(block, registry).summary, "Inspect");
  assert.equal(createAssistantTurnPresentationPlan(frame, registry).slots[0]?.type, "agent-activity");
});

test("unknown AppServer Item types remain visible and never break the projection", () => {
  const payload = { newProtocolField: true };
  const snapshot = projectTimeline(source([{
    id: "turn-unknown",
    status: "complete",
    items: [{ id: "item-unknown", type: "futureCodexItem", payload }],
  }]), createDefaultTimelineProjectorRegistry());

  assert.equal(snapshot.frames[0]?.type, "event");
  assert.deepEqual(snapshot.frames[0]?.blocks[0], {
    type: "unknown",
    id: "unknown:item-unknown",
    sourceItemIds: [asItemId("item-unknown")],
    itemType: "futureCodexItem",
    payload,
  });
});

test("interaction Items are separated from the assistant response and retain request anchors", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-interaction",
    status: "streaming",
    items: [
      { id: "command-1", type: "commandExecution", payload: { command: "npm test", status: "inProgress" } },
      {
        id: "approval-1",
        type: "permissionRequest",
        payload: { requestId: "rpc-44", itemId: "command-1", method: "item/commandExecution/requestApproval", title: "Run command", command: "npm test" },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());

  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["assistant", "interaction"]);
  assert.equal(snapshot.frames[1]?.blocks[0]?.type, "approval");
  assert.equal(snapshot.anchorFrameIds.get("request:rpc-44"), snapshot.frames[1]?.id);
  const attached = indexAttachedInteractions(snapshot.frames);
  assert.equal(attached.get("command-1")?.[0]?.requestId, "rpc-44");
  assert.equal(attached.get("command-1")?.[0]?.method, "item/commandExecution/requestApproval");
  assert.equal(findPendingInteraction(snapshot)?.requestId, "rpc-44");
});

test("Composer request selection is newest-first and ignores settled interactions", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-request-order",
    status: "streaming",
    items: [
      { id: "approved", type: "interaction:approval", payload: { requestId: "rpc-old", title: "Old", state: "accepted" } },
      { id: "question", type: "interaction:question", payload: { requestId: "rpc-question", state: "pending", questions: [{ id: "q", question: "Choose", options: [] }] } },
      { id: "elicitation", type: "interaction:elicitation", payload: { requestId: "rpc-new", state: "pending", method: "mcpServer/elicitation/request", message: "Continue", mode: "form" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());

  assert.equal(findPendingInteraction(snapshot)?.requestId, "rpc-new");
  assert.equal(findPendingInteraction({
    frames: snapshot.frames.map((frame) => ({
      ...frame,
      blocks: frame.blocks.map((block) => block.type === "elicitation" ? { ...block, state: "accepted" as const } : block),
    })),
  })?.requestId, "rpc-question");
});

test("request_option_picker is a distinct Composer-owned interaction", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-option-picker",
    status: "streaming",
    items: [{
      id: "picker",
      type: "interaction:option-picker",
      payload: {
        requestId: "rpc-picker",
        method: "item/tool/call",
        itemId: "call-picker",
        question: "Choose targets",
        options: [
          { id: "Web", label: "Web", description: "Browser" },
          { id: "iOS", label: "iOS", description: null },
        ],
        allowMultiple: true,
        submitLabel: "Continue",
        skipLabel: "Later",
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "option-picker");
  if (block?.type !== "option-picker") return;
  assert.equal(block.question, "Choose targets");
  assert.equal(block.allowMultiple, true);
  assert.equal(block.submitLabel, "Continue");
  assert.deepEqual(block.options.map((option) => option.label), ["Web", "iOS"]);
  assert.equal(findPendingInteraction(snapshot)?.requestId, "rpc-picker");
  assert.equal(indexAttachedInteractions(snapshot.frames).get("call-picker")?.[0]?.type, "option-picker");
});

test("Codex setup requests remain distinct Composer-owned interaction blocks", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-setup",
    status: "streaming",
    items: [
      { id: "role", type: "interaction:setup-codex-step", payload: { requestId: "rpc-role", method: "item/tool/call", itemId: "role-call", step: "role" } },
      { id: "context", type: "interaction:setup-context-picker", payload: { requestId: "rpc-context", method: "item/tool/requestSetupCodexContextPicker", itemId: "context-call" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks);
  assert.deepEqual(blocks.map((block) => block.type), ["setup-codex-step", "setup-context-picker"]);
  const context = blocks[1];
  assert.equal(context?.type, "setup-context-picker");
  if (context?.type === "setup-context-picker") assert.equal(context.method, "item/tool/requestSetupCodexContextPicker");
  assert.equal(findPendingInteraction(snapshot)?.requestId, "rpc-context");
  assert.equal(indexAttachedInteractions(snapshot.frames).get("role-call")?.[0]?.type, "setup-codex-step");
});

test("request_user_input preserves every question and aggregates Codex-compatible answers", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-questions",
    status: "streaming",
    items: [{
      id: "request-questions",
      type: "interaction:question",
      payload: {
        requestId: "rpc-questions",
        method: "item/tool/requestUserInput",
        questions: [
          {
            id: "environment",
            header: "Environment",
            prompt: "Where should this run?",
            options: [{ id: "Staging", label: "Staging", description: "Safe preview" }],
            isOther: false,
            isSecret: false,
          },
          {
            id: "note",
            header: "Notes",
            prompt: "Anything else?",
            options: [],
            isOther: true,
            isSecret: false,
          },
        ],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "question");
  if (block?.type !== "question") return;
  assert.deepEqual(block.questions.map((question) => [question.id, question.header, question.prompt]), [
    ["environment", "Environment", "Where should this run?"],
    ["note", "Notes", "Anything else?"],
  ]);
  const initial = createUserInputQuestionDrafts(block.questions);
  assert.equal(initial[0]?.selectedOptionId, "Staging");
  assert.deepEqual(aggregateUserInputQuestionAnswers(block.questions, [
    initial[0]!,
    { selectedOptionId: null, freeformText: "  notify QA  " },
  ]), {
    environment: ["Staging"],
    note: ["notify QA"],
  });
});

test("approval presentation keeps command, scope and permission details typed", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-approval-facts",
    status: "streaming",
    items: [{
      id: "approval-command",
      type: "interaction:approval",
      payload: {
        requestId: "rpc-command",
        approvalKind: "command",
        title: "Allow command?",
        command: "npm test",
        cwd: "/vela",
        reason: "Run verification",
        availableDecisions: ["accept", "decline"],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "approval");
  if (block?.type !== "approval") return;
  assert.deepEqual(presentApprovalRequest(block), {
    title: "Allow command?",
    subtitle: "npm test",
    description: null,
    details: [
      { label: "Reason", value: "Run verification" },
      { label: "Working directory", value: "/vela" },
    ],
    allowSession: false,
    allowOnce: true,
    allowDeny: true,
    allowAlways: false,
    approveLabel: "Allow once",
    identityLabel: "Terminal",
    leadingApproval: null,
    scopedApproval: null,
  });
});

test("command approval policy metadata produces Codex scoped and network actions", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-policy-approvals",
    status: "streaming",
    items: [
      {
        id: "exec-policy",
        type: "interaction:approval",
        payload: {
          requestId: "rpc-exec-policy",
          approvalKind: "command",
          title: "Allow ChatGPT to run this command?",
          command: "npm test",
          proposedExecpolicyAmendment: ["npm", "test"],
          availableDecisions: ["accept", "decline"],
        },
      },
      {
        id: "network-policy",
        type: "interaction:approval",
        payload: {
          requestId: "rpc-network-policy",
          approvalKind: "command",
          title: "Allow ChatGPT to connect to https://api.example.com?",
          command: "curl https://api.example.com/status",
          detail: "api.example.com isn't on the current network allowlist",
          networkApprovalContext: { host: "api.example.com", protocol: "https" },
          proposedNetworkPolicyAmendments: [{ host: "api.example.com", action: "allow" }],
          availableDecisions: ["accept", "acceptForSession", "decline"],
        },
      },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const blocks = snapshot.frames.flatMap((frame) => frame.blocks)
    .filter((block): block is Extract<TimelineBlock, { type: "approval" }> => block.type === "approval");
  assert.deepEqual(presentApprovalRequest(blocks[0]!).scopedApproval, {
    kind: "exec-policy",
    label: "Allow similar commands",
    info: "Allow commands that start with npm test for this conversation",
  });
  assert.deepEqual(presentApprovalRequest(blocks[1]!), {
    title: "Allow ChatGPT to connect to https://api.example.com?",
    subtitle: null,
    description: "api.example.com isn't on the current network allowlist",
    details: [],
    allowSession: true,
    allowOnce: true,
    allowDeny: true,
    allowAlways: false,
    approveLabel: "Allow once",
    identityLabel: "Internet access",
    leadingApproval: { kind: "network-policy", label: "Always allow" },
    scopedApproval: { kind: "session", label: "Allow this conversation", info: null },
  });
});

test("provider approval scopes project independently of Codex policy amendments", () => {
  for (const scopes of [["once", "deny"], ["once", "session", "always", "deny"], ["unknown"]]) {
    const snapshot = projectTimeline(source([{ id: "turn", status: "streaming", items: [{ id: "approval", type: "interaction:approval",
      payload: { requestId: "approval", approvalKind: "command", title: "Allow?", approvalScopes: scopes } }] }]), createDefaultTimelineProjectorRegistry());
    const block = snapshot.frames[0]?.blocks[0];
    assert.equal(block?.type, "approval"); if (block?.type !== "approval") continue;
    const presentation = presentApprovalRequest(block);
    assert.equal(presentation.allowOnce, scopes.includes("once"));
    assert.equal(presentation.allowDeny, scopes.includes("deny"));
    assert.equal(presentation.allowSession, scopes.includes("session"));
    assert.equal(presentation.allowAlways, scopes.includes("always"));
    assert.deepEqual(block.proposedExecpolicyAmendment, []);
  }
});

test("MCP elicitation forms normalize primitive schemas and validate typed content", () => {
  const fields = normalizeMcpElicitationSchema({
    type: "object",
    required: ["name", "retries", "environment"],
    properties: {
      name: { type: "string", title: "Name", minLength: 2 },
      retries: { type: "integer", minimum: 1, maximum: 5, default: 2 },
      enabled: { type: "boolean", default: true },
      environment: { type: "string", oneOf: [{ const: "stage", title: "Staging" }, { const: "prod", title: "Production" }] },
      tags: { type: "array", items: { type: "string", enum: ["safe", "fast"] }, default: ["safe"] },
    },
  });
  assert.deepEqual(fields.map((field) => [field.name, field.kind]), [
    ["name", "text"],
    ["retries", "number"],
    ["enabled", "boolean"],
    ["environment", "select"],
    ["tags", "multi-select"],
  ]);
  const initial = createMcpElicitationDraft(fields);
  assert.deepEqual(initial, { name: "", retries: "2", enabled: true, environment: "stage", tags: ["safe"] });
  assert.deepEqual(validateMcpElicitationDraft(fields, initial).errors, { name: "This field is required" });
  assert.deepEqual(validateMcpElicitationDraft(fields, { ...initial, name: "OpenCraft", retries: "3" }), {
    content: { name: "OpenCraft", retries: 3, enabled: true, environment: "stage", tags: ["safe"] },
    errors: {},
  });
});

test("MCP tool approval metadata keeps risk, connector, params and persistence scopes typed", () => {
  const metadata = normalizeMcpElicitationMetadata("form", {
    codex_approval_kind: "mcp_tool_call",
    connector_id: "github",
    connector_name: "GitHub",
    tool_name: "create_issue",
    tool_title: "Create issue",
    tool_params: { repo: "opencraft", labels: ["bug"] },
    tool_params_display: [
      { name: "repo", display_name: "Repository", value: "opencraft" },
      { name: "labels", display_name: "Labels", value: ["bug"] },
    ],
    persist: ["session", "always", "unsupported"],
    riskLevel: "high",
    subtitle: "Changes GitHub",
  });
  assert.deepEqual(metadata, {
    interactionKind: "tool-approval",
    riskLevel: "high",
    subtitle: "Changes GitHub",
    persist: ["session", "always"],
    toolApproval: {
      connectorId: "github",
      connectorName: "GitHub",
      toolName: "create_issue",
      toolTitle: "Create issue",
      toolParams: { repo: "opencraft", labels: ["bug"] },
      toolParamsDisplay: [
        { name: "repo", displayName: "Repository", value: "opencraft" },
        { name: "labels", displayName: "Labels", value: ["bug"] },
      ],
    },
    toolSuggestion: null,
    connectorAuth: null,
  });

  const snapshot = projectTimeline(source([{
    id: "turn-mcp-approval",
    status: "streaming",
    items: [{
      id: "mcp-approval",
      type: "interaction:elicitation",
      payload: {
        requestId: "rpc-mcp-approval",
        method: "mcpServer/elicitation/request",
        serverName: "github",
        message: "Allow GitHub to run tool \"create_issue\"?",
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_id: "github",
          connector_name: "GitHub",
          tool_name: "create_issue",
          tool_params: { repo: "opencraft" },
          persist: "session",
        },
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "elicitation");
  if (block?.type !== "elicitation") return;
  assert.equal(block.interactionKind, "tool-approval");
  assert.equal(block.toolApproval?.toolName, "create_issue");
  assert.deepEqual(block.persist, ["session"]);
});

test("MCP metadata distinguishes tool suggestions, connector auth and implicit computer approvals", () => {
  const suggestion = normalizeMcpElicitationMetadata("form", {
    codex_approval_kind: "tool_suggestion",
    suggest_type: "install",
    suggest_reason: "Use GitHub issues for this task",
    tool_id: "github",
    tool_name: "GitHub",
    tool_type: "connector",
    install_url: "https://example.com/install",
    persist: "always",
  });
  assert.equal(suggestion.interactionKind, "tool-suggestion");
  assert.deepEqual(suggestion.toolSuggestion, {
    suggestType: "install",
    suggestReason: "Use GitHub issues for this task",
    toolId: "github",
    toolName: "GitHub",
    toolType: "connector",
    installUrl: "https://example.com/install",
    remotePluginId: null,
    persistAlways: true,
  });

  const connectorAuth = normalizeMcpElicitationMetadata("url", {
    _codex_apps: { connector_auth_failure: {
      is_auth_failure: true,
      connector_id: "drive",
      connector_name: "Google Drive",
      install_url: "https://example.com/auth",
      auth_reason: "missing_link",
      requested_scopes: ["files.read"],
    } },
  }, { serverName: "codex_apps" });
  assert.equal(connectorAuth.interactionKind, "connector-auth");
  assert.equal(connectorAuth.connectorAuth?.connectorName, "Google Drive");
  assert.deepEqual(connectorAuth.connectorAuth?.requestedScopes, ["files.read"]);

  const computerUse = normalizeMcpElicitationMetadata("form", { persist: ["always"] }, {
    serverName: "computer-use",
    message: "Allow Codex to use Notes?",
    requestedSchema: { type: "object", properties: {} },
  });
  assert.equal(computerUse.interactionKind, "tool-approval");
  assert.deepEqual(computerUse.toolApproval?.toolParamsDisplay, [{ name: "app", displayName: "App", value: "Notes" }]);
});

test("MCP elicitation remains a distinct attached interaction with URL identity", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-elicitation",
    status: "streaming",
    items: [{
      id: "elicitation-one",
      type: "interaction:elicitation",
      payload: {
        requestId: "rpc-elicit",
        itemId: "tool-one",
        serverName: "github",
        message: "Authenticate to continue",
        mode: "url",
        url: "https://example.com/auth",
        elicitationId: "auth-one",
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "elicitation");
  if (block?.type !== "elicitation") return;
  assert.equal(block.url, "https://example.com/auth");
  assert.equal(block.elicitationId, "auth-one");
  assert.equal(indexAttachedInteractions(snapshot.frames).get("tool-one")?.[0]?.type, "elicitation");
});

test("projector registry supports deterministic priority overrides and reversible registration", () => {
  const registry = new TimelineProjectorRegistry();
  const removeLow = registry.register({
    name: "low",
    priority: 1,
    itemTypes: ["custom"],
    project(item) {
      return {
        lane: "event",
        block: {
          type: "compaction",
          id: "low",
          sourceItemIds: [asItemId(item.id)],
          summary: "low",
        },
      };
    },
  });
  const removeHigh = registry.register({
    name: "high",
    priority: 10,
    itemTypes: ["custom"],
    project(item) {
      return {
        lane: "event",
        block: {
          type: "compaction",
          id: "high",
          sourceItemIds: [asItemId(item.id)],
          summary: "high",
        },
      };
    },
  });

  const input = source([{
    id: "turn-custom",
    status: "complete",
    items: [{ id: "custom-1", type: "custom", payload: null }],
  }]);
  assert.equal(projectTimeline(input, registry).frames[0]?.blocks[0]?.id, "high");
  removeHigh();
  assert.equal(projectTimeline(input, registry).frames[0]?.blocks[0]?.id, "low");
  removeLow();
  assert.equal(projectTimeline(input, registry).frames[0]?.blocks[0]?.type, "unknown");
});

test("Conversation identity rejects empty Host or Thread IDs", () => {
  assert.throws(() => createConversationKey("", "thread"), /HostId/);
  assert.throws(() => createConversationKey("local", ""), /ThreadId/);
});

test("Timeline Frames are grouped into one stable virtualized row per AppServer Turn", () => {
  const timeline = projectTimeline(source([{
    id: "turn-grouped",
    status: "streaming",
    items: [
      { id: "user-grouped", type: "userMessage", payload: { text: "Build it" } },
      { id: "reasoning-grouped", type: "reasoning", payload: { summary: "Inspecting" } },
      { id: "assistant-grouped", type: "agentMessage", payload: { text: "Done" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());

  const turns = groupTimelineFramesByTurn(timeline);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.turnKey, "turn-grouped");
  assert.deepEqual(turns[0]?.frames.map((frame) => frame.type), ["user", "assistant"]);
});

test("history gaps retain cursor identity and reject unusable height estimates", () => {
  assert.deepEqual(createOlderHistoryGap("gap:before:cursor-1", 480, "cursor-1"), {
    type: "history-gap",
    turnKey: "gap:before:cursor-1",
    estimatedHeightPx: 480,
    direction: "older",
    cursor: "cursor-1",
  });
  assert.throws(() => createOlderHistoryGap("gap", 0, null), /positive/);
});

test("latest Turn phase separates prework from the first final assistant text", () => {
  const project = (status: "streaming" | "complete", items: TimelineProjectionSource["turns"][number]["items"]) =>
    groupTimelineFramesByTurn(projectTimeline(source([{
      id: "turn-phase",
      status,
      items,
    }]), createDefaultTimelineProjectorRegistry()))[0];

  assert.equal(deriveTimelineLatestTurnPhase(project("streaming", [
    { id: "reasoning-phase", type: "reasoning", payload: { summary: "Inspecting" } },
  ])), "prework");
  assert.equal(deriveTimelineLatestTurnPhase(project("streaming", [
    { id: "reasoning-phase", type: "reasoning", payload: { summary: "Inspecting" } },
    { id: "assistant-phase", type: "agentMessage", payload: { text: "Ready." } },
  ])), "final_answer");
  for (const text of ["", "   "]) {
    assert.equal(deriveTimelineLatestTurnPhase(project("streaming", [
      { id: "assistant-phase", type: "agentMessage", payload: { text, phase: "final_answer" } },
    ])), "final_answer", "the final Item, not its first nonempty delta, owns the phase boundary");
    assert.equal(deriveTimelineLatestTurnPhase(project("streaming", [
      { id: "commentary-phase", type: "agentMessage", payload: { text, phase: "commentary" } },
    ])), "prework");
  }
  assert.equal(deriveTimelineLatestTurnPhase(project("complete", [
    { id: "assistant-phase", type: "agentMessage", payload: { text: "Ready." } },
  ])), "idle");
});

test("real Codex reasoning keeps content when the summary array is empty", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-reasoning-content",
    status: "complete",
    items: [{
      id: "reasoning-content",
      type: "reasoning",
      payload: {
        summary: [],
        content: ["Inspected the recovered renderer.", "Compared the scroll transaction."],
      },
    }],
  }]), createDefaultTimelineProjectorRegistry());
  const block = snapshot.frames[0]?.blocks[0];
  assert.equal(block?.type, "reasoning");
  if (block?.type !== "reasoning") throw new Error("Expected a reasoning block");
  assert.equal(block.summary, "");
  assert.equal(block.detail, "Inspected the recovered renderer.\nCompared the scroll transaction.");
});

test("reasoning presentation uses actual summary once, falls back to returned detail, and defaults collapsed", () => {
  const block: Extract<TimelineBlock, { type: "reasoning" }> = {
    type: "reasoning", id: "reasoning:item", sourceItemIds: [asItemId("item")],
    summary: "  First summary line\n\nLatest summary line  ",
    detail: "A second representation of the same reasoning.", streaming: true,
  };
  assert.deepEqual(presentReasoning(block), {
    content: "First summary line\n\nLatest summary line", header: "Latest summary line",
    source: "summary", initiallyCollapsed: true,
  });
  assert.equal(presentReasoning(block, false)?.header, "First summary line");
  assert.deepEqual(presentReasoning({ ...block, summary: " \n ", detail: "Returned detail\nNext line", streaming: false }), {
    content: "Returned detail\nNext line", header: "Returned detail", source: "detail", initiallyCollapsed: true,
  });
  assert.equal(presentReasoning({ ...block, summary: " \n ", detail: " \n " }), null);
  assert.equal(presentReasoning({ ...block, summary: "", detail: null }), null);
});

test("reasoning header is plain visible Markdown text while selected body retains its canonical markup", () => {
  const block: Extract<TimelineBlock, { type: "reasoning" }> = {
    type: "reasoning", id: "reasoning:markdown", sourceItemIds: [asItemId("markdown")],
    summary: "# **Calculating dates**\n\n- Read [the source](file:///work/a.ts) and `a_b`", detail: "Not selected", streaming: true,
  };
  assert.equal(presentReasoning(block)?.header, "Read the source and a_b");
  assert.equal(presentReasoning(block, false)?.header, "Calculating dates");
  assert.equal(presentReasoning(block)?.content, block.summary);
  const fenced = { ...block, summary: "```js\nconst a_b = '*';\n```" };
  assert.equal(presentReasoning(fenced)?.header, "const a_b = '*';");
  assert.equal(presentReasoning(fenced, false)?.header, "const a_b = '*';");
  assert.equal(presentReasoning({ ...block, summary: "Literal \\*stars\\* and a_b" })?.header, "Literal *stars* and a_b");
  assert.equal(presentReasoning({ ...block, summary: "Only **unfinished" })?.header, "Only unfinished");
  assert.equal(presentReasoning({ ...block, summary: "Earlier text\n\n---" })?.header, "Earlier text");
});

test("empty and encrypted-only reasoning cannot create a disclosure or invent content", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-empty-reasoning", status: "streaming",
    items: [{ id: "reasoning", type: "reasoning", payload: {
      summary: [], content: [], encryptedContent: "not-renderable", status: "inProgress",
    } }],
  }]), createDefaultTimelineProjectorRegistry());
  const turn = groupTimelineFramesByTurn(snapshot)[0]!;
  const plan = createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true });
  assert.deepEqual(plan.assistant?.slots, []);
  assert.equal(plan.thinkingOwner.type, "turn");
  assert.equal(plan.topLevelSlotCount, 1);
});

test("reasoning content arrival preserves source and first-tool group identity, not invisible physical sections", () => {
  const project = (summary: readonly string[], status: "streaming" | "complete" = "streaming") => {
    const snapshot = projectTimeline(source([{
      id: "turn-reasoning-arrival", status,
      items: [
        { id: "before", type: "commandExecution", payload: { command: "pwd", status: "completed" } },
        { id: "reasoning", type: "reasoning", payload: { summary, status: status === "streaming" ? "inProgress" : "completed" } },
        { id: "after", type: "commandExecution", payload: { command: "npm test", status: "inProgress" } },
      ],
    }]), createDefaultTimelineProjectorRegistry());
    return createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(snapshot)[0]!, undefined, { isMostRecentTurn: true });
  };
  const empty = project([]);
  const streaming = project(["First", "Latest"]);
  const complete = project(["First", "Latest", "Last"], "complete");
  const toolSlots = (plan: ReturnType<typeof project>) => plan.assistant?.slots.filter((slot) => slot.type === "agent-activity");
  assert.equal(toolSlots(empty)?.length, 1, "empty reasoning is not a physical activity boundary");
  assert.equal(toolSlots(streaming)?.length, 1, "actual text gets an independent inner disclosure, not a second work owner");
  assert.deepEqual(toolSlots(streaming)?.map((slot) => slot.id), toolSlots(complete)?.map((slot) => slot.id));
  const beforeContent = (p: ReturnType<typeof project>) => toolSlots(p)?.flatMap(slot => slot.contentUnits)
    .find(unit => unit.type !== "worked-for" && (unit.type === "group" ? unit.blocks : [unit.block])
      .some(block => block.sourceItemIds.includes("before")));
  assert.equal(beforeContent(empty)?.id, beforeContent(streaming)?.id, "first-source disclosure identity survives a real split");
  const sourceReasoning = (p: ReturnType<typeof project>) => p.assistantFrame?.blocks.find(block => block.type === "reasoning");
  assert.equal(sourceReasoning(empty)?.id, sourceReasoning(streaming)?.id);
  assert.deepEqual(sourceReasoning(empty)?.sourceItemIds, sourceReasoning(streaming)?.sourceItemIds);
  assert.equal(empty.assistant?.slots.some((slot) => slot.type === "reasoning"), false);
  const liveReasoning = reasoningUnits(streaming.assistant)[0];
  const settledReasoning = reasoningUnits(complete.assistant)[0];
  if (liveReasoning?.type !== "reasoning" || settledReasoning?.type !== "reasoning") throw new Error("Expected reasoning disclosures");
  assert.equal(liveReasoning.id, settledReasoning.id);
  assert.equal(liveReasoning.active, false, "later live tool work owns current feedback");
  assert.equal(liveReasoning.presentation.initiallyCollapsed, true);
  assert.equal(settledReasoning.presentation.initiallyCollapsed, true);
  assert.equal(settledReasoning.presentation.content, "First\nLatest\nLast");
});

test("only current-response trailing reasoning may replace Thinking, never historical or later tool work", () => {
  const reasoning = (id: string, summary = ["First", "Latest"]) => ({
    id, type: "reasoning", payload: { summary, completed: false },
  });
  const answer = { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer", completed: true } };
  const command = { id: "command", type: "commandExecution", payload: { command: "npm test", status: "inProgress" } };
  const followup = { id: "followup", type: "steeringUserMessage", payload: {
    status: "accepted", input: [{ type: "text", text: "Check another thing" }],
  } };
  const project = (items: TimelineProjectionSource["turns"][number]["items"], isMostRecentTurn = true, status: "streaming" | "complete" = "streaming") => {
    const snapshot = projectTimeline(source([{ id: "turn-reasoning-ownership", status, items }]), createDefaultTimelineProjectorRegistry());
    return createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(snapshot)[0]!, undefined, { isMostRecentTurn });
  };
  const current = project([command, reasoning("current")]);
  const active = reasoningUnits(current.assistant).filter(slot => slot.active);
  assert.equal(active.length, 1, "older running background work cannot retain a second Thinking owner");
  assert.equal(current.thinkingOwner.type, "reasoning");
  assert.equal(active[0]?.type === "reasoning" ? active[0].presentation.header : null, "Latest");

  const laterTool = project([reasoning("earlier"), command]);
  assert.equal(laterTool.thinkingOwner.type, "none", "running command has its own work feedback, not a Thinking fallback");
  assert.equal(reasoningUnits(laterTool.assistant).some(slot => slot.active), false);
  const historical = project([reasoning("earlier"), answer, followup]);
  assert.equal(historical.thinkingOwner.type, "turn");
  assert.equal(reasoningUnits(historical.assistant).some(slot => slot.active), false);
  const resumed = project([reasoning("earlier"), answer, followup, reasoning("current")]);
  assert.equal(resumed.thinkingOwner.type, "reasoning");
  assert.equal(reasoningUnits(resumed.assistant).filter(slot => slot.active).length, 1);
  const oldTurn = project([reasoning("current")], false);
  assert.equal(oldTurn.thinkingOwner.type, "none");
  assert.equal(reasoningUnits(oldTurn.assistant).some(slot => slot.active), false);
  const complete = project([reasoning("current")], true, "complete");
  assert.equal(complete.thinkingOwner.type, "none");
  assert.equal(reasoningUnits(complete.assistant)[0]?.presentation.header, "First");
});

test("Codex commentary remains inside Agent Activity while final_answer is a separate unit", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-activity",
    status: "streaming",
    items: [
      { id: "reasoning", type: "reasoning", payload: { summary: ["Inspecting"], status: "completed" } },
      { id: "commentary", type: "agentMessage", payload: { text: "I am checking the runtime.", phase: "commentary", completed: true } },
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed" } },
      { id: "answer", type: "agentMessage", payload: { text: "The tests pass.", phase: "final_answer", completed: false } },
      { id: "post-command", type: "commandExecution", payload: { command: "git status", status: "completed" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  assert.equal(frame?.type, "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected an assistant frame");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.deepEqual(units.map((unit) => unit.type), [
    "agent-activity",
    "assistant-content",
    "agent-activity",
  ]);
  const before = units[0];
  const after = units[2];
  assert.equal(before?.type, "agent-activity");
  assert.equal(after?.type, "agent-activity");
  if (before?.type !== "agent-activity" || after?.type !== "agent-activity") throw new Error("Expected activity units");
  assert.deepEqual(before.blocks.map((block) => block.id), [
    "reasoning:reasoning",
    "text:commentary",
    "command-execution:command",
  ]);
  assert.equal(before.forceExpanded, false);
  assert.equal(resolveAgentActivityLayout(before, undefined).isCollapsed, true);
  assert.equal(after.phase, "after-final-answer");
  assert.equal(after.disableCollapse, true);
  assert.equal(resolveAgentActivityLayout(after, true).isCollapsed, false);
});

test("completed reasoning-only response folds actual thinking under its real work interval", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-reasoning-duration",
    status: "complete",
    durationMs: 2_021,
    startedAtMs: 1_000,
    firstTurnWorkItemStartedAtMs: 1_100,
    finalAssistantStartedAtMs: 2_000,
    items: [
      { id: "reasoning", type: "reasoning", payload: { content: ["Returned reasoning text"], summary: [] } },
      { id: "answer", type: "agentMessage", payload: { text: "在。", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const activity = createAssistantTurnPresentationPlan(frame).slots.find(unit => unit.type === "agent-activity");
  if (activity?.type !== "agent-activity") throw new Error("Expected duration Activity");

  assert.equal(activity.workedDurationMs, 2_021);
  assert.deepEqual(activity.contentUnits.map((unit) => unit.type), ["reasoning", "worked-for"]);
  assert.equal(resolveAgentActivityLayout(activity).showToggle, true);
  assert.equal(resolveAgentActivityLayout(activity).isCollapsed, true);
  assert.deepEqual(resolveAgentActivityLayout(activity, false).visibleUnits.map((unit) => unit.type), ["reasoning"]);
  assert.equal(createAssistantTurnPresentationPlan(frame).slots.some(unit => unit.type === "reasoning"), false);
  const reasoning = reasoningUnits(createAssistantTurnPresentationPlan(frame))[0];
  if (reasoning?.type !== "reasoning") throw new Error("Expected reasoning disclosure");
  assert.equal(reasoning.presentation.content, "Returned reasoning text");
  assert.equal(reasoning.active, false);
});

test("reasoning stays inside response work but outside tool groups around commentary", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-semantic-activity",
    status: "complete",
    durationMs: 14_000,
    items: [
      { id: "reasoning-one", type: "reasoning", payload: { summary: ["Inspecting"], status: "completed" } },
      { id: "commentary-one", type: "agentMessage", payload: { text: "I will inspect the repository skill first.", phase: "commentary", completed: true } },
      { id: "skill-read", type: "commandExecution", payload: {
        command: "sed -n '1,200p' /root/.codex/skills/using-superpowers/SKILL.md",
        commandActions: [{ type: "read", command: "sed", name: "SKILL.md", path: "/root/.codex/skills/using-superpowers/SKILL.md" }],
        status: "completed",
      } },
      { id: "commentary-two", type: "agentMessage", payload: { text: "Now I can continue with the adapter notes.", phase: "commentary", completed: true } },
      { id: "notes-read", type: "commandExecution", payload: {
        command: "cat codex-tools.md",
        commandActions: [{ type: "read", command: "cat", name: "codex-tools.md", path: "/workspace/codex-tools.md" }],
        status: "completed",
      } },
      { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const slots = createAssistantTurnPresentationPlan(frame).slots;
  const outer = slots[0];
  assert.equal(outer?.type, "agent-activity");
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(outer.contentUnits.map((unit) => unit.type), [
    "reasoning", "standalone", "standalone", "standalone", "standalone",
  ]);
  assert.deepEqual(outer.contentUnits.flatMap((unit) => unit.type === "group"
    ? unit.blocks.map((block) => block.type)
    : unit.type === "worked-for" ? [] : [unit.block.type]), ["reasoning", "text", "command-execution", "text", "command-execution"]);
  assert.equal(outer.collapsedItemCount, 5);
  const skillRead = outer.contentUnits[2];
  assert.equal(skillRead?.type, "standalone");
  if (skillRead?.type !== "standalone" || skillRead.block.type !== "command-execution") throw new Error("Expected skill read");
  assert.deepEqual(presentToolActivity(skillRead.block), {
    state: "completed",
    grouping: "groupable",
    icon: "wrench",
    summary: "Read",
    detail: "Using Superpowers skill",
    canExpand: true,
    durationMs: null,
    summaryKey: "command-execution:skill-read",
    continuesLiveActivityBetweenCalls: false,
    summaryOnlyInConversationGroup: false,
  });
});

test("Agent Activity retains a summary only for consecutive tool work", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-consecutive-reads",
    status: "complete",
    items: [
      { id: "read-a", type: "commandExecution", payload: { command: "cat a.ts", commandActions: [{ type: "read", command: "cat", name: "a.ts", path: "a.ts" }], status: "completed" } },
      { id: "read-b", type: "commandExecution", payload: { command: "cat b.ts", commandActions: [{ type: "read", command: "cat", name: "b.ts", path: "b.ts" }], status: "completed" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const units = createAgentActivityContentUnits(frame.blocks, frame.status);
  assert.equal(units.length, 1);
  assert.equal(units[0]?.type, "group");
  if (units[0]?.type !== "group") throw new Error("Expected grouped reads");
  assert.equal(agentActivityHeaderAccessibleLabel(deriveAgentActivityHeaderPresentation(units[0]).summary), "Read files");
});

test("Agent Activity group identity remains stable while streaming appends items", () => {
  const project = (items: readonly Record<string, unknown>[]) => {
    const snapshot = projectTimeline(source([{
      id: "turn-streaming-group",
      status: "inProgress",
      items,
    }]), createDefaultTimelineProjectorRegistry());
    const frame = snapshot.frames[0];
    if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
    const unit = createAgentActivityContentUnits(frame.blocks, frame.status)[0];
    if (unit?.type !== "group") throw new Error("Expected grouped activity");
    return unit;
  };
  const first = project([
    { id: "read-a", type: "commandExecution", payload: { command: "cat a.ts", commandActions: [{ type: "read", command: "cat", name: "a.ts", path: "a.ts" }], status: "completed" } },
    { id: "read-b", type: "commandExecution", payload: { command: "cat b.ts", commandActions: [{ type: "read", command: "cat", name: "b.ts", path: "b.ts" }], status: "inProgress" } },
  ]);
  const appended = project([
    { id: "read-a", type: "commandExecution", payload: { command: "cat a.ts", commandActions: [{ type: "read", command: "cat", name: "a.ts", path: "a.ts" }], status: "completed" } },
    { id: "read-b", type: "commandExecution", payload: { command: "cat b.ts", commandActions: [{ type: "read", command: "cat", name: "b.ts", path: "b.ts" }], status: "completed" } },
    { id: "read-c", type: "commandExecution", payload: { command: "cat c.ts", commandActions: [{ type: "read", command: "cat", name: "c.ts", path: "c.ts" }], status: "inProgress" } },
  ]);
  assert.equal(first.id, "agent-activity-group:command-execution:read-a");
  assert.equal(appended.id, first.id);
  assert.equal(appended.blocks.length, 3);
});

test("only the latest open Activity unit owns a live header", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-unit-lifecycle",
    status: "streaming",
    items: [
      { id: "read-old", type: "commandExecution", payload: { command: "cat old.ts", commandActions: [{ type: "read", command: "cat", name: "old.ts", path: "old.ts" }], status: "completed" } },
      { id: "commentary", type: "agentMessage", payload: { text: "Now checking the browser.", phase: "commentary", completed: true } },
      { id: "web-live", type: "webSearch", payload: { query: "Activity lifecycle", action: { type: "search", query: "Activity lifecycle" } } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const outer = createAssistantTurnPresentationPlan(frame).slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(outer.contentUnits.map((unit) => unit.type), ["standalone", "standalone", "group"]);
  const latest = outer.contentUnits[2];
  if (latest?.type !== "group") throw new Error("Expected latest group");
  assert.deepEqual(latest.lifecycle, {
    isLatestVisibleUnit: true,
    isActivitySliceClosed: false,
    isExploring: false,
    inProgress: true,
  });
  assert.equal(deriveAgentActivityHeaderPresentation(latest).state, "active");
});

test("the first final answer closes the preceding Activity slice even while the Turn streams", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-closed-slice",
    status: "streaming",
    items: [
      { id: "command-live", type: "commandExecution", payload: { command: "npm test", status: "inProgress" } },
      { id: "answer", type: "agentMessage", payload: { text: "The result is ready.", phase: "final_answer", completed: false } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const outer = createAssistantTurnPresentationPlan(frame).slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  const group = outer.contentUnits[0];
  if (group?.type !== "group") throw new Error("Expected grouped command");
  assert.equal(group.lifecycle.isActivitySliceClosed, true);
  assert.equal(group.lifecycle.inProgress, false);
  assert.equal(deriveAgentActivityHeaderPresentation(group).state, "summary");
});

test("MCP App persistence requires both the feature cohort and a renderer surface", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-persistent-app",
    status: "complete",
    items: [
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed" } },
      { id: "mcp-app", type: "mcpToolCall", payload: { server: "figma", tool: "render_design", status: "completed", appContext: { resourceUri: "ui://figma/design" }, result: { content: [] } } },
      { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const defaultOuter = createAssistantTurnPresentationPlan(frame).slots[0];
  if (defaultOuter?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(defaultOuter.partitions.persistentUnits, []);
  assert.deepEqual(defaultOuter.partitions.collapsibleUnits.map((unit) => unit.id), [
    "agent-activity-group:command-execution:command",
    "agent-activity-standalone:tool-call:mcp-app",
  ]);
  const outer = createAssistantTurnPresentationPlan(frame, undefined, {
    keepMcpAppEntriesPersistent: true,
    renderMcpApps: true,
  }).slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(outer.partitions.collapsibleUnits.map((unit) => unit.id), ["agent-activity-group:command-execution:command"]);
  assert.deepEqual(outer.partitions.persistentUnits.map((unit) => unit.id), ["agent-activity-standalone:tool-call:mcp-app"]);
  assert.deepEqual(outer.partitions.expandedUnits.map((unit) => unit.id), [
    "agent-activity-group:command-execution:command",
    "agent-activity-standalone:tool-call:mcp-app",
  ]);
});

test("steering and hook feedback retain their own slots outside Activity disclosures", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-persistent-feedback",
    status: "complete",
    params: { clientUserMessageId: "client-primary", input: [{ type: "text", text: "Start" }] },
    items: [
      { id: "primary", type: "userMessage", payload: { clientId: "client-primary", content: [{ type: "text", text: "Start" }] } },
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed" } },
      { id: "steering", type: "steeringUserMessage", payload: { status: "accepted", input: [{ type: "text", text: "Also inspect mobile." }] } },
      { id: "hook", type: "hookPrompt", payload: { fragments: [{ text: "Remember the release note." }] } },
      { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  assert.deepEqual(snapshot.frames.map((frame) => frame.type), ["user", "assistant"]);
  const assistant = snapshot.frames[1];
  if (assistant?.type !== "assistant") throw new Error("Expected assistant frame");
  const slots = createAssistantTurnPresentationPlan(assistant).slots;
  const outer = slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(outer.partitions.collapsibleUnits.map((unit) => unit.id), ["agent-activity-group:command-execution:command"]);
  assert.deepEqual(outer.partitions.persistentUnits, []);
  assert.deepEqual(slots.filter(slot => slot.type === "assistant-content").map(slot => slot.block.id), [
    "user-message:steering", "user-message:hook", "text:answer",
  ]);
  const collapsedLayout = resolveAgentActivityLayout(outer, true);
  assert.equal(collapsedLayout.showToggle, false, "Steer is not a final-answer fold grant");
  assert.equal(collapsedLayout.isCollapsed, false);
  assert.deepEqual(collapsedLayout.visibleUnits.map((unit) => unit.id), ["agent-activity-group:command-execution:command"]);
  assert.deepEqual(collapsedLayout.persistentUnits, []);
  const expandedLayout = resolveAgentActivityLayout(outer, false);
  assert.equal(expandedLayout.isCollapsed, false);
  assert.deepEqual(expandedLayout.persistentUnits, []);
  assert.deepEqual(expandedLayout.visibleUnits.map((unit) => unit.id), [
    "agent-activity-group:command-execution:command",
  ]);
});

test("realtime transcripts follow Codex's pre-toggle and persistent ownership", () => {
  const leadingDelegation = `<realtime_delegation>
    <transcript_delta>assistant: I can help.\nuser: Please inspect the app.</transcript_delta>
    <input>Please inspect the app.</input>
  </realtime_delegation>`;
  const followupDelegation = `<realtime_delegation>
    <source>transcript_tail_flush</source>
    <transcript_delta>assistant: The checks passed.</transcript_delta>
    <input>Ship it.</input>
  </realtime_delegation>`;
  const snapshot = projectTimeline(source([{
    id: "turn-voice-handoff",
    status: "complete",
    params: { clientUserMessageId: "voice-leading", input: [{ type: "text", text: leadingDelegation }] },
    items: [
      { id: "realtime-delegation-leading", type: "userMessage", payload: { clientId: "voice-leading", content: [{ type: "text", text: leadingDelegation }] } },
      { id: "command", type: "commandExecution", payload: { command: "npm test", status: "completed" } },
      { id: "realtime-delegation-handoff-1", type: "userMessage", payload: { clientId: "voice-followup", content: [{ type: "text", text: followupDelegation }] } },
      { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const outer = createAssistantTurnPresentationPlan(frame).slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(outer.partitions.preToggleUnits.map((unit) => unit.id), ["agent-activity-standalone:realtime-transcript:realtime-delegation-leading"]);
  assert.deepEqual(outer.partitions.collapsibleUnits.map((unit) => unit.id), ["agent-activity-group:command-execution:command"]);
  assert.deepEqual(outer.partitions.persistentUnits.map((unit) => unit.id), ["agent-activity-standalone:realtime-transcript:realtime-delegation-handoff-1"]);
  assert.deepEqual(outer.partitions.expandedUnits.map((unit) => unit.id), [
    "agent-activity-group:command-execution:command",
    "agent-activity-standalone:realtime-transcript:realtime-delegation-handoff-1",
  ]);
  assert.equal(outer.collapsedItemCount, 1);
  const leading = outer.partitions.preToggleUnits[0];
  const followup = outer.partitions.persistentUnits[0];
  assert.equal(leading?.type === "standalone" && leading.block.type === "realtime-transcript" ? leading.block.handoffId : "invalid", null);
  assert.equal(followup?.type === "standalone" && followup.block.type === "realtime-transcript" ? followup.block.handoffId : null, "handoff-1");
});

test("a non-collapsible realtime transcript renders from the original Unit stream", () => {
  const delegation = `<realtime_delegation><input>Keep listening.</input></realtime_delegation>`;
  const snapshot = projectTimeline(source([{
    id: "turn-live-voice-only",
    status: "streaming",
    params: { clientUserMessageId: "voice-only", input: [{ type: "text", text: delegation }] },
    items: [
      { id: "realtime-delegation-live", type: "userMessage", payload: { clientId: "voice-only", content: [{ type: "text", text: delegation }] } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const outer = createAssistantTurnPresentationPlan(frame).slots[0];
  if (outer?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.equal(outer.hasRenderableAgentItems, true);
  assert.equal(outer.contentUnits.length, 1);
  assert.equal(outer.partitions.preToggleUnits.length, 1);
  assert.equal(outer.partitions.expandedUnits.length, 0);
  assert.equal(shouldAllowAgentActivityCollapse(outer), false);
  const layout = resolveAgentActivityLayout(outer, true);
  assert.equal(layout.showToggle, false);
  assert.equal(layout.isCollapsed, false);
  assert.equal(layout.preToggleUnits.length, 0);
  assert.equal(layout.visibleUnits.length, 1);
});

test("realtime delegation parsing matches Codex transcript extension and entity decoding", () => {
  assert.deepEqual(parseRealtimeDelegation([{
    type: "text",
    text: `<realtime_delegation>
      <source>transcript_tail_flush</source>
      <transcript_delta>user: Earlier\nassistant: Use &lt;main&gt; &amp; tests</transcript_delta>
      <input>Continue &quot;now&quot;</input>
    </realtime_delegation>`,
  }]), {
    input: `Continue "now"`,
    source: "transcript_tail_flush",
    transcript: [
      { role: "user", text: "Earlier" },
      { role: "assistant", text: "Use <main> & tests" },
      { role: "user", text: `Continue "now"` },
    ],
    transcriptDelta: "user: Earlier\nassistant: Use <main> & tests",
  });
});

test("empty AppServer fileChange placeholders never create visible Activity", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-empty-patch",
    status: "streaming",
    items: [{ id: "patch-empty", type: "fileChange", payload: { status: "inProgress", changes: [] } }],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames[0];
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  assert.deepEqual(createAssistantTurnPresentationPlan(frame).slots, []);
});

test("Codex skill paths produce stable semantic names for local and cached plugin skills", () => {
  assert.deepEqual(parseSkillPath("SKILL.md", "/root/.codex/skills/using-superpowers"), {
    skillId: "using-superpowers",
    skillRootPath: "/root/.codex/skills/using-superpowers",
    skillName: "Using Superpowers",
    pluginId: null,
    pluginDisplayName: null,
    pluginMarketplaceName: null,
    isSystem: false,
    isInScriptsFolder: false,
    isSkillDefinitionFile: true,
  });
  const plugin = parseSkillPath("/root/.codex/plugins/cache/openai-curated-remote/visualize/1.0.23/skills/live/SKILL.md");
  assert.equal(plugin?.skillName, "Live");
  assert.equal(plugin?.pluginId, "visualize");
  assert.equal(plugin?.pluginMarketplaceName, "openai-curated-remote");
  assert.equal(plugin?.isSkillDefinitionFile, true);
});

test("Agent Activity disclosure follows the Codex state table", () => {
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: false,
    hasRenderableAgentItems: true,
    isTurnCancelled: false,
  }), { shouldAllowCollapse: false, isCollapsed: false });
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: true,
    isTurnCancelled: true,
  }), { shouldAllowCollapse: false, isCollapsed: false });
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: false,
    isTurnCancelled: false,
  }), { shouldAllowCollapse: false, isCollapsed: false });
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: true,
    isTurnCancelled: false,
  }), { shouldAllowCollapse: true, isCollapsed: true });
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: true,
    isTurnCancelled: false,
    preventAutoCollapse: true,
  }), { shouldAllowCollapse: true, isCollapsed: false });
  assert.deepEqual(resolveAgentActivityDisclosure({
    forceExpanded: true,
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: true,
    isTurnCancelled: false,
    persistedCollapsed: true,
  }), { shouldAllowCollapse: true, isCollapsed: false });
  assert.deepEqual(resolveAgentActivityDisclosure({
    hasFinalAssistantStarted: true,
    hasRenderableAgentItems: true,
    isTurnCancelled: false,
    persistedCollapsed: false,
  }), { shouldAllowCollapse: true, isCollapsed: false });
});

test("commentary alone stays in prework and does not start final-answer follow mode", () => {
  const turn = groupTimelineFramesByTurn(projectTimeline(source([{
    id: "turn-commentary",
    status: "streaming",
    items: [{
      id: "commentary",
      type: "agentMessage",
      payload: { text: "Still investigating.", phase: "commentary", completed: false },
    }],
  }]), createDefaultTimelineProjectorRegistry()))[0];
  assert.equal(deriveTimelineLatestTurnPhase(turn), "prework");
});

test("standalone app tools and subagent activity share one stable Turn Activity owner", () => {
  const snapshot = projectTimeline(source([{
    id: "turn-standalone",
    status: "complete",
    items: [
      { id: "reasoning-before", type: "reasoning", payload: { summary: ["Inspecting"] } },
      {
        id: "mcp-app",
        type: "mcpToolCall",
        payload: {
          server: "figma",
          tool: "render_design",
          status: "completed",
          result: { content: [] },
          appContext: { resourceUri: "ui://figma/design" },
        },
      },
      { id: "exec-after", type: "commandExecution", payload: { command: "pwd", status: "completed" } },
      { id: "subagent", type: "subAgentActivity", payload: { label: "worker", action: "Reviewing" } },
      { id: "answer", type: "agentMessage", payload: { text: "Done.", phase: "final_answer" } },
    ],
  }]), createDefaultTimelineProjectorRegistry());
  const frame = snapshot.frames.find((candidate) => candidate.type === "assistant");
  assert.equal(frame?.type, "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const units = createAssistantTurnPresentationPlan(frame).slots;
  assert.deepEqual(units.map((unit) => unit.type), [
    "agent-activity",
    "assistant-content",
  ]);
  const activity = units[0];
  assert.equal(activity?.type, "agent-activity");
  if (activity?.type !== "agent-activity") throw new Error("Expected Agent Activity");
  assert.deepEqual(activity.contentUnits.map((unit) => unit.type), ["reasoning", "standalone", "standalone"]);
  assert.equal(activity.contentUnits[1]?.type === "standalone" ? activity.contentUnits[1].block.id : null, "tool-call:mcp-app");
  assert.equal(activity.contentUnits[2]?.type === "standalone" ? activity.contentUnits[2].block.id : null, "command-execution:exec-after");
  assert.equal(activity.inlineSubagentActivity?.blocks[0]?.id, "subagent:subagent");
  assert.equal(activity.collapsedItemCount, 4);
});

test("Turn Activity slot and inline subagent identities survive streaming prepend and append", () => {
  const project = (items: TimelineProjectionSource["turns"][number]["items"]) => projectTimeline(source([{
    id: "turn-stable-owner",
    status: "streaming",
    items,
  }]), createDefaultTimelineProjectorRegistry()).frames.find((frame) => frame.type === "assistant");
  const initial = project([
    { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed" } },
    { id: "subagent-a", type: "subAgentActivity", payload: { label: "A", action: "Reviewing", status: "running" } },
  ]);
  const updated = project([
    { id: "reasoning", type: "reasoning", payload: { summary: ["Planning"] } },
    { id: "command", type: "commandExecution", payload: { command: "pwd", status: "completed" } },
    { id: "subagent-a", type: "subAgentActivity", payload: { label: "A", action: "Reviewing", status: "running" } },
    { id: "subagent-b", type: "subAgentActivity", payload: { label: "B", action: "Testing", status: "running" } },
  ]);
  if (initial?.type !== "assistant" || updated?.type !== "assistant") throw new Error("Expected assistant frames");
  const initialActivity = createAssistantTurnPresentationPlan(initial).slots[0];
  const updatedActivity = createAssistantTurnPresentationPlan(updated).slots.find((unit) => unit.type === "agent-activity");
  if (initialActivity?.type !== "agent-activity" || updatedActivity?.type !== "agent-activity") throw new Error("Expected Activity slots");
  assert.equal(initialActivity.id, "turn-stable-owner:slot:agent-activity");
  assert.equal(updatedActivity.id, initialActivity.id);
  assert.equal(updatedActivity.inlineSubagentActivity?.id, initialActivity.inlineSubagentActivity?.id);
  assert.equal(initialActivity.collapsedItemCount, 2);
  assert.equal(updatedActivity.collapsedItemCount, 3);
  assert.equal(updatedActivity.inlineSubagentActivity?.blocks.length, 2);
});

test("context compaction owns Activity without a redundant disclosure toggle", () => {
  const frame = projectTimeline(source([{
    id: "turn-compaction-only",
    status: "complete",
    items: [
      { id: "compaction", type: "contextCompaction", payload: { summary: "Older context compacted" } },
      { id: "answer", type: "agentMessage", payload: { text: "Continued.", phase: "final_answer", completed: true } },
    ],
  }]), createDefaultTimelineProjectorRegistry()).frames.find((candidate) => candidate.type === "assistant");
  if (frame?.type !== "assistant") throw new Error("Expected assistant frame");
  const activity = createAssistantTurnPresentationPlan(frame).slots[0];
  if (activity?.type !== "agent-activity") throw new Error("Expected Activity slot");
  assert.equal(activity.contentUnits[0]?.type === "standalone" ? activity.contentUnits[0].block.type : null, "compaction");
  assert.equal(resolveAgentActivityLayout(activity, true).showToggle, false);
});

test("latest Activity identity advances for steering without replacing its Turn", () => {
  const project = (items: TimelineProjectionSource["turns"][number]["items"]) => {
    const timeline = projectTimeline(source([{
      id: "turn-steering-placement",
      status: "streaming",
      items,
    }]), createDefaultTimelineProjectorRegistry());
    return groupTimelineFramesByTurn(timeline).at(-1) ?? null;
  };
  const initial = project([
    { id: "prompt", type: "userMessage", payload: { content: [{ type: "text", text: "Start" }] } },
  ]);
  const steered = project([
    { id: "prompt", type: "userMessage", payload: { content: [{ type: "text", text: "Start" }] } },
    { id: "steer-1", type: "steeringUserMessage", payload: { status: "accepted", input: [{ type: "text", text: "Also test mobile" }] } },
  ]);
  const steeredAgain = project([
    { id: "prompt", type: "userMessage", payload: { content: [{ type: "text", text: "Start" }] } },
    { id: "steer-1", type: "steeringUserMessage", payload: { status: "accepted", input: [{ type: "text", text: "Also test mobile" }] } },
    { id: "steer-2", type: "steeringUserMessage", payload: { status: "accepted", input: [{ type: "text", text: "And Web" }] } },
  ]);

  assert.equal(initial?.turnKey, steered?.turnKey);
  assert.equal(deriveTimelineLatestTurnActivityKey(initial), "turn-steering-placement");
  assert.equal(
    deriveTimelineLatestTurnActivityKey(steered),
    "turn-steering-placement:steer-1",
  );
  assert.equal(
    deriveTimelineLatestTurnActivityKey(steeredAgain),
    "turn-steering-placement:steer-2",
  );
});

test("generated images move from live Activity to final assistant content without changing ownership early", () => {
  const runningFrame = projectTimeline(source([{
    id: "turn-image-owner",
    status: "streaming",
    items: [{ id: "image", type: "imageGeneration", payload: { src: null, status: "in_progress" } }],
  }]), createDefaultTimelineProjectorRegistry()).frames.find((candidate) => candidate.type === "assistant");
  const completeFrame = projectTimeline(source([{
    id: "turn-image-owner",
    status: "complete",
    items: [{ id: "image", type: "imageGeneration", payload: { result: "aGVsbG8=", status: "completed" } }],
  }]), createDefaultTimelineProjectorRegistry()).frames.find((candidate) => candidate.type === "assistant");
  if (runningFrame?.type !== "assistant" || completeFrame?.type !== "assistant") throw new Error("Expected assistant frames");
  assert.equal(createAssistantTurnPresentationPlan(runningFrame).slots[0]?.type, "agent-activity");
  assert.equal(createAssistantTurnPresentationPlan(completeFrame).slots[0]?.type, "assistant-content");
});
