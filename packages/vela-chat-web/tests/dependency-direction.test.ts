import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("web renderer consumes render model and does not inspect transcript wire fields", () => {
  const source = readFileSync(join(root, "packages/vela-chat-web/src/index.tsx"), "utf8");

  assert.match(source, /vela-chat-render-model/);
  assert.equal(source.includes("created_at"), false);
  assert.equal(source.includes("event_range"), false);
});

test("desktop renderer is split into agent-friendly component folders with local readmes", () => {
  const expectedPaths = [
    "packages/vela-chat-web/src/adapters/README.md",
    "packages/vela-chat-web/src/adapters/toWebBlocks.ts",
    "packages/vela-chat-web/src/conversation-runtime/README.md",
    "packages/vela-chat-web/src/conversation-runtime/model/README.md",
    "packages/vela-chat-web/src/conversation-runtime/model/buildConversationStreamItems.ts",
    "packages/vela-chat-web/src/conversation-runtime/model/buildConversationRuntimeSegments.ts",
    "packages/vela-chat-web/src/conversation-runtime/model/estimateStreamItemHeight.ts",
    "packages/vela-chat-web/src/conversation-runtime/model/index.ts",
    "packages/vela-chat-web/src/conversation-runtime/model/virtualizationPolicy.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/README.md",
    "packages/vela-chat-web/src/conversation-runtime/scroll/bottomAnchor.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/historyPaging.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/routeResume.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts",
    "packages/vela-chat-web/src/conversation-runtime/strategy/README.md",
    "packages/vela-chat-web/src/conversation-runtime/strategy/strategyRegistry.ts",
    "packages/vela-chat-web/src/conversation-runtime/strategy/strategyResolver.ts",
    "packages/vela-chat-web/src/conversation-runtime/strategy/strategy.ts",
    "packages/vela-chat-web/src/conversation-runtime/strategy/webPlainStrategy.tsx",
    "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx",
    "packages/vela-chat-web/src/renderers/README.md",
    "packages/vela-chat-web/src/renderers/blockRegistry.tsx",
    "packages/vela-chat-web/src/renderers/blocks/README.md",
    "packages/vela-chat-web/src/renderers/blocks/AssistantMarkdownRenderer.tsx",
    "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx",
    "packages/vela-chat-web/src/renderers/blocks/StatusRenderer.tsx",
    "packages/vela-chat-web/src/primitives/README.md",
    "packages/vela-chat-web/src/primitives/message/README.md",
    "packages/vela-chat-web/src/primitives/message/Message.tsx",
    "packages/vela-chat-web/src/primitives/message/MessageResponse.tsx",
    "packages/vela-chat-web/src/primitives/conversation/README.md",
    "packages/vela-chat-web/src/primitives/conversation/Conversation.tsx",
    "packages/vela-chat-web/src/primitives/prompt-input/README.md",
    "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx",
    "packages/vela-chat-web/src/components/README.md",
    "packages/vela-chat-web/src/components/workbench/README.md",
    "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx",
    "packages/vela-chat-web/src/components/conversation/README.md",
    "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx",
    "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx",
    "packages/vela-chat-web/src/components/conversation/VelaTurnGroup.tsx",
    "packages/vela-chat-web/src/components/composer/README.md",
    "packages/vela-chat-web/src/components/composer/VelaComposer.tsx",
    "packages/vela-chat-web/src/components/composer-controls/README.md",
    "packages/vela-chat-web/src/components/composer-controls/ComposerControls.tsx",
    "packages/vela-chat-web/src/components/composer-controls/model.ts",
    "packages/vela-chat-web/src/hooks/README.md",
    "packages/vela-chat-web/src/hooks/useAutoResizeTextarea.ts",
    "packages/vela-chat-web/src/hooks/useComposerKeyboard.ts",
    "packages/vela-chat-web/src/styles/README.md",
    "packages/vela-chat-web/src/styles/desktop.module.css",
  ];

  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }
});

test("package entrypoint stays thin and delegates desktop rendering details", () => {
  const source = readFileSync(join(root, "packages/vela-chat-web/src/index.tsx"), "utf8");

  assert.match(source, /ChatWorkbenchView/);
  assert.equal(source.includes("function MarkdownBlock"), false);
  assert.equal(source.includes("function renderInlineCode"), false);
  assert.equal(source.includes("<textarea"), false);
});

