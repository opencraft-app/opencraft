import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

function readFiles(paths: string[]) {
  return paths
    .map((path) => `// ${path}\n${readFileSync(join(root, path), "utf8")}`)
    .join("\n");
}

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : [path];
  });
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `${start} should exist`);
  assert.notEqual(endIndex, -1, `${end} should exist after ${start}`);
  return source.slice(startIndex, endIndex);
}

test("desktop integration is split into host, shell, controller, and chat renderer packages", () => {
  const expectedPaths = [
    "apps/vela-desktop-electron/README.md",
    "apps/vela-desktop-electron/electron/main.ts",
    "apps/vela-desktop-electron/electron/preload.ts",
    "apps/vela-desktop-electron/electron/session-preview/session-preview-window-metrics.ts",
    "apps/vela-desktop-electron/electron/work-monitor/work-monitor-window-manager.ts",
    "apps/vela-desktop-electron/src/DesktopApp.tsx",
    "apps/vela-desktop-electron/src/session-preview/SessionPreviewWindowContent.tsx",
    "apps/vela-desktop-electron/src/work-monitor/WorkMonitorRoot.tsx",
    "packages/vela-chat-controller/README.md",
    "packages/vela-chat-controller/src/useVelaChatSession.ts",
    "packages/vela-chat-web/src/thumbnail/ConversationPreviewSurface.tsx",
    "packages/vela-desktop-shell/README.md",
    "packages/vela-desktop-shell/src/VelaDesktopShell.tsx",
    "packages/vela-desktop-shell/src/components/session/SessionSidebar.tsx",
    "packages/vela-desktop-shell/src/components/sidebar/VelaSidebarShell.tsx",
  ];

  for (const path of expectedPaths) {
    assert.equal(existsSync(join(root, path)), true, `${path} should exist`);
  }
});

