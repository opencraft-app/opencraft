import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function readChatWorkbenchSource() {
  return [
    "app/chat/ChatWorkbench.tsx",
    "app/chat/workbench/attachments.ts",
    "app/chat/workbench/constants.ts",
    "app/chat/workbench/helpers.ts",
    "app/chat/workbench/renderModel.ts",
    "app/chat/workbench/setupModel.ts",
    "app/chat/workbench/SetupPanel.tsx",
    "app/chat/workbench/streamHandler.ts",
  ]
    .map((path) => `// ${path}\n${readFileSync(join(root, path), "utf8")}`)
    .join("\n");
}

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
    "packages/vela-chat-web/src/conversation-runtime/scroll/bottomAnchorDriver.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/historyPaging.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/routeResume.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/viewportHandle.ts",
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
    "packages/vela-chat-web/src/renderers/markdown/README.md",
    "packages/vela-chat-web/src/renderers/markdown/MarkdownRenderer.tsx",
    "packages/vela-chat-web/src/renderers/markdown/StreamingMarkdownRenderer.tsx",
    "packages/vela-chat-web/src/renderers/markdown/parse.ts",
    "packages/vela-chat-web/src/renderers/markdown/prefixTokenCache.ts",
    "packages/vela-chat-web/src/renderers/markdown/renderTokens.tsx",
    "packages/vela-chat-web/src/renderers/markdown/segmentFade.tsx",
    "packages/vela-chat-web/src/renderers/markdown/streamingRepair.ts",
    "packages/vela-chat-web/src/primitives/README.md",
    "packages/vela-chat-web/src/primitives/message/README.md",
    "packages/vela-chat-web/src/primitives/message/Message.tsx",
    "packages/vela-chat-web/src/primitives/conversation/README.md",
    "packages/vela-chat-web/src/primitives/conversation/Conversation.tsx",
    "packages/vela-chat-web/src/primitives/prompt-input/README.md",
    "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx",
    "packages/vela-chat-web/src/components/README.md",
    "packages/vela-chat-web/src/components/requests/README.md",
    "packages/vela-chat-web/src/components/requests/RequestDock.tsx",
    "packages/vela-chat-web/src/components/requests/requestResponses.ts",
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

test("web partial virtualization keeps row measurement refs stable across parent renders", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx"),
    "utf8",
  );

  assert.match(source, /memo\(function VirtualizedHistoryRow/);
  assert.match(source, /const handleMeasureRef = useCallback/);
  assert.match(source, /ref=\{handleMeasureRef\}/);
  assert.doesNotMatch(
    source,
    /ref=\{\(node\) => measureVirtualizedRowElement\(node, item\)\}/,
  );
});

test("web partial virtualization keeps mounted list hooks unconditional", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/strategy/webVirtualizedStrategy.tsx"),
    "utf8",
  );

  assert.equal(source.match(/return empty;/g)?.length, 1);
  assert.doesNotMatch(source, /function WebPartialVirtualizedItemList[\s\S]*return empty;/);
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

test("turn list passes a stable item renderer into conversation strategies", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx"),
    "utf8",
  );

  assert.match(source, /useCallback/);
  assert.match(source, /const renderConversationItem = useCallback/);
  assert.match(source, /renderItem:\s*renderConversationItem/);
  assert.doesNotMatch(
    source,
    /renderItem:\s*\(item:\s*ConversationStreamItem\)\s*=>\s*\(/,
  );
});

test("turn list is a memoized boundary below conversation scroll state", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnList.tsx"),
    "utf8",
  );

  assert.match(source, /memo\(function VelaTurnList/);
  assert.match(source, /segments:\s*ConversationRuntimeSegments/);
});

