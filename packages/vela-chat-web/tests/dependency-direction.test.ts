import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("repository root stays free of local browser debug artifacts", () => {
  const forbiddenExactPaths = [
    ".DS_Store",
    "scroll-test.html",
    "content/对话.md",
  ];

  for (const path of forbiddenExactPaths) {
    assert.equal(existsSync(join(root, path)), false, `${path} should not be checked in or kept as a workspace artifact`);
  }

  const rootFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const generatedAppAssets = rootFiles.filter((name) => /^(app|index)-[A-Za-z0-9_-]+\.(css|js)$/.test(name));
  assert.deepEqual(generatedAppAssets, []);
});

function readChatWorkbenchSource() {
  return [
    "app/chat/ChatWorkbench.tsx",
    "app/chat/workbench/helpers.ts",
    "app/chat/workbench/session-launcher/DebugSessionLauncher.tsx",
    "app/chat/workbench/session-launcher/model.ts",
    "packages/vela-chat-client/src/eventStream.ts",
    "packages/vela-chat-controller/src/attachments.ts",
    "packages/vela-chat-controller/src/constants.ts",
    "packages/vela-chat-controller/src/historyPolicy.ts",
    "packages/vela-chat-controller/src/renderModel.ts",
    "packages/vela-chat-controller/src/sessionScopedReadModels.ts",
    "packages/vela-chat-controller/src/sessionEventStream.ts",
    "packages/vela-chat-controller/src/setupModel.ts",
    "packages/vela-chat-controller/src/streamHandler.ts",
    "packages/vela-chat-controller/src/useVelaChatSession.ts",
  ]
    .map((path) => `// ${path}\n${readFileSync(join(root, path), "utf8")}`)
    .join("\n");
}

test("chat debug session launcher stays isolated from reusable ChatUI", () => {
  const expectedPaths = [
    "app/chat/workbench/session-launcher/README.md",
    "app/chat/workbench/session-launcher/DebugSessionLauncher.tsx",
    "app/chat/workbench/session-launcher/model.ts",
  ];
  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }

  const chatWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");
  const webPackage = readdirSync(join(root, "packages/vela-chat-web/src"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
    .join("\n");

  assert.match(chatWorkbench, /DebugSessionLauncher/);
  assert.match(chatWorkbench, /client\.getSessionListView\(\{ limit: 12 \}\)/);
  assert.doesNotMatch(chatWorkbench, /SetupPanel/);
  assert.doesNotMatch(webPackage, /DebugSessionLauncher/);
  assert.doesNotMatch(webPackage, /listSessions/);
});

test("next adapter embeds ChatUI without debug or desktop shell concerns", () => {
  const expectedPaths = [
    "packages/vela-chat-next/README.md",
    "packages/vela-chat-next/src/README.md",
    "packages/vela-chat-next/src/VelaNextChat.tsx",
    "packages/vela-chat-next/src/index.ts",
    "app/next-embed-demo/README.md",
    "app/next-embed-demo/NextEmbedDemo.tsx",
    "app/next-embed-demo/page.module.css",
    "app/next-embed-demo/page.tsx",
  ];
  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }

  const adapter = readFileSync(
    join(root, "packages/vela-chat-next/src/VelaNextChat.tsx"),
    "utf8",
  );
  const webEntrypoint = readFileSync(
    join(root, "packages/vela-chat-web/src/index.tsx"),
    "utf8",
  );
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const desktopCss = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const demoPage = readFileSync(join(root, "app/next-embed-demo/page.tsx"), "utf8");
  const demoShell = readFileSync(join(root, "app/next-embed-demo/NextEmbedDemo.tsx"), "utf8");

  assert.match(adapter, /^"use client";/);
  assert.match(adapter, /useVelaChatSession/);
  assert.match(adapter, /createVeladClient/);
  assert.match(adapter, /createBrowserVelaClientStateStore/);
  assert.match(adapter, /VelaChatWeb/);
  assert.match(adapter, /layout="contained"/);
  assert.doesNotMatch(adapter, /DebugSessionLauncher|VelaDesktopShell|vela-chat-debug/);

  assert.match(webEntrypoint, /type VelaChatWebProps = ChatSurfaceProps/);
  assert.match(chatSurface, /layout\?:\s*"viewport" \| "contained"/);
  assert.match(workbenchView, /data-layout=\{layout\}/);
  assert.match(desktopCss, /\.shell\[data-layout="contained"\]\s*\{[^}]*height:\s*100%;/s);
  assert.match(demoPage, /NextEmbedDemo/);
  assert.match(demoShell, /VelaNextChat/);
  assert.doesNotMatch(demoShell, /DebugSessionLauncher|VelaDesktopShell|vela-chat-debug/);
});

