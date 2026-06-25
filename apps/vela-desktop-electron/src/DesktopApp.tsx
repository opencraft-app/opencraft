import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createFetchVelaEventStreamTransport,
  createVeladClient,
  resolveVeladFetch,
  type BackendKindWire,
} from "../../../packages/vela-chat-client/src";
import { useVelaChatSession } from "../../../packages/vela-chat-controller/src";
import {
  VelaQueryProvider,
  useArchiveSessionMutation,
  useSessionListViewQuery,
} from "../../../packages/vela-chat-query/src";
import {
  type ChatRenderModel,
  type ChatHostPolicy,
} from "../../../packages/vela-chat-render-model/src";
import { ChatSurface } from "../../../packages/vela-chat-web/src";
import {
  SessionSidebar,
  VelaDesktopShell,
  type RuntimeHostBridge,
} from "../../../packages/vela-desktop-shell/src";
import { VelaLocalTracer } from "../../../packages/vela-observability-client/src";
import {
  hideWorkMonitor,
  openWorkMonitor,
  runtimeHostBridgeForInfo,
  readDesktopSettings,
  readRuntimeBootstrap,
  readRuntimeChromeState,
  retryRuntimeBootstrap,
  saveDesktopSettings,
  subscribeOpenDesktopSession,
  subscribeRuntimeChromeState,
  type RuntimeChromeStateResponse,
  type RuntimeHostInfo,
  type RuntimeBootstrap,
} from "./desktopBridge";
import {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
  type DesktopSettingsPanelId,
} from "./DesktopSettingsPage";
import { createRuntimeHostStateStores } from "./hostState";
import {
  DesktopNewSessionPage,
  type DesktopNewSessionSubmitInput,
} from "./new-session";
import { normalizeInitialSessionMessage } from "./sessionCreation";
import "./style.css";

const DEFAULT_WORKING_DIRECTORY = "/";
const DEFAULT_WEB_API_BASE_URL = "/api/v1";
const DESKTOP_APP_VERSION = "0.0.1";
const DESKTOP_BACKEND_PREFERENCE = [
  "vela_engine",
  "codex",
  "acp",
  "pi",
] satisfies BackendKindWire[];
const DESKTOP_SHELL_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;
const DESKTOP_SESSION_LIST_OPTIONS = { limit: 80 };

type RuntimeHostStateStores = ReturnType<typeof createRuntimeHostStateStores>;
type DesktopMainView = "new-session" | "chat";