test("turn group memoizes stable stream items during high-frequency streaming", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaTurnGroup.tsx"),
    "utf8",
  );

  assert.match(source, /memo\(function VelaTurnGroup/);
  assert.match(source, /item:\s*ConversationStreamItem/);
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

test("assistant markdown renderer does not expose leaf copy controls", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AssistantMarkdownRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /MarkdownRenderer/);
  assert.doesNotMatch(source, />□</);
  assert.doesNotMatch(source, /aria-label="Copy assistant message"/);
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText/);
});

test("assistant markdown uses the Codex-style marked renderer stack", () => {
  const packageJson = readFileSync(join(root, "package.json"), "utf8");
  const markdownRenderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/MarkdownRenderer.tsx"),
    "utf8",
  );
  const streamingMarkdownRenderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/StreamingMarkdownRenderer.tsx"),
    "utf8",
  );
  const renderTokens = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/renderTokens.tsx"),
    "utf8",
  );

  assert.match(packageJson, /"marked"/);
  assert.doesNotMatch(packageJson, /react-markdown|remark-gfm|streamdown|@streamdown/);
  assert.match(markdownRenderer, /parseMarkdownTokens/);
  assert.match(streamingMarkdownRenderer, /repairStreamingMarkdown/);
  assert.match(streamingMarkdownRenderer, /parseStreamingMarkdownTokens/);
  assert.match(streamingMarkdownRenderer, /fadeSegmentDelayMs/);
  assert.match(renderTokens, /MarkedToken/);
  assert.doesNotMatch(markdownRenderer, /react-markdown|remark-gfm|Streamdown/);
  assert.doesNotMatch(streamingMarkdownRenderer, /react-markdown|remark-gfm|Streamdown/);
  assert.doesNotMatch(packageJson, /streamdown|@streamdown/);

  const sourcePaths = listSourceFiles(join(root, "packages/vela-chat-web/src"))
    .map((path) => path.slice(root.length + 1))
    .filter((path) => path.endsWith(".ts") || path.endsWith(".tsx"));

  for (const path of sourcePaths) {
    const source = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(source, /react-markdown|remark-gfm|streamdown|@streamdown|Streamdown/);
  }
});

test("assistant markdown renders fenced code without third-party block chrome", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/renderTokens.tsx"),
    "utf8",
  );

  assert.match(source, /renderCodeToken/);
  assert.match(source, /trimTrailingCodeNewline/);
  assert.doesNotMatch(source, /CodeBlockHeader|CodeBlockContainer|CodeBlockCopyButton|CodeBlockDownloadButton/);
});

test("assistant markdown renders tables without third-party table chrome", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/renderTokens.tsx"),
    "utf8",
  );

  assert.match(source, /renderTableToken/);
  assert.match(source, /styles\.markdownTableScroller/);
  assert.match(source, /styles\.markdownTable/);
  assert.doesNotMatch(source, /TableCopyDropdown|TableDownloadButton|TableDownloadDropdown/);
});

test("assistant markdown hides transient internal scrollbars like Codex", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const conversation = cssBlock(css, "conversation");

  assert.match(conversation, /scrollbar-gutter:\s*stable;/);
  assert.match(conversation, /overscroll-behavior:\s*contain;/);
  assert.match(css, /\.messageResponse pre,\s*\.markdownTableScroller\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(css, /\.messageResponse pre,\s*\.markdownTableScroller\s*\{[^}]*-ms-overflow-style:\s*none;/s);
  assert.match(css, /\.messageResponse pre::-webkit-scrollbar,\s*\.markdownTableScroller::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.doesNotMatch(css, /\.messageResponse pre\s*\{[^}]*scrollbar-width:\s*thin;/s);
  assert.doesNotMatch(css, /\.markdownTableScroller\s*\{[^}]*scrollbar-width:\s*thin;/s);
});

test("assistant markdown renderer dispatches only the live tail through streaming markdown", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AssistantMarkdownRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /MarkdownRenderer/);
  assert.match(source, /StreamingMarkdownRenderer/);
  assert.match(source, /block\.streaming/);
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
  assert.match(controller, /handleContentSizeChange/);
  assert.doesNotMatch(controller, /FOLLOW_SIGNAL_RESIZE_RESTICK_WINDOW_MS/);
  assert.doesNotMatch(controller, /contentResizeRestickUntilRef/);
  assert.match(turnList, /contentRef/);
});

