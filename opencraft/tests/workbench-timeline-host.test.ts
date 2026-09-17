import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCodexThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { menuGeometry } from "@opencraft/design-system/tokens";

import {
  createWebTimelineViewportSnapshot,
  resizeObserverBlockSize,
  resolveWebTimelinePlatform,
  shouldAcceptWebConversationInvalidation,
  timelineReflowScrollAdjustment,
} from "@opencraft/timeline-host-web";
import { ScrollToBottomButton } from "../apps/workbench-web/src/components/scroll-to-bottom-button";
import {
  resolveAppShellMainContentChrome,
  resolveThreadEdgeScroll,
  THREAD_EDGE_SCROLL_MINIMUM_WIDTH_REM,
} from "../apps/workbench-web/src/app-shell-edge-scroll-model";
import { resolveModalStack } from "../apps/workbench-web/src/components/modal/modal-controller";

const workbenchStyles = readFileSync(
  new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
  "utf8",
);
const workbenchEntry = readFileSync(
  new URL("../apps/workbench-web/src/main.tsx", import.meta.url),
  "utf8",
);
const workbenchApp = readFileSync(
  new URL("../apps/workbench-web/src/app.tsx", import.meta.url),
  "utf8",
);
const composerModelCatalogSource = readFileSync(
  new URL(
    "../packages/workbench-runtime/src/composer-model-catalog.ts",
    import.meta.url,
  ),
  "utf8",
);
const settingsPageSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/settings-page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const modalSurfaceSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/modal-surface.tsx",
    import.meta.url,
  ),
  "utf8",
);
const modalHostSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/modal-host.tsx",
    import.meta.url,
  ),
  "utf8",
);
const announcementDialogSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/announcement-dialog.tsx",
    import.meta.url,
  ),
  "utf8",
);
const announcementProjectionSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/announcement-modal-projection.tsx",
    import.meta.url,
  ),
  "utf8",
);
const nativeModalSurfaceSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/ui/modal-surface.tsx",
    import.meta.url,
  ),
  "utf8",
);
const nativeComposerSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/workbench-composer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const workspaceDirectoryPickerSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/workspace-directory-picker.tsx",
    import.meta.url,
  ),
  "utf8",
);
const toolRenderersSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/conversation-renderers/tool/tool-renderers.tsx",
    import.meta.url,
  ),
  "utf8",
);
const managementSettingsContentSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/management-settings-content.tsx",
    import.meta.url,
  ),
  "utf8",
);
const modalStyles = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/modal/modal.scss",
    import.meta.url,
  ),
  "utf8",
);
const pendingConversationSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/pending-conversation-page.tsx",
    import.meta.url,
  ),
  "utf8",
);
const newThreadDraftSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/new-thread-draft-page.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Settings navigation enters through a semantic route adapter", () => {
  assert.match(
    workbenchApp,
    /onOpenSettings=\{openSettingsFromConversation\}/u,
  );
  assert.doesNotMatch(
    workbenchApp,
    /onOpenSettings=\{workbenchNavigation\.openSettings\}/u,
  );
});

