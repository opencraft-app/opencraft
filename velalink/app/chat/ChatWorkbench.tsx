"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createVeladClient,
  type BackendKindWire,
  type BackendWire,
  type PermissionModeWire,
  type SessionListItemWire,
} from "../../packages/vela-chat-client/src";
import {
  DEFAULT_VELAD_BASE_URL,
  buildVelaSessionSetupSelection,
  useVelaChatSession,
} from "../../packages/vela-chat-controller/src";
import {
  buildVelaChatDebugSnapshot,
  installVelaChatDebugApi,
  logVelaChatConsoleEvent,
  type VelaChatDebugApi,
} from "../../packages/vela-chat-debug/src";
import { VelaChatWeb } from "../../packages/vela-chat-web/src";
import { toWebChatModel } from "../../packages/vela-chat-web/src/adapters/toWebBlocks";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
  summarizeConversationRuntime,
} from "../../packages/vela-chat-web/src/conversation-runtime/model";
import { DebugSessionLauncher } from "./workbench/session-launcher/DebugSessionLauncher";
import { cursorEventId } from "./workbench/helpers";
import { createChatExampleClientStateStore } from "./workbench/hostState";

export function ChatWorkbench({
  initialSessionId,
  initialBaseUrl,
  initialWorkingDirectory,
}: {
  initialSessionId?: string;
  initialBaseUrl?: string;
  initialWorkingDirectory?: string;
}) {
  const [sessionId, setSessionId] = useState(initialSessionId ?? "");
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId ?? "");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? DEFAULT_VELAD_BASE_URL);
  const [workingDirectory, setWorkingDirectory] = useState(initialWorkingDirectory ?? "");
  const [recentSessions, setRecentSessions] = useState<SessionListItemWire[]>([]);
  const [launcherBackends, setLauncherBackends] = useState<BackendWire[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<BackendKindWire | "">("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionModeWire | "">("");
  const [launcherError, setLauncherError] = useState<string | null>(null);
  const [isLoadingRecentSessions, setIsLoadingRecentSessions] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  const client = useMemo(() => createVeladClient({ baseUrl }), [baseUrl]);
  const clientStateStore = useMemo(() => createChatExampleClientStateStore(), []);
  const controller = useVelaChatSession({
    baseUrl,
    client,
    clientStateStore,
    sessionId: activeSessionId,
  });
  const activeBackends = activeSessionId ? controller.backends : launcherBackends;
  const error = controller.error ?? launcherError;

  const loadLauncherBackends = useCallback(async () => {
    try {
      setLauncherError(null);
      const nextBackends = await client.getBackends();
      setLauncherBackends(nextBackends.backends);
      setSelectedBackend((current) => {
        if (nextBackends.backends.some((backend) => backend.kind === current)) return current;
        return nextBackends.backends[0]?.kind ?? current;
      });
    } catch (err) {
      setLauncherError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const loadRecentSessions = useCallback(async () => {
    try {
      setIsLoadingRecentSessions(true);
      setLauncherError(null);
      const nextSessions = await client.getSessionListView({ limit: 12 });
      setRecentSessions(nextSessions.sessions);
    } catch (err) {
      setLauncherError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingRecentSessions(false);
    }
  }, [client]);

  useEffect(() => {
    void loadLauncherBackends();
  }, [loadLauncherBackends]);

  useEffect(() => {
    if (activeSessionId) return;
    void loadRecentSessions();
  }, [activeSessionId, loadRecentSessions]);

  const {
    resolvedSelectedBackend,
    backendKinds,
    setupModelOptions,
    setupSelectedModel,
    setupReasoningOptions,
    setupSelectedReasoningEffort,
    setupPermissionOptions,
    setupSelectedPermissionMode,
    setupAgentConfig,
  } = useMemo(
    () =>
      buildVelaSessionSetupSelection({
        backends: activeBackends,
        selectedBackend,
        selectedModel,
        selectedReasoningEffort,
        selectedPermissionMode,
      }),
    [activeBackends, selectedBackend, selectedModel, selectedPermissionMode, selectedReasoningEffort],
  );

  const openSession = useCallback((nextSessionId?: string) => {
    const resolvedSessionId = (nextSessionId ?? sessionId).trim();
    setSessionId(resolvedSessionId);
    setActiveSessionId(resolvedSessionId);
    updateChatSessionUrl(resolvedSessionId);
    logVelaChatConsoleEvent("open_session", { sessionId: resolvedSessionId });
  }, [sessionId]);

  const createSession = useCallback(async () => {
    const trimmedWorkingDirectory = workingDirectory.trim();
    if (!trimmedWorkingDirectory || !resolvedSelectedBackend || isCreatingSession) return;
    try {
      setIsCreatingSession(true);
      setLauncherError(null);
      const created = await client.createSession({
        backend: resolvedSelectedBackend,
        agentConfig: setupAgentConfig,
        workingDirectory: trimmedWorkingDirectory,
        title: "New chat",
      });
      setSessionId(created.session.id);
      setActiveSessionId(created.session.id);
      updateChatSessionUrl(created.session.id);
      logVelaChatConsoleEvent("create_session", {
        agentConfig: setupAgentConfig,
        backend: resolvedSelectedBackend,
        sessionId: created.session.id,
        workingDirectory: trimmedWorkingDirectory,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLauncherError(message);
      logVelaChatConsoleEvent("create_session_error", { message });
    } finally {
      setIsCreatingSession(false);
    }
  }, [
    client,
    isCreatingSession,
    resolvedSelectedBackend,
    setupAgentConfig,
    workingDirectory,
  ]);

  const conversationDebug = useMemo(() => {
    const webModel = toWebChatModel(controller.model);
    const items = buildConversationStreamItems(webModel.turns);
    const segments = buildConversationRuntimeSegments(
      items,
      conversationRuntimePolicyForHost(controller.model.host.kind),
    );
    return {
      ...summarizeConversationRuntime(items, segments),
      scroll: controller.conversationScrollDebug,
    };
  }, [controller.conversationScrollDebug, controller.model]);

  const snapshot = useMemo(
    () =>
      buildVelaChatDebugSnapshot({
        baseUrl,
        sessionIdInput: sessionId,
        activeSessionId,
        workingDirectoryInput: workingDirectory,
        draft: controller.draft,
        error,
        streamConnected: controller.isStreamConnected,
        isCreatingSession,
        isUpdatingAgentConfig: controller.isUpdatingAgentConfig,
        agentConfig: controller.session?.agent_config,
        backendCount: activeBackends.length,
        conversation: conversationDebug,
        rows: controller.model.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          key: row.key,
        })),
        latestEventId:
          cursorEventId(controller.requests?.cursor) ??
          cursorEventId(controller.conversation?.cursor),
      }),
    [
      activeBackends.length,
      activeSessionId,
      baseUrl,
      controller.conversation?.cursor,
      controller.draft,
      controller.isStreamConnected,
      controller.isUpdatingAgentConfig,
      controller.model.rows,
      controller.requests?.cursor,
      controller.session?.agent_config,
      conversationDebug,
      error,
      isCreatingSession,
      sessionId,
      workingDirectory,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const api: VelaChatDebugApi = {
      version: 1,
      getSnapshot: () => snapshot,
      setBaseUrl: (nextBaseUrl) => {
        setBaseUrl(nextBaseUrl);
        logVelaChatConsoleEvent("set_base_url", { baseUrl: nextBaseUrl });
      },
      setSessionId: (nextSessionId) => {
        setSessionId(nextSessionId);
        logVelaChatConsoleEvent("set_session_id", { sessionId: nextSessionId });
      },
      setWorkingDirectory: (nextWorkingDirectory) => {
        setWorkingDirectory(nextWorkingDirectory);
        logVelaChatConsoleEvent("set_working_directory", {
          workingDirectory: nextWorkingDirectory,
        });
      },
      openSession,
      createSession,
      setDraft: (nextDraft) => {
        controller.setDraft(nextDraft);
        logVelaChatConsoleEvent("set_draft", { draftLength: nextDraft.length });
      },
      sendMessage: async (text?: string) => {
        const nextText = text ?? controller.draft;
        logVelaChatConsoleEvent("send_message", {
          sessionId: activeSessionId,
          textLength: nextText.trim().length,
        });
        await controller.sendText(nextText);
      },
      reloadTranscript: async () => {
        logVelaChatConsoleEvent("reload_conversation", { sessionId: activeSessionId });
        await controller.refreshAll();
      },
      clearError: () => {
        setLauncherError(null);
        logVelaChatConsoleEvent("clear_error");
      },
      logSnapshot: () => {
        logVelaChatConsoleEvent("snapshot", snapshot);
        return snapshot;
      },
    };

    installVelaChatDebugApi({ api, snapshot });
    logVelaChatConsoleEvent("debug_api_ready", snapshot);
  }, [activeSessionId, controller, createSession, openSession, snapshot]);

  if (!activeSessionId) {
    return (
      <DebugSessionLauncher
        backendKinds={backendKinds}
        backends={launcherBackends}
        baseUrl={baseUrl}
        error={error}
        isLoadingRecentSessions={isLoadingRecentSessions}
        isCreatingSession={isCreatingSession}
        onBackendChange={(nextBackend) => {
          setSelectedBackend(nextBackend);
          setSelectedModel("");
          setSelectedReasoningEffort("");
          setSelectedPermissionMode("");
        }}
        onBaseUrlChange={setBaseUrl}
        onCreateSession={createSession}
        onModelChange={setSelectedModel}
        onOpenSession={openSession}
        onPermissionModeChange={setSelectedPermissionMode}
        onReasoningEffortChange={setSelectedReasoningEffort}
        onSessionIdChange={setSessionId}
        onWorkingDirectoryChange={setWorkingDirectory}
        recentSessions={recentSessions}
        resolvedSelectedBackend={resolvedSelectedBackend}
        sessionId={sessionId}
        setupModelOptions={setupModelOptions}
        setupPermissionOptions={setupPermissionOptions}
        setupReasoningOptions={setupReasoningOptions}
        setupSelectedModel={setupSelectedModel}
        setupSelectedPermissionMode={setupSelectedPermissionMode}
        setupSelectedReasoningEffort={setupSelectedReasoningEffort}
        workingDirectory={workingDirectory}
      />
    );
  }

  return (
    <VelaChatWeb
      canLoadOlder={controller.canLoadOlder}
      clientStateStore={clientStateStore}
      composerControls={controller.composerControls}
      model={controller.model}
      draft={controller.draft}
      error={error}
      followOutputToken={controller.followOutputToken}
      historyPhase={controller.historyPhase}
      isLoadingOlder={controller.isLoadingOlder}
      isUpdatingComposerControls={controller.isUpdatingAgentConfig}
      isRespondingToRequest={controller.isRespondingToRequest}
      onAttachImages={controller.attachImages}
      onAgentConfigChange={controller.updateAgentConfig}
      onConversationScrollDebugChange={controller.setConversationScrollDebug}
      onDraftChange={controller.setDraft}
      onLoadOlder={controller.loadOlderConversation}
      onRemoveAttachment={controller.removeAttachment}
      onRespondToRequest={controller.respondToRequest}
      onStop={controller.stop}
      onSubmit={controller.send}
      pendingAttachments={controller.pendingAttachments}
    />
  );
}

function updateChatSessionUrl(sessionId: string) {
  if (typeof window === "undefined" || !sessionId) return;
  const url = new URL(window.location.href);
  url.searchParams.set("session_id", sessionId);
  window.history.replaceState(null, "", url);
}