test("conversation scroll controller cancels pending stick on user scroll-away intent", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /markUserIntent\(event\.deltaY < 0 \? "scroll_up" : "scroll_down"\)/);
  assert.match(controller, /userIntent:\s*userIntentRef\.current/);
  assert.match(controller, /handleScrollNearBottomChange/);
  assert.match(controller, /cancelFrame:\s*\(handle\) => cancelScheduledFrame\(handle\)/);
});

test("conversation scroll controller ignores bottom anchoring while browser overscrolls past bottom", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /isOverscrolledPastBottom/);
  assert.match(controller, /scrollToBottom/);
});

test("bottom anchor driver owns post-layout verification retries", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const driver = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/bottomAnchorDriver.ts"),
    "utf8",
  );

  assert.match(controller, /getTransportBehavior/);
  assert.match(driver, /pendingVerification/);
  assert.match(driver, /BOTTOM_ANCHOR_MAX_VERIFICATION_RETRIES/);
  assert.doesNotMatch(controller, /pendingSettleTimeoutRef/);
});

test("conversation scroll controller gates route bottom anchoring on readiness", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(controller, /applyRouteRequest/);
  assert.match(controller, /route_initial_entry/);
  assert.match(controller, /blockedReason/);
  assert.match(controller, /historyStartReadyRef/);
});

test("conversation viewport exposes explicit bottom-anchor intents to the workbench", () => {
  const conversation = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );

  assert.match(conversation, /forwardRef/);
  assert.match(conversation, /useImperativeHandle/);
  assert.match(conversation, /requestBottomAnchor/);
  assert.match(workbenchView, /conversationRef/);
  assert.match(workbenchView, /requestBottomAnchor\("message_sent"\)/);
});