test("desktop shell owns only reusable chrome and does not talk to velad or chat state", () => {
  const shellSource = readFiles(
    listSourceFiles(join(root, "packages/vela-desktop-shell/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );

  assert.match(shellSource, /DesktopHostBridge/);
  assert.match(shellSource, /SessionSidebar/);
  assert.match(shellSource, /VelaSidebarShell/);
  assert.doesNotMatch(shellSource, /createVeladClient/);
  assert.doesNotMatch(shellSource, /useVelaChatSession/);
  assert.doesNotMatch(shellSource, /ChatSurface/);
  assert.doesNotMatch(shellSource, /EventSource/);
  assert.doesNotMatch(shellSource, /\/api\/v1/);
  assert.doesNotMatch(shellSource, /electron/);
  assert.doesNotMatch(shellSource, /tauri/i);
});

test("cross-host embedding reuses chat-web surfaces instead of desktop shell panels", () => {
  const packagesReadme = readFileSync(join(root, "packages/README.md"), "utf8");
  const desktopShellReadme = readFileSync(
    join(root, "packages/vela-desktop-shell/README.md"),
    "utf8",
  );
  const chatWebReadme = readFileSync(
    join(root, "packages/vela-chat-web/README.md"),
    "utf8",
  );
  const desktopShellIndex = readFileSync(
    join(root, "packages/vela-desktop-shell/src/index.ts"),
    "utf8",
  );
  const chatWebSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/SessionListSurface.tsx"),
    "utf8",
  );

  assert.match(packagesReadme, /SessionListSurface/);
  assert.match(packagesReadme, /ChatSurface/);
  assert.match(packagesReadme, /must not import `VelaDesktopShell`/);
  assert.match(desktopShellReadme, /Desktop-only shell components/);
  assert.match(desktopShellReadme, /not the cross-host workbench API/);
  assert.match(desktopShellReadme, /Avoid adding generic names such as\s*`SessionPanel`/);
  assert.match(chatWebReadme, /Embeddable surfaces/);
  assert.match(chatWebReadme, /Host apps own layout around these surfaces/);
  assert.match(chatWebSurface, /export function SessionListSurface/);
  assert.doesNotMatch(desktopShellIndex, /SessionPanel/);
});

test("host-local state is created only by app hosts, not reusable shell chrome", () => {
  const shellSource = readFiles(
    listSourceFiles(join(root, "packages/vela-desktop-shell/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const desktopApp = readFiles([
    "apps/vela-desktop-electron/src/DesktopApp.tsx",
    "apps/vela-desktop-electron/src/hostState.ts",
  ]);
  const nextChatExample = readFiles([
    "app/chat/ChatWorkbench.tsx",
    "app/chat/workbench/hostState.ts",
  ]);

  assert.equal(existsSync(join(root, "packages/vela-chat-host-state/README.md")), true);
  assert.equal(existsSync(join(root, "packages/vela-chat-host-state/src/README.md")), true);
  assert.doesNotMatch(shellSource, /vela-chat-host-state/);
  assert.doesNotMatch(shellSource, /localStorage|sessionStorage/);
  assert.match(desktopApp, /createRuntimeHostStateStores/);
  assert.match(desktopApp, /createBrowserVelaClientStateStore/);
  assert.match(desktopApp, /createBrowserVelaShellLayoutStore/);
  assert.match(desktopApp, /createBrowserVelaSessionSelectionStore/);
  assert.match(desktopApp, /sessionSelectionStore/);
  assert.match(nextChatExample, /createChatExampleClientStateStore/);
  assert.match(nextChatExample, /createBrowserVelaClientStateStore/);
});

test("desktop app opens new-session by default while persisting explicit chat selection", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const hostState = readFileSync(
    join(root, "apps/vela-desktop-electron/src/hostState.ts"),
    "utf8",
  );

  assert.match(hostState, /sessionSelectionStore/);
  assert.match(renderer, /useState<DesktopMainView>\("new-session"\)/);
  assert.doesNotMatch(renderer, /sessionSelectionStore\?\.read\(\)\?\.sessionId/);
  assert.match(renderer, /sessionSelectionStore\?\.write\(\{/);
  assert.doesNotMatch(renderer, /sessionList\.data\.sessions\[0\]\?\.id \|\| ""/);
  assert.match(renderer, /optimisticCreatedSessionIdRef/);
  assert.match(renderer, /skipMissingActiveSessionCheck/);
  assert.match(renderer, /selectChatSession\(created\.session\.id\)/);
  assert.match(renderer, /vela\.desktop\.session\.create_and_select/);
  assert.match(renderer, /vela\.desktop\.session\.selection_reconcile/);
  assert.match(renderer, /observability\.recordError\(span,\s*err\)/);
  assert.match(renderer, /vela\.desktop\.renderer\.ready/);
  assert.match(renderer, /vela\.chat\.view_state\.snapshot/);
  assert.match(renderer, /chatViewStateAttributes/);
  assert.match(renderer, /vela\.chat\.conversation\.reveal_state/);
  assert.match(renderer, /conversationRevealStateAttributes/);
  assert.match(renderer, /onConversationRevealStateChange=\{observeConversationRevealState\}/);
  assert.match(renderer, /onConversationScrollLifecycleEvent=\{observeConversationScrollLifecycle\}/);
  assert.match(renderer, /vela\.chat\.scroll_resume/);
  assert.match(renderer, /vela\.chat\.scroll_resume\.lifecycle/);
  assert.match(renderer, /vela\.chat\.scroll_resume\.debug_snapshot/);
  assert.match(renderer, /conversationScrollDebugAttributes/);
  assert.match(renderer, /conversationScrollLifecycleErrorMessage/);
  assert.match(renderer, /observability\.recordError\(span,\s*new Error\(errorMessage\)\)/);
  assert.match(renderer, /observability\.endSpan\(span,\s*\{/);
  assert.match(renderer, /route_restore_mismatch/);
  assert.match(renderer, /setMainView\("new-session"\)/);
  assert.match(renderer, /setMainView\("chat"\)/);
});

test("desktop app keeps one new-session page and removes the old workspace home composer", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const css = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.equal(
    existsSync(join(root, "apps/vela-desktop-electron/src/DesktopEmptySurface.tsx")),
    false,
  );
  assert.match(renderer, /DesktopNewSessionPage/);
  assert.doesNotMatch(renderer, /DesktopEmptySurface/);
  assert.doesNotMatch(css, /vela-home-/);
  assert.doesNotMatch(css, /vela-desktop-empty/);
  assert.doesNotMatch(renderer + css, /新建 workspace|给 Agent 发消息/);
});

test("desktop settings panel state lives with the ready app that renders settings", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const outerApp = sourceBetween(renderer, "export function DesktopApp()", "interface DesktopReadyAppProps");
  const readyApp = sourceBetween(renderer, "function DesktopReadyApp(", "interface DesktopBootstrapAppProps");

  assert.doesNotMatch(outerApp, /const \[settingsPanel, setSettingsPanel\]/);
  assert.match(readyApp, /const \[settingsPanel, setSettingsPanel\]/);
  assert.match(readyApp, /activePanel=\{settingsPanel\}/);
  assert.match(readyApp, /onPanelChange=\{setSettingsPanel\}/);
});

test("chat controller is headless and stays independent from desktop and Next shells", () => {
  const controllerSource = readFiles(
    listSourceFiles(join(root, "packages/vela-chat-controller/src"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );

  assert.match(controllerSource, /useVelaChatSession/);
  assert.match(controllerSource, /createVeladClient/);
  assert.match(controllerSource, /eventStreamTransport\.subscribe/);
  assert.doesNotMatch(controllerSource, /VelaDesktopShell/);
  assert.doesNotMatch(controllerSource, /SessionSidebar/);
  assert.doesNotMatch(controllerSource, /BrowserWindow/);
  assert.doesNotMatch(controllerSource, /next\/navigation/);
});

test("electron desktop app is the only layer that composes velad runtime, shell, controller, and ChatUI", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const runtimeSource = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/electron/runtime"))
      .filter((path) => /\.(ts|tsx|md)$/.test(path) && !/\.test\.tsx?$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const preload = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/preload.ts"),
    "utf8",
  );

  assert.match(renderer, /createVeladClient/);
  assert.match(renderer, /useVelaChatSession/);
  assert.match(renderer, /ChatSurface/);
  assert.match(renderer, /VelaDesktopShell/);
  assert.match(renderer, /SessionSidebar/);
  assert.match(renderer, /useSessionListViewQuery/);
  assert.match(renderer, /DESKTOP_SESSION_LIST_OPTIONS/);
  assert.doesNotMatch(renderer, /client\.listSessions\(\{ limit: 80 \}\)/);

  assert.match(main, /BrowserWindow/);
  assert.match(main, /runtimeEnv/);
  assert.match(main, /VeladRuntimeManager/);
  assert.match(main, /vela:desktop-info/);
  assert.doesNotMatch(main, /ChatSurface/);
  assert.doesNotMatch(main, /useVelaChatSession/);
  assert.match(runtimeSource, /VELA_DESKTOP_VELAD_PATH/);
  assert.doesNotMatch(runtimeSource, /VELA_DESKTOP_VELAD_LISTEN_ADDR/);
  assert.doesNotMatch(runtimeSource, /external velad/);
  assert.match(runtimeSource, /spawnImpl/);
  assert.match(runtimeSource, /velad\.local\.v1/);
  assert.doesNotMatch(runtimeSource, /ChatSurface/);
  assert.doesNotMatch(runtimeSource, /useVelaChatSession/);
  assert.match(preload, /vela:desktop-info/);
});

test("session work monitor keeps host windowing separate from thumbnail rendering", () => {
  const workMonitorMain = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/electron/work-monitor"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const workMonitorReadme = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/work-monitor/README.md"),
    "utf8",
  );
  const sessionPreviewMain = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/electron/session-preview"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const rendererMain = readFileSync(
    join(root, "apps/vela-desktop-electron/src/main.tsx"),
    "utf8",
  );
  const rendererWorkMonitor = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/src/work-monitor"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const rendererSessionPreview = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/src/session-preview"))
      .filter((path) => /\.(ts|tsx|css)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const sessionPreviewCss = readFileSync(
    join(root, "apps/vela-desktop-electron/src/session-preview/session-preview.module.css"),
    "utf8",
  );
  const electronMain = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );

  assert.match(workMonitorMain, /BrowserWindow/);
  assert.match(workMonitorMain, /screen/);
  assert.match(workMonitorMain, /windowsBySessionId = new Map/);
  assert.match(workMonitorMain, /activeDragPreviewSessionId/);
  assert.match(workMonitorMain, /getDisplayMatching\(anchorBounds\)/);
  assert.match(workMonitorMain, /getPrimaryDisplay\(\)/);
  assert.match(workMonitorMain, /setBounds\(/);
  assert.match(workMonitorMain, /if \(!window\.isVisible\(\)\)/);
  assert.match(workMonitorMain, /moveBySender/);
  assert.match(workMonitorMain, /openAtPoint/);
  assert.match(workMonitorMain, /moveToPoint/);
  assert.match(workMonitorMain, /endSessionDragPreview/);
  assert.match(workMonitorMain, /screen\.getDisplayNearestPoint/);
  assert.match(workMonitorMain, /findWindowBySender/);
  assert.match(workMonitorMain, /window\.webContents === sender/);
  assert.match(workMonitorMain, /setPosition\(/);
  assert.match(workMonitorMain, /alwaysOnTop/);
  assert.match(workMonitorMain, /sessionPreviewWindowSize/);
  assert.match(workMonitorMain, /visibleWindowCountForDisplay/);
  assert.match(workMonitorMain, /workMonitorStackGap/);
  assert.match(workMonitorMain, /for \(const record of records\)/);
  assert.doesNotMatch(workMonitorMain, /const workMonitorSize/);
  assert.match(sessionPreviewMain, /width:\s*214/);
  assert.match(sessionPreviewMain, /height:\s*134/);
  assert.match(workMonitorMain, /hasShadow:\s*false/);
  assert.match(workMonitorMain, /setHasShadow\(false\)/);
  assert.match(workMonitorMain, /window: "work-monitor"/);
  assert.doesNotMatch(workMonitorMain, /React/);
  assert.doesNotMatch(workMonitorMain, /ChatSurface/);
  assert.doesNotMatch(workMonitorMain, /useVelaChatSession/);
  assert.match(sessionPreviewCss, /padding:\s*2px/);
  assert.match(sessionPreviewCss, /border-radius:\s*14px/);
  assert.match(sessionPreviewCss, /0 1px 2px rgb\(15 23 42 \/ 18%\)/);
  assert.match(sessionPreviewCss, /\.sessionPreviewTitle/);
  assert.match(sessionPreviewCss, /text-overflow:\s*ellipsis/);
  assert.match(sessionPreviewCss, /pointer-events:\s*none/);
  assert.doesNotMatch(sessionPreviewCss, /0 28px 90px/);
  assert.match(workMonitorReadme, /local session work-monitor window lifecycle/);
  assert.match(workMonitorReadme, /Each visible session owns at most one native monitor window/);
  assert.match(workMonitorReadme, /same display as the main desktop window/);
  assert.match(workMonitorReadme, /must not import React/);
  assert.match(electronMain, /getAnchorWindow:\s*\(\)\s*=>\s*mainWindow/);

  assert.match(rendererMain, /windowKind === "work-monitor"/);
  assert.match(rendererMain, /WorkMonitorRoot/);
  assert.match(rendererWorkMonitor, /useVelaChatSession/);
  assert.match(rendererWorkMonitor, /SessionPreviewWindowContent/);
  assert.match(rendererWorkMonitor, /SessionPreviewStatus/);
  assert.match(rendererWorkMonitor, /controller\.model/);
  assert.match(rendererWorkMonitor, /controller\.followOutputToken/);
  assert.match(rendererWorkMonitor, /followOutputToken=\{followOutputToken\}/);
  assert.match(rendererWorkMonitor, /onConversationScrollDebugChange/);
  assert.match(rendererWorkMonitor, /observability\.emitLog/);
  assert.match(rendererWorkMonitor, /vela\.work_monitor\.bottom_anchor\.mode/);
  assert.match(rendererWorkMonitor, /client\.getSession\(sessionId\)/);
  assert.match(rendererWorkMonitor, /session\.title\.trim\(\)/);
  assert.match(rendererWorkMonitor, /useWorkMonitorInteraction/);
  assert.match(rendererWorkMonitor, /moveWorkMonitorBy/);
  assert.match(rendererWorkMonitor, /closeWorkMonitor/);
  assert.match(rendererWorkMonitor, /onPointerDown/);
  assert.match(rendererWorkMonitor, /WORK_MONITOR_DRAG_THRESHOLD_PX/);
  assert.doesNotMatch(rendererWorkMonitor, /suppressNextOpenRef/);
  assert.doesNotMatch(rendererWorkMonitor, /focusDesktopSession/);
  assert.doesNotMatch(rendererWorkMonitor, /onOpenSession/);
  assert.match(rendererSessionPreview, /ConversationPreviewSurface/);
  assert.match(rendererSessionPreview, /SESSION_PREVIEW_SCALE = 0\.25/);
  assert.match(rendererSessionPreview, /scale=\{SESSION_PREVIEW_SCALE\}/);
  assert.match(rendererSessionPreview, /sessionPreviewTitle/);
  assert.match(rendererSessionPreview, /sessionPreviewCloseButton/);
  assert.match(rendererSessionPreview, /onCloseMonitor/);
  assert.doesNotMatch(rendererSessionPreview, /onOpenSession/);
  assert.doesNotMatch(rendererSessionPreview, /role="button"/);
  assert.match(rendererWorkMonitor, /historyPolicy: "tail_only"/);
  assert.doesNotMatch(rendererWorkMonitor, /buildChatThumbnailModel/);
  assert.doesNotMatch(rendererWorkMonitor, /SessionThumbnailSurface/);
  assert.doesNotMatch(rendererWorkMonitor, /ChatSurface/);
  assert.doesNotMatch(rendererWorkMonitor, /ConversationPreviewSurface/);
  assert.doesNotMatch(rendererWorkMonitor, /BrowserWindow/);
});

test("work monitor body is drag-only and only the close icon closes its own window", () => {
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const workMonitorCloseHandler = sourceBetween(
    main,
    'ipcMain.handle("vela:work-monitor-close"',
    'ipcMain.handle("vela:work-monitor-move-by"',
  );
  const workMonitorMoveHandler = sourceBetween(
    main,
    'ipcMain.handle("vela:work-monitor-move-by"',
    '"vela:session-drag-preview-start"',
  );
  const preload = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/preload.ts"),
    "utf8",
  );
  const bridge = readFileSync(
    join(root, "apps/vela-desktop-electron/src/desktopBridge.ts"),
    "utf8",
  );
  const rendererWorkMonitor = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/src/work-monitor"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const sessionPreview = readFileSync(
    join(root, "apps/vela-desktop-electron/src/session-preview/SessionPreviewWindowContent.tsx"),
    "utf8",
  );
  const sessionPreviewCss = readFileSync(
    join(root, "apps/vela-desktop-electron/src/session-preview/session-preview.module.css"),
    "utf8",
  );

  assert.match(workMonitorCloseHandler, /workMonitor\.closeBySender\(event\.sender\)/);
  assert.match(workMonitorMoveHandler, /workMonitor\.moveBySender\(event\.sender,\s*deltaX,\s*deltaY\)/);
  assert.doesNotMatch(main, /vela:desktop-focus-session/);
  assert.doesNotMatch(main, /vela:desktop-open-session/);
  assert.match(preload, /vela:work-monitor-close/);
  assert.match(preload, /vela:work-monitor-move-by/);
  assert.doesNotMatch(preload, /focusDesktopSession/);
  assert.match(bridge, /moveWorkMonitorBy/);
  assert.match(bridge, /closeWorkMonitor/);
  assert.doesNotMatch(bridge, /focusDesktopSession/);
  assert.match(rendererWorkMonitor, /useWorkMonitorInteraction/);
  assert.doesNotMatch(rendererWorkMonitor, /focusDesktopSession/);
  assert.doesNotMatch(rendererWorkMonitor, /onOpenSession/);
  assert.match(sessionPreview, /SessionPreviewCloseButton/);
  assert.match(sessionPreview, /aria-label="Close monitor"/);
  assert.match(sessionPreviewCss, /\.sessionPreviewFrame\s*\{[^}]*cursor:\s*grab;/s);
  assert.match(sessionPreviewCss, /\.sessionPreviewFrame\[data-dragging="true"\]\s*\{[^}]*cursor:\s*grabbing;/s);
  assert.match(sessionPreviewCss, /\.sessionPreviewCloseButton\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(sessionPreviewCss, /\.sessionPreviewCloseButton\[data-visible="true"\]/);
});

test("sidebar session drag opens a session-scoped work monitor instead of a second preview window", () => {
  const electronMain = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const preload = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/preload.ts"),
    "utf8",
  );
  const bridge = readFileSync(
    join(root, "apps/vela-desktop-electron/src/desktopBridge.ts"),
    "utf8",
  );
  const rendererMain = readFileSync(
    join(root, "apps/vela-desktop-electron/src/main.tsx"),
    "utf8",
  );
  const sessionPreviewMain = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/electron/session-preview"))
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const sessionPreviewRenderer = readFiles(
    listSourceFiles(join(root, "apps/vela-desktop-electron/src/session-preview"))
      .filter((path) => /\.(ts|tsx|css)$/.test(path))
      .map((path) => path.slice(root.length + 1)),
  );
  const sessionListSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/SessionListSurface.tsx"),
    "utf8",
  );
  const desktopCss = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );

  assert.match(sessionPreviewMain, /width:\s*214/);
  assert.match(sessionPreviewMain, /height:\s*134/);
  assert.doesNotMatch(electronMain, /SessionDragPreviewWindowManager/);
  assert.match(electronMain, /vela:session-drag-preview-start/);
  assert.match(electronMain, /vela:session-drag-preview-move/);
  assert.match(electronMain, /vela:session-drag-preview-end/);
  assert.match(electronMain, /workMonitor\.openAtPoint\(sessionId,\s*\{\s*screenX,\s*screenY\s*\}\)/);
  assert.match(electronMain, /workMonitor\.moveToPoint\(\{\s*screenX,\s*screenY\s*\}\)/);
  assert.match(electronMain, /workMonitor\.endSessionDragPreview\(\)/);
  assert.match(preload, /startSessionDragPreview/);
  assert.match(preload, /moveSessionDragPreview/);
  assert.match(preload, /endSessionDragPreview/);
  assert.match(bridge, /startSessionDragPreview/);
  assert.match(bridge, /moveSessionDragPreview/);
  assert.match(bridge, /endSessionDragPreview/);
  assert.doesNotMatch(rendererMain, /session-drag-preview|SessionDragPreviewRoot/);
  assert.match(sessionPreviewRenderer, /ConversationPreviewSurface/);
  assert.match(sessionPreviewRenderer, /SESSION_PREVIEW_SCALE = 0\.25/);
  assert.match(sessionPreviewRenderer, /scale=\{SESSION_PREVIEW_SCALE\}/);
  assert.match(sessionPreviewRenderer, /sessionPreviewTitle/);
  assert.match(sessionListSurface, /onSessionDragPreviewStart/);
  assert.doesNotMatch(sessionListSurface, /data-slot="session-drag-preview"/);
  assert.doesNotMatch(sessionListSurface, /ConversationPreviewSurface/);
  assert.doesNotMatch(desktopCss, /\.vela-session-drag-preview/);
});

