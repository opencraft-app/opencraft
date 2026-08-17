import type {
  Account,
  Agent,
  Channel,
  Computer,
  ConversationSummary,
  DirectConversation,
  DirectConversationResource,
  HumanImSession,
  InboxItem,
  Invite,
  Member,
  Message,
  MessageThread,
  MessagingLifecycleEvent,
  Operation,
  RegisterInput,
  Reminder,
  Server,
  Task,
  TerminalSession,
} from "@vela/client-core";
import {
  createComposerDocument,
  createComposerTextDocument,
  MessagingSendError,
  PlatformError,
} from "@vela/client-core";
import {
  createAppStore,
  mentionableAgents,
  type AppStoreDependencies,
} from "./app-store";

const account: Account = {
  id: "account-1",
  displayName: "Skip",
  email: "skip@example.test",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
};

const server: Server = {
  id: "server-1",
  description: "Agent 协作空间",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

const channel: Channel = {
  id: "channel-1",
  joined: true,
  imGroupId: "community-1",
  imState: "ready",
  imTopicId: "topic-1",
  name: "general",
  revision: 1,
  serverId: server.id,
  visibility: "public",
};

const allMembersChannel: Channel = {
  id: "channel-all",
  joined: true,
  imGroupId: "community-1",
  imState: "ready",
  imTopicId: "topic-all",
  name: "全员",
  revision: 1,
  serverId: server.id,
  systemKey: "all",
  visibility: "public",
};

const agent: Agent = {
  availability: "online",
  computerId: "computer-1",
  credentialVersion: 1,
  desiredState: "running",
  displayName: "研究助手",
  handle: "research",
  id: "agent-1",
  imState: "ready",
  imPresence: "online",
  imTransportState: "connected",
  imUserId: "agent-im-1",
  observedState: "running",
  replyPolicy: "mention_and_dm",
  revision: 1,
  runtime: { kind: "codex" },
  serverId: server.id,
};

const agentMember: Member = {
  displayName: agent.displayName,
  handle: agent.handle,
  id: "member-agent-1",
  imState: "ready",
  imUserId: agent.imUserId,
  kind: "agent",
  revision: 1,
  role: "member",
  serverId: server.id,
  status: "active",
};

const task: Task = {
  assignmentRevision: 1,
  createdByMemberId: "member-1",
  id: "task-1",
  number: 1,
  revision: 1,
  serverId: server.id,
  status: "todo",
  title: "验证真实 Agent 回复",
  updatedByMemberId: "member-1",
};

const inboxItem: InboxItem = {
  id: "inbox-task-1",
  kind: "task",
  resourceId: task.id,
  serverId: server.id,
  status: "todo",
  title: task.title,
  updatedAt: "2026-07-31T08:00:00.000Z",
};

const computer: Computer = {
  id: "computer-1",
  lifecycleState: "active",
  name: "研发机",
  osType: "linux",
  revision: 1,
  serverId: server.id,
  connectionState: "online",
};

const ownerMember: Member = {
  accountId: account.id,
  displayName: account.displayName,
  handle: "skip",
  id: "member-1",
  imState: "ready",
  imUserId: account.imUserId,
  kind: "human",
  revision: 1,
  role: "owner",
  serverId: server.id,
  status: "active",
};

const invite: Invite = {
  expiresAt: "2026-08-01T08:00:00.000Z",
  id: "invite-1",
  maxUses: 3,
  revision: 1,
  role: "member",
  serverId: server.id,
  usedCount: 0,
};

const reminder: Reminder = {
  agentId: agent.id,
  createdByMemberId: ownerMember.id,
  id: "019fba00-0000-7000-8000-000000000001",
  nextFireAt: "2026-08-01T10:00:00.000Z",
  revision: 1,
  schedule: "2026-08-01T10:00:00.000Z",
  scheduleKind: "once",
  serverId: server.id,
  status: "active",
  text: "汇报进度",
  timezone: "Asia/Shanghai",
};

const pendingOperation: Operation = {
  createdAt: "2026-08-01T03:00:00.000Z",
  id: "operation-agent-start",
	kind: "agent.start",
	service: "platform",
	state: "succeeded",
};

const completedCredentialRotation: Operation = {
	createdAt: "2026-08-01T03:00:00.000Z",
	id: "operation-agent-credential",
	kind: "agent.credential.rotate",
	service: "platform",
	state: "succeeded",
};

const terminalSession: TerminalSession = {
  authentication: {
    appId: 1_250_000_000,
    instanceId: "rins-test0001",
    uin: "100000000001",
  },
  expiresAt: "2026-08-01T03:05:00.000Z",
  protocol: "tencent-tat-pty-v1",
  sessionId: "one-time-terminal-session",
  terminal: { cols: 120, maxIdleSeconds: 3600, rows: 32 },
  webSocketUrl: "wss://terminal.example.test/connect",
};

const imSession: HumanImSession = {
  expiresAt: "2026-07-31T12:00:00.000Z",
  sdkAppId: 1_600_154_578,
  userId: account.imUserId ?? "human-1",
  userSig: "redacted-test-usersig",
};

const directConversation: DirectConversation = {
  conversationId: "GROUPan_dm_direct_1",
  directConversationId: "direct-1",
  imGroupId: "an_dm_direct_1",
  imState: "ready",
  lastMessageAt: "2026-07-31T10:00:00.000Z",
  lastMessagePreview: "可以开始了",
  peerDisplayName: "研究助手",
  peerMemberId: agentMember.id,
  peerUserId: "agent-im-1",
  unreadCount: 2,
};

const directConversationResource: DirectConversationResource = {
  id: directConversation.directConversationId,
  imGroupId: directConversation.imGroupId,
  imState: "ready",
  memberA: ownerMember,
  memberB: agentMember,
  revision: 1,
  serverId: server.id,
  status: "active",
};

const groupConversation: ConversationSummary = {
  conversationId: "GROUPtopic-1",
  kind: "group",
  lastMessageAt: "2026-07-31T10:00:00.000Z",
  lastMessagePreview: "群聊已经更新",
  title: "general",
  unreadCount: 3,
};

function message(id: string, createdAt: string): Message {
  return {
    content: { kind: "text", text: id },
    conversationId: "GROUPtopic-1",
    createdAt,
    delivery: { state: "sent" },
    direction: "incoming",
    id,
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: { state: "unknown" },
    senderId: agent.imUserId,
    senderName: agent.displayName,
    text: id,
  };
}

function dependencies(): AppStoreDependencies & {
  emitConversations(conversations: ConversationSummary[]): void;
  emitLifecycle(event: MessagingLifecycleEvent): void;
  emitMessages(messages: Message[]): void;
} {
  let conversationListener:
    | ((conversations: ConversationSummary[]) => void)
    | undefined;
  let lifecycleListener: ((event: MessagingLifecycleEvent) => void) | undefined;
  let messageListener: ((messages: Message[]) => void) | undefined;

  return {
    emitConversations(conversations) {
      conversationListener?.(conversations);
    },
    emitLifecycle(event) {
      lifecycleListener?.(event);
    },
    emitMessages(messages) {
      messageListener?.(messages);
    },
    messaging: {
      close: jest.fn(async () => undefined),
      connect: jest.fn(async () => undefined),
      listConversations: jest.fn(async () => ({
        isSyncCompleted: true,
        items: [groupConversation],
      })),
      loadHistory: jest.fn(async () => ({
        completed: true,
        messages: [
          message("history-2", "2026-07-30T02:00:00.000Z"),
          message("history-1", "2026-07-30T01:00:00.000Z"),
        ],
      })),
      loadMessageContext: jest.fn(async () => []),
      loadMessagesByReferences: jest.fn(async () => []),
      markRead: jest.fn(async () => undefined),
      reconcileMessage: jest.fn(async () => ({state: "pending" as const})),
      retryMessage: jest.fn(async () =>
        message("retried-1", "2026-07-30T04:00:00.000Z"),
      ),
      revokeMessage: jest.fn(async (messageId) => ({
        ...message(messageId, "2026-07-30T04:00:00.000Z"),
        content: {kind: "system" as const, text: "[消息已撤回]"},
        kind: "system" as const,
        rawType: "TIMRevokedElem",
        text: "[消息已撤回]",
      })),
      searchMessages: jest.fn(async () => ({
        completed: true,
        messages: [],
        totalCount: 0,
      })),
      setScope: jest.fn(async () => undefined),
      sendAttachment: jest.fn(async () => ({
        ...message("sent-attachment-1", "2026-07-30T04:00:00.000Z"),
        content: {
          kind: "image" as const,
          name: "diagram.png",
          url: "https://example.invalid/diagram.png",
        },
        kind: "image" as const,
        text: "[图片]",
      })),
      sendTask: jest.fn(async (input) => ({
        ...message("sent-task-1", "2026-07-30T04:00:00.000Z"),
        clientRequestId: input.clientRequestId,
        content: {
          kind: "task" as const,
          ...input.task,
        },
        kind: "task" as const,
        text: input.task.title,
      })),
      sendText: jest.fn(async (input) => ({
        ...message("sent-1", "2026-07-30T04:00:00.000Z"),
        clientRequestId: input.clientRequestId,
      })),
      subscribeConversations(listener) {
        conversationListener = listener;
        return () => {
          conversationListener = undefined;
        };
      },
      subscribeLifecycle(listener) {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = undefined;
        };
      },
      subscribeMessages(listener) {
        messageListener = listener;
        return () => {
          messageListener = undefined;
        };
      },
      setReaction: jest.fn(async () => undefined),
      waitUntilReady: jest.fn(async () => undefined),
    },
    createRequestId: () => "request-1",
    platform: {
      acceptJoinLink: jest.fn(async () => ({
        landingChannelId: allMembersChannel.id,
        memberId: ownerMember.id,
        operations: [],
        serverId: server.id,
        serverSlug: server.slug,
      })),
      createChannel: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T04:00:00.000Z",
            id: "operation-channel-default",
            kind: "channel.create",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: channel.id,
      })),
      createHumanImSession: jest.fn(async () => imSession),
      createInvite: jest.fn(async () => ({
        invite,
        token: "one-time-invite-token",
      })),
      createAgent: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T08:00:00.000Z",
            id: "operation-agent-create",
            kind: "im.agent.ensure",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: agent.id,
      })),
      deleteAgent: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-08-04T03:00:00.000Z",
            id: "operation-agent-delete",
            kind: "im.identity.delete",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: agent.id,
      })),
      createComputer: jest.fn(async () => computer),
      createDirectConversation: jest.fn(async () => ({
        kind: "ready" as const,
        resource: directConversationResource,
      })),
      removeComputer: jest.fn(async () => undefined),
      createComputerRegistrationScript: jest.fn(async () => ({
        computerId: computer.id,
        expiresAt: "2026-07-31T08:10:00.000Z",
        revision: 2,
        script: "one-time-registration-material",
      })),
      createTerminalSession: jest.fn(async () => terminalSession),
      createServer: jest.fn(async () => ({
        kind: "ready" as const,
        resource: server,
      })),
      ensureThread: jest.fn(async (_serverId, _channelId, input) => ({
        channelId: channel.id,
        createdAt: "2026-07-31T08:00:00.000Z",
        id: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
        replyCount: 0,
        rootMessageRef: input.rootMessageRef,
        serverId: server.id,
        unreadCount: 0,
      })),
      getServer: jest.fn(async () => server),
      getDirectConversation: jest.fn(async () => directConversationResource),
      getOperation: jest.fn(async (_serverId, operationId) => ({
        ...pendingOperation,
        completedAt: "2026-08-01T03:00:01.000Z",
        id: operationId,
        state: "succeeded" as const,
      })),
      createTask: jest.fn(async () => task),
      listAgents: jest.fn(async () => [agent]),
      getAgentProfileCapabilities: jest.fn(async (_serverId, agentId) => ({
        agentId,
        models: null,
        observedAt: null,
        refreshOperation: null,
        skills: null,
        snapshotState: "absent" as const,
        source: null,
        staleReasons: [],
        subject: null,
      })),
      refreshAgentProfileCapabilities: jest.fn(async () => ({
        createdAt: "2026-08-18T00:00:00.000Z",
        id: "operation-profile-capability-default",
        kind: "agent.profile.capabilities.refresh",
        service: "platform" as const,
        state: "pending" as const,
      })),
      listChannelMembers: jest.fn(async () => [agentMember]),
      listChannels: jest.fn(async () => [channel]),
      listComputers: jest.fn(async () => [computer]),
      listDirectConversations: jest.fn(async () => [directConversationResource]),
      listInbox: jest.fn(async () => [inboxItem]),
      listInvites: jest.fn(async () => [invite]),
      listMembers: jest.fn(async () => [ownerMember, agentMember]),
      listReminders: jest.fn(async () => [reminder]),
      listServers: jest.fn(async () => [server]),
      listTasks: jest.fn(async () => [task]),
      listThreadReplies: jest.fn(async () => ({ items: [] })),
      login: jest.fn(async () => account),
      logout: jest.fn(async () => undefined),
      retryDirectConversation: jest.fn(async () => ({
        operations: [],
        resourceId: directConversationResource.id,
      })),
      acceptInvite: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T08:00:00.000Z",
            id: "operation-invite-accept",
            kind: "im.membership.ensure",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: ownerMember.id,
      })),
      addChannelMember: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T08:00:00.000Z",
            id: "operation-channel-member-add",
            kind: "im.membership.ensure",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: agentMember.id,
      })),
      register: jest.fn(async (_input: RegisterInput) => account),
      removeChannelMember: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T08:00:00.000Z",
            id: "operation-channel-member-remove",
            kind: "im.membership.remove",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: agentMember.id,
      })),
      removeMember: jest.fn(async () => ({
        operations: [
          {
            createdAt: "2026-07-31T08:00:00.000Z",
            id: "operation-member-remove",
            kind: "im.membership.remove",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: agentMember.id,
      })),
      markThreadRead: jest.fn(async () => undefined),
      registerThreadReply: jest.fn(
        async (_serverId, _channelId, threadId, input) => ({
          createdAt: "2026-07-31T08:00:00.000Z",
          id: "019fb45a-9d53-71ef-b925-d075796b48d5",
          messageRef: input.messageRef,
          threadId,
        }),
      ),
      revokeInvite: jest.fn(async () => undefined),
      restore: jest.fn(async () => account),
      agentAction: jest.fn(async () => pendingOperation),
      cancelReminder: jest.fn(async () => undefined),
      createReminder: jest.fn(async () => reminder),
      rotateAgentRuntimeCredential: jest.fn(async () => ({
		...completedCredentialRotation,
      })),
      updateAgent: jest.fn(async () => agent),
      updateChannel: jest.fn(async () => channel),
      updateServer: jest.fn(async () => server),
      updateMember: jest.fn(async () => ownerMember),
      updateReminder: jest.fn(async () => ({
        ...reminder,
        revision: 2,
        status: "paused" as const,
      })),
      updateTask: jest.fn(async () => task),
    },
  };
}