export function DesktopApp() {
  const hostStateStores = useMemo(() => createRuntimeHostStateStores(), []);
  const initialShellLayout = hostStateStores.shellLayoutStore?.read();
  const initialHostInfo = useMemo<RuntimeHostInfo>(
    () => ({
      apiBaseUrl: DEFAULT_WEB_API_BASE_URL,
      otelBaseUrl: undefined,
      chromeState: {
        platform: "darwin",
        isFullscreen: false,
        isMaximized: false,
        reserveTrafficLightGutter: true,
        toolbarCenterY: 28,
        toolbarIconSize: 24,
        leadingToolbarInset: 84,
        toolbarSize: 28,
      },
      hostKind: window.velaDesktop ? "electron" : "web",
      platform: window.velaDesktop ? "darwin" : "web",
    }),
    [],
  );
  const [bootstrap, setBootstrap] = useState<RuntimeBootstrap>({
    status: "starting",
    message: window.velaDesktop ? "Starting local runtime..." : "Connecting to runtime...",
  });
  const [fallbackHostInfo, setFallbackHostInfo] = useState(initialHostInfo);
  const [isSidebarVisible, setIsSidebarVisible] = useState(
    initialShellLayout?.isSidebarVisible ?? true,
  );
  const [sidebarWidthPx, setSidebarWidthPx] = useState(
    initialShellLayout?.sidebarWidthPx ?? 300,
  );

  const loadRuntimeBootstrap = useCallback(async (retry = false) => {
    setBootstrap({
      status: "starting",
      message: window.velaDesktop ? "Starting local runtime..." : "Connecting to runtime...",
    });
    const nextBootstrap = retry
      ? await retryRuntimeBootstrap()
      : await readRuntimeBootstrap();
    if (nextBootstrap.status === "ready") setFallbackHostInfo(nextBootstrap.info);
    setBootstrap(nextBootstrap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBootstrap({
      status: "starting",
      message: window.velaDesktop ? "Starting local runtime..." : "Connecting to runtime...",
    });
    void readRuntimeBootstrap().then((nextBootstrap) => {
      if (cancelled) return;
      if (nextBootstrap.status === "ready") setFallbackHostInfo(nextBootstrap.info);
      setBootstrap(nextBootstrap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    hostStateStores.shellLayoutStore?.write({
      isSidebarVisible,
      sidebarWidthPx,
      updatedAt: Date.now(),
    });
  }, [hostStateStores.shellLayoutStore, isSidebarVisible, sidebarWidthPx]);

  if (bootstrap.status === "ready") {
    return (
      <VelaQueryProvider>
        <DesktopReadyApp
          hostInfo={bootstrap.info}
          hostStateStores={hostStateStores}
          isSidebarVisible={isSidebarVisible}
          sidebarWidthPx={sidebarWidthPx}
          onSidebarVisibilityChange={setIsSidebarVisible}
          onSidebarWidthChange={setSidebarWidthPx}
        />
      </VelaQueryProvider>
    );
  }

  return (
    <DesktopBootstrapApp
      bootstrap={bootstrap}
      hostInfo={fallbackHostInfo}
      isSidebarVisible={isSidebarVisible}
      sidebarWidthPx={sidebarWidthPx}
      onRetry={() => loadRuntimeBootstrap(true)}
      onSidebarVisibilityChange={setIsSidebarVisible}
      onSidebarWidthChange={setSidebarWidthPx}
    />
  );
}

interface DesktopReadyAppProps {
  hostInfo: RuntimeHostInfo;
  hostStateStores: RuntimeHostStateStores;
  isSidebarVisible: boolean;
  sidebarWidthPx: number;
  onSidebarVisibilityChange: (isVisible: boolean) => void;
  onSidebarWidthChange: (widthPx: number) => void;
}

function DesktopReadyApp({
  hostInfo,
  hostStateStores,
  isSidebarVisible,
  sidebarWidthPx,
  onSidebarVisibilityChange,
  onSidebarWidthChange,
}: DesktopReadyAppProps) {
  const [activeSessionId, setActiveSessionId] = useState("");
  const [mainView, setMainView] = useState<DesktopMainView>("new-session");
  const [settingsPanel, setSettingsPanel] =
    useState<DesktopSettingsPanelId>("general");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">("");
  const [hasLoadedDesktopSettings, setHasLoadedDesktopSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chromeState, setChromeState] = useState<RuntimeChromeStateResponse | undefined>(
    hostInfo.chromeState,
  );

  useEffect(() => {
    let cancelled = false;
    void readDesktopSettings()
      .then((settings) => {
        if (cancelled) return;
        setSelectedBackendKind(settings.defaultBackend);
      })
      .catch((err) => {
        console.warn("Failed to load desktop settings", err);
      })
      .finally(() => {
        if (!cancelled) setHasLoadedDesktopSettings(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedDesktopSettings) return;
    void saveDesktopSettings({ defaultBackend: selectedBackendKind }).catch((err) => {
      console.warn("Failed to save desktop settings", err);
    });
  }, [hasLoadedDesktopSettings, selectedBackendKind]);

  useEffect(() => {
    if (!activeSessionId) return;
    hostStateStores.sessionSelectionStore?.write({
      sessionId: activeSessionId,
      updatedAt: Date.now(),
    });
  }, [activeSessionId, hostStateStores.sessionSelectionStore]);

  const apiBaseUrl = hostInfo.apiBaseUrl;
  const observability = useMemo(
    () =>
      new VelaLocalTracer({
        endpoint: hostInfo.otelBaseUrl,
        serviceName: hostInfo.hostKind === "electron" ? "vela-desktop-renderer" : "vela-web",
        tracerName: "vela.chat.client",
      }),
    [hostInfo.hostKind, hostInfo.otelBaseUrl],
  );
  useEffect(() => {
    let cancelled = false;
    void readRuntimeChromeState(hostInfo.chromeState).then((nextChromeState) => {
      if (!cancelled) setChromeState(nextChromeState);
    });
    const unsubscribe = subscribeRuntimeChromeState(setChromeState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [hostInfo.chromeState]);

  const hostBridge = useMemo(
    () => runtimeHostBridgeForInfo(hostInfo, chromeState),
    [chromeState, hostInfo],
  );
  const veladFetch = useMemo(() => resolveVeladFetch(), []);
  const client = useMemo(
    () => createVeladClient({ baseUrl: apiBaseUrl, fetch: veladFetch, observability }),
    [apiBaseUrl, observability, veladFetch],
  );
  const eventStreamTransport = useMemo(
    () => createFetchVelaEventStreamTransport(veladFetch, { observability }),
    [observability, veladFetch],
  );
  const sessionList = useSessionListViewQuery({
    client,
    options: DESKTOP_SESSION_LIST_OPTIONS,
  });
  const sessions = sessionList.data?.sessions ?? [];
  const controller = useVelaChatSession({
    client,
    baseUrl: apiBaseUrl,
    clientStateStore: hostStateStores.clientStateStore,
    eventStreamTransport,
    hostPolicy: DESKTOP_SHELL_HOST_POLICY,
    sessionId: activeSessionId,
  });
  const hostLabel =
    hostBridge.platform === "web"
      ? "Browser preview"
      : hostBridge.platform === "macos"
        ? "Electron on macOS"
        : `Electron on ${hostBridge.platform}`;
  const shouldShowWorkMonitor =
    hostInfo.hostKind === "electron" &&
    mainView === "chat" &&
    Boolean(activeSessionId) &&
    hasWorkMonitorActivity(controller.model);
  const sidebarSessionPreviews = useMemo<
    Record<string, ChatRenderModel | undefined>
  >(() => {
    if (!activeSessionId || !hasWorkMonitorActivity(controller.model)) {
      return {};
    }
    return { [activeSessionId]: controller.model };
  }, [activeSessionId, controller.model]);

  useEffect(() => {
    return subscribeOpenDesktopSession((sessionId) => {
      setError(null);
      setActiveSessionId(sessionId);
      setIsSettingsOpen(false);
      setMainView("chat");
    });
  }, []);

  useEffect(() => {
    if (hostInfo.hostKind !== "electron") return;
    if (shouldShowWorkMonitor && activeSessionId) {
      void openWorkMonitor(activeSessionId);
      return;
    }
    const hideDelayMs = activeSessionId ? 4_000 : 0;
    const hideTimer = window.setTimeout(() => {
      void hideWorkMonitor();
    }, hideDelayMs);
    return () => {
      window.clearTimeout(hideTimer);
    };
  }, [activeSessionId, hostInfo.hostKind, shouldShowWorkMonitor]);

  useEffect(() => {
    if (!sessionList.data) return;
    setError(null);
    if (
      activeSessionId &&
      !sessionList.data.sessions.some((session) => session.id === activeSessionId)
    ) {
      setActiveSessionId("");
      setMainView("new-session");
    }
  }, [activeSessionId, sessionList.data]);

  useEffect(() => {
    if (!sessionList.error) return;
    setError(
      sessionList.error instanceof Error
        ? sessionList.error.message
        : String(sessionList.error),
    );
  }, [sessionList.error]);

  const archiveSessionMutation = useArchiveSessionMutation({
    client,
    currentSessionId: activeSessionId || null,
    sessionListOptions: DESKTOP_SESSION_LIST_OPTIONS,
    onSelectSession: (sessionId) => {
      setActiveSessionId(sessionId);
      setMainView("chat");
    },
  });

  const archiveSession = useCallback(
    async (sessionId: string) => {
      try {
        setError(null);
        await archiveSessionMutation.mutateAsync({ sessionId });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [archiveSessionMutation],
  );

  const refreshSessions = useCallback(async () => {
    try {
      setError(null);
      const response = await sessionList.refetch();
      if (!response.data) return;
      if (
        activeSessionId &&
        !response.data.sessions.some((session) => session.id === activeSessionId)
      ) {
        setActiveSessionId("");
        setMainView("new-session");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, sessionList]);

  const createSession = useCallback(
    async (input: DesktopNewSessionSubmitInput) => {
      if (isCreatingSession) return;
      try {
        setIsCreatingSession(true);
        setError(null);
        const created = await client.createSession({
          backend: input.backend,
          agentConfig: input.agentConfig,
          title: input.title,
          workingDirectory: input.workingDirectory,
        });
        setActiveSessionId(created.session.id);
        setMainView("chat");
        const trimmedInitialMessage = normalizeInitialSessionMessage(input.initialPrompt);
        if (trimmedInitialMessage) {
          if (hostInfo.hostKind === "electron") {
            void openWorkMonitor(created.session.id);
          }
          await client.sendUserMessage({
            sessionId: created.session.id,
            text: trimmedInitialMessage,
          });
        }
        await refreshSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsCreatingSession(false);
      }
    },
    [client, hostInfo.hostKind, isCreatingSession, refreshSessions],
  );

  const submitChatMessage = useCallback(async () => {
    const hasMessageIntent =
      controller.draft.trim().length > 0 || controller.pendingAttachments.length > 0;
    if (hostInfo.hostKind === "electron" && activeSessionId && hasMessageIntent) {
      void openWorkMonitor(activeSessionId);
    }
    await controller.send();
  }, [
    activeSessionId,
    controller.draft,
    controller.pendingAttachments.length,
    controller.send,
    hostInfo.hostKind,
  ]);

  const respondToRequest = useCallback(
    async (response: Parameters<typeof controller.respondToRequest>[0]) => {
      if (hostInfo.hostKind === "electron" && activeSessionId) {
        void openWorkMonitor(activeSessionId);
      }
      await controller.respondToRequest(response);
    },
    [activeSessionId, controller.respondToRequest, hostInfo.hostKind],
  );

  const openNewSessionPage = useCallback(() => {
    setError(null);
    setActiveSessionId("");
    setIsSettingsOpen(false);
    setMainView("new-session");
  }, []);

  const selectSession = useCallback((sessionId: string) => {
    setError(null);
    setActiveSessionId(sessionId);
    setIsSettingsOpen(false);
    setMainView("chat");
  }, []);

  const appSidebar = (
    <SessionSidebar
      currentSessionId={mainView === "chat" ? activeSessionId || null : null}
      sessionPreviews={sidebarSessionPreviews}
      sessions={sessions}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      canCreateSession
      onCreateSession={openNewSessionPage}
      onArchiveSession={archiveSession}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={selectSession}
    />
  );
  const settingsSidebar = (
    <DesktopSettingsSidebar
      activePanel={settingsPanel}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      onClose={() => setIsSettingsOpen(false)}
      onPanelChange={setSettingsPanel}
    />
  );

  return (
    <VelaDesktopShell
      host={hostBridge}
      isSidebarVisible={isSidebarVisible}
      sidebar={isSettingsOpen ? settingsSidebar : appSidebar}
      sidebarPresentation="auto"
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={openNewSessionPage}
      onSidebarVisibilityChange={onSidebarVisibilityChange}
      onSidebarWidthChange={onSidebarWidthChange}
      onToggleSidebar={() => onSidebarVisibilityChange(!isSidebarVisible)}
    >
      {isSettingsOpen ? (
        <DesktopSettingsPage
          activePanel={settingsPanel}
          apiBaseUrl={apiBaseUrl}
          appVersion={DESKTOP_APP_VERSION}
          backends={controller.backends}
          client={client}
          hostLabel={hostLabel}
          logPath={hostInfo.logPath}
          selectedBackend={selectedBackendKind}
          sessionsCount={sessions.length}
          onBackendSettingsChange={controller.refreshBackends}
          onSelectedBackendChange={setSelectedBackendKind}
        />
      ) : mainView === "chat" && activeSessionId ? (
        <ChatSurface
          canLoadOlder={controller.canLoadOlder}
          clientStateStore={hostStateStores.clientStateStore}
          composerControls={controller.composerControls}
          draft={controller.draft}
          error={controller.error ?? error}
          historyPhase={controller.historyPhase}
          isLoadingOlder={controller.isLoadingOlder}
          isRespondingToRequest={controller.isRespondingToRequest}
          isUpdatingComposerControls={controller.isUpdatingAgentConfig}
          messageFollowToken={controller.messageFollowToken}
          model={controller.model}
          onAgentConfigChange={controller.updateAgentConfig}
          onAttachImages={controller.attachImages}
          onConversationScrollDebugChange={controller.setConversationScrollDebug}
          onDraftChange={controller.setDraft}
          onLoadOlder={controller.loadOlderConversation}
          onRemoveAttachment={controller.removeAttachment}
          onRespondToRequest={respondToRequest}
          onStop={controller.stop}
          onSubmit={submitChatMessage}
          pendingAttachments={controller.pendingAttachments}
          voiceInput={hostBridge.voiceInput}
        />
      ) : (
        <DesktopNewSessionPage
          backends={controller.backends}
          defaultBackend={selectedBackendKind}
          defaultWorkingDirectory={DEFAULT_WORKING_DIRECTORY}
          error={error}
          isSubmitting={isCreatingSession}
          preferredBackends={DESKTOP_BACKEND_PREFERENCE}
          voiceInput={hostBridge.voiceInput}
          onDefaultBackendChange={setSelectedBackendKind}
          onSubmit={createSession}
        />
      )}
    </VelaDesktopShell>
  );
}

function hasWorkMonitorActivity(model: ChatRenderModel) {
  return (
    model.composer.is_running ||
    model.requests.items.some((request) => request.status === "pending") ||
    model.rows.some((row) => {
      if (row.kind === "assistant_message") return row.streaming;
      if (row.kind === "agent_work") return row.status === "running" || row.status === "pending";
      if (row.kind === "agent_work_group") {
        return row.children.some(
          (child) => child.status === "running" || child.status === "pending",
        );
      }
      if (row.kind === "turn_meta") return row.status === "running";
      if (row.kind === "status") return row.status === "pending" || row.status === "streaming";
      return false;
    })
  );
}

interface DesktopBootstrapAppProps {
  bootstrap: Exclude<RuntimeBootstrap, { status: "ready" }>;
  hostInfo: RuntimeHostInfo;
  isSidebarVisible: boolean;
  sidebarWidthPx: number;
  onRetry: () => void;
  onSidebarVisibilityChange: (isVisible: boolean) => void;
  onSidebarWidthChange: (widthPx: number) => void;
}

function DesktopBootstrapApp({
  bootstrap,
  hostInfo,
  isSidebarVisible,
  sidebarWidthPx,
  onRetry,
  onSidebarVisibilityChange,
  onSidebarWidthChange,
}: DesktopBootstrapAppProps) {
  const hostBridge = useMemo(() => runtimeHostBridgeForInfo(hostInfo), [hostInfo]);
  const sidebar = (
    <SessionSidebar
      currentSessionId={null}
      sessions={[]}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      canClearSessions={false}
      canCreateSession={false}
      onCreateSession={() => undefined}
      onOpenSettings={() => undefined}
      onSelectSession={() => undefined}
    />
  );

  return (
    <VelaDesktopShell
      host={hostBridge}
      isSidebarVisible={isSidebarVisible}
      sidebar={sidebar}
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={() => undefined}
      onSidebarVisibilityChange={onSidebarVisibilityChange}
      onSidebarWidthChange={onSidebarWidthChange}
      onToggleSidebar={() => onSidebarVisibilityChange(!isSidebarVisible)}
    >
      {bootstrap.status === "failed" ? (
        <DesktopBootstrapSurface bootstrap={bootstrap} onRetry={onRetry} />
      ) : (
        <DesktopRuntimeStartingSurface bootstrap={bootstrap} />
      )}
    </VelaDesktopShell>
  );
}

function DesktopRuntimeStartingSurface({
  bootstrap,
}: {
  bootstrap: Extract<RuntimeBootstrap, { status: "starting" }>;
}) {
  return (
    <div className="vela-runtime-bootstrap" role="status" aria-live="polite">
      <div className="vela-runtime-bootstrap-card">
        <div className="vela-runtime-bootstrap-orb" data-state="starting" />
        <div>
          <h1>Starting local runtime</h1>
          <p>{bootstrap.message}</p>
        </div>
      </div>
    </div>
  );
}

function DesktopBootstrapSurface({
  bootstrap,
  onRetry,
}: {
  bootstrap: Exclude<RuntimeBootstrap, { status: "ready" }>;
  onRetry: () => void;
}) {
  return (
    <div className="vela-runtime-bootstrap" role="alert">
      <div className="vela-runtime-bootstrap-card">
        <div className="vela-runtime-bootstrap-orb" data-state="failed" />
        <div>
          <h1>Runtime could not start</h1>
          <p>{bootstrap.error}</p>
          {bootstrap.logPath ? (
            <p className="vela-runtime-bootstrap-log">Log: {bootstrap.logPath}</p>
          ) : null}
        </div>
        <button className="vela-runtime-bootstrap-retry" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
