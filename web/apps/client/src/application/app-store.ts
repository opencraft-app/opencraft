import {
  agentMentionEligibility,
  channelAddress,
  conversationCapabilities,
  composerDocumentHasContent,
  createComposerDocument,
  directAddress,
  mergeMessages,
  isOperationTerminal,
  planComposerSubmission,
  pollOperation,
  PlatformError,
  type AttachmentSource,
  type AcceptedResource,
  type Account,
  type ActiveConversation,
  type Agent,
  type AgentProfileCapabilities,
  type Channel,
  type Computer,
  type ComposerDraft,
  type ComposerSubmission,
  type ConversationAddress,
  type CreateAgentInput,
  type CreateChannelInput,
  type CreateComputerInput,
  type CreateDirectConversationResult,
  type CreateInviteInput,
  type CreateReminderInput,
  type CreateServerInput,
  type CreateServerResult,
  type CreateTaskInput,
  type ConversationSummary,
  type DirectConversation,
  type DirectConversationResource,
  type HumanImSession,
  type InboxItem,
  type Invite,
  type InviteSecret,
  type JoinResult,
  type Member,
  type Message,
  type MessageReference,
  type MessageThread,
  type MessageQuote,
  type MessagingLifecycleEvent,
  type MessagingPort,
  type Operation,
  type RegistrationScript,
  type RegisterInput,
  type Reminder,
  type Server,
  type Task,
  type TerminalSession,
  type ThreadReplyReference,
  type ThreadReplyReferencePage,
  type UpdateAgentInput,
  type UpdateChannelInput,
  type UpdateMemberInput,
  type UpdateReminderInput,
  type UpdateServerInput,
  type UpdateTaskInput,
  isEveryoneChannel,
} from "@vela/client-core";
import { createStore, type StoreApi } from "zustand/vanilla";

import { productErrorMessage } from "./product-language";
import {SubmissionCoordinator} from "./submission-coordinator";

type AuthStatus =
  | "checking"
  | "recovery_error"
  | "signed_out"
  | "signing_in"
  | "signed_in";

type LoadStatus = "error" | "idle" | "loading" | "ready";

export type HumanImStatus =
  | "signed_out"
  | "issuing_session"
  | "logging_in"
  | "waiting_sdk_ready"
  | "ready"
  | "not_ready"
  | "kicked_out"
  | "error";

export interface HumanImViewState {
  message?: string;
  network?: "connecting" | "connected" | "disconnected";
  status: HumanImStatus;
}

