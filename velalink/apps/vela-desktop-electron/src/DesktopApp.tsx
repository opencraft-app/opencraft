import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createVeladClient,
  type BackendKindWire,
  type BackendWire,
} from "../../../packages/vela-chat-client/src";
import {
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "../../../packages/vela-chat-controller/src";
import {
  VelaQueryProvider,
  useArchiveSessionMutation,
  useSessionListViewQuery,
} from "../../../packages/vela-chat-query/src";
import type { ChatHostPolicy } from "../../../packages/vela-chat-render-model/src";
import { ChatSurface } from "../../../packages/vela-chat-web/src";
import {
  SessionSidebar,
  VelaDesktopShell,
  type RuntimeHostBridge,
} from "../../../packages/vela-desktop-shell/src";
import {
  runtimeHostBridgeForInfo,
  readRuntimeBootstrap,
  readRuntimeChromeState,
  retryRuntimeBootstrap,
  subscribeRuntimeChromeState,
  type RuntimeChromeStateResponse,
  type RuntimeHostInfo,
  type RuntimeBootstrap,
} from "./desktopBridge";
import { DesktopEmptySurface } from "./DesktopEmptySurface";
import {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
  type DesktopSettingsPanelId,
} from "./DesktopSettingsPage";
import { createRuntimeHostStateStores } from "./hostState";
import "./style.css";

const DEFAULT_WORKING_DIRECTORY = "/";
const DEFAULT_WEB_API_BASE_URL = "/api/v1";
const DEFAULT_BACKEND_STORAGE_KEY = "vela-desktop:settings:default-backend";
const DESKTOP_APP_VERSION = "0.0.1";
const DESKTOP_BACKEND_PREFERENCE = ["codex", "acp", "pi"] satisfies BackendKindWire[];
const DESKTOP_SHELL_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;
const DESKTOP_SESSION_LIST_OPTIONS = { limit: 80 };

type RuntimeHostStateStores = ReturnType<typeof createRuntimeHostStateStores>;

export function DesktopApp() {
  const hostStateStores = useMemo(() => createRuntimeHostStateStores(), []);
  const [settingsPanel, setSettingsPanel] =
    useState<DesktopSettingsPanelId>("general");
  const initialShellLayout = hostStateStores.shellLayoutStore?.read();
  const initialHostInfo = useMemo<RuntimeHostInfo>(
    () => ({
      apiBaseUrl: DEFAULT_WEB_API_BASE_URL,
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
  const [activeSessionId, setActiveSessionId] = useState(
    () => hostStateStores.sessionSelectionStore?.read()?.sessionId ?? "",
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">(
    readDefaultBackendPreference,
  );
  const [error, setError] = useState<string | null>(null);
  const [chromeState, setChromeState] = useState<RuntimeChromeStateResponse | undefined>(
    hostInfo.chromeState,
  );

  useEffect(() => {
    writeDefaultBackendPreference(selectedBackendKind);
  }, [selectedBackendKind]);

  useEffect(() => {
    if (!activeSessionId) return;
    hostStateStores.sessionSelectionStore?.write({
      sessionId: activeSessionId,
      updatedAt: Date.now(),
    });
  }, [activeSessionId, hostStateStores.sessionSelectionStore]);

  const apiBaseUrl = hostInfo.apiBaseUrl;
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
  const client = useMemo(() => createVeladClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const sessionList = useSessionListViewQuery({
    client,
    options: DESKTOP_SESSION_LIST_OPTIONS,
  });
  const sessions = sessionList.data?.sessions ?? [];
  const controller = useVelaChatSession({
    client,
    baseUrl: apiBaseUrl,
    clientStateStore: hostStateStores.clientStateStore,
    hostPolicy: DESKTOP_SHELL_HOST_POLICY,
    sessionId: activeSessionId,
  });
  const setup = useMemo(
    () =>
      buildVelaSessionSetupSelection({
        backends: controller.backends,
        selectedBackend: selectedBackendKind,
        preferredBackends: DESKTOP_BACKEND_PREFERENCE,
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [controller.backends, selectedBackendKind],
  );
  const hostLabel =
    hostBridge.platform === "web"
      ? "Browser preview"
      : hostBridge.platform === "macos"
        ? "Electron on macOS"
        : `Electron on ${hostBridge.platform}`;

  useEffect(() => {
    if (!sessionList.data) return;
    setError(null);
    setActiveSessionId((current) =>
      current && sessionList.data.sessions.some((session) => session.id === current)
        ? current
        : sessionList.data.sessions[0]?.id || "",
    );
  }, [sessionList.data]);

  useEffect(() => {
    if (!sessionList.error) return;
    setError(sessionList.error instanceof Error ? sessionList.error.message : String(sessionList.error));
  }, [sessionList.error]);

  const archiveSessionMutation = useArchiveSessionMutation({
    client,
    currentSessionId: activeSessionId || null,
    sessionListOptions: DESKTOP_SESSION_LIST_OPTIONS,
    onSelectSession: setActiveSessionId,
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
      setActiveSessionId((current) =>
        current && response.data.sessions.some((session) => session.id === current)
          ? current
          : response.data.sessions[0]?.id || "",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionList]);

  const buildSessionSetup = useCallback(
    (backends: BackendWire[]) =>
      buildVelaSessionSetupSelection({
        backends,
        selectedBackend: selectedBackendKind,
        preferredBackends: DESKTOP_BACKEND_PREFERENCE,
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [selectedBackendKind],
  );

  const resolveNewSessionSetup = useCallback(async () => {
    if (setup.resolvedSelectedBackend) return setup;
    const nextBackends = await client.getBackends();
    return buildSessionSetup(nextBackends.backends);
  }, [buildSessionSetup, client, setup]);

  const createSession = useCallback(async () => {
    try {
      setError(null);
      const nextSetup = await resolveNewSessionSetup();
      const backend = nextSetup.resolvedSelectedBackend;
      if (!backend) {
        setError("No backend is available yet. Please try again after velad finishes starting.");
        return;
      }
      const created = await client.createSession({
        backend,
        agentConfig: nextSetup.setupAgentConfig,
        title: "New chat",
        workingDirectory: DEFAULT_WORKING_DIRECTORY,
      });
      setActiveSessionId(created.session.id);
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, refreshSessions, resolveNewSessionSetup]);

  const appSidebar = (
    <SessionSidebar
      currentSessionId={activeSessionId || null}
      sessions={sessions}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      accountLabel={hostLabel}
      accountPlanLabel="Local desktop"
      canCreateSession
      onCreateSession={createSession}
      onArchiveSession={archiveSession}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={setActiveSessionId}
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
      onCreateSession={createSession}
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
          hostLabel={hostLabel}
          logPath={hostInfo.logPath}
          selectedBackend={selectedBackendKind}
          sessionsCount={sessions.length}
          onSelectedBackendChange={setSelectedBackendKind}
        />
      ) : activeSessionId ? (
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
          onRespondToRequest={controller.respondToRequest}
          onStop={controller.stop}
          onSubmit={controller.send}
          pendingAttachments={controller.pendingAttachments}
        />
      ) : (
        <DesktopEmptySurface error={error} />
      )}
    </VelaDesktopShell>
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
  const hostLabel = hostBridge.platform === "macos" ? "Electron on macOS" : "Runtime host";
  const sidebar = (
    <SessionSidebar
      currentSessionId={null}
      sessions={[]}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      accountLabel={hostLabel}
      accountPlanLabel="Local desktop"
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
        <DesktopEmptySurface />
      )}
    </VelaDesktopShell>
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

function readDefaultBackendPreference(): BackendKindWire | "" {
  if (typeof window === "undefined") return "";
  const value = window.localStorage.getItem(DEFAULT_BACKEND_STORAGE_KEY);
  return isBackendKind(value) ? value : "";
}

function writeDefaultBackendPreference(value: BackendKindWire | "") {
  if (typeof window === "undefined") return;
  if (!value) {
    window.localStorage.removeItem(DEFAULT_BACKEND_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(DEFAULT_BACKEND_STORAGE_KEY, value);
}

function isBackendKind(value: string | null): value is BackendKindWire {
  return (
    value === "codex" ||
    value === "cloudagent" ||
    value === "claude_code" ||
    value === "pi" ||
    value === "opencode" ||
    value === "acp" ||
    value === "qoder"
  );
}