test("desktop app does not auto-open the work monitor from running activity", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );

  assert.match(renderer, /startSidebarSessionDragPreview/);
  assert.match(renderer, /startSessionDragPreview\(input\.sessionId,\s*input\.point\.screenX,\s*input\.point\.screenY\)/);
  assert.match(renderer, /onSessionDragPreviewStart=\{startSidebarSessionDragPreview\}/);
  assert.doesNotMatch(renderer, /sessionPreviews=\{/);
  assert.doesNotMatch(renderer, /hasPendingRequests/);
  assert.doesNotMatch(renderer, /buildChatThumbnailModel/);
  assert.doesNotMatch(renderer, /hasWorkMonitorActivity/);
  assert.doesNotMatch(renderer, /openWorkMonitor/);
  assert.doesNotMatch(renderer, /hideWorkMonitor/);
  assert.match(renderer, /const submitChatMessage = useCallback/);
  assert.match(renderer, /onSubmit=\{submitChatMessage\}/);
  assert.match(renderer, /const respondToRequest = useCallback/);
  assert.match(renderer, /onRespondToRequest=\{respondToRequest\}/);
});

test("desktop chat topbar stays in the electron host instead of reusable ChatUI", () => {
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const desktopCss = readFileSync(
    join(root, "apps/vela-desktop-electron/src/style.css"),
    "utf8",
  );
  const chatSurface = readFileSync(
    join(root, "packages/vela-chat-web/src/surfaces/ChatSurface.tsx"),
    "utf8",
  );
  const chatStyles = readFileSync(
    join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
    "utf8",
  );

  assert.match(renderer, /function DesktopChatTopbar/);
  assert.match(renderer, /<DesktopChatTopbar/);
  assert.match(renderer, /title=\{activeSessionTitle\}/);
  assert.match(desktopCss, /\.vela-chat-topbar/);
  assert.doesNotMatch(chatSurface, /DesktopChatTopbar|vela-chat-topbar/);
  assert.doesNotMatch(chatStyles, /vela-chat-topbar/);
});