export interface PlatformPort {
  acceptJoinLink(
    token: string,
    idempotencyKey: string,
  ): Promise<JoinResult>;
  acceptInvite(
    token: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  addChannelMember(
    serverId: string,
    channelId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  agentAction(
    serverId: string,
    agentId: string,
    action: "deploy" | "restart" | "start" | "stop",
    idempotencyKey: string,
  ): Promise<Operation>;
  cancelReminder(
    serverId: string,
    reminderId: string,
    revision: number,
    idempotencyKey: string,
  ): Promise<void>;
  createChannel(
    serverId: string,
    input: CreateChannelInput,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  createHumanImSession(): Promise<HumanImSession>;
  createAgent(
    serverId: string,
    input: CreateAgentInput,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  deleteAgent(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  createComputer(
    serverId: string,
    input: CreateComputerInput,
    idempotencyKey: string,
  ): Promise<Computer>;
  createDirectConversation(
    serverId: string,
    peerMemberId: string,
    idempotencyKey: string,
  ): Promise<CreateDirectConversationResult>;
  removeComputer(
    serverId: string,
    computerId: string,
    idempotencyKey: string,
  ): Promise<void>;
  createComputerRegistrationScript(
    serverId: string,
    computerId: string,
    revision: number,
  ): Promise<RegistrationScript>;
  createInvite(
    serverId: string,
    input: CreateInviteInput,
  ): Promise<InviteSecret>;
  createReminder(
    serverId: string,
    input: CreateReminderInput,
    idempotencyKey: string,
  ): Promise<Reminder>;
  createServer(
    input: CreateServerInput,
    idempotencyKey: string,
  ): Promise<CreateServerResult>;
  createTerminalSession(
    serverId: string,
    computerId: string,
  ): Promise<TerminalSession>;
  getOperation(serverId: string, operationId: string): Promise<Operation>;
  getDirectConversation(
    serverId: string,
    directConversationId: string,
  ): Promise<DirectConversationResource>;
  getServer(serverId: string): Promise<Server>;
  ensureThread(
    serverId: string,
    channelId: string,
    input: { rootMessageRef: MessageReference },
    idempotencyKey: string,
  ): Promise<MessageThread>;
  createTask(
    serverId: string,
    input: CreateTaskInput,
    idempotencyKey: string,
  ): Promise<Task>;
  listAgents(serverId: string): Promise<Agent[]>;
  getAgentProfileCapabilities(
    serverId: string,
    agentId: string,
  ): Promise<AgentProfileCapabilities>;
  refreshAgentProfileCapabilities(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<Operation>;
  listChannelMembers(serverId: string, channelId: string): Promise<Member[]>;
  listChannels(serverId: string): Promise<Channel[]>;
  listComputers(serverId: string): Promise<Computer[]>;
  listDirectConversations(
    serverId: string,
  ): Promise<DirectConversationResource[]>;
  listInvites(serverId: string): Promise<Invite[]>;
  listMembers(serverId: string): Promise<Member[]>;
  listReminders(serverId: string): Promise<Reminder[]>;
  listServers(): Promise<Server[]>;
  listInbox(serverId: string): Promise<InboxItem[]>;
  listTasks(serverId: string): Promise<Task[]>;
  listThreadReplies(
    serverId: string,
    channelId: string,
    threadId: string,
    cursor?: string,
  ): Promise<ThreadReplyReferencePage>;
  login(email: string, password: string): Promise<Account>;
  logout(): Promise<unknown>;
  removeChannelMember(
    serverId: string,
    channelId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  removeMember(
    serverId: string,
    memberId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  rotateAgentRuntimeCredential(
    serverId: string,
    agentId: string,
    idempotencyKey: string,
  ): Promise<Operation>;
  markThreadRead(
    serverId: string,
    channelId: string,
    threadId: string,
    lastReadRefId: string,
    idempotencyKey: string,
  ): Promise<void>;
  registerThreadReply(
    serverId: string,
    channelId: string,
    threadId: string,
    input: { messageRef: MessageReference },
    idempotencyKey: string,
  ): Promise<ThreadReplyReference>;
  register(input: RegisterInput): Promise<Account>;
  restore(): Promise<Account>;
  revokeInvite(serverId: string, inviteId: string): Promise<void>;
  retryDirectConversation(
    serverId: string,
    directConversationId: string,
    idempotencyKey: string,
  ): Promise<AcceptedResource>;
  updateAgent(
    serverId: string,
    agentId: string,
    input: UpdateAgentInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Agent>;
  updateChannel(
    serverId: string,
    channelId: string,
    input: UpdateChannelInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Channel>;
  updateServer(
    serverId: string,
    input: UpdateServerInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Server>;
  updateMember(
    serverId: string,
    memberId: string,
    input: UpdateMemberInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Member>;
  updateReminder(
    serverId: string,
    reminderId: string,
    input: UpdateReminderInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Reminder>;
  updateTask(
    serverId: string,
    taskId: string,
    input: UpdateTaskInput,
    revision: number,
    idempotencyKey: string,
  ): Promise<Task>;
}

export type AppMessagingPort = Pick<
  MessagingPort,
  | "close"
  | "connect"
  | "listConversations"
  | "loadHistory"
  | "loadMessageContext"
  | "loadMessagesByReferences"
  | "markRead"
  | "reconcileMessage"
  | "retryMessage"
  | "revokeMessage"
  | "searchMessages"
  | "sendAttachment"
  | "sendTask"
  | "sendText"
  | "setScope"
  | "setReaction"
  | "subscribeConversations"
  | "subscribeLifecycle"
  | "subscribeMessages"
  | "waitUntilReady"
>;

export interface DirectSendIntent {
  accountId: string;
  clientRequestId: string;
  createdAt: string;
  directConversationId?: string;
  idempotencyKey: string;
  kind: "text";
  mentionedUserIds: string[];
  peerMemberId: string;
  phase: "preparing" | "sending" | "uncertain";
  schemaVersion: 1;
  serverId: string;
  text: string;
  updatedAt: string;
}

export interface DirectSendIntentStore {
  load(key: string): Promise<DirectSendIntent | null>;
  remove(key: string): Promise<void>;
  save(key: string, intent: DirectSendIntent): Promise<void>;
}

export interface AppStoreDependencies {
  connectMessaging?: () => Promise<void>;
  createRequestId?: () => string;
  directSendIntents?: DirectSendIntentStore;
  messaging: AppMessagingPort;
  operationPollNow?: () => number;
  operationPollSleep?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  platform: PlatformPort;
  provisioningPollIntervalMs?: number;
  provisioningPollLimit?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type OperationPollingState =
  | "idle"
  | "polling"
  | "terminal"
  | "timed_out"
  | "rate_limited"
  | "query_error";

export interface TrackedOperation {
  message?: string;
  operation: Operation;
  pollingState: OperationPollingState;
  resourceId?: string;
  retryAfterSeconds?: number;
}

export interface CreateWorkspaceInput {
  channelName: string;
  serverName: string;
  serverSlug: string;
  visibility: "private" | "public";
}

export interface RefreshOptions {
  force?: boolean;
}

export interface CreateAgentOptions {
  deployAndStart?: boolean;
}

export interface AppStoreState {
  account: Account | null;
  activeConversation: ActiveConversation | null;
  activeThread: MessageThread | null;
  agents: Agent[];
  agentProfileCapabilitiesById: Record<string, AgentProfileCapabilities>;
  authStatus: AuthStatus;
  channelMembers: Member[];
  channels: Channel[];
  computers: Computer[];
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  currentChannelId: string | null;
  currentServerId: string | null;
  directConversations: DirectConversation[];
  directConversationSync: "complete" | "idle" | "pending";
  error: string | null;
  historyCompleted: boolean;
  historyCursor: string | null;
  inbox: InboxItem[];
  invites: Invite[];
  imState: HumanImViewState;
  joinLinkErrorKind: "identity_pending" | "retryable" | "terminal" | null;
  loadingChannel: boolean;
  loadingOlderMessages: boolean;
  loadingAgents: boolean;
  loadingComputers: boolean;
  loadingOrganization: boolean;
  loadingReminders: boolean;
  loadingWork: boolean;
  messages: Message[];
  messageFocusRequest: {messageId: string; revision: number} | null;
  members: Member[];
  pendingAction: string | null;
  pendingThreadIndexMessageIds: string[];
  operationsById: Record<string, TrackedOperation>;
  provisioningStage: "channel" | "server" | null;
  provisioningWorkspace: boolean;
  searchCompleted: boolean;
  searchCursor: string | null;
  searchError: string | null;
  searchLocateError: string | null;
  locatingSearchResultId: string | null;
  searchingMessages: boolean;
  searchQuery: string;
  searchResults: Message[];
  selectedQuote: MessageQuote | null;
  sendingMessage: boolean;
  sendingThreadReply: boolean;
  serverContextGeneration: number;
  serverContextStatus: LoadStatus;
  servers: Server[];
  submissions: Record<string, ComposerSubmission>;
  serversStatus: LoadStatus;
  targetServerId: string | null;
  tasks: Task[];
  reminders: Reminder[];
  threadCompleted: boolean;
  threadCursor: string | null;
  threadLoading: boolean;
  threadMessages: Message[];
  threadRootMessage: Message | null;
  createAgent(
    input: CreateAgentInput,
    options?: CreateAgentOptions,
  ): Promise<AcceptedResource | null>;
  deleteAgent(agentId: string): Promise<AcceptedResource | null>;
  acceptJoinLink(token: string): Promise<JoinResult | null>;
  acceptInvite(token: string): Promise<AcceptedResource | null>;
  addChannelMember(memberId: string): Promise<void>;
  createChannel(input: CreateChannelInput): Promise<AcceptedResource | null>;
  createComputer(input: CreateComputerInput): Promise<Computer | null>;
  removeComputer(computerId: string): Promise<boolean>;
  createInvite(input: CreateInviteInput): Promise<InviteSecret | null>;
  createTask(input: CreateTaskInput): Promise<void>;
  createReminder(input: CreateReminderInput): Promise<Reminder | null>;
  createTaskFromMessage(messageId: string): Promise<void>;
  createWorkspace(input: CreateWorkspaceInput): Promise<void>;
  clearMessageSearch(): void;
  clearQuote(): void;
  closeThread(): void;
  initialize(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  retryInitialization(): Promise<void>;
  retryServers(): Promise<void>;
  refreshWork(options?: RefreshOptions): Promise<void>;
  refreshAgents(options?: RefreshOptions): Promise<void>;
  refreshAgentProfileCapabilities(agentId: string): Promise<Operation | null>;
  refreshComputers(options?: RefreshOptions): Promise<void>;
  refreshDirectConversations(): Promise<void>;
  refreshOrganization(options?: RefreshOptions): Promise<void>;
  reconnectIm(): Promise<void>;
  loadOlderMessages(): Promise<void>;
  loadMoreSearchResults(): Promise<void>;
  locateSearchResult(messageId: string): Promise<void>;
  loadMoreThreadReplies(): Promise<void>;
  openThread(messageId: string): Promise<void>;
  removeChannelMember(memberId: string): Promise<void>;
  removeMember(memberId: string): Promise<void>;
  requestComputerRegistrationScript(
    computerId: string,
  ): Promise<RegistrationScript | null>;
  createComputerTerminalSession(
    computerId: string,
  ): Promise<TerminalSession | null>;
  cancelOperationPolling(operationId?: string): void;
  cancelReminder(reminderId: string): Promise<void>;
  continueOperationPolling(operationId: string): Promise<void>;
  refreshOperation(operationId: string): Promise<Operation | null>;
  refreshReminders(options?: RefreshOptions): Promise<void>;
  rotateAgentCredential(agentId: string): Promise<Operation | null>;
  runAgentAction(
    agentId: string,
    action: "deploy" | "restart" | "start" | "stop",
  ): Promise<Operation | null>;
  revokeInvite(inviteId: string): Promise<void>;
  revokeMessage(messageId: string): Promise<void>;
  quoteMessage(messageId: string): void;
  searchMessages(query: string): Promise<void>;
  retryMessage(messageId: string): Promise<void>;
  retryThreadReplyIndex(messageId: string): Promise<void>;
  selectChannel(channelId: string): Promise<void>;
  selectDirectConversation(peerUserId: string): Promise<void>;
  selectServer(serverId: string): Promise<void>;
  sendAttachment(input: {
    kind: "file" | "image";
    source: AttachmentSource;
  }): Promise<void>;
  sendMessage(input: {
    mentionedUserIds: string[];
    text: string;
  }): Promise<void>;
  sendComposerDraft(draft: ComposerDraft): Promise<void>;
  sendThreadReply(input: {
    mentionedUserIds: string[];
    text: string;
  }): Promise<void>;
  toggleReaction(messageId: string, reactionId: string): Promise<void>;
  updateTask(taskId: string, input: UpdateTaskInput): Promise<void>;
  updateAgent(agentId: string, input: UpdateAgentInput): Promise<void>;
  updateChannel(channelId: string, input: UpdateChannelInput): Promise<void>;
  updateServer(input: UpdateServerInput): Promise<boolean>;
  updateMember(memberId: string, input: UpdateMemberInput): Promise<void>;
  updateReminder(reminderId: string, input: UpdateReminderInput): Promise<void>;
  updateConversationDraft(draft: ComposerDraft): void;
}

export function createAppStore(
  dependencies: AppStoreDependencies,
): StoreApi<AppStoreState> {
  let initializePromise: Promise<void> | null = null;
  let serverSelection = 0;
  let serverSelectionFlight: {
    promise: Promise<void>;
    serverId: string;
  } | null = null;
  let conversationSelection = 0;
  const channelMembershipRepairs = new Set<string>();
  let imConnection = 0;
  let directConversationEpoch = 0;
  let directConversationActive = false;
  let directConversationSyncGeneration = 0;
  let serverUpdateAttempt: {
    fingerprint: string;
    idempotencyKey: string;
  } | null = null;
  let imRecoveryPromise: Promise<void> | null = null;
  let manualReconnectPromise: Promise<void> | null = null;
  let userSigRecoveryUsed = false;
  let operationPollGeneration = 0;
  const refreshFlights = new Map<string, Promise<void>>();
  const resourceRefreshedAt = new Map<string, number>();
  const operationPollFlights = new Map<
    string,
    {
      controller: AbortController;
      generation: number;
      promise: Promise<void>;
    }
  >();
  const requestId = dependencies.createRequestId ?? defaultRequestId;
  const pollInterval = dependencies.provisioningPollIntervalMs ?? 500;
  const pollLimit = dependencies.provisioningPollLimit ?? 40;
  const sleep = dependencies.sleep ?? delay;
  const refreshFreshnessMs = 15_000;
  const channelReadinessPollIntervalMs = 1_000;
  const channelReadinessPollLimit = 15;

  function refreshKey(serverId: string, resource: string): string {
    return `${serverId}:${resource}`;
  }

  function resourceIsFresh(key: string, force = false): boolean {
    if (force) return false;
    const refreshedAt = resourceRefreshedAt.get(key);
    return refreshedAt !== undefined && Date.now() - refreshedAt < refreshFreshnessMs;
  }

  function markResourceFresh(key: string): void {
    resourceRefreshedAt.set(key, Date.now());
  }

  function runRefreshSingleFlight(
    key: string,
    refresh: () => Promise<void>,
  ): Promise<void> {
    const current = refreshFlights.get(key);
    if (current) return current;
    const promise = refresh().finally(() => {
      if (refreshFlights.get(key) === promise) {
        refreshFlights.delete(key);
      }
    });
    refreshFlights.set(key, promise);
    return promise;
  }

  let submissionCoordinator: SubmissionCoordinator;
  const store = createStore<AppStoreState>((set, get) => ({
    account: null,
    activeConversation: null,
    activeThread: null,
    agents: [],
    agentProfileCapabilitiesById: {},
    authStatus: "checking",
    channelMembers: [],
    channels: [],
    computers: [],
    conversationDrafts: {},
    conversationSummaries: [],
    currentChannelId: null,
    currentServerId: null,
    directConversations: [],
    directConversationSync: "idle",
    error: null,
    historyCompleted: true,
    historyCursor: null,
    inbox: [],
    invites: [],
    imState: { status: "signed_out" },
    joinLinkErrorKind: null,
    loadingChannel: false,
    loadingOlderMessages: false,
    loadingAgents: false,
    loadingComputers: false,
    loadingOrganization: false,
    loadingReminders: false,
    loadingWork: false,
    messages: [],
    messageFocusRequest: null,
    members: [],
    pendingAction: null,
    pendingThreadIndexMessageIds: [],
    operationsById: {},
    provisioningStage: null,
    provisioningWorkspace: false,
    searchCompleted: true,
    searchCursor: null,
    searchError: null,
    searchLocateError: null,
    locatingSearchResultId: null,
    searchingMessages: false,
    searchQuery: "",
    searchResults: [],
    selectedQuote: null,
    sendingMessage: false,
    sendingThreadReply: false,
    serverContextGeneration: 0,
    serverContextStatus: "idle",
    servers: [],
    submissions: {},
    serversStatus: "idle",
    targetServerId: null,
    tasks: [],
    reminders: [],
    threadCompleted: true,
    threadCursor: null,
    threadLoading: false,
    threadMessages: [],
    threadRootMessage: null,

    clearQuote() {
      set({ selectedQuote: null });
    },

    clearMessageSearch() {
      set({
        searchCompleted: true,
        searchCursor: null,
        searchError: null,
        searchLocateError: null,
        locatingSearchResultId: null,
        searchingMessages: false,
        searchQuery: "",
        searchResults: [],
      });
    },

    updateConversationDraft(draft) {
      const key = conversationDraftKey(get().activeConversation);
      if (!key) return;
      set((current) => {
        const conversationDrafts = { ...current.conversationDrafts };
        if (
          !composerDocumentHasContent(draft.document) &&
          draft.attachments.length === 0
        ) {
          delete conversationDrafts[key];
        } else {
          conversationDrafts[key] = cloneComposerDraft(draft);
        }
        return { conversationDrafts };
      });
    },

    closeThread() {
      set({
        activeThread: null,
        pendingThreadIndexMessageIds: [],
        sendingThreadReply: false,
        threadCompleted: true,
        threadCursor: null,
        threadLoading: false,
        threadMessages: [],
        threadRootMessage: null,
      });
    },

    async acceptInvite(token) {
      const action = "invite:accept";
      if (get().pendingAction) return null;
      set({ error: null, pendingAction: action });
      try {
        const accepted = await dependencies.platform.acceptInvite(
          token.trim(),
          `${requestId()}:invite:accept`,
        );
        trackOperations(accepted.operations, accepted.resourceId);
        const servers = await dependencies.platform.listServers();
        set({ pendingAction: null, servers });
        return accepted;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async acceptJoinLink(token) {
      const action = "join-link:accept";
      if (get().pendingAction) return null;
      set({error: null, joinLinkErrorKind: null, pendingAction: action});
      let joined: JoinResult;
      try {
        joined = await dependencies.platform.acceptJoinLink(
          token.trim(),
          `${requestId()}:join-link:accept`,
        );
      } catch (error) {
        set({
          error: errorMessage(error),
          joinLinkErrorKind:
            error instanceof PlatformError &&
            error.platformCode === "invite_invalid"
              ? "terminal"
              : error instanceof PlatformError &&
                  error.platformCode === "im_identity_not_ready"
                ? "identity_pending"
              : "retryable",
          pendingAction: null,
        });
        return null;
      }

      trackOperations(joined.operations, joined.memberId);
      set({joinLinkErrorKind: null, pendingAction: null});
      try {
        const servers = await dependencies.platform.listServers();
        set({
          servers,
          serversStatus: "ready",
        });
        await get().selectServer(joined.serverId);
        if (get().imState.status !== "ready") {
          await get().reconnectIm();
        }
        if (get().imState.status === "ready") {
          await get().selectChannel(joined.landingChannelId);
        }
      } catch (error) {
        set({error: errorMessage(error)});
      }
      return joined;
    },

    async addChannelMember(memberId) {
      await changeCurrentChannelMember(memberId, "add");
    },

    async createAgent(input, options) {
      const action = "agent:create";
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      let accepted: AcceptedResource;
      try {
        accepted = await dependencies.platform.createAgent(
          serverId,
          input,
          `${requestId()}:agent:create`,
        );
        trackOperations(accepted.operations, accepted.resourceId);
        const agents = await dependencies.platform.listAgents(serverId);
        if (get().currentServerId !== serverId) return accepted;
        set({agents});
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({error: errorMessage(error), pendingAction: null});
        }
        return null;
      }
      if (!options?.deployAndStart) {
        set({pendingAction: null});
        return accepted;
      }
      try {
        const ready = await waitForAgent(
          serverId,
          accepted.resourceId,
          (agent) => agent.imState === "ready",
          "Agent 身份仍在创建中，请稍后再部署",
        );
        if (!ready) return accepted;
        set({pendingAction: `agent:${accepted.resourceId}:deploy`});
        const deployedOperation = await dependencies.platform.agentAction(
          serverId,
          accepted.resourceId,
          "deploy",
          `${requestId()}:agent:deploy`,
        );
        if (get().currentServerId !== serverId) return accepted;
        trackOperations([deployedOperation], accepted.resourceId);
        const deployed = await waitForAgent(
          serverId,
          accepted.resourceId,
          (agent) =>
            agent.imState === "ready" &&
            agent.credentialVersion > 0 &&
            agent.observedState === "stopped",
          "Agent 部署仍在处理中，请稍后手动启动",
        );
        if (!deployed) return accepted;
        set({pendingAction: `agent:${accepted.resourceId}:start`});
        const startedOperation = await dependencies.platform.agentAction(
          serverId,
          accepted.resourceId,
          "start",
          `${requestId()}:agent:start`,
        );
        if (get().currentServerId !== serverId) return accepted;
        trackOperations([startedOperation], accepted.resourceId);
        const agents = await dependencies.platform.listAgents(serverId);
        if (get().currentServerId === serverId) {
          set({agents, pendingAction: null});
        }
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({error: errorMessage(error), pendingAction: null});
        }
      }
      return accepted;
    },

    async deleteAgent(agentId) {
      const action = `agent:${agentId}:delete`;
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      const agent = state.agents.find((item) => item.id === agentId);
      if (!serverId || !agent) {
        set({ error: "Agent 不存在或已被删除" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const accepted = await dependencies.platform.deleteAgent(
          serverId,
          agentId,
          `${requestId()}:agent:delete`,
        );
        if (get().currentServerId !== serverId) return null;
        trackOperations(accepted.operations, accepted.resourceId);
        set((current) => ({
          agents: current.agents.filter((item) => item.id !== agentId),
          pendingAction: null,
        }));
        return accepted;
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error), pendingAction: null });
        }
        return null;
      }
    },

    async createComputer(input) {
      const action = "computer:create";
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const computer = await dependencies.platform.createComputer(
          serverId,
          input,
          `${requestId()}:computer:create`,
        );
        set((current) => ({
          computers: upsertComputer(current.computers, computer),
          pendingAction: null,
        }));
        return computer;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async removeComputer(computerId) {
      const action = "computer:remove";
      const state = get();
      if (state.pendingAction) return false;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({error: "请先选择 Server"});
        return false;
      }
      const boundAgentCount = state.agents.reduce(
        (count, agent) => count + Number(agent.computerId === computerId),
        0,
      );
      if (boundAgentCount > 0) {
        set({error: `请先迁移或解绑 ${boundAgentCount} 个 Agent`});
        return false;
      }
      set({error: null, pendingAction: action});
      try {
        await dependencies.platform.removeComputer(
          serverId,
          computerId,
          `${requestId()}:computer:remove`,
        );
        set((current) => ({
          computers: current.computers.filter(
            (candidate) => candidate.id !== computerId,
          ),
          pendingAction: null,
        }));
        return true;
      } catch (error) {
        set({error: errorMessage(error), pendingAction: null});
        return false;
      }
    },

    async createChannel(input) {
      const action = "channel:create";
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const accepted = await dependencies.platform.createChannel(
          serverId,
          input,
          `${requestId()}:channel:create`,
        );
        trackOperations(accepted.operations, accepted.resourceId);
        const created = await waitForChannel(serverId, accepted.resourceId);
        const channels = await dependencies.platform.listChannels(serverId);
        await applyMessagingScope(
          channels,
          get().directConversations,
          get().serverContextGeneration,
        );
        set({ channels, pendingAction: null });
        if (get().imState.status === "ready") {
          void syncConversationSummaries(imConnection);
        }
        await get().selectChannel(created.id);
        return accepted;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async createInvite(input) {
      const action = "invite:create";
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const secret = await dependencies.platform.createInvite(
          serverId,
          input,
        );
        set((current) => ({
          invites: upsertInvite(current.invites, secret.invite),
          pendingAction: null,
        }));
        return secret;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async createTask(input) {
      const action = "task:create";
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const task = await dependencies.platform.createTask(
          serverId,
          input,
          `${requestId()}:task:create`,
        );
        const inbox = await dependencies.platform.listInbox(serverId);
        set((current) => ({
          inbox,
          pendingAction: null,
          tasks: upsertTask(current.tasks, task),
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async createReminder(input) {
      const action = "reminder:create";
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const reminder = await dependencies.platform.createReminder(
          serverId,
          input,
          `${requestId()}:reminder:create`,
        );
        if (get().currentServerId !== serverId) return null;
        set((current) => ({
          pendingAction: null,
          reminders: sortReminders(upsertReminder(current.reminders, reminder)),
        }));
        return reminder;
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error), pendingAction: null });
        }
        return null;
      }
    },

    async cancelReminder(reminderId) {
      const action = `reminder:${reminderId}:cancel`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const reminder = state.reminders.find((item) => item.id === reminderId);
      if (!reminder) {
        set({ error: "Reminder 不存在" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        await dependencies.platform.cancelReminder(
          serverId,
          reminderId,
          reminder.revision,
          `${requestId()}:reminder:cancel`,
        );
        if (get().currentServerId !== serverId) return;
        set((current) => ({
          pendingAction: null,
          reminders: current.reminders.filter((item) => item.id !== reminderId),
        }));
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error), pendingAction: null });
        }
      }
    },

    async createTaskFromMessage(messageId) {
      const state = get();
      if (state.pendingAction) return;
      if (state.activeConversation?.kind !== "channel") {
        set({ error: "私信消息不能转为 Server Task" });
        return;
      }
      const serverId = state.currentServerId;
      const channel = state.channels.find(
        (item) => item.id === state.currentChannelId,
      );
      const message = state.messages.find((item) => item.id === messageId);
      const address = channel ? channelAddress(channel) : null;
      if (!serverId || !channel || !message || !address) {
        set({ error: "当前消息不能转为 Task" });
        return;
      }
      const workflowId = requestId();
      const sourceMessageRef = {
        groupId: channel.imGroupId ?? null,
        kind: "group" as const,
        messageId: message.id,
        senderUserId: message.senderId,
        topicId: channel.imTopicId ?? null,
      };
      set({ error: null, pendingAction: "task:create-from-message" });
      try {
        const task = await dependencies.platform.createTask(
          serverId,
          {
            sourceMessageRef,
            title: message.text.slice(0, 120) || "来自聊天的 Task",
          },
          `${workflowId}:task:create`,
        );
        const inbox = await dependencies.platform.listInbox(serverId);
        let taskMessage: Message | null = null;
        let publishWarning: string | null = null;
        try {
          taskMessage = await dependencies.messaging.sendTask({
            channel: address,
            clientRequestId: `${workflowId}:task-message`,
            task: {
              ...(task.ownerMemberId ? { assigneeId: task.ownerMemberId } : {}),
              sourceMessageRef,
              status: task.status,
              taskId: task.id,
              title: task.title,
            },
          });
        } catch (error) {
          publishWarning = `Task 已创建，但聊天卡片发送失败：${errorMessage(error)}`;
        }
        set((current) => ({
          error: publishWarning,
          inbox,
          messages: taskMessage
            ? mergeMessages(current.messages, [taskMessage])
            : current.messages,
          pendingAction: null,
          tasks: upsertTask(current.tasks, task),
        }));
      } catch (error) {
        set({
          error: errorMessage(error),
          pendingAction: null,
        });
      }
    },

    async createWorkspace(input) {
      if (get().provisioningWorkspace) {
        return;
      }
      const workflowId = requestId();
      set({
        error: null,
        provisioningStage: get().currentServerId ? "channel" : "server",
        provisioningWorkspace: true,
      });

      try {
        let activeServer = currentServer(get());
        if (!activeServer) {
          const result = await dependencies.platform.createServer(
            {
              name: input.serverName.trim(),
              slug: input.serverSlug.trim(),
            },
            `${workflowId}:server`,
          );
          if (result.kind === "accepted") {
            trackOperations(
              result.accepted.operations,
              result.accepted.resourceId,
            );
          }
          activeServer =
            result.kind === "ready"
              ? result.resource
              : await waitForServer(result.accepted.resourceId);
          set((current) => ({
            currentServerId: activeServer?.id ?? null,
            provisioningStage: "channel",
            servers: upsertServer(current.servers, activeServer as Server),
          }));
        } else {
          set({ provisioningStage: "channel" });
        }

        const accepted = await dependencies.platform.createChannel(
          activeServer.id,
          {
            name: input.channelName.trim(),
            visibility: input.visibility,
          },
          `${workflowId}:channel`,
        );
        trackOperations(accepted.operations, accepted.resourceId);
        const createdChannel = await waitForChannel(
          activeServer.id,
          accepted.resourceId,
        );
        await get().selectServer(activeServer.id);
        if (get().currentChannelId !== createdChannel.id) {
          await get().selectChannel(createdChannel.id);
        }
        if (get().imState.status !== "ready") {
          await connectIm();
        }
        set({
          error: null,
          provisioningStage: null,
          provisioningWorkspace: false,
          searchCompleted: true,
          searchCursor: null,
          searchError: null,
          searchLocateError: null,
          locatingSearchResultId: null,
          messageFocusRequest: null,
          searchingMessages: false,
          searchQuery: "",
          searchResults: [],
          selectedQuote: null,
        });
      } catch (error) {
        set({
          error: errorMessage(error),
          provisioningStage: null,
          provisioningWorkspace: false,
        });
      }
    },

    async initialize() {
      if (initializePromise) {
        return initializePromise;
      }
      initializePromise = (async () => {
        set({ authStatus: "checking", error: null });
        try {
          const account = await dependencies.platform.restore();
          await bootstrap(account);
        } catch (error) {
          if (isAuthenticationRequired(error)) {
            set({ authStatus: "signed_out", error: null });
          } else {
            set({
              authStatus: "recovery_error",
              error: errorMessage(error),
            });
          }
        }
      })();
      return initializePromise;
    },

    async login(email, password) {
      set({ authStatus: "signing_in", error: null });
      try {
        const account = await dependencies.platform.login(email, password);
        await bootstrap(account);
      } catch (error) {
        set({
          authStatus: "signed_out",
          error: errorMessage(error),
        });
      }
    },

    async logout() {
      cancelOperationPolls();
      imConnection += 1;
      directConversationEpoch += 1;
      directConversationActive = false;
      directConversationSyncGeneration += 1;
      try {
        await dependencies.messaging.close();
        await dependencies.platform.logout();
      } finally {
        initializePromise = null;
        serverSelection += 1;
        conversationSelection += 1;
        set({
          account: null,
          activeConversation: null,
          activeThread: null,
          agents: [],
          authStatus: "signed_out",
          channelMembers: [],
          channels: [],
          computers: [],
          conversationDrafts: {},
          conversationSummaries: [],
          currentChannelId: null,
          currentServerId: null,
          directConversations: [],
          directConversationSync: "idle",
          error: null,
          historyCompleted: true,
          historyCursor: null,
          inbox: [],
          invites: [],
          imState: { status: "signed_out" },
          loadingWork: false,
          loadingOlderMessages: false,
          loadingAgents: false,
          loadingComputers: false,
          loadingOrganization: false,
          loadingReminders: false,
          messages: [],
          messageFocusRequest: null,
          members: [],
          pendingAction: null,
          pendingThreadIndexMessageIds: [],
          operationsById: {},
          provisioningStage: null,
          provisioningWorkspace: false,
          searchCompleted: true,
          searchCursor: null,
          searchError: null,
          searchLocateError: null,
          locatingSearchResultId: null,
          searchingMessages: false,
          searchQuery: "",
          searchResults: [],
          sendingThreadReply: false,
          serverContextGeneration: serverSelection,
          serverContextStatus: "idle",
          servers: [],
          serversStatus: "idle",
          tasks: [],
          reminders: [],
          targetServerId: null,
          threadCompleted: true,
          threadCursor: null,
          threadLoading: false,
          threadMessages: [],
          threadRootMessage: null,
        });
      }
    },

    async register(input) {
      set({ authStatus: "signing_in", error: null });
      try {
        const account = await dependencies.platform.register(input);
        await bootstrap(account);
      } catch (error) {
        set({
          authStatus: "signed_out",
          error: errorMessage(error),
        });
      }
    },

    async retryInitialization() {
      initializePromise = null;
      await get().initialize();
    },

    async retryServers() {
      if (!get().account) return;
      await loadServers();
    },

    async refreshWork(options) {
      const serverId = get().currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const key = refreshKey(serverId, "work");
      if (resourceIsFresh(key, options?.force)) return;
      await runRefreshSingleFlight(key, async () => {
        set({ error: null, loadingWork: true });
        try {
          const [tasks, inbox] = await Promise.all([
            dependencies.platform.listTasks(serverId),
            dependencies.platform.listInbox(serverId),
          ]);
          if (get().currentServerId !== serverId) return;
          markResourceFresh(key);
          set({ inbox, loadingWork: false, tasks });
        } catch (error) {
          if (get().currentServerId === serverId) {
            set({ error: errorMessage(error), loadingWork: false });
          }
        }
      });
    },

    async refreshReminders(options) {
      const serverId = get().currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const key = refreshKey(serverId, "reminders");
      if (resourceIsFresh(key, options?.force)) return;
      await runRefreshSingleFlight(key, async () => {
        set({ error: null, loadingReminders: true });
        try {
          const reminders = await dependencies.platform.listReminders(serverId);
          if (get().currentServerId !== serverId) return;
          markResourceFresh(key);
          set({
            loadingReminders: false,
            reminders: sortReminders(reminders),
          });
        } catch (error) {
          if (get().currentServerId === serverId) {
            set({ error: errorMessage(error), loadingReminders: false });
          }
        }
      });
    },

    async refreshAgents(options) {
      const serverId = get().currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const key = refreshKey(serverId, "agents");
      if (resourceIsFresh(key, options?.force)) return;
      await runRefreshSingleFlight(key, async () => {
        set({ error: null, loadingAgents: true });
        try {
          const agents = await dependencies.platform.listAgents(serverId);
          const capabilityEntries = await Promise.all(
            agents.map(async (agent) => {
              try {
                return [
                  agent.id,
                  await dependencies.platform.getAgentProfileCapabilities(
                    serverId,
                    agent.id,
                  ),
                ] as const;
              } catch {
                return null;
              }
            }),
          );
          if (get().currentServerId !== serverId) return;
          markResourceFresh(key);
          set({
            agents,
            agentProfileCapabilitiesById: Object.fromEntries(
              capabilityEntries.filter(
                (entry): entry is readonly [string, AgentProfileCapabilities] =>
                  entry !== null,
              ),
            ),
            loadingAgents: false,
          });
        } catch (error) {
          if (get().currentServerId === serverId) {
            set({ error: errorMessage(error), loadingAgents: false });
          }
        }
      });
    },

    async refreshAgentProfileCapabilities(agentId) {
      const state = get();
      const serverId = state.currentServerId;
      if (!serverId || state.pendingAction) return null;
      const action = `agent:${agentId}:profile-capabilities:refresh`;
      set({error: null, pendingAction: action});
      try {
        const operation = await dependencies.platform.refreshAgentProfileCapabilities(
          serverId,
          agentId,
          `${requestId()}:agent:profile-capabilities:refresh`,
        );
		trackOperations([operation], agentId);
        const capabilities = await dependencies.platform.getAgentProfileCapabilities(
          serverId,
          agentId,
        );
        set((current) => ({
          agentProfileCapabilitiesById: {
            ...current.agentProfileCapabilitiesById,
            [agentId]: capabilities,
          },
          pendingAction: null,
        }));
        return operation;
      } catch (error) {
        set({error: errorMessage(error), pendingAction: null});
        return null;
      }
    },

    async refreshComputers(options) {
      const serverId = get().currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const key = refreshKey(serverId, "computers");
      if (resourceIsFresh(key, options?.force)) return;
      await runRefreshSingleFlight(key, async () => {
        set({ error: null, loadingComputers: true });
        try {
          const computers = await dependencies.platform.listComputers(serverId);
          if (get().currentServerId !== serverId) return;
          markResourceFresh(key);
          set({ computers, loadingComputers: false });
        } catch (error) {
          if (get().currentServerId === serverId) {
            set({ error: errorMessage(error), loadingComputers: false });
          }
        }
      });
    },

    async refreshDirectConversations() {
      if (!directConversationActive || get().imState.status !== "ready") {
        return;
      }
      await syncDirectConversations(directConversationEpoch);
    },

    async refreshOrganization(options) {
      const serverId = get().currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const membersKey = refreshKey(serverId, "members");
      const invitesKey = refreshKey(serverId, "invites");
      const membersCached = resourceIsFresh(membersKey, options?.force);
      const invitesCached = resourceIsFresh(invitesKey, options?.force);
      if (membersCached && invitesCached) return;
      await runRefreshSingleFlight(
        refreshKey(serverId, "organization"),
        async () => {
          set({ error: null, loadingOrganization: true });
          const [membersResult, invitesResult] = await Promise.allSettled([
            membersCached
              ? Promise.resolve(get().members)
              : dependencies.platform.listMembers(serverId),
            invitesCached
              ? Promise.resolve(get().invites)
              : dependencies.platform.listInvites(serverId),
          ]);
          if (get().currentServerId !== serverId) return;
          if (membersResult.status === "rejected") {
            set({
              error: errorMessage(membersResult.reason),
              loadingOrganization: false,
            });
            return;
          }
          markResourceFresh(membersKey);
          const invites =
            invitesResult.status === "fulfilled" ? invitesResult.value : [];
          const inviteError =
            invitesResult.status === "rejected" &&
            !isForbidden(invitesResult.reason)
              ? errorMessage(invitesResult.reason)
              : null;
          if (
            invitesResult.status === "fulfilled" ||
            isForbidden(invitesResult.status === "rejected" ? invitesResult.reason : null)
          ) {
            markResourceFresh(invitesKey);
          }
          if (!membersCached) {
            try {
              await applyMessagingScope(
                get().channels,
                get().directConversations,
                get().serverContextGeneration,
              );
            } catch (error) {
              set({ error: errorMessage(error), loadingOrganization: false });
              return;
            }
          }
          if (get().currentServerId !== serverId) return;
          set((current) => ({
            directConversations: enrichDirectConversations(
              current.directConversations,
              membersResult.value,
            ),
            error: inviteError,
            invites,
            loadingOrganization: false,
            members: membersResult.value,
          }));
        },
      );
    },

    async reconnectIm() {
      if (manualReconnectPromise) {
        return manualReconnectPromise;
      }
      if (get().authStatus !== "signed_in" || !get().account) {
        set({ error: "请先登录后再连接聊天" });
        return;
      }
      directConversationEpoch += 1;
      directConversationActive = true;
      directConversationSyncGeneration += 1;
      set({ directConversationSync: "idle" });
      userSigRecoveryUsed = false;
      const operation = connectIm()
        .then(() => {
          set({ error: null });
        })
        .catch((error) => {
          const message = errorMessage(error);
          set({
            error: message,
            imState: { message, status: "error" },
          });
        });
      manualReconnectPromise = operation.finally(() => {
        manualReconnectPromise = null;
      });
      return manualReconnectPromise;
    },

    async removeChannelMember(memberId) {
      await changeCurrentChannelMember(memberId, "remove");
    },

    async removeMember(memberId) {
      const action = `member:${memberId}:remove`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const accepted = await dependencies.platform.removeMember(
          serverId,
          memberId,
          `${requestId()}:member:remove`,
        );
        trackOperations(accepted.operations, accepted.resourceId);
        const members = await dependencies.platform.listMembers(serverId);
        await applyMessagingScope(
          get().channels,
          get().directConversations,
          get().serverContextGeneration,
        );
        set({ members, pendingAction: null });
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async requestComputerRegistrationScript(computerId) {
      const action = `computer:${computerId}:registration`;
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      const computer = state.computers.find((item) => item.id === computerId);
      if (!computer) {
        set({ error: "Computer 不存在" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const registration =
          await dependencies.platform.createComputerRegistrationScript(
            serverId,
            computerId,
            computer.revision,
          );
        set((current) => ({
          computers: current.computers.map((item) =>
            item.id === computerId && registration.computerId === computerId
              ? {...item, revision: registration.revision}
              : item,
          ),
          pendingAction: null,
        }));
        return registration;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async createComputerTerminalSession(computerId) {
      const action = `computer:${computerId}:terminal`;
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const session = await dependencies.platform.createTerminalSession(
          serverId,
          computerId,
        );
        if (get().currentServerId === serverId) {
          set({ pendingAction: null });
        }
        return session;
      } catch (error) {
        const message = errorMessage(error);
        const computerWasOffline =
          error instanceof PlatformError &&
          error.platformCode === "computer_offline";
        if (get().currentServerId !== serverId) return null;
        set({ error: message, pendingAction: null });
        if (computerWasOffline) {
          await get().refreshComputers({force: true});
          if (get().currentServerId === serverId) {
            set({ error: message, pendingAction: null });
          }
        }
        return null;
      }
    },

    cancelOperationPolling(operationId) {
      cancelOperationPolls(operationId);
    },

    async continueOperationPolling(operationId) {
      await startOperationPoll(operationId);
    },

    async refreshOperation(operationId) {
      const state = get();
      const serverId = state.currentServerId;
      const tracked = state.operationsById[operationId];
      if (!serverId || !tracked) return null;
      try {
        const operation = await dependencies.platform.getOperation(
          serverId,
          operationId,
        );
        if (get().currentServerId !== serverId) return null;
        trackOperations([operation], tracked.resourceId);
        return operation;
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error) });
        }
        return null;
      }
    },

    async rotateAgentCredential(agentId) {
      const action = `agent:${agentId}:credential:rotate`;
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      const agent = state.agents.find((item) => item.id === agentId);
      if (!serverId || !agent) {
        set({ error: "Agent 不存在或尚未加载" });
        return null;
      }
      if (
        agent.imState !== "ready" ||
        !agent.computerId ||
        agent.desiredState !== "stopped" ||
        !["unknown", "stopped", "error"].includes(agent.observedState)
      ) {
        set({ error: "请先停止 Agent，并确认已绑定可用 Computer" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const operation =
          await dependencies.platform.rotateAgentRuntimeCredential(
            serverId,
            agentId,
            `${requestId()}:agent:credential:rotate`,
          );
        if (get().currentServerId !== serverId) return null;
        trackOperations([operation], agentId);
		const agents = await dependencies.platform.listAgents(serverId);
		if (get().currentServerId !== serverId) return null;
		set({ agents, pendingAction: null });
        return operation;
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error), pendingAction: null });
        }
        return null;
      }
    },

    async runAgentAction(agentId, agentAction) {
      const action = `agent:${agentId}:${agentAction}`;
      const state = get();
      if (state.pendingAction) return null;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return null;
      }
      set({ error: null, pendingAction: action });
      try {
        const operation = await dependencies.platform.agentAction(
          serverId,
          agentId,
          agentAction,
          `${requestId()}:agent:${agentAction}`,
        );
        trackOperations([operation], agentId);
        const agents = await dependencies.platform.listAgents(serverId);
        set({ agents, pendingAction: null });
        return operation;
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
        return null;
      }
    },

    async revokeInvite(inviteId) {
      const action = `invite:${inviteId}:revoke`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        await dependencies.platform.revokeInvite(serverId, inviteId);
        set((current) => ({
          invites: current.invites.filter((item) => item.id !== inviteId),
          pendingAction: null,
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async selectChannel(channelId) {
      const selection = ++conversationSelection;
      const channel = get().channels.find((item) => item.id === channelId);
      const serverId = get().currentServerId;
      if (!channel) {
        set({ error: "Channel 不存在或尚未加载" });
        return;
      }
      if (!serverId) {
        set({ error: "请先选择 Server" });
        return;
      }
      const address = channelAddress(channel);
      if (!address && channel.joined) {
        set({ error: "Channel 尚未同步到消息服务" });
        return;
      }

      set({
        activeConversation: { channelId, kind: "channel" },
        activeThread: null,
        channelMembers: [],
        currentChannelId: channelId,
        error: null,
        historyCompleted: true,
        historyCursor: null,
        loadingChannel: true,
        loadingOlderMessages: false,
        messages: [],
        messageFocusRequest: null,
        pendingThreadIndexMessageIds: [],
        searchCompleted: true,
        searchCursor: null,
        searchError: null,
        searchLocateError: null,
        locatingSearchResultId: null,
        searchingMessages: false,
        searchQuery: "",
        searchResults: [],
        selectedQuote: null,
        sendingThreadReply: false,
        threadCompleted: true,
        threadCursor: null,
        threadLoading: false,
        threadMessages: [],
        threadRootMessage: null,
      });
      if (!address) {
        try {
          const channelMembers =
            await dependencies.platform.listChannelMembers(
              serverId,
              channelId,
            );
          if (selection !== conversationSelection) return;
          set({channelMembers, loadingChannel: false});
        } catch (error) {
          if (selection === conversationSelection) {
            set({error: errorMessage(error), loadingChannel: false});
          }
        }
        return;
      }
      try {
        const messagingReadiness = dependencies.messaging
          .waitUntilReady(15_000)
          .then(
            () => ({ready: true as const}),
            (error: unknown) => ({error, ready: false as const}),
          );
        const channelMembers =
          await dependencies.platform.listChannelMembers(serverId, channelId);
        if (selection !== conversationSelection) {
          return;
        }
        set({channelMembers});
        const readiness = await messagingReadiness;
        if (!readiness.ready) throw readiness.error;
        if (selection !== conversationSelection) {
          return;
        }
        const page = await dependencies.messaging.loadHistory(address);
        if (selection !== conversationSelection) {
          return;
        }
        set({
          historyCompleted: page.completed,
          historyCursor: page.nextCursor ?? null,
          loadingChannel: false,
          loadingOlderMessages: false,
          messages: mergeMessages([], channelMessages(page.messages)),
        });
        try {
          await dependencies.messaging.markRead(address);
          if (selection === conversationSelection) {
            set((current) => ({
              conversationSummaries: current.conversationSummaries.map(
                (summary) =>
                  summary.conversationId === address.conversationId
                    ? {...summary, unreadCount: 0}
                    : summary,
              ),
            }));
          }
        } catch (error) {
          if (selection === conversationSelection) {
            set({
              error: `消息已加载，但已读同步失败：${errorMessage(error)}`,
            });
          }
        }
      } catch (error) {
        if (selection === conversationSelection) {
          if (
            isImNotMember(error) &&
            !isEveryoneChannel(channel) &&
            (await compensateChannelMembership(
              serverId,
              channelId,
              selection,
            ))
          ) {
            return;
          }
          set({
            error: errorMessage(error),
            loadingChannel: false,
            loadingOlderMessages: false,
          });
        }
      }
    },

    async selectDirectConversation(peerUserId) {
      const normalizedPeerUserId = peerUserId.trim();
      const state = get();
      if (!normalizedPeerUserId) {
        set({ error: "私信对象不能为空" });
        return;
      }
      if (normalizedPeerUserId === state.account?.imUserId) {
        set({ error: "不能给自己发私信" });
        return;
      }
      const existing = state.directConversations.find(
        (item) => item.peerUserId === normalizedPeerUserId,
      );
      const readyMember = state.members.find(
        (member) =>
          member.imState === "ready" &&
          member.status === "active" &&
          member.imUserId === normalizedPeerUserId,
      );
      if (!existing && !readyMember) {
        set({ error: "该成员不在当前 Server，或 IM 身份尚未就绪" });
        return;
      }
      const peerMemberId = existing?.peerMemberId ?? readyMember!.id;
      const selection = ++conversationSelection;
      const epoch = directConversationEpoch;
      const address = existing ? directAddress(existing) : null;
      set({
        activeConversation: {
          ...(existing ? {directConversationId: existing.directConversationId} : {}),
          kind: "direct",
          peerMemberId,
          peerUserId: normalizedPeerUserId,
        },
        activeThread: null,
        channelMembers: [],
        error: null,
        historyCompleted: true,
        historyCursor: null,
        loadingChannel: address !== null,
        loadingOlderMessages: false,
        messages: [],
        messageFocusRequest: null,
        pendingThreadIndexMessageIds: [],
        searchCompleted: true,
        searchCursor: null,
        searchError: null,
        searchLocateError: null,
        locatingSearchResultId: null,
        searchingMessages: false,
        searchQuery: "",
        searchResults: [],
        selectedQuote: null,
        sendingThreadReply: false,
        threadCompleted: true,
        threadCursor: null,
        threadLoading: false,
        threadMessages: [],
        threadRootMessage: null,
      });
      if (!address) {
        return;
      }
      try {
        await dependencies.messaging.waitUntilReady(15_000);
        if (
          selection !== conversationSelection ||
          epoch !== directConversationEpoch
        ) {
          return;
        }
        const page = await dependencies.messaging.loadHistory(address);
        if (
          selection !== conversationSelection ||
          epoch !== directConversationEpoch
        ) {
          return;
        }
        set({
          historyCompleted: page.completed,
          historyCursor: page.nextCursor ?? null,
          loadingChannel: false,
          loadingOlderMessages: false,
          messages: mergeMessages(
            [],
            messagesForConversation(page.messages, address.conversationId),
          ),
        });
        try {
          await dependencies.messaging.markRead(address);
          if (
            selection === conversationSelection &&
            epoch === directConversationEpoch
          ) {
            set((current) => ({
              directConversations: current.directConversations.map((item) =>
                item.peerUserId === normalizedPeerUserId
                  ? { ...item, unreadCount: 0 }
                  : item,
              ),
            }));
          }
        } catch (error) {
          if (
            selection === conversationSelection &&
            epoch === directConversationEpoch
          ) {
            set({
              error: `消息已加载，但已读同步失败：${errorMessage(error)}`,
            });
          }
        }
      } catch (error) {
        if (
          selection === conversationSelection &&
          epoch === directConversationEpoch
        ) {
          set({
            error: errorMessage(error),
            loadingChannel: false,
            loadingOlderMessages: false,
          });
        }
      }
    },

    async selectServer(serverId) {
      if (serverSelectionFlight?.serverId === serverId) {
        return serverSelectionFlight.promise;
      }
      const current = get();
      if (
        current.currentServerId === serverId &&
        current.targetServerId === serverId &&
        current.serverContextStatus === "ready" &&
        current.channels.some((channel) => channelAddress(channel) !== null)
      ) {
        return;
      }
      const selection = ++serverSelection;
      cancelOperationPolls();
      conversationSelection += 1;
      set({
        activeConversation: null,
        activeThread: null,
        agents: [],
        channelMembers: [],
        channels: [],
        computers: [],
        conversationSummaries: [],
        currentChannelId: null,
        currentServerId: null,
        directConversations: [],
        directConversationSync: "pending",
        error: null,
        inbox: [],
        invites: [],
        loadingReminders: false,
        messages: [],
        messageFocusRequest: null,
        loadingOlderMessages: false,
        members: [],
        pendingAction: null,
        pendingThreadIndexMessageIds: [],
        operationsById: {},
        searchCompleted: true,
        searchCursor: null,
        searchError: null,
        searchLocateError: null,
        locatingSearchResultId: null,
        searchingMessages: false,
        searchQuery: "",
        searchResults: [],
        selectedQuote: null,
        sendingThreadReply: false,
        serverContextGeneration: selection,
        serverContextStatus: "loading",
        tasks: [],
        reminders: [],
        targetServerId: serverId,
        threadCompleted: true,
        threadCursor: null,
        threadLoading: false,
        threadMessages: [],
        threadRootMessage: null,
      });
      const promise = (async () => {
      try {
          await dependencies.messaging.setScope({
            allowedConversations: [],
            generation: selection,
          });
          const [initialChannels, agents, computers, members, directResources] =
            await Promise.all([
              dependencies.platform.listChannels(serverId),
              dependencies.platform.listAgents(serverId),
              dependencies.platform.listComputers(serverId),
              dependencies.platform.listMembers(serverId),
              dependencies.platform.listDirectConversations(serverId),
            ]);
          if (selection !== serverSelection) return;
          let channels = initialChannels;
          for (
            let attempt = 0;
            attempt < channelReadinessPollLimit &&
            !channels.some((channel) => channelAddress(channel) !== null) &&
            channels.some(
              (channel) =>
                channel.joined && channel.imState === "provisioning",
            );
            attempt += 1
          ) {
            await sleep(channelReadinessPollIntervalMs);
            if (selection !== serverSelection) return;
            try {
              channels = await dependencies.platform.listChannels(serverId);
            } catch (error) {
              if (attempt === channelReadinessPollLimit - 1) throw error;
              continue;
            }
            if (selection !== serverSelection) return;
          }
          const directConversations = projectDirectConversationResources(
            directResources,
            get().account,
            [],
          );
          await applyMessagingScope(channels, directConversations, selection);
          if (selection !== serverSelection) return;
          set({
            agents,
            channels,
            computers,
            currentServerId: serverId,
            directConversations,
            directConversationSync: "complete",
            members,
            serverContextStatus: "ready",
          });
          markResourceFresh(refreshKey(serverId, "agents"));
          markResourceFresh(refreshKey(serverId, "computers"));
          markResourceFresh(refreshKey(serverId, "members"));
          if (get().imState.status === "ready") {
            void syncConversationSummaries(imConnection);
          }
        } catch (error) {
          if (selection === serverSelection) {
            set({
              error: errorMessage(error),
              serverContextStatus: "error",
            });
          }
        }
      })();
      serverSelectionFlight = { promise, serverId };
      try {
        await promise;
      } finally {
        if (serverSelectionFlight?.promise === promise) {
          serverSelectionFlight = null;
        }
      }
    },

    async loadOlderMessages() {
      const state = get();
      if (
        state.loadingOlderMessages ||
        state.historyCompleted ||
        !state.historyCursor
      ) {
        return;
      }
      const address = activeConversationAddress(state);
      if (!address) return;
      const selection = conversationSelection;
      const cursor = state.historyCursor;
      set({ error: null, loadingOlderMessages: true });
      try {
        const page = await dependencies.messaging.loadHistory(address, cursor);
        if (selection !== conversationSelection) return;
        set((current) => ({
          historyCompleted: page.completed,
          historyCursor: page.nextCursor ?? null,
          loadingOlderMessages: false,
          messages: mergeMessages(
            current.messages,
            messagesForConversation(page.messages, address.conversationId),
          ),
        }));
      } catch (error) {
        if (selection === conversationSelection) {
          set({
            error: errorMessage(error),
            loadingOlderMessages: false,
          });
        }
      }
    },

    async loadMoreSearchResults() {
      const state = get();
      if (
        state.searchingMessages ||
        state.searchCompleted ||
        !state.searchCursor ||
        !state.searchQuery
      ) {
        return;
      }
      await runMessageSearch(state.searchQuery, state.searchCursor, false);
    },

    async locateSearchResult(messageId) {
      const state = get();
      if (state.locatingSearchResultId) return;
      const result = state.searchResults.find((item) => item.id === messageId);
      const address = activeConversationAddress(state);
      if (!result || !address) {
        set({searchLocateError: "无法定位这条消息：搜索结果或会话已失效"});
        return;
      }
      const selection = conversationSelection;
      set({
        locatingSearchResultId: messageId,
        searchLocateError: null,
      });
      try {
        if (result.thread?.role === "reply") {
          throw new Error("这条消息位于 Thread，请从原消息进入 Thread 查看");
        }
        const alreadyLoaded = state.messages.some(
          (message) => message.id === messageId,
        );
        const context = alreadyLoaded
          ? []
          : await dependencies.messaging.loadMessageContext(
              address,
              searchResultReference(address, result),
            );
        if (selection !== conversationSelection) return;
        const visibleContext = messagesForConversation(
          context,
          address.conversationId,
        );
        if (
          !alreadyLoaded &&
          !visibleContext.some((message) => message.id === messageId)
        ) {
          throw new Error("消息上下文已返回，但目标消息不可见");
        }
        set((current) => ({
          locatingSearchResultId: null,
          messageFocusRequest: {
            messageId,
            revision: (current.messageFocusRequest?.revision ?? 0) + 1,
          },
          messages: mergeMessages(current.messages, visibleContext),
          searchCompleted: true,
          searchCursor: null,
          searchError: null,
          searchLocateError: null,
          searchingMessages: false,
          searchQuery: "",
          searchResults: [],
        }));
      } catch (error) {
        if (selection === conversationSelection) {
          set({
            locatingSearchResultId: null,
            searchLocateError: `无法定位这条消息：${errorMessage(error)}`,
          });
        }
      }
    },

    async loadMoreThreadReplies() {
      const state = get();
      if (
        !state.activeThread ||
        state.threadLoading ||
        state.threadCompleted ||
        !state.threadCursor
      ) {
        return;
      }
      await loadThreadReplyPage(state.activeThread, state.threadCursor, false);
    },

    async openThread(messageId) {
      const state = get();
      if (state.activeConversation?.kind !== "channel") {
        set({ error: "私信不支持 Thread" });
        return;
      }
      const serverId = state.currentServerId;
      const channel = state.channels.find(
        (item) => item.id === state.currentChannelId,
      );
      const root = state.messages.find((item) => item.id === messageId);
      if (!serverId || !channel || !root) {
        set({ error: "无法打开这条消息的 Thread" });
        return;
      }
      const rootMessageRef = threadMessageReference(channel, root);
      if (!rootMessageRef) {
        set({ error: "这条消息缺少腾讯 sequence，暂时不能建立 Thread" });
        return;
      }
      const selection = conversationSelection;
      set({
        activeThread: null,
        error: null,
        threadCompleted: false,
        threadCursor: null,
        threadLoading: true,
        threadMessages: [],
        threadRootMessage: root,
        pendingThreadIndexMessageIds: [],
      });
      try {
        const thread = await dependencies.platform.ensureThread(
          serverId,
          channel.id,
          { rootMessageRef },
          `${requestId()}:thread:ensure`,
        );
        if (selection !== conversationSelection) return;
        set({ activeThread: thread });
        await loadThreadReplyPage(thread, undefined, true);
      } catch (error) {
        if (selection === conversationSelection) {
          set({
            activeThread: null,
            error: errorMessage(error),
            threadCompleted: true,
            threadLoading: false,
          });
        }
      }
    },

    async sendAttachment(input) {
      const state = get();
      if (state.imState.status !== "ready") {
        set({ error: "聊天连接尚未就绪" });
        return;
      }
      const clientRequestId = requestId();
      let address: ConversationAddress | null;
      try {
        address = await resolveConversationAddressForSend(
          state,
          clientRequestId,
        );
      } catch (error) {
        set({error: errorMessage(error), sendingMessage: false});
        return;
      }
      if (!address) {
        set({ error: "当前会话尚未同步到消息服务", sendingMessage: false });
        return;
      }
      const localId = `local:${clientRequestId}`;
      const optimistic = optimisticAttachmentMessage({
        account: state.account,
        clientRequestId,
        conversationId: address.conversationId,
        kind: input.kind,
        quote: state.selectedQuote ?? undefined,
        source: input.source,
      });
      set((current) => ({
        error: null,
        messages: mergeMessages(current.messages, [optimistic]),
        selectedQuote: null,
        sendingMessage: true,
      }));

      try {
        const sent = await dependencies.messaging.sendAttachment({
          channel: address,
          clientRequestId,
          kind: input.kind,
          onProgress(progress) {
            set((current) => ({
              messages: current.messages.map((message) =>
                message.id === localId
                  ? {
                      ...message,
                      delivery: {
                        progress,
                        state: "uploading" as const,
                      },
                    }
                  : message,
              ),
            }));
          },
          ...(state.selectedQuote ? { quote: state.selectedQuote } : {}),
          source: input.source,
        });
        set((current) => ({
          messages: mergeConfirmedMessage(current.messages, sent),
          sendingMessage: false,
        }));
      } catch (error) {
        const message = errorMessage(error);
        set((current) => ({
          error: message,
          messages: current.messages.map((item) =>
            item.id === localId
              ? {
                  ...item,
                  delivery: {
                    error: message,
                    retryable: true,
                    state: "failed" as const,
                  },
                }
              : item,
          ),
          sendingMessage: false,
        }));
      }
    },

    async sendComposerDraft(draft) {
      const state = get();
      const draftKey = conversationDraftKey(state.activeConversation);
      if (
        !composerDocumentHasContent(draft.document) &&
        draft.attachments.length === 0
      ) {
        return;
      }
      if (state.imState.status !== "ready") {
        if (draftKey) {
          set((current) => ({
            conversationDrafts: {
              ...current.conversationDrafts,
              [draftKey]: cloneComposerDraft(draft),
            },
            error: "聊天连接尚未就绪",
          }));
        }
        return;
      }

      let address: ConversationAddress | null;
      try {
        address = await resolveConversationAddressForSend(state, uuidV7());
      } catch (error) {
        set((current) => ({
          ...(draftKey
            ? {
                conversationDrafts: {
                  ...current.conversationDrafts,
                  [draftKey]: cloneComposerDraft(draft),
                },
              }
            : {}),
          error: errorMessage(error),
        }));
        return;
      }
      if (!address) {
        if (draftKey) {
          set((current) => ({
            conversationDrafts: {
              ...current.conversationDrafts,
              [draftKey]: cloneComposerDraft(draft),
            },
            error: "当前会话尚未同步到消息服务",
          }));
        }
        return;
      }

      const conversationKey =
        draftKey ?? `conversation:${address.conversationId}`;
      const partCount =
        draft.attachments.length +
        (composerDocumentHasContent(draft.document) ? 1 : 0);
      const submission = planComposerSubmission({
        channel: address,
        clientRequestIds: Array.from({length: partCount}, () => uuidV7()),
        conversationKey,
        draft,
        submissionId: uuidV7(),
      });
      const optimistic = submission.parts.map((part) =>
        part.role === "attachment"
          ? optimisticAttachmentMessage({
              account: state.account,
              clientRequestId: part.clientRequestId,
              conversationId: address.conversationId,
              kind: part.attachment.kind,
              ...(part.quote ? {quote: part.quote} : {}),
              source: part.attachment.source,
              submission: part.submission,
            })
          : optimisticTextMessage({
              account: state.account,
              clientRequestId: part.clientRequestId,
              conversationId: address.conversationId,
              mentions: part.mentions.map((mention) => mention.imUserId),
              ...(part.quote ? {quote: part.quote} : {}),
              submission: part.submission,
              text: part.text,
            }),
      );
      set((current) => {
        const conversationDrafts = {...current.conversationDrafts};
        if (draftKey) delete conversationDrafts[draftKey];
        return {
          conversationDrafts,
          error: null,
          messages: mergeMessages(current.messages, optimistic),
          selectedQuote: null,
        };
      });
      submissionCoordinator.enqueue(submission);
    },

    async sendMessage(input) {
      const state = get();
      if (state.imState.status !== "ready") {
        set({ error: "聊天连接尚未就绪" });
        return;
      }
      let directIntent: DirectSendIntent | null = null;
      let clientRequestId = requestId();
      if (state.activeConversation?.kind === "direct") {
        try {
          directIntent = await loadOrCreateDirectTextIntent(
            state,
            state.activeConversation,
            input,
            clientRequestId,
          );
          if (!directIntent) {
            const draftKey = conversationDraftKey(state.activeConversation);
            set((current) => {
              const conversationDrafts = {...current.conversationDrafts};
              if (draftKey) delete conversationDrafts[draftKey];
              return {conversationDrafts, error: null, sendingMessage: false};
            });
            return;
          }
          clientRequestId = directIntent.clientRequestId;
        } catch (error) {
          set({error: errorMessage(error), sendingMessage: false});
          return;
        }
      }
      let address: ConversationAddress | null;
      try {
        address = await resolveConversationAddressForSend(
          state,
          directIntent?.idempotencyKey ?? clientRequestId,
        );
      } catch (error) {
        set({error: errorMessage(error), sendingMessage: false});
        return;
      }
      if (directIntent) {
        const activeConversation = store.getState().activeConversation;
        directIntent = {
          ...directIntent,
          directConversationId:
            activeConversation?.kind === "direct"
              ? activeConversation.directConversationId
              : directIntent.directConversationId,
          updatedAt: new Date().toISOString(),
        };
        await saveDirectSendIntent(directIntent);
      }
      if (!address) {
        set({ error: "当前会话尚未同步到消息服务" });
        return;
      }
      const mentionIds = new Set(input.mentionedUserIds);
      const mentions = conversationCapabilities(address).mentions
        ? mentionableAgents(state)
            .filter((agent) => mentionIds.has(agent.imUserId))
            .map((agent) => ({
              displayName: agent.displayName,
              imUserId: agent.imUserId,
              memberId:
                state.members.find(
                  (member) => member.imUserId === agent.imUserId,
                )?.id ?? agent.id,
              memberKind: "agent" as const,
            }))
        : [];
      const localId = `local:${clientRequestId}`;
      const draftKey = conversationDraftKey(state.activeConversation);
      const optimistic = optimisticTextMessage({
        account: state.account,
        clientRequestId,
        conversationId: address.conversationId,
        mentions: mentions.map((mention) => mention.imUserId),
        quote: state.selectedQuote ?? undefined,
        text: input.text,
      });
      set((current) => {
        const conversationDrafts = { ...current.conversationDrafts };
        if (draftKey) delete conversationDrafts[draftKey];
        return {
          conversationDrafts,
          error: null,
          messages: mergeMessages(current.messages, [optimistic]),
          selectedQuote: null,
          sendingMessage: true,
        };
      });
      try {
        if (directIntent) {
          directIntent = {
            ...directIntent,
            phase: "sending",
            updatedAt: new Date().toISOString(),
          };
          await saveDirectSendIntent(directIntent);
        }
        const sent = await dependencies.messaging.sendText({
          channel: address,
          clientRequestId,
          mentions,
          ...(state.selectedQuote ? { quote: state.selectedQuote } : {}),
          text: input.text,
        });
        set((current) => ({
          conversationSummaries: updateConversationSummariesFromMessages(
            current.conversationSummaries,
            current.channels,
            [sent],
            address.conversationId,
          ),
          directConversations: updateDirectConversationsFromMessages(
            current.directConversations,
            [sent],
            address.conversationId,
          ),
          messages: mergeMessages(current.messages, [sent]),
          sendingMessage: false,
        }));
        if (directIntent) {
          await removeDirectSendIntent(directIntent);
        }
      } catch (error) {
        const message = errorMessage(error);
        if (directIntent?.phase === "sending") {
          directIntent = {
            ...directIntent,
            phase: "uncertain",
            updatedAt: new Date().toISOString(),
          };
          try {
            await saveDirectSendIntent(directIntent);
          } catch (persistenceError) {
            set({
              error: `${message}；发送状态保存失败：${errorMessage(persistenceError)}`,
            });
          }
        }
        set((current) => ({
          error: message,
          messages: current.messages.map((item) =>
            item.id === localId
              ? {
                  ...item,
                  delivery: {
                    error: message,
                    retryable: true,
                    state: "failed" as const,
                  },
                }
              : item,
          ),
          sendingMessage: false,
        }));
      }
    },

    async sendThreadReply(input) {
      const state = get();
      const serverId = state.currentServerId;
      const thread = state.activeThread;
      const channel = state.channels.find(
        (item) => item.id === state.currentChannelId,
      );
      const address = channel ? channelAddress(channel) : null;
      if (
        state.imState.status !== "ready" ||
        !serverId ||
        !channel ||
        !address ||
        !thread
      ) {
        set({ error: "Thread 尚未就绪" });
        return;
      }
      const mentionIds = new Set(input.mentionedUserIds);
      const mentions = mentionableAgents(state)
        .filter((item) => mentionIds.has(item.imUserId))
        .map((item) => ({
          displayName: item.displayName,
          imUserId: item.imUserId,
          memberId:
            state.members.find(
              (member) => member.imUserId === item.imUserId,
            )?.id ?? item.id,
          memberKind: "agent" as const,
        }));
      const clientRequestId = requestId();
      const optimistic = {
        ...optimisticTextMessage({
          account: state.account,
          clientRequestId,
          conversationId: address.conversationId,
          mentions: mentions.map((mention) => mention.imUserId),
          text: input.text,
        }),
        thread: {
          role: "reply" as const,
          rootMessageRef: thread.rootMessageRef,
          threadId: thread.id,
        },
      };
      set((current) => ({
        error: null,
        sendingThreadReply: true,
        threadMessages: mergeMessages(current.threadMessages, [optimistic]),
      }));
      let sent: Message;
      try {
        sent = await dependencies.messaging.sendText({
          channel: address,
          clientRequestId,
          mentions,
          text: input.text,
          thread: {
            rootMessageRef: thread.rootMessageRef,
            threadId: thread.id,
          },
        });
        set((current) => ({
          sendingThreadReply: false,
          threadMessages: mergeMessages(current.threadMessages, [sent]),
        }));
      } catch (error) {
        set((current) => ({
          error: errorMessage(error),
          sendingThreadReply: false,
          threadMessages: current.threadMessages.map((message) =>
            message.clientRequestId === clientRequestId &&
            message.id.startsWith("local:")
              ? {
                  ...message,
                  delivery: {
                    error: errorMessage(error),
                    retryable: true,
                    state: "failed" as const,
                  },
                }
              : message,
          ),
        }));
        return;
      }

      const messageRef = threadMessageReference(channel, sent);
      if (!messageRef) {
        set((current) => ({
          error: "消息已发送，但腾讯回执缺少 sequence；可稍后重试收录",
          pendingThreadIndexMessageIds: appendUnique(
            current.pendingThreadIndexMessageIds,
            sent.id,
          ),
        }));
        return;
      }
      try {
        const reply = await dependencies.platform.registerThreadReply(
          serverId,
          channel.id,
          thread.id,
          { messageRef },
          `${clientRequestId}:thread:reply:index`,
        );
        set((current) => ({
          activeThread:
            current.activeThread?.id === thread.id
              ? {
                  ...current.activeThread,
                  lastReplyAt: reply.createdAt,
                  replyCount: current.activeThread.replyCount + 1,
                  unreadCount: 0,
                }
              : current.activeThread,
          pendingThreadIndexMessageIds:
            current.pendingThreadIndexMessageIds.filter(
              (messageId) => messageId !== sent.id,
            ),
        }));
        try {
          await dependencies.platform.markThreadRead(
            serverId,
            channel.id,
            thread.id,
            reply.id,
            `${clientRequestId}:thread:read`,
          );
        } catch (error) {
          set({ error: `回复已收录，但更新已读失败：${errorMessage(error)}` });
        }
      } catch (error) {
        set((current) => ({
          error: `消息已发送，但 Thread 收录失败：${errorMessage(error)}`,
          pendingThreadIndexMessageIds: appendUnique(
            current.pendingThreadIndexMessageIds,
            sent.id,
          ),
        }));
      }
    },

    async retryThreadReplyIndex(messageId) {
      const state = get();
      const serverId = state.currentServerId;
      const thread = state.activeThread;
      const channel = state.channels.find(
        (item) => item.id === state.currentChannelId,
      );
      const message = state.threadMessages.find(
        (item) =>
          item.id === messageId || item.reference?.messageId === messageId,
      );
      if (!state.pendingThreadIndexMessageIds.includes(messageId)) {
        set({ error: "这条回复当前不需要重新收录" });
        return;
      }
      if (!serverId || !thread || !channel) {
        set({ error: "Thread 上下文已变化，请重新打开后再收录" });
        return;
      }
      if (!message) {
        set({
          error: `本地找不到待收录回复 ${messageId}（当前：${state.threadMessages
            .map((item) => item.id)
            .join("、")}）`,
        });
        return;
      }
      const messageRef = threadMessageReference(channel, message);
      if (!messageRef) {
        set({ error: "腾讯回执仍缺少 sequence，暂时无法收录" });
        return;
      }
      const indexKey =
        message.clientRequestId ?? message.reference?.messageId ?? message.id;
      try {
        const reply = await dependencies.platform.registerThreadReply(
          serverId,
          channel.id,
          thread.id,
          { messageRef },
          `${indexKey}:thread:reply:index`,
        );
        set((current) => ({
          activeThread:
            current.activeThread?.id === thread.id
              ? {
                  ...current.activeThread,
                  lastReplyAt: reply.createdAt,
                  replyCount: current.activeThread.replyCount + 1,
                  unreadCount: 0,
                }
              : current.activeThread,
          error: null,
          pendingThreadIndexMessageIds:
            current.pendingThreadIndexMessageIds.filter(
              (pendingId) => pendingId !== messageId,
            ),
        }));
        try {
          await dependencies.platform.markThreadRead(
            serverId,
            channel.id,
            thread.id,
            reply.id,
            `${indexKey}:thread:read`,
          );
        } catch (error) {
          set({ error: `回复已收录，但更新已读失败：${errorMessage(error)}` });
        }
      } catch (error) {
        set({
          error: `Thread 收录仍未完成：${errorMessage(error)}`,
        });
      }
    },

    async retryMessage(messageId) {
      const state = get();
      const failed = state.messages.find((message) => message.id === messageId);
      const submissionId = failed?.submission?.id;
      if (submissionId && state.submissions[submissionId]) {
        if (
          failed.delivery.state !== "failed" ||
          !failed.delivery.retryable ||
          !submissionCoordinator.canRetry(submissionId)
        ) {
          set({ error: "这组消息当前不能重试" });
          return;
        }
        set({ error: null });
        await submissionCoordinator.retry(submissionId);
        return;
      }
      if (
        !failed?.clientRequestId ||
        failed.delivery.state !== "failed" ||
        !failed.delivery.retryable
      ) {
        set({ error: "这条消息当前不能重试" });
        return;
      }
      const clientRequestId = failed.clientRequestId;
      set((current) => ({
        error: null,
        messages: current.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                delivery: { state: "sending" as const },
              }
            : message,
        ),
        sendingMessage: true,
      }));
      try {
        const sent = await dependencies.messaging.retryMessage(clientRequestId);
        set((current) => ({
          messages: mergeMessages(current.messages, [sent]),
          sendingMessage: false,
        }));
      } catch (error) {
        const message = errorMessage(error);
        set((current) => ({
          error: message,
          messages: current.messages.map((item) =>
            item.id === messageId
              ? {
                  ...item,
                  delivery: {
                    error: message,
                    retryable: true,
                    state: "failed" as const,
                  },
                }
              : item,
          ),
          sendingMessage: false,
        }));
      }
    },

    async revokeMessage(messageId) {
      const target = get().messages.find((message) => message.id === messageId);
      if (
        !target ||
        target.direction !== "outgoing" ||
        target.id.startsWith("local:") ||
        target.delivery.state !== "sent" ||
        target.rawType === "TIMRevokedElem"
      ) {
        set({error: "这条消息当前不能撤回"});
        return;
      }
      set({error: null});
      try {
        const recalled = await dependencies.messaging.revokeMessage(messageId);
        set(current => ({
          messages: mergeMessages(current.messages, [recalled]),
          searchResults: mergeMessages(current.searchResults, [recalled]),
          threadMessages: mergeMessages(current.threadMessages, [recalled]),
        }));
      } catch (error) {
        set({error: errorMessage(error)});
      }
    },

    quoteMessage(messageId) {
      const message = get().messages.find((item) => item.id === messageId);
      if (!message) {
        set({ error: "要引用的消息不存在" });
        return;
      }
      set({
        error: null,
        selectedQuote: {
          messageId: message.id,
          preview: message.text.slice(0, 160),
          senderId: message.senderId,
          senderName: message.senderName,
        },
      });
    },

    async searchMessages(query) {
      const normalized = query.trim();
      if (!normalized) {
        set({
          searchCompleted: true,
          searchCursor: null,
          searchError: null,
          searchLocateError: null,
          locatingSearchResultId: null,
          searchingMessages: false,
          searchQuery: "",
          searchResults: [],
        });
        return;
      }
      await runMessageSearch(normalized, undefined, true);
    },

    async toggleReaction(messageId, reactionId) {
      const state = get();
      const message = state.messages.find((item) => item.id === messageId);
      if (!message || message.id.startsWith("local:")) {
        set({ error: "这条消息当前不能添加 Reaction" });
        return;
      }
      const existing = message.reactions.find(
        (reaction) => reaction.reactionId === reactionId,
      );
      const active = existing?.reactedByMe !== true;
      const previous = message.reactions;
      set((current) => ({
        error: null,
        messages: current.messages.map((item) =>
          item.id === messageId
            ? {
                ...item,
                reactions: toggleMessageReaction(
                  item.reactions,
                  reactionId,
                  active,
                ),
              }
            : item,
        ),
      }));
      try {
        await dependencies.messaging.setReaction(messageId, reactionId, active);
      } catch (error) {
        set((current) => ({
          error: errorMessage(error),
          messages: current.messages.map((item) =>
            item.id === messageId ? { ...item, reactions: previous } : item,
          ),
        }));
      }
    },

    async updateTask(taskId, input) {
      const action = `task:${taskId}:update`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      const task = state.tasks.find((item) => item.id === taskId);
      if (!serverId || !task) {
        set({ error: "Task 不存在或尚未加载" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const updated = await dependencies.platform.updateTask(
          serverId,
          taskId,
          input,
          task.revision,
          `${requestId()}:task:update`,
        );
        const inbox = await dependencies.platform.listInbox(serverId);
        set((current) => ({
          inbox,
          pendingAction: null,
          tasks: upsertTask(current.tasks, updated),
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async updateReminder(reminderId, input) {
      const action = `reminder:${reminderId}:update`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      const reminder = state.reminders.find((item) => item.id === reminderId);
      if (!serverId || !reminder) {
        set({ error: "Reminder 不存在或尚未加载" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const updated = await dependencies.platform.updateReminder(
          serverId,
          reminderId,
          input,
          reminder.revision,
          `${requestId()}:reminder:update`,
        );
        if (get().currentServerId !== serverId) return;
        set((current) => ({
          pendingAction: null,
          reminders: sortReminders(upsertReminder(current.reminders, updated)),
        }));
      } catch (error) {
        if (get().currentServerId === serverId) {
          set({ error: errorMessage(error), pendingAction: null });
        }
      }
    },

    async updateAgent(agentId, input) {
      const action = `agent:${agentId}:update`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      const agent = state.agents.find((item) => item.id === agentId);
      if (!serverId || !agent) {
        set({ error: "Agent 不存在或尚未加载" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const updated = await dependencies.platform.updateAgent(
          serverId,
          agentId,
          input,
          agent.revision,
          `${requestId()}:agent:update`,
        );
        set((current) => ({
          agents: upsertAgent(current.agents, updated),
          pendingAction: null,
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async updateChannel(channelId, input) {
      const action = `channel:${channelId}:update`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      const channel = state.channels.find((item) => item.id === channelId);
      if (!serverId || !channel) {
        set({ error: "Channel 不存在或尚未加载" });
        return;
      }
      if (isEveryoneChannel(channel)) {
        set({ error: "全员根群不能编辑" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const updated = await dependencies.platform.updateChannel(
          serverId,
          channelId,
          input,
          channel.revision,
          `${requestId()}:channel:update`,
        );
        set((current) => ({
          channels: upsertChannel(current.channels, updated),
          pendingAction: null,
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },

    async updateServer(input) {
      const state = get();
      if (state.pendingAction) return false;
      const server = currentServer(state);
      if (!server) {
        set({error: "Server 不存在或尚未加载"});
        return false;
      }
      const fingerprint = JSON.stringify({
        input,
        revision: server.revision,
        serverId: server.id,
      });
      if (!serverUpdateAttempt || serverUpdateAttempt.fingerprint !== fingerprint) {
        serverUpdateAttempt = {
          fingerprint,
          idempotencyKey: `${requestId()}:server:update`,
        };
      }
      const attempt = serverUpdateAttempt;
      set({error: null, pendingAction: "server:update"});
      try {
        const updated = await dependencies.platform.updateServer(
          server.id,
          input,
          server.revision,
          attempt.idempotencyKey,
        );
        serverUpdateAttempt = null;
        set((current) => ({
          pendingAction: null,
          servers: upsertServer(current.servers, updated),
        }));
        return true;
      } catch (error) {
        if (
          error instanceof PlatformError &&
          error.platformCode === "revision_conflict"
        ) {
          try {
            const latest = await dependencies.platform.getServer(server.id);
            set((current) => ({servers: upsertServer(current.servers, latest)}));
          } catch {
            // 保留原始 revision 冲突；下一次常规刷新仍会重新获取最新事实。
          }
          serverUpdateAttempt = null;
        }
        set({error: errorMessage(error), pendingAction: null});
        return false;
      }
    },

    async updateMember(memberId, input) {
      const action = `member:${memberId}:update`;
      const state = get();
      if (state.pendingAction) return;
      const serverId = state.currentServerId;
      const member = state.members.find((item) => item.id === memberId);
      if (!serverId || !member) {
        set({ error: "Member 不存在或尚未加载" });
        return;
      }
      set({ error: null, pendingAction: action });
      try {
        const updated = await dependencies.platform.updateMember(
          serverId,
          memberId,
          input,
          member.revision,
          `${requestId()}:member:update`,
        );
        set((current) => ({
          members: upsertMember(current.members, updated),
          pendingAction: null,
        }));
      } catch (error) {
        set({ error: errorMessage(error), pendingAction: null });
      }
    },
  }));

  dependencies.messaging.subscribeLifecycle((event) => {
    if (event.type === "kicked_out" && event.cause === "user_sig_expired") {
      store.setState({
        imState: lifecycleState(event, store.getState().imState),
      });
      void recoverExpiredUserSig().catch((error) => {
        store.setState({
          error: errorMessage(error),
          imState: {
            message: errorMessage(error),
            status: "kicked_out",
          },
        });
      });
      return;
    }
    if (event.type === "kicked_out") {
      imConnection += 1;
      directConversationEpoch += 1;
      directConversationActive = false;
      directConversationSyncGeneration += 1;
      conversationSelection += 1;
      store.setState({
        directConversationSync: "idle",
      });
    }
    store.setState({
      imState: lifecycleState(event, store.getState().imState),
    });
    if (event.type === "ready" && directConversationActive) {
      void store.getState().refreshDirectConversations();
    }
  });

  dependencies.messaging.subscribeConversations((updates) => {
    store.setState((current) => ({
      conversationSummaries: mergeConversationSummaries(
        current.conversationSummaries,
        updates,
      ),
      directConversations: enrichDirectConversationSummaries(
        current.directConversations,
        updates,
      ),
    }));
  });

  dependencies.messaging.subscribeMessages((messages) => {
    const state = store.getState();
    const address = activeConversationAddress(state);
    store.setState((current) => ({
      conversationSummaries: updateConversationSummariesFromMessages(
        current.conversationSummaries,
        current.channels,
        messages,
        address?.conversationId ?? null,
      ),
      directConversations: updateDirectConversationsFromMessages(
        current.directConversations,
        messages,
        address?.conversationId ?? null,
      ),
    }));
    if (!address) {
      return;
    }
    const incoming = messages.filter(
      (message) => message.conversationId === address.conversationId,
    );
    if (incoming.length > 0) {
      const activeThreadId = state.activeThread?.id;
      const threadIncoming = activeThreadId
        ? incoming.filter(
            (message) => message.thread?.threadId === activeThreadId,
          )
        : [];
      store.setState((current) => ({
        messages: mergeMessages(
          current.messages,
          messagesForConversation(incoming, address.conversationId),
        ),
        threadMessages:
          threadIncoming.length > 0
            ? mergeMessages(current.threadMessages, threadIncoming)
            : current.threadMessages,
      }));
      void dependencies.messaging.markRead(address).catch((error) => {
        if (
          activeConversationAddress(store.getState())?.conversationId ===
          address.conversationId
        ) {
          store.setState({
            error: `消息已收到，但已读同步失败：${errorMessage(error)}`,
          });
        }
      });
    }
  });

  async function bootstrap(account: Account): Promise<void> {
    userSigRecoveryUsed = false;
    imRecoveryPromise = null;
    directConversationEpoch += 1;
    directConversationActive = true;
    directConversationSyncGeneration += 1;
    conversationSelection += 1;
    store.setState({
      account,
      activeConversation: null,
      authStatus: "signed_in",
      conversationSummaries: [],
      directConversations: [],
      directConversationSync: "idle",
      error: null,
      messages: [],
      serverContextGeneration: serverSelection,
      serverContextStatus: "idle",
      serversStatus: "loading",
      targetServerId: null,
    });

    await Promise.all([
      loadServers(),
      connectIm().catch((error) => {
        store.setState({ error: errorMessage(error) });
      }),
    ]);
  }

  async function loadServers(): Promise<void> {
    store.setState({ serversStatus: "loading" });
    try {
      const servers = await dependencies.platform.listServers();
      store.setState({ servers, serversStatus: "ready" });
    } catch (error) {
      store.setState({
        error: errorMessage(error),
        serversStatus: "error",
      });
    }
  }

  async function applyMessagingScope(
    channels: Channel[],
    directConversations: DirectConversation[],
    generation: number,
  ): Promise<void> {
    const allowedConversations = [
      ...channels.map((channel) => channelAddress(channel)),
      ...directConversations.map((conversation) => directAddress(conversation)),
    ].filter(
      (address): address is ConversationAddress => address !== null,
    );
    await dependencies.messaging.setScope({
      allowedConversations,
      generation: Math.max(1, generation),
    });
  }

  async function connectIm(allowExpiredRecovery = true): Promise<void> {
    const generation = ++imConnection;
    store.setState({
      directConversationSync: "idle",
      imState: { status: "issuing_session" },
    });
    try {
      if (dependencies.connectMessaging) {
        const initialState = store.getState();
        await applyMessagingScope(
          initialState.channels,
          initialState.directConversations,
          initialState.serverContextGeneration,
        );
        if (generation !== imConnection) return;
        store.setState({ imState: { status: "logging_in" } });
        await dependencies.connectMessaging();
      } else {
        const session = await dependencies.platform.createHumanImSession();
        if (generation !== imConnection) return;
        const initialState = store.getState();
        await applyMessagingScope(
          initialState.channels,
          initialState.directConversations,
          initialState.serverContextGeneration,
        );
        if (generation !== imConnection) return;
        store.setState({ imState: { status: "logging_in" } });
        await dependencies.messaging.connect(session);
      }
      if (generation !== imConnection) return;
      if (store.getState().imState.status !== "ready") {
        store.setState({ imState: { status: "waiting_sdk_ready" } });
      }
      await dependencies.messaging.waitUntilReady(15_000);
      if (generation !== imConnection) return;
      const state = store.getState();
      await applyMessagingScope(
        state.channels,
        state.directConversations,
        state.serverContextGeneration,
      );
      if (generation !== imConnection) return;
      store.setState({ imState: { status: "ready" } });
      await Promise.all([
        store.getState().directConversationSync === "idle"
          ? syncDirectConversations(directConversationEpoch)
          : Promise.resolve(),
        syncConversationSummaries(generation),
      ]);
    } catch (error) {
      if (allowExpiredRecovery && isUserSigExpired(error)) {
        await recoverExpiredUserSig();
        return;
      }
      throw error;
    }
  }

  async function recoverExpiredUserSig(): Promise<void> {
    if (imRecoveryPromise) {
      return imRecoveryPromise;
    }
    if (userSigRecoveryUsed) {
      throw new PlatformError(
        "IM_KICKED_OUT",
        "IM 签名再次过期，请手动重新连接",
        { details: { cause: "user_sig_expired" } },
      );
    }
    userSigRecoveryUsed = true;
    imRecoveryPromise = connectIm(false).finally(() => {
      imRecoveryPromise = null;
    });
    return imRecoveryPromise;
  }

  async function syncConversationSummaries(generation: number): Promise<void> {
    const completed = await pullConversationSummarySnapshot(generation);
    if (completed !== false) return;
    void retryConversationSummarySync(generation);
  }

  async function pullConversationSummarySnapshot(
    generation: number,
  ): Promise<boolean | null> {
    const stateBefore = store.getState();
    const contextGeneration = stateBefore.serverContextGeneration;
    const groupIds = channelTopicGroupIds(stateBefore.channels);
    if (groupIds.length === 0) return true;
    const snapshot = await dependencies.messaging.listConversations(groupIds);
    if (generation !== imConnection) return null;
    if (
      contextGeneration !== store.getState().serverContextGeneration
    ) {
      return null;
    }
    store.setState((current) => ({
      conversationSummaries: mergeConversationSummaries(
        current.conversationSummaries,
        snapshot.items,
      ),
      directConversations: enrichDirectConversationSummaries(
        current.directConversations,
        snapshot.items,
      ),
    }));
    return snapshot.isSyncCompleted;
  }

  async function retryConversationSummarySync(
    generation: number,
  ): Promise<void> {
    for (const delayMs of [100, 250, 500, 1_000, 2_000]) {
      await sleep(delayMs);
      if (generation !== imConnection) return;
      try {
        const completed = await pullConversationSummarySnapshot(generation);
        if (completed !== false) return;
      } catch {
        // 腾讯 SDK 的本地会话分页可能仍在收敛，下一档继续尝试。
      }
    }
  }

  async function syncDirectConversations(epoch: number): Promise<void> {
    const syncGeneration = ++directConversationSyncGeneration;
    if (!directConversationActive || epoch !== directConversationEpoch) {
      return;
    }
    store.setState({ directConversationSync: "pending" });
    try {
      const state = store.getState();
      const serverId = state.currentServerId;
      if (!serverId || !state.account) {
        store.setState({directConversationSync: "complete"});
        return;
      }
      const resources =
        await dependencies.platform.listDirectConversations(serverId);
      if (
        !directConversationActive ||
        epoch !== directConversationEpoch ||
        syncGeneration !== directConversationSyncGeneration
      ) {
        return;
      }
      const current = store.getState();
      const conversations = projectDirectConversationResources(
        resources,
        current.account,
        current.conversationSummaries,
      );
      await applyMessagingScope(
        current.channels,
        conversations,
        current.serverContextGeneration,
      );
      if (
        !directConversationActive ||
        epoch !== directConversationEpoch ||
        syncGeneration !== directConversationSyncGeneration
      ) {
        return;
      }
      store.setState({
        directConversations: conversations,
        directConversationSync: "complete",
      });
    } catch (error) {
      if (
        directConversationActive &&
        epoch === directConversationEpoch &&
        syncGeneration === directConversationSyncGeneration
      ) {
        store.setState({
          directConversationSync: "pending",
          error: `私信列表同步失败：${errorMessage(error)}`,
        });
      }
    }
  }

  async function ensureDirectConversationReady(
    active: Extract<ActiveConversation, {kind: "direct"}>,
    clientRequestId: string,
  ): Promise<ConversationAddress> {
    const state = store.getState();
    const serverId = state.currentServerId;
    if (!serverId || !state.account) {
      throw new Error("请先选择 Server");
    }
    const existing = state.directConversations.find(
      (conversation) =>
        conversation.directConversationId === active.directConversationId ||
        conversation.peerMemberId === active.peerMemberId,
    );
    let resource: DirectConversationResource;
    if (existing?.imState === "error") {
      const accepted = await dependencies.platform.retryDirectConversation(
        serverId,
        existing.directConversationId,
        clientRequestId,
      );
      trackOperations(accepted.operations, accepted.resourceId);
      resource = await waitForDirectConversation(
        serverId,
        existing.directConversationId,
      );
    } else if (existing?.imState === "ready") {
      const existingAddress = directAddress(existing);
      if (existingAddress) return existingAddress;
      throw new Error("私信群映射无效，请刷新后重试");
    } else if (existing) {
      resource = await waitForDirectConversation(
        serverId,
        existing.directConversationId,
      );
    } else {
      const result = await dependencies.platform.createDirectConversation(
        serverId,
        active.peerMemberId,
        clientRequestId,
      );
      if (result.kind === "ready") {
        resource = result.resource;
      } else {
        trackOperations(result.accepted.operations, result.accepted.resourceId);
        resource = await waitForDirectConversation(
          serverId,
          result.accepted.resourceId,
        );
      }
    }
    const current = store.getState();
    if (!current.account || current.currentServerId !== serverId) {
      throw new Error("Server 已切换，请重新发送");
    }
    const conversation = projectDirectConversationResource(
      resource,
      current.account,
      current.conversationSummaries,
    );
    const directConversations = upsertDirectConversation(
      current.directConversations,
      conversation,
    );
    await applyMessagingScope(
      current.channels,
      directConversations,
      current.serverContextGeneration,
    );
    const latest = store.getState();
    if (
      latest.currentServerId !== serverId ||
      latest.activeConversation?.kind !== "direct" ||
      latest.activeConversation.peerMemberId !== active.peerMemberId
    ) {
      throw new Error("会话已切换，请重新发送");
    }
    store.setState({
      activeConversation: {
        ...latest.activeConversation,
        directConversationId: conversation.directConversationId,
      },
      directConversations,
      directConversationSync: "complete",
    });
    const address = directAddress(conversation);
    if (!address) {
      throw new Error("私信群尚未就绪，请稍后重试");
    }
    return address;
  }

  async function resolveConversationAddressForSend(
    state: AppStoreState,
    idempotencyKey: string,
  ): Promise<ConversationAddress | null> {
    const address = activeConversationAddress(state);
    if (address) return address;
    const active = state.activeConversation;
    if (!active || active.kind !== "direct") return null;
    return ensureDirectConversationReady(active, idempotencyKey);
  }

  async function loadOrCreateDirectTextIntent(
    state: AppStoreState,
    active: Extract<ActiveConversation, {kind: "direct"}>,
    input: {mentionedUserIds: string[]; text: string},
    generatedRequestId: string,
  ): Promise<DirectSendIntent | null> {
    if (!state.account || !state.currentServerId) {
      throw new Error("请先选择 Server");
    }
    const key = directSendIntentKey(
      state.account.id,
      state.currentServerId,
      active.peerMemberId,
    );
    const existing = dependencies.directSendIntents
      ? await dependencies.directSendIntents.load(key)
      : null;
    if (existing) {
      const confirmed =
        (existing.phase === "sending" || existing.phase === "uncertain") &&
        state.messages.some(
          (message) =>
            message.clientRequestId === existing.clientRequestId &&
            message.delivery.state === "sent",
        );
      if (confirmed) {
        await removeDirectSendIntent(existing);
        if (existing.text === input.text) {
          return null;
        }
      }
      if (
        !confirmed &&
        existing.kind === "text" &&
        existing.phase === "preparing"
      ) {
        if (existing.text === input.text) {
          return existing;
        }
        const updated = {
          ...existing,
          mentionedUserIds: [],
          text: input.text,
          updatedAt: new Date().toISOString(),
        };
        await saveDirectSendIntent(updated);
        return updated;
      }
      if (!confirmed) {
        throw new Error("上一条私信仍在处理中，请确认结果后再发送");
      }
    }
    const now = new Date().toISOString();
    const intent: DirectSendIntent = {
      accountId: state.account.id,
      clientRequestId: generatedRequestId,
      createdAt: now,
      idempotencyKey: generatedRequestId,
      kind: "text",
      mentionedUserIds: [],
      peerMemberId: active.peerMemberId,
      phase: "preparing",
      schemaVersion: 1,
      serverId: state.currentServerId,
      text: input.text,
      updatedAt: now,
    };
    await saveDirectSendIntent(intent);
    return intent;
  }

  async function saveDirectSendIntent(
    intent: DirectSendIntent,
  ): Promise<void> {
    if (!dependencies.directSendIntents) return;
    await dependencies.directSendIntents.save(
      directSendIntentKey(
        intent.accountId,
        intent.serverId,
        intent.peerMemberId,
      ),
      intent,
    );
  }

  async function removeDirectSendIntent(
    intent: DirectSendIntent,
  ): Promise<void> {
    if (!dependencies.directSendIntents) return;
    await dependencies.directSendIntents.remove(
      directSendIntentKey(
        intent.accountId,
        intent.serverId,
        intent.peerMemberId,
      ),
    );
  }

  async function waitForDirectConversation(
    serverId: string,
    directConversationId: string,
  ): Promise<DirectConversationResource> {
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
      try {
        const conversation =
          await dependencies.platform.getDirectConversation(
            serverId,
            directConversationId,
          );
        if (conversation.status !== "active") {
          throw new Error("私信会话已关闭");
        }
        if (conversation.imState === "ready") {
          return conversation;
        }
        if (conversation.imState === "error" || conversation.imState === "deleted") {
          throw new Error("私信群创建失败，请重试");
        }
      } catch (error) {
        if (attempt === pollLimit - 1) throw error;
      }
      await sleep(pollInterval);
    }
    throw new Error("私信群仍在创建中，请稍后重试");
  }

  async function waitForServer(serverId: string): Promise<Server> {
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
      const server = await dependencies.platform.getServer(serverId);
      if (server.imState === "ready") {
        return server;
      }
      if (server.imState === "error") {
        throw new Error("Server 创建失败，请稍后重试");
      }
      await sleep(pollInterval);
    }
    throw new Error("Server 创建仍在处理中，请稍后重试");
  }

  async function waitForChannel(
    serverId: string,
    channelId: string,
  ): Promise<Channel> {
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
      const channels = await dependencies.platform.listChannels(serverId);
      const channel = channels.find((item) => item.id === channelId);
      if (channel?.imState === "error") {
        throw new Error("Channel 创建失败，请稍后重试");
      }
      if (channel && isWritableChannel(channel)) {
        return channel;
      }
      await sleep(pollInterval);
    }
    throw new Error("Channel 创建仍在处理中，请稍后重试");
  }

  async function waitForAgent(
    serverId: string,
    agentId: string,
    ready: (agent: Agent) => boolean,
    timeoutMessage: string,
  ): Promise<Agent | null> {
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
      if (store.getState().currentServerId !== serverId) return null;
      const agents = await dependencies.platform.listAgents(serverId);
      if (store.getState().currentServerId !== serverId) return null;
      store.setState({agents});
      const agent = agents.find((item) => item.id === agentId);
      if (agent?.imState === "error") {
        throw new Error("Agent 身份创建失败，请检查错误后重试");
      }
      if (agent?.observedState === "error") {
        throw new Error("Agent 部署失败，请检查运行状态后重试");
      }
      if (agent && ready(agent)) return agent;
      if (attempt < pollLimit - 1) await sleep(pollInterval);
    }
    throw new Error(timeoutMessage);
  }

  async function loadThreadReplyPage(
    thread: MessageThread,
    cursor: string | undefined,
    replace: boolean,
  ): Promise<void> {
    const state = store.getState();
    const serverId = state.currentServerId;
    const channel = state.channels.find(
      (item) => item.id === state.currentChannelId,
    );
    const address = channel ? channelAddress(channel) : null;
    if (
      !serverId ||
      !channel ||
      !address ||
      thread.serverId !== serverId ||
      thread.channelId !== channel.id
    ) {
      store.setState({
        error: "Thread 与当前 Channel 不匹配",
        threadLoading: false,
      });
      return;
    }
    if (state.threadLoading && !replace) return;
    const selection = conversationSelection;
    store.setState({
      error: null,
      threadLoading: true,
      ...(replace
        ? {
            threadCompleted: false,
            threadCursor: null,
            threadMessages: [],
          }
        : {}),
    });
    try {
      const page = await dependencies.platform.listThreadReplies(
        serverId,
        channel.id,
        thread.id,
        cursor,
      );
      const hydrated = await dependencies.messaging.loadMessagesByReferences(
        address,
        page.items.map((item) => item.messageRef),
      );
      if (
        selection !== conversationSelection ||
        store.getState().activeThread?.id !== thread.id
      ) {
        return;
      }
      const hydratedByMessageId = new Map(
        hydrated.map((message) => [
          message.reference?.messageId ?? message.id,
          message,
        ]),
      );
      const current = store.getState();
      const replies = page.items.map((item) => {
        const hydratedMessage = hydratedByMessageId.get(
          item.messageRef.messageId,
        );
        const message =
          hydratedMessage ??
          unavailableThreadMessage(item, thread, current.account, [
            ...current.members,
            ...current.channelMembers,
          ]);
        return {
          ...message,
          thread: message.thread ?? {
            role: "reply" as const,
            rootMessageRef: thread.rootMessageRef,
            threadId: thread.id,
          },
        };
      });
      store.setState((current) => ({
        activeThread:
          current.activeThread?.id === thread.id
            ? { ...current.activeThread, unreadCount: 0 }
            : current.activeThread,
        threadCompleted: !page.nextCursor,
        threadCursor: page.nextCursor ?? null,
        threadLoading: false,
        threadMessages: replace
          ? mergeMessages([], replies)
          : mergeMessages(current.threadMessages, replies),
      }));
      const last = page.items.at(-1);
      if (last) {
        await dependencies.platform.markThreadRead(
          serverId,
          channel.id,
          thread.id,
          last.id,
          `${requestId()}:thread:read`,
        );
      }
    } catch (error) {
      if (selection === conversationSelection) {
        store.setState({
          error: errorMessage(error),
          threadLoading: false,
        });
      }
    }
  }

  async function runMessageSearch(
    query: string,
    cursor: string | undefined,
    replace: boolean,
  ): Promise<void> {
    const state = store.getState();
    if (state.searchingMessages) return;
    const address = activeConversationAddress(state);
    if (!address) {
      store.setState({
        searchError: "请先选择可搜索的会话",
        searchLocateError: null,
      });
      return;
    }
    const selection = conversationSelection;
    store.setState({
      searchCompleted: false,
      searchCursor: cursor ?? null,
      searchError: null,
      searchLocateError: null,
      locatingSearchResultId: null,
      messageFocusRequest: null,
      searchingMessages: true,
      searchQuery: query,
      ...(replace ? { searchResults: [] } : {}),
    });
    try {
      const page = await dependencies.messaging.searchMessages({
        channel: address,
        ...(cursor ? { cursor } : {}),
        limit: 20,
        query,
      });
      if (selection !== conversationSelection) return;
      store.setState((current) => ({
        searchCompleted: page.completed,
        searchCursor: page.nextCursor ?? null,
        searchError: null,
        searchLocateError: null,
        searchingMessages: false,
        searchResults: replace
          ? mergeMessages([], page.messages)
          : mergeMessages(current.searchResults, page.messages),
      }));
    } catch (error) {
      if (selection === conversationSelection) {
        store.setState({
          searchError: errorMessage(error),
          searchingMessages: false,
        });
      }
    }
  }

  async function changeCurrentChannelMember(
    memberId: string,
    operation: "add" | "remove",
    keepPending = false,
  ): Promise<AcceptedResource | null> {
    const state = store.getState();
    if (state.pendingAction) return null;
    const serverId = state.currentServerId;
    const channelId = state.currentChannelId;
    if (!serverId || !channelId) {
      store.setState({ error: "请先选择 Channel" });
      return null;
    }
    const action = `channel:${channelId}:member:${memberId}:${operation}`;
    store.setState({ error: null, pendingAction: action });
    try {
      const mutate =
        operation === "add"
          ? dependencies.platform.addChannelMember.bind(dependencies.platform)
          : dependencies.platform.removeChannelMember.bind(
              dependencies.platform,
            );
      const accepted = await mutate(
        serverId,
        channelId,
        memberId,
        `${requestId()}:channel:member:${operation}`,
      );
      // Channel membership operations belong to the Channel management
      // surface even though the backend resource is the membership row.
      trackOperations(accepted.operations, channelId);
      const channelMembers = await dependencies.platform.listChannelMembers(
        serverId,
        channelId,
      );
      store.setState({
        channelMembers,
        ...(keepPending ? {} : {pendingAction: null}),
      });
      return accepted;
    } catch (error) {
      store.setState({
        error: errorMessage(error),
        pendingAction: null,
      });
      return null;
    }
  }

  async function compensateChannelMembership(
    serverId: string,
    channelId: string,
    selection: number,
  ): Promise<boolean> {
    const repairKey = `${serverId}:${channelId}`;
    if (channelMembershipRepairs.has(repairKey)) return false;
    const state = store.getState();
    const currentAccount = state.account;
    const currentMember = currentAccount
      ? state.members.find((member) => isSelfMember(member, currentAccount))
      : undefined;
    if (!currentMember) return false;

    const repairAction = `channel:${channelId}:member:${currentMember.id}:add`;
    channelMembershipRepairs.add(repairKey);
    try {
      const accepted = await changeCurrentChannelMember(
        currentMember.id,
        "add",
        true,
      );
      if (!accepted) return true;
      const operation = accepted.operations.find(
        (candidate) => candidate.kind === "im.membership.ensure",
      );
      if (!operation) {
        store.setState({error: "频道成员同步没有返回可跟踪的操作"});
        return true;
      }
      await startOperationPoll(operation.id);
      const current = store.getState();
      if (
        selection !== conversationSelection ||
        current.currentServerId !== serverId ||
        current.activeConversation?.kind !== "channel" ||
        current.activeConversation.channelId !== channelId
      ) {
        return true;
      }
      const tracked = current.operationsById[operation.id];
      if (tracked?.operation.state !== "succeeded") {
        store.setState({error: "频道成员同步没有完成，请稍后重试"});
        return true;
      }
      await current.selectChannel(channelId);
      return true;
    } finally {
      channelMembershipRepairs.delete(repairKey);
      store.setState((current) =>
        current.pendingAction === repairAction ? {pendingAction: null} : {},
      );
    }
  }

  function trackOperations(operations: Operation[], resourceId?: string): void {
    store.setState((current) => {
      const operationsById = { ...current.operationsById };
      for (const operation of operations) {
        const previous = operationsById[operation.id];
        operationsById[operation.id] = {
          operation,
          pollingState: isOperationTerminal(operation)
            ? "terminal"
            : previous?.pollingState === "polling"
              ? "polling"
              : "idle",
          ...((resourceId ?? previous?.resourceId)
            ? { resourceId: resourceId ?? previous?.resourceId }
            : {}),
        };
      }
      return { operationsById };
    });
  }

  function cancelOperationPolls(operationId?: string): void {
    operationPollGeneration += 1;
    if (operationId) {
      operationPollFlights.get(operationId)?.controller.abort();
      return;
    }
    for (const flight of operationPollFlights.values()) {
      flight.controller.abort();
    }
  }

  async function startOperationPoll(operationId: string): Promise<void> {
    const existing = operationPollFlights.get(operationId);
    if (existing) return existing.promise;
    const state = store.getState();
    const tracked = state.operationsById[operationId];
    const serverId = state.currentServerId;
    if (!tracked || !serverId || isOperationTerminal(tracked.operation)) {
      return;
    }

    const controller = new AbortController();
    const generation = ++operationPollGeneration;
    const contextGeneration = state.serverContextGeneration;
    const flight = {
      controller,
      generation,
      promise: Promise.resolve(),
    };
    operationPollFlights.set(operationId, flight);
    store.setState((current) => ({
      operationsById: updateTrackedOperation(
        current.operationsById,
        operationId,
        { pollingState: "polling" },
      ),
    }));

    flight.promise = (async () => {
      try {
        const result = await pollOperation({
          initial: tracked.operation,
          load: (_signal) =>
            dependencies.platform.getOperation(serverId, operationId),
          ...(dependencies.operationPollNow
            ? { now: dependencies.operationPollNow }
            : {}),
          onUpdate(operation) {
            if (
              !operationPollIsCurrent(
                operationId,
                generation,
                serverId,
                contextGeneration,
              )
            )
              return;
            store.setState((current) => ({
              operationsById: updateTrackedOperation(
                current.operationsById,
                operationId,
                { operation, pollingState: "polling" },
              ),
            }));
          },
          signal: controller.signal,
          ...(dependencies.operationPollSleep
            ? { sleep: dependencies.operationPollSleep }
            : {}),
        });
        if (
          !operationPollIsCurrent(
            operationId,
            generation,
            serverId,
            contextGeneration,
          )
        )
          return;

        if (result.kind === "aborted") {
          store.setState((current) => ({
            operationsById: updateTrackedOperation(
              current.operationsById,
              operationId,
              { pollingState: "idle" },
            ),
          }));
          return;
        }
        const patch: Partial<TrackedOperation> = {
          operation: result.operation,
          pollingState: result.kind,
        };
        if (result.kind === "query_error") {
          patch.message = result.error.message;
        } else if (result.kind === "rate_limited") {
          patch.message = "请求过于频繁，请稍后继续查询";
          patch.retryAfterSeconds = result.retryAfterSeconds;
        }
        store.setState((current) => ({
          operationsById: updateTrackedOperation(
            current.operationsById,
            operationId,
            patch,
          ),
        }));
        if (
          result.kind === "terminal" &&
          result.operation.kind === "agent.profile.capabilities.refresh" &&
          tracked.resourceId
        ) {
          const capabilities = await dependencies.platform.getAgentProfileCapabilities(
            serverId,
            tracked.resourceId,
          );
          if (
            operationPollIsCurrent(
              operationId,
              generation,
              serverId,
              contextGeneration,
            )
          ) {
            store.setState((current) => ({
              agentProfileCapabilitiesById: {
                ...current.agentProfileCapabilitiesById,
                [tracked.resourceId as string]: capabilities,
              },
            }));
          }
        }
        if (
          result.kind === "terminal" &&
          result.operation.kind.startsWith("im.membership.")
        ) {
          const before = store
            .getState()
            .channels.find((channel) => channel.id === tracked.resourceId);
          const channels = await dependencies.platform.listChannels(serverId);
          if (
            !operationPollIsCurrent(
              operationId,
              generation,
              serverId,
              contextGeneration,
            )
          ) {
            return;
          }
          await applyMessagingScope(
            channels,
            store.getState().directConversations,
            contextGeneration,
          );
          if (
            !operationPollIsCurrent(
              operationId,
              generation,
              serverId,
              contextGeneration,
            )
          ) {
            return;
          }
          store.setState({ channels });
          const current = store.getState();
          const after = channels.find(
            (channel) => channel.id === tracked.resourceId,
          );
          if (
            result.operation.state === "succeeded" &&
            current.activeConversation?.kind === "channel" &&
            current.activeConversation.channelId === tracked.resourceId &&
            before?.joined === false &&
            after?.joined === true
          ) {
            await current.selectChannel(tracked.resourceId);
          }
        }
      } catch (error) {
        if (
          operationPollIsCurrent(
            operationId,
            generation,
            serverId,
            contextGeneration,
          )
        ) {
          store.setState((current) => ({
            error: errorMessage(error),
            operationsById: updateTrackedOperation(
              current.operationsById,
              operationId,
              { message: errorMessage(error), pollingState: "query_error" },
            ),
          }));
        }
      } finally {
        if (operationPollFlights.get(operationId)?.generation === generation) {
          operationPollFlights.delete(operationId);
        }
      }
    })();
    return flight.promise;
  }

  function operationPollIsCurrent(
    operationId: string,
    generation: number,
    serverId: string,
    contextGeneration: number,
  ): boolean {
    const current = store.getState();
    return (
      operationPollFlights.get(operationId)?.generation === generation &&
      current.currentServerId === serverId &&
      current.serverContextGeneration === contextGeneration
    );
  }

  submissionCoordinator = new SubmissionCoordinator({
    messaging: dependencies.messaging,
    onMessage(message) {
      store.setState((current) => ({
        messages: mergeConfirmedMessage(current.messages, message),
      }));
    },
    onProgress(clientRequestId, progress) {
      store.setState((current) => ({
        messages: current.messages.map((message) =>
          message.clientRequestId === clientRequestId
            ? {
                ...message,
                delivery: {progress, state: "uploading" as const},
              }
            : message,
        ),
      }));
    },
    onChange(submission) {
      store.setState((current) => {
        const submissions = {...current.submissions};
        if (
          submission.phase === "committed" ||
          submission.phase === "cancelled"
        ) {
          delete submissions[submission.id];
        } else {
          submissions[submission.id] = submission;
        }
        return {
          submissions,
          messages: current.messages.map((message) => {
            const part = submission.parts.find(
              (item) => item.clientRequestId === message.clientRequestId,
            );
            if (!part) return message;
            if (part.status === "sent") {
              return {...message, delivery: {state: "sent" as const}};
            }
            if (part.status === "failed") {
              return {
                ...message,
                delivery: {
                  error: part.error ?? "发送失败",
                  retryable: part.retryable === true,
                  state: "failed" as const,
                },
              };
            }
            if (part.status === "cancelled") {
              return {
                ...message,
                delivery: {
                  error: "发送已取消",
                  retryable: false,
                  state: "failed" as const,
                },
              };
            }
            return {
              ...message,
              delivery:
                part.role === "attachment" && part.status === "sending"
                  ? {progress: 0, state: "uploading" as const}
                  : {state: "sending" as const},
            };
          }),
        };
      });
    },
  });

  return store;
}

export function mentionableAgents(
  state: Pick<
    AppStoreState,
    | "activeConversation"
    | "agents"
    | "channelMembers"
    | "channels"
    | "members"
  >,
): Agent[] {
  const active = state.activeConversation;
  if (active?.kind !== "channel") {
    return [];
  }
  const channel = state.channels.find((item) => item.id === active.channelId);
  if (!channel) {
    return [];
  }
  if (isEveryoneChannel(channel)) {
    return state.agents.filter(
      (agent) =>
        agent.imState === "ready" &&
        state.members.some(
          (member) =>
            member.kind === "agent" &&
            member.status === "active" &&
            member.imUserId === agent.imUserId,
        ),
    );
  }
  return state.agents.filter(
    (agent) => agentMentionEligibility(agent, state.channelMembers).allowed,
  );
}

export function mentionableMembers(
  state: Pick<
    AppStoreState,
    "activeConversation" | "channelMembers" | "channels" | "members"
  >,
): Array<Member & {imUserId: string}> {
  const active = state.activeConversation;
  if (active?.kind !== "channel") return [];
  const channel = state.channels.find((item) => item.id === active.channelId);
  if (!channel) return [];
  const candidates = isEveryoneChannel(channel)
    ? state.members
    : state.channelMembers;
  return candidates.filter(
    (member): member is Member & {imUserId: string} =>
      member.status === "active" &&
      member.imState === "ready" &&
      typeof member.imUserId === "string" &&
      member.imUserId.trim().length > 0,
  );
}

function conversationDraftKey(
  conversation: ActiveConversation | null,
): string | null {
  if (!conversation) return null;
  return conversation.kind === "channel"
    ? `channel:${conversation.channelId}`
    : `direct:${conversation.peerMemberId}`;
}

function activeConversationAddress(
  state: AppStoreState,
): ConversationAddress | null {
  const active = state.activeConversation;
  if (!active) return null;
  if (active.kind === "direct") {
    const conversation = state.directConversations.find(
      (item) =>
        item.directConversationId === active.directConversationId ||
        item.peerMemberId === active.peerMemberId,
    );
    return conversation ? directAddress(conversation) : null;
  }
  const channel = state.channels.find((item) => item.id === active.channelId);
  return channel ? channelAddress(channel) : null;
}

function searchResultReference(
  address: ConversationAddress,
  message: Message,
): MessageReference {
  if (message.reference) return message.reference;
  const timestamp = Math.floor(Date.parse(message.createdAt) / 1_000);
  return {
    kind: "group",
    messageId: message.id,
    senderUserId: message.senderId,
    ...(Number.isSafeInteger(timestamp) && timestamp > 0 ? {timestamp} : {}),
    ...("imGroupId" in address && address.imGroupId
      ? {groupId: address.imGroupId}
      : {}),
    ...("imTopicId" in address
      ? {topicId: address.imTopicId ?? null}
      : {}),
  };
}

function projectDirectConversationResources(
  resources: DirectConversationResource[],
  account: Account | null,
  summaries: ConversationSummary[],
): DirectConversation[] {
  if (!account) return [];
  return resources
    .filter((resource) => resource.status !== "closed")
    .map((resource) =>
      projectDirectConversationResource(resource, account, summaries),
    );
}

function projectDirectConversationResource(
  resource: DirectConversationResource,
  account: Account,
  summaries: ConversationSummary[],
): DirectConversation {
  const selfIsA = isSelfMember(resource.memberA, account);
  const selfIsB = isSelfMember(resource.memberB, account);
  if (selfIsA === selfIsB) {
    throw new Error("私信成员与当前账号不匹配");
  }
  const peer = selfIsA ? resource.memberB : resource.memberA;
  const conversationId = `GROUP${resource.imGroupId}`;
  const summary = summaries.find(
    (candidate) => candidate.conversationId === conversationId,
  );
  return {
    conversationId,
    directConversationId: resource.id,
    imGroupId: resource.imGroupId,
    imState: resource.imState,
    ...(summary?.lastMessageAt ? {lastMessageAt: summary.lastMessageAt} : {}),
    lastMessagePreview: summary?.lastMessagePreview ?? "",
    peerDisplayName: peer.displayName,
    peerMemberId: peer.id,
    peerUserId: peer.imUserId?.trim() ?? "",
    unreadCount: summary?.unreadCount ?? 0,
  };
}

function isSelfMember(member: Member, account: Account): boolean {
  return (
    member.accountId === account.id ||
    Boolean(account.imUserId && member.imUserId === account.imUserId)
  );
}

function upsertDirectConversation(
  conversations: DirectConversation[],
  conversation: DirectConversation,
): DirectConversation[] {
  const next = conversations.filter(
    (candidate) =>
      candidate.directConversationId !== conversation.directConversationId &&
      candidate.peerMemberId !== conversation.peerMemberId,
  );
  return [conversation, ...next];
}

function enrichDirectConversationSummaries(
  conversations: DirectConversation[],
  summaries: ConversationSummary[],
): DirectConversation[] {
  const byConversationId = new Map(
    summaries.map((summary) => [summary.conversationId, summary]),
  );
  return conversations.map((conversation) => {
    const summary = byConversationId.get(conversation.conversationId);
    if (!summary) return conversation;
    return {
      ...conversation,
      ...(summary.lastMessageAt ? {lastMessageAt: summary.lastMessageAt} : {}),
      lastMessagePreview: summary.lastMessagePreview,
      unreadCount: summary.unreadCount,
    };
  });
}

function enrichDirectConversations(
  conversations: DirectConversation[],
  members: Member[],
): DirectConversation[] {
  const membersByImUserId = new Map(
    members
      .filter((member) => member.imUserId)
      .map((member) => [member.imUserId as string, member]),
  );
  return conversations.map((conversation) => {
    const member = membersByImUserId.get(conversation.peerUserId);
    return member
      ? {
          ...conversation,
          peerDisplayName: member.displayName,
        }
      : conversation;
  });
}

function messagesForConversation(
  messages: Message[],
  conversationId: string,
): Message[] {
  return channelMessages(
    messages.filter((message) => message.conversationId === conversationId),
  );
}

function isWritableChannel(channel: Channel): boolean {
  return channelAddress(channel) !== null;
}

function currentServer(state: AppStoreState): Server | null {
  if (state.currentServerId) {
    return (
      state.servers.find((server) => server.id === state.currentServerId) ??
      null
    );
  }
  return state.servers[0] ?? null;
}

function upsertServer(servers: Server[], server: Server): Server[] {
  const index = servers.findIndex((item) => item.id === server.id);
  if (index < 0) {
    return [...servers, server];
  }
  return servers.map((item) => (item.id === server.id ? server : item));
}

function upsertTask(tasks: Task[], task: Task): Task[] {
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index < 0) return [...tasks, task];
  return tasks.map((item) => (item.id === task.id ? task : item));
}

function upsertReminder(reminders: Reminder[], reminder: Reminder): Reminder[] {
  const index = reminders.findIndex((item) => item.id === reminder.id);
  if (index < 0) return [...reminders, reminder];
  return reminders.map((item) => (item.id === reminder.id ? reminder : item));
}

function sortReminders(reminders: Reminder[]): Reminder[] {
  const statusRank: Record<Reminder["status"], number> = {
    active: 0,
    paused: 1,
    completed: 2,
    canceled: 3,
  };
  return [...reminders].sort((left, right) => {
    const statusOrder = statusRank[left.status] - statusRank[right.status];
    if (statusOrder !== 0) return statusOrder;
    if (left.status === "active") {
      const leftFire = left.nextFireAt
        ? Date.parse(left.nextFireAt)
        : Number.POSITIVE_INFINITY;
      const rightFire = right.nextFireAt
        ? Date.parse(right.nextFireAt)
        : Number.POSITIVE_INFINITY;
      if (leftFire !== rightFire) return leftFire - rightFire;
    }
    return left.id.localeCompare(right.id);
  });
}

function updateTrackedOperation(
  operations: Record<string, TrackedOperation>,
  operationId: string,
  patch: Partial<TrackedOperation>,
): Record<string, TrackedOperation> {
  const current = operations[operationId];
  if (!current) return operations;
  return {
    ...operations,
    [operationId]: { ...current, ...patch },
  };
}

function upsertAgent(agents: Agent[], agent: Agent): Agent[] {
  const index = agents.findIndex((item) => item.id === agent.id);
  if (index < 0) return [...agents, agent];
  return agents.map((item) => (item.id === agent.id ? agent : item));
}

function upsertComputer(computers: Computer[], computer: Computer): Computer[] {
  const index = computers.findIndex((item) => item.id === computer.id);
  if (index < 0) return [...computers, computer];
  return computers.map((item) => (item.id === computer.id ? computer : item));
}

function upsertChannel(channels: Channel[], channel: Channel): Channel[] {
  const index = channels.findIndex((item) => item.id === channel.id);
  if (index < 0) return [...channels, channel];
  return channels.map((item) => (item.id === channel.id ? channel : item));
}

function upsertInvite(invites: Invite[], invite: Invite): Invite[] {
  const index = invites.findIndex((item) => item.id === invite.id);
  if (index < 0) return [...invites, invite];
  return invites.map((item) => (item.id === invite.id ? invite : item));
}

function upsertMember(members: Member[], member: Member): Member[] {
  const index = members.findIndex((item) => item.id === member.id);
  if (index < 0) return [...members, member];
  return members.map((item) => (item.id === member.id ? member : item));
}

function optimisticAttachmentMessage(input: {
  account: Account | null;
  clientRequestId: string;
  conversationId: string;
  kind: "file" | "image";
  quote?: MessageQuote;
  source: AttachmentSource;
  submission?: Message["submission"];
}): Message {
  const senderId =
    input.account?.imUserId ?? input.account?.id ?? "current-user";
  const common = {
    clientRequestId: input.clientRequestId,
    conversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    delivery: { progress: 0, state: "uploading" as const },
    direction: "outgoing" as const,
    id: `local:${input.clientRequestId}`,
    mentions: [],
    ...(input.quote ? { quote: input.quote } : {}),
    rawType: `local:${input.kind}`,
    reactions: [],
    read: { state: "unknown" as const },
    senderId,
    senderName: input.account?.displayName ?? senderId,
    ...(input.submission ? {submission: input.submission} : {}),
  };
  if (input.kind === "image") {
    const previewUri =
      input.source.kind === "uri"
        ? input.source.uri
        : input.source.previewUri;
    return {
      ...common,
      content: {
        kind: "image",
        ...(input.source.height !== undefined
          ? {height: input.source.height}
          : {}),
        name: input.source.name,
        ...(input.source.size !== undefined ? { size: input.source.size } : {}),
        ...(previewUri ? {url: previewUri} : {}),
        ...(input.source.width !== undefined
          ? {width: input.source.width}
          : {}),
      },
      kind: "image",
      text: "[图片]",
    };
  }
  return {
    ...common,
    content: {
      kind: "file",
      ...(input.source.mimeType ? { mimeType: input.source.mimeType } : {}),
      name: input.source.name,
      ...(input.source.size !== undefined ? { size: input.source.size } : {}),
    },
    kind: "file",
    text: input.source.name,
  };
}

function mergeConfirmedMessage(
  existing: Message[],
  confirmed: Message,
): Message[] {
  const optimistic = confirmed.clientRequestId
    ? existing.find(
        (message) => message.clientRequestId === confirmed.clientRequestId,
      )
    : undefined;
  if (
    optimistic?.content.kind !== "image" ||
    confirmed.content.kind !== "image"
  ) {
    return mergeMessages(existing, [confirmed]);
  }
  return mergeMessages(existing, [
    {
      ...confirmed,
      content: {
        ...optimistic.content,
        ...confirmed.content,
      },
    },
  ]);
}

function optimisticTextMessage(input: {
  account: Account | null;
  clientRequestId: string;
  conversationId: string;
  mentions: string[];
  quote?: MessageQuote;
  submission?: Message["submission"];
  text: string;
}): Message {
  const senderId =
    input.account?.imUserId ?? input.account?.id ?? "current-user";
  return {
    clientRequestId: input.clientRequestId,
    content: { kind: "text", text: input.text },
    conversationId: input.conversationId,
    createdAt: new Date().toISOString(),
    delivery: { state: "sending" },
    direction: "outgoing",
    id: `local:${input.clientRequestId}`,
    kind: "text",
    mentions: input.mentions,
    ...(input.quote ? { quote: input.quote } : {}),
    rawType: "local:text",
    reactions: [],
    read: { state: "unknown" },
    senderId,
    senderName: input.account?.displayName ?? senderId,
    ...(input.submission ? {submission: input.submission} : {}),
    text: input.text,
  };
}

function cloneComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    attachments: draft.attachments.map((attachment) => ({...attachment})),
    document: createComposerDocument(draft.document.nodes),
    ...(draft.quote ? {quote: {...draft.quote}} : {}),
  };
}

function uuidV7(now = Date.now()): string {
  const random = new Uint8Array(10);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }
  const timestamp = BigInt(now) & 0xffffffffffffn;
  const bytes = new Uint8Array(16);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8) & 0xffn);
  }
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  bytes[7] = random[1] ?? 0;
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  bytes.set(random.slice(3), 9);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .replace(
      /^(........)(....)(....)(....)(............)$/u,
      "$1-$2-$3-$4-$5",
    );
}

function toggleMessageReaction(
  reactions: Message["reactions"],
  reactionId: string,
  active: boolean,
): Message["reactions"] {
  const existing = reactions.find(
    (reaction) => reaction.reactionId === reactionId,
  );
  if (!existing) {
    return active
      ? [
          ...reactions,
          {
            count: 1,
            reactedByMe: true,
            reactionId,
          },
        ]
      : reactions;
  }
  if (active) {
    return reactions.map((reaction) =>
      reaction.reactionId === reactionId
        ? {
            ...reaction,
            count: reaction.count + (reaction.reactedByMe ? 0 : 1),
            reactedByMe: true,
          }
        : reaction,
    );
  }
  const count = Math.max(0, existing.count - (existing.reactedByMe ? 1 : 0));
  if (count === 0) {
    return reactions.filter((reaction) => reaction.reactionId !== reactionId);
  }
  return reactions.map((reaction) =>
    reaction.reactionId === reactionId
      ? { ...reaction, count, reactedByMe: false }
      : reaction,
  );
}

function unavailableThreadMessage(
  reply: ThreadReplyReference,
  thread: MessageThread,
  account: Account | null,
  members: Member[],
): Message {
  const senderId = reply.messageRef.senderUserId ?? "unknown";
  const senderName =
    (account?.imUserId === senderId ? account.displayName : undefined) ??
    members.find((member) => member.imUserId === senderId)?.displayName ??
    "未知成员";
  return {
    content: {
      kind: "unsupported",
      rawType: "VELA_MESSAGE_UNAVAILABLE",
    },
    conversationId: `GROUP${
      reply.messageRef.topicId ?? reply.messageRef.groupId ?? thread.channelId
    }`,
    createdAt: reply.createdAt,
    delivery: { state: "sent" },
    direction: account?.imUserId === senderId ? "outgoing" : "incoming",
    id: reply.messageRef.messageId,
    kind: "unsupported",
    mentions: [],
    rawType: "VELA_MESSAGE_UNAVAILABLE",
    reactions: [],
    read: { state: "unknown" },
    reference: reply.messageRef,
    senderId,
    senderName,
    text: "消息已不可用",
    thread: {
      role: "reply",
      rootMessageRef: thread.rootMessageRef,
      threadId: thread.id,
    },
  };
}

function threadMessageReference(
  channel: Channel,
  message: Message,
): MessageReference | null {
  const sequence = message.reference?.sequence;
  const timestamp =
    message.reference?.timestamp ??
    Math.floor(Date.parse(message.createdAt) / 1_000);
  if (
    !Number.isSafeInteger(sequence) ||
    (sequence as number) <= 0 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0
  ) {
    return null;
  }
  return {
    ...(channel.imGroupId ? { groupId: channel.imGroupId } : {}),
    kind: "group",
    messageId: message.id,
    sequence,
    senderUserId: message.senderId,
    timestamp,
    topicId: channel.imTopicId ?? null,
  };
}

function channelMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.thread?.role !== "reply");
}

function mergeConversationSummaries(
  current: ConversationSummary[],
  updates: ConversationSummary[],
): ConversationSummary[] {
  const byId = new Map(
    current.map((summary) => [summary.conversationId, summary]),
  );
  updates.forEach((summary) => byId.set(summary.conversationId, summary));
  return [...byId.values()].sort((left, right) =>
    (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""),
  );
}

function updateConversationSummariesFromMessages(
  current: ConversationSummary[],
  channels: Channel[],
  messages: Message[],
  activeConversationId: string | null,
): ConversationSummary[] {
  const channelsByConversationId = new Map<string, Channel>();
  channels.forEach((channel) => {
    const address = channelAddress(channel);
    if (address) {
      channelsByConversationId.set(address.conversationId, channel);
    }
  });
  let next = current;
  [...messages]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .forEach((message) => {
      const channel = channelsByConversationId.get(message.conversationId);
      if (!channel) return;
      const existing = next.find(
        (summary) => summary.conversationId === message.conversationId,
      );
      if (existing?.lastMessage?.id === message.id) return;
      if (
        existing?.lastMessageAt &&
        message.createdAt < existing.lastMessageAt
      ) {
        return;
      }
      const unreadCount =
        message.conversationId === activeConversationId
          ? 0
          : message.direction === "incoming"
            ? (existing?.unreadCount ?? 0) + 1
            : (existing?.unreadCount ?? 0);
      next = mergeConversationSummaries(next, [
        {
          conversationId: message.conversationId,
          kind: "group",
          lastMessage: message,
          lastMessageAt: message.createdAt,
          lastMessagePreview: message.text,
          title: channel.name,
          unreadCount,
        },
      ]);
    });
  return next;
}

function channelTopicGroupIds(channels: Channel[]): string[] {
  return [
    ...new Set(
      channels
        .map((channel) => channel.imGroupId?.trim())
        .filter((groupId): groupId is string => Boolean(groupId)),
    ),
  ];
}

function updateDirectConversationsFromMessages(
  conversations: DirectConversation[],
  messages: Message[],
  activeConversationId: string | null,
): DirectConversation[] {
  let next = [...conversations];
  for (const message of messages) {
    const index = next.findIndex(
      (conversation) => conversation.conversationId === message.conversationId,
    );
    if (index < 0) continue;
    const current = next[index]!;
    if (current.lastMessageAt && message.createdAt < current.lastMessageAt) {
      continue;
    }
    next[index] = {
      ...current,
      lastMessageAt: message.createdAt,
      lastMessagePreview: message.text,
      unreadCount:
        message.conversationId === activeConversationId
          ? 0
          : message.direction === "incoming"
            ? current.unreadCount + 1
            : current.unreadCount,
    };
  }
  return next.sort((left, right) =>
    (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? ""),
  );
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function isUserSigExpired(error: unknown): boolean {
  return (
    error instanceof PlatformError &&
    error.code === "IM_KICKED_OUT" &&
    error.details?.cause === "user_sig_expired"
  );
}

function isImNotMember(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "IM_NOT_MEMBER";
}

function isForbidden(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "AUTH_FORBIDDEN";
}

function isAuthenticationRequired(error: unknown): boolean {
  return error instanceof PlatformError && error.code === "AUTH_REQUIRED";
}

function lifecycleState(
  event: MessagingLifecycleEvent,
  current: HumanImViewState,
): HumanImViewState {
  if (event.type === "ready") return { status: "ready" };
  if (event.type === "not_ready") {
    return {
      ...(event.reason ? { message: productErrorMessage(event.reason) } : {}),
      status: "not_ready",
    };
  }
  if (event.type === "kicked_out") {
    return {
      message: event.reason
        ? productErrorMessage(event.reason)
        : "消息服务登录已失效，请重新连接",
      status: "kicked_out",
    };
  }
  if (event.type === "network") {
    return { ...current, network: event.state };
  }
  return {
    message: productErrorMessage(event.message),
    status: "error",
  };
}

function defaultRequestId(): string {
  return `client-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function directSendIntentKey(
  accountId: string,
  serverId: string,
  peerMemberId: string,
): string {
  return `${accountId}:${serverId}:${peerMemberId}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? productErrorMessage(error.message)
    : "操作失败，请稍后再试";
}