test("message sends can request bottom anchoring after the committed read model update", () => {
  const chatWeb = readFileSync(
    join(root, "packages/vela-chat-web/src/index.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const conversation = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );
  const chatWorkbench = readFileSync(
    join(root, "app/chat/ChatWorkbench.tsx"),
    "utf8",
  );

  assert.match(chatWeb, /messageFollowToken\?:\s*number/);
  assert.match(workbenchView, /messageFollowToken/);
  assert.match(conversation, /messageFollowToken/);
  assert.match(conversation, /requestBottomAnchor\("message_sent"\)/);
  assert.match(chatWorkbench, /setMessageFollowToken/);
  assert.match(chatWorkbench, /messageFollowToken=\{messageFollowToken\}/);
});

test("composer height is measured instead of using fixed bottom padding", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );
  const composer = readFileSync(
    join(root, "packages/vela-chat-web/src/components/composer/VelaComposer.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(promptInput, /ResizeObserver/);
  assert.match(promptInput, /onHeightChange/);
  assert.match(composer, /onHeightChange/);
  assert.match(workbenchView, /--vela-composer-height/);
  assert.match(css, /var\(--vela-composer-height/);
  assert.doesNotMatch(css, /padding:\s*54px 28px 178px/);
  assert.doesNotMatch(css, /padding:\s*38px 20px 164px/);
});

test("composer backdrop is an independent layer between conversation content and input", () => {
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(workbenchView, /styles\.composerBackdrop/);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*position:\s*fixed;/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*height:\s*var\(--vela-composer-height\);/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*rgb\(255 255 255 \/ 0\)\s*0%/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*var\(--vela-bg\)\s*50%/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*z-index:\s*19;/s);
  assert.match(css, /\.composerDock\s*\{[^}]*z-index:\s*20;/s);
  assert.match(css, /\.composerDock\s*\{[^}]*padding:\s*0 24px 24px;/s);
  assert.doesNotMatch(css, /\.composerDock\s*\{[^}]*background:/s);
  assert.doesNotMatch(css, /\.composerDock\s*\{[^}]*height:\s*calc\(var\(--vela-composer-height\)/s);
});

test("chat shell keeps document scrolling out of the conversation runtime", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(css, /\.shell\s*\{[^}]*height:\s*100dvh;/s);
  assert.match(css, /\.shell\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.frame\s*\{[^}]*height:\s*100%;/s);
  assert.match(css, /\.frame\s*\{[^}]*min-height:\s*0;/s);
  assert.match(css, /\.conversation\s*\{[^}]*overflow-y:\s*auto;/s);
});

test("chat debug snapshot includes conversation scroll runtime state", () => {
  const chatWorkbench = readChatWorkbenchSource();
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
  const chatWorkbench = readChatWorkbenchSource();

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
  const chatWorkbench = readChatWorkbenchSource();

  assert.match(controller, /pendingHistoryPrependAnchorRef/);
  assert.match(controller, /deriveHistoryPrependAnchorAfterResize/);
  assert.doesNotMatch(chatWorkbench, /captureTranscriptScrollAnchor/);
  assert.doesNotMatch(chatWorkbench, /querySelector<HTMLElement>\('\\[aria-label="Chat transcript"\\]'\)/);
});

test("chat history paging uses the ConversationView window contract", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /buildConversationHistoryPrependPlan/);
  assert.match(source, /canApplyConversationHistoryPrependPlan/);
  assert.match(source, /deriveConversationWindowState/);
  assert.match(source, /prependConversationWindow/);
  assert.match(source, /const requestedPrependPlan = conversationHistoryPrependPlan/);
  assert.match(source, /requestedPrependPlan\.conversation/);
  assert.match(source, /client\.getConversation\(requestedSessionId,\s*requestedPrependPlan\.conversation\)/);
  assert.match(source, /conversationRef/);
  assert.match(source, /commitConversation/);
  assert.doesNotMatch(source, /prependActivityWindow/);
  assert.doesNotMatch(source, /prependTranscriptWindow/);
  assert.doesNotMatch(source, /requestedPrependPlan\.activity/);
  assert.doesNotMatch(source, /requestedPrependPlan\.transcript/);
  assert.doesNotMatch(source, /canLoadOlder=\{transcript\?\.window\?\.has_older/);
});

test("chat fallback read models keep OpenAPI-required envelopes", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /const surfaceSessionId = activeSessionId \|\| "unselected"/);
  assert.match(source, /conversation: conversation \?\? \{/);
  assert.match(source, /session_id: surfaceSessionId/);
  assert.match(source, /window: \{ has_older: false, has_newer: false \}/);
  assert.match(source, /event_id: ""/);
  assert.match(source, /epoch: 0/);
  assert.match(source, /seq: 0/);
  assert.match(source, /conversation: conversation \?\? \{[\s\S]*?cursor: EMPTY_EVENT_CURSOR,[\s\S]*?\n    \},\n    requests:/);
  assert.match(source, /requests: requests \?\? \{ requests: \[\], cursor: EMPTY_CURSOR_WINDOW \}/);
  assert.doesNotMatch(source, /transcript: transcript \?\? \{ rows: \[\], cursor: \{\} \}/);
  assert.doesNotMatch(source, /activity: activity \?\? \{ items: \[\], cursor: \{\} \}/);
  assert.doesNotMatch(source, /requests: activeRequests \?\? \{ requests: \[\], cursor: \{\} \}/);
});

