import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createVeladClient,
  type BackendKindWire,
  type SessionListItemWire,
} from "../../../packages/vela-chat-client/src";
import {
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "../../../packages/vela-chat-controller/src";
import { VelaChatWeb } from "../../../packages/vela-chat-web/src";
import {
  SessionSidebar,
  VelaDesktopShell,
  type DesktopHostBridge,
} from "../../../packages/vela-desktop-shell/src";
import { desktopHostBridgeForInfo, readDesktopHostInfo } from "./desktopBridge";
import { DesktopEmptySurface } from "./DesktopEmptySurface";
import { DesktopSettingsOverlay } from "./DesktopSettingsOverlay";
import { createDesktopHostStateStores } from "./hostState";
import "./style.css";

const DEFAULT_WORKING_DIRECTORY = "/";
const DEFAULT_WEB_API_BASE_URL = "/api/v1";

export function DesktopApp() {
  const hostStateStores = useMemo(() => createDesktopHostStateStores(), []);
  const initialShellLayout = hostStateStores.shellLayoutStore?.read();
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_WEB_API_BASE_URL);
  const [hostBridge, setHostBridge] = useState<DesktopHostBridge>(() =>
    desktopHostBridgeForInfo({
      apiBaseUrl: DEFAULT_WEB_API_BASE_URL,
      hostKind: "web",
      platform: "browser",
    }),
  );
  const [isHostReady, setIsHostReady] = useState(() => !window.velaDesktop);
  const [sessions, setSessions] = useState<SessionListItemWire[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [isSidebarVisible, setIsSidebarVisible] = useState(
    initialShellLayout?.isSidebarVisible ?? true,
  );
  const [sidebarWidthPx, setSidebarWidthPx] = useState(
    initialShellLayout?.sidebarWidthPx ?? 300,
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readDesktopHostInfo().then((info) => {
      if (cancelled) return;
      setApiBaseUrl(info.apiBaseUrl);
      setHostBridge(desktopHostBridgeForInfo(info));
      setIsHostReady(true);
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

  const client = useMemo(() => createVeladClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const controller = useVelaChatSession({
    client,
    baseUrl: apiBaseUrl,
    clientStateStore: hostStateStores.clientStateStore,
    sessionId: activeSessionId,
  });
  const setup = useMemo(
    () =>
      buildVelaSessionSetupSelection({
        backends: controller.backends,
        selectedBackend: (controller.backends[0]?.kind ?? "") as BackendKindWire | "",
        selectedModel: "",
        selectedPermissionMode: "",
        selectedReasoningEffort: "",
      }),
    [controller.backends],
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
    if (!isHostReady) return;
    void loadSessions();
  }, [isHostReady, loadSessions]);

  const createSession = useCallback(async () => {
    const backend = setup.resolvedSelectedBackend;
    if (!backend) return;
    try {
      setError(null);
      const created = await client.createSession({
        backend,
        agentConfig: setup.setupAgentConfig,
        title: "New chat",
        workingDirectory: DEFAULT_WORKING_DIRECTORY,
      });
      setActiveSessionId(created.session.id);
      await loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, loadSessions, setup.resolvedSelectedBackend, setup.setupAgentConfig]);

  const sidebar = (
    <SessionSidebar
      currentSessionId={activeSessionId || null}
      sessions={sessions}
      showTrafficLights={hostBridge.chrome.showTrafficLights}
      accountLabel={hostLabel}
      accountPlanLabel="Local desktop"
      onCreateSession={createSession}
      onOpenSettings={() => setIsSettingsOpen(true)}
      onSelectSession={setActiveSessionId}
    />
  );

  return (
    <VelaDesktopShell
      host={hostBridge}
      isSidebarVisible={isSidebarVisible}
      sidebar={sidebar}
      sidebarWidthPx={sidebarWidthPx}
      onCreateSession={createSession}
      onSidebarVisibilityChange={setIsSidebarVisible}
      onSidebarWidthChange={setSidebarWidthPx}
      onToggleSidebar={() => setIsSidebarVisible((visible) => !visible)}
    >
      {isSettingsOpen ? (
        <DesktopSettingsOverlay
          apiBaseUrl={apiBaseUrl}
          hostLabel={hostLabel}
          sessionsCount={sessions.length}
          onClose={() => setIsSettingsOpen(false)}
        />
      ) : null}
      {activeSessionId ? (
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
        <DesktopEmptySurface />
      )}
    </VelaDesktopShell>
  );
}