test("the first submit atomically hands presentation from Draft to Conversation ownership", () => {
  assert.match(
    workbenchApp,
    /draft !== null && draft\.submission === null[\s\S]{0,160}?<NewThreadDraftPage/u,
  );
  assert.match(
    workbenchApp,
    /draft !== null \? \([\s\S]{0,120}?<PendingConversationPage/u,
  );
  assert.doesNotMatch(newThreadDraftSource, /Starting task/u);
  assert.match(pendingConversationSource, /contains no Draft[\s\S]*Composer/u);
});
const webConversationSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/conversation.tsx",
    import.meta.url,
  ),
  "utf8",
);
const webViewportOwnerSource = readFileSync(
  new URL(
    "../packages/timeline-host-web/src/conversation-viewport-owner.ts",
    import.meta.url,
  ),
  "utf8",
);
const botConversationViewportSource = readFileSync(
  new URL(
    "../plugins/bot-chat/src/conversation-viewport.ts",
    import.meta.url,
  ),
  "utf8",
);
const botChatViewSource = readFileSync(
  new URL(
    "../plugins/bot-chat/src/bot-chat-view.tsx",
    import.meta.url,
  ),
  "utf8",
);
const expoFrameSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/workbench-frame.shared.tsx",
    import.meta.url,
  ),
  "utf8",
);
const expoConversationSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/workbench-conversation.tsx",
    import.meta.url,
  ),
  "utf8",
);
const expoComposerSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/workbench-composer.tsx",
    import.meta.url,
  ),
  "utf8",
);
const webToolRendererSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/conversation-renderers/tool/tool-renderers.tsx",
    import.meta.url,
  ),
  "utf8",
);
const nativeResponseSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/native-response-positioned-turns.tsx",
    import.meta.url,
  ),
  "utf8",
);
const nativeVirtualizedTurnsSource = readFileSync(
  new URL(
    "../apps/workbench-expo/src/components/native-virtualized-conversation-turns.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("tool Activity uses one flat surface contract and lazily owns detail bodies", () => {
  assert.match(expoConversationSource, /function NativeActivityDisclosure/u);
  assert.doesNotMatch(expoConversationSource, /styles\.toolCard|toolCard:/u);
  assert.doesNotMatch(expoConversationSource, />Browse all</u);
  const genericWebTool = webToolRendererSource.slice(
    webToolRendererSource.indexOf("function ToolCallBlock"),
    webToolRendererSource.indexOf("function ImageViewToolBlock"),
  );
  assert.match(genericWebTool, /unmountBodyWhenCollapsed/u);
  assert.doesNotMatch(genericWebTool, /unmountBodyWhenCollapsed=\{block\.kind === "mcp"\}/u);
});
const stableEventSource = readFileSync(
  new URL("../packages/react-runtime/src/use-stable-event.ts", import.meta.url),
  "utf8",
);
const appShellSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/app-shell.tsx",
    import.meta.url,
  ),
  "utf8",
);
const appShellHeaderSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/app-shell-header.tsx",
    import.meta.url,
  ),
  "utf8",
);
const responsiveSidebarDockSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/use-responsive-sidebar-dock.ts",
    import.meta.url,
  ),
  "utf8",
);
const rightPanelSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/app-shell-right-panel.tsx",
    import.meta.url,
  ),
  "utf8",
);
const rightPanelTabsSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/right-panel.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("panel creation picker is outlet-owned and shares its actions with the empty state", () => {
  assert.doesNotMatch(rightPanelTabsSource, /action\.tabKind|emptyPanelActions|emptyPanelLabel/);
  assert.match(rightPanelTabsSource, /regionState\.tabs\.length > 0 \?\s*\(\s*<PanelCreationMenu/);
  assert.match(rightPanelTabsSource, /actions=\{creationActions\}/);
  assert.match(rightPanelTabsSource, /creationActions\.map\(\(?action\)?\s*=>/);
  assert.match(rightPanelTabsSource, /onCloseAutoFocus=\{\(?event\)?\s*=>/);
  assert.match(rightPanelTabsSource, /tabs=\{regionState\.tabs\}/);
  assert.match(rightPanelTabsSource, /aria-label=\{tabs \? "Tabs" : "New tab"\}/);
  assert.doesNotMatch(rightPanelTabsSource, /action\.panelKind|panelTabsForAction|right-panel-type-picker/);
});
const browserPanelSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/browser/browser-panel-plugin.tsx",
    import.meta.url,
  ),
  "utf8",
);
const webBrowserRuntimeSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/browser/web-browser-runtime.ts",
    import.meta.url,
  ),
  "utf8",
);
const browserPresentationSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/browser/browser-presentation-coordinator.ts",
    import.meta.url,
  ),
  "utf8",
);
const browserSurfaceHostSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/browser/web-browser-surface-host.ts",
    import.meta.url,
  ),
  "utf8",
);
const panelAnimationSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/use-panel-animation.ts",
    import.meta.url,
  ),
  "utf8",
);
const navigationRailSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/components/user-message-navigation-rail.tsx",
    import.meta.url,
  ),
  "utf8",
);
const panelRuntimeSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/runtime/panel-runtime-context.tsx",
    import.meta.url,
  ),
  "utf8",
);
const builtinPanelSource = readFileSync(
  new URL(
    "../apps/workbench-web/src/panels/builtin-panel-plugin.tsx",
    import.meta.url,
  ),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../packages/codex-composer/src/codex-composer.tsx", import.meta.url),
  "utf8",
);
test("theme bootstrap is owned by the application root, not a removable header control", () => {
  assert.match(
    workbenchEntry,
    /import\s*\{\s*initializeAppearanceTheme\s*\}\s*from\s*["']\.\/appearance-theme["']/u,
  );
  assert.match(workbenchEntry, /initializeAppearanceTheme\(\);/u);
  assert.match(workbenchApp, /theme:\s*appearanceTheme\.resolvedTheme/u);
  assert.match(webConversationSource, /theme=\{documentContext\.theme\}/u);
  assert.doesNotMatch(
    webConversationSource,
    /documentElement\.dataset\.theme/u,
  );
  assert.doesNotMatch(webConversationSource, /toolJsonTheme/u);

  const lightTheme = buildCodexThemeCssProperties("light");
  for (const token of [
    "--color-background-button-tertiary-hover",
    "--color-surface-tertiary",
    "--color-background-elevated-primary-opaque",
    "--color-border-default",
  ] as const) {
    assert.ok(
      lightTheme[token],
      `${token} must survive as a runtime theme token`,
    );
  }
});

test("application Settings owns route slots while target management owns a modal surface", () => {
  assert.match(
    workbenchApp,
    /const settingsRoute = routeSettingsOpen \? \(/u,
  );
  assert.match(
    workbenchApp,
    /<AppShell[\s\S]*?leftPanel=\{[\s\S]*?routeSettingsOpen \? settingsNavigation : \(conversationSurfaceVisible \|\| standaloneManagementOpen\) \? <Sidebar[\s\S]*?<div className="workbench-route-stage">[\s\S]*?\{settingsRoute\}[\s\S]*?<\/AppShell>/u,
  );
  assert.match(workbenchApp, /const managementSettingsOpen = settingsOpen[\s\S]*?selectedSettingsContribution\?\.management !== undefined/u);
  assert.match(workbenchApp, /const conversationSurfaceVisible = conversationRouteOpen\s+\|\| \(managementSettingsOpen && !standaloneManagementOpen\)/u);
  assert.match(workbenchApp, /hidden=\{!conversationSurfaceVisible\}/u);
  assert.match(workbenchApp, /inert=\{!conversationRouteOpen \|\| undefined\}/u);
  assert.match(workbenchApp, /<ManagementSettingsContent[\s\S]*?navigation=\{settingsNavigation\}/u);
  assert.match(workbenchApp, /<ModalHost requests=\{modalRequests\}/u);
  assert.doesNotMatch(workbenchApp, /ApplicationShellRoot/u);
  assert.doesNotMatch(settingsPageSource, /ApplicationShellRoot/u);
  assert.match(settingsPageSource, /export function SettingsNavigation/u);
  assert.match(settingsPageSource, /export function SettingsContent/u);
  assert.match(modalSurfaceSource, /from "@radix-ui\/react-dialog"/u);
  assert.match(modalSurfaceSource, /<Dialog\.Root/u);
  assert.match(modalSurfaceSource, /<Dialog\.Portal/u);
  assert.match(modalSurfaceSource, /<Dialog\.Overlay/u);
  assert.match(modalSurfaceSource, /<Dialog\.Content/u);
  assert.match(modalSurfaceSource, /className="modal-surface__scrim"/u);
  assert.doesNotMatch(modalSurfaceSource, /createPortal|addEventListener|setAttribute\("inert"\)|onEscapeKeyDown|event\.key/u);
  assert.doesNotMatch(managementSettingsContentSource, /ModalSurface|Dialog\./u);
  assert.match(modalHostSource, /resolveModalStack\(requests\)/u);
  assert.match(modalHostSource, /<ModalSurface/u);
  assert.match(settingsPageSource, /section === "laboratory"/u);
  assert.match(settingsPageSource, /onOpenAnnouncementLab/u);
  assert.match(announcementProjectionSource, /useSyncExternalStore/u);
  assert.match(announcementProjectionSource, /<AnnouncementDialogContent/u);
  assert.doesNotMatch(announcementDialogSource, /from "@radix-ui|<ModalSurface|createPortal|zIndex/u);
  assert.match(announcementDialogSource, /import \{ Button \} from "\.\.\/ui\/button"/u);
  assert.match(workbenchApp, /modalRequests\.push\(\.\.\.announcementModalRequests\)/u);
  assert.match(
    workbenchStyles,
    /\.workbench-conversation-route\[hidden\]\s*\{\s*display:\s*none;/u,
  );
  assert.match(
    workbenchApp,
    /const headerNavigationActions = chromePolicy\.leadingNavigationActions/u,
  );
  assert.match(
    workbenchStyles,
    /\.settings-page\s*\{[^}]*display:\s*flex;[^}]*overflow:\s*hidden;/u,
  );
  assert.match(
    workbenchStyles,
    /\.settings-page__viewport\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/u,
  );
  assert.match(
    modalStyles,
    /\.management-settings-dialog\s*\{[^}]*grid-template-columns:\s*238px minmax\(0, 1fr\);/u,
  );
  assert.match(
    modalStyles,
    /\.modal-surface__scrim\s*\{[^}]*position:\s*fixed;[^}]*backdrop-filter:\s*blur\(7px\)/u,
  );
  assert.match(
    modalStyles,
    /--modal-layer-base:\s*var\(--layer-application-modal,\s*230\)/u,
  );
  assert.match(
    modalStyles,
    /\.modal-surface\s*\{[^}]*isolation:\s*isolate;[^}]*background:\s*var\(--color-background-elevated-primary-opaque,\s*var\(--color-background-surface\)\);/u,
  );
  assert.doesNotMatch(
    modalStyles,
    /\.modal-surface\s*\{[^}]*background:\s*var\(--color-background-primary\)/u,
  );
});

test("the platform resolves modal identity and Expo adapts the same semantic contract", () => {
  const dismiss = () => undefined;
  const stack = resolveModalStack([
    { id: "settings", label: "Settings", content: null, onDismiss: dismiss },
    { id: "account", label: "Account", content: null, onDismiss: dismiss },
    { id: "settings", label: "Settings updated", content: null, onDismiss: dismiss },
  ]);
  assert.deepEqual(stack.map(({ id, label, stackIndex }) => ({ id, label, stackIndex })), [
    { id: "account", label: "Account", stackIndex: 0 },
    { id: "settings", label: "Settings updated", stackIndex: 1 },
  ]);
  assert.match(nativeModalSurfaceSource, /from "@opencraft\/design-system\/modal"/u);
  assert.match(nativeModalSurfaceSource, /<Modal/u);
  assert.match(nativeModalSurfaceSource, /onRequestClose=\{\(\) => onDismiss\("system"\)\}/u);
  assert.match(nativeComposerSource, /<ModalSurface[\s\S]*?label="Model"/u);
  assert.doesNotMatch(nativeComposerSource, /<Modal\b|modalScrim|modalRoot/u);
  assert.match(workspaceDirectoryPickerSource, /<ModalSurface/u);
  assert.doesNotMatch(workspaceDirectoryPickerSource, /createPortal|event\.key|addEventListener/u);
  assert.equal(Array.from(toolRenderersSource.matchAll(/<ModalSurface/gu)).length, 2);
  assert.doesNotMatch(toolRenderersSource, /createPortal|event\.key\s*===\s*"Escape"/u);
});

test("Draft menus consume one design-system rhythm and stay out of the hero title", () => {
  assert.deepEqual(menuGeometry, {
    collisionPadding: 6,
    rootSideOffset: 6,
    submenuSideOffset: 4,
    surfacePadding: 5,
    itemGap: 2,
    itemRadius: 8,
    boundedMinimumWidth: 200,
    boundedMaximumWidth: 320,
    listMaximumHeight: 250,
  });
  assert.match(
    newThreadDraftSource,
    /className="new-thread-project-menu new-thread-host-menu"[\s\S]*?align="end"[\s\S]*?sideOffset=\{menuGeometry\.rootSideOffset\}[\s\S]*?collisionPadding=\{menuGeometry\.collisionPadding\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.new-thread-project-menu__items\s*\{[^}]*display:\s*grid;[^}]*gap:\s*var\(--menu-item-gap\)/u,
  );
  assert.match(
    workbenchStyles,
    /\.new-thread-project-menu\s*\{[\s\S]*?padding:\s*var\(--menu-surface-padding\)/u,
  );
});

test("dark primary actions preserve inverted foreground contrast", () => {
  const darkTheme = buildCodexThemeCssProperties("dark");

  assert.equal(darkTheme["--color-background-button-primary"], "#ffffff");
  assert.equal(darkTheme["--color-text-button-primary"], "#181818");
  assert.notEqual(
    darkTheme["--color-background-button-primary"],
    darkTheme["--color-text-button-primary"],
    "the Composer send arrow must not collapse into its button background",
  );
});

test("light primary action hover remains an opaque inverted surface", () => {
  const lightTheme = buildCodexThemeCssProperties("light");
  const primary = lightTheme["--color-background-button-primary"];
  const hover = lightTheme["--color-background-button-primary-hover"];

  assert.equal(primary, "#1a1c1f");
  assert.match(hover, /^rgb\(/u);
  assert.notEqual(hover, lightTheme["--color-background-surface"]);
  assert.notEqual(hover, lightTheme["--color-text-button-primary"]);
  assert.match(
    workbenchStyles,
    /\.codex-composer-submit\s*\{[\s\S]*?&:not\(:disabled\):not\(\.is-stop\):hover\s*\{[^}]*var\(--color-background-button-primary-hover\)[\s\S]*?&\.is-stop:not\(:disabled\):hover\s*\{[^}]*var\(--color-background-button-secondary-hover\)/u,
  );
});

test("Composer material does not encode editor focus", () => {
  const shellStart = workbenchStyles.indexOf(".codex-composer-shell {");
  const shellEnd = workbenchStyles.indexOf("@supports not", shellStart);

  assert.notEqual(shellStart, -1);
  assert.notEqual(shellEnd, -1);

  const shellRules = workbenchStyles.slice(shellStart, shellEnd);
  assert.doesNotMatch(shellRules, /:focus-within|:hover/u);
  assert.doesNotMatch(shellRules, /transition\s*:/u);
  assert.match(shellRules, /box-shadow\s*:/u);
  assert.match(workbenchStyles, /\.codex-composer-editor\s*\{[^}]*outline:\s*none/u);
  assert.match(workbenchStyles, /\.codex-composer-submit\s*\{[\s\S]*?&:focus-visible/u);
});

test("renderer measurement requests are generation fenced before Web layout work", () => {
  const request = {
    documentId: "doc-1",
    generation: 4,
    geometryChanged: true,
    reason: "image-load",
  };
  assert.equal(shouldAcceptWebConversationInvalidation(3, request), true);
  assert.equal(shouldAcceptWebConversationInvalidation(4, request), true);
  assert.equal(shouldAcceptWebConversationInvalidation(5, request), false);
  assert.equal(
    shouldAcceptWebConversationInvalidation(3, {
      ...request,
      geometryChanged: false,
    }),
    false,
  );
  assert.match(
    webVirtualizedTurnsSource,
    /isCurrentGeneration\(generation\)/u,
    "the virtualizer must reject a batch from a retired viewport lifetime",
  );
});

const webResponseSource = readFileSync(new URL("../apps/workbench-web/src/components/conversation/response-positioned-turns.tsx", import.meta.url), "utf8");

const webVirtualizedTurnsSource = readFileSync(new URL("../apps/workbench-web/src/components/conversation/virtualized-conversation-turns.tsx", import.meta.url), "utf8");

test("row height and follow-content observations share one policy consumer without conflating their facts", () => {
  assert.match(webResponseSource, /onLatestTurnMeasurement=\{handleLatestTurnMeasurement\}/u);
  assert.match(webVirtualizedTurnsSource, /setLatestTurnMeasurementListener\(onLatestTurnMeasurement \?\? null\)/u);
  assert.doesNotMatch(webResponseSource, /latestTurnFollowContentHeightRef\.current = change\.heightPx/u);
  assert.match(
    webResponseSource,
    /const restoredLatestTurnHeightBaselineRef = useRef<number \| null>[\s\S]{0,180}?isViewportPreservingTurnFollowMode/u,
    "only a viewport-preserving restored latest Turn may provide the one-shot height baseline",
  );
  assert.match(
    webResponseSource,
    /if \(change\.kind === "turn-height"\) \{[\s\S]{0,180}?restoredLatestTurnHeightBaselineRef\.current = null;/u,
    "the restored height baseline must be consumed exactly once",
  );
  assert.match(
    webVirtualizedTurnsSource,
    /viewportOwner\.publishLatestTurnHeightChange\(\s*transaction\.latestTurnHeightChange,?\s*\)/u,
  );
  assert.match(
    webVirtualizedTurnsSource,
    /createTurnMeasurementTransaction\(\{[\s\S]{0,650}?currentDistanceFromBottomPx:\s*scrollController\.getLastScrollDistanceFromBottomPx\(\)/u,
    "measurement transactions must read the controller's synchronous distance, not an event-lagging mirror",
  );
  assert.match(
    webResponseSource,
    /targetDistance < 0[\s\S]{0,220}?Math\.max\(0, targetDistance\)/u,
    "response-spacer ownership must observe signed underflow before the platform scroll is clamped",
  );
});

test("Native virtualizer publishes live Turn height while response policy owns compensation", () => {
  assert.match(
    nativeResponseSource,
    /preserveMeasuredTurnViewport=\{!isLatestTurnInProgress\}/u,
  );
  assert.match(
    nativeVirtualizedTurnsSource,
    /transaction\.latestTurnHeightChange !== null[\s\S]{0,140}?onLatestTurnMeasurement\(transaction\.latestTurnHeightChange\)/u,
  );
  assert.match(
    nativeResponseSource,
    /responsePositioning\.shouldPreserveMeasuredViewport\(\)[\s\S]{0,80}?compensateHeightDelta\(change\.heightDeltaPx\)/u,
  );
  assert.match(
    nativeResponseSource,
    /viewportOwner\.commitContentGeometry\(\s*height,[\s\S]{0,4000}?return requestedDistance/u,
    "a Native content-size event must merge policy candidates before the viewport owner performs one write",
  );
  assert.doesNotMatch(
    nativeResponseSource,
    /reportContentHeight\(height\)[\s\S]{0,160}?consumePendingGeometryDistanceFromBottomPx/u,
    "React must not split one Native content-size transaction into separate geometry and scroll owners",
  );
  assert.match(
    nativeResponseSource,
    /Animated\.spring\(latestTurnOffset,[\s\S]{0,520}?Animated\.spring\(responseSpacerHeight/u,
    "Native translation and spacer height must share the recovered zero-bounce spring",
  );
  assert.match(webResponseSource, /CODEX_LATEST_TURN_PLACEMENT_SPRING\.durationMs/u);
});

test("footer geometry and response placement have disjoint Codex owners", () => {
  assert.match(webViewportOwnerSource, /readonly attachFooterElement/u);
  assert.match(
    webViewportOwnerSource,
    /observeBorderBoxHeight\(footer,[\s\S]{0,520}?--thread-scroll-padding-bottom/u,
    "the platform layout owner writes footer padding in the ResizeObserver transaction",
  );
  assert.doesNotMatch(
    webConversationSource,
    /measuredFooterScrollPaddingPx|setMeasuredFooterScrollPaddingPx|bottomPaddingRef/u,
    "footer geometry must not create a React render or enter a shared padding register",
  );
  assert.match(
    webVirtualizedTurnsSource,
    /createTurnMeasurementTransaction\(\{[\s\S]{0,520}?bottomPaddingPx: getBottomScrollPaddingPx\(\)/u,
    "the virtualizer bottom coordinate is the response spacer only",
  );
  assert.match(
    webResponseSource,
    /maximumResponseSpacerHeightPx\(\{[\s\S]{0,180}?scrollPaddingBottomPx: viewportOwner\.getFooterScrollPaddingPx\(\)/u,
    "follow policy reads footer padding directly from the platform owner",
  );
  assert.doesNotMatch(nativeResponseSource, /bottomScrollPaddingPx|bottomPaddingRef/u);
  assert.match(nativeResponseSource, /footerPaddingRef = useRef\(footerScrollPaddingPx\)/u);
  assert.match(
    nativeVirtualizedTurnsSource,
    /reconcileTurnLayoutViewport\(\{[\s\S]{0,420}?bottomPaddingPx: getBottomPaddingPx\(\)/u,
    "Native uses the same footer/response-spacer ownership boundary",
  );
});

test("Native conversation page, response policy, and virtualizer keep disjoint ownership", () => {
  assert.match(expoConversationSource, /<NativeResponsePositionedTurns/u);
  assert.doesNotMatch(
    expoConversationSource,
    /createTurnMeasurementTransaction|createTurnWindowSlice|TurnResponsePositioningController|NativeConversationViewportOwner/u,
  );
  assert.match(nativeResponseSource, /TurnResponsePositioningController/u);
  assert.match(nativeResponseSource, /ref=\{attachScrollView\}/u);
  assert.doesNotMatch(
    nativeResponseSource,
    /scrollRef\.current\?\.scrollTo/u,
    "Native physical writers must attach at the ref commit boundary, not mutate during render",
  );
  assert.doesNotMatch(
    nativeResponseSource,
    /createTurnMeasurementTransaction|createTurnWindowSlice/u,
  );
  assert.match(
    nativeVirtualizedTurnsSource,
    /createTurnMeasurementTransaction/u,
  );
  assert.match(nativeVirtualizedTurnsSource, /createTurnWindowSlice/u);
  assert.doesNotMatch(
    nativeVirtualizedTurnsSource,
    /TurnResponsePositioningController|responseSpacerHeight/u,
  );
});

test("physical scroll distance and input classification have one platform transaction owner", () => {
  assert.doesNotMatch(webConversationSource, /distanceRef|inputDirectionRef|touchPointRef|previousPointerSnapshotRef/u);
  assert.doesNotMatch(nativeResponseSource, /distanceRef/u);
  assert.doesNotMatch(botConversationViewportSource, /distanceRef/u);

  assert.match(
    webViewportOwnerSource,
    /private bindScrollPortListeners[\s\S]*?bindScrollBehavior\(callbacks:/u,
    "raw DOM listeners must remain an implementation detail of the Web viewport owner",
  );
  assert.match(
    webViewportOwnerSource,
    /reportPlatformScroll\(\(change\)\s*=>[\s\S]{0,220}?resolveScrollOrigin\([\s\S]{0,180}?change\.previousDistanceFromBottomPx[\s\S]{0,100}?change\.currentDistanceFromBottomPx/u,
    "origin must be resolved inside the controller transaction after pending layout restoration",
  );
  assert.match(webConversationSource, /viewportOwner\.bindScrollBehavior\(/u);
  assert.match(webResponseSource, /scrollController\.subscribe\(handlePlatformScroll\)/u);
  assert.match(webResponseSource, /scrollController\.addUserScrollListener\(handleUserScroll\)/u);
  assert.match(nativeResponseSource, /scrollController\.addUserScrollListener\(handleUserScroll\)/u);
  assert.match(botConversationViewportSource, /owner\.bindScrollBehavior\(/u);
  assert.doesNotMatch(botConversationViewportSource, /scrollTop\s*</u);
  assert.doesNotMatch(botChatViewSource, /onTranscriptScroll|onScroll=\{onTranscriptScroll\}/u);
  assert.match(botConversationViewportSource, /owner\.scrollController\.addUserScrollListener/u);
  assert.match(
    botConversationViewportSource,
    /preserveMeasuredViewport: !following/u,
    "Bot follow and generic virtualizer preservation must never own the same layout transaction",
  );
  assert.doesNotMatch(
    botConversationViewportSource,
    /reportPlatformScroll\("user"\)/u,
    "a React onScroll callback must not relabel every Bot layout scroll as user-owned",
  );
});

test("Composer menus live in the root overlay plane with Codex viewport constraints", () => {
  assert.equal(
    Array.from(composerSource.matchAll(/<DropdownMenu\.Portal>/gu)).length,
    2,
  );
  assert.equal(
    Array.from(composerSource.matchAll(/modal=\{false\}/gu)).length,
    2,
  );
  assert.match(
    composerSource,
    /window\.addEventListener\("blur", dismissOnWindowBlur\)/u,
  );
  assert.match(
    workbenchStyles,
    /\.codex-composer-selection-menu\s*\{[^}]*@include menu\.surface/u,
  );
  assert.match(workbenchStyles, /\.right-panel-creation-menu\s*\{[^}]*@include menu\.surface/u);
  const menuStyles = readFileSync(new URL("../packages/design-system/src/menu.web.scss", import.meta.url), "utf8");
  assert.match(menuStyles, /--radix-dropdown-menu-content-available-width/);
  assert.match(menuStyles, /--radix-dropdown-menu-content-available-height/);
  assert.match(menuStyles, /prefers-reduced-motion: no-preference/);
  assert.match(menuStyles, /font-size: 13px/);
  assert.doesNotMatch(
    workbenchStyles,
    /\.codex-composer-selection-menu\s*\{[^}]*position:\s*absolute/u,
  );
  assert.match(
    composerSource,
    /codex-composer-selection-menu__trailing[\s\S]*?<Check size=\{16\}/u,
  );
  assert.match(composerSource, /aria-label="Permissions"/u);
  assert.doesNotMatch(composerSource, /How should OpenCraft actions be approved\?/u);
  assert.match(
    workbenchStyles,
    /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/u,
  );
  assert.match(
    workbenchStyles,
    /container:\s*composer-footer\s*\/\s*inline-size/u,
  );
  assert.match(composerSource, /openPicker === "intelligence"/u);
  assert.doesNotMatch(composerSource, /openPicker === "(?:model|effort)"/u);
  assert.match(
    workbenchStyles,
    /\.codex-composer-footer__attachment,[\s\S]{0,120}?\.codex-composer-footer__end\s*\{[\s\S]{0,120}?flex:\s*0 0 auto/u,
  );
  assert.match(
    workbenchStyles,
    /\.codex-composer-mode__model-label\s*\{[\s\S]{0,120}?flex:\s*1 1 auto/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /codex-composer-selection-menu__item\.is-selected/u,
  );
});

test("Composer intelligence keeps model and reasoning in one catalog-owned menu", () => {
  assert.doesNotMatch(composerSource, /<DropdownMenu\.Sub(?:Trigger|Content)/u);
  assert.match(
    composerSource,
    /codex-composer-selection-menu__heading">\s*Model/u,
  );
  assert.match(
    composerSource,
    /codex-composer-selection-menu__heading">\s*Reasoning/u,
  );
  assert.doesNotMatch(composerSource, /Power presets|>\s*Advanced\s*</u);
  assert.doesNotMatch(
    composerSource,
    /buildPowerOptions|powerPreviewId|role="slider"/u,
  );
  assert.doesNotMatch(workbenchStyles, /\.codex-composer-power-track\s*\{/u);
  assert.doesNotMatch(workbenchStyles, /codex-composer-selection-menu__item--field/u);
  assert.match(
    composerModelCatalogSource,
    /function reasoningEffortLabel\(value: string\)/u,
  );
  assert.match(composerModelCatalogSource, /case "low":\s*return "Light"/u);
});

test("Composer EditorView and submission callbacks are fenced by Conversation View ownership", () => {
  assert.match(
    composerSource,
    /pendingSubmissionRef\.current\?\.controller === controller/u,
  );
  assert.match(
    composerSource,
    /editorViewRef\.current === view[\s\S]{0,180}?editorControllerRef\.current === controller[\s\S]{0,120}?!view\.isDestroyed/u,
  );
  assert.match(
    composerSource,
    /if \(editorViewRef\.current === view\) editorViewRef\.current = null;[\s\S]{0,260}?view\.destroy\(\);/u,
  );
  assert.doesNotMatch(
    composerSource,
    /setTimeout\(\(\) => view\.destroy\(\)/u,
  );
  assert.doesNotMatch(composerSource, /submitPendingRef/u);
});

test("Composer submission preserves View-owned focus across primary action swaps", () => {
  assert.match(
    composerSource,
    /requestAnimationFrame\(\(\) => \{[\s\S]{0,160}?disabledRef\.current[\s\S]{0,120}?controller\.focus\(\)/u,
  );
  assert.equal(
    composerSource.match(
      /onPointerDown=\{\(event\) => \{\s*if \(event\.button === 0\) event\.preventDefault\(\);\s*\}\}/gu,
    )?.length,
    2,
    "Send and Stop must not take pointer focus from the current EditorView",
  );
  assert.doesNotMatch(
    composerSource,
    /setTimeout\([\s\S]{0,120}?(?:controller|view)\.focus/u,
  );
});

test("an existing Thread adopts a submission before remote acknowledgement", () => {
  assert.match(
    workbenchApp,
    /submission = hostCatalog\.submit\(submittedIntent\);[\s\S]{0,360}?intent\.target\.type !== "new-thread"[\s\S]{0,620}?void submission\.catch[\s\S]{0,420}?return true;/u,
  );
  assert.match(
    workbenchApp,
    /The Conversation Scope synchronously owns the immutable first Turn[\s\S]{0,500}?void submission\.catch\(\(\) => \{[\s\S]{0,300}?return true;/u,
    "New Thread input must clear once its immutable intent is owned by the Draft scope",
  );
  assert.doesNotMatch(
    workbenchApp,
    /const sendMessage = useCallback\(\s*async/u,
    "an async wrapper would make every existing-Thread handoff look remotely pending to the Composer",
  );
});

test("local-submit placement is page-owned and consumed once by the Conversation", () => {
  assert.match(workbenchApp, /pendingLatestTurnPlacementRef = useRef<LatestTurnPlacementSnapshot \| null>/u);
  assert.match(workbenchApp, /captureLatestTurnSubmitPlacement\(\)/u);
  assert.match(workbenchApp, /consumePendingLatestTurnSubmitPlacement=\{consumeLatestTurnPlacement\}/u);
  assert.match(
    webResponseSource,
    /captureLatestTurnSubmitPlacement:[\s\S]{0,280}?distanceFromBottomPx: scrollController\.getLastScrollDistanceFromBottomPx\(\)/u,
    "submit placement snapshots share the same authoritative distance clock as measurement",
  );
  assert.match(
    webResponseSource,
    /consumePendingLatestTurnSubmitPlacement !== undefined && placement === null && !allowInitialPlacement\) \{\s*return;/u,
    "an unowned replica Turn must not acquire local-submit follow policy",
  );
  assert.match(
    webVirtualizedTurnsSource,
    /preserveViewport: preserveMeasuredTurnViewport/u,
    "rejecting latest-Turn policy must not suppress virtualizer-owned anchor reconciliation",
  );
  assert.doesNotMatch(webResponseSource, /pendingLatestTurnPlacementRef/u);
  assert.match(expoFrameSource, /pendingLatestTurnPlacementRef = useRef<LatestTurnPlacementSnapshot \| null>/u);
  assert.doesNotMatch(expoConversationSource, /pendingPlacementRef/u);
  assert.match(workbenchApp, /!followsActiveTurn \|\| context\.followUpAction === "steer"/u);
  assert.match(expoFrameSource, /!followsActiveTurn \|\| context\.followUpAction === "steer"/u);
  assert.match(webResponseSource, /deriveTimelineLatestTurnActivityKey\(latestTurn\)/u);
  assert.match(nativeResponseSource, /deriveTimelineLatestTurnActivityKey\(latestTurn\)/u);
  assert.match(
    webResponseSource,
    /previousLatestTurnActivityKey !== latestTurnActivityKey/u,
    "steering must advance placement identity without replacing the Turn row",
  );
});

test("response lifecycle keeps row identity and uses one mount/submit transition", () => {
  assert.match(webConversationSource, /style=\{\{ y: offset \?\? 0 \}\}/u);
  assert.doesNotMatch(webConversationSource, /return offset === null/u);
  assert.equal(webResponseSource.match(/consumePendingLatestTurnSubmitPlacement\?\.\(\)/gu)?.length, 1);
  assert.equal(webResponseSource.match(/scrollToDistanceFromBottomPx\(1, "instant"\)/gu)?.length, 1);
  assert.match(webResponseSource, /initialPlacementPendingRef\.current = false;\s*const placement = consumePendingLatestTurnSubmitPlacement/u);
  assert.match(
    webResponseSource,
    /distanceAfterUnplacedLatestTurnContentResize\(\{[\s\S]{0,160}?nextScrollHeightPx: element\.scrollHeight,[\s\S]{0,80}?placement/u,
  );
  assert.match(webResponseSource, /previousInProgress && !isLatestTurnInProgress\) \{\s*stopResponseAnimations\(\);\s*latestTurnOffset\.set\(0\);\s*\}/u);
  assert.doesNotMatch(webResponseSource, /stopResponseAnimations\((?:true|false)\)/u);
  assert.match(webResponseSource, /<VirtualizedConversationTurns/u);
  assert.doesNotMatch(webResponseSource, /pendingMeasurementTransactionRef|measuredHeightsByKey|layoutRef|viewportRef|reconcileTurnLayoutViewport|handledLatestTurnLayout/u);
  assert.doesNotMatch(webVirtualizedTurnsSource, /followStateRef|latestTurnActivityKey|consumePendingLatestTurnSubmitPlacement|useMotionValue/u);
  assert.match(webVirtualizedTurnsSource, /viewportOwner\.measureNewlyMountedTurns\(\)/u);
});

test("response observation follows the controller boundary, not button visibility", () => {
  assert.match(webResponseSource, /setIsScrolledFromBottom\(snapshot\.isScrolledFromBottom\)/u);
  assert.match(webResponseSource, /\[isScrolledFromBottom, responseSpacerHeight, shrinkResponseSpacer, viewportOwner\]/u);
  assert.doesNotMatch(webResponseSource, /\[showScrollToBottom, responseSpacerHeight, shrinkResponseSpacer, viewportOwner\]/u);
});

test("a new-thread workspace is an optional execution override, not Composer ownership", () => {
  assert.match(
    newThreadDraftSource,
    /disabled=\{draftSubmissionOwnsNavigation\(draft\.phase\)\}/u,
  );
  assert.doesNotMatch(newThreadDraftSource, /workspaceReady/u);
  assert.doesNotMatch(
    newThreadDraftSource,
    /runtimeWorkspaceRoots[\s\S]{0,160}?disabled/u,
  );
});

test("user messages preserve Codex's authored-message width invariant", () => {
  assert.match(
    workbenchStyles,
    /&__bubble\s*\{\s*max-width:\s*77%/u,
  );
  assert.doesNotMatch(workbenchStyles, /--thread-user-message-inline-gutter/u);
});

test("the transcript and Composer consume Codex's shared toolbar inset", () => {
  assert.match(
    workbenchStyles,
    /\.thread-layout-width\s*\{[\s\S]{0,240}?padding-inline:\s*var\(--padding-toolbar\)/u,
  );
  assert.doesNotMatch(workbenchStyles, /--thread-toolbar-inline-padding/u);
});

test("workbench preserves Codex's native themed scrollbar contract", () => {
  assert.match(
    workbenchStyles,
    /\*\s*\{[\s\S]*?scrollbar-color:\s*var\(--scrollbar-thumb\)\s+transparent;[\s\S]*?scrollbar-width:\s*thin;[\s\S]*?\}/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /\.thread-scroll\s*\{[\s\S]{0,600}?scrollbar-width:\s*none/u,
  );
});

test("the collapsing sidebar divider stays below the fixed toolbar", () => {
  assert.match(
    workbenchStyles,
    /\.app-shell-left-panel__resize\s*\{[\s\S]*?z-index:\s*20;[\s\S]*?\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-header\s*\{[\s\S]*?z-index:\s*30;[\s\S]*?\}/u,
  );
  assert.match(
    workbenchStyles,
    /\[data-sidebar-presentation="layout-transition"\][\s\S]*?\.app-shell-left-panel__resize:not\(\[data-resizing="true"\]\)[\s\S]*?pointer-events:\s*none;/u,
  );
});

test("Web owns one desktop topology and keeps responsive projection separate from sidebar intent", () => {
  assert.match(
    appShellSource,
    /usePanelAnimation\(\{[\s\S]*?animation:\s*sidebarAnimation,[\s\S]*?isVisible:\s*sidebarOpen/u,
  );
  assert.doesNotMatch(
    appShellSource,
    /compactOverlay|sidebarLayout|sidebarAnimation\.set\(sidebarOpen \? 1 : 0\)/u,
  );
  assert.doesNotMatch(responsiveSidebarDockSource, /matchMedia|setSidebarOpen\(false\)/u);
  assert.match(appShellSource, /const sidebarOpen = space\.contextOpen/u);
  assert.doesNotMatch(
    workbenchStyles,
    /data-sidebar-layout|sidebar-panel__mobile-toolbar/u,
  );
});

test("narrow desktop header keeps Codex's intrinsic action rail", () => {
  assert.match(
    workbenchStyles,
    /\.app-shell-header__window-controls\s*\{[\s\S]*?width:\s*var\(--app-shell-header-left-slot-width\);[\s\S]*?min-width:\s*var\(--app-shell-header-left-fit-width\);/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /--app-shell-header-left-slot-width:\s*86px/u,
  );
});

test("narrow desktop header preserves the thread identity icon", () => {
  assert.match(appShellHeaderSource, /className="thread-header-project-icon"/u);
  assert.doesNotMatch(
    workbenchStyles,
    /\.thread-header-project-icon\s*\{[^}]*display:\s*none;/u,
  );
});

test("Electron titlebar subtracts only real controls from its native drag surface", () => {
  assert.match(
    workbenchStyles,
    /\.app-shell-header\s*\{[\s\S]{0,760}?-webkit-app-region:\s*drag/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-floating-left-panel__header\s*\{[\s\S]{0,520}?-webkit-app-region:\s*drag/u,
  );
  assert.doesNotMatch(appShellHeaderSource, /className="thread-header-title no-drag"/u);
  assert.match(appShellHeaderSource, /className="thread-header-title"/u);
  assert.match(appShellHeaderSource, /className="chrome-button no-drag/u);
  assert.match(
    appShellHeaderSource,
    /className="app-shell-header__window-action no-drag"/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-header__window-controls-rail\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?\.app-shell-header__window-action\s*\{[\s\S]*?pointer-events:\s*auto;[\s\S]*?-webkit-app-region:\s*no-drag;/u,
  );
});

test("the header end slot measures fit width outside its animated geometry", () => {
  assert.match(appShellHeaderSource, /ref=\{endActionsMeasureRef\}/u);
  assert.match(
    workbenchStyles,
    /\.app-shell-header__end-measure\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?width:\s*max-content;[\s\S]*?min-width:\s*max-content;[\s\S]*?visibility:\s*hidden;/u,
  );
  assert.match(
    appShellHeaderSource,
    /minWidth:\s*headerRightWidthPx,[\s\S]*?width:\s*rightPanelAnimatedWidthPx/u,
  );
});

test("a full-width right panel exclusively owns the center toolbar", () => {
  assert.match(
    appShellHeaderSource,
    /className="app-shell-header__context-surface"[\s\S]*?aria-hidden=\{rightPanelFullWidth\}[\s\S]*?data-app-shell-header-context-hidden=\{rightPanelFullWidth\}/u,
  );
  assert.match(
    workbenchApp,
    /rightPanelFullWidth=\{conversationSurfaceVisible && presentedRightPanelFullWidth\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-header__context-surface\[data-app-shell-header-context-hidden="true"\]\s*\{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/u,
  );
  assert.match(
    workbenchStyles,
    /\.main-content-viewport\[data-app-shell-right-panel-full-width="true"\]\s*\{\s*overflow:\s*hidden;/u,
  );
  assert.match(appShellSource,/className="main-content-frame"\s*style=\{\{ width: mainFrameWidth \}\}/u);
  assert.match(workbenchStyles,/\.main-content-frame\s*\{[^}]*min-width:\s*100%;[^}]*container:\s*app-shell-main-content/u);
});

test("right-panel maximize is one semantic-to-motion geometry transaction", () => {
  assert.match(
    appShellSource,
    /const paneGeometry = useTransform\([\s\S]*?workspacePaneGeometry\([\s\S]*?const rightPanelWidth = useTransform\(paneGeometry, geometry => geometry.contentWidth\)/u,
  );
  assert.doesNotMatch(
    appShellSource,
    /const rightPanelWidth = rightPanelFullWidth\s*\?/u,
    "semantic maximize must retarget one continuous physical width signal",
  );
  assert.match(
    appShellSource,
    /const rightPanelAnimatedWidth = rightPanelFullWidth\s*\? zeroWidth\s*:\s*regularRightPanelAnimatedWidth/u,
  );
  assert.doesNotMatch(appShellSource, /rightPanelLayoutMode/u);
  assert.match(
    appShellSource,
    /const mainContentTargetWidth = !rightPanelOpen[\s\S]*?\? mainContentWidth[\s\S]*?: rightPanelFullWidth[\s\S]*?\? zeroWidth[\s\S]*?: regularMainContentTargetWidth/u,
  );
  assert.match(
    appShellSource,
    /const headerLeftFitWidth = useMotionValue\([\s\S]*?getHeaderStartMinimumWidth\(windowChrome\)[\s\S]*?const fullWidthTabBarLeftInset = useTransform\(\s*\[totalLeftWidth, headerLeftFitWidth\][\s\S]*?Number\(startMinimumWidth\) - Number\(leftWidth\)[\s\S]*?const rightPanelTabBarLeftInset = rightPanelFullWidth/u,
  );
  assert.match(
    appShellSource,
    /const headerLeftSlotWidth = useTransform\(\s*totalLeftWidth[\s\S]*?const headerLeftFitWidthPx = useTransform\(\s*headerLeftFitWidth/u,
  );
  assert.match(appShellSource, /const totalLeftWidth = useTransform\(\s*\[animatedNavigationWidth, animatedSidebarWidth\]/u);
  assert.match(appShellSource, /const mainContentWidth = useTransform\(\s*\[shellWidth, totalLeftWidth\]/u);
  assert.match(
    appShellHeaderSource,
    /hostRole !== "persistent"[\s\S]*?measure\.getBoundingClientRect\(\)\.width[\s\S]*?headerLeftFitWidth\.set\(width\)/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-header__window-controls-measure\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?width:\s*max-content;[\s\S]*?visibility:\s*hidden;[\s\S]*?\.app-shell-header__window-controls-rail\s*\{[\s\S]*?padding:[\s\S]*?calc\(var\(--spacing-token-safe-header-left\) \+ 6px\)/u,
  );
  assert.match(
    rightPanelTabsSource,
    /className="right-panel-header-start-spacer"[\s\S]*?style=\{\{ width: tabBarLeftInsetPx \}\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.right-panel-header-start-spacer\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?pointer-events:\s*none;/u,
  );
});

test("right-panel visibility and geometry remain AppShell-owned signals", () => {
  assert.match(
    appShellSource,
    /const rightPanelAnimation = useMotionValue\(rightPanelOpen \? 1 : 0\)/u,
  );
  assert.match(
    appShellSource,
    /useWorkspacePaneAnimation\(fullWidthProgress, rightPanelAnimation, rightPanelFullWidth, layoutScope, rightPanelOpen\)/u,
  );
  assert.match(
    appShellSource,
    /const regularRightPanelAnimatedWidth = useTransform\(paneGeometry, geometry => geometry.occupiedWidth\)/u,
  );
  assert.match(appShellSource, /const regularMainContentTargetWidth = useTransform/u);
  assert.match(rightPanelSource, /readonly animation: MotionValue<number>/u);
  assert.doesNotMatch(rightPanelSource, /headerSlotWidth/u);
  assert.doesNotMatch(rightPanelSource, /useMotionValue/u);
  assert.match(
    panelAnimationSource,
    /isMounted:\s*isVisible \|\| animation\.get\(\) > 0/u,
  );
  assert.match(panelAnimationSource, /"animationComplete"/u);
});

test("a wide viewport never invents an open right-panel route", () => {
  assert.match(
    panelRuntimeSource,
    /return createWorkbenchPanelReactRuntime\(\{\}, context\);/u,
  );
  assert.doesNotMatch(panelRuntimeSource, /matchMedia/u);
  assert.doesNotMatch(panelRuntimeSource, /defaultRightPanelOpen:\s*true/u);
});

test("right-panel chrome is persistent while its default route is lazy", () => {
  assert.doesNotMatch(builtinPanelSource, /initialTab:/u);
  assert.match(
    workbenchApp,
    /allowEmpty:\s*panelState\.right\.tabs\.length === 0/u,
  );
  assert.doesNotMatch(workbenchApp, /rightPanelAvailable/u);
  assert.doesNotMatch(workbenchApp, /panels\.open\(panelThreadId, "changes"/u);
  assert.match(
    appShellHeaderSource,
    /aria-label=\{[\s\S]*?"Hide task details"[\s\S]*?"Show task details"/u,
  );
  assert.match(appShellHeaderSource, /app-shell-header__right-panel-toggle/u);
  assert.match(appShellHeaderSource, /aria-pressed=\{rightPanelOpen\}/u);
  assert.match(
    appShellHeaderSource,
    /<RightPanelToggleIcon panelOpen=\{rightPanelOpen\} \/>/u,
  );
});

test("an incomplete navigation projection reuses one empty anchor snapshot", () => {
  assert.match(
    navigationRailSource,
    /const EMPTY_NAVIGATION_ANCHORS:[\s\S]*?= \[\];/u,
  );
  assert.match(navigationRailSource, /:\s*EMPTY_NAVIGATION_ANCHORS;/u);
  assert.doesNotMatch(
    navigationRailSource,
    /snapshot\.completeness === "complete" \? snapshot\.anchors : \[\]/u,
  );
});

test("the prompt rail owns a scroll-position-aware edge fade and the viewport owns its overlay host", () => {
  assert.match(
    navigationRailSource,
    /const \[railHost, setRailHost\] = useState<HTMLElement \| null>\(null\)/u,
  );
  assert.match(
    navigationRailSource,
    /setRailHost\(\(current\) => current === nextRailHost \? current : nextRailHost\)/u,
  );
  assert.match(
    navigationRailSource,
    /createPortal\(<nav className="conversation-navigation-rail"[\s\S]*?, railHost\)/u,
  );
  assert.match(
    workbenchStyles,
    /\.conversation-navigation-rail__list[\s\S]*?animation-timeline:\s*scroll\(self y\)/u,
  );
  assert.match(
    workbenchStyles,
    /@keyframes conversation-navigation-edge-fade[\s\S]*?--navigation-rail-top-fade:\s*0px[\s\S]*?--navigation-rail-bottom-fade:\s*var\(--edge-fade-distance\)[\s\S]*?--navigation-rail-top-fade:\s*var\(--edge-fade-distance\)[\s\S]*?--navigation-rail-bottom-fade:\s*0px/u,
  );
  assert.match(
    navigationRailSource,
    /const observationKey = useMemo\(\(\) => navigationObservationKey\(items\), \[items\]\)/u,
  );
  assert.match(
    navigationRailSource,
    /if \(mutationsChangeMountedTurns\(records\)\) reconcile\(\)/u,
  );
  assert.match(
    navigationRailSource,
    /setVisibleItemIds\(\(current\) => equalStringSets\(current, next\) \? current : next\)/u,
  );
  assert.match(
    navigationRailSource,
    /\}, \[getScrollElement, observationKey\]\);/u,
  );
});

test("a virtualizer handoff gap cannot promote the newest prompt marker", () => {
  assert.match(
    navigationRailSource,
    /const firstVisibleIndex = items\.findIndex\([\s\S]*?if \(firstVisibleIndex < 0\) return;/u,
  );
  assert.doesNotMatch(
    navigationRailSource,
    /if \(firstVisibleIndex < 0\)[\s\S]{0,160}?setVisibleItemIds/u,
  );
});

test("history pagination keeps one callback identity across viewport measurements", () => {
  assert.match(
    workbenchApp,
    /const loadOlderConversation = useStableEvent\(\s*\(\) => activeThreadLease\?\.loadOlder\(\) \?\? Promise\.resolve\(\),?\s*\)/u,
  );
  assert.match(workbenchApp, /\? loadOlderConversation\s*:\s*undefined/u);
  assert.doesNotMatch(
    workbenchApp,
    /onLoadOlder=\{[\s\S]*?\? \(\) => activeThreadLease\?\.loadOlder\(\)/u,
  );
  assert.match(
    expoFrameSource,
    /const loadOlderConversation = useStableEvent\(\(\) => activeThreadLease\?\.loadOlder\(\) \?\? Promise\.resolve\(\)\)/u,
  );
  assert.match(expoFrameSource, /\? loadOlderConversation : undefined/u);
  assert.match(stableEventSource, /useInsertionEffect\(\(\) => \{/u);
  assert.match(stableEventSource, /return useCallback\([\s\S]*?\[\]\);/u);
  for (const source of [webConversationSource, nativeVirtualizedTurnsSource]) {
    assert.match(source, /useTurnHistoryBackfill\(\{/u);
    assert.doesNotMatch(source, /loadOlderPendingRef/u);
  }
  assert.match(webConversationSource, /historyBackfill\.invalidate\(\);/u);
  assert.doesNotMatch(webViewportOwnerSource, /observer\.observe\(element\.firstElementChild\)/u);
  assert.match(webConversationSource, /onContentLayoutCommitted=\{loadOlderUntilScrollable\}/u);
});

test("right-panel resize interaction is owned only by its edge handle", () => {
  assert.doesNotMatch(rightPanelSource, /data-resizing=\{resizing\}/u);
  assert.doesNotMatch(
    workbenchStyles,
    /\.app-shell-right-panel\s*\{[^}]*data-resizing/u,
  );
  assert.match(
    workbenchStyles,
    /\.right-panel-resize-handle\s*\{[\s\S]*?cursor:\s*col-resize;[\s\S]*?touch-action:\s*none;[\s\S]*?user-select:\s*none;/u,
  );
});

test("right-panel surface width and minimum share one atomic target signal", () => {
  assert.match(
    rightPanelSource,
    /"--app-shell-right-panel-target-width":\s*rightPanelTargetWidthPx/u,
  );
  assert.doesNotMatch(
    rightPanelSource,
    /style=\{\{\s*minWidth:\s*rightPanelWidth,\s*width:\s*rightPanelWidth\s*\}\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-right-panel__surface\s*\{[\s\S]*?width:\s*var\(--app-shell-right-panel-target-width\);[\s\S]*?min-width:\s*var\(--app-shell-right-panel-target-width\);/u,
  );
});

test("browser portal commits one dual-coordinate viewport transaction", () => {
  assert.match(
    rightPanelSource,
    /progress\.on\("change",[\s\S]*?rightPanelLayoutTick\.set/u,
  );
  assert.match(
    browserPanelSource,
    /rightPanelLayoutTick\.on\([\s\S]*?"change",[\s\S]*?scheduleMeasure/u,
  );
  assert.match(
    browserPanelSource,
    /requestAnimationFrame\([\s\S]*?presentation\.measure\(\)/u,
  );
  assert.match(
    browserSurfaceHostSource,
    /container\.style\.width = `\$\{visualBounds\.width\}px`;[\s\S]*?iframe\.style\.width = `\$\{viewportSize\.width\}px`;/u,
  );
  assert.match(
    browserSurfaceHostSource,
    /container\.style\.height = `\$\{visualBounds\.height\}px`;[\s\S]*?iframe\.style\.height = `\$\{viewportSize\.height\}px`;/u,
  );
  assert.match(
    browserSurfaceHostSource,
    /iframe\.style\.transform = scale === 1 \? "" : `scale\(\$\{scale\}\)`;/u,
  );
  assert.match(
    browserPresentationSource,
    /intersectBrowserPresentationBounds\([\s\S]*?this\.manager\.syncElectronWebview/u,
  );
  assert.doesNotMatch(webBrowserRuntimeSource, /HTMLIFrameElement|HTMLElement|ResizeObserver/u);
  assert.doesNotMatch(browserSurfaceHostSource, /PanelTab|\bviewId\b|BrowserTabId/u);
  assert.doesNotMatch(browserPresentationSource, /framesRemaining/u);
});

test("browser presentation retires with the physical panel presence", () => {
  assert.match(
    appShellSource,
    /const \[rightPanelPresentationActive, setRightPanelPresentationActive\] =\s*useState/u,
  );
  assert.match(
    appShellSource,
    /if \(progress <= 0\.001\) setRightPanelPresentationActive\(false\)/u,
  );
  assert.match(
    browserPanelSource,
    /\|\| !rightPanelPresentationActive\s*\) return;/u,
  );
  assert.match(browserPanelSource, /presentation\.dispose\(\);/u);
});

test("thread edge-scroll is one measured AppShell state", () => {
  assert.deepEqual(
    resolveAppShellMainContentChrome({
      layout: "default",
      threadEdgeScrollEligible: true,
    }),
    { headerEdgeScroll: false, threadEdgeDivider: false },
    "default routes reserve titlebar geometry without borrowing the thread divider",
  );
  assert.deepEqual(
    resolveAppShellMainContentChrome({
      layout: "thread-edge-scroll",
      threadEdgeScrollEligible: false,
    }),
    { headerEdgeScroll: false, threadEdgeDivider: true },
  );
  assert.deepEqual(
    resolveAppShellMainContentChrome({
      layout: "thread-edge-scroll",
      threadEdgeScrollEligible: true,
    }),
    { headerEdgeScroll: true, threadEdgeDivider: false },
  );

  const threshold = THREAD_EDGE_SCROLL_MINIMUM_WIDTH_REM * 16;
  assert.equal(
    resolveThreadEdgeScroll({
      shellWidthPx: threshold - 0.01,
      rightChromeWidthPx: 0,
      rightPanelFullWidth: false,
      rootFontSizePx: 16,
    }),
    false,
  );
  assert.equal(
    resolveThreadEdgeScroll({
      shellWidthPx: threshold,
      rightChromeWidthPx: 0,
      rightPanelFullWidth: false,
      rootFontSizePx: 16,
    }),
    true,
  );
  assert.equal(
    resolveThreadEdgeScroll({
      shellWidthPx: threshold + 275,
      rightChromeWidthPx: 275,
      rightPanelFullWidth: false,
      rootFontSizePx: 16,
    }),
    true,
    "only the real right panel is subtracted from the Shell envelope",
  );
  assert.equal(
    resolveThreadEdgeScroll({
      shellWidthPx: threshold + 300,
      rightChromeWidthPx: 0,
      rightPanelFullWidth: true,
      rootFontSizePx: 16,
    }),
    false,
  );

  assert.match(
    workbenchStyles,
    /\.main-content-top-fade\s*\{[\s\S]*?transition:\s*opacity\s+var\(--transition-duration-basic\);[\s\S]*?\}/u,
  );
  assert.match(
    workbenchStyles,
    /html\[data-codex-window-type="browser"\]\s+\.main-content-top-fade\s*\{[\s\S]*?display:\s*none;[\s\S]*?\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.app-shell-header[\s\S]*?&\[data-app-shell-header-edge-scroll="true"\]\s*\{[\s\S]*?background:\s*transparent;/u,
  );
  assert.match(
    appShellSource,
    /data-app-shell-main-content-layout=\{presentedMainContentLayout\}/u,
  );
  assert.match(
    workbenchApp,
    /mainContentLayout=\{conversationSurfaceVisible \? "thread-edge-scroll" : "default"\}/u,
  );
  assert.match(
    appShellSource,
    /data-app-shell-thread-edge-scroll=\{isHeaderEdgeScroll\}/u,
  );
  assert.match(
    appShellSource,
    /data-app-shell-thread-edge-divider=\{threadEdgeDivider\}/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /\.settings-page__titlebar-spacer/u,
  );
  assert.match(
    workbenchStyles,
    /\.main-content-viewport\[data-app-shell-main-content-layout="thread-edge-scroll"\]\[data-app-shell-thread-edge-scroll="true"\][\s\S]*?\.main-content-frame/u,
  );
  assert.doesNotMatch(
    workbenchStyles,
    /\[data-app-shell-main-content-layout="thread-edge-scroll"\]\s+&\[data-app-shell-thread-edge-scroll="true"\]/u,
  );
});

test("scroll-to-bottom action stays mounted in the Composer zero-height overlay", () => {
  assert.match(
    workbenchStyles,
    /\.thread-scroll-to-bottom-anchor\s*\{[\s\S]*?position:\s*relative;[\s\S]*?height:\s*0;[\s\S]*?\}/u,
  );
  assert.match(
    workbenchStyles,
    /\.thread-scroll-to-bottom-button\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ 6 \* var\(--spacing\)\);[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/u,
  );

  const hidden = renderToStaticMarkup(
    createElement(ScrollToBottomButton, {
      label: "Scroll to bottom",
      onClick: () => undefined,
      show: false,
    }),
  );
  assert.match(hidden, /aria-hidden="true"/u);
  assert.match(hidden, /tabindex="-1"/u);
  assert.match(hidden, /data-visible="false"/u);

  const working = renderToStaticMarkup(
    createElement(ScrollToBottomButton, {
      label: "Scroll to bottom",
      onClick: () => undefined,
      show: true,
      showWorkingDots: true,
    }),
  );
  assert.match(working, /aria-hidden="false"/u);
  assert.match(working, /tabindex="0"/u);
  assert.equal(
    working.match(/thread-scroll-to-bottom-button__dot/g)?.length,
    3,
  );
});

test("Native Composer does not duplicate the live response as a Working row", () => {
  assert.match(expoComposerSource, /isResponseInProgress:\s*isStreaming/u);
  assert.match(expoComposerSource, /primaryAction === "stop"/u);
  assert.doesNotMatch(expoComposerSource, /workingStatus|workingDots|>Working</u);
});

test("iPad desktop-class user agents still select the iOS viewport host", () => {
  assert.equal(
    resolveWebTimelinePlatform({
      maxTouchPoints: 5,
      navigatorPlatform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }),
    "ios",
  );
  assert.equal(
    resolveWebTimelinePlatform({
      maxTouchPoints: 0,
      navigatorPlatform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
    }),
    "darwin",
  );
});

test("VisualViewport snapshots expose keyboard occlusion but not pinch zoom", () => {
  const keyboard = createWebTimelineViewportSnapshot({
    editableFocused: true,
    layoutHeightPx: 1_024,
    layoutWidthPx: 1_366,
    revision: 4,
    visualHeightPx: 650,
    visualWidthPx: 1_366,
  });
  assert.equal(keyboard.keyboardInsetBottomPx, 374);
  assert.equal(keyboard.revision, 4);

  const zoom = createWebTimelineViewportSnapshot({
    editableFocused: true,
    layoutHeightPx: 1_024,
    layoutWidthPx: 1_366,
    revision: 5,
    scale: 1.5,
    visualHeightPx: 650,
    visualOffsetTopPx: 80,
    visualWidthPx: 900,
  });
  assert.equal(zoom.keyboardInsetBottomPx, 0);
});

test("footer measurement prefers the ResizeObserver border box", () => {
  const entry = {
    borderBoxSize: [{ blockSize: 116.5, inlineSize: 700 }],
    contentRect: { height: 100 },
  } as unknown as ResizeObserverEntry;
  assert.equal(resizeObserverBlockSize(entry), 116.5);
});

test("the Web Conversation owns one horizontal plane for transcript and Composer", () => {
  assert.doesNotMatch(webConversationSource, /footerAttachment|thread-scroll-footer-spacer/u);
  assert.doesNotMatch(workbenchStyles, /thread-scroll-chrome-inline|viewport-overlay/u);
  assert.match(
    webConversationSource,
    /className="thread-scroll-surface"[\s\S]*?className="thread-content thread-layout-width"[\s\S]*?\{footerElement\}/u,
  );
  assert.equal(
    webConversationSource.match(/wideContentOffsetPx/g)?.length,
    2,
    "the surface consumes the horizontal offset once and derives only the wide-block CSS value",
  );
});

test("the conversation scrollport terminates browser boundary scrolling", () => {
  const threadScrollRule = workbenchStyles.match(
    /\.thread-scroll\s*\{[\s\S]*?\n\}/u,
  )?.[0] ?? "";
  assert.match(threadScrollRule, /overscroll-behavior:\s*none/u);
  assert.doesNotMatch(workbenchStyles, /data-timeline-overscroll/u);
});

test("reflow pinning follows Codex window-zoom compensation", () => {
  assert.equal(timelineReflowScrollAdjustment(200, 260), 60);
  assert.equal(timelineReflowScrollAdjustment(200, 260, 1.5), 40);
});

test("response spacer mutation stays private behind a read/subscribe API", () => {
  const apiContract = webResponseSource.slice(
    webResponseSource.indexOf("export interface ResponsePositionedTurnsApi"),
    webResponseSource.indexOf("export function ResponsePositionedTurns"),
  );
  assert.match(apiContract, /getSpacerHeightPx\(\): number/u);
  assert.match(apiContract, /subscribeSpacerHeight\(listener: \(\) => void\): \(\) => void/u);
  assert.doesNotMatch(apiContract, /MotionValue|readonly spacerHeight/u);
  const apiImplementation = webResponseSource.slice(
    webResponseSource.indexOf("const responseApi = useMemo"),
    webResponseSource.indexOf("onResponseApiChange(responseApi)"),
  );
  assert.match(apiImplementation, /getSpacerHeightPx: \(\) => responseSpacerHeight\.get\(\)/u);
  assert.match(apiImplementation, /subscribeSpacerHeight: \(listener\) => responseSpacerHeight\.on\("change", listener\)/u);
  assert.doesNotMatch(apiImplementation, /spacerHeight: responseSpacerHeight/u);
  assert.match(webConversationSource, /responseApi\?\.subscribeSpacerHeight\(listener\)/u);
  assert.match(webConversationSource, /responseApi\?\.getSpacerHeightPx\(\)/u);
  assert.doesNotMatch(webConversationSource, /responseApi\?\.spacerHeight/u);
});

test("the Web host explicitly selects Codex response placement without a hidden policy default", () => {
  assert.match(workbenchApp, /scrollPolicy="response-placement"/u);
  assert.match(workbenchApp, /consumePendingLatestTurnSubmitPlacement=\{consumeLatestTurnPlacement\}/u);
  assert.match(webConversationSource, /readonly scrollPolicy: ConversationScrollPolicy/u);
  assert.doesNotMatch(webConversationSource, /scrollPolicy = "natural"/u);
});

test("natural policy mounts the virtualizer without constructing response owners", () => {
  assert.doesNotMatch(webConversationSource, /useMotionValue|followStateRef|reduceTurnFollowState|thread-response-spacer/u);
  const naturalList = webConversationSource.slice(webConversationSource.lastIndexOf("<VirtualizedConversationTurns"));
  assert.match(naturalList, /preserveMeasuredTurnViewport\s/u);
  assert.doesNotMatch(naturalList, /onLatestTurnMeasurement=|getBottomScrollPaddingPx=|getPendingRestoreScrollDistanceFromBottomPx=|restoreScrollDistanceFromBottomPx=|consumePendingLatestTurnSubmitPlacement=/u);
  assert.match(webResponseSource, /preserveMeasuredTurnViewport=\{!isLatestTurnInProgress\}/u);
  assert.match(webConversationSource, /turnFollow: responseRestore\?\.turnFollow \?\? null/u);
  assert.doesNotMatch(webResponseSource, /viewportOwner\.dispose\(/u, "policy must not dispose the shared platform owner");
});