test("next web build excludes the standalone electron host from root type checking", () => {
  const tsconfig = readFileSync(join(root, "tsconfig.json"), "utf8");

  assert.match(tsconfig, /"apps\/vela-desktop-electron"/);
});

test("electron host has a real Vite dev and build pipeline instead of loading TS directly", () => {
  const packageJson = readFileSync(
    join(root, "apps/vela-desktop-electron/package.json"),
    "utf8",
  );
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );
  const devScript = readFileSync(
    join(root, "apps/vela-desktop-electron/scripts/dev.mjs"),
    "utf8",
  );

  assert.match(packageJson, /"main":\s*"dist-electron\/main\.js"/);
  assert.match(packageJson, /"dev":\s*"node scripts\/dev\.mjs"/);
  assert.match(packageJson, /"dev:web":\s*"vite --config vite\.renderer\.config\.ts --host 127\.0\.0\.1"/);
  assert.match(packageJson, /"build":\s*"vite build --config vite\.electron\.config\.ts && esbuild electron\/preload\.ts/);
  assert.match(packageJson, /--outfile=dist-electron\/preload\.cjs && vite build --config vite\.renderer\.config\.ts"/);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/vite.electron.config.ts")), true);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/vite.renderer.config.ts")), true);
  assert.equal(existsSync(join(root, "apps/vela-desktop-electron/scripts/dev.mjs")), true);
  assert.match(devScript, /createServer as createViteServer/);
  assert.match(devScript, /resolvedUrls/);
  assert.match(devScript, /strictPort:\s*false/);
  assert.match(devScript, /desktopPreviewUserDataDir/);
  assert.match(devScript, /VELA_DESKTOP_USER_DATA_DIR:\s*desktopPreviewUserDataDir/);
  assert.doesNotMatch(devScript, /spawnChild\("renderer"/);
  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(main, /preload\.ts/);
  assert.match(main, /env as nodeEnv/);
  assert.match(main, /return nodeEnv\[name\]/);
  assert.match(main, /function applyUserDataOverride/);
  assert.match(main, /app\.setPath\("userData", resolve\(userDataDir\)\)/);
  assert.match(main, /applyUserDataOverride\(\);/);
});

