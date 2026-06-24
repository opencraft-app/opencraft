import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createVeladClient,
  type BackendKindWire,
  type BackendWire,
  type PermissionModeWire,
  type SessionListItemWire,
} from "../../../packages/vela-chat-client/src";
import {
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "../../../packages/vela-chat-controller/src";
import type { ChatHostPolicy } from "../../../packages/vela-chat-render-model/src";
import {
  ChatSurface,
  NewSessionSurface,
  buildNewSessionTitle,
  type NewSessionOption,
  type NewSessionSubmitInput,
} from "../../../packages/vela-chat-web/src";
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
} from "./DesktopSettingsPage";
import { createRuntimeHostStateStores } from "./hostState";
import "./style.css";

const DEFAULT_WEB_API_BASE_URL = "/api/v1";
const DEFAULT_BACKEND_STORAGE_KEY = "vela-desktop:settings:default-backend";
const LAST_WORKING_DIRECTORY_STORAGE_KEY = "vela-desktop:new-session:last-working-directory";
const DESKTOP_BACKEND_PREFERENCE = ["codex", "acp", "pi"] satisfies BackendKindWire[];
const DESKTOP_SHELL_HOST_POLICY = { kind: "desktop_shell" } satisfies ChatHostPolicy;

type RuntimeHostStateStores = ReturnType<typeof createRuntimeHostStateStores>;

