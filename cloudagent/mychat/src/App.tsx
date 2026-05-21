import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlarmClock,
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronsUpDown,
  CircleDot,
  Mic,
  Paperclip,
  PanelLeft,
  Send,
  Settings,
  SlidersHorizontal,
  SquarePlus,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from "./components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./components/ai-elements/conversation";
import {
  AcpClient,
  resolveAcpWebSocketURL,
  isSameChatMessageTarget,
  mergeChatMessage,
  type AgentCapabilities,
  type ChatMessage,
  type CloudAgentSessionStatus,
  type ListedSession,
  type PermissionRequest,
  type ToolCall,
  type UsageState,
} from "./lib/acpClient";
import {
  beginLoadReplayState,
  evaluateLoadReplay,
  markLoadReplayDone,
  type LoadReplayLifecycle,
} from "./lib/loadReplay";
import {
  canSendPrompt,
  chooseModeWritePath,
  chooseModelWritePath,
  normalizeAttachmentRelativePath,
  validateAttachment,
} from "./lib/protocol";
import {
  createDraftRow,
  removeSessionRow,
  resolveActiveRowId,
  sanitizeStoredUiState,
  updateRowConfigOptions,
  type SessionListStatus,
  type SessionRow,
  type StoredUiState,
} from "./lib/sessionState";
import {
  applyRowRestoreEffect,
  applyTranscriptEffect,
  planCreateConversation,
  planLoadReplaySettled,
  planOpenConversation,
  planReady,
  planRestoreError,
  planSendPrompt,
  planSessionList,
  planSessionReady,
  planTransportLoss,
  type AcpRestoreEnvironment,
  type PendingPrompt,
  type SessionCoordinatorEffect,
} from "./lib/sessionCoordinator";
import {
  getMessageSections,
  getToolGroupSummary,
} from "./lib/messagePresentation";
import { cn } from "./lib/utils";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
const SIDEBAR_DEFAULT_WIDTH = 330;
const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 420;
const MOBILE_MEDIA_QUERY = "(max-width: 1023px)";
const DEFAULT_CWD = "/workspace";
const SESSION_METADATA_POLL_MS = 2000;
const MarkdownContent = lazy(() => import("./components/MarkdownContent"));
const ACP_RESTORE_ENVIRONMENT: AcpRestoreEnvironment = {
  cwd: DEFAULT_CWD,
  // ACP requires clients to resend the full intended MCP server list on load/resume.
  // MyChat currently configures no MCP servers, so the authoritative client list is empty.
  mcpServers: [] as unknown[],
  mcpServersAuthoritative: true,
};