test("desktop preview docs prefer the managed local runtime fast-feedback loop", () => {
  const makefile = readFileSync(join(root, "Makefile"), "utf8");
  const rootReadme = readFileSync(join(root, "README.md"), "utf8");
  const electronReadme = readFileSync(
    join(root, "apps/vela-desktop-electron/README.md"),
    "utf8",
  );
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const desktopDevTarget = sourceBetween(makefile, "desktop-dev:", "desktop-dev-web:");

  assert.match(makefile, /desktop-preview:\s*desktop-preview-stop desktop-dev/);
  assert.match(makefile, /desktop-preview-fast:\s*desktop-preview/);
  assert.match(makefile, /stack-dev:\s*desktop-preview/);
  assert.match(makefile, /desktop-preview-stop:/);
  assert.match(makefile, /desktop-pids:/);
  assert.match(makefile, /\[s\]cripts\/dev\.mjs/);
  assert.doesNotMatch(desktopDevTarget, /VELA_DESKTOP_VELAD_LISTEN_ADDR/);

  assert.match(rootReadme, /make desktop-preview/);
  assert.match(rootReadme, /make desktop-preview-stop/);
  assert.match(rootReadme, /target\/debug\/velad/);
  assert.match(rootReadme, /Electron spawns that local `velad` child/);
  assert.match(rootReadme, /Renderer\/CSS changes update through Vite/);
  assert.match(rootReadme, /fallback port/);
  assert.doesNotMatch(rootReadme, /starts a local external `velad`/);

  assert.match(electronReadme, /work-monitor iteration/);
  assert.match(electronReadme, /fallback port/);
  assert.match(electronReadme, /make desktop-preview-stop/);
  assert.match(electronReadme, /Restart `make desktop-preview` after changing Electron main\/preload/);
  assert.match(electronReadme, /make desktop-pids/);

  assert.match(agents, /Fast desktop preview/);
  assert.match(agents, /fallback port/);
  assert.match(agents, /make desktop-preview-stop/);
  assert.match(agents, /Do not start a separate external `velad` for desktop preview/);
});