test("web partial virtualization uses item-level tanstack virtualizer instead of mounting every history item", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx"),
    "utf8",
  );

  assert.match(source, /@tanstack\/react-virtual/);
  assert.match(source, /useVirtualizer/);
  assert.equal(source.includes("historyVirtualized.map"), false);
  assert.match(source, /ConversationStreamItem/);
});

test("web partial virtualization batches row measurement through animation frames", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx"),
    "utf8",
  );

  assert.match(source, /pendingVirtualRowMeasureFramesRef/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
  assert.doesNotMatch(source, /ref=\{rowVirtualizer\.measureElement\}/);
});

test("web partial virtualization records measured row heights for future estimates", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx"),
    "utf8",
  );

  assert.match(source, /recordMeasuredStreamItemHeight/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /bounds\.height/);
  assert.match(source, /bounds\.width/);
});

test("conversation components use the app-side runtime instead of turn-level conversation-engine", () => {
  const conversation = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );
  const turnList = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx"),
    "utf8",
  );

  assert.match(conversation, /conversation-runtime/);
  assert.match(turnList, /ConversationStreamItem/);
  assert.doesNotMatch(conversation, /conversation-engine/);
  assert.doesNotMatch(turnList, /WebTurn/);
});

test("conversation component memoizes derived stream items and segments", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );

  assert.match(source, /useMemo/);
  assert.match(source, /buildConversationStreamItems/);
  assert.match(source, /buildConversationRuntimeSegments/);
});

test("conversation component chooses runtime policy from the render-model host", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );

  assert.match(source, /conversationRuntimePolicyForHost/);
  assert.match(source, /webModel\.host\.kind/);
  assert.match(source, /buildConversationRuntimeSegments\(items,\s*runtimePolicy\)/);
});

test("turn list delegates list strategy selection to the conversation strategy resolver", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx"),
    "utf8",
  );

  assert.match(source, /resolveConversationStrategy/);
  assert.match(source, /hostKind/);
  assert.doesNotMatch(source, /webPlainConversationStrategy/);
  assert.doesNotMatch(source, /webPartialVirtualizedConversationStrategy/);
});

test("user message renderer uses a semantic copy control instead of a placeholder glyph", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx"),
    "utf8",
  );

  assert.doesNotMatch(source, />□</);
  assert.match(source, /aria-label="Copy message"/);
  assert.match(source, /navigator\.clipboard\.writeText/);
});

test("conversation scroll controller observes content size changes for post-layout bottom anchoring", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const turnList = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx"),
    "utf8",
  );

  assert.match(controller, /contentRef/);
  assert.match(controller, /ResizeObserver/);
  assert.match(controller, /shouldRestickOnContentSizeChange/);
  assert.match(turnList, /contentRef/);
});

test("conversation scroll controller cancels pending stick on user scroll-away intent", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /shouldCancelPendingStickForUserScrollIntent/);
  assert.match(controller, /cancelPendingFrame\(\)/);
});

test("conversation scroll controller ignores bottom anchoring while browser overscrolls past bottom", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /isOverscrolledPastBottom/);
  assert.match(controller, /scrollToBottom/);
});

test("conversation scroll controller retries bottom stick after layout settle", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /BOTTOM_STICK_SETTLE_RETRY_MS/);
  assert.match(controller, /pendingSettleTimeoutRef/);
  assert.match(controller, /shouldRetryBottomStickAfterSettle/);
});

test("conversation scroll controller gates route bottom anchoring on readiness", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /deriveBottomAnchorRouteReadiness/);
  assert.match(controller, /blockedReason/);
  assert.match(controller, /historyStartReadyRef/);
});

test("chat debug snapshot includes conversation scroll runtime state", () => {
  const chatWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");
  const conversation = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );

  assert.match(conversation, /onScrollDebugChange/);
  assert.match(conversation, /scroll\.debug/);
  assert.match(chatWorkbench, /conversationScrollDebug/);
  assert.match(chatWorkbench, /scroll:\s*conversationScrollDebug/);
  assert.match(chatWorkbench, /routeResumeStatus/);
  assert.match(chatWorkbench, /routeResumeScrollTop/);
});

test("conversation runtime owns session scroll resume instead of the page shell", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const chatWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(controller, /readConversationScrollResumeState/);
  assert.match(controller, /persistConversationScrollResumeState/);
  assert.match(controller, /deriveConversationScrollResumeDecision/);
  assert.match(controller, /routeResumeStatus/);
  assert.doesNotMatch(chatWorkbench, /sessionStorage/);
  assert.doesNotMatch(chatWorkbench, /scrollTop/);
});

