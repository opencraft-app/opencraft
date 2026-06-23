"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VelaClientStateStore } from "../../vela-chat-host-state/src";
import {
  applyConversationLiveOverlay,
  commandAckRejectionMessage,
  createStreamRefreshScheduler,
  createVeladClient,
  mergeConversationSnapshot,
  needsConversationRefreshAfterLiveOverlay,
  readVelaStreamEvent,
  selectSessionEventStreamAfterId,
  subscribeVelaEventSource,
  type AgentConfigPatchWire,
  type BackendWire,
  type ClientInputPart,
  type ConversationWireView,
  type PendingRequestsWireView,
  type SessionWire,
  type VeladClient,
} from "../../vela-chat-client/src";
import {
  buildConversationHistoryPrependPlan,
  canApplyConversationHistoryPrependPlan,
  deriveConversationWindowState,
  prependConversationWindow,
} from "../../vela-chat-surface/src";
import type { RequestDockResponse } from "../../vela-chat-web/src/components/requests/RequestDock";
import { buildRequestResponseInputEvent } from "../../vela-chat-web/src/components/requests/requestResponses";
import { buildComposerControlsModel } from "../../vela-chat-web/src/components/composer-controls/model";
import type { ConversationScrollControllerDebug } from "../../vela-chat-web/src/conversation-runtime/scroll/useConversationScrollController";
import { buildPendingImageAttachments, type PendingImageAttachment } from "./attachments";
import { DEFAULT_VELAD_BASE_URL } from "./constants";
import {
  DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
  deriveConversationHistoryPhase,
  hasCompletedConversationHistoryHydration,
  rememberCompletedConversationHistoryHydration,
  shouldAutoPreloadOlderConversation,
  type VelaConversationHistoryPolicy,
  type VelaConversationHistoryPhase,
} from "./historyPolicy";
import { buildVelaChatControllerRenderModel } from "./renderModel";
import {
  isCurrentSessionRequest,
  pendingRequestsForActiveSession,
  readModelForActiveSession,
} from "./sessionScopedReadModels";
import { handleVelaChatSessionStreamEvent } from "./streamHandler";

export interface VelaChatSessionControllerOptions {
  sessionId: string;
  baseUrl?: string;
  clientStateStore?: VelaClientStateStore | null;
  client?: VeladClient;
  historyPolicy?: VelaConversationHistoryPolicy;
  fetchBackends?: boolean;
}

export interface VelaChatSessionController {
  activeSessionId: string;
  backends: BackendWire[];
  canLoadOlder: boolean;
  composerControls: ReturnType<typeof buildComposerControlsModel>;
  conversation: ConversationWireView | null;
  conversationScrollDebug: ConversationScrollControllerDebug | null;
  draft: string;
  error: string | null;
  historyPhase: VelaConversationHistoryPhase;
  isLoadingOlder: boolean;
  isRespondingToRequest: boolean;
  isStreamConnected: boolean;
  isUpdatingAgentConfig: boolean;
  messageFollowToken: number;
  model: ReturnType<typeof buildVelaChatControllerRenderModel>;
  pendingAttachments: PendingImageAttachment[];
  requests: PendingRequestsWireView | null;
  session: SessionWire | null;
  attachImages: (files: File[]) => Promise<void>;
  loadOlderConversation: () => Promise<void>;
  refreshAll: () => Promise<void>;
  removeAttachment: (attachmentId: string) => void;
  respondToRequest: (response: RequestDockResponse) => Promise<void>;
  send: () => Promise<void>;
  sendText: (text: string) => Promise<void>;
  setConversationScrollDebug: (debug: ConversationScrollControllerDebug) => void;
  setDraft: (value: string) => void;
  stop: () => Promise<void>;
  updateAgentConfig: (patch: AgentConfigPatchWire) => Promise<void>;
}