test("desktop web host can run as a pure browser app without Electron globals", () => {
  const bridge = readFileSync(
    join(root, "apps/vela-desktop-electron/src/desktopBridge.ts"),
    "utf8",
  );
  const renderer = readFileSync(
    join(root, "apps/vela-desktop-electron/src/DesktopApp.tsx"),
    "utf8",
  );
  const viteRendererConfig = readFileSync(
    join(root, "apps/vela-desktop-electron/vite.renderer.config.ts"),
    "utf8",
  );
  const readme = readFileSync(
    join(root, "apps/vela-desktop-electron/README.md"),
    "utf8",
  );

  assert.match(bridge, /hostKind: "web"/);
  assert.match(bridge, /browserRuntimeHostBridge/);
  assert.match(bridge, /api_base_url/);
  assert.match(bridge, /VITE_VELA_API_BASE_URL/);
  assert.match(bridge, /DEFAULT_WEB_API_BASE_URL = "\/api\/v1"/);
  assert.match(viteRendererConfig, /VITE_VELA_PROXY_TARGET/);
  assert.match(viteRendererConfig, /"\/api\/v1"/);
  assert.match(renderer, /readRuntimeBootstrap/);
  assert.match(renderer, /DEFAULT_WEB_API_BASE_URL/);
  assert.doesNotMatch(renderer, /readElectronDesktopInfo/);
  assert.match(readme, /Pure web host mode/);
  assert.match(readme, /same-origin `\/api\/v1`/);
  assert.match(readme, /dev:web/);
});
