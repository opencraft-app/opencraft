"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  VeladClientError,
  applyTranscriptLiveOverlay,
  commandAckRejectionMessage,
  createVeladClient,
  createStreamRefreshScheduler,
  imageFileToInputPart,
  isVelaStreamEventFreshForCursor,
  isVelaStreamEventForSession,
  needsTranscriptRefreshAfterLiveOverlay,
  readVelaStreamEvent,
  streamReadModelRefreshPlan,
  subscribeVelaEventSource,
  type AgentConfigPatchWire,
  type AgentConfigWire,
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
import { buildChatRenderModel } from "../../packages/vela-chat-render-model/src";
import {
  buildConversationHistoryPrependPlan,
  canApplyConversationHistoryPrependPlan,
  deriveConversationWindowState,
  buildChatSurfaceFromReadModels,
  prependActivityWindow,
  prependTranscriptWindow,
} from "../../packages/vela-chat-surface/src";
import { VelaChatWeb } from "../../packages/vela-chat-web/src";
import { toWebChatModel } from "../../packages/vela-chat-web/src/adapters/toWebBlocks";
import {
  DEFAULT_PERMISSION_MODE_OPTIONS,
  DEFAULT_REASONING_EFFORT_OPTIONS,
  buildComposerControlsModel,
} from "../../packages/vela-chat-web/src/components/composer-controls/model";
import {
  buildConversationRuntimeSegments,
  buildConversationStreamItems,
  conversationRuntimePolicyForHost,
  summarizeConversationRuntime,
} from "../../packages/vela-chat-web/src/conversation-runtime/model";
import type { RequestDockResponse } from "../../packages/vela-chat-web/src/components/requests/RequestDock";
import { buildRequestResponseInputEvent } from "./requestResponses";

const DEFAULT_BASE_URL = "/chat/api/velad/api/v1";