async function initializeServerContext(
  store: ReturnType<typeof createAppStore>,
): Promise<void> {
  await store.getState().initialize();
  await store.getState().selectServer(server.id);
}

async function initializeChannel(
  store: ReturnType<typeof createAppStore>,
  channelId = channel.id,
): Promise<void> {
  await initializeServerContext(store);
  await store.getState().selectChannel(channelId);
}

describe("app store", () => {
  it("lets a trusted host connect messaging without exposing HumanImSession", async () => {
    const deps = dependencies();
    const connectMessaging = jest.fn(async () => undefined);
    deps.platform.createHumanImSession = jest.fn(async () => {
      throw new Error("HumanImSession must stay outside the UI runtime");
    });
    const store = createAppStore({
      ...deps,
      connectMessaging,
    } as AppStoreDependencies);

    await store.getState().initialize();

    expect(connectMessaging).toHaveBeenCalledTimes(1);
    expect(deps.platform.createHumanImSession).not.toHaveBeenCalled();
    expect(deps.messaging.connect).not.toHaveBeenCalled();
    expect(store.getState().imState.status).toBe("ready");
  });

  it("restores the Human session and visible Servers without preselecting a route", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);

    await store.getState().initialize();

    expect(store.getState()).toMatchObject({
      account,
      agents: [],
      authStatus: "signed_in",
      channels: [],
      currentChannelId: null,
      currentServerId: null,
      directConversations: [],
      imState: { status: "ready" },
      messages: [],
      serverContextStatus: "idle",
      serversStatus: "ready",
      servers: [server],
    });
    expect(deps.messaging.connect).toHaveBeenCalledWith(imSession);
    expect(deps.messaging.waitUntilReady).toHaveBeenCalledWith(15_000);
    expect(deps.platform.listChannels).not.toHaveBeenCalled();
    expect(deps.messaging.loadHistory).not.toHaveBeenCalled();
  });

  it("keeps a recoverable startup failure distinct from a signed-out session", async () => {
    const deps = dependencies();
    deps.platform.restore = jest
      .fn()
      .mockRejectedValueOnce(new PlatformError("NETWORK", "网络暂时不可用"))
      .mockResolvedValueOnce(account);
    const store = createAppStore(deps);

    await store.getState().initialize();
    expect(store.getState()).toMatchObject({
      authStatus: "recovery_error",
      error: "网络暂时不可用",
    });

    await store.getState().retryInitialization();
    expect(store.getState()).toMatchObject({
      account,
      authStatus: "signed_in",
      serversStatus: "ready",
    });
  });

  it("keeps the Human signed in when only the Server list fails and retries it", async () => {
    const deps = dependencies();
    deps.platform.listServers = jest
      .fn()
      .mockRejectedValueOnce(new Error("Server 列表暂时不可用"))
      .mockResolvedValueOnce([server]);
    const store = createAppStore(deps);

    await store.getState().initialize();
    expect(store.getState()).toMatchObject({
      account,
      authStatus: "signed_in",
      servers: [],
      serversStatus: "error",
    });

    await store.getState().retryServers();
    expect(store.getState()).toMatchObject({
      servers: [server],
      serversStatus: "ready",
    });
  });

  it("loads one Server context without implicitly choosing a Channel", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();

    await store.getState().selectServer(server.id);

    expect(store.getState()).toMatchObject({
      agents: [agent],
      channels: [channel],
      currentChannelId: null,
      currentServerId: server.id,
      members: [ownerMember, agentMember],
      serverContextStatus: "ready",
      targetServerId: server.id,
    });
    expect(deps.messaging.setScope).toHaveBeenCalledWith({
      allowedConversations: [
        {
          channelId: channel.id,
          conversationId: "GROUPtopic-1",
          imGroupId: "community-1",
          imTopicId: "topic-1",
          targetId: "topic-1",
        },
        {
          conversationId: directConversation.conversationId,
          directConversationId: directConversation.directConversationId,
          imGroupId: directConversation.imGroupId,
          targetId: directConversation.imGroupId,
        },
      ],
      generation: 1,
    });
    expect(deps.messaging.loadHistory).not.toHaveBeenCalled();
  });

  it("waits for the Tencent messaging client before restoring Channel history", async () => {
    const deps = dependencies();
    let releaseReady: (() => void) | undefined;
    deps.messaging.waitUntilReady = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseReady = resolve;
          }),
      );
    const store = createAppStore(deps);
    await initializeServerContext(store);

    const selecting = store.getState().selectChannel(channel.id);
    await eventually(() => expect(releaseReady).toBeDefined());
    expect(deps.messaging.loadHistory).not.toHaveBeenCalled();

    releaseReady?.();
    await selecting;
    expect(deps.messaging.loadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "GROUPtopic-1" }),
    );
  });

  it("keeps Channel members when Tencent history fails", async () => {
    const deps = dependencies();
    deps.platform.listChannelMembers = jest.fn(async () => [ownerMember]);
    deps.messaging.loadHistory = jest.fn(async () => {
      throw new Error("history unavailable");
    });
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().selectChannel(channel.id);

    expect(store.getState()).toMatchObject({
      channelMembers: [ownerMember],
      error: "history unavailable",
      loadingChannel: false,
    });
  });

  it("repairs a drifted Channel membership before retrying history once", async () => {
    const deps = dependencies();
    deps.operationPollSleep = jest.fn(async () => undefined);
    deps.messaging.loadHistory = jest
      .fn()
      .mockRejectedValueOnce(
        new PlatformError(
          "IM_NOT_MEMBER",
          "当前账号不在 Channel Topic 中",
          {platformCode: "tencent_10007"},
        ),
      )
      .mockResolvedValueOnce({
        completed: true,
        messages: [message("history-after-repair", "2026-08-17T11:00:00Z")],
      });
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().selectChannel(channel.id);

    expect(deps.platform.addChannelMember).toHaveBeenCalledTimes(1);
    expect(deps.platform.addChannelMember).toHaveBeenCalledWith(
      server.id,
      channel.id,
      ownerMember.id,
      expect.any(String),
    );
    expect(deps.messaging.loadHistory).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      error: null,
      loadingChannel: false,
      messages: [expect.objectContaining({id: "history-after-repair"})],
      pendingAction: null,
    });
  });

  it("stops after one Channel membership repair attempt", async () => {
    const deps = dependencies();
    const notMember = new PlatformError(
      "IM_NOT_MEMBER",
      "当前账号不在 Channel Topic 中",
      {platformCode: "tencent_10007"},
    );
    deps.operationPollSleep = jest.fn(async () => undefined);
    deps.messaging.loadHistory = jest
      .fn()
      .mockRejectedValueOnce(notMember)
      .mockRejectedValueOnce(notMember)
      .mockResolvedValue({completed: true, messages: []});
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().selectChannel(channel.id);

    expect(deps.platform.addChannelMember).toHaveBeenCalledTimes(1);
    expect(deps.messaging.loadHistory).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      error: "消息服务暂时不可用，请稍后重试",
      loadingChannel: false,
    });
  });

  it("does not reopen a repaired Channel after navigation", async () => {
    const otherChannel: Channel = {
      ...channel,
      id: "channel-2",
      imTopicId: "topic-2",
      joined: false,
      name: "random",
    };
    const deps = dependencies();
    let finishOperation: ((operation: Operation) => void) | undefined;
    deps.platform.listChannels = jest.fn(async () => [channel, otherChannel]);
    deps.operationPollSleep = jest.fn(async () => undefined);
    deps.platform.getOperation = jest.fn(
      () =>
        new Promise<Operation>((resolve) => {
          finishOperation = resolve;
        }),
    );
    deps.messaging.loadHistory = jest
      .fn()
      .mockRejectedValueOnce(
        new PlatformError("IM_NOT_MEMBER", "当前账号不在 Channel Topic 中"),
      )
      .mockResolvedValue({completed: true, messages: []});
    const store = createAppStore(deps);
    await initializeServerContext(store);

    const repairing = store.getState().selectChannel(channel.id);
    await eventually(() => expect(finishOperation).toBeDefined());
    await store.getState().selectChannel(otherChannel.id);
    finishOperation?.({
      createdAt: "2026-08-17T11:30:00Z",
      id: "operation-channel-member-add",
      kind: "im.membership.ensure",
      service: "im",
      state: "succeeded",
    });
    await repairing;

    expect(store.getState()).toMatchObject({
      activeConversation: {channelId: otherChannel.id, kind: "channel"},
      currentChannelId: otherChannel.id,
    });
    expect(deps.messaging.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not run ordinary Channel compensation for the all-members root", async () => {
    const deps = dependencies();
    deps.platform.listChannels = jest.fn(async () => [allMembersChannel]);
    deps.messaging.loadHistory = jest.fn(async () => {
      throw new PlatformError("IM_NOT_MEMBER", "当前账号不在 Channel Topic 中");
    });
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().selectChannel(allMembersChannel.id);

    expect(deps.platform.addChannelMember).not.toHaveBeenCalled();
    expect(store.getState().error).toBe("消息服务暂时不可用，请稍后重试");
  });

  it("keeps same-target Server loading single-flight", async () => {
    const deps = dependencies();
    let releaseChannels: ((value: Channel[]) => void) | undefined;
    deps.platform.listChannels = jest.fn(
      () =>
        new Promise<Channel[]>((resolve) => {
          releaseChannels = resolve;
        }),
    );
    const store = createAppStore(deps);
    await store.getState().initialize();

    const first = store.getState().selectServer(server.id);
    const second = store.getState().selectServer(server.id);
    await eventually(() => expect(releaseChannels).toBeDefined());

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      serverContextStatus: "loading",
      targetServerId: server.id,
    });
    releaseChannels?.([channel]);
    await Promise.all([first, second]);
    expect(store.getState().serverContextStatus).toBe("ready");
  });

  it("recovers a joined provisioning Channel without a page refresh", async () => {
    const provisioningChannel: Channel = {
      ...allMembersChannel,
      imState: "provisioning",
    };
    const deps = dependencies();
    const sleep = jest.fn(async () => undefined);
    deps.sleep = sleep;
    deps.platform.listChannels = jest
      .fn()
      .mockResolvedValueOnce([provisioningChannel])
      .mockResolvedValueOnce([allMembersChannel]);
    const store = createAppStore(deps);

    await store.getState().initialize();
    await store.getState().selectServer(server.id);

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(store.getState()).toMatchObject({
      channels: [allMembersChannel],
      currentServerId: server.id,
      serverContextStatus: "ready",
    });
  });

  it("keeps recovering after one transient Channel refresh failure", async () => {
    const provisioningChannel: Channel = {
      ...allMembersChannel,
      imState: "provisioning",
    };
    const deps = dependencies();
    deps.sleep = jest.fn(async () => undefined);
    deps.platform.listChannels = jest
      .fn()
      .mockResolvedValueOnce([provisioningChannel])
      .mockRejectedValueOnce(new Error("temporary Channel read failure"))
      .mockResolvedValueOnce([allMembersChannel]);
    const store = createAppStore(deps);

    await store.getState().initialize();
    await store.getState().selectServer(server.id);

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(3);
    expect(store.getState()).toMatchObject({
      channels: [allMembersChannel],
      currentServerId: server.id,
      error: null,
      serverContextStatus: "ready",
    });
  });

  it("lets the same Server start a fresh Channel recovery after the bounded wait", async () => {
    const provisioningChannel: Channel = {
      ...allMembersChannel,
      imState: "provisioning",
    };
    const deps = dependencies();
    deps.sleep = jest.fn(async () => undefined);
    deps.platform.listChannels = jest
      .fn()
      .mockResolvedValueOnce([provisioningChannel]);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      (deps.platform.listChannels as jest.Mock).mockResolvedValueOnce([
        provisioningChannel,
      ]);
    }
    (deps.platform.listChannels as jest.Mock).mockResolvedValueOnce([
      allMembersChannel,
    ]);
    const store = createAppStore(deps);

    await store.getState().initialize();
    await store.getState().selectServer(server.id);

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(16);
    expect(store.getState()).toMatchObject({
      channels: [provisioningChannel],
      currentServerId: server.id,
      serverContextStatus: "ready",
    });

    await store.getState().selectServer(server.id);

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(17);
    expect(store.getState()).toMatchObject({
      channels: [allMembersChannel],
      currentServerId: server.id,
      serverContextStatus: "ready",
    });
  });

  it("does not poll when the Channel snapshot has no joined provisioning resource", async () => {
    const deps = dependencies();
    deps.sleep = jest.fn(async () => undefined);
    deps.platform.listChannels = jest.fn(async () => []);
    const store = createAppStore(deps);

    await store.getState().initialize();
    await store.getState().selectServer(server.id);

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({
      channels: [],
      currentServerId: server.id,
      serverContextStatus: "ready",
    });
  });

  it("stops an old Channel recovery when another Server is selected", async () => {
    const mono: Server = {
      ...server,
      id: "server-2",
      name: "Mono",
      slug: "mono",
    };
    const monoChannel: Channel = {
      ...allMembersChannel,
      id: "channel-mono-all",
      serverId: mono.id,
    };
    const provisioningChannel: Channel = {
      ...allMembersChannel,
      imState: "provisioning",
    };
    const deps = dependencies();
    deps.platform.listServers = jest.fn(async () => [server, mono]);
    deps.platform.listChannels = jest.fn(async (serverId: string) =>
      serverId === mono.id ? [monoChannel] : [provisioningChannel],
    );
    let releaseSleep: (() => void) | undefined;
    deps.sleep = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    );
    const store = createAppStore(deps);
    await store.getState().initialize();

    const atlasSelection = store.getState().selectServer(server.id);
    await eventually(() => expect(releaseSleep).toBeDefined());
    await store.getState().selectServer(mono.id);
    releaseSleep?.();
    await atlasSelection;

    expect(deps.platform.listChannels).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({
      channels: [monoChannel],
      currentServerId: mono.id,
      serverContextStatus: "ready",
      targetServerId: mono.id,
    });
  });

  it("drops stale Server context completion after the route target changes", async () => {
    const mono: Server = {
      ...server,
      id: "server-2",
      name: "Mono",
      slug: "mono",
    };
    const monoChannel: Channel = {
      ...channel,
      id: "channel-2",
      serverId: mono.id,
    };
    const deps = dependencies();
    deps.platform.listServers = jest.fn(async () => [server, mono]);
    let releaseAtlas: ((value: Channel[]) => void) | undefined;
    deps.platform.listChannels = jest.fn((serverId) => {
      if (serverId === mono.id) return Promise.resolve([monoChannel]);
      return new Promise<Channel[]>((resolve) => {
        releaseAtlas = resolve;
      });
    });
    deps.platform.listAgents = jest.fn(async () => []);
    const store = createAppStore(deps);
    await store.getState().initialize();

    const atlasSelection = store.getState().selectServer(server.id);
    await eventually(() => expect(releaseAtlas).toBeDefined());
    await store.getState().selectServer(mono.id);
    releaseAtlas?.([channel]);
    await atlasSelection;

    expect(store.getState()).toMatchObject({
      channels: [monoChannel],
      currentServerId: mono.id,
      serverContextStatus: "ready",
      targetServerId: mono.id,
    });
  });

  it("opens a Server 内双人群私信, keeps unrelated messages out, and sends as the Human", async () => {
    const deps = dependencies();
    const directHistory = {
      ...message("direct-history-1", "2026-07-31T09:00:00.000Z"),
      conversationId: directConversation.conversationId,
    };
    deps.messaging.loadHistory = jest.fn(async (address) => ({
      completed: true,
      messages:
        address.conversationId === directConversation.conversationId
          ? [directHistory]
          : [
              message("history-2", "2026-07-30T02:00:00.000Z"),
              message("history-1", "2026-07-30T01:00:00.000Z"),
            ],
    }));
    deps.messaging.sendText = jest.fn(async (input) => ({
      ...directHistory,
      clientRequestId: input.clientRequestId,
      direction: "outgoing" as const,
      id: "direct-sent-1",
      text: input.text,
    }));
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store
      .getState()
      .selectDirectConversation(directConversation.peerUserId);
    deps.emitMessages([
      {
        ...directHistory,
        id: "direct-live-1",
        text: "实时私信",
      },
      message("channel-live-1", "2026-07-31T10:00:00.000Z"),
    ]);
    await store.getState().sendMessage({
      mentionedUserIds: [agent.imUserId],
      text: "收到",
    });

    expect(store.getState().activeConversation).toEqual({
      directConversationId: "direct-1",
      kind: "direct",
      peerMemberId: agentMember.id,
      peerUserId: "agent-im-1",
    });
    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "direct-history-1",
      "direct-live-1",
      "direct-sent-1",
    ]);
    expect(deps.messaging.markRead).toHaveBeenCalledWith({
      conversationId: "GROUPan_dm_direct_1",
      directConversationId: "direct-1",
      imGroupId: "an_dm_direct_1",
      targetId: "an_dm_direct_1",
    });
    expect(deps.messaging.sendText).toHaveBeenCalledWith({
      channel: {
        conversationId: "GROUPan_dm_direct_1",
        directConversationId: "direct-1",
        imGroupId: "an_dm_direct_1",
        targetId: "an_dm_direct_1",
      },
      clientRequestId: "request-1",
      mentions: [],
      text: "收到",
    });
    expect(mentionableAgents(store.getState())).toEqual([]);
  });

  it("creates the Server 内私信 group only when the first message is sent", async () => {
    const deps = dependencies();
    deps.platform.listDirectConversations = jest.fn(async () => []);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().selectDirectConversation(agent.imUserId);

    expect(store.getState().activeConversation).toEqual({
      kind: "direct",
      peerMemberId: agentMember.id,
      peerUserId: agent.imUserId,
    });
    expect(deps.platform.createDirectConversation).not.toHaveBeenCalled();

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "第一条私信",
    });

    expect(deps.platform.createDirectConversation).toHaveBeenCalledWith(
      server.id,
      agentMember.id,
      "request-1",
    );
    expect(deps.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: {
          conversationId: directConversation.conversationId,
          directConversationId: directConversation.directConversationId,
          imGroupId: directConversation.imGroupId,
          targetId: directConversation.imGroupId,
        },
        clientRequestId: "request-1",
        text: "第一条私信",
      }),
    );
    expect(store.getState().activeConversation).toMatchObject({
      directConversationId: directConversation.directConversationId,
      kind: "direct",
      peerMemberId: agentMember.id,
    });
  });

  it("reuses the persisted first-DM intent after a page reload", async () => {
    const persisted = new Map<string, unknown>();
    const intentStore = {
      async load(key: string) {
        return persisted.get(key) ?? null;
      },
      async remove(key: string) {
        persisted.delete(key);
      },
      async save(key: string, value: unknown) {
        persisted.set(key, value);
      },
    };
    const first = Object.assign(dependencies(), {
      directSendIntents: intentStore,
    });
    first.createRequestId = () => "request-before-reload";
    first.platform.listDirectConversations = jest.fn(async () => []);
    first.platform.createDirectConversation = jest.fn(async () => {
      throw new Error("network interrupted");
    });
    const firstStore = createAppStore(first);
    await initializeServerContext(firstStore);
    await firstStore.getState().selectDirectConversation(agent.imUserId);
    await firstStore.getState().sendMessage({
      mentionedUserIds: [],
      text: "刷新后继续发送",
    });

    expect(persisted.size).toBe(1);

    const restored = Object.assign(dependencies(), {
      directSendIntents: intentStore,
    });
    restored.createRequestId = () => "request-after-reload";
    restored.platform.listDirectConversations = jest.fn(async () => []);
    const restoredStore = createAppStore(restored);
    await initializeServerContext(restoredStore);
    await restoredStore
      .getState()
      .selectDirectConversation(agent.imUserId);
    await restoredStore.getState().sendMessage({
      mentionedUserIds: [],
      text: "刷新后继续发送",
    });

    expect(restored.platform.createDirectConversation).toHaveBeenCalledWith(
      server.id,
      agentMember.id,
      "request-before-reload",
    );
    expect(restored.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "request-before-reload",
        text: "刷新后继续发送",
      }),
    );
    expect(persisted.size).toBe(0);
  });

  it("replaces a persisted preparing first-DM intent with the latest draft before Tencent send", async () => {
    const key = `${account.id}:${server.id}:${agentMember.id}`;
    const persisted = new Map<string, unknown>([
      [
        key,
        {
          accountId: account.id,
          clientRequestId: "request-before-failure",
          createdAt: "2026-07-31T09:59:00.000Z",
          idempotencyKey: "request-before-failure",
          kind: "text",
          mentionedUserIds: [],
          peerMemberId: agentMember.id,
          phase: "preparing",
          schemaVersion: 1,
          serverId: server.id,
          text: "旧草稿",
          updatedAt: "2026-07-31T09:59:00.000Z",
        },
      ],
    ]);
    const deps = Object.assign(dependencies(), {
      directSendIntents: {
        async load(intentKey: string) {
          return persisted.get(intentKey) ?? null;
        },
        async remove(intentKey: string) {
          persisted.delete(intentKey);
        },
        async save(intentKey: string, value: unknown) {
          persisted.set(intentKey, value);
        },
      },
    });
    deps.createRequestId = () => "request-after-failure";
    deps.platform.listDirectConversations = jest.fn(async () => []);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().selectDirectConversation(agent.imUserId);

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "修改后的草稿",
    });

    expect(deps.platform.createDirectConversation).toHaveBeenCalledWith(
      server.id,
      agentMember.id,
      "request-before-failure",
    );
    expect(deps.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "request-before-failure",
        text: "修改后的草稿",
      }),
    );
    expect(store.getState().error).toBeNull();
    expect(persisted.size).toBe(0);
  });

  it("confirms an uncertain first-DM send from Tencent history without resending", async () => {
    const key = `${account.id}:${server.id}:${agentMember.id}`;
    const persisted = new Map<string, unknown>([
      [
        key,
        {
          accountId: account.id,
          clientRequestId: "request-before-timeout",
          createdAt: "2026-07-31T09:59:00.000Z",
          directConversationId: directConversation.directConversationId,
          idempotencyKey: "request-before-timeout",
          kind: "text",
          mentionedUserIds: [],
          peerMemberId: agentMember.id,
          phase: "uncertain",
          schemaVersion: 1,
          serverId: server.id,
          text: "其实已经发送成功",
          updatedAt: "2026-07-31T10:00:00.000Z",
        },
      ],
    ]);
    const deps = Object.assign(dependencies(), {
      directSendIntents: {
        async load(intentKey: string) {
          return persisted.get(intentKey) ?? null;
        },
        async remove(intentKey: string) {
          persisted.delete(intentKey);
        },
        async save(intentKey: string, value: unknown) {
          persisted.set(intentKey, value);
        },
      },
    });
    const confirmed = {
      ...message("direct-confirmed", "2026-07-31T10:00:00.000Z"),
      clientRequestId: "request-before-timeout",
      conversationId: directConversation.conversationId,
      direction: "outgoing" as const,
      text: "其实已经发送成功",
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [confirmed],
    }));
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store
      .getState()
      .selectDirectConversation(directConversation.peerUserId);

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "其实已经发送成功",
    });

    expect(deps.messaging.sendText).not.toHaveBeenCalled();
    expect(persisted.size).toBe(0);
    expect(store.getState().error).toBeNull();
    expect(store.getState().messages).toContainEqual(confirmed);
  });

  it("sends the next DM after Tencent history confirms the previous uncertain send", async () => {
    const key = `${account.id}:${server.id}:${agentMember.id}`;
    const persisted = new Map<string, unknown>([
      [
        key,
        {
          accountId: account.id,
          clientRequestId: "request-before-timeout",
          createdAt: "2026-07-31T09:59:00.000Z",
          directConversationId: directConversation.directConversationId,
          idempotencyKey: "request-before-timeout",
          kind: "text",
          mentionedUserIds: [],
          peerMemberId: agentMember.id,
          phase: "uncertain",
          schemaVersion: 1,
          serverId: server.id,
          text: "已经发送成功",
          updatedAt: "2026-07-31T10:00:00.000Z",
        },
      ],
    ]);
    const deps = Object.assign(dependencies(), {
      directSendIntents: {
        async load(intentKey: string) {
          return persisted.get(intentKey) ?? null;
        },
        async remove(intentKey: string) {
          persisted.delete(intentKey);
        },
        async save(intentKey: string, value: unknown) {
          persisted.set(intentKey, value);
        },
      },
    });
    deps.createRequestId = () => "request-next-message";
    const confirmed = {
      ...message("direct-confirmed-next", "2026-07-31T10:00:00.000Z"),
      clientRequestId: "request-before-timeout",
      conversationId: directConversation.conversationId,
      direction: "outgoing" as const,
      text: "已经发送成功",
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [confirmed],
    }));
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store
      .getState()
      .selectDirectConversation(directConversation.peerUserId);

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "下一条消息",
    });

    expect(deps.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "request-next-message",
        text: "下一条消息",
      }),
    );
    expect(store.getState().error).toBeNull();
    expect(persisted.size).toBe(0);
  });

  it("queries Topic summaries only for Channel Community groups", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();
    await store.getState().selectServer(server.id);

    expect(store.getState().conversationSummaries).toEqual([
      groupConversation,
    ]);
    expect(deps.messaging.listConversations).toHaveBeenCalledWith([
      "community-1",
    ]);

    const liveMessage = {
      ...message("group-live-1", "2026-08-01T10:01:00.000Z"),
      content: {kind: "text" as const, text: "新的群消息"},
      text: "新的群消息",
    };
    deps.emitMessages([liveMessage]);
    deps.emitMessages([liveMessage]);

    expect(store.getState().conversationSummaries).toEqual([
      expect.objectContaining({
        conversationId: "GROUPtopic-1",
        lastMessageAt: "2026-08-01T10:01:00.000Z",
        lastMessagePreview: "新的群消息",
        unreadCount: 4,
      }),
    ]);

    await store.getState().selectChannel(channel.id);
    expect(store.getState().conversationSummaries[0]?.unreadCount).toBe(0);

    deps.emitConversations([
      {
        ...groupConversation,
        lastMessagePreview: "新的群消息",
        unreadCount: 5,
      },
    ]);

    expect(store.getState().conversationSummaries).toEqual([
      expect.objectContaining({
        conversationId: "GROUPtopic-1",
        lastMessagePreview: "新的群消息",
        unreadCount: 5,
      }),
    ]);

    await store.getState().logout();
    expect(store.getState().conversationSummaries).toEqual([]);
  });

  it("retries group summaries until Tencent conversation paging completes", async () => {
    const deps = dependencies();
    deps.sleep = jest.fn(async () => undefined);
    deps.messaging.listConversations = jest
      .fn()
      .mockResolvedValueOnce({isSyncCompleted: false, items: []})
      .mockResolvedValue({
        isSyncCompleted: true,
        items: [groupConversation],
      });
    const store = createAppStore(deps);

    await store.getState().initialize();
    await store.getState().selectServer(server.id);
    await eventually(() => {
      expect(store.getState().conversationSummaries).toEqual([
        groupConversation,
      ]);
    });

    expect(deps.messaging.listConversations).toHaveBeenCalledTimes(2);
  });

  it("clears Server 内私信 on logout", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();

    await store.getState().logout();

    expect(store.getState()).toMatchObject({
      activeConversation: null,
      authStatus: "signed_out",
      directConversations: [],
    });
  });

  it("refreshes Server 内私信 from the platform authority", async () => {
    const deps = dependencies();
    const listDirectConversations = jest.fn(async () => [
      directConversationResource,
    ]);
    deps.platform.listDirectConversations = listDirectConversations;
    const store = createAppStore(deps);
    await store.getState().initialize();
    await store.getState().selectServer(server.id);
    listDirectConversations.mockClear();

    await store.getState().refreshDirectConversations();

    expect(listDirectConversations).toHaveBeenCalledTimes(1);
  });

  it("creates the first Server and Channel before entering chat", async () => {
    const deps = dependencies();
    deps.platform.listServers = jest.fn(async () => []);
    deps.platform.createServer = jest.fn(async () => ({
      kind: "ready" as const,
      resource: server,
    }));
    deps.platform.createChannel = jest.fn(async () => ({
      operations: [
        {
          createdAt: "2026-07-31T04:00:00.000Z",
          id: "operation-channel-1",
          kind: "channel.create",
          service: "im" as const,
          state: "pending" as const,
        },
      ],
      resourceId: channel.id,
    }));
    deps.platform.getServer = jest.fn(async () => server);
    const store = createAppStore(deps);
    await store.getState().initialize();

    await store.getState().createWorkspace({
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public",
    });

    expect(deps.platform.createServer).toHaveBeenCalledWith(
      { name: "Agent Network", slug: "agent-network" },
      "request-1:server",
    );
    expect(deps.platform.createChannel).toHaveBeenCalledWith(
      server.id,
      { name: "general", visibility: "public" },
      "request-1:channel",
    );
    expect(store.getState()).toMatchObject({
      channels: [channel],
      currentChannelId: channel.id,
      currentServerId: server.id,
      provisioningStage: null,
      provisioningWorkspace: false,
      servers: [server],
    });
  });

  it("retries only Channel creation after the Server already succeeded", async () => {
    const deps = dependencies();
    deps.platform.listServers = jest.fn(async () => []);
    deps.platform.createServer = jest.fn(async () => ({
      kind: "ready" as const,
      resource: server,
    }));
    deps.platform.createChannel = jest
      .fn()
      .mockRejectedValueOnce(new Error("腾讯云 Topic 创建失败"))
      .mockResolvedValueOnce({
        operations: [
          {
            createdAt: "2026-07-31T04:00:00.000Z",
            id: "operation-channel-2",
            kind: "channel.create",
            service: "im" as const,
            state: "pending" as const,
          },
        ],
        resourceId: channel.id,
      });
    deps.platform.getServer = jest.fn(async () => server);
    const store = createAppStore(deps);
    await store.getState().initialize();

    const input = {
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public" as const,
    };
    await store.getState().createWorkspace(input);

    expect(store.getState()).toMatchObject({
      currentServerId: server.id,
      error: "消息服务暂时不可用，请稍后重试",
      provisioningWorkspace: false,
      servers: [server],
    });

    await store.getState().createWorkspace(input);

    expect(deps.platform.createServer).toHaveBeenCalledTimes(1);
    expect(deps.platform.createChannel).toHaveBeenCalledTimes(2);
    expect(store.getState().currentChannelId).toBe(channel.id);
  });

  it("reconnects Human IM after first-time provisioning completes", async () => {
    const deps = dependencies();
    deps.platform.listServers = jest.fn(async () => []);
    deps.platform.createHumanImSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("IM 身份尚未就绪"))
      .mockResolvedValueOnce(imSession);
    const store = createAppStore(deps);
    await store.getState().initialize();

    expect(store.getState().imState.status).toBe("issuing_session");

    await store.getState().createWorkspace({
      channelName: "general",
      serverName: "Agent Network",
      serverSlug: "agent-network",
      visibility: "public",
    });

    expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(2);
    expect(store.getState().imState.status).toBe("ready");
  });

  it("keeps manual IM reconnect single-flight", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();
    const createHumanImSession = jest.fn(async () => imSession);
    let releaseConnect: (() => void) | undefined;
    const connect = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve;
        }),
    );
    deps.platform.createHumanImSession = createHumanImSession;
    deps.messaging.connect = connect;

    const first = store.getState().reconnectIm();
    const second = store.getState().reconnectIm();
    await eventually(() => {
      expect(connect).toHaveBeenCalledTimes(1);
    });
    expect(createHumanImSession).toHaveBeenCalledTimes(1);
    releaseConnect?.();
    await Promise.all([first, second]);

    expect(store.getState().imState.status).toBe("ready");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("opens an explicitly routed writable Topic instead of the Community root channel", async () => {
    const deps = dependencies();
    deps.platform.listChannels = jest.fn(async () => [
      allMembersChannel,
      channel,
    ]);
    const store = createAppStore(deps);

    await initializeServerContext(store);
    await store.getState().selectChannel(channel.id);

    expect(store.getState().currentChannelId).toBe(channel.id);
    expect(deps.messaging.loadHistory).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: channel.id }),
    );
  });

  it("selects a discoverable public Channel without opening IM before join", async () => {
    const discoverableChannel: Channel = {...channel, joined: false};
    const deps = dependencies();
    deps.platform.listChannels = jest.fn(async () => [discoverableChannel]);
    const store = createAppStore(deps);

    await initializeServerContext(store);
    await store.getState().selectChannel(discoverableChannel.id);

    expect(store.getState()).toMatchObject({
      activeConversation: {
        channelId: discoverableChannel.id,
        kind: "channel",
      },
      channelMembers: [agentMember],
      currentChannelId: discoverableChannel.id,
      error: null,
      loadingChannel: false,
      messages: [],
    });
    expect(deps.messaging.loadHistory).not.toHaveBeenCalled();
  });

  it("opens IM only after a public Channel join reaches Tencent", async () => {
    const discoverableChannel: Channel = {...channel, joined: false};
    const deps = dependencies();
    deps.platform.listChannels = jest
      .fn()
      .mockResolvedValueOnce([discoverableChannel])
      .mockResolvedValue([channel]);
    deps.platform.getOperation = jest.fn(async (_serverId, operationId) => ({
      createdAt: "2026-08-01T03:00:00.000Z",
      id: operationId,
      kind: "im.membership.ensure",
      service: "im" as const,
      state: "succeeded" as const,
    }));
    const store = createAppStore(deps);

    await initializeServerContext(store);
    await store.getState().selectChannel(discoverableChannel.id);
    await store.getState().addChannelMember(ownerMember.id);

    expect(store.getState().channels[0]?.joined).toBe(false);
    expect(deps.messaging.loadHistory).not.toHaveBeenCalled();

    await store
      .getState()
      .continueOperationPolling("operation-channel-member-add");

    expect(store.getState().channels[0]?.joined).toBe(true);
    expect(deps.messaging.loadHistory).toHaveBeenCalledWith(
      expect.objectContaining({conversationId: "GROUPtopic-1"}),
    );
  });

  it("sends consecutive all-members messages through its system Topic", async () => {
    const deps = dependencies();
    deps.platform.listChannels = jest.fn(async () => [
      allMembersChannel,
      channel,
    ]);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().selectChannel(allMembersChannel.id);

    await store.getState().sendMessage({
      mentionedUserIds: [agent.imUserId],
      text: "@研究助手 你好",
    });
    await store.getState().sendMessage({mentionedUserIds: [], text: "第二条消息"});

    expect(deps.messaging.sendText).toHaveBeenNthCalledWith(1, {
      channel: {
        channelId: allMembersChannel.id,
        conversationId: "GROUPtopic-all",
        imGroupId: "community-1",
        imTopicId: "topic-all",
        targetId: "topic-all",
      },
      clientRequestId: "request-1",
      mentions: [
        {
          displayName: agent.displayName,
          imUserId: agent.imUserId,
          memberId: agentMember.id,
          memberKind: "agent",
        },
      ],
      text: "@研究助手 你好",
    });
    expect(deps.messaging.sendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: expect.objectContaining({targetId: "topic-all"}),
        text: "第二条消息",
      }),
    );
    expect(store.getState().error).toBeNull();
    expect(mentionableAgents(store.getState())).toEqual([agent]);
  });

  it("publishes signed_in while the independently tracked Server list loads", async () => {
    const deps = dependencies();
    let releaseServers: ((servers: Server[]) => void) | undefined;
    deps.platform.listServers = jest.fn(
      () =>
        new Promise<Server[]>((resolve) => {
          releaseServers = resolve;
        }),
    );
    const store = createAppStore(deps);

    const initialization = store.getState().initialize();
    await eventually(() => {
      expect(releaseServers).toBeDefined();
    });

    expect(store.getState()).toMatchObject({
      authStatus: "signed_in",
      serversStatus: "loading",
    });
    releaseServers?.([server]);
    await initialization;
    expect(store.getState()).toMatchObject({
      authStatus: "signed_in",
      currentChannelId: null,
      serversStatus: "ready",
    });
  });

  it("requests one fresh UserSig when the first IM login reports expiration", async () => {
    const deps = dependencies();
    const freshSession = {
      ...imSession,
      userSig: "redacted-fresh-usersig",
    };
    deps.platform.createHumanImSession = jest
      .fn()
      .mockResolvedValueOnce(imSession)
      .mockResolvedValueOnce(freshSession);
    deps.messaging.connect = jest
      .fn()
      .mockRejectedValueOnce(
        new PlatformError("IM_KICKED_OUT", "UserSig 已过期", {
          details: { cause: "user_sig_expired" },
        }),
      )
      .mockResolvedValueOnce(undefined);
    const store = createAppStore(deps);

    await store.getState().initialize();

    expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(2);
    expect(deps.messaging.connect).toHaveBeenNthCalledWith(1, imSession);
    expect(deps.messaging.connect).toHaveBeenNthCalledWith(2, freshSession);
    expect(store.getState().imState.status).toBe("ready");
  });

  it("recovers one runtime UserSig expiration but never auto-recovers an ordinary kick", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();
    expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(1);

    deps.emitLifecycle({
      cause: "user_sig_expired",
      type: "kicked_out",
    });
    await eventually(() => {
      expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(2);
    });

    deps.emitLifecycle({
      cause: "user_sig_expired",
      type: "kicked_out",
    });
    deps.emitLifecycle({
      reason: "另一个设备登录",
      type: "kicked_out",
    });
    await Promise.resolve();

    expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(2);
    expect(store.getState().imState).toMatchObject({
      status: "kicked_out",
    });
  });

  it("keeps the current conversation visible after another browser takes over and reconnects in place", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);
    const activeConversation = store.getState().activeConversation;
    const visibleMessages = store.getState().messages;

    deps.emitLifecycle({
      reason: "账号已在另一个浏览器中登录",
      type: "kicked_out",
    });

    expect(store.getState()).toMatchObject({
      activeConversation,
      imState: {
        message: "账号已在另一个浏览器中登录",
        status: "kicked_out",
      },
      messages: visibleMessages,
    });

    await store.getState().reconnectIm();

    expect(store.getState().imState.status).toBe("ready");
    expect(deps.platform.listDirectConversations).toHaveBeenCalledTimes(2);
  });

  it("keeps provider lifecycle diagnostics out of the human-facing state", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();

    deps.emitLifecycle({
      reason: "TAT provider connection failed",
      type: "not_ready",
    });
    expect(store.getState().imState).toEqual({
      message: "操作失败，请稍后重试",
      status: "not_ready",
    });

    deps.emitLifecycle({
      message: "腾讯云 IM Topic unavailable",
      type: "error",
    });
    expect(store.getState().imState).toEqual({
      message: "消息服务暂时不可用，请稍后重试",
      status: "error",
    });
  });

  it("merges visible live messages once and sends through Tencent IM", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);
    deps.emitLifecycle({ type: "ready" });

    deps.emitMessages([
      message("live-1", "2026-07-30T03:00:00.000Z"),
      message("live-1", "2026-07-30T03:00:00.000Z"),
      {
        ...message("other", "2026-07-30T03:30:00.000Z"),
        conversationId: "GROUPtopic-2",
      },
    ]);
    await store.getState().sendMessage({
      mentionedUserIds: [agent.imUserId],
      text: "@研究助手 请总结。",
    });

    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "history-1",
      "history-2",
      "live-1",
      "sent-1",
    ]);
    expect(deps.messaging.sendText).toHaveBeenCalledWith({
      channel: {
        channelId: channel.id,
        conversationId: "GROUPtopic-1",
        imGroupId: channel.imGroupId,
        imTopicId: channel.imTopicId,
        targetId: "topic-1",
      },
      clientRequestId: "request-1",
      mentions: [
        {
          displayName: agent.displayName,
          imUserId: agent.imUserId,
          memberId: agentMember.id,
          memberKind: "agent",
        },
      ],
      text: "@研究助手 请总结。",
    });
  });

  it("does not send before the Tencent SDK is ready", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await store.getState().initialize();
    deps.emitLifecycle({
      reason: "连接已断开",
      type: "not_ready",
    });

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "你好",
    });

    expect(deps.messaging.sendText).not.toHaveBeenCalled();
    expect(store.getState().error).toBe("聊天连接尚未就绪");
  });

  it("keeps a failed text message in place and replaces it after retry", async () => {
    const deps = dependencies();
    deps.messaging.sendText = jest.fn(async () => {
      throw new Error("网络暂时不可用");
    });
    deps.messaging.retryMessage = jest.fn(async () => ({
      ...message("remote-retry-1", "2026-07-30T04:00:00.000Z"),
      clientRequestId: "request-1",
      direction: "outgoing" as const,
      senderId: account.imUserId ?? account.id,
      senderName: account.displayName,
      text: "稍后重试",
    }));
    const store = createAppStore(deps);
    await initializeChannel(store);
    deps.emitLifecycle({ type: "ready" });

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "稍后重试",
    });

    expect(
      store.getState().messages.find((item) => item.id === "local:request-1"),
    ).toMatchObject({
      clientRequestId: "request-1",
      delivery: {
        error: "网络暂时不可用",
        retryable: true,
        state: "failed",
      },
      text: "稍后重试",
    });

    await store.getState().retryMessage("local:request-1");

    expect(deps.messaging.retryMessage).toHaveBeenCalledWith("request-1");
    expect(
      store
        .getState()
        .messages.filter((item) => item.clientRequestId === "request-1"),
    ).toEqual([
      expect.objectContaining({
        delivery: { state: "sent" },
        id: "remote-retry-1",
      }),
    ]);
  });

  it("revokes an outgoing Human message and replaces the shared projection", async () => {
    const deps = dependencies();
    const outgoing = {
      ...message("human-message-1", "2026-07-30T04:00:00.000Z"),
      direction: "outgoing" as const,
      senderId: account.imUserId ?? account.id,
      senderName: account.displayName,
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [outgoing],
    }));
    const revokeMessage = jest.fn(async () => ({
      ...outgoing,
      content: {kind: "system" as const, text: "[消息已撤回]"},
      kind: "system" as const,
      rawType: "TIMRevokedElem",
      text: "[消息已撤回]",
    }));
    (deps.messaging as typeof deps.messaging & {
      revokeMessage(messageId: string): Promise<Message>;
    }).revokeMessage = revokeMessage;
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().revokeMessage(outgoing.id);

    expect(revokeMessage).toHaveBeenCalledWith(outgoing.id);
    expect(store.getState().messages).toEqual([
      expect.objectContaining({
        id: outgoing.id,
        kind: "system",
        text: "[消息已撤回]",
      }),
    ]);
  });

  it("quotes an existing message in the next send and clears the Composer quote", async () => {
    const deps = dependencies();
    deps.messaging.sendText = jest.fn(async (input) => ({
      ...message("sent-quote-1", "2026-07-30T04:00:00.000Z"),
      clientRequestId: input.clientRequestId,
      direction: "outgoing" as const,
      quote: input.quote,
      text: "按这个方案继续",
    }));
    const store = createAppStore(deps);
    await initializeChannel(store);
    deps.emitLifecycle({ type: "ready" });

    store.getState().quoteMessage("history-1");
    expect(store.getState().selectedQuote).toEqual({
      messageId: "history-1",
      preview: "history-1",
      senderId: agent.imUserId,
      senderName: agent.displayName,
    });
    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "按这个方案继续",
    });

    expect(deps.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        quote: {
          messageId: "history-1",
          preview: "history-1",
          senderId: agent.imUserId,
          senderName: agent.displayName,
        },
      }),
    );
    expect(store.getState().selectedQuote).toBeNull();
    expect(store.getState().messages.at(-1)?.quote).toMatchObject({
      messageId: "history-1",
    });
  });

  it("marks the selected Channel read after history and after a visible live message", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);

    expect(deps.messaging.markRead).toHaveBeenCalledTimes(1);
    deps.emitMessages([message("live-read-1", "2026-07-30T03:00:00.000Z")]);
    await eventually(() => {
      expect(deps.messaging.markRead).toHaveBeenCalledTimes(2);
    });
  });

  it("optimistically toggles a Tencent Reaction on the selected message", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().toggleReaction("history-1", "👍");
    expect(deps.messaging.setReaction).toHaveBeenLastCalledWith(
      "history-1",
      "👍",
      true,
    );
    expect(
      store.getState().messages.find((item) => item.id === "history-1")
        ?.reactions,
    ).toEqual([
      {
        count: 1,
        reactedByMe: true,
        reactionId: "👍",
      },
    ]);

    await store.getState().toggleReaction("history-1", "👍");
    expect(deps.messaging.setReaction).toHaveBeenLastCalledWith(
      "history-1",
      "👍",
      false,
    );
    expect(
      store.getState().messages.find((item) => item.id === "history-1")
        ?.reactions,
    ).toEqual([]);
  });

  it("searches Tencent cloud messages and appends the next search cursor", async () => {
    const deps = dependencies();
    deps.messaging.searchMessages = jest
      .fn()
      .mockResolvedValueOnce({
        completed: false,
        messages: [message("search-2", "2026-07-30T02:00:00.000Z")],
        nextCursor: "search-cursor-2",
        totalCount: 2,
      })
      .mockResolvedValueOnce({
        completed: true,
        messages: [message("search-1", "2026-07-30T01:00:00.000Z")],
        totalCount: 2,
      });
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().searchMessages("历史");
    await store.getState().loadMoreSearchResults();

    expect(deps.messaging.searchMessages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: expect.objectContaining({
          conversationId: "GROUPtopic-1",
        }),
        limit: 20,
        query: "历史",
      }),
    );
    expect(deps.messaging.searchMessages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: "search-cursor-2",
        query: "历史",
      }),
    );
    expect(store.getState().searchResults.map((item) => item.id)).toEqual([
      "search-1",
      "search-2",
    ]);
    expect(store.getState().searchCompleted).toBe(true);
  });

  it("loads missing search context, closes search and requests message focus", async () => {
    const deps = dependencies();
    const target = {
      ...message("search-target", "2026-07-30T03:00:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "search-target",
        sequence: 50,
        timestamp: 1_785_400_050,
      },
    };
    deps.messaging.searchMessages = jest.fn(async () => ({
      completed: true,
      messages: [target],
      totalCount: 1,
    }));
    deps.messaging.loadMessageContext = jest.fn(async () => [
      message("before", "2026-07-30T02:59:00.000Z"),
      target,
      message("after", "2026-07-30T03:01:00.000Z"),
    ]);
    const store = createAppStore(deps);
    await initializeChannel(store);
    await store.getState().searchMessages("目标");

    await store.getState().locateSearchResult("search-target");

    expect(deps.messaging.loadMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({conversationId: "GROUPtopic-1"}),
      target.reference,
    );
    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "history-1",
      "history-2",
      "before",
      "search-target",
      "after",
    ]);
    expect(store.getState()).toMatchObject({
      locatingSearchResultId: null,
      messageFocusRequest: {messageId: "search-target", revision: 1},
      searchLocateError: null,
      searchQuery: "",
      searchResults: [],
    });
  });

  it("keeps search results available when context loading fails", async () => {
    const deps = dependencies();
    const target = {
      ...message("search-target", "2026-07-30T03:00:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "search-target",
        sequence: 50,
        timestamp: 1_785_400_050,
      },
    };
    deps.messaging.searchMessages = jest.fn(async () => ({
      completed: true,
      messages: [target],
      totalCount: 1,
    }));
    deps.messaging.loadMessageContext = jest.fn(async () => {
      throw new Error("网络暂时不可用");
    });
    const store = createAppStore(deps);
    await initializeChannel(store);
    await store.getState().searchMessages("目标");

    await store.getState().locateSearchResult("search-target");

    expect(store.getState()).toMatchObject({
      locatingSearchResultId: null,
      searchLocateError: "无法定位这条消息：网络暂时不可用",
      searchQuery: "目标",
    });
    expect(store.getState().searchResults.map((item) => item.id)).toEqual([
      "search-target",
    ]);
  });

  it("focuses an already loaded search result without another network request", async () => {
    const deps = dependencies();
    const loaded = message("history-1", "2026-07-30T01:00:00.000Z");
    deps.messaging.searchMessages = jest.fn(async () => ({
      completed: true,
      messages: [loaded],
      totalCount: 1,
    }));
    const store = createAppStore(deps);
    await initializeChannel(store);
    await store.getState().searchMessages("history");

    await store.getState().locateSearchResult("history-1");

    expect(deps.messaging.loadMessageContext).not.toHaveBeenCalled();
    expect(store.getState().messageFocusRequest).toEqual({
      messageId: "history-1",
      revision: 1,
    });
  });

  it("keeps drafts isolated by conversation and clears only the accepted message draft", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);

    store.getState().updateConversationDraft({
      attachments: [],
      document: createComposerTextDocument("Channel 待发送内容"),
    });
    await store
      .getState()
      .selectDirectConversation(directConversation.peerUserId);
    store.getState().updateConversationDraft({
      attachments: [],
      document: createComposerTextDocument("私信待发送内容"),
    });
    await store.getState().selectChannel(channel.id);

    expect(store.getState().conversationDrafts).toEqual({
      "channel:channel-1": {
        attachments: [],
        document: createComposerTextDocument("Channel 待发送内容"),
      },
      "direct:member-agent-1": {
        attachments: [],
        document: createComposerTextDocument("私信待发送内容"),
      },
    });

    await store.getState().sendMessage({
      mentionedUserIds: [],
      text: "Channel 待发送内容",
    });

    expect(store.getState().conversationDrafts).toEqual({
      "direct:member-agent-1": {
        attachments: [],
        document: createComposerTextDocument("私信待发送内容"),
      },
    });

    await store.getState().logout();
    expect(store.getState().conversationDrafts).toEqual({});
  });

  it("queues one Composer action as attachments followed by a mention commit", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().sendComposerDraft({
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "spec.pdf",
          size: 1_024,
          source: {
            kind: "uri",
            name: "spec.pdf",
            size: 1_024,
            uri: "file:///spec.pdf",
          },
        },
      ],
      document: createComposerDocument([
        {text: "请 ", type: "text"},
        {
          displayName: agent.displayName,
          handle: agent.handle,
          imUserId: agent.imUserId,
          memberId: agentMember.id,
          memberKind: "agent",
          type: "mention",
        },
        {text: " 核对", type: "text"},
      ]),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(deps.messaging.sendAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "file",
        submission: expect.objectContaining({
          count: 2,
          index: 0,
          role: "attachment",
        }),
      }),
    );
    expect(deps.messaging.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        mentions: [
          {
            displayName: agent.displayName,
            imUserId: agent.imUserId,
            memberId: agentMember.id,
            memberKind: "agent",
          },
        ],
        submission: expect.objectContaining({
          count: 2,
          final: true,
          index: 1,
          role: "commit",
        }),
        text: `请 @${agent.displayName} 核对`,
      }),
    );
    expect(
      jest.mocked(deps.messaging.sendAttachment).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(deps.messaging.sendText).mock.invocationCallOrder[0] ?? 0,
    );
    expect(store.getState().submissions).toEqual({});
  });

  it("retries a failed Composer part through its submission before sending the commit", async () => {
    const deps = dependencies();
    deps.messaging.sendAttachment = jest.fn(async () => {
      throw new MessagingSendError("附件上传失败", {
        outcome: "definitive",
        retryable: true,
      });
    });
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().sendComposerDraft({
      attachments: [
        {
          id: "attachment-retry-1",
          kind: "file",
          name: "spec.pdf",
          size: 1_024,
          source: {
            kind: "uri",
            name: "spec.pdf",
            size: 1_024,
            uri: "file:///spec.pdf",
          },
        },
      ],
      document: createComposerTextDocument("附件成功后再发送正文"),
    });

    await eventually(() => {
      expect(Object.values(store.getState().submissions)[0]?.phase).toBe(
        "blocked",
      );
    });
    expect(deps.messaging.sendText).not.toHaveBeenCalled();
    const failed = store
      .getState()
      .messages.find((item) => item.delivery.state === "failed");
    expect(failed?.submission).toBeDefined();

    await store.getState().retryMessage(failed?.id ?? "missing");

    expect(deps.messaging.retryMessage).toHaveBeenCalledWith(
      failed?.clientRequestId,
    );
    await eventually(() => {
      expect(store.getState().submissions).toEqual({});
      expect(deps.messaging.sendText).toHaveBeenCalledTimes(1);
    });
    expect(
      store
        .getState()
        .messages.filter(
          (item) => item.submission?.id === failed?.submission?.id,
        ),
    ).toEqual([
      expect.objectContaining({delivery: {state: "sent"}}),
      expect.objectContaining({delivery: {state: "sent"}}),
    ]);
  });

  it("keeps message-search failure scoped and clears it with the search session", async () => {
    const deps = dependencies();
    deps.messaging.searchMessages = jest.fn(async () => {
      throw new Error("消息服务暂时不可用");
    });
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().searchMessages("协议");

    expect(store.getState()).toMatchObject({
      error: null,
      searchError: "消息服务暂时不可用",
      searchingMessages: false,
    });

    store.getState().clearMessageSearch();

    expect(store.getState()).toMatchObject({
      searchCompleted: true,
      searchCursor: null,
      searchError: null,
      searchQuery: "",
      searchResults: [],
    });
  });

  it("opens an indexed Thread, hydrates old replies and sends a new reply without polluting the Channel", async () => {
    const deps = dependencies();
    const root = {
      ...message("root-message-1", "2026-07-30T01:00:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "root-message-1",
        sequence: 100,
        senderUserId: agent.imUserId,
        timestamp: 1_785_400_000,
      },
    };
    const oldReply = {
      ...message("reply-message-1", "2026-07-30T01:01:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "reply-message-1",
        sequence: 108,
        senderUserId: agent.imUserId,
        timestamp: 1_785_400_108,
      },
      thread: {
        role: "reply" as const,
        rootMessageRef: root.reference,
        threadId: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      },
    };
    const thread: MessageThread = {
      channelId: channel.id,
      createdAt: "2026-07-30T01:00:00.000Z",
      id: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      lastReplyAt: "2026-07-30T01:01:00.000Z",
      replyCount: 1,
      rootMessageRef: {
        ...root.reference,
        groupId: channel.imGroupId,
        topicId: channel.imTopicId,
      },
      serverId: server.id,
      unreadCount: 1,
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [root, oldReply],
    }));
    deps.messaging.loadMessagesByReferences = jest.fn(async () => [oldReply]);
    deps.platform.ensureThread = jest.fn(async () => thread);
    deps.platform.listThreadReplies = jest.fn(async () => ({
      items: [
        {
          createdAt: oldReply.createdAt,
          id: "019fb45a-9d53-71ef-b925-d075796b48d5",
          messageRef: {
            ...oldReply.reference,
            groupId: channel.imGroupId,
            topicId: channel.imTopicId,
          },
          threadId: thread.id,
        },
      ],
    }));
    deps.platform.markThreadRead = jest.fn(async () => undefined);
    deps.platform.registerThreadReply = jest.fn(
      async (_serverId, _channelId, _threadId, input) => ({
        createdAt: "2026-07-30T01:02:00.000Z",
        id: "019fb45b-5dbc-7288-bb8d-bf573c93bcc4",
        messageRef: input.messageRef,
        threadId: thread.id,
      }),
    );
    deps.messaging.sendText = jest.fn(async (input) => ({
      ...message("reply-message-2", "2026-07-30T01:02:00.000Z"),
      clientRequestId: input.clientRequestId,
      direction: "outgoing" as const,
      reference: {
        kind: "group" as const,
        messageId: "reply-message-2",
        sequence: 109,
        senderUserId: account.imUserId,
        timestamp: 1_785_400_109,
      },
      thread: input.thread
        ? {
            role: "reply" as const,
            rootMessageRef: input.thread.rootMessageRef,
            threadId: input.thread.threadId,
          }
        : undefined,
    }));
    const store = createAppStore(deps);
    await initializeChannel(store);

    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "root-message-1",
    ]);
    await store.getState().openThread("root-message-1");
    expect(store.getState()).toMatchObject({
      activeThread: {
        id: thread.id,
        replyCount: 1,
        unreadCount: 0,
      },
      threadMessages: [expect.objectContaining({ id: "reply-message-1" })],
      threadRootMessage: expect.objectContaining({ id: "root-message-1" }),
    });

    await store.getState().sendThreadReply({
      mentionedUserIds: [],
      text: "新的 Thread 回复",
    });

    expect(deps.messaging.sendText).toHaveBeenLastCalledWith(
      expect.objectContaining({
        thread: {
          rootMessageRef: thread.rootMessageRef,
          threadId: thread.id,
        },
      }),
    );
    expect(deps.platform.registerThreadReply).toHaveBeenCalledWith(
      server.id,
      channel.id,
      thread.id,
      {
        messageRef: expect.objectContaining({
          messageId: "reply-message-2",
          sequence: 109,
        }),
      },
      "request-1:thread:reply:index",
    );
    expect(store.getState().threadMessages.map((item) => item.id)).toEqual([
      "reply-message-1",
      "reply-message-2",
    ]);
    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "root-message-1",
    ]);
  });

  it("keeps an unavailable Tencent Thread reply visible from its platform reference", async () => {
    const deps = dependencies();
    const root = {
      ...message("root-message-unavailable", "2026-07-30T01:00:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "root-message-unavailable",
        sequence: 100,
        senderUserId: agent.imUserId,
        timestamp: 1_785_400_000,
      },
    };
    const thread: MessageThread = {
      channelId: channel.id,
      createdAt: "2026-07-30T01:00:00.000Z",
      id: "019fb45a-41bf-78d4-a5c0-a97b85046fc3",
      lastReplyAt: "2026-07-30T01:01:00.000Z",
      replyCount: 1,
      rootMessageRef: {
        ...root.reference,
        groupId: channel.imGroupId,
        topicId: channel.imTopicId,
      },
      serverId: server.id,
      unreadCount: 1,
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [root],
    }));
    deps.messaging.loadMessagesByReferences = jest.fn(async () => []);
    deps.platform.ensureThread = jest.fn(async () => thread);
    deps.platform.listThreadReplies = jest.fn(async () => ({
      items: [
        {
          createdAt: "2026-07-30T01:01:00.000Z",
          id: "019fb45a-9d53-71ef-b925-d075796b48d6",
          messageRef: {
            groupId: channel.imGroupId,
            kind: "group" as const,
            messageId: "reply-message-unavailable",
            senderUserId: agent.imUserId,
            sequence: 108,
            timestamp: 1_785_400_108,
            topicId: channel.imTopicId,
          },
          threadId: thread.id,
        },
      ],
    }));

    const store = createAppStore(deps);
    await initializeChannel(store);
    await store.getState().openThread(root.id);

    expect(store.getState().threadMessages).toEqual([
      expect.objectContaining({
        id: "reply-message-unavailable",
        rawType: "VELA_MESSAGE_UNAVAILABLE",
        reference: expect.objectContaining({
          messageId: "reply-message-unavailable",
          sequence: 108,
        }),
        text: "消息已不可用",
        thread: expect.objectContaining({
          role: "reply",
          threadId: thread.id,
        }),
      }),
    ]);
    expect(deps.platform.markThreadRead).toHaveBeenCalledWith(
      server.id,
      channel.id,
      thread.id,
      "019fb45a-9d53-71ef-b925-d075796b48d6",
      "request-1:thread:read",
    );
  });

  it("keeps a Tencent-sent Thread reply visible when indexing fails and retries only the index", async () => {
    const deps = dependencies();
    const root = {
      ...message("root-message-1", "2026-07-30T01:00:00.000Z"),
      reference: {
        kind: "group" as const,
        messageId: "root-message-1",
        sequence: 101,
        senderUserId: account.imUserId,
        timestamp: 1_785_400_101,
      },
    };
    const indexedThread: MessageThread = {
      channelId: channel.id,
      createdAt: "2026-07-30T01:00:00.000Z",
      id: "019fb45a-34cc-75fd-a862-d896221101f6",
      lastReplyAt: null,
      replyCount: 0,
      rootMessageRef: {
        ...root.reference,
        groupId: channel.imGroupId,
        topicId: channel.imTopicId,
      },
      serverId: server.id,
      unreadCount: 0,
    };
    deps.messaging.loadHistory = jest.fn(async () => ({
      completed: true,
      messages: [root],
    }));
    deps.platform.ensureThread = jest.fn(async () => indexedThread);
    deps.platform.listThreadReplies = jest.fn(async () => ({ items: [] }));
    deps.platform.markThreadRead = jest.fn(async () => undefined);
    deps.messaging.sendText = jest.fn(async (input) => ({
      ...message("reply-message-pending-index", "2026-07-30T01:02:00.000Z"),
      clientRequestId: input.clientRequestId,
      direction: "outgoing" as const,
      reference: {
        kind: "group" as const,
        messageId: "reply-message-pending-index",
        sequence: 110,
        senderUserId: account.imUserId,
        timestamp: 1_785_400_110,
      },
      thread: {
        role: "reply" as const,
        rootMessageRef: indexedThread.rootMessageRef,
        threadId: indexedThread.id,
      },
    }));
    deps.platform.registerThreadReply = jest
      .fn()
      .mockRejectedValueOnce(new Error("平台暂时不可用"))
      .mockResolvedValueOnce({
        createdAt: "2026-07-30T01:02:00.000Z",
        id: "019fb45b-5dbc-7288-bb8d-bf573c93bcc4",
        messageRef: {
          kind: "group" as const,
          messageId: "reply-message-pending-index",
          sequence: 110,
          senderUserId: account.imUserId,
          timestamp: 1_785_400_110,
          groupId: channel.imGroupId,
          topicId: channel.imTopicId,
        },
        threadId: indexedThread.id,
      });

    const store = createAppStore(deps);
    await initializeChannel(store);
    await store.getState().openThread(root.id);
    await store.getState().sendThreadReply({
      mentionedUserIds: [],
      text: "已经发到腾讯，但索引暂时失败",
    });

    expect(store.getState()).toMatchObject({
      pendingThreadIndexMessageIds: ["reply-message-pending-index"],
      sendingThreadReply: false,
    });
    expect(deps.messaging.sendText).toHaveBeenCalledTimes(1);
    expect(
      store.getState().threadMessages.map((item) => ({
        delivery: item.delivery,
        id: item.id,
      })),
    ).toEqual([
      {
        delivery: { state: "sent" },
        id: "reply-message-pending-index",
      },
    ]);

    await store.getState().retryThreadReplyIndex("reply-message-pending-index");

    expect(store.getState().error).toBeNull();
    expect(deps.messaging.sendText).toHaveBeenCalledTimes(1);
    expect(deps.platform.registerThreadReply).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingThreadIndexMessageIds).toEqual([]);
    expect(store.getState().activeThread).toMatchObject({
      replyCount: 1,
      unreadCount: 0,
    });
  });

  it("creates a platform Task from a message reference and publishes its custom message", async () => {
    const deps = dependencies();
    deps.platform.createTask = jest.fn(async (_serverId, input) => ({
      ...task,
      sourceMessageRef: input.sourceMessageRef,
      title: input.title,
    }));
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().createTaskFromMessage("history-1");

    expect(deps.platform.createTask).toHaveBeenCalledWith(
      server.id,
      {
        sourceMessageRef: {
          groupId: channel.imGroupId,
          kind: "group",
          messageId: "history-1",
          senderUserId: agent.imUserId,
          topicId: channel.imTopicId,
        },
        title: "history-1",
      },
      "request-1:task:create",
    );
    expect(deps.messaging.sendTask).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({
          conversationId: "GROUPtopic-1",
        }),
        task: expect.objectContaining({
          taskId: task.id,
          title: "history-1",
        }),
      }),
    );
    expect(store.getState().messages.at(-1)).toMatchObject({
      kind: "task",
    });
  });

  it("loads older Tencent history with the current cursor exactly once", async () => {
    const deps = dependencies();
    deps.messaging.loadHistory = jest
      .fn()
      .mockResolvedValueOnce({
        completed: false,
        messages: [
          message("history-4", "2026-07-30T04:00:00.000Z"),
          message("history-3", "2026-07-30T03:00:00.000Z"),
        ],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        completed: true,
        messages: [
          message("history-2", "2026-07-30T02:00:00.000Z"),
          message("history-1", "2026-07-30T01:00:00.000Z"),
        ],
      });
    const store = createAppStore(deps);
    await initializeChannel(store);

    await Promise.all([
      store.getState().loadOlderMessages(),
      store.getState().loadOlderMessages(),
    ]);

    expect(deps.messaging.loadHistory).toHaveBeenNthCalledWith(
      2,
      {
        channelId: channel.id,
        conversationId: "GROUPtopic-1",
        imGroupId: channel.imGroupId,
        imTopicId: channel.imTopicId,
        targetId: "topic-1",
      },
      "cursor-2",
    );
    expect(deps.messaging.loadHistory).toHaveBeenCalledTimes(2);
    expect(store.getState().historyCompleted).toBe(true);
    expect(store.getState().historyCursor).toBeNull();
    expect(store.getState().messages.map((item) => item.id)).toEqual([
      "history-1",
      "history-2",
      "history-3",
      "history-4",
    ]);
  });

  it("keeps one optimistic attachment message and updates its upload progress", async () => {
    const deps = dependencies();
    let finishUpload: ((message: Message) => void) | undefined;
    deps.messaging.sendAttachment = jest.fn(
      async (input) =>
        new Promise<Message>((resolve) => {
          finishUpload = resolve;
          input.onProgress?.(0.4);
        }),
    );
    const store = createAppStore(deps);
    await initializeChannel(store);
    deps.emitLifecycle({ type: "ready" });

    const sending = store.getState().sendAttachment({
      kind: "image",
      source: {
        kind: "uri",
        mimeType: "image/png",
        name: "diagram.png",
        size: 456_789,
        uri: "file:///private/diagram.png",
      },
    });
    await eventually(() => {
      expect(
        store.getState().messages.find((item) => item.id === "local:request-1"),
      ).toMatchObject({
        clientRequestId: "request-1",
        content: {
          kind: "image",
          name: "diagram.png",
          size: 456_789,
          url: "file:///private/diagram.png",
        },
        delivery: { progress: 0.4, state: "uploading" },
      });
    });

    finishUpload?.({
      ...message("remote-image-1", "2026-07-30T04:00:00.000Z"),
      clientRequestId: "request-1",
      content: {
        kind: "image",
        name: "diagram.png",
        url: "https://example.invalid/diagram.png",
      },
      kind: "image",
      text: "[图片]",
    });
    await sending;

    expect(
      store
        .getState()
        .messages.filter((item) => item.clientRequestId === "request-1"),
    ).toEqual([
      expect.objectContaining({
        delivery: { state: "sent" },
        id: "remote-image-1",
      }),
    ]);
  });

  it("offers only active ready Agents that belong to the selected Channel", async () => {
    const deps = dependencies();
    const outsider = {
      ...agent,
      id: "agent-outsider",
      imUserId: "agent-im-outsider",
    };
    deps.platform.listAgents = jest.fn(async () => [agent, outsider]);
    const store = createAppStore(deps);

    await initializeChannel(store);

    expect(mentionableAgents(store.getState()).map((item) => item.id)).toEqual([
      agent.id,
    ]);
    expect(deps.platform.listChannelMembers).toHaveBeenCalledWith(
      server.id,
      channel.id,
    );
  });

  it("loads Tasks and Inbox lazily and refreshes Inbox after Task creation", async () => {
    const deps = dependencies();
    const created = {
      ...task,
      id: "task-2",
      number: 2,
      title: "补齐 Expo 管理面",
    };
    deps.platform.createTask = jest.fn(async () => created);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    expect(deps.platform.listTasks).not.toHaveBeenCalled();
    expect(deps.platform.listInbox).not.toHaveBeenCalled();

    await store.getState().refreshWork();
    await store.getState().createTask({
      title: created.title,
    });

    expect(store.getState().tasks).toEqual([task, created]);
    expect(store.getState().inbox).toEqual([inboxItem]);
    expect(deps.platform.createTask).toHaveBeenCalledWith(
      server.id,
      { title: created.title },
      "request-1:task:create",
    );
    expect(deps.platform.listInbox).toHaveBeenCalledTimes(2);
    expect(store.getState().pendingAction).toBeNull();
  });

  it("creates an Agent through the control plane and reloads Agent status", async () => {
    const deps = dependencies();
    const created = {
      ...agent,
      displayName: "交付助手",
      handle: "delivery",
      id: "agent-2",
      imUserId: "agent-im-2",
    };
    deps.platform.listAgents = jest
      .fn()
      .mockResolvedValueOnce([agent])
      .mockResolvedValueOnce([agent, created]);
    deps.platform.createAgent = jest.fn(async () => ({
      operations: [
        {
          createdAt: "2026-07-31T08:00:00.000Z",
          id: "operation-agent-2",
          kind: "im.agent.ensure",
          service: "im" as const,
          state: "pending" as const,
        },
      ],
      resourceId: created.id,
    }));
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().createAgent({
      computerId: computer.id,
      displayName: created.displayName,
      handle: created.handle,
      replyPolicy: "mention_and_dm",
      runtime: { kind: "hermes-gateway" },
    });

    expect(store.getState().agents).toEqual([agent, created]);
    expect(deps.platform.createAgent).toHaveBeenCalledWith(
      server.id,
      expect.objectContaining({ handle: "delivery" }),
      "request-1:agent:create",
    );
  });

  it("waits for Agent readiness and a deployed credential before auto-starting", async () => {
    const deps = dependencies();
    const created = {
      ...agent,
      credentialVersion: 0,
      desiredState: "stopped" as const,
      displayName: "交付助手",
      handle: "delivery",
      id: "agent-2",
      imState: "provisioning" as const,
      observedState: "unknown" as const,
    };
    const ready = {
      ...created,
      imState: "ready" as const,
    };
    const deployed = {
      ...ready,
      credentialVersion: 1,
      observedState: "stopped" as const,
    };
    const running = {
      ...deployed,
      desiredState: "running" as const,
      observedState: "starting" as const,
    };
    deps.provisioningPollIntervalMs = 0;
    deps.provisioningPollLimit = 6;
    deps.sleep = jest.fn(async () => undefined);
    deps.platform.listAgents = jest
      .fn()
      .mockResolvedValueOnce([agent])
      .mockResolvedValueOnce([agent, created])
      .mockResolvedValueOnce([agent, created])
      .mockResolvedValueOnce([agent, ready])
      .mockResolvedValueOnce([agent, ready])
      .mockResolvedValueOnce([agent, deployed])
      .mockResolvedValueOnce([agent, running]);
    deps.platform.createAgent = jest.fn(async () => ({
      operations: [],
      resourceId: created.id,
    }));
    deps.platform.agentAction = jest.fn(async (_serverId, _agentId, action) => ({
      createdAt: "2026-08-10T08:00:00.000Z",
      id: `operation-${action}`,
      kind: `agent.${action}`,
      service: "platform" as const,
      state: "succeeded" as const,
    }));
    const store = createAppStore(deps);
    await initializeServerContext(store);

    const accepted = await store.getState().createAgent(
      {
        computerId: computer.id,
        displayName: created.displayName,
        handle: created.handle,
        replyPolicy: "mention_and_dm",
        runtime: {kind: "codex"},
      },
      {deployAndStart: true},
    );

    expect(accepted?.resourceId).toBe(created.id);
    expect(deps.platform.agentAction).toHaveBeenNthCalledWith(
      1,
      server.id,
      created.id,
      "deploy",
      "request-1:agent:deploy",
    );
    expect(deps.platform.agentAction).toHaveBeenNthCalledWith(
      2,
      server.id,
      created.id,
      "start",
      "request-1:agent:start",
    );
    expect(store.getState().agents).toEqual([agent, running]);
    expect(store.getState().pendingAction).toBeNull();
  });

  it("converges the Computer revision without storing registration scripts", async () => {
    const deps = dependencies();
    deps.platform.createComputerRegistrationScript = jest
      .fn()
      .mockResolvedValueOnce({
        computerId: computer.id,
        expiresAt: "2026-07-31T08:10:00.000Z",
        revision: 2,
        script: "one-time-registration-material",
      })
      .mockResolvedValueOnce({
        computerId: computer.id,
        expiresAt: "2026-07-31T08:11:00.000Z",
        revision: 3,
        script: "replacement-registration-material",
      });
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshComputers();
    const first = await store
      .getState()
      .requestComputerRegistrationScript(computer.id);
    const second = await store
      .getState()
      .requestComputerRegistrationScript(computer.id);

    expect(deps.platform.createComputerRegistrationScript).toHaveBeenNthCalledWith(
      1,
      server.id,
      computer.id,
      1,
    );
    expect(deps.platform.createComputerRegistrationScript).toHaveBeenNthCalledWith(
      2,
      server.id,
      computer.id,
      2,
    );
    expect(store.getState().computers).toEqual([{...computer, revision: 3}]);
    expect(first?.script).toBe("one-time-registration-material");
    expect(second?.script).toBe("replacement-registration-material");
    expect(JSON.stringify(store.getState())).not.toContain(
      "one-time-registration-material",
    );
    expect(JSON.stringify(store.getState())).not.toContain(
      "replacement-registration-material",
    );
    expect(store.getState().pendingAction).toBeNull();
  });

  it("removes an unbound Computer only after the platform confirms release", async () => {
    const deps = dependencies();
    const removeComputer = jest.fn(async () => undefined);
    Object.assign(deps.platform, {removeComputer});
    deps.platform.listAgents = jest.fn(async () => []);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await Promise.all([
      store.getState().refreshComputers(),
      store.getState().refreshAgents(),
    ]);

    const removed = await store.getState().removeComputer(computer.id);

    expect(removed).toBe(true);
    expect(removeComputer).toHaveBeenCalledWith(
      server.id,
      computer.id,
      "request-1:computer:remove",
    );
    expect(store.getState().computers).toEqual([]);
    expect(store.getState().pendingAction).toBeNull();
  });

  it("blocks Computer release while an Agent is still bound", async () => {
    const deps = dependencies();
    deps.platform.listAgents = jest.fn(async () => [
      {...agent, computerId: computer.id},
    ]);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await Promise.all([
      store.getState().refreshComputers(),
      store.getState().refreshAgents(),
    ]);

    const removed = await store.getState().removeComputer(computer.id);

    expect(removed).toBe(false);
    expect(deps.platform.removeComputer).not.toHaveBeenCalled();
    expect(store.getState().computers).toEqual([computer]);
    expect(store.getState().error).toBe("请先迁移或解绑 1 个 Agent");
  });

  it("loads Server members for IM scope, keeps invites lazy, and never stores an invite token", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);

    expect(deps.platform.listMembers).toHaveBeenCalledTimes(1);
    expect(deps.platform.listInvites).not.toHaveBeenCalled();

    await store.getState().refreshOrganization();
    const secret = await store.getState().createInvite({
      expiresAt: invite.expiresAt,
      maxUses: invite.maxUses,
      role: invite.role,
    });

    expect(store.getState().members).toEqual([ownerMember, agentMember]);
    expect(store.getState().invites).toEqual([invite]);
    expect(secret?.token).toBe("one-time-invite-token");
    expect(JSON.stringify(store.getState())).not.toContain(
      "one-time-invite-token",
    );
  });

  it("reuses fresh Server bootstrap resources until a manual refresh is forced", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().refreshAgents();
    await store.getState().refreshOrganization();

    expect(deps.platform.listAgents).toHaveBeenCalledTimes(1);
    expect(deps.platform.listMembers).toHaveBeenCalledTimes(1);
    expect(deps.platform.listInvites).toHaveBeenCalledTimes(1);

    await store.getState().refreshAgents({force: true});
    await store.getState().refreshOrganization({force: true});

    expect(deps.platform.listAgents).toHaveBeenCalledTimes(2);
    expect(deps.platform.listMembers).toHaveBeenCalledTimes(2);
    expect(deps.platform.listInvites).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent refreshes of the same Server resource", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);
    let resolveComputers!: (value: typeof computer[]) => void;
    deps.platform.listComputers = jest.fn(
      () =>
        new Promise<typeof computer[]>((resolve) => {
          resolveComputers = resolve;
        }),
    );
    const first = store.getState().refreshComputers({force: true});
    const second = store.getState().refreshComputers({force: true});
    expect(deps.platform.listComputers).toHaveBeenCalledTimes(1);

    resolveComputers([computer]);
    await Promise.all([first, second]);
    expect(store.getState().computers).toEqual([computer]);
  });

  it("accepts a join link and selects its stable Server Channel landing", async () => {
    const deps = dependencies();
    deps.platform.acceptJoinLink = jest.fn(async () => ({
      landingChannelId: allMembersChannel.id,
      memberId: ownerMember.id,
      operations: [],
      serverId: server.id,
      serverSlug: server.slug,
    }));
    deps.platform.listChannels = jest.fn(async () => [allMembersChannel, channel]);
    const store = createAppStore(deps);
    await store.getState().initialize();

    const joined = await store
      .getState()
      .acceptJoinLink("rfi_join_link_token");

    expect(deps.platform.acceptJoinLink).toHaveBeenCalledWith(
      "rfi_join_link_token",
      "request-1:join-link:accept",
    );
    expect(joined).toMatchObject({
      landingChannelId: allMembersChannel.id,
      serverSlug: server.slug,
    });
    expect(store.getState().currentServerId).toBe(server.id);
    expect(store.getState().currentChannelId).toBe(allMembersChannel.id);
    expect(store.getState().computers).toEqual([computer]);
    expect(store.getState().joinLinkErrorKind).toBeNull();
  });

  it("keeps an accepted membership when the required IM reconnect is unavailable", async () => {
    const deps = dependencies();
    deps.platform.listChannels = jest.fn(async () => [allMembersChannel]);
    deps.platform.createHumanImSession = jest.fn(async () => {
      throw new Error("IM 暂时无法连接");
    });
    const store = createAppStore(deps);
    store.setState({
      account,
      authStatus: "signed_in",
      imState: {message: "IM 身份尚未就绪", status: "error"},
    });

    const joined = await store
      .getState()
      .acceptJoinLink("rfi_join_link_after_registration");

    expect(joined).toMatchObject({
      landingChannelId: allMembersChannel.id,
      serverId: server.id,
    });
    expect(deps.platform.acceptJoinLink).toHaveBeenCalledTimes(1);
    expect(deps.platform.createHumanImSession).toHaveBeenCalledTimes(1);
    expect(store.getState().currentServerId).toBe(server.id);
    expect(store.getState().currentChannelId).toBeNull();
    expect(store.getState().imState.status).toBe("error");
  });

  it("classifies an invalid join link as terminal", async () => {
    const deps = dependencies();
    deps.platform.acceptJoinLink = jest.fn(async () => {
      throw new PlatformError("RESOURCE_NOT_FOUND", "邀请无效或已失效", {
        platformCode: "invite_invalid",
      });
    });
    const store = createAppStore(deps);

    const joined = await store
      .getState()
      .acceptJoinLink("rfi_invalid_join_link_token");

    expect(joined).toBeNull();
    expect(store.getState().joinLinkErrorKind).toBe("terminal");
  });

  it("classifies a newly registered account waiting for IM identity separately", async () => {
    const deps = dependencies();
    deps.platform.acceptJoinLink = jest.fn(async () => {
      throw new PlatformError("CONFLICT", "账号 IM 身份尚未就绪", {
        platformCode: "im_identity_not_ready",
      });
    });
    const store = createAppStore(deps);

    const joined = await store
      .getState()
      .acceptJoinLink("rfi_identity_pending_join_link_token");

    expect(joined).toBeNull();
    expect(store.getState().joinLinkErrorKind).toBe("identity_pending");
  });

  it("keeps transient join-link failures retryable", async () => {
    const deps = dependencies();
    deps.platform.acceptJoinLink = jest.fn(async () => {
      throw new PlatformError("NETWORK", "网络暂时不可用");
    });
    const store = createAppStore(deps);

    await store.getState().acceptJoinLink("rfi_retryable_join_link_token");

    expect(store.getState().joinLinkErrorKind).toBe("retryable");
  });

  it("keeps the member list usable when invites are forbidden", async () => {
    const deps = dependencies();
    deps.platform.listInvites = jest.fn(async () => {
      throw new PlatformError("AUTH_FORBIDDEN", "当前角色不能查看邀请");
    });
    const store = createAppStore(deps);
    await initializeChannel(store);

    await store.getState().refreshOrganization();

    expect(store.getState().members).toEqual([ownerMember, agentMember]);
    expect(store.getState().invites).toEqual([]);
    expect(store.getState().loadingOrganization).toBe(false);
  });

  it("updates a Channel with its current revision and keeps visibility unchanged", async () => {
    const deps = dependencies();
    const updated = {
      ...channel,
      description: "交付讨论",
      name: "delivery",
      revision: 2,
    };
    deps.platform.updateChannel = jest.fn(async () => updated);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().updateChannel(channel.id, {
      description: updated.description,
      name: updated.name,
    });

    expect(store.getState().channels).toEqual([updated]);
    expect(deps.platform.updateChannel).toHaveBeenCalledWith(
      server.id,
      channel.id,
      {
        description: updated.description,
        name: updated.name,
      },
      channel.revision,
      "request-1:channel:update",
    );
    expect(store.getState().channels[0]?.visibility).toBe("public");
  });

  it("updates the selected Server with its current revision", async () => {
    const deps = dependencies();
    const updated = {
      ...server,
      description: "协作与运行时研究",
      name: "Vela 研究实验室",
      revision: 2,
    };
    deps.platform.updateServer = jest.fn(async () => updated);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    const saved = await store.getState().updateServer({
      description: updated.description,
      name: updated.name,
    });

    expect(saved).toBe(true);
    expect(store.getState().servers).toEqual([updated]);
    expect(deps.platform.updateServer).toHaveBeenCalledWith(
      server.id,
      {description: updated.description, name: updated.name},
      server.revision,
      "request-1:server:update",
    );
  });

  it("reuses the Server update idempotency key for the same transient retry", async () => {
    const deps = dependencies();
    const updated = {...server, name: "Vela", revision: 2};
    deps.platform.updateServer = jest
      .fn()
      .mockRejectedValueOnce(new PlatformError("NETWORK", "网络暂时不可用"))
      .mockResolvedValueOnce(updated);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    expect(await store.getState().updateServer({name: "Vela"})).toBe(false);
    expect(await store.getState().updateServer({name: "Vela"})).toBe(true);

    expect(deps.platform.updateServer).toHaveBeenNthCalledWith(
      1,
      server.id,
      {name: "Vela"},
      server.revision,
      "request-1:server:update",
    );
    expect(deps.platform.updateServer).toHaveBeenNthCalledWith(
      2,
      server.id,
      {name: "Vela"},
      server.revision,
      "request-1:server:update",
    );
  });

  it("loads, sorts and mutates Reminders inside the selected Server", async () => {
    const deps = dependencies();
    const paused: Reminder = {
      ...reminder,
      id: "019fba00-0000-7000-8000-000000000002",
      nextFireAt: null,
      status: "paused",
    };
    const earlier: Reminder = {
      ...reminder,
      id: "019fba00-0000-7000-8000-000000000003",
      nextFireAt: "2026-08-01T09:00:00.000Z",
    };
    deps.platform.listReminders = jest.fn(async () => [
      paused,
      reminder,
      earlier,
    ]);
    const store = createAppStore(deps);
    await initializeServerContext(store);

    await store.getState().refreshReminders();
    expect(store.getState().reminders.map((item) => item.id)).toEqual([
      earlier.id,
      reminder.id,
      paused.id,
    ]);

    await store.getState().createReminder({
      agentId: agent.id,
      schedule: reminder.schedule,
      scheduleKind: "once",
      text: reminder.text,
      timezone: reminder.timezone,
    });
    await store.getState().updateReminder(reminder.id, { status: "paused" });
    await store.getState().cancelReminder(reminder.id);

    expect(deps.platform.createReminder).toHaveBeenCalledWith(
      server.id,
      expect.objectContaining({ text: reminder.text }),
      "request-1:reminder:create",
    );
    expect(deps.platform.updateReminder).toHaveBeenCalledWith(
      server.id,
      reminder.id,
      { status: "paused" },
      1,
      "request-1:reminder:update",
    );
    expect(deps.platform.cancelReminder).toHaveBeenCalledWith(
      server.id,
      reminder.id,
      2,
      "request-1:reminder:cancel",
    );
    expect(store.getState().reminders.map((item) => item.id)).toEqual([
      earlier.id,
      paused.id,
    ]);
  });

	it("tracks the synchronously completed platform Agent operation", async () => {
		const deps = dependencies();
		const store = createAppStore(deps);
		await initializeServerContext(store);

		const operation = await store.getState().runAgentAction(agent.id, "start");
		expect(operation?.state).toBe("succeeded");
		expect(
			store.getState().operationsById[pendingOperation.id]?.operation.state,
		).toBe("succeeded");
	});

  it("rotates a stopped Agent credential and keeps one-time PTY material outside state", async () => {
    const deps = dependencies();
    const stopped = {
      ...agent,
      computerId: computer.id,
      desiredState: "stopped" as const,
      observedState: "stopped" as const,
    };
    deps.platform.listAgents = jest.fn(async () => [stopped]);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshAgents();

		deps.platform.listAgents = jest.fn(async () => [{
			...stopped,
			credentialVersion: stopped.credentialVersion + 1,
		}]);
		const operation = await store.getState().rotateAgentCredential(stopped.id);
    const session = await store
      .getState()
      .createComputerTerminalSession(computer.id);

		expect(operation?.kind).toBe("agent.credential.rotate");
		expect(store.getState().agents[0]?.credentialVersion).toBe(
			stopped.credentialVersion + 1,
		);
    expect(deps.platform.rotateAgentRuntimeCredential).toHaveBeenCalledWith(
      server.id,
      stopped.id,
      "request-1:agent:credential:rotate",
    );
    expect(session?.sessionId).toBe("one-time-terminal-session");
    expect(JSON.stringify(store.getState())).not.toContain(
      "one-time-terminal-session",
    );
    expect(JSON.stringify(store.getState())).not.toContain(
      "terminal.example.test",
    );
  });

  it("refreshes the Computer projection after an offline terminal rejection", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshComputers();
    const offlineComputer = {
      ...computer,
      connectionState: "offline" as const,
      lastObservedAt: "2026-08-05T03:19:57.000Z",
    };
    deps.platform.listComputers = jest.fn(async () => [offlineComputer]);
    deps.platform.createTerminalSession = jest.fn(async () => {
      throw new PlatformError("CONFLICT", "Computer 当前离线", {
        platformCode: "computer_offline",
      });
    });

    const session = await store
      .getState()
      .createComputerTerminalSession(computer.id);

    expect(session).toBeNull();
    expect(deps.platform.listComputers).toHaveBeenCalledTimes(1);
    expect(store.getState().computers).toEqual([offlineComputer]);
    expect(store.getState().error).toBe("Computer 当前离线");
    expect(store.getState().pendingAction).toBeNull();
  });

  it("does not refresh Computers for an unrelated terminal failure", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshComputers();
    deps.platform.listComputers = jest.fn(async () => [computer]);
    deps.platform.createTerminalSession = jest.fn(async () => {
      throw new PlatformError("NETWORK", "终端服务暂时不可用");
    });

    const session = await store
      .getState()
      .createComputerTerminalSession(computer.id);

    expect(session).toBeNull();
    expect(deps.platform.listComputers).not.toHaveBeenCalled();
    expect(store.getState().error).toBe("终端服务暂时不可用");
  });

  it("removes an accepted Agent deletion from active state without touching Computer", async () => {
    const deps = dependencies();
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshComputers();

    const accepted = await store.getState().deleteAgent(agent.id);

    expect(accepted?.operations[0]?.kind).toBe("im.identity.delete");
    expect(deps.platform.deleteAgent).toHaveBeenCalledWith(
      server.id,
      agent.id,
      "request-1:agent:delete",
    );
    expect(store.getState().agents).toEqual([]);
    expect(store.getState().computers).toEqual([computer]);
    expect(
      store.getState().operationsById["operation-agent-delete"],
    ).toMatchObject({resourceId: agent.id, pollingState: "idle"});
  });

  it("clears Reminder and Operation projections when switching Server", async () => {
    const deps = dependencies();
    const mono = { ...server, id: "server-2", slug: "mono" };
    deps.platform.listChannels = jest.fn(async () => []);
    deps.platform.listAgents = jest.fn(async () => []);
    const store = createAppStore(deps);
    await initializeServerContext(store);
    await store.getState().refreshReminders();
    await store.getState().runAgentAction(agent.id, "start");

    await store.getState().selectServer(mono.id);

    expect(store.getState().reminders).toEqual([]);
    expect(store.getState().operationsById).toEqual({});
  });
});

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw failure;
}
