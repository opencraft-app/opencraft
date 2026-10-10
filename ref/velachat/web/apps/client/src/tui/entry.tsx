import {useEffect, useState} from "react";
import {useStore} from "zustand";
import type {StoreApi} from "zustand/vanilla";

import {
  createAppStore,
  mentionableMembers,
  type AppStoreState,
} from "../application/app-store";
import {conversationScope} from "../ui/layouts/conversation-scope";
import {
  conversationPageModel,
  type ConversationFormMode,
  type ConversationSemanticState,
} from "../ui/layouts/workspace-shell-model";
import {
  buildManagementShellModel,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationForm,
  type WorkspaceSetupModel,
} from "../ui/presentation";
import type {WorkspaceSection} from "../ui/presentation/section-navigation-model";
import {
  createNativePlatformPort,
  NativeMessagingPort,
  type NativeModuleEvent,
  type NativeModulesBridge,
} from "./native-modules";
import {useTerminalNavigation} from "./navigation";
import {Button, Text, TextInput, View} from "./primitives";
import {terminalPresenter} from "./presenter";
import {installTuiRuntimeGlobals} from "./runtime-globals";
import {
  createReactVaxisRenderer,
  type ReactVaxisRenderer,
} from "./renderer/reconciler";
import type {NativeNode} from "./renderer/node";

export interface TuiFacade {
  dispatch(handlerId: string, payload: Record<string, unknown>): boolean;
  protocol: "reactvaxis/v2";
  resize(width: number, height: number): void;
  start(): void;
}

export interface TuiApplication {
  dispatchNativeEvent(event: NativeModuleEvent): void;
  facade: TuiFacade;
  renderer: ReactVaxisRenderer;
  store: StoreApi<AppStoreState>;
}

type ManagementFormMode =
  | "accept-invite"
  | "create-agent"
  | "create-computer"
  | "create-task"
  | "edit-server";

export function createTuiApplication(input: {
  bridge: NativeModulesBridge;
  commit(tree: NativeNode): void;
}): TuiApplication {
  const messaging = new NativeMessagingPort(input.bridge);
  const platform = createNativePlatformPort(input.bridge);
  const store = createAppStore({
    connectMessaging: () => messaging.connectFresh(),
    messaging,
    platform,
  });
  const renderer = createReactVaxisRenderer(input.commit);
  let started = false;
  let viewport = {height: 40, width: 120};
  const renderRoot = () =>
    renderer.render(<TuiRoot store={store} viewport={viewport} />);
  const facade: TuiFacade = {
    dispatch(handlerId, payload) {
      return renderer.dispatch(handlerId, payload);
    },
    protocol: "reactvaxis/v2",
    resize(width, height) {
      viewport = {height, width};
      if (started) void renderRoot();
    },
    start() {
      started = true;
      void renderRoot();
    },
  };
  return {
    dispatchNativeEvent: (event) => messaging.dispatchNativeEvent(event),
    facade,
    renderer,
    store,
  };
}