test("chat history hydration is a reusable ChatUI phase instead of host-specific branching", () => {
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const desktopApp = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const nextWorkbench = readFileSync(join(root, "app/chat/ChatWorkbench.tsx"), "utf8");
  const controller = readFileSync(
    join(root, "packages/vela-chat-controller/src/useVelaChatSession.ts"),
    "utf8",
  );

  assert.match(controller, /historyPhase/);
  assert.doesNotMatch(controller, /isHistoryHydrating/);
  assert.match(chatSurface, /historyPhase/);
  assert.match(workbenchView, /historyPhase === "hydrating_history"/);
  assert.match(workbenchView, /ConversationHistoryHydrationView/);
  assert.doesNotMatch(nextWorkbench, /ConversationHistoryHydrationScreen/);
  assert.doesNotMatch(nextWorkbench, /isHistoryHydrating/);
  assert.match(nextWorkbench, /historyPhase=\{controller\.historyPhase\}/);
  assert.match(desktopApp, /historyPhase=\{controller\.historyPhase\}/);
});

test("chat controller initial refresh is not coupled to backend state", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-controller/src/useVelaChatSession.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /Promise\.resolve\(\{\s*backends\s*\}\)/);
  assert.doesNotMatch(source, /}, \[activeSessionId, backends,/);
  assert.match(source, /fetchBackends \? client\.getBackends\(\) : Promise\.resolve\(null\)/);
});

test("web renderer consumes render model and does not inspect transcript wire fields", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );

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
    "packages/vela-chat-web/src/conversation-runtime/scroll/scrollResumePersistence.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts",
    "packages/vela-chat-web/src/conversation-runtime/scroll/viewportHandle.ts",
    "packages/vela-chat-web/src/conversation-runtime/scrollbar/README.md",
    "packages/vela-chat-web/src/conversation-runtime/scrollbar/geometry.ts",
    "packages/vela-chat-web/src/conversation-runtime/scrollbar/useConversationScrollbarOverlay.tsx",
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
    "packages/vela-chat-web/src/composer-editor/README.md",
    "packages/vela-chat-web/src/composer-editor/LexicalComposerEditor.tsx",
    "packages/vela-chat-web/src/composer-editor/index.ts",
    "packages/vela-chat-web/src/composer-editor/model.ts",
    "packages/vela-chat-web/src/composer-editor/types.ts",
    "packages/vela-chat-web/src/components/README.md",
    "packages/vela-chat-web/src/components/requests/README.md",
    "packages/vela-chat-web/src/components/requests/RequestDock.tsx",
    "packages/vela-chat-web/src/components/requests/requestResponses.ts",
    "packages/vela-chat-web/src/components/workbench/README.md",
    "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx",
    "packages/vela-chat-web/src/components/workbench/ConversationHistoryHydrationView.tsx",
    "packages/vela-chat-web/src/components/workbench/ConversationScrollInspector.tsx",
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
    "packages/vela-chat-web/src/new-session/README.md",
    "packages/vela-chat-web/src/new-session/NewSessionSurface.tsx",
    "packages/vela-chat-web/src/new-session/index.ts",
    "packages/vela-chat-web/src/new-session/model.ts",
    "packages/vela-chat-web/src/styles/README.md",
    "packages/vela-chat-web/src/styles/VISUAL_CONTRACT.md",
    "packages/vela-chat-web/src/styles/desktop.module.css",
  ];

  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }
});

test("scroll inspector is an explicit dev-only ChatUI diagnostic boundary", () => {
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
    "utf8",
  );
  const workbenchView = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ChatWorkbenchView.tsx"),
    "utf8",
  );
  const inspector = readFileSync(
    join(root, "packages/vela-chat-web/src/components/workbench/ConversationScrollInspector.tsx"),
    "utf8",
  );
  const css = readFileSync(join(root, "packages/vela-chat-web/src/styles/desktop.module.css"), "utf8");

  assert.match(chatSurface, /showScrollInspector\?: boolean/);
  assert.match(workbenchView, /ConversationScrollInspector/);
  assert.match(workbenchView, /showScrollInspector/);
  assert.match(inspector, /ConversationScrollControllerDebug/);
  assert.doesNotMatch(inspector, /openapi|created_at|event_range|localStorage|sessionStorage/i);
  assert.match(css, /\.scrollInspector\b/);
});

test("ChatUI visual contract explicitly owns markdown and scrollbar visual rules", () => {
  const contract = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/VISUAL_CONTRACT.md"),
    "utf8",
  );
  const css = readFileSync(join(root, "packages/vela-chat-web/src/styles/desktop.module.css"), "utf8");

  assert.match(contract, /Markdown Visual Rules/);
  assert.match(contract, /Horizontal rules/);
  assert.match(contract, /Tables/);
  assert.match(contract, /Lists/);
  assert.match(contract, /Code/);
  assert.match(contract, /Scrollbar Visual Rules/);
  assert.match(css, /\.messageResponse hr\b/);
  assert.match(css, /\.messageResponse pre\b/);
  assert.match(css, /\.markdownTableScroller\b/);
});