test("chat workbench scopes read models to the active session before stream and render", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /readModelForActiveSession\(activeSessionId,\s*conversation\)/);
  assert.match(source, /pendingRequestsForActiveSession\(activeSessionId,\s*requests\)/);
  assert.match(source, /conversation:\s*activeConversation\?\.cursor/);
  assert.match(source, /const isConversationReady = activeConversation !== null/);
  assert.match(source, /buildWorkbenchRenderModel\(\{[\s\S]*?conversation: activeConversation/);
  assert.match(source, /buildWorkbenchRenderModel\(\{[\s\S]*?requests: activeRequests/);
});

test("chat workbench ignores late read-model responses from stale sessions", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /activeSessionIdRef/);
  assert.match(source, /const requestedSessionId = activeSessionId/);
  assert.match(
    source,
    /if \(!isCurrentSessionRequest\(activeSessionIdRef\.current,\s*requestedSessionId\)\) return;/,
  );
  assert.match(source, /resetSessionReadModels/);
  assert.match(source, /openSession:[\s\S]*?resetSessionReadModels\(\);/);
});

test("workbench memoizes the web render model adapter output", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );

  assert.match(source, /useMemo/);
  assert.match(source, /toWebChatModel\(model\)/);
});

test("workbench does not invent memory references without a render-model field", () => {
  const workbench = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const adapter = readFileSync(
    join(root, "packages/vela-chat-web/src/adapters/toWebBlocks.ts"),
    "utf8",
  );

  assert.doesNotMatch(workbench, /条记忆引用/);
  assert.doesNotMatch(workbench, /styles\.topbar/);
  assert.match(workbench, /frameWithoutTopbarStyle/);
  assert.doesNotMatch(adapter, /memoryReferenceCount/);
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

test("chat markdown and agent work use compact Codex-style vertical rhythm", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const assistant = cssBlock(css, "messageResponse");
  const paragraph = cssBlockContaining(css, "messageResponse p");
  const heading = cssBlockContaining(css, "messageResponse h1");
  const list = cssBlockContaining(css, "messageResponse ul");
  const listItem = cssBlockContaining(css, "messageResponse li");
  const codeBlock = cssBlockContaining(css, "messageResponse pre");
  const tableScroller = cssBlock(css, "markdownTableScroller");
  const table = cssBlock(css, "markdownTable");
  const tableCell = cssBlock(css, "markdownTableCell");
  const agentWork = cssBlock(css, "agentWorkBlock");
  const agentWorkGroup = cssBlock(css, "agentWorkGroup");
  const agentWorkChildren = cssBlock(css, "agentWorkGroupChildren");
  const continuationTurn = cssBlockContaining(css, 'turnGroup[data-continuation="true"]');
  const assistantBeforeContinuation = cssBlockContaining(
    css,
    'turnGroup[data-turn-kind="assistant_markdown"]:has',
  );
  const continuationAssistant = cssBlockContaining(
    css,
    'turnGroup[data-continuation="true"][data-turn-kind="assistant_markdown"] .messageAssistant',
  );
  const workToAssistantGap = cssBlockContaining(
    css,
    'turnGroup[data-turn-kind="agent_work"] + .turnGroup[data-turn-kind="assistant_markdown"]',
  );

  assert.match(assistant, /line-height:\s*1\.56;/);
  assert.match(paragraph, /margin:\s*0 0 12px;/);
  assert.match(heading, /margin:\s*18px 0 8px;/);
  assert.match(heading, /line-height:\s*1\.28;/);
  assert.match(list, /margin:\s*0 0 12px;/);
  assert.match(listItem, /margin:\s*0;/);
  assert.match(codeBlock, /margin:\s*14px 0;/);
  assert.match(tableScroller, /margin:\s*14px 0;/);
  assert.match(tableScroller, /overflow-x:\s*auto;/);
  assert.match(table, /border:\s*1px solid var\(--vela-border\);/);
  assert.doesNotMatch(tableScroller, /border:/);
  assert.match(tableCell, /padding:\s*10px 14px;/);
  assert.match(agentWork, /line-height:\s*1\.35;/);
  assert.match(agentWork, /padding:\s*1px 0;/);
  assert.match(agentWorkGroup, /gap:\s*4px;/);
  assert.match(agentWorkChildren, /gap:\s*3px;/);
  assert.match(continuationTurn, /margin-top:\s*0;/);
  assert.match(assistantBeforeContinuation, /margin-bottom:\s*8px;/);
  assert.match(continuationAssistant, /margin-top:\s*0;/);
  assert.match(workToAssistantGap, /margin-top:\s*18px;/);
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

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : [path];
  });
}