function TuiRoot({
  store,
  viewport,
}: {
  store: StoreApi<AppStoreState>;
  viewport: {height: number; width: number};
}) {
  const state = useStore(store, (current) => current);
  const navigation = useTerminalNavigation();
  useEffect(() => {
    void store.getState().initialize();
  }, [store]);
  const firstServerID = state.servers[0]?.id;
  useEffect(() => {
    if (
      state.account &&
      state.serversStatus === "ready" &&
      !state.currentServerId &&
      !state.targetServerId &&
      firstServerID
    ) {
      void store.getState().selectServer(firstServerID);
    }
  }, [
    firstServerID,
    state.account,
    state.currentServerId,
    state.serversStatus,
    state.targetServerId,
    store,
  ]);
  const firstChannelID = state.channels.find(
    (channel) => channel.joined && channel.imState === "ready",
  )?.id;
  useEffect(() => {
    if (
      state.currentServerId &&
      state.serverContextStatus === "ready" &&
      !state.currentChannelId &&
      firstChannelID
    ) {
      void store.getState().selectChannel(firstChannelID);
    }
  }, [
    firstChannelID,
    state.currentChannelId,
    state.currentServerId,
    state.serverContextStatus,
    store,
  ]);

  if (viewport.width < 96 || viewport.height < 22) {
    return (
      <View
        style={{direction: "column", gap: 1, paddingX: 2, paddingY: 1, surface: "canvas"}}
        testID="terminal-width-remediation"
      >
        <Text maxLines={2}>终端宽度不足</Text>
        <Text maxLines={3}>
          当前 {viewport.width} × {viewport.height}，请将窗口调整到至少 96 × 22。
        </Text>
      </View>
    );
  }

  if (!state.account || state.authStatus !== "signed_in") {
    return <AuthRoute state={state} store={store} />;
  }
  if (state.serversStatus === "loading" || state.serverContextStatus === "loading") {
    return (
      <View testID="human-tui-loading">
        <Text>正在加载 Server…</Text>
      </View>
    );
  }
  if (state.serversStatus === "ready" && state.servers.length === 0) {
    return <WorkspaceSetupRoute state={state} store={store} />;
  }
  if (!state.currentServerId) {
    return (
      <View testID="human-tui-selecting-server">
        <Text>{state.error ?? "正在进入 Server…"}</Text>
      </View>
    );
  }
  return navigation.activeSection === "chat" ? (
    <ConversationRoute
      onNavigateSection={navigation.navigate}
      state={state}
      store={store}
    />
  ) : (
    <ManagementRoute
      activeSection={navigation.activeSection}
      key={navigation.activeSection}
      onNavigateSection={navigation.navigate}
      state={state}
      store={store}
    />
  );
}

