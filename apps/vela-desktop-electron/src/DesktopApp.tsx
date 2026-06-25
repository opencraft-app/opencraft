import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  ChevronDown,
  Code2,
  Columns2,
  Folder,
  ListChecks,
  MoreHorizontal,
  PanelRight,
  RectangleHorizontal,
} from "lucide-react";
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
import {
  buildSessionLocationInfo,
  ChatSurface,
  type SessionLocationInfo,
} from "../../../packages/vela-chat-web/src";
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
  selectDesktopWorkingDirectory,
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
        leadingToolbarInset: 86,
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
    useState<DesktopSettingsPanelId>("engine");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">("");
  const [hasLoadedDesktopSettings, setHasLoadedDesktopSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chromeState, setChromeState] = useState<RuntimeChromeStateResponse | undefined>(
    hostInfo.chromeState,
  );
  const optimisticCreatedSessionIdRef = useRef<string | null>(null);
  const loggedOptimisticMissingSessionIdRef = useRef<string | null>(null);

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
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const activeSessionTitle = useMemo(() => {
    const title = activeSession?.title?.trim();
    return title || "New chat";
  }, [activeSession]);
  const activeSessionLocationInfo = useMemo(
    () => buildSessionLocationInfo(activeSession?.working_directory),
    [activeSession?.working_directory],
  );
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

  const selectChatSession = useCallback((sessionId: string) => {
    setError(null);
    setActiveSessionId(sessionId);
    setIsSettingsOpen(false);
    setMainView("chat");
  }, []);

  useEffect(() => {
    return subscribeOpenDesktopSession((sessionId) => {
      selectChatSession(sessionId);
    });
  }, [selectChatSession]);

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
    const hasActiveSession = sessionList.data.sessions.some(
      (session) => session.id === activeSessionId,
    );
    if (hasActiveSession) {
      if (optimisticCreatedSessionIdRef.current === activeSessionId) {
        optimisticCreatedSessionIdRef.current = null;
        loggedOptimisticMissingSessionIdRef.current = null;
        void observability.emitLog({
          severityText: "INFO",
          body: "Created desktop session appeared in refreshed session list",
          attributes: {
            "vela.operation": "vela.desktop.session.selection_reconcile",
            "vela.session_id": activeSessionId,
            "vela.session_list.count": sessionList.data.sessions.length,
            "vela.reconcile.result": "created_session_visible",
          },
        });
      }
      return;
    }
    if (activeSessionId && optimisticCreatedSessionIdRef.current === activeSessionId) {
      if (loggedOptimisticMissingSessionIdRef.current !== activeSessionId) {
        loggedOptimisticMissingSessionIdRef.current = activeSessionId;
        void observability.emitLog({
          severityText: "INFO",
          body: "Keeping newly created desktop session selected while list refresh catches up",
          attributes: {
            "vela.operation": "vela.desktop.session.selection_reconcile",
            "vela.session_id": activeSessionId,
            "vela.session_list.count": sessionList.data.sessions.length,
            "vela.reconcile.result": "optimistic_created_session",
          },
        });
      }
      return;
    }
    if (activeSessionId) {
      setActiveSessionId("");
      setMainView("new-session");
    }
  }, [activeSessionId, observability, sessionList.data]);

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
    onSelectSession: selectChatSession,
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

  const refreshSessions = useCallback(async (options?: {
    skipMissingActiveSessionCheck?: boolean;
  }) => {
    try {
      setError(null);
      const response = await sessionList.refetch();
      if (!response.data) return;
      if (
        !options?.skipMissingActiveSessionCheck &&
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
      const trimmedInitialMessage = normalizeInitialSessionMessage(input.initialPrompt);
      const span = observability.startSpan("vela.desktop.session.create_and_select", {
        attributes: {
          "vela.backend": input.backend,
          "vela.session.has_initial_prompt": trimmedInitialMessage.length > 0,
          "vela.session.title_length": input.title.length,
        },
      });
      try {
        setIsCreatingSession(true);
        setError(null);
        const created = await client.createSession({
          backend: input.backend,
          agentConfig: input.agentConfig,
          title: input.title,
          workingDirectory: input.workingDirectory,
        });
        optimisticCreatedSessionIdRef.current = created.session.id;
        selectChatSession(created.session.id);
        span.setAttribute("vela.session_id", created.session.id);
        span.setAttribute("vela.desktop.main_view", "chat");
        if (trimmedInitialMessage) {
          if (hostInfo.hostKind === "electron") {
            void openWorkMonitor(created.session.id);
          }
          await client.sendUserMessage({
            sessionId: created.session.id,
            text: trimmedInitialMessage,
          });
        }
        await refreshSessions({ skipMissingActiveSessionCheck: true });
        selectChatSession(created.session.id);
        observability.endSpan(span, { code: SpanStatusCode.OK });
      } catch (err) {
        observability.recordError(span, err);
        observability.endSpan(span);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsCreatingSession(false);
      }
    },
    [
      client,
      hostInfo.hostKind,
      isCreatingSession,
      observability,
      refreshSessions,
      selectChatSession,
    ],
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

  const appSidebar = (
    <SessionSidebar
      currentSessionId={mainView === "chat" ? activeSessionId || null : null}
      sessions={sessions}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      canCreateSession
      onCreateSession={openNewSessionPage}
      onArchiveSession={archiveSession}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={selectChatSession}
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
          selectedBackend={selectedBackendKind}
          onBackendSettingsChange={controller.refreshBackends}
          onSelectedBackendChange={setSelectedBackendKind}
        />
      ) : mainView === "chat" && activeSessionId ? (
        <div className="vela-chat-page">
          <DesktopChatTopbar
            isSidebarVisible={isSidebarVisible}
            locationInfo={activeSessionLocationInfo}
            title={activeSessionTitle}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onToggleSidebar={() => onSidebarVisibilityChange(!isSidebarVisible)}
          />
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
            onRemoveQueuedInput={controller.removeQueuedInput}
            onRespondToRequest={respondToRequest}
            onStop={controller.stop}
            onSubmit={submitChatMessage}
            pendingAttachments={controller.pendingAttachments}
            queuedInputs={controller.queuedInputs}
            voiceInput={hostBridge.voiceInput}
          />
        </div>
      ) : (
        <DesktopNewSessionPage
          backends={controller.backends}
          defaultBackend={selectedBackendKind}
          defaultWorkingDirectory={DEFAULT_WORKING_DIRECTORY}
          error={error}
          isSubmitting={isCreatingSession}
          preferredBackends={DESKTOP_BACKEND_PREFERENCE}
          runtimeHostKind={hostInfo.hostKind}
          voiceInput={hostBridge.voiceInput}
          onDefaultBackendChange={setSelectedBackendKind}
          onSelectWorkingDirectory={selectDesktopWorkingDirectory}
          onSubmit={createSession}
        />
      )}
    </VelaDesktopShell>
  );
}