interface BrowserSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onend: (() => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onstart: (() => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: BrowserSpeechRecognitionResult;
}

interface BrowserSpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: BrowserSpeechRecognitionResultList;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface ComposerAttachment extends AttachmentData {
  file: File;
  data?: string;
  relativePath?: string;
  error?: string;
}

interface LoadReplayTracker {
  lifecycle: LoadReplayLifecycle;
}

const agents = [
  ["主AGENTS", "general · 3 conversations"],
  ["UI Smoke Agent", "general · 0 conversations"],
  ["123", "general · 1 conversation"],
  ["你好", "general · 0 conversations"],
  ["123", "general · 0 conversations"],
  ["你好", "general · 0 conversations"],
];

const STORAGE_KEY = "mychat.acp.chat.v1";

type ViewMode = "chat" | "session" | "settings";
type SessionStatusSnapshot = CloudAgentSessionStatus & { receivedAt?: string };
type SessionMetaTemplate = {
  id: string;
  name: string;
  description: string;
  json: string;
};

const SESSION_META_TEMPLATES: SessionMetaTemplate[] = [
  {
    id: "default",
    name: "Default",
    description: "Use the server default sandbox backend.",
    json: "{}",
  },
  {
    id: "talos",
    name: "Talos",
    description: "Create the next ACP session on the Talos backend.",
    json: JSON.stringify(
      {
        _meta: {
          cloudagent: {
            sandbox_backend: "talos",
            sandbox_template_id: "498c6c11-74d7-426e-bdb1-13d8aa73997e",
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "custom",
    name: "Custom",
    description: "Send your own session/new JSON params extension.",
    json: "{}",
  },
];

export function App() {
  const [storedInitialState] = useState(loadStoredState);
  const [initialGatewayURL] = useState(() =>
    resolveInitialGatewayURL(storedInitialState.gatewayURL),
  );
  const [sessionMetaTemplateId, setSessionMetaTemplateId] = useState(
    () => storedInitialState.sessionMetaTemplateId ?? "default",
  );
  const [sessionCreateMetaJSON, setSessionCreateMetaJSON] = useState(
    () => initialSessionCreateMetaJSON(storedInitialState),
  );
  const [conversations, setConversations] = useState<SessionRow[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [listStatus, setListStatus] = useState<SessionListStatus>("idle");
  const [listError, setListError] = useState("");
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [capabilities, setCapabilities] = useState<AgentCapabilities>({});
  const [listedSessions, setListedSessions] = useState<ListedSession[]>([]);
  const [usageByConversation, setUsageByConversation] = useState<
    Record<string, UsageState>
  >({});
  const [sessionStatusByConversation, setSessionStatusByConversation] =
    useState<Record<string, SessionStatusSnapshot>>({});
  const [commandsByConversation, setCommandsByConversation] = useState<
    Record<string, unknown[]>
  >({});
  const [permissionRequests, setPermissionRequests] = useState<
    PermissionRequest[]
  >([]);
  const [pendingTurns, setPendingTurns] = useState<Set<string>>(
    () => new Set(),
  );
  const [lastError, setLastError] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [viewMode, setViewMode] = useState<ViewMode>("chat");
  const [gatewayURLInput, setGatewayURLInput] = useState(initialGatewayURL);
  const [appliedGatewayURL, setAppliedGatewayURL] = useState(initialGatewayURL);
  const clientRef = useRef<AcpClient | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const storedActiveSessionIdRef = useRef(storedInitialState.activeSessionId);
  const activeConversationRef = useRef(activeConversationId);
  const conversationsRef = useRef(conversations);
  const messagesRef = useRef(messages);
  const pendingTurnsRef = useRef(pendingTurns);
  const capabilitiesRef = useRef(capabilities);
  const listedSessionsRef = useRef(listedSessions);
  const pendingOpenAfterListRef = useRef<string | null>(null);
  const pendingPromptsRef = useRef<Map<string, PendingPrompt>>(new Map());
  const loadReplayTrackersRef = useRef<Map<string, LoadReplayTracker>>(
    new Map(),
  );
  const sidebarResizeMovedRef = useRef(false);

  const flushPendingPrompt = useCallback((conversationId: string) => {
    const pending = pendingPromptsRef.current.get(conversationId);
    if (!pending) return;
    pendingPromptsRef.current.delete(conversationId);
    clientRef.current?.sendPrompt(
      pending.conversationId,
      pending.text,
      pending.files,
      {
        optimistic: pending.optimisticMessageId ? false : undefined,
      },
    );
  }, []);

  const clearLoadReplayTracker = useCallback((conversationId: string) => {
    loadReplayTrackersRef.current.delete(conversationId);
  }, []);

  const clearAllLoadReplayTrackers = useCallback(() => {
    loadReplayTrackersRef.current.clear();
  }, []);

  const settleLoadReplay = useCallback(
    (conversationId: string) => {
      const tracker = loadReplayTrackersRef.current.get(conversationId);
      if (!tracker) return;
      if (evaluateLoadReplay(tracker.lifecycle) !== "live") return;
      clearLoadReplayTracker(conversationId);
      const client = clientRef.current;
      if (!client) return;
      const plan = planLoadReplaySettled({
        conversationId,
        conversations: conversationsRef.current,
      });
      for (const effect of plan.effects) {
        if (effect.type === "activate_loaded_session") {
          client.setActiveSession(effect.conversationId, effect.sessionId);
        } else if (effect.type === "resume_session") {
          client.resumeSession(
            effect.conversationId,
            effect.sessionId,
            effect.cwd,
            effect.mcpServers,
            effect.additionalDirectories,
          );
        } else if (effect.type === "update_row_restore_state") {
          setConversations((prev) => applyRowRestoreEffect(prev, effect));
        } else if (effect.type === "flush_pending_prompt") {
          flushPendingPrompt(effect.conversationId);
        }
      }
    },
    [clearLoadReplayTracker, flushPendingPrompt],
  );

  const completeLoadReplay = useCallback(
    (conversationId: string) => {
      const tracker = loadReplayTrackersRef.current.get(conversationId);
      if (!tracker) return;
      tracker.lifecycle = markLoadReplayDone(tracker.lifecycle);
      settleLoadReplay(conversationId);
    },
    [settleLoadReplay],
  );

  const beginLoadReplayTracking = useCallback(
    (conversationId: string) => {
      clearLoadReplayTracker(conversationId);
      const tracker: LoadReplayTracker = {
        lifecycle: beginLoadReplayState(Date.now()),
      };
      loadReplayTrackersRef.current.set(conversationId, tracker);
    },
    [clearLoadReplayTracker],
  );

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    pendingTurnsRef.current = pendingTurns;
  }, [pendingTurns]);

  useEffect(() => {
    capabilitiesRef.current = capabilities;
  }, [capabilities]);

  useEffect(() => {
    listedSessionsRef.current = listedSessions;
  }, [listedSessions]);

  useEffect(() => {
    saveStoredState({
      activeSessionId: activeConversationId || undefined,
      gatewayURL: appliedGatewayURL || undefined,
      sessionMetaTemplateId,
      sessionCreateMetaJSON,
    });
  }, [
    activeConversationId,
    appliedGatewayURL,
    sessionCreateMetaJSON,
    sessionMetaTemplateId,
  ]);

  useEffect(() => {
    setVoiceSupported(Boolean(getSpeechRecognitionConstructor()));
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const sync = () => {
      const nextIsMobile = query.matches;
      setIsMobile(nextIsMobile);
      setSidebarOpen(!nextIsMobile);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const loadReplayTrackers = loadReplayTrackersRef.current;
    const client = new AcpClient(
      {
        onStatus: (nextStatus) => {
          setStatus(nextStatus);
          if (nextStatus === "disconnected" || nextStatus === "error") {
            const plan = planTransportLoss({
              conversations: conversationsRef.current,
            });
            setPendingTurns(plan.pendingTurns);
            setPermissionRequests(plan.permissionRequests);
            pendingPromptsRef.current = plan.pendingPrompts;
            setConversations(plan.conversations);
            executeSessionEffects(plan.effects, client);
          }
        },
        onReady: (nextCapabilities) => {
          setCapabilities(nextCapabilities);
          const plan = planReady({
            capabilities: nextCapabilities,
            storedActiveSessionId: storedActiveSessionIdRef.current,
            defaultCwd: DEFAULT_CWD,
          });
          setListStatus(plan.listStatus);
          setListError(plan.listError);
          pendingOpenAfterListRef.current = plan.pendingOpenAfterList;
          const readyConversations =
            "conversations" in plan ? plan.conversations : undefined;
          const readyActiveConversationId =
            "activeConversationId" in plan
              ? plan.activeConversationId
              : undefined;
          if (readyConversations) setConversations(readyConversations);
          if (typeof readyActiveConversationId === "string")
            setActiveConversationId(readyActiveConversationId);
          executeSessionEffects(plan.effects, client);
        },
        onMessage: (message) => {
          setMessages((prev) => {
            const existing = prev.find((item) =>
              isSameChatMessageTarget(item, message),
            );
            if (!existing) return [...prev, message];
            return prev.map((item) =>
              isSameChatMessageTarget(item, message)
                ? mergeChatMessage(item, message)
                : item,
            );
          });
        },
        onSession: (state) => {
          const plan = planSessionReady({
            state,
            conversations: conversationsRef.current,
            activeConversationId: activeConversationRef.current,
            messages: messagesRef.current,
            pendingTurns: pendingTurnsRef.current,
            pendingPrompts: pendingPromptsRef.current,
          });
          setConversations(plan.conversations);
          setActiveConversationId(plan.activeConversationId);
          setMessages(plan.messages);
          setPendingTurns(plan.pendingTurns);
          pendingPromptsRef.current = plan.pendingPrompts;
          executeSessionEffects(plan.effects, client);
        },
        onSessionList: (sessions) => {
          const plan = planSessionList({
            sessions,
            previousRows: conversationsRef.current,
            defaultCwd: ACP_RESTORE_ENVIRONMENT.cwd,
            pendingOpenAfterList: pendingOpenAfterListRef.current,
            storedActiveSessionId: storedActiveSessionIdRef.current,
            activeConversationId: activeConversationRef.current,
            capabilities: capabilitiesRef.current,
            restoreEnvironment: ACP_RESTORE_ENVIRONMENT,
            activeLiveConnection: false,
          });
          setListedSessions(sessions);
          setListStatus(plan.listStatus);
          setListError(plan.listError);
          pendingOpenAfterListRef.current = plan.pendingOpenAfterList;
          setConversations(plan.conversations);
          setActiveConversationId(plan.activeConversationId);
          executeSessionEffects(plan.effects, client);
        },
        onControlOptions: (conversationId, nextOptions) => {
          setConversations((prev) =>
            updateRowConfigOptions(prev, conversationId, nextOptions),
          );
        },
        onAvailableCommands: (conversationId, commands) => {
          setCommandsByConversation((prev) => ({
            ...prev,
            [conversationId]: commands,
          }));
        },
        onUsage: (conversationId, usage) => {
          setUsageByConversation((prev) => ({
            ...prev,
            [conversationId]: usage,
          }));
        },
        onSessionStatus: (conversationId, sessionStatus) => {
          setSessionStatusByConversation((prev) => ({
            ...prev,
            [conversationId]: {
              ...sessionStatus,
              receivedAt: new Date().toISOString(),
            },
          }));
        },
        onTurn: (conversationId, turnState) => {
          setPendingTurns((prev) => {
            const next = new Set(prev);
            if (turnState === "started") next.add(conversationId);
            else next.delete(conversationId);
            return next;
          });
          if (
            turnState !== "started" &&
            hasCloudAgentMethod(
              capabilitiesRef.current,
              "_cloudagent.session.status",
            )
          ) {
            const row = conversationsRef.current.find(
              (conversation) => conversation.id === conversationId,
            );
            if (row?.sessionId) {
              client.requestSessionStatus(conversationId, row.sessionId);
            }
          }
        },
        onPermissionRequest: (request) => {
          setPermissionRequests((prev) => {
            const existing = prev.find(
              (item) => item.conversationId === request.conversationId,
            );
            if (existing && existing.requestId !== request.requestId) {
              client.cancelPermission(request);
              reportError(
                request.conversationId,
                "busy/active_turn_in_progress: another permission request is already pending",
              );
              return prev;
            }
            return [
              ...prev.filter(
                (item) => item.conversationId !== request.conversationId,
              ),
              request,
            ];
          });
        },
        onError: (error) => {
          const targetConversationId =
            error.conversationId ?? activeConversationRef.current;
          const content = `${error.code}/${error.kind}${error.message ? `: ${error.message}` : ""}`;
          setLastError(content);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              conversationId: targetConversationId,
              role: "system",
              sender: "system",
              time: timeLabelSafe(),
              content,
            },
          ]);
          if (error.code === "restore_failed") {
            const plan = planRestoreError({
              targetConversationId,
              kind: error.kind,
              content,
              conversations: conversationsRef.current,
              pendingTurns: pendingTurnsRef.current,
              pendingPrompts: pendingPromptsRef.current,
            });
            pendingPromptsRef.current = plan.pendingPrompts;
            setPendingTurns(plan.pendingTurns);
            setConversations(plan.conversations);
            if (plan.listStatus) setListStatus(plan.listStatus);
            if (plan.listError) setListError(plan.listError);
            executeSessionEffects(plan.effects, client);
          }
        },
        onSessionClosed: (conversationId) => {
          clearLoadReplayTracker(conversationId);
          pendingPromptsRef.current.delete(conversationId);
          setPendingTurns((prev) => {
            const next = new Set(prev);
            next.delete(conversationId);
            return next;
          });
          setPermissionRequests((prev) =>
            prev.filter((request) => request.conversationId !== conversationId),
          );
          setConversations((prev) =>
            applyRowRestoreEffect(prev, {
              type: "update_row_restore_state",
              conversationId,
              restoreState: "new",
            }),
          );
        },
        onSessionDeleted: (conversationId, sessionId) => {
          clearLoadReplayTracker(conversationId);
          pendingPromptsRef.current.delete(conversationId);
          setPendingTurns((prev) => {
            const next = new Set(prev);
            next.delete(conversationId);
            return next;
          });
          setPermissionRequests((prev) =>
            prev.filter((request) => request.conversationId !== conversationId),
          );
          setUsageByConversation((prev) => {
            const next = { ...prev };
            delete next[conversationId];
            return next;
          });
          setCommandsByConversation((prev) => {
            const next = { ...prev };
            delete next[conversationId];
            return next;
          });
          setSessionStatusByConversation((prev) => {
            const next = { ...prev };
            delete next[conversationId];
            return next;
          });
          setMessages((prev) =>
            applyTranscriptEffect(prev, {
              type: "remove_transcript",
              conversationId,
            }),
          );
          setListedSessions((prev) =>
            prev.filter((session) => session.sessionId !== sessionId),
          );
          setConversations((prev) => removeSessionRow(prev, conversationId));
          setActiveConversationId((current) => {
            if (current !== conversationId) return current;
            const remaining = conversationsRef.current.filter(
              (conversation) => conversation.id !== conversationId,
            );
            return resolveActiveRowId(remaining);
          });
        },
        onReplayDone: (conversationId) => {
          completeLoadReplay(conversationId);
        },
        onTrace: () => undefined,
      },
      {
        gatewayURL: appliedGatewayURL || undefined,
      },
    );
    clientRef.current = client;
    client.connect();
    return () => {
      loadReplayTrackers.clear();
      client.disconnect();
    };
    // The ACP connection should not be recreated when render-local effect executors change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    beginLoadReplayTracking,
    clearLoadReplayTracker,
    completeLoadReplay,
    flushPendingPrompt,
  ]);

  const activeConversation =
    conversations.find((item) => item.id === activeConversationId) ??
    conversations[0] ??
    emptyConversation();
  const resolvedGatewayURL =
    typeof window === "undefined"
      ? "/ws"
      : resolveAcpWebSocketURL(appliedGatewayURL || undefined);
  const activeMessages = messages.filter(
    (message) => message.conversationId === activeConversationId,
  );
  const modelDecision = useMemo(
    () =>
      chooseModelWritePath({ configOptions: activeConversation.configOptions }),
    [activeConversation.configOptions],
  );
  const modeDecision = useMemo(
    () =>
      chooseModeWritePath({ configOptions: activeConversation.configOptions }),
    [activeConversation.configOptions],
  );
  const activeModelOption = activeConversation.configOptions.find(
    (item) => item.id === modelDecision.configId,
  );
  const activeModeOption = activeConversation.configOptions.find(
    (item) => item.id === modeDecision.configId,
  );
  const imageCapability = capabilities.promptCapabilities?.image === true;
  const activePermissionRequest = permissionRequests.find(
    (request) => request.conversationId === activeConversationId,
  );
  const canCancelActiveTurn =
    pendingTurns.has(activeConversationId) || Boolean(activePermissionRequest);
  const activeUsage = usageByConversation[activeConversationId];
  const activeCommands = commandsByConversation[activeConversationId] ?? [];
  const activeSessionStatus =
    sessionStatusByConversation[activeConversation.id];
  const sessionCreateMeta = useMemo(
    () => parseSessionCreateMetaJSON(sessionCreateMetaJSON),
    [sessionCreateMetaJSON],
  );
  const sessionMetaSummary = summarizeSessionCreateMeta(
    sessionCreateMeta.value,
  );
  const canInspectSessionMetadata = hasCloudAgentMethod(
    capabilities,
    "_cloudagent.session.status",
  );
  const busyConversationIds = new Set(pendingTurns);
  permissionRequests.forEach((request) => {
    busyConversationIds.add(request.conversationId);
  });
  const canSend =
    canSendPrompt({
      text: input,
      attachments: attachments.map((attachment) => ({
        name: attachment.name ?? attachment.file.name,
        type: attachment.type ?? attachment.file.type,
        size: attachment.size ?? attachment.file.size,
      relativePath: attachment.relativePath,
    })),
    status,
      restoreState: activeConversation.restoreState,
      pending: canCancelActiveTurn,
      imageCapability,
    }) && !sessionCreateMeta.error;
  const blockedPromptReason =
    sessionCreateMeta.error
      ? `Session params JSON: ${sessionCreateMeta.error}`
      : activeConversation.restoreState === "blocked"
      ? activeConversation.readOnly
        ? `Session is read-only: ${activeConversation.readOnlyReason ?? "runtime_not_recovered"}`
        : "Session cannot be restored"
      : "";

  useEffect(() => {
    if (viewMode !== "session") return;
    if (status !== "connected") return;
    if (!canInspectSessionMetadata) return;
    if (!activeConversation.sessionId) return;
    const conversationId = activeConversation.id;
    const sessionId = activeConversation.sessionId;
    const requestStatus = () => {
      clientRef.current?.requestSessionStatus(conversationId, sessionId);
    };
    requestStatus();
    const interval = window.setInterval(
      requestStatus,
      SESSION_METADATA_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [
    activeConversation.id,
    activeConversation.sessionId,
    canInspectSessionMetadata,
    status,
    viewMode,
  ]);

  function openSettings() {
    setGatewayURLInput(appliedGatewayURL);
    setViewMode("settings");
    if (isMobile) setSidebarOpen(false);
  }

  function closeSettings() {
    setGatewayURLInput(appliedGatewayURL);
    setViewMode("chat");
  }

  function saveGatewaySettings() {
    const next = gatewayURLInput.trim();
    setGatewayURLInput(next);
    setAppliedGatewayURL(next);
    setViewMode("chat");
  }

  function resetGatewaySettings() {
    setGatewayURLInput("");
  }

  function selectSessionMetaTemplate(templateId: string) {
    const template =
      SESSION_META_TEMPLATES.find((item) => item.id === templateId) ??
      SESSION_META_TEMPLATES[0];
    setSessionMetaTemplateId(template.id);
    setSessionCreateMetaJSON(template.json);
  }

  function updateSessionMetaJSON(value: string) {
    setSessionMetaTemplateId("custom");
    setSessionCreateMetaJSON(value);
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const accepted: ComposerAttachment[] = [];
    for (const file of Array.from(files)) {
      const browserRelativePath =
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ??
        "";
      const normalizedRelativePath = browserRelativePath
        ? normalizeAttachmentRelativePath(browserRelativePath)
        : undefined;
      if (normalizedRelativePath && !normalizedRelativePath.ok) {
        reportError(activeConversationId, "unsupported/attachment_type_unavailable");
        continue;
      }
      const relativePath = normalizedRelativePath?.path;
      const result = validateAttachment(
        {
          name: file.name,
          type: file.type,
          size: file.size,
          relativePath,
        },
        imageCapability,
      );
      if (!result.ok) {
        reportError(activeConversationId, `${result.code}/${result.kind}`);
        continue;
      }
      const data = await readFile(file);
      accepted.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        type: file.type,
        mediaType: file.type,
        size: file.size,
        data,
        relativePath,
        url: file.type.startsWith("image/") ? data : undefined,
      });
    }
    setAttachments((prev) => [...prev, ...accepted]);
  }

  function executeSessionEffects(
    effects: SessionCoordinatorEffect[],
    client: AcpClient,
  ) {
    for (const effect of effects) {
      switch (effect.type) {
        case "list_sessions":
          client.listSessions(effect.cwd);
          break;
        case "update_row_restore_state":
          setConversations((prev) => applyRowRestoreEffect(prev, effect));
          break;
        case "remove_transcript":
          client.resetConversationRuntime(effect.conversationId);
          setMessages((prev) => applyTranscriptEffect(prev, effect));
          break;
        case "activate_loaded_session":
          client.setActiveSession(effect.conversationId, effect.sessionId);
          break;
        case "resume_session":
          client.resumeSession(
            effect.conversationId,
            effect.sessionId,
            effect.cwd,
            effect.mcpServers,
            effect.additionalDirectories,
          );
          break;
        case "load_session":
          client.loadSession(
            effect.conversationId,
            effect.sessionId,
            effect.cwd,
            effect.mcpServers,
            effect.additionalDirectories,
          );
          break;
        case "create_session":
          if (sessionCreateMeta.error) {
            reportError(
              effect.conversationId,
              `unsupported/session_meta_invalid: ${sessionCreateMeta.error}`,
            );
            break;
          }
          client.createSession(
            effect.conversationId,
            effect.cwd,
            effect.mcpServers,
            sessionCreateMeta.value,
          );
          break;
        case "send_prompt":
          client.sendPrompt(
            effect.prompt.conversationId,
            effect.prompt.text,
            effect.prompt.files,
          );
          break;
        case "report_error":
          reportError(effect.conversationId, effect.content);
          break;
        case "start_load_replay":
          beginLoadReplayTracking(effect.conversationId);
          break;
        case "clear_load_replay":
          clearLoadReplayTracker(effect.conversationId);
          break;
        case "flush_pending_prompt":
          flushPendingPrompt(effect.conversationId);
          break;
        case "clear_all_load_replay":
          clearAllLoadReplayTrackers();
          break;
      }
    }
  }

  function send() {
    if (!canSend) return;
    const prompt: PendingPrompt = {
      conversationId: activeConversationId,
      text: input.trim(),
      files: attachments.map((item) => ({
        name: item.name ?? item.file.name,
        type: item.type ?? item.file.type,
        size: item.size ?? item.file.size,
        data: item.data,
        file: item.file,
        relativePath: item.relativePath,
      })),
    };
    const client = clientRef.current;
    if (!client) return;

    const plan = planSendPrompt({
      prompt,
      activeConversation,
      capabilities: capabilitiesRef.current,
      listedSessions: listedSessionsRef.current,
      restoreEnvironment: ACP_RESTORE_ENVIRONMENT,
      liveConnection: Boolean(
        activeConversation.sessionId &&
        client.hasActiveSession(
          activeConversationId,
          activeConversation.sessionId,
        ),
      ),
    });
    if (plan.queuePrompt) {
      const queuedPrompt = {
        ...plan.queuePrompt,
        optimisticMessageId: crypto.randomUUID(),
      };
      pendingPromptsRef.current.set(queuedPrompt.conversationId, queuedPrompt);
      setMessages((prev) => [...prev, promptToUserMessage(queuedPrompt)]);
    }
    executeSessionEffects(plan.effects, client);
    if (plan.clearComposer) {
      setInput("");
      setAttachments([]);
    }
  }

  function answerPermission(request: PermissionRequest, optionId?: string) {
    const client = clientRef.current;
    if (!client) return;
    if (optionId) client.resolvePermission(request, optionId);
    else client.cancelPermission(request);
    setPermissionRequests((prev) =>
      prev.filter((item) => item.requestId !== request.requestId),
    );
  }

  function cancelActiveTurn() {
    const activePermission = permissionRequests.find(
      (request) => request.conversationId === activeConversationId,
    );
    if (activePermission) {
      answerPermission(activePermission);
    }
    clientRef.current?.cancel(activeConversationId);
    setPendingTurns((prev) => {
      const next = new Set(prev);
      next.delete(activeConversationId);
      return next;
    });
  }

  function toggleVoiceInput() {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      reportError(activeConversationId, "unsupported/voice_input_unavailable");
      return;
    }

    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.lang = navigator.language || "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    const baseInput = input;
    let finalTranscript = "";

    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      recognitionRef.current = null;
      reportError(
        activeConversationRef.current,
        `unsupported/voice_input_unavailable${event.error ? `: ${event.error}` : ""}`,
      );
    };
    recognition.onresult = (event) => {
      let interimTranscript = "";
      for (
        let index = event.resultIndex;
        index < event.results.length;
        index += 1
      ) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }
      setInput(
        appendVoiceTranscript(
          baseInput,
          `${finalTranscript}${interimTranscript}`,
        ),
      );
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      reportError(activeConversationId, "unsupported/voice_input_unavailable");
    }
  }

  function closeConversation(conversationId: string) {
    if (busyConversationIds.has(conversationId)) return;
    clientRef.current?.closeSession(conversationId);
  }

  function deleteConversation(conversationId: string) {
    if (busyConversationIds.has(conversationId)) return;
    const conversation = conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation?.sessionId) return;
    const target = conversation.title?.trim() || conversation.sessionId;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${target}" from ACP session history?`)
    ) {
      return;
    }
    clientRef.current?.deleteSession(conversationId);
  }

  function selectConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    if (isMobile) setSidebarOpen(false);
    const conversation = conversations.find(
      (item) => item.id === conversationId,
    );
    const client = clientRef.current;
    if (!conversation || !client || status !== "connected") return;
    const plan = planOpenConversation({
      conversation,
      capabilities,
      listedSessions,
      restoreEnvironment: ACP_RESTORE_ENVIRONMENT,
      liveConnection: Boolean(
        conversation.sessionId &&
        client.hasActiveSession(conversation.id, conversation.sessionId),
      ),
    });
    executeSessionEffects(plan.effects, client);
  }

  function createConversation() {
    const id = `conv-${crypto.randomUUID()}`;
    const plan = planCreateConversation({
      id,
      status,
      restoreEnvironment: ACP_RESTORE_ENVIRONMENT,
    });
    setConversations((prev) => [plan.conversation, ...prev]);
    setActiveConversationId(id);
    if (isMobile) setSidebarOpen(false);
    setInput("");
    setAttachments([]);
    if (clientRef.current)
      executeSessionEffects(plan.effects, clientRef.current);
  }

  const startSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (isMobile) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      sidebarResizeMovedRef.current = false;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (Math.abs(moveEvent.clientX - startX) > 3) {
          sidebarResizeMovedRef.current = true;
        }
        const nextWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
        );
        setSidebarWidth(nextWidth);
      };
      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [isMobile, sidebarWidth],
  );

  function updateModel(value: string) {
    if (modelDecision.path === "set_config_option" && modelDecision.configId) {
      clientRef.current?.setConfigOption(
        activeConversationId,
        modelDecision.configId,
        value,
      );
    } else if (modelDecision.path === "set_model") {
      clientRef.current?.setModelFallback(activeConversationId, value);
    } else {
      reportError(activeConversationId, "unsupported/control_path_unavailable");
    }
  }

  function updateMode(value: string) {
    if (modeDecision.path === "set_config_option" && modeDecision.configId) {
      clientRef.current?.setConfigOption(
        activeConversationId,
        modeDecision.configId,
        value,
      );
    } else {
      reportError(activeConversationId, "unsupported/control_path_unavailable");
    }
  }

  function reportError(conversationId: string, content: string) {
    setLastError(content);
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        conversationId,
        role: "system",
        sender: "system",
        time: timeLabelSafe(),
        content,
      },
    ]);
  }

  function promptToUserMessage(prompt: PendingPrompt): ChatMessage {
    return {
      id: prompt.optimisticMessageId ?? crypto.randomUUID(),
      conversationId: prompt.conversationId,
      role: "user",
      sender: "meo",
      time: timeLabelSafe(),
      content: prompt.text,
      attachments: prompt.files.map((file, index) => ({
        id: `${file.name}:${file.size}:${index}`,
        name: file.name,
        type: file.type,
        size: file.size,
        data: file.data,
        url: file.uploaded?.downloadUrl ?? (file.type.startsWith("image/") ? file.data : undefined),
        fileId: file.uploaded?.fileId,
        downloadUrl: file.uploaded?.downloadUrl,
        relativePath: file.uploaded?.relativePath ?? file.relativePath,
      })),
    };
  }

  return (
    <div className="flex h-[100svh] overflow-hidden bg-background text-foreground">
      {isMobile && sidebarOpen && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px]"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <Sidebar
        status={status}
        conversations={conversations}
        listStatus={listStatus}
        listError={listError}
        activeConversationId={activeConversationId}
        activeView={viewMode}
        onSelectConversation={(conversationId) => {
          setViewMode("chat");
          selectConversation(conversationId);
        }}
        onOpenSettings={openSettings}
        onNewConversation={() => {
          setViewMode("chat");
          createConversation();
        }}
        canCloseSessions={Boolean(capabilities.sessionCapabilities?.close)}
        canDeleteSessions={Boolean(capabilities.sessionCapabilities?.delete)}
        busyConversationIds={busyConversationIds}
        onCloseConversation={closeConversation}
        onDeleteConversation={deleteConversation}
        isMobile={isMobile}
        open={sidebarOpen}
        width={sidebarWidth}
        onClose={() => setSidebarOpen(false)}
      />
      {!isMobile && sidebarOpen && (
        <button
          type="button"
          aria-label="Resize sidebar"
          title="Drag to resize sidebar. Click to close."
          className="group relative z-20 hidden w-2 shrink-0 cursor-ew-resize md:block"
          onPointerDown={startSidebarResize}
          onClick={() => {
            if (!sidebarResizeMovedRef.current) setSidebarOpen(false);
          }}
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-border" />
        </button>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <Header
          sessionId={activeConversation.sessionId ?? ""}
          status={status}
          usage={activeUsage}
          commandCount={activeCommands.length}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenSession={() => setViewMode("session")}
        />
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <Conversation>
            <ConversationContent className="px-4 pb-[310px] pt-8 sm:px-6 sm:pb-[270px] sm:pt-12">
              <div className="mx-auto flex min-h-full w-full max-w-[1040px] flex-col">
                {viewMode === "settings" ? (
                  <SettingsPage
                    gatewayURLInput={gatewayURLInput}
                    resolvedGatewayURL={resolvedGatewayURL}
                    onChangeGatewayURL={setGatewayURLInput}
                    sessionMetaTemplates={SESSION_META_TEMPLATES}
                    sessionMetaTemplateId={sessionMetaTemplateId}
                    sessionMetaJSON={sessionCreateMetaJSON}
                    sessionMetaError={sessionCreateMeta.error}
                    sessionMetaSummary={sessionMetaSummary}
                    onSessionMetaTemplateChange={selectSessionMetaTemplate}
                    onSessionMetaJSONChange={updateSessionMetaJSON}
                    onSave={saveGatewaySettings}
                    onReset={resetGatewaySettings}
                    onCancel={closeSettings}
                  />
                ) : viewMode === "session" ? (
                  <SessionPage
                    session={activeConversation}
                    status={status}
                    metadata={activeSessionStatus}
                    metadataAvailable={canInspectSessionMetadata}
                    onBack={() => setViewMode("chat")}
                  />
                ) : activeMessages.length === 0 ? (
                  <EmptyState gatewayLabel={resolvedGatewayURL} />
                ) : (
                  <MessageStream messages={activeMessages} />
                )}
              </div>
            </ConversationContent>
            <ConversationScrollButton className="bottom-[210px] gap-2 px-4 text-sm text-muted">
              <ArrowDown className="h-4 w-4" />
              New messages
            </ConversationScrollButton>
          </Conversation>
          {viewMode === "chat" && activePermissionRequest && (
            <PermissionPanel
              request={activePermissionRequest}
              onSelect={(optionId) =>
                answerPermission(activePermissionRequest, optionId)
              }
              onCancel={() => answerPermission(activePermissionRequest)}
            />
          )}
          {viewMode === "chat" && (
            <Composer
              input={input}
              setInput={setInput}
              canSend={canSend}
              onSend={send}
              attachments={attachments}
              onAddFiles={addFiles}
              onRemoveAttachment={(id) =>
                setAttachments((prev) => prev.filter((item) => item.id !== id))
              }
              fileRef={fileRef}
              voiceSupported={voiceSupported}
              isListening={isListening}
              onToggleVoice={toggleVoiceInput}
              status={status}
              blockedReason={blockedPromptReason}
              canCancel={canCancelActiveTurn}
              modeLabel={modeDecision.configId ?? "mode"}
              modeValue={activeModeOption?.currentValue ?? ""}
              modeOptions={activeModeOption?.options ?? []}
              onModeChange={updateMode}
              modelLabel={modelDecision.configId ?? "主AGENTS"}
              modelValue={activeModelOption?.currentValue ?? ""}
              modelOptions={activeModelOption?.options ?? []}
              onModelChange={updateModel}
              onCancel={cancelActiveTurn}
            />
          )}
          {lastError && (
            <div className="absolute bottom-5 left-[50%] z-20 -translate-x-1/2 rounded-full border border-border bg-panel px-4 py-2 text-sm text-accent shadow-sm">
              {lastError}
              <button
                type="button"
                className="ml-3 text-muted"
                onClick={() => setLastError("")}
                aria-label="Dismiss error"
              >
                <X className="inline h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export function SettingsPage({
  gatewayURLInput,
  resolvedGatewayURL,
  onChangeGatewayURL,
  sessionMetaTemplates,
  sessionMetaTemplateId,
  sessionMetaJSON,
  sessionMetaError,
  sessionMetaSummary,
  onSessionMetaTemplateChange,
  onSessionMetaJSONChange,
  onSave,
  onReset,
  onCancel,
}: {
  gatewayURLInput: string;
  resolvedGatewayURL: string;
  onChangeGatewayURL: (value: string) => void;
  sessionMetaTemplates: SessionMetaTemplate[];
  sessionMetaTemplateId: string;
  sessionMetaJSON: string;
  sessionMetaError?: string;
  sessionMetaSummary: string;
  onSessionMetaTemplateChange: (value: string) => void;
  onSessionMetaJSONChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-1 items-start">
      <div className="w-full rounded-[28px] border border-border bg-panel p-6 shadow-sm sm:p-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">
            Settings
          </p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground">
            Gateway URI
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            Leave it empty to keep the default current-origin websocket
            endpoint. You can paste either http(s)://... or ws(s)://.... If you
            point to /acp, MyChat will switch to raw ACP transport
            automatically.
          </p>
          <div className="mt-8 space-y-3">
            <label
              htmlFor="gateway-uri"
              className="text-sm font-semibold text-foreground"
            >
              Gateway URI
            </label>
            <Textarea
              id="gateway-uri"
              value={gatewayURLInput}
              onChange={(event) => onChangeGatewayURL(event.target.value)}
              placeholder="http://127.0.0.1:18094 or ws://127.0.0.1:18094/acp"
              className="min-h-[120px] rounded-[24px] border border-border bg-input px-5 py-4 font-mono text-sm"
            />
            <div className="rounded-[20px] border border-border bg-background/70 px-4 py-3 text-sm text-muted">
              Effective websocket URI:{" "}
              <span className="break-all font-mono text-foreground">
                {resolvedGatewayURL}
              </span>
            </div>
          </div>
          <SessionMetaSettingsSection
            templates={sessionMetaTemplates}
            templateId={sessionMetaTemplateId}
            json={sessionMetaJSON}
            error={sessionMetaError}
            summary={sessionMetaSummary}
            onTemplateChange={onSessionMetaTemplateChange}
            onJSONChange={onSessionMetaJSONChange}
          />
          <div className="mt-8 flex flex-wrap gap-3">
            <Button onClick={onSave}>Save</Button>
            <Button variant="soft" onClick={onReset}>
              Use Default
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              Back
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SessionPage({
  session,
  status,
  metadata,
  metadataAvailable,
  onBack,
}: {
  session: SessionRow;
  status: ConnectionStatus;
  metadata?: SessionStatusSnapshot;
  metadataAvailable: boolean;
  onBack: () => void;
}) {
  const modelValue = getConfigOptionValue(session.configOptions, "model");
  const modeValue = getConfigOptionValue(session.configOptions, "mode");
  const overviewRows = [
    ["Title", session.title || "Untitled session"],
    ["Session ID", session.sessionId ?? "Draft session"],
    ["State", formatRestoreState(session.restoreState)],
    ["Workspace", session.cwd || DEFAULT_CWD],
    ["Access", formatSessionAccess(session)],
  ];
  const configurationRows = [
    ["Model", modelValue ?? "Not exposed"],
    ["Mode", modeValue ?? "Not exposed"],
  ];
  const runtimeRows = [
    ["Connection", formatConnectionStatus(status)],
    ["Binding", session.sessionId ? "Session-bound" : "Draft session"],
    ["Runtime", session.restoreState === "live" ? "Live" : "Unknown"],
  ];
  const metadataRows = metadataAvailable
    ? [
        ["Backend", metadata?.sandbox?.backend ?? "Unknown"],
        ["Template ID", metadata?.sandbox?.sandboxTemplateId ?? "Unknown"],
        ["Runtime ID", metadata?.sandbox?.runtimeId ?? "Unknown"],
        [
          "Outer Sandbox ID",
          metadata?.sandbox?.outerSandboxId ?? "Not created",
        ],
        [
          "Inner Sandbox ID",
          metadata?.sandbox?.innerSandboxId ?? "Not created",
        ],
        ["Sandbox Domain", metadata?.sandbox?.outerSandboxDomain ?? "Unknown"],
        [
          "Runtime Generation",
          formatOptionalNumber(metadata?.runtimeGeneration),
        ],
        ["Last Refreshed", formatTimestamp(metadata?.receivedAt)],
        ["Closed", formatOptionalBoolean(metadata?.closed)],
        ["Prompt In Flight", formatOptionalBoolean(metadata?.promptInFlight)],
        ["Cleanup Pending", formatOptionalBoolean(metadata?.cleanupPending)],
        ["Last Runtime Error", metadata?.lastRuntimeError ?? "None"],
      ]
    : [["CloudAgent Metadata", "Not exposed"]];

  return (
    <div className="flex flex-1 items-start">
      <div className="w-full rounded-[28px] border border-border bg-panel p-6 shadow-sm sm:p-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted">
            Session
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-3xl font-bold tracking-tight text-foreground">
                {session.sessionId
                  ? session.sessionId.slice(0, 20)
                  : "Draft session"}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted">
                Current ACP session summary. Runtime internals stay summarized
                here; raw protocol payloads are not displayed.
              </p>
            </div>
            <Button variant="ghost" onClick={onBack}>
              Back to chat
            </Button>
          </div>
          <div className="mt-8 space-y-6">
            <SessionInfoSection title="Overview" rows={overviewRows} />
            <SessionInfoSection title="Configuration" rows={configurationRows} />
            <SessionInfoSection title="Runtime" rows={runtimeRows} />
            <SessionInfoSection title="Metadata" rows={metadataRows} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionInfoSection({
  title,
  rows,
}: {
  title: string;
  rows: string[][];
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <div className="mt-3 divide-y divide-border rounded-[20px] border border-border bg-background/70">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[140px_minmax(0,1fr)]"
          >
            <div className="font-semibold text-muted">{label}</div>
            <div className="min-w-0 break-words text-foreground">{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function getConfigOptionValue(
  options: SessionRow["configOptions"],
  category: string,
) {
  const option = options.find((item) => item.category === category);
  if (!option?.currentValue) return undefined;
  return (
    option.options?.find((choice) => choice.value === option.currentValue)
      ?.name ?? option.currentValue
  );
}

function formatRestoreState(state: SessionRow["restoreState"]) {
  switch (state) {
    case "live":
      return "Live";
    case "restoring":
      return "Restoring";
    case "blocked":
      return "Blocked";
    case "error":
      return "Error";
    case "new":
    default:
      return "Ready to open";
  }
}

function formatSessionAccess(session: SessionRow) {
  return session.readOnly
    ? `Read-only: ${session.readOnlyReason ?? "runtime_not_recovered"}`
    : "Writable";
}

function formatConnectionStatus(status: ConnectionStatus) {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "disconnected":
    default:
      return "Disconnected";
  }
}

function formatOptionalBoolean(value: boolean | undefined) {
  if (value === undefined) return "Unknown";
  return value ? "Yes" : "No";
}

function formatOptionalNumber(value: number | undefined) {
  return value === undefined ? "Unknown" : String(value);
}

function formatTimestamp(value: string | undefined) {
  if (!value) return "Unknown";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Unknown";
  return timestamp.toLocaleTimeString();
}

function hasCloudAgentMethod(
  capabilities: AgentCapabilities,
  method: string,
) {
  return capabilities._meta?.cloudagent?.methods?.includes(method) === true;
}

function Sidebar({
  status,
  conversations,
  listStatus,
  listError,
  activeConversationId,
  activeView,
  onSelectConversation,
  onOpenSettings,
  onNewConversation,
  canCloseSessions,
  canDeleteSessions,
  busyConversationIds,
  onCloseConversation,
  onDeleteConversation,
  isMobile,
  open,
  width,
  onClose,
}: {
  status: ConnectionStatus;
  conversations: SessionRow[];
  listStatus: SessionListStatus;
  listError: string;
  activeConversationId: string;
  activeView: ViewMode;
  onSelectConversation: (conversationId: string) => void;
  onOpenSettings: () => void;
  onNewConversation: () => void;
  canCloseSessions: boolean;
  canDeleteSessions: boolean;
  busyConversationIds: Set<string>;
  onCloseConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  isMobile: boolean;
  open: boolean;
  width: number;
  onClose: () => void;
}) {
  const [sessionsCollapsed, setSessionsCollapsed] = useState(false);
  const [agentsCollapsed, setAgentsCollapsed] = useState(false);

  return (
    <aside
      aria-hidden={isMobile && !open}
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-sidebar transition-[transform,width] duration-200 ease-out",
        isMobile
          ? "fixed inset-y-0 left-0 z-40 max-w-[86vw] shadow-composer"
          : open
            ? "relative z-10"
            : "hidden",
        isMobile && (open ? "translate-x-0" : "-translate-x-full"),
      )}
      style={{ width: isMobile ? "min(330px, 86vw)" : width }}
    >
      <div className="border-b border-border p-4">
        <div className="flex h-16 items-center gap-3 rounded-[22px] bg-[#efebe3] px-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-panel text-lg font-semibold">
            A
          </div>
          <div className="min-w-0 flex-1 font-semibold">AgentOS</div>
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={onClose}
              aria-label="Close sidebar"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <ChevronsUpDown className="h-4 w-4 text-muted" />
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1 px-7 py-6 text-[17px] text-muted">
        <SidebarAction icon={<AlarmClock />} label="自动化" />
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-full text-left"
        >
          <SidebarAction
            icon={<SlidersHorizontal />}
            label="空间设置"
            activeDot={activeView === "settings"}
          />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <SectionHeader
          label="会话"
          collapsed={sessionsCollapsed}
          plus
          onToggle={() => setSessionsCollapsed((collapsed) => !collapsed)}
          onPlus={onNewConversation}
        />
        {!sessionsCollapsed && (
          <div className="space-y-1">
            {listStatus === "loading" && (
              <SidebarNotice label="Loading ACP sessions..." />
            )}
            {(listStatus === "blocked" || listStatus === "error") && (
              <SidebarNotice
                label={listError || "ACP session/list unavailable"}
              />
            )}
            {listStatus === "ready" && conversations.length === 0 && (
              <SidebarNotice label="No ACP sessions" />
            )}
            {conversations.map((conversation) => (
              <ConversationItem
                key={conversation.id}
                title={conversation.title}
                subtitle={
                  conversation.sessionId
                    ? `${conversation.subtitle} · ${conversation.sessionId.slice(0, 8)}`
                    : conversation.subtitle
                }
                selected={conversation.id === activeConversationId}
                onClick={() => onSelectConversation(conversation.id)}
                canClose={canCloseSessions && Boolean(conversation.sessionId)}
                canDelete={canDeleteSessions && Boolean(conversation.sessionId)}
                disabled={busyConversationIds.has(conversation.id)}
                onClose={() => onCloseConversation(conversation.id)}
                onDelete={() => onDeleteConversation(conversation.id)}
              />
            ))}
          </div>
        )}
        <SectionHeader
          label="AGENTS"
          collapsed={agentsCollapsed}
          onToggle={() => setAgentsCollapsed((collapsed) => !collapsed)}
        />
        {!agentsCollapsed && (
          <div className="space-y-2">
            {agents.map(([name, subtitle], index) => (
              <AgentItem
                key={`${name}-${index}`}
                name={name}
                subtitle={subtitle}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex h-[92px] shrink-0 items-center gap-3 border-t border-border px-7">
        <Avatar variant="user" />
        <div className="flex-1 text-lg font-semibold">meo</div>
        <span
          className={cn(
            "h-2.5 w-2.5 rounded-full",
            status === "connected" ? "bg-green" : "bg-accent",
          )}
        />
        <Settings className="h-5 w-5 text-muted" />
      </div>
    </aside>
  );
}

function SidebarNotice({ label }: { label: string }) {
  return <div className="px-3 py-3 text-sm leading-5 text-muted">{label}</div>;
}

function SidebarAction({
  icon,
  label,
  activeDot,
}: {
  icon: ReactNode;
  label: string;
  activeDot?: boolean;
}) {
  return (
    <div className="flex h-12 items-center gap-4 rounded-lg px-2 text-left">
      <span className="relative flex h-6 w-6 items-center justify-center [&_svg]:h-5 [&_svg]:w-5">
        {icon}
        {activeDot && (
          <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[#28bd67]" />
        )}
      </span>
      {label}
    </div>
  );
}

function SectionHeader({
  label,
  collapsed,
  plus,
  onToggle,
  onPlus,
}: {
  label: string;
  collapsed: boolean;
  plus?: boolean;
  onToggle: () => void;
  onPlus?: () => void;
}) {
  return (
    <div className="mt-3 flex h-10 items-center px-3 text-[13px] font-semibold tracking-[0.08em] text-muted">
      <span className="flex-1">{label}</span>
      <button
        type="button"
        aria-label={`Toggle ${label}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="mr-3 grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-selected hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 transition-transform duration-150",
            collapsed && "-rotate-90",
          )}
          strokeWidth={2.25}
        />
      </button>
      {plus && (
        <button
          type="button"
          aria-label={`New ${label}`}
          onClick={onPlus}
          className="grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-selected hover:text-foreground"
        >
          <SquarePlus className="h-[18px] w-[18px]" strokeWidth={2.1} />
        </button>
      )}
    </div>
  );
}

function ConversationItem({
  title,
  subtitle,
  selected,
  canClose,
  canDelete,
  disabled,
  onClick,
  onClose,
  onDelete,
}: {
  title: string;
  subtitle: string;
  selected?: boolean;
  canClose?: boolean;
  canDelete?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onClose?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-[18px] px-3 py-2.5",
        selected && "bg-selected",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Avatar />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold">{title}</div>
          <div className="truncate text-sm text-muted">{subtitle}</div>
        </div>
      </button>
      {canClose && onClose ? (
        <button
          type="button"
          aria-label="Close session"
          title="Close session"
          disabled={disabled}
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-md text-muted opacity-0 transition hover:bg-panel hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
      {canDelete && onDelete ? (
        <button
          type="button"
          aria-label="Delete session"
          title="Delete session"
          disabled={disabled}
          onClick={onDelete}
          className="grid h-8 w-8 place-items-center rounded-md text-muted opacity-0 transition hover:bg-panel hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}

function AgentItem({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <div className="flex w-full items-center gap-3 rounded-[18px] px-3 py-2 text-left">
      <Avatar />
      <div className="min-w-0">
        <div className="truncate text-[16px] font-semibold">{name}</div>
        <div className="truncate text-sm text-muted">{subtitle}</div>
      </div>
    </div>
  );
}

export function Header({
  sessionId,
  status,
  usage,
  commandCount,
  sidebarOpen,
  onToggleSidebar,
  onOpenSession,
}: {
  sessionId: string;
  status: ConnectionStatus;
  usage?: UsageState;
  commandCount: number;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSession: () => void;
}) {
  const usageLabel =
    usage && usage.size > 0 ? ` · ctx ${usage.used}/${usage.size}` : "";
  const commandLabel = commandCount > 0 ? ` · /${commandCount}` : "";
  return (
    <header className="flex h-[88px] shrink-0 items-center gap-3 px-4 sm:px-6 lg:px-8">
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-9 w-9", sidebarOpen && "lg:hidden")}
        onClick={onToggleSidebar}
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        aria-pressed={sidebarOpen}
      >
        <PanelLeft className="h-5 w-5" />
      </Button>
      <Avatar />
      <span className="text-lg font-semibold sm:text-xl">ChatClaw</span>
      <span className="hidden text-lg font-semibold sm:inline sm:text-xl">
        主AGENTS
      </span>
      <button
        type="button"
        onClick={onOpenSession}
        aria-label="Open session properties"
        className="ml-0 max-w-[180px] truncate rounded-full border border-border bg-panel px-3 py-1 text-left text-xs text-muted transition hover:bg-selected hover:text-foreground sm:ml-2 sm:max-w-none"
      >
        {status}
        {sessionId ? ` · ${sessionId.slice(0, 12)}` : ""}
        {usageLabel}
        {commandLabel}
      </button>
    </header>
  );
}

function EmptyState({ gatewayLabel }: { gatewayLabel: string }) {
  return (
    <ConversationEmptyState className="flex-1 pb-24" title="" description="">
      <div className="mb-24 text-center">
        <Avatar size="lg" />
        <h1 className="mt-6 text-[28px] font-bold">Welcome to ChatClaw</h1>
        <p className="mt-2 text-lg text-muted">
          Chat with 主AGENTS or send a message to start.
        </p>
        <p className="mt-3 break-all text-xs text-muted/70">{gatewayLabel}</p>
      </div>
    </ConversationEmptyState>
  );
}

function MessageStream({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="mx-auto w-full max-w-[900px] space-y-14">
      {messages.map((message) => (
        <MessageGroup
          key={`${message.conversationId}:${message.id}`}
          message={message}
        />
      ))}
    </div>
  );
}

function MessageGroup({ message }: { message: ChatMessage }) {
  const sections = getMessageSections(message);
  return (
    <article className="grid grid-cols-[44px_minmax(0,1fr)] gap-4">
      <Avatar variant={message.role === "user" ? "user" : "agent"} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-bold",
              message.role === "user" ? "text-green" : "text-[#d27777]",
            )}
          >
            {message.sender}
          </span>
          <span className="text-xs text-muted">{message.time}</span>
        </div>
        {sections.map((section) => {
          if (section.type === "thought") {
            return (
              <details
                key={section.id ?? "thought"}
                className="mt-2 rounded-lg border border-border bg-panel/50 px-3 py-2 text-sm text-muted"
              >
                <summary className="cursor-pointer font-medium text-muted">
                  Reasoning
                </summary>
                <div className="mt-2 whitespace-pre-wrap break-words leading-6 [overflow-wrap:anywhere]">
                  {section.text}
                </div>
              </details>
            );
          }
          if (section.type === "content") {
            if (message.role === "agent") {
              return (
                <Suspense
                  key={section.id ?? "content"}
                  fallback={<PlainTextContent text={section.text} />}
                >
                  <MarkdownContent
                    isAnimating={message.streaming === true}
                    text={section.text}
                  />
                </Suspense>
              );
            }
            return (
              <PlainTextContent
                key={section.id ?? "content"}
                text={section.text}
              />
            );
          }
          if (section.type === "attachments") {
            return (
              <Attachments
                key={section.id ?? "attachments"}
                className="mt-3"
                variant="inline"
              >
                {section.attachments.map((attachment) => (
                  <AttachmentLink key={attachment.id} attachment={attachment} />
                ))}
              </Attachments>
            );
          }
          return (
            <ToolGroup
              key={section.id ?? `tools-${section.toolCalls[0].id}`}
              toolCalls={section.toolCalls}
            />
          );
        })}
      </div>
    </article>
  );
}

function AttachmentLink({
  attachment,
}: {
  attachment: NonNullable<ChatMessage["attachments"]>[number];
}) {
  const content = (
    <Attachment data={attachment}>
      <AttachmentPreview />
      <AttachmentInfo />
    </Attachment>
  );
  const href = attachment.downloadUrl ?? attachment.url;
  if (!href || href.startsWith("data:")) return content;
  return (
    <a href={href} download={attachment.name} className="block">
      {content}
    </a>
  );
}

function PlainTextContent({ text }: { text: string }) {
  return (
    <div className="mt-1 whitespace-pre-wrap break-words text-[17px] leading-8 [overflow-wrap:anywhere]">
      {text}
    </div>
  );
}

function PermissionPanel({
  request,
  onSelect,
  onCancel,
}: {
  request: PermissionRequest;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-[218px] z-20 px-4 sm:bottom-[230px]">
      <div className="mx-auto flex max-w-[900px] flex-wrap items-center gap-3 rounded-2xl border border-border bg-panel px-4 py-3 text-sm shadow-composer">
        <Wrench className="h-4 w-4 text-green" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Tool permission requested</div>
          <div className="truncate text-muted">{request.title}</div>
        </div>
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            type="button"
            variant={option.kind.startsWith("allow") ? "default" : "soft"}
            size="sm"
            onClick={() => onSelect(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button type="button" variant="soft" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ToolStrip({ tool }: { tool: ToolCall }) {
  const statusLabel =
    tool.status === "done"
      ? "Done"
      : tool.status === "error"
        ? "Error"
        : "Running";
  const inputText = formatToolValue(tool.input);
  const outputText =
    tool.error || tool.content || formatToolValue(tool.output);
  return (
    <div className="mt-3 w-full min-w-0 rounded-md border border-border bg-panel/70 px-4 py-3 text-left shadow-sm">
      <div className="flex min-w-0 items-center gap-3">
        <Wrench
          className={cn(
            "h-4 w-4 shrink-0",
            tool.status === "error" ? "text-[#d27777]" : "text-green",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-semibold" title={tool.name}>
          {tool.name}
        </span>
        {tool.kind && (
          <span className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-xs text-muted">
            {tool.kind}
          </span>
        )}
        <span className="shrink-0 text-sm text-muted">{statusLabel}</span>
      </div>
      {inputText && (
        <ToolDetail label="Input" tone="muted" value={inputText} />
      )}
      {outputText && (
        <ToolDetail
          label={tool.status === "error" ? "Error" : "Output"}
          tone={tool.status === "error" ? "error" : "normal"}
          value={outputText}
        />
      )}
    </div>
  );
}

function ToolGroup({ toolCalls }: { toolCalls: ToolCall[] }) {
  const hasError = toolCalls.some((tool) => tool.status === "error");
  const isRunning = toolCalls.some((tool) => tool.status === "running");
  return (
    <details className="group mt-3 min-w-0 rounded-md border border-border bg-panel/60 shadow-sm">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <Wrench
          className={cn(
            "h-4 w-4 shrink-0",
            hasError ? "text-[#d27777]" : "text-green",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {getToolGroupSummary(toolCalls)}
        </span>
        {isRunning && (
          <span className="shrink-0 text-xs text-muted">Running</span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-3 pb-3 pt-1">
        {toolCalls.map((tool) => (
          <ToolStrip key={tool.id} tool={tool} />
        ))}
      </div>
    </details>
  );
}

function ToolDetail({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "muted" | "normal" | "error";
}) {
  return (
    <div className="mt-3 min-w-0">
      <div
        className={cn(
          "mb-1 text-xs font-semibold uppercase tracking-normal",
          tone === "error" ? "text-[#d27777]" : "text-muted",
        )}
      >
        {label}
      </div>
      <pre
        className={cn(
          "max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs leading-relaxed",
          tone === "error" ? "text-[#d27777]" : "text-text",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

function formatToolValue(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function Composer({
  input,
  setInput,
  canSend,
  onSend,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  fileRef,
  voiceSupported,
  isListening,
  onToggleVoice,
  status,
  blockedReason,
  canCancel,
  modeLabel,
  modeValue,
  modeOptions,
  onModeChange,
  modelLabel,
  modelValue,
  modelOptions,
  onModelChange,
  onCancel,
}: {
  input: string;
  setInput: (value: string) => void;
  canSend: boolean;
  onSend: () => void;
  attachments: ComposerAttachment[];
  onAddFiles: (files: FileList | null) => void;
  onRemoveAttachment: (id?: string) => void;
  fileRef: RefObject<HTMLInputElement | null>;
  voiceSupported: boolean;
  isListening: boolean;
  onToggleVoice: () => void;
  status: ConnectionStatus;
  blockedReason: string;
  canCancel: boolean;
  modeLabel: string;
  modeValue: string;
  modeOptions: { value: string; name?: string }[];
  onModeChange: (value: string) => void;
  modelLabel: string;
  modelValue: string;
  modelOptions: { value: string; name?: string }[];
  onModelChange: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-3 z-10 px-3 sm:bottom-8 sm:px-6">
      <div className="mx-auto max-w-[1040px] rounded-[24px] border border-border bg-panel p-4 shadow-composer sm:rounded-composer sm:p-5">
        {attachments.length > 0 && (
          <Attachments className="mb-3" variant="grid">
            {attachments.map((attachment) => (
              <Attachment
                key={attachment.id}
                data={attachment}
                onRemove={() => onRemoveAttachment(attachment.id)}
              >
                <AttachmentPreview />
                <AttachmentInfo />
                <AttachmentRemove />
              </Attachment>
            ))}
          </Attachments>
        )}
        <Textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Send a message to your agents"
        />
        <div className="mt-4 flex flex-wrap items-center gap-2 sm:gap-3">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => onAddFiles(event.target.files)}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileRef.current?.click()}
            aria-label="Add attachment"
          >
            <Paperclip className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleVoice}
            aria-label={isListening ? "Stop voice input" : "Voice input"}
            aria-pressed={isListening}
            title={
              voiceSupported
                ? isListening
                  ? "Stop voice input"
                  : "Voice input"
                : "Voice input is unavailable in this browser"
            }
            className={cn(
              isListening && "bg-selected text-accent",
              !voiceSupported && "text-muted opacity-60",
            )}
          >
            <Mic className={cn("h-5 w-5", isListening && "animate-pulse")} />
          </Button>
          {canCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="hidden rounded-full border border-border px-3 py-2 text-sm text-muted hover:bg-selected sm:inline-flex"
            >
              Cancel
            </button>
          )}
          <label className="ml-auto flex h-10 min-w-[126px] items-center justify-center gap-2 rounded-full border border-border bg-[#faf7f3] px-3 text-[14px] font-semibold sm:min-w-[150px] sm:px-4 sm:text-[15px]">
            <CircleDot
              className={cn(
                "h-3 w-3",
                modeOptions.length > 0 ? "text-green" : "text-muted",
              )}
            />
            <select
              aria-label="Mode"
              className="max-w-[82px] bg-transparent font-semibold outline-none sm:max-w-[110px]"
              value={modeValue || modeOptions[0]?.value || modeLabel}
              onChange={(event) => onModeChange(event.target.value)}
              disabled={modeOptions.length === 0}
            >
              {modeOptions.length === 0 ? (
                <option>{modeLabel}</option>
              ) : (
                modeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.name ?? option.value}
                  </option>
                ))
              )}
            </select>
            <ChevronDown className="h-4 w-4 text-muted" />
          </label>
          <label className="flex h-10 min-w-[138px] items-center justify-center gap-2 rounded-full border border-border bg-[#faf7f3] px-3 text-[14px] font-semibold sm:min-w-[170px] sm:px-4 sm:text-[15px]">
            <CircleDot
              className={cn(
                "h-3 w-3",
                status === "connected" ? "text-green" : "text-accent",
              )}
            />
            <select
              aria-label="Model"
              className="max-w-[96px] bg-transparent font-semibold outline-none sm:max-w-[140px]"
              value={modelValue || modelOptions[0]?.value || modelLabel}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={modelOptions.length === 0}
            >
              {modelOptions.length === 0 ? (
                <option>{modelLabel}</option>
              ) : (
                modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.name ?? option.value}
                  </option>
                ))
              )}
            </select>
            <ChevronDown className="h-4 w-4 text-muted" />
          </label>
          <Button
            onClick={onSend}
            disabled={!canSend}
            className={cn(
              "ml-auto h-10 rounded-full px-4 text-[15px] sm:h-11 sm:px-5 sm:text-[16px]",
              !canSend && "bg-disabledSend text-white opacity-100",
            )}
          >
            <Send className="h-4 w-4" />
            Send
          </Button>
        </div>
        <p className="mt-4 px-1 text-xs text-muted">
          {blockedReason ||
            "回车发送，Shift+Enter 发起新的一行。回复由模型返回，不代表平台立场，请注意甄别"}
        </p>
      </div>
    </div>
  );
}

function SessionMetaSettingsSection({
  templates,
  templateId,
  json,
  error,
  summary,
  onTemplateChange,
  onJSONChange,
}: {
  templates: SessionMetaTemplate[];
  templateId: string;
  json: string;
  error?: string;
  summary: string;
  onTemplateChange: (value: string) => void;
  onJSONChange: (value: string) => void;
}) {
  return (
    <section className="mt-8 rounded-[24px] border border-border bg-background/70 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Session create params
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {summary}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onTemplateChange(template.id)}
            className={cn(
              "rounded-[14px] border px-3 py-2 text-left transition-colors",
              templateId === template.id
                ? "border-accent bg-selected text-foreground"
                : "border-border bg-background/70 text-muted hover:bg-selected",
            )}
            title={template.description}
          >
            <span className="block text-sm font-semibold">
              {template.name}
            </span>
          </button>
        ))}
      </div>
      <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-muted">
        JSON merged into session/new params
      </label>
      <Textarea
        value={json}
        onChange={(event) => onJSONChange(event.target.value)}
        spellCheck={false}
        className={cn(
          "mt-2 min-h-[150px] rounded-[16px] border border-border bg-input font-mono text-xs leading-5",
          error && "border-accent text-accent",
        )}
      />
      <div
        className={cn(
          "mt-3 rounded-[14px] px-3 py-2 text-xs leading-5",
          error
            ? "bg-accent/10 text-accent"
            : "bg-background/70 text-muted",
        )}
      >
        {error
          ? `Invalid JSON: ${error}`
          : "This only applies when a new ACP session is created."}
      </div>
    </section>
  );
}

function getSpeechRecognitionConstructor():
  | BrowserSpeechRecognitionConstructor
  | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function appendVoiceTranscript(baseInput: string, transcript: string) {
  const next = transcript.trim();
  if (!next) return baseInput;
  if (!baseInput) return next;
  return /\s$/.test(baseInput) ? `${baseInput}${next}` : `${baseInput} ${next}`;
}

export function parseSessionCreateMetaJSON(raw: string): {
  value?: Record<string, unknown>;
  error?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { value: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "expected a JSON object" };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "parse failed",
    };
  }
}

export function summarizeSessionCreateMeta(meta?: Record<string, unknown>) {
  const cloudagent = readRecord(meta?._meta)?.cloudagent;
  const backend = readRecord(cloudagent)?.sandbox_backend;
  const templateID = readRecord(cloudagent)?.sandbox_template_id;
  if (typeof backend === "string" && backend.trim()) {
    if (typeof templateID === "string" && templateID.trim()) {
      return `Backend: ${backend.trim()} · template ${templateID.trim().slice(0, 8)}`;
    }
    return `Backend: ${backend.trim()}`;
  }
  if (!meta || Object.keys(meta).length === 0) return "Default";
  return "Custom params";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function loadStoredState(): StoredUiState {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return sanitizeStoredUiState(JSON.parse(raw));
  } catch {
    return {};
  }
}

function initialSessionCreateMetaJSON(state: StoredUiState) {
  if (state.sessionMetaTemplateId) {
    const template = SESSION_META_TEMPLATES.find(
      (item) => item.id === state.sessionMetaTemplateId,
    );
    if (template && state.sessionMetaTemplateId !== "custom") {
      return template.json;
    }
  }
  return state.sessionCreateMetaJSON ?? SESSION_META_TEMPLATES[0].json;
}

function resolveInitialGatewayURL(storedGatewayURL?: string) {
  const urlGateway = readGatewayURLFromLocation();
  return urlGateway || storedGatewayURL || "";
}

function readGatewayURLFromLocation() {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("acp_url")?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveStoredState(state: {
  activeSessionId?: string;
  gatewayURL?: string;
  sessionMetaTemplateId?: string;
  sessionCreateMetaJSON?: string;
}) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local persistence is best-effort; ACP state remains authoritative.
  }
}

function emptyConversation(): SessionRow {
  return {
    ...createDraftRow("__empty__", DEFAULT_CWD),
    restoreState: "blocked",
  };
}

function timeLabelSafe() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function Avatar({
  variant = "agent",
  size = "sm",
}: {
  variant?: "agent" | "user";
  size?: "sm" | "lg";
}) {
  const large = size === "lg";
  if (variant === "user") {
    return (
      <div
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-full bg-[#b8d8c2]",
          large ? "h-20 w-20" : "h-10 w-10",
        )}
      >
        <Bot className={cn("text-panel", large ? "h-9 w-9" : "h-5 w-5")} />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-[#371414]",
        large ? "mx-auto h-20 w-20" : "h-10 w-10",
      )}
    >
      <div
        className={cn(
          "absolute rounded-full bg-[#ff4d00]",
          large ? "-bottom-8 -left-6 h-16 w-16" : "-bottom-4 -left-3 h-9 w-9",
        )}
      />
      <div
        className={cn(
          "absolute rounded-full bg-[#ff7b00]",
          large ? "bottom-1 left-4 h-12 w-12" : "bottom-0 left-2 h-6 w-6",
        )}
      />
      <div
        className={cn(
          "absolute rounded-full bg-panel",
          large ? "bottom-3 right-2 h-11 w-11" : "bottom-1 right-1 h-6 w-6",
        )}
      />
      <div
        className={cn(
          "absolute rounded-full bg-[#e74d1d]",
          large ? "bottom-7 right-7 h-2 w-2" : "bottom-4 right-4 h-1.5 w-1.5",
        )}
      />
    </div>
  );
}

function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    if (file.type.startsWith("image/")) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}
