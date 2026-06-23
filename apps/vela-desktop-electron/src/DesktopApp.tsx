import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createVeladClient,
  type BackendKindWire,
  type BackendWire,
  type SessionListItemWire,
} from "../../../packages/vela-chat-client/src";
import {
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "../../../packages/vela-chat-controller/src";
import type { ChatHostPolicy } from "../../../packages/vela-chat-render-model/src";
import { VelaChatWeb } from "../../../packages/vela-chat-web/src";
import {
  SessionSidebar,
  VelaDesktopShell,
  type DesktopHostBridge,
} from "../../../packages/vela-desktop-shell/src";
import {
  desktopHostBridgeForInfo,
  readDesktopRuntimeBootstrap,
  retryDesktopRuntimeBootstrap,
  type DesktopHostInfo,
  type DesktopRuntimeBootstrap,
} from "./desktopBridge";
import { DesktopEmptySurface } from "./DesktopEmptySurface";
import {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
} from "./DesktopSettingsPage";
import { createDesktopHostStateStores } from "./hostState";
import "./style.css";

const DEFAULT_WORKING_DIRECTORY = "/";
const DEFAULT_WEB_API_BASE_URL = "/api/v1";
const DEFAULT_BACKEND_STORAGE_KEY = "vela-desktop:settings:default-backend";
const DESKTOP_SHELL_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;

type DesktopHostStateStores = ReturnType<typeof createDesktopHostStateStores>;

export function DesktopApp() {
  const hostStateStores = useMemo(() => createDesktopHostStateStores(), []);
  const initialShellLayout = hostStateStores.shellLayoutStore?.read();
  const initialHostInfo = useMemo<DesktopHostInfo>(
    () => ({
      apiBaseUrl: DEFAULT_WEB_API_BASE_URL,
      hostKind: window.velaDesktop ? "electron" : "web",
      platform: window.velaDesktop ? "darwin" : "browser",
    }),
    [],
  );
  const [bootstrap, setBootstrap] = useState<DesktopRuntimeBootstrap>({
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
      ? await retryDesktopRuntimeBootstrap()
      : await readDesktopRuntimeBootstrap();
    if (nextBootstrap.status === "ready") setFallbackHostInfo(nextBootstrap.info);
    setBootstrap(nextBootstrap);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setBootstrap({
      status: "starting",
      message: window.velaDesktop ? "Starting local runtime..." : "Connecting to runtime...",
    });
    void readDesktopRuntimeBootstrap().then((nextBootstrap) => {
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
      <DesktopReadyApp
        hostInfo={bootstrap.info}
        hostStateStores={hostStateStores}
        isSidebarVisible={isSidebarVisible}
        sidebarWidthPx={sidebarWidthPx}
        onSidebarVisibilityChange={setIsSidebarVisible}
        onSidebarWidthChange={setSidebarWidthPx}
      />
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
  hostInfo: DesktopHostInfo;
  hostStateStores: DesktopHostStateStores;
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
  const [sessions, setSessions] = useState<SessionListItemWire[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(
    () => hostStateStores.sessionSelectionStore?.read()?.sessionId ?? "",
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">(
    readDefaultBackendPreference,
  );
  const [error, setError] = useState<string | null>(null);

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
  const hostBridge = useMemo(() => desktopHostBridgeForInfo(hostInfo), [hostInfo]);
  const client = useMemo(() => createVeladClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
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
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [controller.backends, selectedBackendKind],
  );
  const hostLabel =
    hostBridge.platform === "browser"
      ? "Browser preview"
      : hostBridge.platform === "macos"
        ? "Electron on macOS"
        : `Electron on ${hostBridge.platform}`;

  const loadSessions = useCallback(async () => {
    try {
      setError(null);
      const response = await client.getSessionListView({ limit: 80 });
      setSessions(response.sessions);
      setActiveSessionId((current) => current || response.sessions[0]?.id || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const buildSessionSetup = useCallback(
    (backends: BackendWire[]) =>
      buildVelaSessionSetupSelection({
        backends,
        selectedBackend: selectedBackendKind,
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
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, loadSessions, resolveNewSessionSetup]);

  const appSidebar = (
    <SessionSidebar
      currentSessionId={activeSessionId || null}
      sessions={sessions}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      accountLabel={hostLabel}
      accountPlanLabel="Local desktop"
      canCreateSession
      onCreateSession={createSession}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={setActiveSessionId}
    />
  );
  const settingsSidebar = (
    <DesktopSettingsSidebar
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      onClose={() => setIsSettingsOpen(false)}
    />
  );

  return (
    <VelaDesktopShell
      host={hostBridge}
      isSidebarVisible={isSidebarVisible}
      sidebar={isSettingsOpen ? settingsSidebar : appSidebar}
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={createSession}
      onSidebarVisibilityChange={onSidebarVisibilityChange}
      onSidebarWidthChange={onSidebarWidthChange}
      onToggleSidebar={() => onSidebarVisibilityChange(!isSidebarVisible)}
    >
      {isSettingsOpen ? (
        <DesktopSettingsPage
          apiBaseUrl={apiBaseUrl}
          backends={controller.backends}
          hostLabel={hostLabel}
          logPath={hostInfo.logPath}
          selectedBackend={selectedBackendKind}
          sessionsCount={sessions.length}
          onSelectedBackendChange={setSelectedBackendKind}
        />
      ) : activeSessionId ? (
        <VelaChatWeb
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
  bootstrap: Exclude<DesktopRuntimeBootstrap, { status: "ready" }>;
  hostInfo: DesktopHostInfo;
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
  const hostBridge = useMemo(() => desktopHostBridgeForInfo(hostInfo), [hostInfo]);
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
  bootstrap: Exclude<DesktopRuntimeBootstrap, { status: "ready" }>;
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