test("chat velad proxy forwards PATCH for agent config updates", () => {
  const source = readFileSync(join(root, "app/chat/api/velad/[...path]/route.ts"), "utf8");

  assert.match(source, /export async function PATCH/);
});

test("chat example creates sessions with backend and agent config selections", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /selectedBackend/);
  assert.match(source, /agentConfig: setupAgentConfig/);
  assert.match(source, /backend: resolvedSelectedBackend/);
});

test("chat composer preserves draft when velad returns a rejected CommandAck", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /commandAckRejectionMessage/);
  assert.match(source, /const ack = await client\.sendUserMessage/);
  assert.match(source, /const rejectionMessage = commandAckRejectionMessage\(ack\);/);
  assert.match(source, /if \(rejectionMessage\) \{\s*setError\(rejectionMessage\);\s*return;\s*\}/);
  assert.doesNotMatch(
    source,
    /await client\.sendUserMessage\(\{ sessionId: activeSessionId, content: messageContent \}\);\s*setDraft\(""\);/,
  );
});

test("chat stream connection is keyed by session readiness instead of every cursor update", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /const isConversationReady = activeConversation !== null/);
  assert.match(source, /selectSessionEventStreamAfterId/);
  assert.match(source, /conversation:\s*activeConversation\?\.cursor/);
  assert.match(source, /if \(!activeSessionId \|\| !isConversationReady\) return/);
  assert.doesNotMatch(source, /\[[^\]]*transcriptEventCursor[^\]]*\]/);
  assert.doesNotMatch(source, /const transcriptEventCursor = cursorEventId\(transcript\?\.cursor\)/);
});

test("chat stream handler applies local overlays and scopes read-model refresh", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /readVelaStreamEvent/);
  assert.match(source, /isVelaStreamEventForSession/);
  assert.match(
    source,
    /if \(!isVelaStreamEventForSession\(activeSessionId,\s*streamEvent\)\) return;/,
  );
  assert.doesNotMatch(source, /isVelaStreamEventFreshForCursor/);
  assert.doesNotMatch(source, /currentTranscript\.cursor,\s*streamEvent\)\) return/);
  assert.match(source, /applyConversationLiveOverlay/);
  assert.match(source, /streamReadModelRefreshPlanForCursors/);
  assert.match(source, /conversation:\s*currentConversation\?\.cursor/);
  assert.match(source, /requests:\s*currentRequests\?\.cursor/);
  assert.match(source, /conversationRefreshScheduler\.notifyStreamEvent/);
  assert.doesNotMatch(source, /activityRefreshScheduler\.notifyStreamEvent/);
  assert.doesNotMatch(source, /refresh:\s*loadReadModels/);
});