test("streaming visible text growth is treated as DOM geometry, not a read-model signal only", () => {
  const scrollModel = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/SCROLL_MODEL.md"),
    "utf8",
  );
  const scrollController = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const streamingRenderer = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/StreamingMarkdownRenderer.tsx"),
    "utf8",
  );

  assert.match(scrollModel, /Streaming Renderer Growth/);
  assert.match(scrollModel, /visibleText/);
  assert.match(scrollModel, /ResizeObserver/);
  assert.match(scrollController, /resizeObserver\.observe\(contentElement\)/);
  assert.match(streamingRenderer, /data-live-text-pending/);
});

test("package entrypoint stays thin and delegates desktop rendering details", () => {
  const source = readFileSync(join(root, "packages/vela-chat-web/src/index.tsx"), "utf8");

  assert.match(source, /ChatSurface/);
  assert.equal(source.includes("function MarkdownBlock"), false);
  assert.equal(source.includes("function renderInlineCode"), false);
  assert.equal(source.includes("<textarea"), false);
});

test("composer editor boundary hides Lexical behind a stable model", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );
  const editorIndex = readFileSync(
    join(root, "packages/vela-chat-web/src/composer-editor/index.ts"),
    "utf8",
  );
  const editorTypes = readFileSync(
    join(root, "packages/vela-chat-web/src/composer-editor/types.ts"),
    "utf8",
  );
  const editorModel = readFileSync(
    join(root, "packages/vela-chat-web/src/composer-editor/model.ts"),
    "utf8",
  );
  const lexicalEditor = readFileSync(
    join(root, "packages/vela-chat-web/src/composer-editor/LexicalComposerEditor.tsx"),
    "utf8",
  );

  assert.match(promptInput, /LexicalComposerEditor/);
  assert.equal(promptInput.includes("<textarea"), false);
  assert.match(editorIndex, /ComposerEditorHandle/);
  assert.match(editorTypes, /interface ComposerEditorSnapshot/);
  assert.match(editorTypes, /interface ComposerEditorHandle/);
  assert.match(editorModel, /createComposerEditorSnapshot/);
  assert.match(lexicalEditor, /@lexical\/react\/LexicalComposer/);
  assert.doesNotMatch(promptInput, /@lexical\/react|from "lexical"/);
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
  assert.match(streamingMarkdownRenderer, /useBufferedStreamingText/);
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

test("chat transcript hides native scrollbars behind a cross-platform overlay", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const conversation = cssBlock(css, "conversation");
  const conversationSource = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );
  const overlaySource = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scrollbar/useConversationScrollbarOverlay.tsx"),
    "utf8",
  );

  assert.match(conversationSource, /useConversationScrollbarOverlay/);
  assert.match(overlaySource, /ResizeObserver/);
  assert.match(overlaySource, /applyConversationScrollWrite/);
  assert.match(overlaySource, /source:\s*"scrollbar_overlay"/);
  assert.doesNotMatch(overlaySource, /\b(?:element|scrollElement|container)\.scrollTop\s*=/);
  assert.match(overlaySource, /computeScrollOffsetFromThumbOffset/);
  assert.match(conversation, /overscroll-behavior:\s*contain;/);
  assert.match(conversation, /scrollbar-width:\s*none;/);
  assert.match(conversation, /-ms-overflow-style:\s*none;/);
  assert.match(conversation, /scrollbar-gutter:\s*auto;/);
  assert.doesNotMatch(conversation, /scroll-behavior:\s*smooth;/);
  assert.match(css, /\.conversation::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /\.conversation::-webkit-scrollbar\s*\{[^}]*width:\s*0;/s);
  assert.match(css, /\.conversation::-webkit-scrollbar\s*\{[^}]*height:\s*0;/s);
  assert.match(css, /\.conversationScrollbarOverlay\s*\{/);
  assert.match(css, /\.conversationScrollbarThumb\s*\{/);
  assert.doesNotMatch(css, /\.conversationScrollbarThumbHitbox\s*\{[^}]*transition:\s*transform/s);
  assert.match(css, /\.messageResponse pre,\s*\.markdownTableScroller\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(css, /\.messageResponse pre,\s*\.markdownTableScroller\s*\{[^}]*-ms-overflow-style:\s*none;/s);
  assert.match(css, /\.messageResponse pre::-webkit-scrollbar,\s*\.markdownTableScroller::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.doesNotMatch(conversation, /scrollbar-gutter:\s*stable;/);
  assert.doesNotMatch(css, /\.messageResponse pre\s*\{[^}]*scrollbar-width:\s*thin;/s);
  assert.doesNotMatch(css, /\.markdownTableScroller\s*\{[^}]*scrollbar-width:\s*thin;/s);
});

test("chat viewport prevents horizontal panning while markdown leaves keep local scrollers", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const conversation = cssBlock(css, "conversation");
  const turnList = cssBlock(css, "turnList");
  const tableScroller = cssBlock(css, "markdownTableScroller");

  assert.match(conversation, /overflow-x:\s*hidden;/);
  assert.match(turnList, /box-sizing:\s*border-box;/);
  assert.match(tableScroller, /overflow-x:\s*auto;/);
});

test("streaming markdown never overlays live text with a blocking tail mask", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.doesNotMatch(css, /messageResponse\[data-live-text-pending=.*?::after/s);
});

test("streaming markdown fade keeps pending text readable", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const fadeStart = css.match(/@keyframes\s+velaMarkdownFadeIn\s*\{[\s\S]*?from\s*\{[\s\S]*?opacity:\s*([0-9.]+)/);

  assert.ok(fadeStart, "expected markdown fade start opacity to be explicit");
  const opacity = Number(fadeStart[1]);
  assert.ok(
    opacity >= 0.42,
    "streaming markdown fade must not make pending text look missing",
  );
  assert.ok(
    opacity <= 0.58,
    "streaming markdown fade must remain visible enough to avoid chunky text pops",
  );
});

test("assistant markdown renderer dispatches only the live tail through streaming markdown", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/blocks/AssistantMarkdownRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /MarkdownRenderer/);
  assert.match(source, /StreamingMarkdownRenderer/);
  assert.match(source, /block\.streaming/);
  assert.match(source, /onSettled/);
});