interface DesktopChatTopbarProps {
  title: string;
  locationInfo: SessionLocationInfo | null;
  isSidebarVisible: boolean;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}

function DesktopChatTopbar({
  title,
  locationInfo,
  isSidebarVisible,
  onOpenSettings,
  onToggleSidebar,
}: DesktopChatTopbarProps) {
  return (
    <header className="vela-chat-topbar" data-window-drag-region="true">
      <div className="vela-chat-topbar-title-group">
        {locationInfo ? (
          <div
            className="vela-chat-topbar-location"
            aria-label={locationInfo.ariaLabel}
            title={locationInfo.path}
          >
            <Folder size={15} strokeWidth={2.1} />
            <span>{locationInfo.label}</span>
          </div>
        ) : null}
        <div className="vela-chat-topbar-title-line">
          <h1 className="vela-chat-topbar-title">{title}</h1>
          <button
            type="button"
            className="vela-chat-topbar-icon-button vela-chat-topbar-more"
            aria-label="More chat actions"
            title="More"
          >
            <MoreHorizontal size={22} strokeWidth={2.5} />
          </button>
        </div>
      </div>
      <div className="vela-chat-topbar-actions" role="toolbar" aria-label="Chat view controls">
        <button
          type="button"
          className="vela-chat-topbar-backend-button"
          aria-label="Agent backend"
          title="Agent backend"
          onClick={onOpenSettings}
        >
          <Code2 size={22} strokeWidth={2.45} />
          <ChevronDown size={17} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          className="vela-chat-topbar-icon-button"
          aria-label="Queue"
          title="Queue"
        >
          <ListChecks size={23} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          className="vela-chat-topbar-icon-button"
          aria-label={isSidebarVisible ? "Hide sidebar" : "Show sidebar"}
          title={isSidebarVisible ? "Hide sidebar" : "Show sidebar"}
          onClick={onToggleSidebar}
        >
          <PanelRight size={23} strokeWidth={2.25} />
        </button>
        <button
          type="button"
          className="vela-chat-topbar-icon-button"
          aria-label="Compact view"
          title="Compact view"
        >
          <RectangleHorizontal size={23} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className="vela-chat-topbar-icon-button"
          aria-label="Split view"
          title="Split view"
        >
          <Columns2 size={23} strokeWidth={2.2} />
        </button>
      </div>
    </header>
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
