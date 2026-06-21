"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  commandAckRejectionMessage,
  createVeladClient,
  createStreamRefreshScheduler,
  readVelaStreamEvent,
  selectSessionEventStreamAfterId,
  subscribeVelaEventSource,
  type AgentConfigPatchWire,
  type BackendKindWire,
  type BackendWire,
  type ClientInputPart,
  type PermissionModeWire,
  type SessionWire,
} from "../../packages/vela-chat-client/src";
import {
  buildVelaChatDebugSnapshot,
  installVelaChatDebugApi,
  logVelaChatConsoleEvent,
  type VelaChatDebugApi,
  type VelaChatDebugScrollRuntime,
} from "../../packages/vela-chat-debug/src";
import {
  buildConversationHistoryPrependPlan,
  canApplyConversationHistoryPrependPlan,
  deriveConversationWindowState,
  prependActivityWindow,
  prependTranscriptWindow,
} from "../../packages/vela-chat-surface/src";
import { VelaChatWeb } from "../../packages/vela-chat-web/src";
import { toWebChatModel } from "../../packages/vela-chat-web/src/adapters/toWebBlocks";
import { buildComposerControlsModel } from "../../packages/vela-chat-web/src/components/composer-controls/model";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
  summarizeConversationRuntime,
} from "../../packages/vela-chat-web/src/conversation-runtime/model";
import type { RequestDockResponse } from "../../packages/vela-chat-web/src/components/requests/RequestDock";
import { buildRequestResponseInputEvent } from "../../packages/vela-chat-web/src/components/requests/requestResponses";
import {
  isCurrentSessionRequest,
  pendingRequestsForActiveSession,
  readModelForActiveSession,
} from "./sessionScopedReadModels";
import { buildPendingImageAttachments, type PendingImageAttachment } from "./workbench/attachments";
import { DEFAULT_BASE_URL } from "./workbench/constants";
import { buildWorkbenchRenderModel } from "./workbench/renderModel";
import { SetupPanel } from "./workbench/SetupPanel";
import { cursorEventId, isStaleCursorError } from "./workbench/helpers";
import { buildWorkbenchSetupSelection } from "./workbench/setupModel";
import { handleWorkbenchStreamEvent } from "./workbench/streamHandler";

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
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const [workingDirectory, setWorkingDirectory] = useState(initialWorkingDirectory ?? "");
  const [transcript, setTranscript] = useState<Awaited<ReturnType<ReturnType<typeof createVeladClient>["getTranscript"]>> | null>(null);
  const [activity, setActivity] = useState<Awaited<ReturnType<ReturnType<typeof createVeladClient>["getActivity"]>> | null>(null);
  const [requests, setRequests] = useState<Awaited<ReturnType<ReturnType<typeof createVeladClient>["getPendingRequests"]>> | null>(null);
  const [session, setSession] = useState<SessionWire | null>(null);
  const [backends, setBackends] = useState<BackendWire[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<BackendKindWire | "">("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState("");
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionModeWire | "">("");
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isUpdatingAgentConfig, setIsUpdatingAgentConfig] = useState(false);
  const [isRespondingToRequest, setIsRespondingToRequest] = useState(false);
  const [conversationScrollDebug, setConversationScrollDebug] =
    useState<VelaChatDebugScrollRuntime | null>(null);
  const transcriptRef = useRef<typeof transcript>(null);
  const activityRef = useRef<typeof activity>(null);
  const requestsRef = useRef<typeof requests>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const client = useMemo(() => createVeladClient({ baseUrl }), [baseUrl]);
  const commitTranscript = useCallback((nextTranscript: typeof transcript) => {
    transcriptRef.current = nextTranscript;
    setTranscript(nextTranscript);
  }, []);
  const commitActivity = useCallback((nextActivity: typeof activity) => {
    activityRef.current = nextActivity;
    setActivity(nextActivity);
  }, []);
  const commitRequests = useCallback((nextRequests: typeof requests) => {
    requestsRef.current = nextRequests;
    setRequests(nextRequests);
  }, []);
  const resetSessionReadModels = useCallback(() => {
    commitTranscript(null);
    commitActivity(null);
    commitRequests(null);
    setStreamConnected(false);
    setIsLoadingOlder(false);
  }, [commitActivity, commitRequests, commitTranscript]);

  const loadTranscript = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const nextTranscript = await client.getTranscript(requestedSessionId);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitTranscript(nextTranscript);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitTranscript]);

  const loadActivity = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const nextActivity = await client.getActivity(requestedSessionId);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitActivity(nextActivity);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitActivity]);

  const loadRequests = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const nextRequests = await client.getPendingRequests(requestedSessionId, { status: "pending" });
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitRequests(nextRequests);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitRequests]);

  const loadSession = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const nextSession = await client.getSession(requestedSessionId);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setSession(nextSession.session);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client]);

  const loadBackends = useCallback(async () => {
    try {
      setError(null);
      const nextBackends = await client.getBackends();
      setBackends(nextBackends.backends);
      setSelectedBackend((current) => {
        if (nextBackends.backends.some((backend) => backend.kind === current)) return current;
        return nextBackends.backends[0]?.kind ?? current;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const loadReadModels = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const [nextTranscript, nextActivity, nextRequests, nextSession, nextBackends] = await Promise.all([
        client.getTranscript(requestedSessionId),
        client.getActivity(requestedSessionId),
        client.getPendingRequests(requestedSessionId, { status: "pending" }),
        client.getSession(requestedSessionId),
        client.getBackends(),
      ]);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitTranscript(nextTranscript);
      commitActivity(nextActivity);
      commitRequests(nextRequests);
      setSession(nextSession.session);
      setBackends(nextBackends.backends);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitActivity, commitRequests, commitTranscript]);

  useEffect(() => {
    void loadReadModels();
  }, [loadReadModels]);

  useEffect(() => {
    setConversationScrollDebug(null);
  }, [activeSessionId]);

  useEffect(() => {
    void loadBackends();
  }, [loadBackends]);

  const activeTranscript = readModelForActiveSession(activeSessionId, transcript);
  const activeActivity = readModelForActiveSession(activeSessionId, activity);
  const activeRequests = pendingRequestsForActiveSession(activeSessionId, requests);
  const sessionEventStreamAfterId = selectSessionEventStreamAfterId({
    transcript: activeTranscript?.cursor,
    activity: activeActivity?.cursor,
  });
  const isTranscriptReady = activeTranscript !== null;
  const isActivityReady = activeActivity !== null;
  const conversationWindow = useMemo(
    () => deriveConversationWindowState({ transcript: activeTranscript, activity: activeActivity }),
    [activeActivity, activeTranscript],
  );
  const conversationHistoryPrependPlan = useMemo(
    () => buildConversationHistoryPrependPlan({ transcript: activeTranscript, activity: activeActivity, limit: 80 }),
    [activeActivity, activeTranscript],
  );

  useEffect(() => {
    if (!activeSessionId || !isTranscriptReady || !isActivityReady) return;
    const url = client.sessionEventStreamUrl(activeSessionId, sessionEventStreamAfterId);
    const source = new EventSource(url);
    const transcriptRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadTranscript,
      minIntervalMs: 240,
    });
    const activityRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadActivity,
      minIntervalMs: 240,
    });
    const requestsRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadRequests,
      minIntervalMs: 240,
    });
    const sessionRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadSession,
      minIntervalMs: 320,
    });
    const backendsRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadBackends,
      minIntervalMs: 2000,
    });

    const unsubscribe = subscribeVelaEventSource(source, {
      onOpen: () => setStreamConnected(true),
      onError: () => setStreamConnected(false),
      onEvent: (event) => {
        const streamEvent = readVelaStreamEvent(event);
        if (streamEvent) {
          const currentTranscript = readModelForActiveSession(activeSessionId, transcriptRef.current);
          const currentActivity = readModelForActiveSession(activeSessionId, activityRef.current);
          const currentRequests = pendingRequestsForActiveSession(activeSessionId, requestsRef.current);
          handleWorkbenchStreamEvent({
            activeSessionId,
            streamEvent,
            currentTranscript,
            currentActivity,
            currentRequests,
            commitTranscript,
            transcriptRefreshScheduler,
            activityRefreshScheduler,
            requestsRefreshScheduler,
            sessionRefreshScheduler,
            backendsRefreshScheduler,
          });
        }
      },
    });

    return () => {
      unsubscribe();
      transcriptRefreshScheduler.dispose();
      activityRefreshScheduler.dispose();
      requestsRefreshScheduler.dispose();
      sessionRefreshScheduler.dispose();
      backendsRefreshScheduler.dispose();
      source.close();
      setStreamConnected(false);
    };
  }, [
    activeSessionId,
    client,
    isActivityReady,
    isTranscriptReady,
    loadActivity,
    loadBackends,
    commitTranscript,
    loadRequests,
    loadSession,
    loadTranscript,
  ]);

  const loadOlderConversation = useCallback(async () => {
    if (!activeSessionId || !conversationHistoryPrependPlan.has_older || isLoadingOlder) return;
    const requestedSessionId = activeSessionId;
    const requestedPrependPlan = conversationHistoryPrependPlan;
    try {
      setIsLoadingOlder(true);
      setError(null);
      const [older, olderActivity] = await Promise.all([
        requestedPrependPlan.transcript
          ? client.getTranscript(requestedSessionId, requestedPrependPlan.transcript)
          : Promise.resolve(null),
        requestedPrependPlan.activity
          ? client.getActivity(requestedSessionId, requestedPrependPlan.activity)
          : Promise.resolve(null),
      ]);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      const currentTranscript = readModelForActiveSession(requestedSessionId, transcriptRef.current);
      const currentActivity = readModelForActiveSession(requestedSessionId, activityRef.current);
      if (
        !canApplyConversationHistoryPrependPlan(requestedPrependPlan, {
          transcript: currentTranscript,
          activity: currentActivity,
        })
      ) {
        return;
      }
      if (older) {
        commitTranscript(
          currentTranscript ? prependTranscriptWindow(currentTranscript, older) : older,
        );
      }
      if (olderActivity) {
        commitActivity(
          currentActivity
            ? prependActivityWindow(currentActivity, olderActivity)
            : olderActivity,
        );
      }
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      if (isStaleCursorError(err)) {
        await loadReadModels();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [
    activeSessionId,
    client,
    commitActivity,
    commitTranscript,
    conversationHistoryPrependPlan,
    isLoadingOlder,
    loadReadModels,
  ]);

  const model = useMemo(() => {
    return buildWorkbenchRenderModel({
      activeSessionId,
      transcript: activeTranscript,
      activity: activeActivity,
      requests: activeRequests,
      streamConnected,
    });
  }, [activeActivity, activeRequests, activeSessionId, activeTranscript, streamConnected]);

  const conversationDebug = useMemo(() => {
    const webModel = toWebChatModel(model);
    const items = buildConversationStreamItems(webModel.turns);
    const segments = buildConversationRuntimeSegments(
      items,
      conversationRuntimePolicyForHost(model.host.kind),
    );
    return {
      ...summarizeConversationRuntime(items, segments),
      scroll: conversationScrollDebug,
    };
  }, [conversationScrollDebug, model]);

  const handleConversationScrollDebugChange = useCallback(
    (nextDebug: VelaChatDebugScrollRuntime) => {
      setConversationScrollDebug((current) =>
        current?.followOutput === nextDebug.followOutput &&
        current?.bottomAnchorBlockedReason === nextDebug.bottomAnchorBlockedReason &&
        current?.routeResumeStatus === nextDebug.routeResumeStatus &&
        current?.routeResumeScrollTop === nextDebug.routeResumeScrollTop
          ? current
          : { ...nextDebug },
      );
    },
    [],
  );

  const submit = useCallback(async () => {
    const text = draft.trim();
    const imageParts = pendingAttachments.map((attachment) => attachment.part);
    if ((!text && imageParts.length === 0) || !activeSessionId) return;
    const messageContent: ClientInputPart[] = [
      ...(text ? [{ type: "text", text } satisfies ClientInputPart] : []),
      ...imageParts,
    ];
    try {
      setError(null);
      const ack = await client.sendUserMessage({ sessionId: activeSessionId, content: messageContent });
      const rejectionMessage = commandAckRejectionMessage(ack);
      if (rejectionMessage) {
        setError(rejectionMessage);
        return;
      }
      setDraft("");
      setPendingAttachments([]);
      await loadReadModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, draft, loadReadModels, pendingAttachments]);

  const attachImages = useCallback(async (files: File[]) => {
    try {
      setError(null);
      const nextAttachments = await buildPendingImageAttachments(files);
      setPendingAttachments((current) => [...current, ...nextAttachments]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const removeAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

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
      buildWorkbenchSetupSelection({
        backends,
        selectedBackend,
        selectedModel,
        selectedReasoningEffort,
        selectedPermissionMode,
      }),
    [backends, selectedBackend, selectedModel, selectedPermissionMode, selectedReasoningEffort],
  );

  const createSession = useCallback(async () => {
    const trimmedWorkingDirectory = workingDirectory.trim();
    if (!trimmedWorkingDirectory || !resolvedSelectedBackend || isCreatingSession) return;
    try {
      setIsCreatingSession(true);
      setError(null);
      const created = await client.createSession({
        backend: resolvedSelectedBackend,
        agentConfig: setupAgentConfig,
        workingDirectory: trimmedWorkingDirectory,
        title: "New chat",
      });
      setSessionId(created.session.id);
      setActiveSessionId(created.session.id);
      setSession(created.session);
      resetSessionReadModels();
      logVelaChatConsoleEvent("create_session", {
        agentConfig: setupAgentConfig,
        backend: resolvedSelectedBackend,
        sessionId: created.session.id,
        workingDirectory: trimmedWorkingDirectory,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      logVelaChatConsoleEvent("create_session_error", { message });
    } finally {
      setIsCreatingSession(false);
    }
  }, [
    client,
    isCreatingSession,
    resolvedSelectedBackend,
    resetSessionReadModels,
    setupAgentConfig,
    workingDirectory,
  ]);

  const updateAgentConfig = useCallback(
    async (patch: AgentConfigPatchWire) => {
      if (!activeSessionId || isUpdatingAgentConfig) return;
      try {
        setIsUpdatingAgentConfig(true);
        setError(null);
        const updated = await client.updateAgentConfig({
          sessionId: activeSessionId,
          patch,
        });
        setSession(updated.session);
        logVelaChatConsoleEvent("update_agent_config", {
          sessionId: activeSessionId,
          patch,
          effectiveAfter: updated.effective_after,
        });
        await loadReadModels();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        logVelaChatConsoleEvent("update_agent_config_error", { message });
      } finally {
        setIsUpdatingAgentConfig(false);
      }
    },
    [activeSessionId, client, isUpdatingAgentConfig, loadReadModels],
  );

  const respondToRequest = useCallback(
    async (response: RequestDockResponse) => {
      if (!activeSessionId || isRespondingToRequest) return;
      try {
        setIsRespondingToRequest(true);
        setError(null);
        const ack = await client.sendSessionInputEvents({
          sessionId: activeSessionId,
          events: [buildRequestResponseInputEvent(response)],
        });
        const rejectionMessage = commandAckRejectionMessage(ack);
        if (rejectionMessage) {
          setError(rejectionMessage);
          return;
        }
        await Promise.all([loadRequests(), loadActivity()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsRespondingToRequest(false);
      }
    },
    [activeSessionId, client, isRespondingToRequest, loadActivity, loadRequests],
  );

  const sendDebugMessage = useCallback(
    async (text?: string) => {
      const nextDraft = text ?? draft;
      const trimmed = nextDraft.trim();
      if (!trimmed || !activeSessionId) return;
      try {
        setError(null);
        logVelaChatConsoleEvent("send_message", {
          sessionId: activeSessionId,
          textLength: trimmed.length,
        });
        const ack = await client.sendUserMessage({ sessionId: activeSessionId, text: trimmed });
        const rejectionMessage = commandAckRejectionMessage(ack);
        if (rejectionMessage) {
          setError(rejectionMessage);
          logVelaChatConsoleEvent("send_message_rejected", { message: rejectionMessage });
          return;
        }
        setDraft("");
        await loadReadModels();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        logVelaChatConsoleEvent("send_message_error", { message });
      }
    },
    [activeSessionId, client, draft, loadReadModels],
  );

  const snapshot = useMemo(
    () =>
      buildVelaChatDebugSnapshot({
        baseUrl,
        sessionIdInput: sessionId,
        activeSessionId,
        workingDirectoryInput: workingDirectory,
        draft,
        error,
        streamConnected,
        isCreatingSession,
        isUpdatingAgentConfig,
        agentConfig: session?.agent_config,
        backendCount: backends.length,
        conversation: conversationDebug,
        rows: model.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          key: row.key,
        })),
        latestEventId:
          cursorEventId(activeRequests?.cursor) ??
          cursorEventId(activeActivity?.cursor) ??
          cursorEventId(activeTranscript?.cursor),
      }),
    [
      activeSessionId,
      activeActivity,
      activeRequests,
      activeTranscript,
      baseUrl,
      conversationDebug,
      draft,
      error,
      isCreatingSession,
      isUpdatingAgentConfig,
      model.rows,
      sessionId,
      session,
      backends,
      streamConnected,
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
      openSession: (nextSessionId) => {
        const resolvedSessionId = (nextSessionId ?? sessionId).trim();
        resetSessionReadModels();
        setSession(null);
        setSessionId(resolvedSessionId);
        setActiveSessionId(resolvedSessionId);
        logVelaChatConsoleEvent("open_session", { sessionId: resolvedSessionId });
      },
      createSession,
      setDraft: (nextDraft) => {
        setDraft(nextDraft);
        logVelaChatConsoleEvent("set_draft", { draftLength: nextDraft.length });
      },
      sendMessage: sendDebugMessage,
      reloadTranscript: async () => {
        logVelaChatConsoleEvent("reload_transcript", { sessionId: activeSessionId });
        await loadReadModels();
      },
      clearError: () => {
        setError(null);
        logVelaChatConsoleEvent("clear_error");
      },
      logSnapshot: () => {
        logVelaChatConsoleEvent("snapshot", snapshot);
        return snapshot;
      },
    };

    installVelaChatDebugApi({ api, snapshot });
    logVelaChatConsoleEvent("debug_api_ready", snapshot);
  }, [activeSessionId, createSession, loadReadModels, resetSessionReadModels, sendDebugMessage, sessionId, snapshot]);

  if (!activeSessionId) {
    return (
      <SetupPanel
        backendKinds={backendKinds}
        backends={backends}
        baseUrl={baseUrl}
        error={error}
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
        onOpenSession={() => {
          resetSessionReadModels();
          setSession(null);
          setActiveSessionId(sessionId.trim());
        }}
        onPermissionModeChange={setSelectedPermissionMode}
        onReasoningEffortChange={setSelectedReasoningEffort}
        onSessionIdChange={setSessionId}
        onWorkingDirectoryChange={setWorkingDirectory}
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
      canLoadOlder={conversationWindow.has_older && conversationHistoryPrependPlan.has_older}
      composerControls={buildComposerControlsModel({ session, backends })}
      model={model}
      draft={draft}
      error={error}
      isLoadingOlder={isLoadingOlder}
      isUpdatingComposerControls={isUpdatingAgentConfig}
      isRespondingToRequest={isRespondingToRequest}
      onAttachImages={attachImages}
      onAgentConfigChange={updateAgentConfig}
      onConversationScrollDebugChange={handleConversationScrollDebugChange}
      onDraftChange={setDraft}
      onLoadOlder={loadOlderConversation}
      onRemoveAttachment={removeAttachment}
      onRespondToRequest={respondToRequest}
      onSubmit={submit}
      pendingAttachments={pendingAttachments}
    />
  );
}