test("chat request dock uses PendingRequestsView and responds through input events", () => {
  const chatWorkbench = readChatWorkbenchSource();
  const requestResponses = readFileSync(
    join(root, "packages/vela-chat-web/src/components/requests/requestResponses.ts"),
    "utf8",
  );
  const requestDock = readFileSync(
    join(root, "packages/vela-chat-web/src/components/requests/RequestDock.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );

  assert.match(chatWorkbench, /client\.getPendingRequests\(requestedSessionId,\s*\{\s*status:\s*"pending"\s*\}\)/);
  assert.match(chatWorkbench, /requestsRefreshScheduler\.notifyStreamEvent/);
  assert.match(chatWorkbench, /refreshPlan\.requests/);
  assert.match(chatWorkbench, /client\.sendSessionInputEvents\(\{\s*sessionId:\s*activeSessionId/);
  assert.match(chatWorkbench, /buildRequestResponseInputEvent/);
  assert.match(requestResponses, /type:\s*"user\.tool_confirmation"/);
  assert.match(requestResponses, /type:\s*"user\.request_answer"/);
  assert.match(requestResponses, /request_id:\s*response\.requestId/);
  assert.match(requestDock, /response_kind === "answer"/);
  assert.match(requestDock, /textarea/);
  assert.match(workbenchView, /RequestDock/);
  assert.match(workbenchView, /onRespondToRequest/);
  assert.doesNotMatch(workbenchView, /AgentRequestWire/);
  assert.equal(existsSync(join(root, "app/chat/requestResponses.ts")), false);
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
  const chatWorkbench = readChatWorkbenchSource();

  assert.match(promptInput, /type="file"/);
  assert.match(promptInput, /accept="image\/\*"/);
  assert.match(promptInput, /onAttachImages/);
  assert.match(composer, /pendingAttachments/);
  assert.match(chatWorkbench, /imageFileToInputPart/);
  assert.match(chatWorkbench, /content: messageContent/);
});

test("composer primary control has stable accessible action labels", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );

  assert.match(promptInput, /aria-label=\{isStopControl \? "Stop generation" : "Send message"\}/);
  assert.match(promptInput, /title=\{isStopControl \? "Stop generation" : "Send message"\}/);
});

test("composer primary control switches to stop while a turn is running", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );
  const composer = readFileSync(
    join(root, "packages/vela-chat-web/src/components/composer/VelaComposer.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const chatWeb = readFileSync(
    join(root, "packages/vela-chat-web/src/index.tsx"),
    "utf8",
  );
  const chatWorkbench = readChatWorkbenchSource();

  assert.match(promptInput, /isRunning/);
  assert.match(promptInput, /onStop/);
  assert.match(promptInput, /aria-label=\{isStopControl \? "Stop generation" : "Send message"\}/);
  assert.match(promptInput, /<span className=\{styles\.stopGlyph\} aria-hidden="true" \/>/);
  assert.match(composer, /isRunning/);
  assert.match(composer, /onStop/);
  assert.match(workbenchView, /isRunning=\{webModel\.composer\.isRunning\}/);
  assert.match(workbenchView, /onStop=\{onStop\}/);
  assert.match(chatWeb, /onStop\?:\s*\(\) => void/);
  assert.match(chatWorkbench, /client\.cancelSession\(\{ sessionId: requestedSessionId \}\)/);
});

test("composer does not expose dictation as an enabled mock action", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );

  assert.match(promptInput, /aria-label="Dictation unavailable"/);
  assert.match(promptInput, /title="Dictation unavailable"/);
  assert.match(
    promptInput,
    /<button[\s\S]*aria-label="Dictation unavailable"[\s\S]*disabled[\s\S]*>\s*⌘\s*<\/button>/,
  );
  assert.doesNotMatch(promptInput, /aria-label="Dictation"/);
});

test("user message copy control is omitted when there is no text to copy", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /const copyText = block\.copyText \|\| text;/);
  assert.match(source, /\{copyText \? \(/);
  assert.match(source, /copyMessageText\(copyText\)/);
});

test("user message timestamps use stable twenty-four hour display", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /toLocaleTimeString\(\[\], \{ hour: "2-digit", minute: "2-digit", hour12: false \}\)/);
});

test("user message renderer preserves explicit multiline text breaks", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /renderUserTextWithLineBreaks\(text\)/);
  assert.match(source, /text\.split\("\\n"\)/);
  assert.match(source, /<br key=\{`line-break:\$\{index\}`\} \/>/);
});

test("user uploaded images avoid blocking long conversation rendering", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/UserMessageRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /loading="lazy"/);
  assert.match(source, /decoding="async"/);
});