test("conversation runtime owns history prepend scroll anchoring", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const chatWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(controller, /pendingHistoryPrependAnchorRef/);
  assert.match(controller, /deriveHistoryPrependAnchorAfterResize/);
  assert.doesNotMatch(chatWorkbench, /captureTranscriptScrollAnchor/);
  assert.doesNotMatch(chatWorkbench, /querySelector<HTMLElement>\('\\[aria-label="Chat transcript"\\]'\)/);
});

test("chat history paging keeps transcript and activity windows in sync", () => {
  const source = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(source, /buildConversationHistoryPrependPlan/);
  assert.match(source, /canApplyConversationHistoryPrependPlan/);
  assert.match(source, /deriveConversationWindowState/);
  assert.match(source, /prependActivityWindow/);
  assert.match(source, /const requestedPrependPlan = conversationHistoryPrependPlan/);
  assert.match(source, /requestedPrependPlan\.transcript/);
  assert.match(source, /requestedPrependPlan\.activity/);
  assert.match(source, /client\.getActivity\(activeSessionId,\s*requestedPrependPlan\.activity\)/);
  assert.match(source, /activityRef/);
  assert.match(source, /commitActivity/);
  assert.doesNotMatch(source, /canLoadOlder=\{transcript\?\.window\?\.has_older/);
});

test("workbench memoizes the web render model adapter output", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );

  assert.match(source, /useMemo/);
  assert.match(source, /toWebChatModel\(model\)/);
});

test("chat typography follows Codex-style reading weight and size", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const assistant = cssBlock(css, "messageResponse");
  const user = cssBlock(css, "userBubble");
  const strong = cssBlockContaining(css, "messageResponse strong");

  assert.match(assistant, /font-size:\s*15px;/);
  assert.match(assistant, /font-weight:\s*400;/);
  assert.match(user, /font-size:\s*15px;/);
  assert.match(user, /font-weight:\s*400;/);
  assert.match(strong, /font-weight:\s*650;/);
});

function cssBlock(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`\\.${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing .${selector} block`);
  return match[1] ?? "";
}

function cssBlockContaining(css: string, selectorFragment: string) {
  const escaped = selectorFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`[^{}]*\\.${escaped}[^{}]*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing selector containing .${selectorFragment}`);
  return match[1] ?? "";
}

test("chat velad proxy forwards PATCH for agent config updates", () => {
  const source = readFileSync(join(root, "app/chat/api/velad/[...path]/route.ts"), "utf8");

  assert.match(source, /export async function PATCH/);
});

test("chat example creates sessions with backend and agent config selections", () => {
  const source = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(source, /selectedBackend/);
  assert.match(source, /agentConfig: setupAgentConfig/);
  assert.match(source, /backend: resolvedSelectedBackend/);
});

test("chat stream connection is keyed by session readiness instead of every cursor update", () => {
  const source = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(source, /const isTranscriptReady = transcript !== null/);
  assert.match(source, /if \(!activeSessionId \|\| !isTranscriptReady\) return/);
  assert.doesNotMatch(source, /\[[^\]]*transcriptEventCursor[^\]]*\]/);
});

test("chat stream handler applies local overlays and scopes read-model refresh", () => {
  const source = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(source, /readVelaStreamEvent/);
  assert.match(source, /applyTranscriptLiveOverlay/);
  assert.match(source, /streamReadModelRefreshPlan/);
  assert.match(source, /transcriptRefreshScheduler\.notifyStreamEvent/);
  assert.match(source, /activityRefreshScheduler\.notifyStreamEvent/);
  assert.doesNotMatch(source, /refresh:\s*loadReadModels/);
});

test("composer plus control is wired to image attachments instead of being decorative", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );
  const composer = readFileSync(
    join(root, "packages/vela-chat-web/src/components/composer/VelaComposer.tsx"),
    "utf8",
  );
  const chatWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");

  assert.match(promptInput, /type="file"/);
  assert.match(promptInput, /accept="image\/\*"/);
  assert.match(promptInput, /onAttachImages/);
  assert.match(composer, /pendingAttachments/);
  assert.match(chatWorkbench, /imageFileToInputPart/);
  assert.match(chatWorkbench, /content: messageContent/);
});