export function DesktopApp() {
  const hostStateStores = useMemo(() => createRuntimeHostStateStores(), []);
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
  const [sessions, setSessions] = useState<SessionListItemWire[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(
    () => hostStateStores.sessionSelectionStore?.read()?.sessionId ?? "",
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedBackendKind, setSelectedBackendKind] = useState<BackendKindWire | "">(
    readDefaultBackendPreference,
  );
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionModeWire | "">("");
  const [workingDirectory, setWorkingDirectory] = useState(readLastWorkingDirectory);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [isCreatingSession, setIsCreatingSession] = useState(false);
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
        selectedModel,
        selectedPermissionMode,
        selectedReasoningEffort,
      }),
    [
      controller.backends,
      selectedBackendKind,
      selectedModel,
      selectedPermissionMode,
      selectedReasoningEffort,
    ],
  );
  const backendOptions = useMemo(
    () => controller.backends.map(toBackendOption),
    [controller.backends],
  );
  const modelOptions = useMemo(
    () => setup.setupModelOptions.map(toModelOption),
    [setup.setupModelOptions],
  );
  const reasoningEffortOptions = useMemo(
    () => setup.setupReasoningOptions.map(toReasoningEffortOption),
    [setup.setupReasoningOptions],
  );
  const permissionModeOptions = useMemo(
    () => setup.setupPermissionOptions.map(toPermissionModeOption),
    [setup.setupPermissionOptions],
  );
  const selectedBackendForNewSession = backendOptions.some(
    (option) => option.id === setup.resolvedSelectedBackend && !option.disabled,
  )
    ? setup.resolvedSelectedBackend
    : "";
  const newSessionBackendStatusMessage = useMemo(
    () => {
      const selectedBackend = selectedBackendKind
        ? controller.backends.find((backend) => backend.kind === selectedBackendKind)
        : null;
      if (selectedBackend && selectedBackend.status !== "available") {
        return backendStatusMessage(selectedBackend);
      }
      if (selectedBackendForNewSession) return null;
      return backendStatusMessage(
        controller.backends.find((backend) => backend.status !== "available") ?? null,
      );
    },
    [controller.backends, selectedBackendForNewSession, selectedBackendKind],
  );
  const hostLabel =
    hostBridge.platform === "web"
      ? "Browser preview"
      : hostBridge.platform === "macos"
        ? "Electron on macOS"
        : `Electron on ${hostBridge.platform}`;

  const loadSessions = useCallback(async (preferredSessionId?: string) => {
    try {
      setError(null);
      const response = await client.getSessionListView({ limit: 80 });
      setSessions(response.sessions);
      setActiveSessionId((current) => {
        const candidate = preferredSessionId ?? current;
        return candidate && response.sessions.some((session) => session.id === candidate)
          ? candidate
          : "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (workingDirectory.trim()) return;
    const currentSessionDirectory =
      sessions.find((session) => session.id === activeSessionId)?.working_directory ??
      sessions[0]?.working_directory ??
      "";
    if (currentSessionDirectory) setWorkingDirectory(currentSessionDirectory);
  }, [activeSessionId, sessions, workingDirectory]);

  const buildSessionSetup = useCallback(
    (backends: BackendWire[]) =>
      buildVelaSessionSetupSelection({
        backends,
        selectedBackend: selectedBackendKind,
        preferredBackends: DESKTOP_BACKEND_PREFERENCE,
        selectedModel,
        selectedPermissionMode,
        selectedReasoningEffort,
      }),
    [selectedBackendKind, selectedModel, selectedPermissionMode, selectedReasoningEffort],
  );

  const resolveNewSessionSetup = useCallback(async () => {
    if (setup.resolvedSelectedBackend) return setup;
    const nextBackends = await client.getBackends();
    return buildSessionSetup(nextBackends.backends);
  }, [buildSessionSetup, client, setup]);

  const openNewSessionPage = useCallback(() => {
    setError(null);
    setIsSettingsOpen(false);
    setActiveSessionId("");
  }, []);

  const createSession = useCallback(async (input: NewSessionSubmitInput) => {
    try {
      setIsCreatingSession(true);
      setError(null);
      const nextSetup = await resolveNewSessionSetup();
      const backend = input.backend || nextSetup.resolvedSelectedBackend;
      if (!backend) {
        setError("No backend is available yet. Please try again after velad finishes starting.");
        return;
      }
      const created = await client.createSession({
        backend,
        agentConfig: input.agentConfig,
        title: buildNewSessionTitle(input.initialPrompt),
        workingDirectory: input.workingDirectory,
      });
      if (input.initialPrompt) {
        await client.sendUserMessage({
          sessionId: created.session.id,
          text: input.initialPrompt,
        });
      }
      setSelectedBackendKind(backend);
      writeLastWorkingDirectory(input.workingDirectory);
      setWorkingDirectory(input.workingDirectory);
      setInitialPrompt("");
      setActiveSessionId(created.session.id);
      await loadSessions(created.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreatingSession(false);
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
      onCreateSession={openNewSessionPage}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={(sessionId) => {
        setError(null);
        setIsSettingsOpen(false);
        setActiveSessionId(sessionId);
      }}
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
      sidebarPresentation="auto"
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={openNewSessionPage}
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
        <NewSessionSurface
          agentConfig={setup.setupAgentConfig}
          backendStatusMessage={newSessionBackendStatusMessage}
          backendOptions={backendOptions}
          error={error}
          initialPrompt={initialPrompt}
          isSubmitting={isCreatingSession}
          modelOptions={modelOptions}
          permissionModeOptions={permissionModeOptions}
          reasoningEffortOptions={reasoningEffortOptions}
          selectedBackend={selectedBackendForNewSession}
          selectedModel={setup.setupSelectedModel}
          selectedPermissionMode={setup.setupSelectedPermissionMode}
          selectedReasoningEffort={setup.setupSelectedReasoningEffort}
          workingDirectory={workingDirectory}
          onBackendChange={setSelectedBackendKind}
          onInitialPromptChange={setInitialPrompt}
          onModelChange={setSelectedModel}
          onPermissionModeChange={setSelectedPermissionMode}
          onReasoningEffortChange={setSelectedReasoningEffort}
          onSubmit={createSession}
          onWorkingDirectoryChange={setWorkingDirectory}
        />
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

function readLastWorkingDirectory() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(LAST_WORKING_DIRECTORY_STORAGE_KEY)?.trim() ?? "";
}

function writeLastWorkingDirectory(value: string) {
  if (typeof window === "undefined") return;
  const trimmed = value.trim();
  if (!trimmed) {
    window.localStorage.removeItem(LAST_WORKING_DIRECTORY_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(LAST_WORKING_DIRECTORY_STORAGE_KEY, trimmed);
}

function toBackendOption(backend: BackendWire): NewSessionOption<BackendKindWire> {
  const isAvailable = backend.status === "available";
  const message = backendStatusMessage(backend);
  return {
    id: backend.kind,
    label: `${backend.display_name || titleFromSnakeCase(backend.kind)}${isAvailable ? "" : ` (${backend.status})`}`,
    description: message ?? undefined,
    disabled: !isAvailable,
  };
}

function backendStatusMessage(backend: BackendWire | null) {
  if (!backend || backend.status === "available") return null;
  if (backend.status_message) return backend.status_message;
  const discoveryError = backend.diagnostics?.model_discovery_error;
  if (typeof discoveryError === "string" && discoveryError.trim()) {
    return `Backend ${backend.display_name || backend.kind} model discovery failed: ${discoveryError}`;
  }
  return `Backend ${backend.display_name || backend.kind} is ${backend.status}.`;
}

function toModelOption(model: BackendWire["models"][number]): NewSessionOption {
  return {
    id: model.id,
    label: model.label || model.id,
    description: model.description,
  };
}

function toReasoningEffortOption(
  option: BackendWire["models"][number]["reasoning_efforts"][number],
): NewSessionOption {
  return {
    id: option.id,
    label: option.label || titleFromSnakeCase(option.id),
    description: option.description,
  };
}

function toPermissionModeOption(
  option: BackendWire["permission_modes"][number],
): NewSessionOption<PermissionModeWire> {
  return {
    id: option.id,
    label: option.label || titleFromSnakeCase(option.id),
    description: option.description,
  };
}

function titleFromSnakeCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
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