test("streaming markdown renderer drives buffered text at animation-frame cadence", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/renderers/markdown/StreamingMarkdownRenderer.tsx"),
    "utf8",
  );

  assert.match(source, /frameIntervalMs:\s*16/);
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
  assert.match(controller, /const userIntent = userIntentRef\.current/);
  assert.match(controller, /userIntent,\s*\}\);/);
  assert.match(controller, /requestIntent:\s*userIntent/);
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
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
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
  const controller = readFileSync(
    join(root, "packages/vela-chat-controller/src/useVelaChatSession.ts"),
    "utf8",
  );

  assert.match(chatSurface, /messageFollowToken\?:\s*number/);
  assert.match(workbenchView, /messageFollowToken/);
  assert.match(conversation, /messageFollowToken/);
  assert.match(conversation, /requestBottomAnchor\("message_sent"\)/);
  assert.match(controller, /setMessageFollowToken/);
  assert.match(chatWorkbench, /messageFollowToken=\{controller\.messageFollowToken\}/);
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
  const sharedShellTokenBlock =
    stylesBlock(css, /\.shell,\s*\.newSessionShell\s*\{([\s\S]*?)\}/);

  assert.match(workbenchView, /styles\.composerBackdrop/);
  assert.match(css, /--vela-bg:\s*rgb\(255 255 255 \/ [0-9.]+%\);/);
  assert.match(css, /\.shell\s*\{[^}]*position:\s*relative;/s);
  assert.match(css, /\.shell\s*\{[^}]*width:\s*100%;/s);
  assert.match(css, /\.shell\s*\{[^}]*min-width:\s*0;/s);
  assert.match(sharedShellTokenBlock, /--vela-spacing:\s*0\.25rem;/);
  assert.match(sharedShellTokenBlock, /--vela-toolbar-height:\s*46px;/);
  assert.match(sharedShellTokenBlock, /--vela-shell-radius:\s*16px;/);
  assert.doesNotMatch(sharedShellTokenBlock, /--vela-composer-radius:/);
  assert.doesNotMatch(sharedShellTokenBlock, /--vela-composer-bg:/);
  assert.doesNotMatch(sharedShellTokenBlock, /--vela-composer-blur:/);
  assert.doesNotMatch(sharedShellTokenBlock, /--vela-composer-shadow:/);
  assert.match(sharedShellTokenBlock, /background:\s*var\(--vela-bg\);/);
  assert.match(sharedShellTokenBlock, /color:\s*var\(--vela-text\);/);
  assert.match(css, /\.shell\s*\{[^}]*border-top-left-radius:\s*var\(--vela-shell-radius\);/s);
  assert.match(css, /\.shell\s*\{[^}]*-webkit-backdrop-filter:\s*saturate/s);
  assert.match(css, /\.shell\s*\{[^}]*backdrop-filter:\s*saturate/s);
  assert.doesNotMatch(css, /\.shell\s*\{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.frame\s*\{[^}]*position:\s*relative;/s);
  assert.match(css, /\.frame\s*\{[^}]*isolation:\s*isolate;/s);
  assert.match(css, /\.frame\s*\{[^}]*border-top:\s*1px solid var\(--vela-border\);/s);
  assert.match(css, /\.frame::before\s*\{[^}]*height:\s*16px;/s);
  assert.match(css, /\.frame::before\s*\{[^}]*background:\s*linear-gradient\(to bottom, var\(--vela-bg\), rgb\(255 255 255 \/ 0\)\);/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*height:\s*calc\(var\(--vela-composer-height\) \+ 64px\);/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*rgb\(255 255 255 \/ 0\)\s*0%/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*var\(--vela-bg\)\s*54%/s);
  assert.match(css, /\.composerBackdrop\s*\{[^}]*z-index:\s*19;/s);
  assert.match(css, /\.composerDock\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.composerDock\s*\{[^}]*z-index:\s*20;/s);
  assert.match(
    css,
    /\.composerDock\s*\{[^}]*padding:\s*0 24px var\(--vela-thread-floating-content-bottom-inset,\s*12px\);/s,
  );
  assert.match(css, /\.requestDock\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.requestDock\s*\{[^}]*bottom:\s*calc\(var\(--vela-composer-height\) \+ var\(--vela-thread-floating-content-top-inset\)\);/s);
  assert.match(css, /\.error\s*\{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.error\s*\{[^}]*bottom:\s*calc\(var\(--vela-composer-height\) \+ var\(--vela-thread-floating-content-top-inset\)\);/s);
  assert.doesNotMatch(css, /\.composerBackdrop\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(css, /\.composerDock\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(css, /\.requestDock\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(css, /\.error\s*\{[^}]*position:\s*fixed;/s);
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
  const scrollController = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(conversation, /onScrollDebugChange/);
  assert.match(conversation, /scroll\.debug/);
  assert.match(chatWorkbench, /conversationScrollDebug/);
  assert.match(chatWorkbench, /scroll:\s*controller\.conversationScrollDebug/);
  assert.match(scrollController, /routeResumeStatus/);
  assert.match(scrollController, /routeResumeScrollTop/);
});

test("conversation runtime owns session scroll resume instead of the page shell", () => {
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const routeResume = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/routeResume.ts"),
    "utf8",
  );
  const scrollResumePersistence = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/scrollResumePersistence.ts"),
    "utf8",
  );
  const chatWorkbench = readChatWorkbenchSource();

  assert.match(controller, /clientStateStore/);
  assert.match(controller, /conversationScroll\.read/);
  assert.match(controller, /conversationScroll\.write/);
  assert.match(routeResume, /deriveConversationScrollResumeDecision/);
  assert.match(scrollResumePersistence, /flush\(\)/);
  assert.match(controller, /flushPendingScrollResumePersist/);
  assert.match(controller, /routeResumeStatus/);
  assert.doesNotMatch(controller, /sessionStorage/);
  assert.doesNotMatch(chatWorkbench, /sessionStorage/);
  assert.doesNotMatch(chatWorkbench, /scrollTop/);
});

test("self-drawn scrollbar commits user positions through the conversation scroll runtime", () => {
  const conversation = readFileSync(
    join(root, "packages/vela-chat-web/src/components/conversation/VelaConversation.tsx"),
    "utf8",
  );
  const controller = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );
  const overlay = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scrollbar/useConversationScrollbarOverlay.tsx"),
    "utf8",
  );

  assert.match(
    controller,
    /commitScrollResumeNow/,
    "scroll runtime needs an explicit synchronous commit entrypoint for pointer-driven scrollbar updates",
  );
  assert.match(
    conversation,
    /onScrollCommit:\s*scroll\.commitScrollResumeNow/,
    "VelaConversation should wire the overlay commit callback into the scroll controller",
  );
  assert.match(
    overlay,
    /onScrollCommit/,
    "the overlay may own thumb geometry, but route-safe scroll persistence belongs to the conversation scroll runtime",
  );
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
  assert.match(source, /buildVelaChatControllerRenderModel\(\{[\s\S]*?conversation: activeConversation/);
  assert.match(source, /buildVelaChatControllerRenderModel\(\{[\s\S]*?requests: activeRequests/);
});

test("chat workbench ignores late read-model responses from stale sessions", () => {
  const source = readChatWorkbenchSource();

  assert.match(source, /activeSessionIdRef/);
  assert.match(source, /const requestedSessionId = activeSessionId/);
  assert.match(
    source,
    /if \(!isCurrentSessionRequest\(activeSessionIdRef\.current,\s*requestedSessionId\)\) return;/,
  );
  assert.match(source, /conversationCacheRef/);
  assert.match(
    source,
    /conversationCacheRef\.current\.get\(activeSessionId\) \?\? null/,
  );
  assert.match(source, /conversationCacheRef\.current\.set/);
  assert.match(source, /commitRequests\(null\)/);
  assert.match(source, /setStreamConnected\(false\)/);
  assert.match(source, /const openSession = useCallback/);
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

  const shellTokens = stylesBlock(css, /\.shell,\s*\.newSessionShell\s*\{([\s\S]*?)\}/);
  const assistant = cssBlock(css, "messageResponse");
  const user = cssBlock(css, "userBubble");
  const strong = cssBlockContaining(css, "messageResponse strong");

  assert.match(shellTokens, /"PingFang SC"/);
  assert.match(shellTokens, /"Hiragino Sans GB"/);
  assert.doesNotMatch(shellTokens, /"SF Pro Text"/);
  assert.match(assistant, /font-size:\s*14px;/);
  assert.match(assistant, /font-weight:\s*400;/);
  assert.match(user, /font-size:\s*14px;/);
  assert.match(user, /font-weight:\s*400;/);
  assert.match(strong, /font-weight:\s*650;/);
});

test("chat visual contract documents the styling ownership boundaries", () => {
  const visualContractPath = "packages/vela-chat-web/src/styles/VISUAL_CONTRACT.md";
  assert.equal(existsSync(join(root, visualContractPath)), true, `${visualContractPath} should exist`);

  const contract = readFileSync(join(root, visualContractPath), "utf8");

  assert.match(contract, /# ChatUI Visual Contract/);
  assert.match(contract, /desktop\.module\.css/);
  assert.match(contract, /dependency-direction\.test\.ts/);
  assert.match(contract, /desktop-shell-visual-contract\.test\.ts/);
  assert.match(contract, /Markdown/);
  assert.match(contract, /Agent work/);
  assert.match(contract, /Composer/);
  assert.match(contract, /Conversation/);
  assert.match(contract, /Desktop shell/);
  assert.match(contract, /OpenAPI/);
});

test("chat markdown and agent work use compact Codex-style vertical rhythm", () => {
  const css = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const assistant = cssBlock(css, "messageResponse");
  const paragraph = cssBlockContaining(css, "messageResponse p");
  const heading = cssBlockContaining(css, "messageResponse h1");
  const horizontalRule = cssBlockContaining(css, "messageResponse hr");
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

  assert.match(assistant, /line-height:\s*1\.48;/);
  assert.match(paragraph, /margin:\s*0 0 12px;/);
  assert.match(heading, /margin:\s*18px 0 8px;/);
  assert.match(heading, /line-height:\s*1\.28;/);
  assert.match(horizontalRule, /height:\s*1px;/);
  assert.match(horizontalRule, /margin:\s*14px 0 12px;/);
  assert.match(horizontalRule, /border:\s*0;/);
  assert.match(horizontalRule, /background:\s*var\(--vela-border\);/);
  assert.match(css, /\.messageResponse h1\s*\{\s*font-size:\s*16px;\s*\}/);
  assert.match(css, /\.messageResponse h2\s*\{\s*font-size:\s*15px;\s*\}/);
  assert.match(css, /\.messageResponse h3,[\s\S]*?\.messageResponse h6\s*\{\s*font-size:\s*15px;\s*\}/);
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
  const match = css.match(new RegExp(`\\.${escapeRegex(selector)}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing .${selector} block`);
  return match[1] ?? "";
}

function stylesBlock(css: string, pattern: RegExp) {
  const match = css.match(pattern);
  assert.ok(match, `missing css block matching ${pattern}`);
  return match[1] ?? "";
}

function cssBlockContaining(css: string, selectorFragment: string) {
  const match = css.match(new RegExp(`[^{}]*\\.${escapeRegex(selectorFragment)}[^{}]*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing selector containing .${selectorFragment}`);
  return match[1] ?? "";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  assert.match(promptInput, /submitLabel = "Send message"/);
  assert.match(promptInput, /stopLabel = "Stop generation"/);
  assert.match(promptInput, /const primaryControlLabel = isStopControl \? stopLabel : submitLabel;/);
  assert.match(promptInput, /aria-label=\{primaryControlLabel\}/);
  assert.match(promptInput, /title=\{primaryControlLabel\}/);
});

test("composer primary control keeps codex-desktop dimensions in narrow flex layouts", () => {
  const styles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const primaryControlBlock = styles.match(/\.sendButton,\n\.stopButton\s*\{[^}]+\}/)?.[0] ?? "";
  const stopButtonBlock = [...styles.matchAll(/\.stopButton\s*\{[^}]+\}/g)].at(-1)?.[0] ?? "";

  assert.match(primaryControlBlock, /width:\s*38px;/);
  assert.match(primaryControlBlock, /height:\s*38px;/);
  assert.match(primaryControlBlock, /min-width:\s*38px;/);
  assert.match(primaryControlBlock, /min-height:\s*38px;/);
  assert.match(primaryControlBlock, /flex:\s*0 0 38px;/);
  assert.match(primaryControlBlock, /aspect-ratio:\s*1;/);
  assert.match(primaryControlBlock, /border-radius:\s*999px;/);
  assert.match(primaryControlBlock, /box-shadow:/);
  assert.match(stopButtonBlock, /background:\s*#191d21;/);
  assert.match(stopButtonBlock, /border-radius:\s*999px;/);
  assert.doesNotMatch(styles, /\.stopGlyph/);
});

test("composer input frame matches the codex-desktop visual rhythm", () => {
  const styles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  const rootBlock = cssBlock(styles, "composerRoot");
  const dockBlock = cssBlock(styles, "composerDock");
  const frameBlock = cssBlock(styles, "composer");
  const editorBlock = cssBlock(styles, "composerEditor");
  const attachedSurfaceBlock = cssBlock(styles, "composerAttachedSurface");
  const newSessionContextBlock = cssBlock(styles, "newSessionContextBar");
  const toolbarBlock = cssBlock(styles, "composerFooter");
  const toolbarLaneBlock = styles.match(/\.composerLeft,\n\.composerRight\s*\{[^}]+\}/)?.[0] ?? "";
  const leftBlock = styles.match(/\.composerLeft\s*\{[^}]+\}/)?.[0] ?? "";
  const rightBlock =
    [...styles.matchAll(/\.composerRight\s*\{[^}]+\}/g)].find((match) =>
      match[0].includes("flex: 0 1 auto;"),
    )?.[0] ?? "";
  const iconButtonBlock = cssBlock(styles, "iconButton");

  assert.match(rootBlock, /--vela-composer-radius:\s*20px;/);
  assert.match(rootBlock, /--vela-composer-bg:\s*rgb\(255 255 255 \/ 90%\);/);
  assert.match(rootBlock, /--vela-composer-blur:\s*16px;/);
  assert.match(rootBlock, /--vela-composer-shadow:\s*0 4px 16px 0 rgb\(0 0 0 \/ 5%\);/);
  assert.match(rootBlock, /--vela-composer-max-width:\s*var\(--vela-thread-content-max-width,\s*920px\);/);
  assert.match(dockBlock, /padding:\s*0 24px var\(--vela-thread-floating-content-bottom-inset,\s*12px\);/);
  assert.match(frameBlock, /overflow:\s*hidden auto;/);
  assert.match(frameBlock, /border:\s*1px solid rgb\(13 13 13 \/ 10%\);/);
  assert.match(frameBlock, /width:\s*min\(100%, var\(--vela-composer-max-width\)\);/);
  assert.match(frameBlock, /border-radius:\s*var\(--vela-composer-radius\);/);
  assert.match(frameBlock, /background:\s*var\(--vela-composer-bg\);/);
  assert.match(frameBlock, /0 18px 46px rgb\(15 23 42 \/ 9%\)/);
  assert.match(frameBlock, /var\(--vela-composer-shadow\);/);
  assert.match(frameBlock, /backdrop-filter:\s*saturate\(1\.2\) blur\(var\(--vela-composer-blur\)\);/);
  assert.doesNotMatch(frameBlock, /min-height:\s*112px;/);

  assert.match(editorBlock, /min-height:\s*var\(--vela-composer-input-min-height,\s*24px\);/);
  assert.match(editorBlock, /max-height:\s*var\(--vela-composer-input-max-height,\s*200px\);/);
  assert.match(editorBlock, /font-size:\s*14px;/);
  assert.match(editorBlock, /line-height:\s*1\.5;/);
  assert.match(editorBlock, /padding:\s*12px 16px 8px;/);
  assert.doesNotMatch(styles, /\.composerDockInline\s*\{[^}]*--vela-composer-input-min-height:/s);
  assert.doesNotMatch(styles, /\.composerDockInline \.composerEditor\s*\{/);

  assert.match(attachedSurfaceBlock, /width:\s*min\(100%, var\(--vela-composer-max-width\)\);/);
  assert.match(attachedSurfaceBlock, /border-radius:\s*0 0 var\(--vela-composer-radius\) var\(--vela-composer-radius\);/);
  assert.match(attachedSurfaceBlock, /background:\s*#f4f4f5;/);
  assert.doesNotMatch(newSessionContextBlock, /border:/);
  assert.doesNotMatch(newSessionContextBlock, /border-radius:/);
  assert.doesNotMatch(newSessionContextBlock, /background:/);

  assert.match(toolbarBlock, /align-items:\s*flex-end;/);
  assert.match(toolbarBlock, /flex-wrap:\s*wrap;/);
  assert.match(toolbarBlock, /gap:\s*10px;/);
  assert.match(toolbarBlock, /padding:\s*0 16px 16px;/);
  assert.match(toolbarLaneBlock, /flex-wrap:\s*wrap;/);
  assert.match(toolbarLaneBlock, /gap:\s*8px;/);
  assert.match(leftBlock, /flex:\s*1 1 auto;/);
  assert.match(rightBlock, /flex:\s*0 1 auto;/);
  assert.match(rightBlock, /justify-content:\s*flex-end;/);
  assert.match(rightBlock, /margin-left:\s*auto;/);
  assert.match(styles, /\.composerControls\[data-composer-controls-ready="false"\]\s*\{[^}]*visibility:\s*hidden;/s);
  assert.match(styles, /\.composerControls\[data-composer-controls-ready="false"\]\[data-placement="primary"\]\s*\{[^}]*min-width:\s*136px;/s);
  assert.match(styles, /\.composerControls\[data-composer-controls-ready="false"\]\[data-placement="secondary"\]\s*\{[^}]*min-width:\s*260px;/s);

  assert.match(iconButtonBlock, /width:\s*32px;/);
  assert.match(iconButtonBlock, /height:\s*32px;/);
  assert.match(iconButtonBlock, /border:\s*1px solid #e7e5e4;/);
  assert.match(iconButtonBlock, /border-radius:\s*8px;/);
  assert.match(styles, /@supports \(corner-shape:\s*superellipse\(1\.5\)\)\s*\{[^}]*\.composer,\s*\.composerAttachedSurface\s*\{[^}]*corner-shape:\s*superellipse\(1\.5\);/s);
  assert.doesNotMatch(styles, /\.controlButtonLabel/);
});

test("composer frames disable selection outside editable user input", () => {
  const styles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );
  const newSessionSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/new-session/NewSessionSurface.tsx"),
    "utf8",
  );

  const chatFrameBlock = cssBlock(styles, "composer");
  const chatEditorBlock = cssBlock(styles, "composerEditor");
  const chatAttachmentLabelBlock = cssBlock(styles, "attachmentLabel");
  const chatControlsBlock = cssBlock(styles, "composerControls");
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );

  assert.match(chatFrameBlock, /user-select:\s*none;/);
  assert.match(chatEditorBlock, /user-select:\s*text;/);
  assert.doesNotMatch(chatAttachmentLabelBlock, /user-select:\s*(text|all);/);
  assert.doesNotMatch(chatControlsBlock, /user-select:\s*(text|all);/);
  assert.match(newSessionSurface, /<PromptInput/);
  assert.match(newSessionSurface, /layout="inline"/);
  assert.match(promptInput, /styles\.composerRoot/);
  assert.match(promptInput, /composerAttachedSurface/);
  assert.doesNotMatch(styles, /newSessionComposer/);
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
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
    "utf8",
  );
  const chatWorkbench = readChatWorkbenchSource();

  assert.match(promptInput, /isRunning/);
  assert.match(promptInput, /onStop/);
  assert.match(promptInput, /import \{ ArrowUp, Mic, Square \} from "lucide-react";/);
  assert.match(promptInput, /aria-label=\{primaryControlLabel\}/);
  assert.match(promptInput, /<Square size=\{13\} strokeWidth=\{0\} fill="currentColor" aria-hidden="true" \/>/);
  assert.match(promptInput, /<ArrowUp size=\{22\} strokeWidth=\{2\.4\} aria-hidden="true" \/>/);
  assert.match(composer, /isRunning/);
  assert.match(composer, /onStop/);
  assert.match(workbenchView, /isRunning=\{webModel\.composer\.isRunning\}/);
  assert.match(workbenchView, /onStop=\{onStop\}/);
  assert.match(chatSurface, /onStop\?:\s*\(\) => void/);
  assert.match(chatWorkbench, /client\.cancelSession\(\{ sessionId: requestedSessionId \}\)/);
});

test("composer gates dictation behind browser speech recognition", () => {
  const promptInput = readFileSync(
    join(root, "packages/vela-chat-web/src/primitives/prompt-input/PromptInput.tsx"),
    "utf8",
  );

  assert.match(promptInput, /import \{ ArrowUp, Mic, Square \} from "lucide-react";/);
  assert.match(promptInput, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  assert.match(promptInput, /recognition\.interimResults = true;/);
  assert.match(promptInput, /recognition\.onresult = \(event\) =>/);
  assert.match(promptInput, /aria-label=\{isDictating \? "Stop dictation" : "Start dictation"\}/);
  assert.match(promptInput, /disabled=\{!supportsDictation\}/);
  assert.match(promptInput, /<Mic size=\{17\} strokeWidth=\{2\.1\} aria-hidden="true" \/>/);
  assert.doesNotMatch(promptInput, />\s*⌘\s*</);
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

test("conversation scroll controller does not bypass scroll write arbitration", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController.ts"),
    "utf8",
  );

  assert.match(source, /applyConversationScrollWrite/);
  assert.doesNotMatch(
    source,
    /\b(?:element|scrollElement|container)\.scrollTop\s*=/,
    "programmatic scrollTop writes in the controller must go through scrollWrite.ts",
  );
});

test("semantic scroll anchors compute restore targets but never write DOM scroll state", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-web/src/conversation-runtime/scroll/scrollAnchor.ts"),
    "utf8",
  );

  assert.match(source, /getConversationScrollAnchorRestoreTarget/);
  assert.doesNotMatch(
    source,
    /\b(?:element|scrollElement|container)\.scrollTop\s*=/,
    "scrollAnchor.ts should stay pure and leave DOM writes to scrollWrite.ts",
  );
});