function AuthRoute({
  state,
  store,
}: {
  state: AppStoreState;
  store: StoreApi<AppStoreState>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const busy = state.authStatus === "checking" || state.authStatus === "signing_in";
  return (
    <View
      style={{direction: "column", gap: 1, paddingX: 3, paddingY: 2, surface: "canvas"}}
      testID="auth-form-panel"
    >
      <Text maxLines={2}>欢迎回来{`\n使用 Human 账号登录 Vela`}</Text>
      <Text maxLines={1}>邮箱</Text>
      <TextInput
        disabled={busy}
        onChangeText={(payload) =>
          setEmail(typeof payload.value === "string" ? payload.value : "")
        }
        placeholder="name@example.com"
        testID="human-auth-email"
        value={email}
      />
      <Text maxLines={1}>密码</Text>
      <TextInput
        disabled={busy}
        onChangeText={(payload) =>
          setPassword(typeof payload.value === "string" ? payload.value : "")
        }
        secureTextEntry
        testID="human-auth-password"
        value={password}
      />
      {state.error ? <Text maxLines={2}>{state.error}</Text> : null}
      <Button
        disabled={busy || email.trim().length === 0 || password.length === 0}
        onPress={() => void store.getState().login(email.trim(), password)}
        testID="human-auth-submit"
        title="登录"
      />
    </View>
  );
}

function WorkspaceSetupRoute({
  state,
  store,
}: {
  state: AppStoreState;
  store: StoreApi<AppStoreState>;
}) {
  const [serverName, setServerName] = useState("");
  const [serverSlug, setServerSlug] = useState("");
  const [channelName, setChannelName] = useState("general");
  const model: WorkspaceSetupModel = {
    description: "创建 Server 和首个公开 Channel，开始 Human 与 Agent 协作。",
    ...(state.error ? {error: state.error} : {}),
    form: {
      actions: [
        {
          disabled:
            state.provisioningWorkspace ||
            !serverName.trim() ||
            !serverSlug.trim() ||
            !channelName.trim(),
          id: "create-workspace",
          label: state.provisioningWorkspace ? "创建中" : "创建",
          run: () =>
            store.getState().createWorkspace({
              channelName: channelName.trim(),
              serverName: serverName.trim(),
              serverSlug: serverSlug.trim(),
              visibility: "public",
            }),
        },
      ],
      fields: [
        {
          id: "server-name",
          label: "Server 名称",
          onChange: setServerName,
          placeholder: "例如：研发团队",
          value: serverName,
        },
        {
          id: "server-slug",
          label: "稳定地址",
          onChange: setServerSlug,
          placeholder: "例如：engineering",
          value: serverSlug,
        },
        {
          id: "channel-name",
          label: "首个 Channel",
          onChange: setChannelName,
          value: channelName,
        },
      ],
      title: "Server",
    },
    stage: state.provisioningStage,
    title: "建立你的第一个 Server",
  };
  return terminalPresenter.renderWorkspaceSetup(model, null);
}

function ConversationRoute({
  onNavigateSection,
  state,
  store,
}: {
  onNavigateSection(section: WorkspaceSection): void;
  state: AppStoreState;
  store: StoreApi<AppStoreState>;
}) {
  const [formMode, setFormMode] = useState<ConversationFormMode>(null);
  const [formValue, setFormValue] = useState("");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const semantic: ConversationSemanticState = {
    closeForm() {
      setFormMode(null);
      setFormValue("");
      setFormValues({});
    },
    formMode,
    formValue,
    formValues,
    openForm(mode, value = "", values = {}) {
      setFormMode(mode);
      setFormValue(value);
      setFormValues(values);
    },
    setFormField(id, value) {
      setFormValues((current) => ({...current, [id]: value}));
    },
    setFormValue,
  };
  const props = {
    account: state.account,
    activeConversation: state.activeConversation,
    activeThread: state.activeThread,
    agents: state.agents,
    canManageChannels: currentMemberCanManage(state),
    channelMembers: state.channelMembers,
    channels: state.channels,
    conversationDrafts: state.conversationDrafts,
    conversationSummaries: state.conversationSummaries,
    currentChannelId: state.currentChannelId,
    currentImUserId: state.account?.imUserId ?? undefined,
    currentServerId: state.currentServerId,
    directConversationSync: state.directConversationSync,
    directConversations: state.directConversations,
    error: state.error,
    historyCompleted: state.historyCompleted,
    imStatus: state.imState.status,
    loadingOlder: state.loadingOlderMessages,
    locatingSearchResultId: state.locatingSearchResultId,
    members: state.members,
    messageFocusRequest: state.messageFocusRequest,
    messages: state.messages,
    mentionMembers: mentionableMembers(state),
    onAddChannelMember: (memberId: string) =>
      store.getState().addChannelMember(memberId),
    onAttachLocalPath: (input: {kind: "file" | "image"; path: string}) =>
      store.getState().sendAttachment({
        kind: input.kind,
        source: {
          kind: "uri" as const,
          name: input.path.split(/[\\/]/u).at(-1) || "attachment",
          uri: input.path,
        },
      }),
    onClearMessageSearch: () => store.getState().clearMessageSearch(),
    onClearQuote: () => store.getState().clearQuote(),
    onCloseThread: () => store.getState().closeThread(),
    onContinueOperation: (operationId: string) =>
      store.getState().continueOperationPolling(operationId),
    onCreateChannel: (input: Parameters<AppStoreState["createChannel"]>[0]) =>
      store.getState().createChannel(input),
    onCreateTaskFromMessage: (messageId: string) =>
      store.getState().createTaskFromMessage(messageId),
    onDraftChange: (draft: Parameters<AppStoreState["updateConversationDraft"]>[0]) =>
      store.getState().updateConversationDraft(draft),
    onLoadMoreSearchResults: () => store.getState().loadMoreSearchResults(),
    onLoadMoreThreadReplies: () => store.getState().loadMoreThreadReplies(),
    onLoadOlder: () => store.getState().loadOlderMessages(),
    onLocateSearchResult: (messageId: string) =>
      store.getState().locateSearchResult(messageId),
    onLogout: () => store.getState().logout(),
    onNavigateSection,
    onOpenChannelManagement: () => store.getState().refreshOrganization(),
    onOpenThread: (messageId: string) => store.getState().openThread(messageId),
    onQuoteMessage: (messageId: string) => store.getState().quoteMessage(messageId),
    onReconnect: () => store.getState().reconnectIm(),
    onRemoveChannelMember: (memberId: string) =>
      store.getState().removeChannelMember(memberId),
    onRetryMessage: (messageId: string) => store.getState().retryMessage(messageId),
    onRevokeMessage: (messageId: string) => store.getState().revokeMessage(messageId),
    onSearchMessages: (query: string) => store.getState().searchMessages(query),
    onSelectChannel: (channelId: string) => store.getState().selectChannel(channelId),
    onSelectDirect: (peerUserId: string) =>
      store.getState().selectDirectConversation(peerUserId),
    onSelectServer: (serverId: string) => store.getState().selectServer(serverId),
    onSend: (draft: Parameters<AppStoreState["sendComposerDraft"]>[0]) =>
      store.getState().sendComposerDraft(draft),
    onSendThreadReply: (input: {mentionedUserIds: string[]; text: string}) =>
      store.getState().sendThreadReply(input),
    onToggleReaction: (messageId: string, reactionId: string) =>
      store.getState().toggleReaction(messageId, reactionId),
    onUpdateChannel: (
      channelId: string,
      input: Parameters<AppStoreState["updateChannel"]>[1],
    ) => store.getState().updateChannel(channelId, input),
    operations: Object.values(state.operationsById),
    pendingAction: state.pendingAction,
    pendingThreadIndexMessageIds: state.pendingThreadIndexMessageIds,
    searchCompleted: state.searchCompleted,
    searchError: state.searchError,
    searchLocateError: state.searchLocateError,
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    searchingMessages: state.searchingMessages,
    selectedQuote: state.selectedQuote,
    sending: state.sendingMessage,
    sendingThreadReply: state.sendingThreadReply,
    serverAgents: state.agents,
    servers: state.servers,
    threadCompleted: state.threadCompleted,
    threadLoading: state.threadLoading,
    threadMessages: state.threadMessages,
    threadRootMessage: state.threadRootMessage,
  };
  const scope = conversationScope(props);
  return terminalPresenter.renderConversationPage(
    conversationPageModel(props, semantic, scope),
    null,
  );
}

function ManagementRoute({
  activeSection,
  onNavigateSection,
  state,
  store,
}: {
  activeSection: Exclude<WorkspaceSection, "chat">;
  onNavigateSection(section: WorkspaceSection): void;
  state: AppStoreState;
  store: StoreApi<AppStoreState>;
}) {
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<ManagementFormMode | null>(null);
  const [agentComputerID, setAgentComputerID] = useState("");
  const [agentDisplayName, setAgentDisplayName] = useState("");
  const [agentHandle, setAgentHandle] = useState("");
  const [agentReplyPolicy, setAgentReplyPolicy] = useState<
    "all_channel_messages" | "dm_only" | "mention_and_dm"
  >("mention_and_dm");
  const [agentRuntime, setAgentRuntime] = useState<
    "codex" | "hermes-acp" | "hermes-gateway" | "openclaw"
  >("codex");
  const [computerName, setComputerName] = useState("");
  const [computerOS, setComputerOS] = useState<"linux" | "macos">("macos");
  const [inviteToken, setInviteToken] = useState("");
  const [serverDescription, setServerDescription] = useState("");
  const [serverName, setServerName] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  useEffect(() => {
    if (activeSection === "agents") {
      void Promise.all([
        store.getState().refreshAgents(),
        store.getState().refreshComputers(),
      ]);
    } else if (activeSection === "computers") {
      void store.getState().refreshComputers();
    } else if (activeSection === "members") {
      void store.getState().refreshOrganization();
    } else if (activeSection === "tasks") {
      void Promise.all([
        store.getState().refreshWork(),
        store.getState().refreshReminders(),
      ]);
    }
  }, [activeSection, store]);
  const resources = managementResources(activeSection, state);
  const selected = resources.find((item) => item.id === selectedID) ?? resources[0];
  const canManage = currentMemberCanManage(state);
  const selectedServer = state.servers.find(
    (server) => server.id === state.currentServerId,
  );
  const availableComputers = state.computers.filter(
    (computer) =>
      computer.lifecycleState === "active" && computer.connectionState === "online",
  );
  const commands: PresentationAction[] = [
    ...(activeSection === "agents" && canManage
      ? [{
          disabled: state.pendingAction !== null || availableComputers.length === 0,
          id: "create-agent",
          kind: "primary" as const,
          label: state.agents.length === 0 ? "创建第一个 Agent" : "新建 Agent",
          run: () => {
            setAgentComputerID(availableComputers[0]?.id ?? "");
            setFormMode("create-agent");
          },
        }]
      : []),
    ...(activeSection === "computers" && canManage
      ? [{
          disabled: state.pendingAction !== null,
          id: "create-computer",
          kind: "primary" as const,
          label: state.computers.length === 0 ? "纳管 Computer" : "新建 Computer",
          run: () => setFormMode("create-computer"),
        }]
      : []),
    ...(activeSection === "members"
      ? [{
          disabled: state.pendingAction !== null,
          id: "accept-invite",
          label: "接受邀请",
          run: () => setFormMode("accept-invite"),
        }]
      : []),
    ...(activeSection === "tasks"
      ? [{
          disabled: state.pendingAction !== null,
          id: "create-task",
          kind: "primary" as const,
          label: state.tasks.length === 0 ? "创建第一个任务" : "新建任务",
          run: () => setFormMode("create-task"),
        }]
      : []),
    ...(activeSection === "settings" && canManage && selectedServer
      ? [{
          disabled: state.pendingAction !== null,
          id: "edit-server",
          kind: "primary" as const,
          label: "编辑 Server",
          run: () => {
            setServerName(selectedServer.name);
            setServerDescription(selectedServer.description ?? "");
            setFormMode("edit-server");
          },
        }]
      : []),
    {
      disabled: state.pendingAction !== null,
      id: `refresh-${activeSection}`,
      label: "刷新",
      run: () => refreshManagementSection(activeSection, store),
    },
  ];
  const form = managementForm({
    agentComputerID,
    agentDisplayName,
    agentHandle,
    agentReplyPolicy,
    agentRuntime,
    availableComputers,
    computerName,
    computerOS,
    formMode,
    inviteToken,
    pending: state.pendingAction !== null,
    serverDescription,
    serverName,
    setAgentComputerID,
    setAgentDisplayName,
    setAgentHandle,
    setAgentReplyPolicy,
    setAgentRuntime,
    setComputerName,
    setComputerOS,
    setFormMode,
    setInviteToken,
    setSelectedID,
    setServerDescription,
    setServerName,
    setTaskDescription,
    setTaskTitle,
    store,
    taskDescription,
    taskTitle,
  });
  const model: ManagementPageModel = {
    collection: {
      items: resources.map((item) => ({
        id: item.id,
        onSelect: () => setSelectedID(item.id),
        selected: item.id === selected?.id,
        status: item.status,
        title: item.title,
      })),
      label: managementTitle(activeSection),
    },
    commands,
    ...(selected
      ? {
          detail: {
            actions: [],
            description: selected.description,
            status: selected.status,
            title: selected.title,
          },
        }
      : {
          empty: {
            description: `还没有${managementTitle(activeSection)}。`,
            title: managementTitle(activeSection),
          },
        }),
    ...(state.error ? {error: state.error} : {}),
    header: {
      eyebrow: managementHeader(activeSection),
      summary: `${resources.length} 项`,
      title: managementTitle(activeSection),
    },
    id: activeSection,
    ...(form ? {form} : {}),
    shell: buildManagementShellModel({
      accountLabel: state.account?.displayName,
      activeSection,
      canManageServer: currentMemberCanManage(state),
      currentServerId: state.currentServerId,
      onLogout: () => store.getState().logout(),
      onNavigateSection,
      onSelectServer: (serverId) => store.getState().selectServer(serverId),
      servers: state.servers,
    }),
  };
  return terminalPresenter.renderManagementPage(model, null);
}

function managementForm(input: {
  agentComputerID: string;
  agentDisplayName: string;
  agentHandle: string;
  agentReplyPolicy: "all_channel_messages" | "dm_only" | "mention_and_dm";
  agentRuntime: "codex" | "hermes-acp" | "hermes-gateway" | "openclaw";
  availableComputers: AppStoreState["computers"];
  computerName: string;
  computerOS: "linux" | "macos";
  formMode: ManagementFormMode | null;
  inviteToken: string;
  pending: boolean;
  serverDescription: string;
  serverName: string;
  setAgentComputerID(value: string): void;
  setAgentDisplayName(value: string): void;
  setAgentHandle(value: string): void;
  setAgentReplyPolicy(
    value: "all_channel_messages" | "dm_only" | "mention_and_dm",
  ): void;
  setAgentRuntime(
    value: "codex" | "hermes-acp" | "hermes-gateway" | "openclaw",
  ): void;
  setComputerName(value: string): void;
  setComputerOS(value: "linux" | "macos"): void;
  setFormMode(value: ManagementFormMode | null): void;
  setInviteToken(value: string): void;
  setSelectedID(value: string | null): void;
  setServerDescription(value: string): void;
  setServerName(value: string): void;
  setTaskDescription(value: string): void;
  setTaskTitle(value: string): void;
  store: StoreApi<AppStoreState>;
  taskDescription: string;
  taskTitle: string;
}): PresentationForm | null {
  const cancel: PresentationAction = {
    id: "cancel",
    label: "取消",
    run: () => input.setFormMode(null),
  };
  if (input.formMode === "create-agent") {
    const handleReady = /^[a-z0-9][a-z0-9_-]{1,31}$/u.test(
      input.agentHandle.trim(),
    );
    const openClawSupported =
      (input.availableComputers.find(
        (computer) => computer.id === input.agentComputerID,
      )?.assignmentVersion ?? 0) >= 3;
    return {
      actions: [
        cancel,
        {
          disabled:
            input.pending ||
            !input.agentDisplayName.trim() ||
            !handleReady ||
            !input.agentComputerID ||
            (input.agentRuntime === "openclaw" && !openClawSupported),
          id: "submit-agent",
          kind: "submit",
          label: input.pending ? "创建中" : "创建",
          run: async () => {
            const created = await input.store.getState().createAgent(
              {
                computerId: input.agentComputerID,
                displayName: input.agentDisplayName.trim(),
                handle: input.agentHandle.trim(),
                replyPolicy: input.agentReplyPolicy,
                runtime: {kind: input.agentRuntime},
              },
              {deployAndStart: true},
            );
            if (!created) return;
            input.setSelectedID(created.resourceId);
            input.setAgentDisplayName("");
            input.setAgentHandle("");
            input.setFormMode(null);
          },
        },
      ],
      fields: [
        {
          id: "agent-display-name",
          label: "显示名称",
          onChange: input.setAgentDisplayName,
          placeholder: "例如：交付助手",
          value: input.agentDisplayName,
        },
        {
          error:
            input.agentHandle.length > 0 && !handleReady
              ? "Handle 需为 2–32 位小写字母、数字、下划线或连字符。"
              : null,
          id: "agent-handle",
          label: "Handle",
          onChange: input.setAgentHandle,
          placeholder: "delivery",
          value: input.agentHandle,
        },
        {
          id: "agent-runtime",
          label: "Runtime",
          onChange: (value) =>
            input.setAgentRuntime(
              value === "hermes-acp" ||
              value === "hermes-gateway" ||
              value === "openclaw"
                ? value
                : "codex",
            ),
          options: [
            {label: "Codex", value: "codex"},
            {label: "Hermes ACP", value: "hermes-acp"},
            {label: "Hermes Gateway", value: "hermes-gateway"},
            ...(openClawSupported
              ? [{label: "OpenClaw", value: "openclaw" as const}]
              : []),
          ],
          value: input.agentRuntime,
        },
        {
          id: "agent-reply-policy",
          label: "回复策略",
          onChange: (value) =>
            input.setAgentReplyPolicy(
              value === "all_channel_messages" || value === "dm_only"
                ? value
                : "mention_and_dm",
            ),
          options: [
            {label: "提及 + 私聊", value: "mention_and_dm"},
            {label: "全部频道", value: "all_channel_messages"},
            {label: "仅私聊", value: "dm_only"},
          ],
          value: input.agentReplyPolicy,
        },
        {
          id: "agent-computer",
          label: "Computer",
          onChange: input.setAgentComputerID,
          options: input.availableComputers.map((computer) => ({
            label: computer.name,
            value: computer.id,
          })),
          value: input.agentComputerID,
        },
      ],
      title: "新建 Agent",
    };
  }
  if (input.formMode === "create-computer") {
    return {
      actions: [
        cancel,
        {
          disabled: input.pending || input.computerName.trim().length === 0,
          id: "submit-computer",
          kind: "submit",
          label: input.pending ? "创建中" : "创建",
          run: async () => {
            const created = await input.store.getState().createComputer({
              name: input.computerName.trim(),
              osType: input.computerOS,
            });
            if (!created) return;
            input.setSelectedID(created.id);
            input.setComputerName("");
            input.setComputerOS("macos");
            input.setFormMode(null);
          },
        },
      ],
      fields: [
        {
          id: "computer-name",
          label: "名称",
          onChange: input.setComputerName,
          placeholder: "例如：Linux 验收机",
          value: input.computerName,
        },
        {
          id: "computer-os",
          label: "目标平台",
          onChange: (value) =>
            input.setComputerOS(value === "linux" ? "linux" : "macos"),
          options: [
            {label: "macOS", value: "macos"},
            {label: "Linux", value: "linux"},
          ],
          value: input.computerOS,
        },
      ],
      title: "纳管 Computer",
    };
  }
  if (input.formMode === "accept-invite") {
    return {
      actions: [
        cancel,
        {
          disabled: input.pending || !input.inviteToken.trim(),
          id: "submit-invite",
          kind: "submit",
          label: input.pending ? "加入中" : "接受邀请",
          run: async () => {
            const accepted = await input.store
              .getState()
              .acceptInvite(input.inviteToken.trim());
            if (!accepted) return;
            input.setInviteToken("");
            input.setFormMode(null);
          },
        },
      ],
      fields: [
        {
          id: "invite-token",
          label: "邀请 token",
          onChange: input.setInviteToken,
          placeholder: "粘贴一次性邀请 token",
          value: input.inviteToken,
        },
      ],
      title: "加入其他 Server",
    };
  }
  if (input.formMode === "create-task") {
    return {
      actions: [
        cancel,
        {
          disabled: input.pending || !input.taskTitle.trim(),
          id: "submit-task",
          kind: "submit",
          label: input.pending ? "创建中" : "创建",
          run: async () => {
            await input.store.getState().createTask({
              description: input.taskDescription.trim() || null,
              title: input.taskTitle.trim(),
            });
            if (input.store.getState().error) return;
            input.setTaskDescription("");
            input.setTaskTitle("");
            input.setFormMode(null);
          },
        },
      ],
      fields: [
        {
          id: "task-title",
          label: "标题",
          onChange: input.setTaskTitle,
          placeholder: "需要完成什么？",
          value: input.taskTitle,
        },
        {
          id: "task-description",
          label: "描述",
          multiline: true,
          onChange: input.setTaskDescription,
          value: input.taskDescription,
        },
      ],
      title: "新建任务",
    };
  }
  if (input.formMode === "edit-server") {
    return {
      actions: [
        cancel,
        {
          disabled: input.pending || !input.serverName.trim(),
          id: "submit-server",
          kind: "submit",
          label: input.pending ? "保存中" : "保存",
          run: async () => {
            const saved = await input.store.getState().updateServer({
              description: input.serverDescription.trim() || null,
              name: input.serverName.trim(),
            });
            if (saved) input.setFormMode(null);
          },
        },
      ],
      fields: [
        {
          id: "server-name",
          label: "名称",
          onChange: input.setServerName,
          value: input.serverName,
        },
        {
          id: "server-description",
          label: "描述",
          multiline: true,
          onChange: input.setServerDescription,
          value: input.serverDescription,
        },
      ],
      title: "编辑 Server",
    };
  }
  return null;
}

function refreshManagementSection(
  section: Exclude<WorkspaceSection, "chat">,
  store: StoreApi<AppStoreState>,
): Promise<unknown> {
  if (section === "agents") {
    return Promise.all([
      store.getState().refreshAgents({force: true}),
      store.getState().refreshComputers({force: true}),
    ]);
  }
  if (section === "computers") {
    return store.getState().refreshComputers({force: true});
  }
  if (section === "members") {
    return store.getState().refreshOrganization({force: true});
  }
  if (section === "tasks") {
    return Promise.all([
      store.getState().refreshWork({force: true}),
      store.getState().refreshReminders({force: true}),
    ]);
  }
  return Promise.resolve();
}

function currentMemberCanManage(state: AppStoreState): boolean {
  const current = state.members.find(
    (member) => member.accountId === state.account?.id,
  );
  return current?.role === "owner" || current?.role === "admin";
}

function managementTitle(section: Exclude<WorkspaceSection, "chat">): string {
  if (section === "agents") return "Agent";
  if (section === "computers") return "Computer";
  if (section === "members") return "成员";
  if (section === "settings") return "设置";
  return "任务";
}

function managementHeader(section: Exclude<WorkspaceSection, "chat">): string {
  if (section === "agents") return "Agent 管理";
  if (section === "computers") return "计算资源";
  if (section === "members") return "成员管理";
  if (section === "tasks") return "协作任务";
  return "Server 设置";
}

function managementResources(
  section: Exclude<WorkspaceSection, "chat">,
  state: AppStoreState,
): Array<{description?: string; id: string; status?: string; title: string}> {
  if (section === "agents") {
    return state.agents.map((agent) => ({
      id: agent.id,
      status: agent.observedState,
      title: agent.displayName,
    }));
  }
  if (section === "computers") {
    return state.computers.map((computer) => ({
      id: computer.id,
      status: computer.connectionState,
      title: computer.name,
    }));
  }
  if (section === "members") {
    return state.members.map((member) => ({
      id: member.id,
      status: member.status,
      title: member.displayName,
    }));
  }
  if (section === "settings") {
    const server = state.servers.find((item) => item.id === state.currentServerId);
    return server
      ? [{description: server.description ?? undefined, id: server.id, title: server.name}]
      : [];
  }
  return state.tasks.map((task) => ({
    description: task.description ?? undefined,
    id: task.id,
    status: task.status,
    title: task.title,
  }));
}

declare global {
  var __velaNative:
    | {commit(tree: NativeNode): void}
    | undefined;
  var __velaNativeModuleDispatch:
    | ((event: NativeModuleEvent) => void)
    | undefined;
  var __velaNativeModules: NativeModulesBridge | undefined;
  var __velaTui: TuiFacade | undefined;
}

installTuiRuntimeGlobals();

if (globalThis.__velaNative && globalThis.__velaNativeModules) {
  const application = createTuiApplication({
    bridge: globalThis.__velaNativeModules,
    commit: (tree) => globalThis.__velaNative?.commit(tree),
  });
  globalThis.__velaNativeModuleDispatch = application.dispatchNativeEvent;
  globalThis.__velaTui = application.facade;
}