interface PendingImageAttachment {
  id: string;
  label: string;
  mimeType: string;
  part: Extract<ClientInputPart, { type: "image" }>;
}

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
  const [selectedBackend, setSelectedBackend] = useState("");
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

  const loadTranscript = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setError(null);
      commitTranscript(await client.getTranscript(activeSessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitTranscript]);

  const loadActivity = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setError(null);
      commitActivity(await client.getActivity(activeSessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitActivity]);

  const loadRequests = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setError(null);
      commitRequests(await client.getPendingRequests(activeSessionId, { status: "pending" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitRequests]);

  const loadSession = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setError(null);
      const nextSession = await client.getSession(activeSessionId);
      setSession(nextSession.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client]);

  const loadBackends = useCallback(async () => {
    try {
      setError(null);
      const nextBackends = await client.getBackends();
      setBackends(nextBackends.backends);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  const loadReadModels = useCallback(async () => {
    if (!activeSessionId) return;
    try {
      setError(null);
      const [nextTranscript, nextActivity, nextRequests, nextSession, nextBackends] = await Promise.all([
        client.getTranscript(activeSessionId),
        client.getActivity(activeSessionId),
        client.getPendingRequests(activeSessionId, { status: "pending" }),
        client.getSession(activeSessionId),
        client.getBackends(),
      ]);
      commitTranscript(nextTranscript);
      commitActivity(nextActivity);
      commitRequests(nextRequests);
      setSession(nextSession.session);
      setBackends(nextBackends.backends);
    } catch (err) {
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
    if (activeSessionId) return;
    let cancelled = false;

    client
      .getBackends()
      .then((nextBackends) => {
        if (cancelled) return;
        setBackends(nextBackends.backends);
        setSelectedBackend((current) => {
          if (nextBackends.backends.some((backend) => backend.kind === current)) return current;
          return nextBackends.backends[0]?.kind ?? current;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, client]);

  const transcriptEventCursor = cursorEventId(transcript?.cursor);
  const isTranscriptReady = transcript !== null;
  const conversationWindow = useMemo(
    () => deriveConversationWindowState({ transcript, activity }),
    [activity, transcript],
  );
  const conversationHistoryPrependPlan = useMemo(
    () => buildConversationHistoryPrependPlan({ transcript, activity, limit: 80 }),
    [activity, transcript],
  );

  useEffect(() => {
    if (!activeSessionId || !isTranscriptReady) return;
    const url = client.sessionEventStreamUrl(activeSessionId, transcriptEventCursor);
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
          if (!isVelaStreamEventForSession(activeSessionId, streamEvent)) return;
          const currentTranscript = transcriptRef.current;
          if (currentTranscript && !isVelaStreamEventFreshForCursor(currentTranscript.cursor, streamEvent)) return;
          const forceTranscriptRefresh = currentTranscript
            ? needsTranscriptRefreshAfterLiveOverlay(currentTranscript, streamEvent)
            : false;
          if (currentTranscript) {
            commitTranscript(applyTranscriptLiveOverlay(currentTranscript, streamEvent));
          }
          const refreshPlan = streamReadModelRefreshPlan(streamEvent);
          if (forceTranscriptRefresh) transcriptRefreshScheduler.notifyStreamEvent();
          if (refreshPlan.transcript) transcriptRefreshScheduler.notifyStreamEvent();
          if (refreshPlan.activity) activityRefreshScheduler.notifyStreamEvent();
          if (refreshPlan.requests) requestsRefreshScheduler.notifyStreamEvent();
          if (refreshPlan.session) sessionRefreshScheduler.notifyStreamEvent();
          if (refreshPlan.backends) backendsRefreshScheduler.notifyStreamEvent();
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
    const requestedPrependPlan = conversationHistoryPrependPlan;
    try {
      setIsLoadingOlder(true);
      setError(null);
      const [older, olderActivity] = await Promise.all([
        requestedPrependPlan.transcript
          ? client.getTranscript(activeSessionId, requestedPrependPlan.transcript)
          : Promise.resolve(null),
        requestedPrependPlan.activity
          ? client.getActivity(activeSessionId, requestedPrependPlan.activity)
          : Promise.resolve(null),
      ]);
      if (
        !canApplyConversationHistoryPrependPlan(requestedPrependPlan, {
          transcript: transcriptRef.current,
          activity: activityRef.current,
        })
      ) {
        return;
      }
      if (older) {
        commitTranscript(
          transcriptRef.current ? prependTranscriptWindow(transcriptRef.current, older) : older,
        );
      }
      if (olderActivity) {
        commitActivity(
          activityRef.current
            ? prependActivityWindow(activityRef.current, olderActivity)
            : olderActivity,
        );
      }
    } catch (err) {
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
    const surface = buildChatSurfaceFromReadModels({
      sessionId: activeSessionId || "unselected",
      transcript: transcript ?? { rows: [], cursor: {} },
      activity: activity ?? { items: [], cursor: {} },
      requests: requests ?? { requests: [], cursor: {} },
      stream: { connected: streamConnected },
    });
    return buildChatRenderModel(surface, { kind: "desktop_web" });
  }, [activeSessionId, activity, requests, streamConnected, transcript]);

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
      const nextAttachments = await Promise.all(
        files.map(async (file, index) => ({
          id: `image_${Date.now()}_${index}_${file.name || "attachment"}`,
          label: file.name || "image",
          mimeType: file.type || "application/octet-stream",
          part: await imageFileToInputPart(file),
        })),
      );
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

  const selectedBackendDetails = useMemo(
    () => backends.find((backend) => backend.kind === selectedBackend) ?? backends[0],
    [backends, selectedBackend],
  );
  const resolvedSelectedBackend = selectedBackendDetails?.kind ?? selectedBackend;
  const setupModelOptions = selectedBackendDetails?.models ?? [];
  const setupSelectedModel = useMemo(() => {
    if (selectedModel && setupModelOptions.some((model) => model.id === selectedModel)) {
      return selectedModel;
    }
    return setupModelOptions.find((model) => model.is_default)?.id ?? setupModelOptions[0]?.id ?? selectedModel;
  }, [selectedModel, setupModelOptions]);
  const setupReasoningOptions = useMemo(() => {
    const modelReasoningOptions =
      setupModelOptions.find((model) => model.id === setupSelectedModel)?.reasoning_efforts ?? [];
    return modelReasoningOptions.length ? modelReasoningOptions : DEFAULT_REASONING_EFFORT_OPTIONS;
  }, [setupModelOptions, setupSelectedModel]);
  const setupSelectedReasoningEffort = useMemo(() => {
    if (
      selectedReasoningEffort &&
      setupReasoningOptions.some((option) => option.id === selectedReasoningEffort)
    ) {
      return selectedReasoningEffort;
    }
    return (
      setupReasoningOptions.find(isDefaultOption)?.id ??
      setupReasoningOptions.find((option) => option.id === "medium")?.id ??
      setupReasoningOptions[0]?.id ??
      selectedReasoningEffort
    );
  }, [selectedReasoningEffort, setupReasoningOptions]);
  const setupPermissionOptions = selectedBackendDetails?.permission_modes?.length
    ? selectedBackendDetails.permission_modes
    : DEFAULT_PERMISSION_MODE_OPTIONS;
  const setupSelectedPermissionMode = useMemo<PermissionModeWire | "">(() => {
    if (
      selectedPermissionMode &&
      setupPermissionOptions.some((option) => option.id === selectedPermissionMode)
    ) {
      return selectedPermissionMode;
    }
    return (
      setupPermissionOptions.find(isDefaultOption)?.id ??
      setupPermissionOptions.find((option) => option.id === "auto")?.id ??
      setupPermissionOptions[0]?.id ??
      selectedPermissionMode
    );
  }, [selectedPermissionMode, setupPermissionOptions]);
  const setupAgentConfig = useMemo<AgentConfigWire>(
    () => ({
      ...(setupSelectedModel ? { model: setupSelectedModel } : {}),
      ...(setupSelectedReasoningEffort ? { reasoning_effort: setupSelectedReasoningEffort } : {}),
      ...(setupSelectedPermissionMode ? { permission_mode: setupSelectedPermissionMode } : {}),
    }),
    [setupSelectedModel, setupSelectedPermissionMode, setupSelectedReasoningEffort],
  );

  const createSession = useCallback(async () => {
    const trimmedWorkingDirectory = workingDirectory.trim();
    if (!trimmedWorkingDirectory || isCreatingSession) return;
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
      commitTranscript(null);
      commitActivity(null);
      commitRequests(null);
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
    commitActivity,
    commitRequests,
    commitTranscript,
    isCreatingSession,
    resolvedSelectedBackend,
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
          cursorEventId(requests?.cursor) ??
          cursorEventId(activity?.cursor) ??
          cursorEventId(transcript?.cursor),
      }),
    [
      activeSessionId,
      activity,
      baseUrl,
      conversationDebug,
      draft,
      error,
      isCreatingSession,
      isUpdatingAgentConfig,
      model.rows,
      requests,
      sessionId,
      session,
      backends,
      streamConnected,
      transcript,
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
  }, [activeSessionId, createSession, loadReadModels, sendDebugMessage, sessionId, snapshot]);

  if (!activeSessionId) {
    return (
      <main style={setupShellStyle}>
        <section style={setupCardStyle}>
          <h1 style={setupTitleStyle}>连接本地 velad session</h1>
          <label style={setupLabelStyle}>
            Base URL
            <input
              style={setupInputStyle}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label style={setupLabelStyle}>
            Session ID
            <input
              style={setupInputStyle}
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="输入已有 session_id"
            />
          </label>
          <label style={setupLabelStyle}>
            Working Directory
            <input
              style={setupInputStyle}
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="/Users/alice/project"
            />
          </label>
          <label style={setupLabelStyle}>
            Backend
            <select
              style={setupInputStyle}
              value={resolvedSelectedBackend}
              onChange={(event) => {
                setSelectedBackend(event.target.value);
                setSelectedModel("");
                setSelectedReasoningEffort("");
                setSelectedPermissionMode("");
              }}
            >
              {backends.length ? (
                backends.map((backend) => (
                  <option key={backend.kind} value={backend.kind}>
                    {backend.display_name || backend.kind}
                  </option>
                ))
              ) : (
                <option value="">Loading backends...</option>
              )}
            </select>
          </label>
          <label style={setupLabelStyle}>
            Model
            {setupModelOptions.length ? (
              <select
                style={setupInputStyle}
                value={setupSelectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
              >
                {setupModelOptions.map((modelOption) => (
                  <option key={modelOption.id} value={modelOption.id}>
                    {modelOption.label || modelOption.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                style={setupInputStyle}
                value={setupSelectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                placeholder="model id"
              />
            )}
          </label>
          <label style={setupLabelStyle}>
            Thinking
            <select
              style={setupInputStyle}
              value={setupSelectedReasoningEffort}
              onChange={(event) => setSelectedReasoningEffort(event.target.value)}
            >
              {setupReasoningOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label || option.id}
                </option>
              ))}
            </select>
          </label>
          <label style={setupLabelStyle}>
            Permissions
            <select
              style={setupInputStyle}
              value={setupSelectedPermissionMode}
              onChange={(event) => setSelectedPermissionMode(event.target.value as PermissionModeWire)}
            >
              {setupPermissionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label || option.id}
                </option>
              ))}
            </select>
          </label>
          {error ? <p style={setupErrorStyle}>{error}</p> : null}
          <button
            style={setupButtonStyle}
            type="button"
            onClick={() => setActiveSessionId(sessionId.trim())}
            disabled={!sessionId.trim()}
          >
            打开 ChatUI
          </button>
          <button
            style={setupSecondaryButtonStyle}
            type="button"
            onClick={createSession}
            disabled={!workingDirectory.trim() || !resolvedSelectedBackend || isCreatingSession}
          >
            {isCreatingSession ? "创建中" : "新建会话"}
          </button>
        </section>
      </main>
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

const setupShellStyle = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  background: "#fff",
  color: "#171717",
  fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} satisfies React.CSSProperties;

const setupCardStyle = {
  width: "min(92vw, 520px)",
  border: "1px solid #e8e8e8",
  borderRadius: 24,
  padding: 28,
  boxShadow: "0 18px 50px rgb(0 0 0 / 6%)",
} satisfies React.CSSProperties;

const setupTitleStyle = {
  margin: "0 0 22px",
  fontSize: 22,
} satisfies React.CSSProperties;

const setupLabelStyle = {
  display: "grid",
  gap: 8,
  marginBottom: 16,
  color: "#6f7176",
  fontSize: 13,
  fontWeight: 650,
} satisfies React.CSSProperties;

const setupInputStyle = {
  border: "1px solid #dedede",
  borderRadius: 14,
  padding: "12px 14px",
  color: "#171717",
  font: "inherit",
} satisfies React.CSSProperties;

const setupButtonStyle = {
  width: "100%",
  border: 0,
  borderRadius: 14,
  padding: "13px 16px",
  background: "#171717",
  color: "#fff",
  font: "inherit",
  fontWeight: 700,
} satisfies React.CSSProperties;

const setupSecondaryButtonStyle = {
  ...setupButtonStyle,
  marginTop: 10,
  border: "1px solid #dedede",
  background: "#fff",
  color: "#171717",
} satisfies React.CSSProperties;

const setupErrorStyle = {
  margin: "0 0 16px",
  color: "#b42318",
  fontSize: 13,
  lineHeight: 1.5,
} satisfies React.CSSProperties;

function cursorEventId(
  cursor?: { event_id?: string; latest_event_id?: string; next_event_id?: string } | null,
) {
  return cursor?.event_id ?? cursor?.latest_event_id ?? cursor?.next_event_id ?? null;
}

function isStaleCursorError(err: unknown) {
  return err instanceof VeladClientError && (err.detail as { reason?: unknown } | undefined)?.reason === "stale_cursor";
}

function isDefaultOption(option: unknown) {
  return typeof option === "object" && option !== null && "is_default" in option && option.is_default === true;
}