export function useVelaChatSession({
  sessionId,
  baseUrl = DEFAULT_VELAD_BASE_URL,
  clientStateStore = null,
  client: providedClient,
  historyPolicy = DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY,
  fetchBackends = true,
}: VelaChatSessionControllerOptions): VelaChatSessionController {
  const [conversation, setConversation] = useState<ConversationWireView | null>(null);
  const [requests, setRequests] = useState<PendingRequestsWireView | null>(null);
  const [session, setSession] = useState<SessionWire | null>(null);
  const [backends, setBackends] = useState<BackendWire[]>([]);
  const [draft, setDraftState] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isUpdatingAgentConfig, setIsUpdatingAgentConfig] = useState(false);
  const [isRespondingToRequest, setIsRespondingToRequest] = useState(false);
  const [isCancellingSession, setIsCancellingSession] = useState(false);
  const [messageFollowToken, setMessageFollowToken] = useState(0);
  const [
    completedInitialHydrationSessionIds,
    setCompletedInitialHydrationSessionIds,
  ] = useState<ReadonlySet<string>>(() => new Set());
  const [conversationScrollDebug, setConversationScrollDebug] =
    useState<ConversationScrollControllerDebug | null>(null);

  const activeSessionId = sessionId.trim();
  const activeSessionIdRef = useRef(activeSessionId);
  const conversationRef = useRef<typeof conversation>(null);
  const requestsRef = useRef<typeof requests>(null);
  activeSessionIdRef.current = activeSessionId;

  const ownedClient = useMemo(() => createVeladClient({ baseUrl }), [baseUrl]);
  const client = providedClient ?? ownedClient;

  const commitConversation = useCallback((nextConversation: typeof conversation) => {
    const mergedConversation = nextConversation
      ? mergeConversationSnapshot(conversationRef.current, nextConversation)
      : null;
    conversationRef.current = mergedConversation;
    setConversation(mergedConversation);
  }, []);

  const commitRequests = useCallback((nextRequests: typeof requests) => {
    requestsRef.current = nextRequests;
    setRequests(nextRequests);
  }, []);

  const commitDraft = useCallback(
    (nextDraft: string) => {
      setDraftState(nextDraft);
      if (!activeSessionId) return;
      if (!nextDraft) {
        clientStateStore?.composerDraft.clear(activeSessionId);
        return;
      }
      clientStateStore?.composerDraft.write(activeSessionId, {
        sessionId: activeSessionId,
        text: nextDraft,
        updatedAt: Date.now(),
      });
    },
    [activeSessionId, clientStateStore],
  );

  useEffect(() => {
    commitConversation(null);
    commitRequests(null);
    setSession(null);
    setStreamConnected(false);
    setIsLoadingOlder(false);
    setConversationScrollDebug(null);
  }, [activeSessionId, commitConversation, commitRequests]);

  useEffect(() => {
    if (!activeSessionId) {
      setDraftState("");
      return;
    }
    setDraftState(clientStateStore?.composerDraft.read(activeSessionId)?.text ?? "");
  }, [activeSessionId, clientStateStore]);

  const loadConversation = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const nextConversation = await client.getConversation(requestedSessionId);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitConversation(nextConversation);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitConversation]);

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
    if (!fetchBackends) return;
    try {
      setError(null);
      const nextBackends = await client.getBackends();
      setBackends(nextBackends.backends);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client, fetchBackends]);

  const refreshAll = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId) return;
    try {
      setError(null);
      const [nextConversation, nextRequests, nextSession, nextBackends] = await Promise.all([
        client.getConversation(requestedSessionId),
        client.getPendingRequests(requestedSessionId, { status: "pending" }),
        client.getSession(requestedSessionId),
        fetchBackends ? client.getBackends() : Promise.resolve(null),
      ]);
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      commitConversation(nextConversation);
      commitRequests(nextRequests);
      setSession(nextSession.session);
      if (nextBackends) setBackends(nextBackends.backends);
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeSessionId, client, commitConversation, commitRequests, fetchBackends]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    void loadBackends();
  }, [loadBackends]);

  const activeConversation = readModelForActiveSession(activeSessionId, conversation);
  const activeRequests = pendingRequestsForActiveSession(activeSessionId, requests);
  const sessionEventStreamAfterId = selectSessionEventStreamAfterId({
    conversation: activeConversation?.cursor,
  });
  const isConversationReady = activeConversation !== null;
  const conversationWindow = useMemo(
    () => deriveConversationWindowState({ conversation: activeConversation }),
    [activeConversation],
  );
  const conversationHistoryPrependPlan = useMemo(
    () => buildConversationHistoryPrependPlan({ conversation: activeConversation, limit: 80 }),
    [activeConversation],
  );
  const hasCompletedInitialHistoryHydration =
    hasCompletedConversationHistoryHydration(
      completedInitialHydrationSessionIds,
      activeSessionId,
    );

  useEffect(() => {
    if (!activeSessionId || !isConversationReady) return;
    const url = client.sessionEventStreamUrl(activeSessionId, sessionEventStreamAfterId);
    const source = new EventSource(url);
    const conversationRefreshScheduler = createStreamRefreshScheduler({
      refresh: loadConversation,
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
        if (!streamEvent) return;
        const currentConversation = readModelForActiveSession(
          activeSessionId,
          conversationRef.current,
        );
        const currentRequests = pendingRequestsForActiveSession(
          activeSessionId,
          requestsRef.current,
        );
        if (!currentConversation) return;
        const forceConversationRefresh =
          needsConversationRefreshAfterLiveOverlay(currentConversation, streamEvent);
        commitConversation(applyConversationLiveOverlay(currentConversation, streamEvent));
        handleVelaChatSessionStreamEvent({
          activeSessionId,
          streamEvent,
          currentConversation,
          currentRequests,
          conversationRefreshScheduler,
          forceConversationRefresh,
          requestsRefreshScheduler,
          sessionRefreshScheduler,
          backendsRefreshScheduler,
        });
      },
    });

    return () => {
      unsubscribe();
      conversationRefreshScheduler.dispose();
      requestsRefreshScheduler.dispose();
      sessionRefreshScheduler.dispose();
      backendsRefreshScheduler.dispose();
      source.close();
      setStreamConnected(false);
    };
  }, [
    activeSessionId,
    client,
    commitConversation,
    isConversationReady,
    loadBackends,
    loadConversation,
    loadRequests,
    loadSession,
    sessionEventStreamAfterId,
  ]);

  const loadOlderConversation = useCallback(async () => {
    if (!activeSessionId || !conversationHistoryPrependPlan.has_older || isLoadingOlder) return;
    const requestedSessionId = activeSessionId;
    const requestedPrependPlan = conversationHistoryPrependPlan;
    try {
      setIsLoadingOlder(true);
      setError(null);
      const older = requestedPrependPlan.conversation
        ? await client.getConversation(requestedSessionId, requestedPrependPlan.conversation)
        : null;
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      const currentConversation = readModelForActiveSession(
        requestedSessionId,
        conversationRef.current,
      );
      if (
        !canApplyConversationHistoryPrependPlan(requestedPrependPlan, {
          conversation: currentConversation,
        })
      ) {
        return;
      }
      if (older) {
        commitConversation(
          currentConversation ? prependConversationWindow(currentConversation, older) : older,
        );
      }
    } catch (err) {
      if (!isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingOlder(false);
    }
  }, [
    activeSessionId,
    client,
    commitConversation,
    conversationHistoryPrependPlan,
    isLoadingOlder,
  ]);

  const shouldAutoPreloadOlder = shouldAutoPreloadOlderConversation({
    activeSessionId,
    error,
    hasCompletedInitialHydration: hasCompletedInitialHistoryHydration,
    hasOlder: conversationHistoryPrependPlan.has_older,
    isConversationReady,
    isLoadingOlder,
    policy: historyPolicy,
  });

  useEffect(() => {
    if (!shouldAutoPreloadOlder) return;
    void loadOlderConversation();
  }, [loadOlderConversation, shouldAutoPreloadOlder]);

  const historyPhase = deriveConversationHistoryPhase({
    activeSessionId,
    error,
    hasCompletedInitialHydration: hasCompletedInitialHistoryHydration,
    hasOlder: conversationHistoryPrependPlan.has_older,
    isConversationReady,
    isLoadingOlder,
    policy: historyPolicy,
  });

  useEffect(() => {
    if (
      !activeSessionId ||
      hasCompletedInitialHistoryHydration ||
      !isConversationReady ||
      conversationHistoryPrependPlan.has_older ||
      isLoadingOlder
    ) {
      return;
    }
    setCompletedInitialHydrationSessionIds((current) =>
      rememberCompletedConversationHistoryHydration(current, activeSessionId),
    );
  }, [
    activeSessionId,
    conversationHistoryPrependPlan.has_older,
    hasCompletedInitialHistoryHydration,
    isConversationReady,
    isLoadingOlder,
  ]);

  const model = useMemo(() => {
    return buildVelaChatControllerRenderModel({
      activeSessionId,
      conversation: activeConversation,
      requests: activeRequests,
      streamConnected,
    });
  }, [activeConversation, activeRequests, activeSessionId, streamConnected]);

  const sendMessageContent = useCallback(async (messageContent: ClientInputPart[]) => {
    if (messageContent.length === 0 || !activeSessionId) return false;
    try {
      setError(null);
      const ack = await client.sendUserMessage({ sessionId: activeSessionId, content: messageContent });
      const rejectionMessage = commandAckRejectionMessage(ack);
      if (rejectionMessage) {
        setError(rejectionMessage);
        return false;
      }
      await refreshAll();
      setMessageFollowToken((current) => current + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [activeSessionId, client, refreshAll]);

  const send = useCallback(async () => {
    const text = draft.trim();
    const imageParts = pendingAttachments.map((attachment) => attachment.part);
    if (!text && imageParts.length === 0) return;
    const messageContent: ClientInputPart[] = [
      ...(text ? [{ type: "text", text } satisfies ClientInputPart] : []),
      ...imageParts,
    ];
    const accepted = await sendMessageContent(messageContent);
    if (!accepted) return;
    commitDraft("");
    setPendingAttachments([]);
  }, [commitDraft, draft, pendingAttachments, sendMessageContent]);

  const sendText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const accepted = await sendMessageContent([{ type: "text", text: trimmed }]);
    if (!accepted) return;
    commitDraft("");
    setPendingAttachments([]);
  }, [commitDraft, sendMessageContent]);

  const stop = useCallback(async () => {
    const requestedSessionId = activeSessionId;
    if (!requestedSessionId || isCancellingSession) return;

    try {
      setIsCancellingSession(true);
      setError(null);
      const ack = await client.cancelSession({ sessionId: requestedSessionId });
      const rejectionMessage = commandAckRejectionMessage(ack);
      if (rejectionMessage) {
        setError(rejectionMessage);
        return;
      }
      if (isCurrentSessionRequest(activeSessionIdRef.current, requestedSessionId)) {
        await refreshAll();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCancellingSession(false);
    }
  }, [activeSessionId, client, isCancellingSession, refreshAll]);

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
        await refreshAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsUpdatingAgentConfig(false);
      }
    },
    [activeSessionId, client, isUpdatingAgentConfig, refreshAll],
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
        await Promise.all([loadRequests(), loadConversation()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsRespondingToRequest(false);
      }
    },
    [activeSessionId, client, isRespondingToRequest, loadConversation, loadRequests],
  );

  return {
    activeSessionId,
    backends,
    canLoadOlder: conversationWindow.has_older && conversationHistoryPrependPlan.has_older,
    composerControls: buildComposerControlsModel({ session, backends }),
    conversation: activeConversation,
    conversationScrollDebug,
    draft,
    error,
    historyPhase,
    isLoadingOlder,
    isRespondingToRequest,
    isStreamConnected: streamConnected,
    isUpdatingAgentConfig,
    messageFollowToken,
    model,
    pendingAttachments,
    requests: activeRequests,
    session,
    attachImages,
    loadOlderConversation,
    refreshAll,
    removeAttachment,
    respondToRequest,
    send,
    sendText,
    setConversationScrollDebug,
    setDraft: commitDraft,
    stop,
    updateAgentConfig,
  };
}
