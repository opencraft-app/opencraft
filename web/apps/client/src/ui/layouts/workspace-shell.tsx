import type {
  Account,
  AcceptedResource,
  ActiveConversation,
  Agent,
  AttachmentSource,
  Channel,
  ComposerDraft,
  ConversationSummary,
  CreateChannelInput,
  DirectConversation,
  Member,
  Message,
  MessageQuote,
  MessageThread,
  Server,
  UpdateChannelInput,
} from "@vela/client-core";
import {
  channelAddress,
  composerDocumentMentions,
  composerDocumentPreview,
  composerDocumentText,
  createComposerDocument,
  createComposerTextDocument,
} from "@vela/client-core";
import {
  createContext,
  useEffect,
  useContext,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import AtSign from "lucide-react-native/icons/at-sign";
import Bot from "lucide-react-native/icons/bot";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Hash from "lucide-react-native/icons/hash";
import ListChecks from "lucide-react-native/icons/list-checks";
import LogOut from "lucide-react-native/icons/log-out";
import Menu from "lucide-react-native/icons/menu";
import MessageCircle from "lucide-react-native/icons/message-circle";
import Monitor from "lucide-react-native/icons/monitor";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Search from "lucide-react-native/icons/search";
import Settings from "lucide-react-native/icons/settings";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import Ellipsis from "lucide-react-native/icons/ellipsis";
import type { LucideIcon } from "lucide-react-native";

import {
  MessageComposer,
  type MentionableMember,
} from "../components/message-composer";
import { BrandMark } from "../components/brand-mark";
import { MessageList } from "../components/message-list";
import {
  OperationStatusList,
  type OperationStatusItem,
} from "../components/operation-status-list";
import { ThreadPanel } from "../components/thread-panel";
import { UserPicker } from "../components/user-picker";
import { InlineEmptyState } from "../components/management-workspace";
import { ActionButton } from "../primitives/action-button";
import { IconActionButton } from "../primitives/icon-action-button";
import { formatConversationTimestamp } from "../date-time";
import {
  memberByImUserId,
  memberIdentityLabel,
  visibleMemberHandle,
} from "../member-identity";
import { workspaceLayoutMode } from "../workspace-layout-mode";
import { velaTheme } from "../tokens";
import {
  ConversationPresentation,
  type ConversationPageModel,
  type PresentationAction,
} from "../presentation";

export type WorkspaceImStatus =
  | "signed_out"
  | "issuing_session"
  | "logging_in"
  | "waiting_sdk_ready"
  | "ready"
  | "not_ready"
  | "kicked_out"
  | "error";

export type WorkspaceSection =
  | "agents"
  | "chat"
  | "computers"
  | "members"
  | "settings"
  | "tasks";

export interface NavigationLinkProps {
  children: ReactElement;
  href: string;
}

export type NavigationLinkComponent = ComponentType<NavigationLinkProps>;

const NavigationLinkContext = createContext<NavigationLinkComponent | null>(
  null,
);

export function NavigationLinkProvider({
  children,
  component,
}: {
  children: ReactNode;
  component: NavigationLinkComponent;
}) {
  return (
    <NavigationLinkContext.Provider value={component}>
      {children}
    </NavigationLinkContext.Provider>
  );
}

export interface WorkspaceShellProps {
  account?: Account | null;
  activeConversation?: ActiveConversation | null;
  activeSection?: WorkspaceSection;
  activeThread?: MessageThread | null;
  agents: Agent[];
  canManageChannels?: boolean;
  channelMembers?: Member[];
  channels: Channel[];
  conversationDrafts?: Record<string, ComposerDraft>;
  conversationSummaries?: ConversationSummary[];
  channelHref?(channel: Channel): string;
  currentChannelId: string | null;
  currentImUserId?: string;
  currentServerId: string | null;
  directConversations?: DirectConversation[];
  directHref?(peerUserId: string): string;
  directConversationSync?: "complete" | "idle" | "pending";
  error?: string | null;
  historyCompleted?: boolean;
  initializingMessages?: boolean;
  imStatus: WorkspaceImStatus;
  imStatusMessage?: string;
  loadingOlder?: boolean;
  members?: Member[];
  messages: Message[];
  mentionMembers?: MentionableMember[];
  messageFocusRequest?: { messageId: string; revision: number } | null;
  onAddChannelMember?(memberId: string): void | Promise<void>;
  onAttachFile?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onAttachImage?(): AttachmentSource | null | Promise<AttachmentSource | null>;
  onAttachLocalPath?(input: {
    kind: "file" | "image";
    path: string;
  }): void | Promise<void>;
  onClearQuote?(): void | Promise<void>;
  onClearMessageSearch?(): void;
  onCloseThread?(): void | Promise<void>;
  onCreateTaskFromMessage?(messageId: string): void | Promise<void>;
  onCreateChannel?(
    input: CreateChannelInput,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onLoadMoreSearchResults?(): void | Promise<void>;
  onLocateSearchResult?(messageId: string): void | Promise<void>;
  onContinueOperation?(operationId: string): void | Promise<void>;
  onLoadMoreThreadReplies?(): void | Promise<void>;
  onDraftChange?(draft: ComposerDraft): void;
  onLogout?(): void | Promise<void>;
  onNavigateSection?(section: WorkspaceSection): void;
  onLoadOlder?(): void | Promise<void>;
  onOpenChannelManagement?(): void | Promise<void>;
  onOpenThread?(messageId: string): void | Promise<void>;
  onRemoveChannelMember?(memberId: string): void | Promise<void>;
  onQuoteMessage?(messageId: string): void | Promise<void>;
  onReconnect?(): void | Promise<void>;
  onRevokeMessage?(messageId: string): void | Promise<void>;
  onRetryMessage?(messageId: string): void | Promise<void>;
  onRetryThreadReplyIndex?(messageId: string): void | Promise<void>;
  onSearchMessages?(query: string): void | Promise<void>;
  onSelectChannel(channelId: string): void | Promise<void>;
  onSelectDirect?(peerUserId: string): void | Promise<void>;
  onSelectServer(serverId: string): void | Promise<void>;
  onSend(draft: ComposerDraft): void | Promise<void>;
  onSendThreadReply?(input: {
    mentionedUserIds: string[];
    text: string;
  }): void | Promise<void>;
  onUpdateChannel?(
    channelId: string,
    input: UpdateChannelInput,
  ): void | Promise<void>;
  onToggleReaction?(
    messageId: string,
    reactionId: string,
  ): void | Promise<void>;
  pendingAction?: string | null;
  operations?: OperationStatusItem[];
  sectionHref?(section: WorkspaceSection): string;
  pendingThreadIndexMessageIds?: string[];
  searchCompleted?: boolean;
  searchError?: string | null;
  searchLocateError?: string | null;
  locatingSearchResultId?: string | null;
  searchQuery?: string;
  searchResults?: Message[];
  searchingMessages?: boolean;
  selectedQuote?: MessageQuote | null;
  sending?: boolean;
  sendingThreadReply?: boolean;
  serverAgents?: Agent[];
  servers: Server[];
  serverHref?(server: Server): string;
  threadCompleted?: boolean;
  threadLoading?: boolean;
  threadMessages?: Message[];
  threadRootMessage?: Message | null;
  viewportWidth?: number;
}

export interface PlatformFrameProps {
  account?: Account | null;
  activeSection: WorkspaceSection;
  children: ReactNode;
  canManageServer?: boolean;
  currentServerId: string | null;
  navigation: ReactNode;
  imStatus?: WorkspaceImStatus;
  onLogout?(): void | Promise<void>;
  onNavigateSection(section: WorkspaceSection): void;
  onSelectServer(serverId: string): void | Promise<void>;
  sectionHref?(section: WorkspaceSection): string;
  serverHref?(server: Server): string;
  servers: Server[];
  viewportWidth?: number;
}

export function PlatformFrame({
  account,
  activeSection,
  children,
  canManageServer = false,
  currentServerId,
  navigation,
  imStatus,
  onLogout,
  onNavigateSection,
  onSelectServer,
  sectionHref,
  serverHref,
  servers,
  viewportWidth,
}: PlatformFrameProps) {
  const window = useWindowDimensions();
  const mode = workspaceLayoutMode(viewportWidth ?? window.width);

  if (mode === "compact") {
    return (
      <View style={styles.compactShell}>
        {children}
        <MobileBottomNavigation
          activeSection={activeSection}
          canManageServer={canManageServer}
          navigationOpen={false}
          onNavigateSection={onNavigateSection}
          onToggle={() => onNavigateSection("chat")}
          sectionHref={sectionHref}
        />
      </View>
    );
  }

  return (
    <View style={styles.shell} testID="workspace-shell">
      <ServerRail
        account={account}
        activeSection={activeSection}
        canManageServer={canManageServer}
        currentServerId={currentServerId}
        imStatus={imStatus}
        onNavigateSection={onNavigateSection}
        onLogout={onLogout}
        onSelectServer={onSelectServer}
        sectionHref={sectionHref}
        serverHref={serverHref}
        servers={servers}
      />
      {navigation}
      {children}
    </View>
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

function emptyComposerDraft(): ComposerDraft {
  return {attachments: [], document: createComposerDocument()};
}

function composerDraftPreview(draft: ComposerDraft | undefined): string {
  if (!draft) return "";
  const text = composerDocumentPreview(draft.document);
  if (text) return text;
  return draft.attachments.length > 0
    ? `[${draft.attachments.length} 个附件]`
    : "";
}

type ConversationFormMode =
  | "attach-file"
  | "attach-image"
  | "create-channel"
  | "edit-channel"
  | "manage-channel-members"
  | "new-direct"
  | "search"
  | null;

interface ConversationSemanticState {
  closeForm(): void;
  formMode: ConversationFormMode;
  formValue: string;
  formValues: Record<string, string>;
  openForm(
    mode: Exclude<ConversationFormMode, null>,
    value?: string,
    values?: Record<string, string>,
  ): void;
  setFormField(id: string, value: string): void;
  setFormValue(value: string): void;
}

function conversationPageModel(
  props: WorkspaceShellProps,
  semantic: ConversationSemanticState,
): ConversationPageModel {
  const account = props.account ?? null;
  const activeConversation =
    props.activeConversation ??
    (props.currentChannelId
      ? ({ channelId: props.currentChannelId, kind: "channel" } as const)
      : null);
  const currentServer = props.servers.find(
    (server) => server.id === props.currentServerId,
  );
  const currentChannel = props.channels.find(
    (channel) => channel.id === props.currentChannelId,
  );
  const activeDirect =
    activeConversation?.kind === "direct"
      ? props.directConversations?.find(
          (item) => item.peerUserId === activeConversation.peerUserId,
        )
      : undefined;
  const activeDirectMember =
    activeConversation?.kind === "direct"
      ? props.members?.find(
          (member) => member.imUserId === activeConversation.peerUserId,
        )
      : undefined;
  const activeDraftKey = conversationDraftKey(activeConversation);
  const draft = activeDraftKey
    ? (props.conversationDrafts?.[activeDraftKey] ?? emptyComposerDraft())
    : emptyComposerDraft();
  const threadActive = Boolean(
    activeConversation?.kind === "channel" &&
      props.activeThread &&
      props.threadRootMessage,
  );
  const searchActive = Boolean(
    props.searchQuery || props.searchingMessages || props.searchError,
  );
  const displayedMessages = threadActive
    ? [props.threadRootMessage!, ...(props.threadMessages ?? [])]
    : searchActive
      ? (props.searchResults ?? [])
      : props.messages;
  const currentMember = props.members?.find(
    (member) =>
      member.kind === "human" &&
      (member.accountId === account?.id ||
        member.imUserId === (props.currentImUserId ?? account?.imUserId)),
  );
  const canJoin = Boolean(
    currentChannel &&
      currentMember &&
      !currentChannel.joined &&
      currentChannel.systemKey !== "all" &&
      (currentChannel.visibility === "public" || props.canManageChannels),
  );
  const draftText = composerDocumentText(draft.document);
  const mentionIds = composerDocumentMentions(draft.document).map(
    (mention) => mention.imUserId,
  );
  const existingDirectPeers = new Set(
    (props.directConversations ?? []).map((item) => item.peerUserId),
  );
  const directCandidates = (props.members ?? []).filter(
    (member) =>
      Boolean(member.imUserId) &&
      member.imState === "ready" &&
      member.imUserId !== (props.currentImUserId ?? account?.imUserId) &&
      !existingDirectPeers.has(member.imUserId!),
  );
  const navigationItems: Array<[WorkspaceSection, string]> = [
    ["chat", "聊天"],
    ["tasks", "任务"],
    ["agents", "Agent"],
    ["computers", "Computer"],
    ["members", "成员"],
  ];
  const navigation: PresentationAction[] = navigationItems.map(
    ([id, label]) => ({
      id: `navigate-${id}`,
      label,
      run: () => props.onNavigateSection?.(id as WorkspaceSection),
    }),
  );
  const commands: PresentationAction[] = [];
  if (threadActive) {
    commands.push({
      id: "close-thread",
      label: "返回频道",
      run: () => props.onCloseThread?.(),
      shortcut: "Esc",
    });
  }
  if (
    !threadActive &&
    displayedMessages.length > 0 &&
    !props.historyCompleted
  ) {
    commands.push({
      disabled: props.loadingOlder,
      id: "load-older",
      label: props.loadingOlder ? "加载中" : "更早消息",
      run: () => props.onLoadOlder?.(),
      shortcut: "L",
    });
  }
  if (activeConversation && props.onSearchMessages) {
    commands.push({
      disabled: props.searchingMessages,
      id: "search",
      label: props.searchingMessages ? "搜索中" : "搜索当前会话",
      run: () => semantic.openForm("search", props.searchQuery ?? ""),
      shortcut: "/",
    });
  }
  if (searchActive) {
    commands.push({
      id: "clear-search",
      label: "返回会话",
      run: () => props.onClearMessageSearch?.(),
      shortcut: "Esc",
    });
  }
  if (props.canManageChannels && props.onCreateChannel) {
    commands.push({
      id: "create-channel",
      kind: "primary",
      label: "新建 Channel",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("create-channel", "", {
          name: "",
          visibility: "public",
        });
      },
      shortcut: "N",
    });
  }
  if (
    props.canManageChannels &&
    currentChannel &&
    currentChannel.systemKey !== "all"
  ) {
    commands.push({
      id: "edit-channel",
      label: "编辑 Channel",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("edit-channel", "", {
          name: currentChannel.name,
          visibility: currentChannel.visibility,
        });
      },
      shortcut: "E",
    });
    commands.push({
      id: "manage-channel-members",
      label: "管理 Channel 成员",
      run: async () => {
        await props.onOpenChannelManagement?.();
        semantic.openForm("manage-channel-members");
      },
      shortcut: "M",
    });
  }
  if (props.onSelectDirect && (props.members?.length ?? 0) > 0) {
    commands.push({
      id: "new-direct",
      label: "新建私信",
      run: () => semantic.openForm("new-direct"),
      shortcut: "D",
    });
  }
  if (canJoin && currentMember) {
    commands.push({
      id: "join-channel",
      kind: "primary",
      label: "加入频道",
      run: () => props.onAddChannelMember?.(currentMember.id),
      shortcut: "J",
    });
  }
  if (props.imStatus !== "ready" && props.onReconnect) {
    commands.push({
      id: "reconnect",
      kind: "primary",
      label: "重新连接",
      run: props.onReconnect,
      shortcut: "R",
    });
  }

  const title = searchActive
    ? `搜索 · ${props.searchQuery || "当前会话"}`
    : threadActive
      ? `话题 · ${props.threadRootMessage?.senderName ?? "消息"}`
      : activeConversation?.kind === "direct"
        ? `@ ${activeDirect?.peerDisplayName ?? activeDirectMember?.displayName ?? activeConversation.peerUserId}`
        : currentChannel
          ? `# ${currentChannel.name}`
          : "选择会话";
  const onlineAgents = (props.serverAgents ?? props.agents).filter(
    (agent) =>
      agent.availability === "online" || agent.observedState === "running",
  ).length;
  const composerDisabled = Boolean(
    props.sending ||
      props.sendingThreadReply ||
      props.imStatus !== "ready" ||
      !activeConversation ||
      (activeConversation.kind === "channel" && !currentChannel?.joined),
  );
  const composerActions: PresentationAction[] = [];
  if (props.onAttachLocalPath && !threadActive) {
    composerActions.push({
      disabled: composerDisabled,
      id: "attach-image",
      label: "添加图片",
      run: () => semantic.openForm("attach-image"),
      shortcut: "I",
    });
    composerActions.push({
      disabled: composerDisabled,
      id: "attach-file",
      label: "添加文件",
      run: () => semantic.openForm("attach-file"),
      shortcut: "F",
    });
  }

  const form =
    semantic.formMode === "search"
      ? {
          actions: [
            {
              id: "cancel",
              label: "取消",
              run: semantic.closeForm,
            },
            {
              disabled: semantic.formValue.trim().length === 0,
              id: "submit",
              kind: "primary" as const,
              label: "搜索",
              run: async () => {
                await props.onSearchMessages?.(semantic.formValue.trim());
                semantic.closeForm();
              },
            },
          ],
          fields: [
            {
              id: "query",
              label: "关键词",
              onChange: semantic.setFormValue,
              placeholder: "搜索当前会话",
              value: semantic.formValue,
            },
          ],
          title: "搜索消息",
        }
      : semantic.formMode === "attach-file" ||
          semantic.formMode === "attach-image"
        ? {
            actions: [
              {
                id: "cancel",
                label: "取消",
                run: semantic.closeForm,
              },
              {
                disabled: !semantic.formValue.trim().startsWith("/"),
                id: "submit",
                kind: "primary" as const,
                label: "发送",
                run: async () => {
                  const kind =
                    semantic.formMode === "attach-image" ? "image" : "file";
                  await props.onAttachLocalPath?.({
                    kind,
                    path: semantic.formValue.trim(),
                  });
                  semantic.closeForm();
                },
              },
            ],
            fields: [
              {
                id: "path",
                label: "本地绝对路径",
                onChange: semantic.setFormValue,
                placeholder: "/Users/name/path/to/file",
                value: semantic.formValue,
              },
            ],
            title:
              semantic.formMode === "attach-image" ? "添加图片" : "添加文件",
          }
        : semantic.formMode === "create-channel" ||
            semantic.formMode === "edit-channel"
          ? {
              actions: [
                {
                  id: "cancel",
                  label: "取消",
                  run: semantic.closeForm,
                },
                {
                  disabled: !(semantic.formValues.name ?? "").trim(),
                  id: "submit",
                  kind: "primary" as const,
                  label:
                    semantic.formMode === "create-channel" ? "创建" : "保存",
                  run: async () => {
                    const input = {
                      name: (semantic.formValues.name ?? "").trim(),
                      visibility:
                        semantic.formValues.visibility === "private"
                          ? ("private" as const)
                          : ("public" as const),
                    };
                    if (semantic.formMode === "create-channel") {
                      await props.onCreateChannel?.(input);
                    } else if (currentChannel) {
                      await props.onUpdateChannel?.(currentChannel.id, input);
                    }
                    semantic.closeForm();
                  },
                },
              ],
              fields: [
                {
                  id: "channel-name",
                  label: "Channel 名称",
                  onChange: (value: string) =>
                    semantic.setFormField("name", value),
                  placeholder: "例如：研发",
                  value: semantic.formValues.name ?? "",
                },
                {
                  id: "visibility",
                  label: "可见范围",
                  onChange: (value: string) =>
                    semantic.setFormField("visibility", value),
                  options: [
                    { label: "公开", value: "public" },
                    { label: "私密", value: "private" },
                  ],
                  value: semantic.formValues.visibility ?? "public",
                },
              ],
              title:
                semantic.formMode === "create-channel"
                  ? "新建 Channel"
                  : `编辑 #${currentChannel?.name ?? "Channel"}`,
            }
          : semantic.formMode === "manage-channel-members" && currentChannel
            ? {
                actions: [
                  {
                    id: "close",
                    label: "完成",
                    run: semantic.closeForm,
                  },
                  ...(props.members ?? []).map((member) => {
                    const joined = (props.channelMembers ?? []).some(
                      (item) => item.id === member.id,
                    );
                    return {
                      id: `${joined ? "remove" : "add"}-${member.id}`,
                      label: `${joined ? "移除" : "添加"} ${member.displayName}`,
                      run: () =>
                        joined
                          ? props.onRemoveChannelMember?.(member.id)
                          : props.onAddChannelMember?.(member.id),
                    };
                  }),
                ],
                fields: [],
                title: `管理 #${currentChannel.name} 成员`,
              }
            : semantic.formMode === "new-direct"
              ? {
                  actions: [
                    {
                      id: "cancel",
                      label: "取消",
                      run: semantic.closeForm,
                    },
                    ...directCandidates.map((member) => ({
                      id: `direct-${member.id}`,
                      label: `${member.displayName} · @${member.handle}`,
                      run: async () => {
                        await props.onSelectDirect?.(member.imUserId!);
                        semantic.closeForm();
                      },
                    })),
                  ],
                  fields: [],
                  title: "新建私信",
                }
              : undefined;

  return {
    commands,
    composer: {
      actions: composerActions,
      disabled: composerDisabled,
      onChange: (value) =>
        props.onDraftChange?.({
          ...draft,
          document: createComposerTextDocument(value),
        }),
      onSend: async () => {
        const text = draftText.trim();
        if (!text || composerDisabled) return;
        if (threadActive) {
          await props.onSendThreadReply?.({mentionedUserIds: mentionIds, text});
        } else {
          await props.onSend(draft);
        }
      },
      placeholder: activeConversation
        ? `给 ${title} 发消息`
        : "请先选择 Channel 或私信",
      value: draftText,
    },
    conversations: [
      ...props.channels.map((channel) => ({
        id: channel.id,
        kind: "channel" as const,
        onSelect: () => props.onSelectChannel(channel.id),
        selected:
          activeConversation?.kind === "channel" &&
          activeConversation.channelId === channel.id,
        status: channel.joined ? "已加入" : "可加入",
        subtitle:
          channel.systemKey === "all"
            ? "全体成员根群"
            : channel.visibility === "public"
              ? "公开频道"
              : "私有频道",
        title: `# ${channel.name}`,
      })),
      ...(props.directConversations ?? []).map((conversation) => ({
        id: `direct-${conversation.peerUserId}`,
        kind: "direct" as const,
        onSelect: () => props.onSelectDirect?.(conversation.peerUserId),
        selected:
          activeConversation?.kind === "direct" &&
          activeConversation.peerUserId === conversation.peerUserId,
        subtitle: conversation.lastMessagePreview || "私信",
        title: `@ ${conversation.peerDisplayName}`,
        unreadCount: conversation.unreadCount,
      })),
    ],
    empty: searchActive
      ? {
          description: props.searchError ?? "换一个关键词再试。",
          title: props.searchingMessages ? "正在搜索" : "没有找到消息",
        }
      : activeConversation
        ? {
            description: "从这里和 Human、Agent 开始协作。",
            title: "还没有消息",
          }
        : { description: "从左侧选择 Channel 或私信。", title: "选择一个会话" },
    ...(props.error ? { error: props.error } : {}),
    ...(form ? { form } : {}),
    header: {
      eyebrow: `${currentServer?.name ?? "SERVER"} / CHAT`,
      summary: `${onlineAgents} 个 Agent 在线 · ${props.imStatus === "ready" ? "消息已连接" : "消息未连接"}`,
      title,
    },
    messages: displayedMessages.map((message) => {
      const actions: PresentationAction[] = [];
      if (searchActive) {
        actions.push({
          disabled: props.locatingSearchResultId === message.id,
          id: "locate",
          label:
            props.locatingSearchResultId === message.id
              ? "定位中"
              : "在会话中查看",
          run: () => props.onLocateSearchResult?.(message.id),
        });
      }
      if (message.delivery.state === "failed" && message.delivery.retryable) {
        actions.push({
          id: "retry",
          label: "重试",
          run: () => props.onRetryMessage?.(message.id),
        });
      }
      if (!searchActive && message.delivery.state === "sent") {
        if (
          message.direction === "outgoing" &&
          !message.id.startsWith("local:") &&
          message.rawType !== "TIMRevokedElem" &&
          props.onRevokeMessage
        ) {
          actions.push({
            id: "revoke",
            kind: "danger",
            label: "撤回",
            run: () => props.onRevokeMessage?.(message.id),
          });
        }
        actions.push({
          id: "quote",
          label: "引用",
          run: () => props.onQuoteMessage?.(message.id),
        });
        if (!threadActive && activeConversation?.kind === "channel") {
          actions.push({
            id: "thread",
            label: "话题",
            run: () => props.onOpenThread?.(message.id),
          });
          actions.push({
            id: "task",
            label: "生成任务",
            run: () => props.onCreateTaskFromMessage?.(message.id),
          });
        }
        actions.push({
          id: "reaction-like",
          label: "赞",
          run: () => props.onToggleReaction?.(message.id, "👍"),
        });
      }
      const delivery =
        message.delivery.state === "failed"
          ? "发送失败"
          : message.delivery.state === "sending"
            ? "发送中"
            : message.delivery.state === "uploading"
              ? `上传 ${message.delivery.progress}%`
              : "已发送";
      return {
        actions,
        id: message.id,
        meta: [formatConversationTimestamp(message.createdAt), delivery]
          .filter(Boolean)
          .join(" · "),
        sender: message.senderName,
        text: message.text || "[不支持的消息类型]",
      };
    }),
    shell: {
      accountLabel: account?.displayName,
      activeSection: "chat",
      navigation,
      onLogout: props.onLogout,
      serverName: currentServer?.name,
      serverOptions: props.servers.map((server) => ({
        id: server.id,
        label: server.name,
        onSelect: () => props.onSelectServer(server.id),
        selected: server.id === props.currentServerId,
      })),
    },
  };
}

export function WorkspaceShell(props: WorkspaceShellProps) {
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
      setFormValue(value);
      setFormValues(values);
      setFormMode(mode);
    },
    setFormField(id, value) {
      setFormValues((current) => ({ ...current, [id]: value }));
    },
    setFormValue,
  };
  return (
    <ConversationPresentation model={() => conversationPageModel(props, semantic)}>
      <GraphicalWorkspaceShell {...props} />
    </ConversationPresentation>
  );
}

function GraphicalWorkspaceShell({
  account = null,
  activeConversation: activeConversationProp,
  activeSection = "chat",
  activeThread = null,
  agents,
  canManageChannels = false,
  channelMembers = [],
  channels,
  conversationDrafts = {},
  conversationSummaries = [],
  channelHref,
  currentChannelId,
  currentImUserId,
  currentServerId,
  directConversations = [],
  directHref,
  directConversationSync = "idle",
  error,
  historyCompleted = true,
  initializingMessages = false,
  imStatus,
  imStatusMessage,
  loadingOlder = false,
  locatingSearchResultId = null,
  members = [],
  messageFocusRequest = null,
  messages,
  mentionMembers = [],
  onAddChannelMember = () => undefined,
  onAttachFile = () => null,
  onAttachImage = () => null,
  onClearMessageSearch = () => undefined,
  onClearQuote = () => undefined,
  onCloseThread = () => undefined,
  onCreateTaskFromMessage = () => undefined,
  onCreateChannel = () => null,
  onContinueOperation = () => undefined,
  onDraftChange = () => undefined,
  onLoadMoreSearchResults = () => undefined,
  onLocateSearchResult = () => undefined,
  onLoadMoreThreadReplies = () => undefined,
  onLoadOlder = () => undefined,
  onLogout,
  onNavigateSection = () => undefined,
  onOpenChannelManagement = () => undefined,
  onOpenThread = () => undefined,
  onRemoveChannelMember = () => undefined,
  onQuoteMessage = () => undefined,
  onReconnect,
  onRevokeMessage = () => undefined,
  onRetryMessage = () => undefined,
  onRetryThreadReplyIndex = () => undefined,
  onSearchMessages = () => undefined,
  onSelectChannel,
  onSelectDirect = () => undefined,
  onSelectServer,
  onSend,
  onSendThreadReply = () => undefined,
  onToggleReaction = () => undefined,
  onUpdateChannel = () => undefined,
  operations = [],
  pendingAction = null,
  pendingThreadIndexMessageIds = [],
  searchCompleted = true,
  searchError = null,
  searchLocateError = null,
  searchQuery = "",
  searchResults = [],
  searchingMessages = false,
  selectedQuote = null,
  sending = false,
  sendingThreadReply = false,
  serverAgents = agents,
  sectionHref,
  servers,
  serverHref,
  threadCompleted = true,
  threadLoading = false,
  threadMessages = [],
  threadRootMessage = null,
  viewportWidth,
}: WorkspaceShellProps) {
  const window = useWindowDimensions();
  const mode = workspaceLayoutMode(viewportWidth ?? window.width);
  const [conversationPickerOpen, setConversationPickerOpen] = useState(false);
  const [channelManagementMode, setChannelManagementMode] = useState<
    "create" | "edit" | "members" | null
  >(null);
  const [directPickerOpen, setDirectPickerOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  useEffect(() => {
    if (messageFocusRequest) setMessageSearchOpen(false);
  }, [messageFocusRequest]);
  const currentServer = servers.find((item) => item.id === currentServerId);
  const currentChannel = channels.find((item) => item.id === currentChannelId);
  const currentMember = members.find(
    (member) =>
      member.kind === "human" &&
      member.imUserId === (currentImUserId ?? account?.imUserId),
  );
  const activeConversation =
    activeConversationProp ??
    (currentChannelId
      ? ({ channelId: currentChannelId, kind: "channel" } as const)
      : null);
  const activeDraftKey = conversationDraftKey(activeConversation);
  const activeDraft = activeDraftKey
    ? (conversationDrafts[activeDraftKey] ?? emptyComposerDraft())
    : emptyComposerDraft();
  function changeMessageSearchOpen(open: boolean): void {
    setMessageSearchOpen(open);
    if (!open) onClearMessageSearch();
  }
  const activeDirectConversation =
    activeConversation?.kind === "direct"
      ? (directConversations.find(
          (item) => item.peerUserId === activeConversation.peerUserId,
        ) ?? {
          conversationId: "",
          directConversationId:
            activeConversation.directConversationId ??
            `draft:${activeConversation.peerMemberId}`,
          imGroupId: "",
          imState: "provisioning" as const,
          lastMessagePreview: "",
          peerDisplayName:
            members.find(
              (member) => member.imUserId === activeConversation.peerUserId,
            )?.displayName ?? activeConversation.peerUserId,
          peerUserId: activeConversation.peerUserId,
          peerMemberId: activeConversation.peerMemberId,
          unreadCount: 0,
        })
      : undefined;
  const activeDirectMember = activeDirectConversation
    ? memberByImUserId(members, activeDirectConversation.peerUserId)
    : undefined;
  const directCandidates = members.filter(
    (member) =>
      member.imState === "ready" &&
      Boolean(member.imUserId) &&
      member.imUserId !== currentImUserId &&
      !directConversations.some(
        (conversation) => conversation.peerUserId === member.imUserId,
      ),
  );
  const canJoinCurrentChannel =
    currentChannel !== undefined &&
    !currentChannel.joined &&
    currentChannel.systemKey !== "all" &&
    (currentChannel.visibility === "public" || canManageChannels) &&
    currentMember !== undefined;
  const joiningCurrentChannel = Boolean(
    currentChannel &&
      currentMember &&
      pendingAction ===
        `channel:${currentChannel.id}:member:${currentMember.id}:add`,
  );
  const joinCurrentChannel = canJoinCurrentChannel
    ? () => onAddChannelMember(currentMember.id)
    : undefined;

  if (mode === "compact") {
    return (
      <View style={styles.compactShell}>
        {channelManagementMode || directPickerOpen ? null : (
          <CompactHeader
            activeDirectConversation={activeDirectConversation}
            activeDirectMember={activeDirectMember}
            channelMemberCount={channelMembers.length}
            channel={currentChannel}
            imStatus={imStatus}
            navigationOpen={conversationPickerOpen}
            canSearch={
              activeConversation?.kind === "direct" ||
              currentChannel !== undefined
            }
            onOpenChannelMembers={async () => {
              await onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("members");
            }}
            onOpenNavigation={() =>
              setConversationPickerOpen((current) => !current)
            }
            onSearch={() => changeMessageSearchOpen(!messageSearchOpen)}
            searchOpen={messageSearchOpen}
            server={currentServer}
          />
        )}
        {channelManagementMode ? (
          <ChannelManagementPanel
            canManageMembers={canManageChannels}
            channel={currentChannel}
            channelMembers={channelMembers}
            compact
            currentImUserId={currentImUserId}
            disabled={pendingAction !== null}
            key={`${channelManagementMode}:${currentChannel?.id ?? "new"}`}
            members={members}
            mode={channelManagementMode}
            onAddMember={onAddChannelMember}
            onClose={() => setChannelManagementMode(null)}
            onCreate={onCreateChannel}
            onRemoveMember={onRemoveChannelMember}
            onUpdate={onUpdateChannel}
          />
        ) : conversationPickerOpen ? (
          <CompactConversationPicker
            account={account}
            activeConversation={activeConversation}
            canManageChannels={canManageChannels}
            channels={channels}
            channelHref={channelHref}
            conversationDrafts={conversationDrafts}
            conversationSummaries={conversationSummaries}
            currentChannel={currentChannel}
            currentChannelId={currentChannelId}
            currentServerId={currentServerId}
            directConversations={directConversations}
            directHref={directHref}
            directConversationSync={directConversationSync}
            directCandidates={directCandidates}
            imStatus={imStatus}
            members={members}
            onCreateChannel={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("create");
            }}
            onEditChannel={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("edit");
            }}
            onManageMembers={() => {
              void onOpenChannelManagement();
              setConversationPickerOpen(false);
              setChannelManagementMode("members");
            }}
            onLogout={onLogout}
            onNewDirect={() => {
              setConversationPickerOpen(false);
              setDirectPickerOpen(true);
            }}
            onSelectChannel={(channelId) => {
              setConversationPickerOpen(false);
              return onSelectChannel(channelId);
            }}
            onSelectDirect={(peerUserId) => {
              setConversationPickerOpen(false);
              return onSelectDirect(peerUserId);
            }}
            onSelectServer={onSelectServer}
            serverHref={serverHref}
            servers={servers}
          />
        ) : directPickerOpen ? (
          <DirectConversationPicker
            directHref={directHref}
            members={directCandidates}
            onClose={() => setDirectPickerOpen(false)}
            onNavigateMembers={() => {
              setDirectPickerOpen(false);
              onNavigateSection("members");
            }}
            onSelect={(peerUserId) => {
              setDirectPickerOpen(false);
              setConversationPickerOpen(false);
              return onSelectDirect(peerUserId);
            }}
          />
        ) : activeConversation?.kind === "channel" &&
          activeThread &&
          threadRootMessage ? (
          <ThreadPanel
            agents={agents}
            compact
            completed={threadCompleted}
            loading={threadLoading}
            messages={threadMessages}
            onClose={onCloseThread}
            onLoadMore={onLoadMoreThreadReplies}
            onRetryIndex={onRetryThreadReplyIndex}
            onSend={onSendThreadReply}
            pendingIndexMessageIds={pendingThreadIndexMessageIds}
            rootMessage={threadRootMessage}
            sending={sendingThreadReply}
            thread={activeThread}
          />
        ) : (
          <MessageStage
            agents={activeConversation?.kind === "direct" ? [] : agents}
            channel={currentChannel}
            compact
            directConversation={activeDirectConversation}
            directMember={activeDirectMember}
            draft={activeDraft}
            error={error}
            historyCompleted={historyCompleted}
            initializingMessages={initializingMessages}
            imStatus={imStatus}
            imStatusMessage={imStatusMessage}
            loadingOlder={loadingOlder}
            messages={messages}
            mentionMembers={
              activeConversation?.kind === "direct" ? [] : mentionMembers
            }
            messageFocusRequest={messageFocusRequest}
            onAttachFile={onAttachFile}
            onAttachImage={onAttachImage}
            onClearQuote={onClearQuote}
            onDraftChange={onDraftChange}
            onCreateTaskFromMessage={
              activeConversation?.kind === "direct"
                ? undefined
                : onCreateTaskFromMessage
            }
            onContinueOperation={onContinueOperation}
            onLoadMoreSearchResults={onLoadMoreSearchResults}
            onLocateSearchResult={onLocateSearchResult}
            onLoadOlder={onLoadOlder}
            channelMemberCount={channelMembers.length}
            joiningChannel={joiningCurrentChannel}
            onJoinChannel={joinCurrentChannel}
            onOpenChannelMembers={async () => {
              await onOpenChannelManagement();
              setChannelManagementMode("members");
            }}
            onOpenThread={
              activeConversation?.kind === "direct" ? undefined : onOpenThread
            }
            onQuoteMessage={onQuoteMessage}
            onReconnect={onReconnect}
            onRevokeMessage={onRevokeMessage}
            onRetryMessage={onRetryMessage}
            onSearchMessages={onSearchMessages}
            onSend={onSend}
            onToggleReaction={onToggleReaction}
            operations={operations}
            searchCompleted={searchCompleted}
            searchError={searchError}
            searchLocateError={searchLocateError}
            locatingSearchResultId={locatingSearchResultId}
            searchOpen={messageSearchOpen}
            searchQuery={searchQuery}
            searchResults={searchResults}
            searchingMessages={searchingMessages}
            onSearchOpenChange={changeMessageSearchOpen}
            selectedQuote={selectedQuote}
            sending={sending}
            viewportWidth={viewportWidth}
          />
        )}
        {messageSearchOpen ? null : (
          <MobileBottomNavigation
            activeSection={activeSection}
            canManageServer={
              currentMember?.role === "owner" || currentMember?.role === "admin"
            }
            navigationOpen={conversationPickerOpen}
            onNavigateSection={onNavigateSection}
            onToggle={() =>
              channelManagementMode
                ? setChannelManagementMode(null)
                : setConversationPickerOpen((current) => !current)
            }
            sectionHref={sectionHref}
          />
        )}
      </View>
    );
  }

  return (
    <View style={styles.shell} testID="workspace-shell">
      <ServerRail
        account={account}
        activeSection={activeSection}
        canManageServer={
          currentMember?.role === "owner" || currentMember?.role === "admin"
        }
        currentServerId={currentServerId}
        imStatus={imStatus}
        onNavigateSection={onNavigateSection}
        onLogout={onLogout}
        onSelectServer={onSelectServer}
        sectionHref={sectionHref}
        serverHref={serverHref}
        servers={servers}
      />
      <ConversationSidebar
        activeConversation={activeConversation}
        agents={serverAgents}
        canManageChannels={canManageChannels}
        channels={channels}
        channelHref={channelHref}
        conversationDrafts={conversationDrafts}
        conversationSummaries={conversationSummaries}
        currentChannelId={currentChannelId}
        currentServer={currentServer}
        currentServerHref={
          currentServer ? serverHref?.(currentServer) : undefined
        }
        directConversations={directConversations}
        directHref={directHref}
        directConversationSync={directConversationSync}
        directPickerOpen={directPickerOpen}
        directCandidates={directCandidates}
        members={members}
        memberCount={members.length}
        onCreateChannel={() => {
          void onOpenChannelManagement();
          setChannelManagementMode("create");
        }}
        onEditChannel={() => {
          void onOpenChannelManagement();
          setChannelManagementMode("edit");
        }}
        onManageMembers={() => {
          void onOpenChannelManagement();
          setChannelManagementMode("members");
        }}
        onNavigateMembers={() => {
          setDirectPickerOpen(false);
          onNavigateSection("members");
        }}
        onNewDirect={() => setDirectPickerOpen((current) => !current)}
        onSelectChannel={onSelectChannel}
        onSelectDirect={(peerUserId) => {
          setDirectPickerOpen(false);
          return onSelectDirect(peerUserId);
        }}
        onSelectServer={() => {
          if (currentServer) return onSelectServer(currentServer.id);
          return undefined;
        }}
      />
      <MessageStage
        agents={activeConversation?.kind === "direct" ? [] : agents}
        channel={currentChannel}
        directConversation={activeDirectConversation}
        directMember={activeDirectMember}
        draft={activeDraft}
        error={error}
        historyCompleted={historyCompleted}
        initializingMessages={initializingMessages}
        imStatus={imStatus}
        imStatusMessage={imStatusMessage}
        loadingOlder={loadingOlder}
        messages={messages}
        mentionMembers={
          activeConversation?.kind === "direct" ? [] : mentionMembers
        }
        messageFocusRequest={messageFocusRequest}
        onAttachFile={onAttachFile}
        onAttachImage={onAttachImage}
        onClearQuote={onClearQuote}
        onDraftChange={onDraftChange}
        onCreateTaskFromMessage={
          activeConversation?.kind === "direct"
            ? undefined
            : onCreateTaskFromMessage
        }
        onContinueOperation={onContinueOperation}
        onLoadMoreSearchResults={onLoadMoreSearchResults}
        onLocateSearchResult={onLocateSearchResult}
        onLoadOlder={onLoadOlder}
        channelMemberCount={channelMembers.length}
        joiningChannel={joiningCurrentChannel}
        onJoinChannel={joinCurrentChannel}
        onOpenChannelMembers={async () => {
          await onOpenChannelManagement();
          setChannelManagementMode("members");
        }}
        onOpenThread={
          activeConversation?.kind === "direct" ? undefined : onOpenThread
        }
        onQuoteMessage={onQuoteMessage}
        onReconnect={onReconnect}
        onRevokeMessage={onRevokeMessage}
        onRetryMessage={onRetryMessage}
        onSearchMessages={onSearchMessages}
        onSend={onSend}
        onToggleReaction={onToggleReaction}
        operations={operations}
        searchCompleted={searchCompleted}
        searchError={searchError}
        searchLocateError={searchLocateError}
        locatingSearchResultId={locatingSearchResultId}
        searchOpen={messageSearchOpen}
        searchQuery={searchQuery}
        searchResults={searchResults}
        searchingMessages={searchingMessages}
        onSearchOpenChange={changeMessageSearchOpen}
        selectedQuote={selectedQuote}
        sending={sending}
        viewportWidth={viewportWidth}
      />
      {activeConversation?.kind === "channel" &&
      activeThread &&
      threadRootMessage ? (
        <ThreadPanel
          agents={agents}
          completed={threadCompleted}
          loading={threadLoading}
          messages={threadMessages}
          onClose={onCloseThread}
          onLoadMore={onLoadMoreThreadReplies}
          onRetryIndex={onRetryThreadReplyIndex}
          onSend={onSendThreadReply}
          pendingIndexMessageIds={pendingThreadIndexMessageIds}
          rootMessage={threadRootMessage}
          sending={sendingThreadReply}
          thread={activeThread}
        />
      ) : null}
      {channelManagementMode ? (
        <ChannelManagementPanel
          canManageMembers={canManageChannels}
          channel={currentChannel}
          channelMembers={channelMembers}
          currentImUserId={currentImUserId}
          disabled={pendingAction !== null}
          key={`${channelManagementMode}:${currentChannel?.id ?? "new"}`}
          members={members}
          mode={channelManagementMode}
          onAddMember={onAddChannelMember}
          onClose={() => setChannelManagementMode(null)}
          onCreate={onCreateChannel}
          onRemoveMember={onRemoveChannelMember}
          onUpdate={onUpdateChannel}
        />
      ) : null}
    </View>
  );
}

function ServerRail({
  account,
  activeSection,
  canManageServer,
  currentServerId,
  imStatus,
  onNavigateSection,
  onLogout,
  onSelectServer,
  sectionHref,
  serverHref,
  servers,
}: Pick<
  WorkspaceShellProps,
  | "account"
  | "activeSection"
  | "currentServerId"
  | "onNavigateSection"
  | "onLogout"
  | "onSelectServer"
  | "sectionHref"
  | "serverHref"
  | "servers"
> & {
  canManageServer: boolean;
  imStatus?: WorkspaceImStatus;
}) {
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <View style={styles.serverRail} testID="server-rail">
      <View accessibilityLabel="Vela" style={styles.railBrand}>
        <BrandMark compact />
      </View>
      {servers.length > 1 ? (
        <ScrollView
          contentContainerStyle={styles.serverMarks}
          showsVerticalScrollIndicator={false}
          style={styles.serverMarksScroller}
          testID="server-marks"
        >
          {servers.map((server) => {
            const selected = server.id === currentServerId;
            const href = serverHref?.(server);
            return (
              <MaybeLink href={href} key={server.id}>
                <Pressable
                  accessibilityLabel={`打开 Server ${server.name}`}
                  accessibilityRole={href ? "link" : "button"}
                  accessibilityState={{ selected }}
                  onPress={href ? undefined : () => onSelectServer(server.id)}
                  style={({ pressed }) => [
                    styles.serverMark,
                    selected && styles.serverMarkSelected,
                    pressed && styles.railItemPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.serverMarkText,
                      selected && styles.serverMarkTextSelected,
                    ]}
                  >
                    {server.name.slice(0, 1).toUpperCase()}
                  </Text>
                </Pressable>
              </MaybeLink>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={styles.railNavigation} testID="rail-navigation">
        {visibleSectionNavigation(canManageServer).map((item) => {
          const selected = item.id === activeSection;
          const href = sectionHref?.(item.id);
          return (
            <RailSectionNavigationItem
              href={href}
              item={item}
              key={item.id}
              onPress={() => onNavigateSection?.(item.id)}
              selected={selected}
            />
          );
        })}
      </View>
      <View style={styles.railSpacer} />
      <View style={styles.railFooter}>
        {account ? (
          <>
            <Pressable
              accessibilityLabel={`打开当前账号 ${account.displayName}`}
              accessibilityRole="button"
              accessibilityState={{ expanded: accountOpen }}
              onPress={() => setAccountOpen((current) => !current)}
              style={({ pressed }) => [
                styles.accountRailButton,
                accountOpen && styles.accountRailButtonActive,
                pressed && styles.railItemPressed,
              ]}
              testID="rail-account"
            >
              <HumanAvatar account={account} imStatus={imStatus} />
            </Pressable>
            {accountOpen ? (
              <View style={styles.accountPopover} testID="account-popover">
                <HumanAccountIdentity account={account} imStatus={imStatus} />
                {account.imUserId ? (
                  <View style={styles.accountIdPanel}>
                    <Text style={styles.accountIdLabel}>IM USER ID</Text>
                    <Text numberOfLines={1} style={styles.accountIdValue}>
                      {account.imUserId}
                    </Text>
                  </View>
                ) : null}
                {onLogout ? (
                  <Pressable
                    accessibilityLabel="退出当前账号"
                    accessibilityRole="button"
                    onPress={onLogout}
                    style={({ pressed }) => [
                      styles.accountLogoutButton,
                      pressed && styles.railItemPressed,
                    ]}
                  >
                    <LogOut
                      color={velaTheme.semantic.color.iconMuted}
                      size={velaTheme.semantic.icon.size.small}
                      strokeWidth={velaTheme.semantic.icon.stroke.regular}
                    />
                    <Text style={styles.accountLogoutText}>退出当前账号</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </>
        ) : onLogout ? (
          <Pressable
            accessibilityLabel="退出当前账号"
            accessibilityRole="button"
            onPress={onLogout}
            style={({ pressed }) => [
              styles.railNavigationButton,
              pressed && styles.railItemPressed,
            ]}
          >
            <LogOut
              color={velaTheme.semantic.color.iconMuted}
              size={velaTheme.semantic.icon.size.medium}
              strokeWidth={velaTheme.semantic.icon.stroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function RailSectionNavigationItem({
  href,
  item,
  onPress,
  selected,
}: {
  href: string | undefined;
  item: (typeof sectionNavigation)[number];
  onPress: () => void;
  selected: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const labelVisible = focused || hovered;
  const NavigationIcon = item.icon;

  return (
    <View style={styles.railNavigationItem}>
      <MaybeLink href={href}>
        <Pressable
          accessibilityLabel={item.accessibilityLabel}
          accessibilityRole={href ? "link" : "button"}
          accessibilityState={{ selected }}
          onBlur={() => setFocused(false)}
          onFocus={() => setFocused(true)}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={href ? undefined : onPress}
          style={({ pressed }) => [
            styles.railNavigationButton,
            selected && styles.railNavigationActive,
            labelVisible && !selected && styles.railNavigationHovered,
            pressed && styles.railItemPressed,
          ]}
          testID={`rail-section-${item.id}`}
        >
          <View testID={`rail-icon-${item.id}`}>
            <NavigationIcon
              color={
                selected
                  ? velaTheme.semantic.color.iconAccent
                  : velaTheme.semantic.color.iconMuted
              }
              size={velaTheme.semantic.icon.size.feature}
              strokeWidth={selected ? velaTheme.semantic.icon.stroke.strong : velaTheme.semantic.icon.stroke.regular}
            />
          </View>
        </Pressable>
      </MaybeLink>
      {labelVisible ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.railTooltip}
          testID={`rail-tooltip-${item.id}`}
        >
          <Text style={styles.railTooltipText}>{item.label}</Text>
        </View>
      ) : null}
    </View>
  );
}

function accountImPresentation(
  account: Account,
  imStatus: WorkspaceImStatus | undefined,
): { label: string; tone: "connecting" | "error" | "ready" } {
  if (
    account.imState === "error" ||
    imStatus === "error" ||
    imStatus === "kicked_out" ||
    imStatus === "not_ready"
  ) {
    return { label: "IM 未连接", tone: "error" };
  }
  if (account.imState === "ready" && imStatus === "ready") {
    return { label: "IM 已连接", tone: "ready" };
  }
  return { label: "IM 连接中", tone: "connecting" };
}

function HumanAvatar({
  account,
  imStatus,
}: {
  account: Account;
  imStatus?: WorkspaceImStatus;
}) {
  const status = accountImPresentation(account, imStatus);
  const initial =
    account.displayName.trim().slice(0, 1) ||
    account.email.trim().slice(0, 1).toUpperCase() ||
    "人";
  return (
    <View style={styles.humanAvatar}>
      <Text style={styles.humanAvatarText}>{initial}</Text>
      <View
        style={[
          styles.humanAvatarStatus,
          status.tone === "ready" && styles.humanAvatarStatusReady,
          status.tone === "error" && styles.humanAvatarStatusError,
        ]}
      />
    </View>
  );
}

function HumanAccountIdentity({
  account,
  imStatus,
}: {
  account: Account;
  imStatus?: WorkspaceImStatus;
}) {
  const status = accountImPresentation(account, imStatus);
  return (
    <View style={styles.accountIdentity}>
      <HumanAvatar account={account} imStatus={imStatus} />
      <View style={styles.accountIdentityCopy}>
        <Text numberOfLines={1} style={styles.accountDisplayName}>
          {account.displayName}
        </Text>
        <Text numberOfLines={1} style={styles.accountEmail}>
          {account.email}
        </Text>
        <View style={styles.accountStatusRow}>
          <View
            style={[
              styles.accountStatusDot,
              status.tone === "ready" && styles.accountStatusDotReady,
              status.tone === "error" && styles.accountStatusDotError,
            ]}
          />
          <Text style={styles.accountStatusText}>{status.label}</Text>
        </View>
      </View>
    </View>
  );
}

function ConversationSidebar({
  activeConversation,
  agents,
  canManageChannels,
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannelId,
  currentServer,
  currentServerHref,
  directCandidates,
  directConversations,
  directHref,
  directConversationSync,
  directPickerOpen,
  members,
  memberCount,
  onCreateChannel,
  onEditChannel,
  onManageMembers,
  onNavigateMembers,
  onNewDirect,
  onSelectChannel,
  onSelectDirect,
  onSelectServer,
}: {
  activeConversation: ActiveConversation | null;
  agents: Agent[];
  canManageChannels: boolean;
  channelHref?: WorkspaceShellProps["channelHref"];
  channels: Channel[];
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  currentChannelId: string | null;
  currentServer: Server | undefined;
  currentServerHref?: string;
  directCandidates: Member[];
  directConversations: DirectConversation[];
  directHref?: WorkspaceShellProps["directHref"];
  directConversationSync: "complete" | "idle" | "pending";
  directPickerOpen: boolean;
  members: Member[];
  memberCount: number;
  onCreateChannel(): void;
  onEditChannel(): void;
  onManageMembers(): void;
  onNavigateMembers(): void;
  onNewDirect(): void;
  onSelectChannel(channelId: string): void | Promise<void>;
  onSelectDirect(peerUserId: string): void | Promise<void>;
  onSelectServer(): void | Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const currentChannel = channels.find((item) => item.id === currentChannelId);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleChannels = normalizedFilter
    ? channels.filter((channel) =>
        [
          channel.name,
          channel.description ?? "",
          channelConversationSummary(channel, conversationSummaries)
            ?.lastMessagePreview ?? "",
          composerDraftPreview(conversationDrafts[`channel:${channel.id}`]),
        ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
      )
    : channels;
  const visibleDirectConversations = normalizedFilter
    ? directConversations.filter((conversation) =>
        [
          conversation.peerDisplayName,
          memberIdentityLabel(
            memberByImUserId(members, conversation.peerUserId),
          ) ?? "",
          conversation.lastMessagePreview,
          composerDraftPreview(
            conversationDrafts[`direct:${conversation.peerMemberId}`],
          ),
        ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
      )
    : directConversations;
  const visibleMembers = normalizedFilter
    ? directCandidates.filter((member) =>
        [member.displayName, member.handle].some((value) =>
          value.toLocaleLowerCase().includes(normalizedFilter),
        ),
      )
    : directCandidates;
  const hasSearchMatches =
    visibleChannels.length > 0 ||
    visibleDirectConversations.length > 0 ||
    visibleMembers.length > 0;
  return (
    <View style={styles.conversationSidebar} testID="conversation-sidebar">
      <MaybeLink href={currentServerHref}>
        <Pressable
          accessibilityLabel={
            currentServer ? `打开 Server ${currentServer.name}` : "选择 Server"
          }
          accessibilityRole={currentServerHref ? "link" : "button"}
          disabled={!currentServer}
          onPress={currentServerHref ? undefined : onSelectServer}
          style={styles.sidebarHeader}
        >
          <View style={styles.sidebarHeaderIcon}>
            <Text style={styles.sidebarHeaderIconText}>
              {(currentServer?.name ?? "S").slice(0, 2).toUpperCase()}
            </Text>
          </View>
          <View style={styles.sidebarHeaderCopy}>
            <Text numberOfLines={1} style={styles.sidebarTitle}>
              {currentServer?.name ?? "选择 Server"}
            </Text>
            <Text numberOfLines={1} style={styles.sidebarSubtitle}>
              {memberCount} 位成员 · {agents.length} 个 Agent
            </Text>
          </View>
          <Ellipsis
            color={velaTheme.semantic.color.iconMuted}
            size={velaTheme.semantic.icon.size.small}
            strokeWidth={velaTheme.semantic.icon.stroke.regular}
          />
        </Pressable>
      </MaybeLink>
      {!directPickerOpen ? (
        <View style={styles.sidebarSearchWrap}>
          <Search
            color={velaTheme.semantic.color.iconMuted}
            size={velaTheme.semantic.icon.size.compact}
            strokeWidth={velaTheme.semantic.icon.stroke.regular}
          />
          <TextInput
            accessibilityLabel="搜索频道、私信与成员"
            onChangeText={setFilter}
            placeholder="搜索频道、私信与成员"
            placeholderTextColor={velaTheme.semantic.color.fieldPlaceholder}
            style={styles.sidebarSearchInput}
            value={filter}
          />
          {normalizedFilter ? (
            <Pressable
              accessibilityLabel="清除会话搜索"
              accessibilityRole="button"
              hitSlop={velaTheme.semantic.interaction.hitTargetInset}
              onPress={() => setFilter("")}
              style={styles.sidebarSearchClear}
            >
              <X
                color={velaTheme.semantic.color.iconMuted}
                size={velaTheme.semantic.icon.size.compact}
                strokeWidth={velaTheme.semantic.icon.stroke.regular}
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!directPickerOpen &&
      (!normalizedFilter || visibleChannels.length > 0) ? (
        <>
          <View style={styles.sidebarSectionHeader}>
            <Text style={styles.sectionLabel}>频道</Text>
            <View style={styles.sidebarSectionActions}>
              <Text style={styles.sidebarCount}>{visibleChannels.length}</Text>
              {!normalizedFilter && canManageChannels ? (
                <>
                  <IconActionButton
                    accessibilityLabel="新建 Channel"
                    icon={Plus}
                    onPress={onCreateChannel}
                    testID="channel-create-action"
                  />
                  {currentChannel?.systemKey !== "all" && currentChannel ? (
                    <IconActionButton
                      accessibilityLabel={`编辑 Channel ${currentChannel.name}`}
                      icon={Pencil}
                      onPress={onEditChannel}
                      testID="channel-edit-action"
                    />
                  ) : null}
                  {currentChannel && currentChannel.systemKey !== "all" ? (
                    <IconActionButton
                      accessibilityLabel={`管理 Channel ${currentChannel.name} 的成员`}
                      icon={UsersRound}
                      onPress={onManageMembers}
                    />
                  ) : null}
                </>
              ) : null}
            </View>
          </View>
          <ChannelList
            channelHref={channelHref}
            channels={visibleChannels}
            conversationDrafts={conversationDrafts}
            conversationSummaries={conversationSummaries}
            currentChannelId={currentChannelId}
            onSelectChannel={onSelectChannel}
          />
        </>
      ) : null}
      {!directPickerOpen &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.sidebarSectionHeader}>
          <Text style={styles.sectionLabel}>私信</Text>
          {!normalizedFilter ? (
            <IconActionButton
              accessibilityLabel="新建私信"
              icon={Plus}
              onPress={onNewDirect}
            />
          ) : null}
        </View>
      ) : null}
      {directPickerOpen ? (
        <DirectConversationPicker
          directHref={directHref}
          embedded
          members={directCandidates}
          onClose={onNewDirect}
          onNavigateMembers={onNavigateMembers}
          onSelect={onSelectDirect}
        />
      ) : (
        <>
          {!normalizedFilter || visibleDirectConversations.length > 0 ? (
            <DirectConversationList
              activeConversation={activeConversation}
              conversations={visibleDirectConversations}
              conversationDrafts={conversationDrafts}
              directHref={directHref}
              emptyLabel="还没有私信。"
              members={members}
              onSelect={onSelectDirect}
            />
          ) : null}
          {normalizedFilter && visibleMembers.length > 0 ? (
            <>
              <View style={styles.sidebarSectionHeader}>
                <Text style={styles.sectionLabel}>成员</Text>
                <Text style={styles.sidebarCount}>{visibleMembers.length}</Text>
              </View>
              <DirectMemberList
                directHref={directHref}
                members={visibleMembers}
                onSelect={(peerUserId) => {
                  setFilter("");
                  return onSelectDirect(peerUserId);
                }}
              />
            </>
          ) : null}
          {normalizedFilter && !hasSearchMatches ? (
            <View style={styles.sidebarSearchEmpty}>
              <Text style={styles.compactDirectorySearchEmptyTitle}>
                没有匹配的会话。
              </Text>
              <Text style={styles.channelMeta}>换个关键词试试。</Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function DirectConversationList({
  activeConversation,
  conversations,
  conversationDrafts,
  directHref,
  emptyLabel,
  members,
  onSelect,
}: {
  activeConversation: ActiveConversation | null;
  conversations: DirectConversation[];
  conversationDrafts: Record<string, ComposerDraft>;
  directHref?: WorkspaceShellProps["directHref"];
  emptyLabel: string;
  members: Member[];
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.directList}
      style={styles.directScroller}
    >
      {conversations.length === 0 ? (
        <Text style={[styles.empty, styles.directEmpty]}>{emptyLabel}</Text>
      ) : null}
      {conversations.map((conversation) => {
        const selected =
          activeConversation?.kind === "direct" &&
          activeConversation.peerUserId === conversation.peerUserId;
        const href = directHref?.(conversation.peerUserId);
        const lastMessageTime = conversation.lastMessageAt
          ? formatConversationTimestamp(conversation.lastMessageAt)
          : "";
        const draftPreview = composerDraftPreview(
          conversationDrafts[`direct:${conversation.peerMemberId}`],
        );
        const directMember = memberByImUserId(members, conversation.peerUserId);
        const identityLabel = memberIdentityLabel(directMember);
        const identitySummary = directIdentitySummary(directMember);
        return (
          <MaybeLink href={href} key={conversation.conversationId}>
            <Pressable
              accessibilityLabel={`打开私信 ${conversation.peerDisplayName}${identityLabel ? ` ${identityLabel}` : ""}`}
              accessibilityRole={href ? "link" : "button"}
              accessibilityState={{ selected }}
              onPress={
                href ? undefined : () => onSelect(conversation.peerUserId)
              }
              style={
                selected ? styles.directButtonSelected : styles.directButton
              }
            >
              <View style={styles.directAvatar}>
                <Text style={styles.directAvatarText}>
                  {conversation.peerDisplayName.slice(0, 1)}
                </Text>
              </View>
              <View style={styles.channelButtonCopy}>
                <View style={styles.directHeader}>
                  <Text
                    numberOfLines={1}
                    style={[styles.channelName, styles.directDisplayName]}
                  >
                    {conversation.peerDisplayName}
                  </Text>
                  {identitySummary ? (
                    <Text numberOfLines={1} style={styles.directHandle}>
                      {identitySummary}
                    </Text>
                  ) : null}
                  {lastMessageTime ? (
                    <Text style={styles.directTime}>{lastMessageTime}</Text>
                  ) : null}
                </View>
                <View style={styles.directFooter}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.channelMeta,
                      styles.directPreview,
                      draftPreview ? styles.draftMeta : null,
                    ]}
                  >
                    {draftPreview
                      ? `[草稿] ${draftPreview}`
                      : conversation.lastMessagePreview || "开始私信"}
                  </Text>
                  {conversation.unreadCount > 0 ? (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadBadgeText}>
                        {conversation.unreadCount > 99
                          ? "99+"
                          : conversation.unreadCount}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          </MaybeLink>
        );
      })}
    </ScrollView>
  );
}

function DirectMemberList({
  directHref,
  members,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  members: Member[];
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.directList}
      style={styles.directScroller}
    >
      {members.map((member) => (
        <DirectMemberRow
          directHref={directHref}
          key={member.id}
          member={member}
          onSelect={onSelect}
        />
      ))}
    </ScrollView>
  );
}

function DirectMemberRow({
  directHref,
  member,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  member: Member;
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  const href = member.imUserId ? directHref?.(member.imUserId) : undefined;
  const identityLabel = memberIdentityLabel(member);
  return (
    <MaybeLink href={href}>
      <Pressable
        accessibilityLabel={`私信 ${member.displayName}${identityLabel ? ` ${identityLabel}` : ""}`}
        accessibilityRole={href ? "link" : "button"}
        onPress={
          href ? undefined : () => member.imUserId && onSelect(member.imUserId)
        }
        style={styles.directButton}
      >
        <View style={styles.directAvatar}>
          <Text style={styles.directAvatarText}>
            {member.displayName.slice(0, 1)}
          </Text>
        </View>
        <View style={styles.channelButtonCopy}>
          <Text style={styles.channelName}>{member.displayName}</Text>
          <Text style={styles.channelMeta}>
            {identityLabel ? `${identityLabel} · ` : ""}
            {member.kind === "agent" ? "Agent" : "自然人"}
          </Text>
        </View>
      </Pressable>
    </MaybeLink>
  );
}

function ChannelList({
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannelId,
  emptyLabel = "这个 Server 还没有 Channel。",
  onSelectChannel,
}: Pick<
  WorkspaceShellProps,
  "channelHref" | "channels" | "currentChannelId" | "onSelectChannel"
> & {
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  emptyLabel?: string;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.channelList}
      style={styles.channelScroller}
      testID="channel-scroller"
    >
      {channels.length === 0 ? (
        <Text style={styles.empty}>{emptyLabel}</Text>
      ) : null}
      {channels.map((channel) => {
        const selected = channel.id === currentChannelId;
        const href = channelHref?.(channel);
        const draftPreview = composerDraftPreview(
          conversationDrafts[`channel:${channel.id}`],
        );
        const summary = channelConversationSummary(
          channel,
          conversationSummaries,
        );
        const lastMessageTime = summary?.lastMessageAt
          ? formatConversationTimestamp(summary.lastMessageAt)
          : "";
        return (
          <MaybeLink href={href} key={channel.id}>
            <Pressable
              accessibilityLabel={`打开 Channel ${channel.name}`}
              accessibilityRole={href ? "link" : "button"}
              accessibilityState={{ selected }}
              onPress={href ? undefined : () => onSelectChannel(channel.id)}
              style={
                selected ? styles.channelButtonSelected : styles.channelButton
              }
              testID={`channel-row-${channel.id}`}
            >
              <View
                style={[
                  styles.channelIcon,
                  selected && styles.channelIconSelected,
                ]}
              >
                <Hash
                  color={
                    selected
                      ? velaTheme.semantic.color.iconAccent
                      : velaTheme.semantic.color.iconMuted
                  }
                  size={velaTheme.semantic.icon.size.compact}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
              </View>
              <View style={styles.channelButtonCopy}>
                <View style={styles.directHeader}>
                  <View style={styles.channelNameRow}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.channelName,
                        styles.channelNameInRow,
                        selected && styles.channelNameSelected,
                      ]}
                    >
                      {channel.name}
                    </Text>
                    <ChannelKindBadge channel={channel} />
                  </View>
                  {lastMessageTime ? (
                    <Text style={styles.directTime}>{lastMessageTime}</Text>
                  ) : null}
                </View>
                <View style={styles.directFooter}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.channelMeta,
                      styles.directPreview,
                      draftPreview ? styles.draftMeta : null,
                    ]}
                  >
                    {draftPreview
                      ? `[草稿] ${draftPreview}`
                      : !channel.joined
                        ? channel.visibility === "public"
                          ? "公开频道 · 可加入"
                          : "私密频道 · 尚未加入"
                        : summary?.lastMessagePreview ||
                          channel.description ||
                          (channel.systemKey === "all"
                            ? "全体成员根群"
                            : "Human 与 Agent 的日常协作")}
                  </Text>
                  {!selected && (summary?.unreadCount ?? 0) > 0 ? (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadBadgeText}>
                        {(summary?.unreadCount ?? 0) > 99
                          ? "99+"
                          : summary?.unreadCount}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          </MaybeLink>
        );
      })}
    </ScrollView>
  );
}

function ChannelKindBadge({ channel }: { channel: Channel }) {
  const label =
    channel.systemKey === "all"
      ? "系统"
      : channel.visibility === "private"
        ? "私密"
        : "公开";
  return (
    <View
      accessibilityLabel={channelKindLongLabel(channel)}
      style={[
        styles.channelKindBadge,
        channel.visibility === "private" && styles.channelKindBadgePrivate,
        channel.systemKey === "all" && styles.channelKindBadgeSystem,
      ]}
    >
      <Text style={styles.channelKindBadgeText}>{label}</Text>
    </View>
  );
}

function channelKindLongLabel(channel: Channel): string {
  if (channel.systemKey === "all") return "所有成员自动加入";
  return channel.visibility === "private" ? "私密频道" : "公开频道";
}

function ChatActionErrorToast({
  compact,
  message,
}: {
  compact: boolean;
  message: string;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(
      () => setVisible(false),
      velaTheme.semantic.motion.dismissal.toast,
    );
    return () => clearTimeout(timer);
  }, [message]);

  if (!visible) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.chatErrorToastLayer,
        compact && styles.chatErrorToastLayerCompact,
      ]}
    >
      <View
        accessibilityRole="alert"
        style={styles.chatErrorToast}
        testID="chat-error-toast"
      >
        <View style={styles.chatErrorToastIcon}>
          <CircleAlert
            color={velaTheme.semantic.color.statusDanger}
            size={velaTheme.semantic.icon.size.medium}
            strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
          />
        </View>
        <Text numberOfLines={3} style={styles.chatErrorToastText}>
          {message}
        </Text>
        <Pressable
          accessibilityLabel="关闭错误提示"
          accessibilityRole="button"
          onPress={() => setVisible(false)}
          style={styles.chatErrorToastClose}
        >
          <X
            color={velaTheme.semantic.color.iconMuted}
            size={velaTheme.semantic.icon.size.small}
            strokeWidth={velaTheme.semantic.icon.stroke.regular}
          />
        </Pressable>
      </View>
    </View>
  );
}

function MessageStage({
  agents,
  channel,
  channelMemberCount,
  compact = false,
  directConversation,
  directMember,
  draft,
  error,
  historyCompleted,
  initializingMessages,
  imStatus,
  imStatusMessage,
  loadingOlder,
  joiningChannel,
  locatingSearchResultId,
  messages,
  mentionMembers = [],
  messageFocusRequest,
  onAttachFile,
  onAttachImage,
  onClearQuote,
  onDraftChange,
  onCreateTaskFromMessage,
  onContinueOperation,
  onLoadMoreSearchResults,
  onLocateSearchResult,
  onLoadOlder,
  onJoinChannel,
  onOpenChannelMembers,
  onOpenThread,
  onQuoteMessage,
  onReconnect,
  onRevokeMessage,
  onRetryMessage,
  onSearchMessages,
  onSearchOpenChange,
  onSend,
  onToggleReaction,
  operations,
  searchCompleted,
  searchError,
  searchLocateError,
  searchOpen,
  searchQuery,
  searchResults,
  searchingMessages,
  selectedQuote,
  sending,
  viewportWidth,
}: {
  agents: Agent[];
  channel: Channel | undefined;
  channelMemberCount: number;
  compact?: boolean;
  directConversation?: DirectConversation;
  directMember?: Member;
  draft: ComposerDraft;
  error?: string | null;
  historyCompleted: boolean;
  initializingMessages: boolean;
  imStatus: WorkspaceImStatus;
  imStatusMessage?: string;
  loadingOlder: boolean;
  joiningChannel: boolean;
  locatingSearchResultId: string | null;
  messages: Message[];
  mentionMembers?: MentionableMember[];
  messageFocusRequest: { messageId: string; revision: number } | null;
  onAttachFile: NonNullable<WorkspaceShellProps["onAttachFile"]>;
  onAttachImage: NonNullable<WorkspaceShellProps["onAttachImage"]>;
  onClearQuote: NonNullable<WorkspaceShellProps["onClearQuote"]>;
  onDraftChange: NonNullable<WorkspaceShellProps["onDraftChange"]>;
  onCreateTaskFromMessage?: WorkspaceShellProps["onCreateTaskFromMessage"];
  onContinueOperation: NonNullable<WorkspaceShellProps["onContinueOperation"]>;
  onLoadMoreSearchResults: NonNullable<
    WorkspaceShellProps["onLoadMoreSearchResults"]
  >;
  onLocateSearchResult: NonNullable<
    WorkspaceShellProps["onLocateSearchResult"]
  >;
  onLoadOlder: NonNullable<WorkspaceShellProps["onLoadOlder"]>;
  onJoinChannel?: () => void | Promise<void>;
  onOpenChannelMembers(): void | Promise<void>;
  onOpenThread?: WorkspaceShellProps["onOpenThread"];
  onQuoteMessage: NonNullable<WorkspaceShellProps["onQuoteMessage"]>;
  onReconnect?: WorkspaceShellProps["onReconnect"];
  onRevokeMessage: NonNullable<WorkspaceShellProps["onRevokeMessage"]>;
  onRetryMessage: NonNullable<WorkspaceShellProps["onRetryMessage"]>;
  onSearchMessages: NonNullable<WorkspaceShellProps["onSearchMessages"]>;
  onSearchOpenChange(open: boolean): void;
  onSend: WorkspaceShellProps["onSend"];
  onToggleReaction: NonNullable<WorkspaceShellProps["onToggleReaction"]>;
  operations: OperationStatusItem[];
  searchCompleted: boolean;
  searchError: string | null;
  searchLocateError: string | null;
  searchOpen: boolean;
  searchQuery: string;
  searchResults: Message[];
  searchingMessages: boolean;
  selectedQuote: MessageQuote | null;
  sending: boolean;
  viewportWidth?: number;
}) {
  const direct = directConversation !== undefined;
  const needsMembership =
    !direct &&
    channel !== undefined &&
    !channel.joined &&
    channel.systemKey !== "all";
  const hasConversation = direct || channel !== undefined;
  const conversationTitle = direct
    ? directConversation.peerDisplayName
    : channel
      ? channel.name
      : "选择一个会话";
  const conversationDescription = direct
    ? directConversationDescription(directMember)
    : channel
      ? `${channelKindLongLabel(channel)} · ${channel.description || "Human 与 Agent 的日常协作"}`
      : "Human 与 Agent 的日常协作";
  const onlineAgentCount = agents.filter(
    (agent) => agent.observedState === "running",
  ).length;
  const hasAgents = agents.length > 0;
  const hasOnlineAgents = onlineAgentCount > 0;
  const conversationLabel = direct
    ? directConversation.peerDisplayName
    : undefined;
  const conversationKey = directConversation
    ? `direct:${directConversation.peerUserId}`
    : channel
      ? `channel:${channel.id}`
      : "conversation:none";
  const [searchDraft, setSearchDraft] = useState(searchQuery);
  const [openActionMessageId, setOpenActionMessageId] = useState<string | null>(
    null,
  );
  useEffect(() => setSearchDraft(searchQuery), [searchQuery]);
  useEffect(() => setOpenActionMessageId(null), [conversationKey]);
  const messageSearchPanel = searchOpen ? (
    <MessageSearchPanel
      compact={compact}
      completed={searchCompleted}
      draft={searchDraft}
      error={searchError}
      locateError={searchLocateError}
      locatingResultId={locatingSearchResultId}
      loading={searchingMessages}
      onChangeDraft={setSearchDraft}
      onClose={() => onSearchOpenChange(false)}
      onLoadMore={onLoadMoreSearchResults}
      onLocate={onLocateSearchResult}
      onSearch={() => onSearchMessages(searchDraft.trim())}
      query={searchQuery}
      results={searchResults}
    />
  ) : null;

  if (compact && searchOpen) {
    return (
      <View style={styles.messageStage} testID="message-stage">
        {messageSearchPanel}
      </View>
    );
  }

  return (
    <View style={styles.messageStage} testID="message-stage">
      {compact ? null : (
        <View style={styles.messageHeader}>
          <View style={styles.messageHeaderIdentity}>
            <View style={styles.messageHeaderIcon}>
              {direct ? (
                <AtSign
                  color={velaTheme.semantic.color.iconAccent}
                  size={velaTheme.semantic.icon.size.medium}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
              ) : (
                <Hash
                  color={velaTheme.semantic.color.iconAccent}
                  size={velaTheme.semantic.icon.size.medium}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
              )}
            </View>
            <View style={styles.messageHeaderCopy}>
              <Text numberOfLines={1} style={styles.messageTitle}>
                {conversationTitle}
              </Text>
              <Text numberOfLines={1} style={styles.messageSubtitle}>
                {conversationDescription}
              </Text>
            </View>
          </View>
          <View style={styles.messageHeaderActions}>
            {!direct ? (
              <View
                style={[
                  styles.onlineAgentsBadge,
                  !hasOnlineAgents && styles.onlineAgentsBadgeEmpty,
                ]}
                testID="online-agents-badge"
              >
                <View
                  style={[
                    styles.onlineAgentsDot,
                    !hasOnlineAgents && styles.onlineAgentsDotEmpty,
                  ]}
                  testID="online-agents-dot"
                />
                <Text
                  style={[
                    styles.onlineAgentsText,
                    !hasOnlineAgents && styles.onlineAgentsTextEmpty,
                  ]}
                >
                  {hasAgents
                    ? `${onlineAgentCount} 个 Agent 在线`
                    : "暂无在线 Agent"}
                </Text>
              </View>
            ) : null}
            <Pressable
              accessibilityLabel={direct ? "搜索当前私信" : "搜索当前 Channel"}
              accessibilityRole="button"
              disabled={!hasConversation || needsMembership}
              onPress={() => onSearchOpenChange(!searchOpen)}
              style={styles.headerActionButton}
            >
              <Search
                color={velaTheme.semantic.color.iconSecondary}
                size={velaTheme.semantic.icon.size.medium}
                strokeWidth={velaTheme.semantic.icon.stroke.regular}
              />
            </Pressable>
            {!direct ? (
              <ActionButton
                accessibilityLabel={`查看 Channel ${channel?.name ?? ""} 的 ${channelMemberCount} 位成员`}
                align="center"
                context="header"
                disabled={!channel}
                icon={UsersRound}
                importance="quiet"
                label={`${channelMemberCount} 位成员`}
                onPress={onOpenChannelMembers}
              />
            ) : null}
            {imStatus === "ready" ? null : (
              <ConnectionBadge status={imStatus} />
            )}
          </View>
        </View>
      )}

      {messageSearchPanel}

      {error ? (
        <ChatActionErrorToast compact={compact} message={error} />
      ) : null}
      {!direct && operations.length > 0 ? (
        <View style={styles.operationStatus}>
          <OperationStatusList
            items={operations}
            onContinue={onContinueOperation}
          />
        </View>
      ) : null}
      {isRecoverableImStatus(imStatus) && onReconnect ? (
        <View accessibilityRole="alert" style={styles.reconnectNotice}>
          <Text style={styles.reconnectNoticeText}>
            {imStatusMessage ?? "消息连接已中断，请重新连接"}
          </Text>
          <ActionButton
            accessibilityLabel="重新连接聊天"
            align="center"
            importance="secondary"
            label="重新连接"
            onPress={onReconnect}
          />
        </View>
      ) : null}
      {needsMembership ? (
        <View style={styles.channelJoinStage}>
          <InlineEmptyState
            actionAccessibilityLabel={`加入 #${channel.name}`}
            actionBusy={joiningChannel}
            actionDisabled={joiningChannel}
            actionLabel={
              onJoinChannel
                ? joiningChannel
                  ? "正在加入…"
                  : `加入 #${channel.name}`
                : undefined
            }
            description={
              channel.visibility === "public"
                ? "加入后即可查看历史消息、发送消息，并与频道里的 Human 和 Agent 协作。"
                : "请联系频道管理员邀请你加入。"
            }
            icon={Hash}
            onAction={onJoinChannel}
            testID="channel-join-empty-state"
            title={
              channel.visibility === "public"
                ? "这是一个公开频道"
                : "你还不是这个私密频道的成员"
            }
          />
        </View>
      ) : (
        <>
          <MessageList
            conversationKey={conversationKey}
            historyCompleted={historyCompleted}
            initializing={initializingMessages}
            focusRequest={messageFocusRequest}
            emptyDescription={
              direct || hasAgents
                ? "发送第一条消息，或 @Agent 分配一项工作。"
                : "发送第一条消息，开始与成员协作。"
            }
            loadingOlder={loadingOlder}
            messages={messages}
            onCreateTask={onCreateTaskFromMessage}
            onLoadOlder={onLoadOlder}
            onOpenActionMessageIdChange={setOpenActionMessageId}
            onOpenThread={onOpenThread}
            onQuote={onQuoteMessage}
            onRevoke={onRevokeMessage}
            onRetry={onRetryMessage}
            onToggleReaction={onToggleReaction}
            openActionMessageId={openActionMessageId}
            viewportWidth={viewportWidth}
          />

          <MessageComposer
              members={mentionMembers}
              channelName={channel?.name ?? "channel"}
              conversationLabel={conversationLabel}
              disabled={
                !hasConversation ||
                imStatus !== "ready" ||
                initializingMessages ||
                sending
              }
              draft={draft}
              key={
                directConversation
                  ? `direct:${directConversation.peerUserId}`
                  : channel
                    ? `channel:${channel.id}`
                    : "conversation:none"
              }
              onAttachFile={onAttachFile}
              onAttachImage={onAttachImage}
              onClearQuote={onClearQuote}
              onDraftChange={onDraftChange}
              onFocus={() => setOpenActionMessageId(null)}
              onSend={onSend}
              quote={selectedQuote}
              viewportWidth={viewportWidth}
          />
        </>
      )}
    </View>
  );
}

function MessageSearchPanel({
  compact = false,
  completed,
  draft,
  error,
  locateError,
  locatingResultId,
  loading,
  onChangeDraft,
  onClose,
  onLoadMore,
  onLocate,
  onSearch,
  query,
  results,
}: {
  compact?: boolean;
  completed: boolean;
  draft: string;
  error: string | null;
  locateError: string | null;
  locatingResultId: string | null;
  loading: boolean;
  onChangeDraft(value: string): void;
  onClose(): void;
  onLoadMore(): void | Promise<void>;
  onLocate(messageId: string): void | Promise<void>;
  onSearch(): void | Promise<void>;
  query: string;
  results: Message[];
}) {
  return (
    <View
      style={[styles.searchPanel, compact && styles.searchPanelCompact]}
      testID="message-search-panel"
    >
      <View style={styles.searchControls}>
        <TextInput
          autoFocus
          onChangeText={onChangeDraft}
          onSubmitEditing={onSearch}
          placeholder="搜索消息"
          returnKeyType="search"
          style={styles.searchInput}
          value={draft}
        />
        <ActionButton
          accessibilityLabel="执行消息搜索"
          align="center"
          busy={loading}
          disabled={loading || draft.trim().length === 0}
          importance="tonal"
          label={loading ? "搜索中…" : "搜索"}
          onPress={onSearch}
        />
        <IconActionButton
          accessibilityLabel="关闭消息搜索"
          icon={X}
          iconTestID="message-search-close-icon"
          onPress={onClose}
        />
      </View>
      {error ? (
        <View accessibilityRole="alert" style={styles.searchPanelError}>
          <Text style={styles.searchPanelErrorTitle}>搜索暂不可用</Text>
          <Text style={styles.searchPanelErrorText}>{error}</Text>
          <Text style={styles.searchPanelErrorHint}>
            可以修改关键词后重新搜索。
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.searchResults}
          style={compact ? styles.searchResultsViewport : undefined}
        >
          {locateError ? (
            <View
              accessibilityRole="alert"
              accessible
              style={styles.searchLocateError}
            >
              <Text style={styles.searchLocateErrorText}>{locateError}</Text>
              <Text style={styles.searchLocateErrorHint}>
                搜索结果仍保留，可以稍后重试。
              </Text>
            </View>
          ) : null}
          {results.length === 0 && !loading ? (
            <Text style={styles.searchEmpty}>
              {query.trim().length > 0
                ? `没有找到与「${query.trim()}」相关的消息。`
                : "输入关键词，搜索历史消息。"}
            </Text>
          ) : null}
          {results.map((message) => {
            const locating = locatingResultId === message.id;
            return (
              <Pressable
                accessibilityLabel={`定位到消息 ${message.text}`}
                accessibilityRole="button"
                accessibilityState={{
                  busy: locating,
                  disabled: locatingResultId !== null,
                }}
                disabled={locatingResultId !== null}
                key={message.id}
                onPress={() => onLocate(message.id)}
                style={({ pressed }) => [
                  styles.searchResult,
                  pressed && styles.searchResultPressed,
                  locatingResultId !== null && styles.searchResultDisabled,
                ]}
              >
                <View style={styles.searchResultBody}>
                  <View style={styles.searchResultMeta}>
                    <Text style={styles.searchResultSender}>
                      {message.senderName}
                    </Text>
                    <Text style={styles.searchResultTime}>
                      {new Date(message.createdAt).toLocaleString("zh-CN")}
                    </Text>
                  </View>
                  <Text numberOfLines={3} style={styles.searchResultText}>
                    {message.text}
                  </Text>
                </View>
                <View style={styles.searchResultAction}>
                  <Text style={styles.searchResultActionText}>
                    {locating ? "定位中…" : "定位"}
                  </Text>
                  {locating ? null : (
                    <ArrowRight
                      color={velaTheme.semantic.color.iconAccent}
                      size={velaTheme.semantic.icon.size.compact}
                      strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                    />
                  )}
                </View>
              </Pressable>
            );
          })}
          {!completed ? (
            <ActionButton
              accessibilityLabel="加载更多搜索结果"
              busy={loading}
              disabled={loading}
              importance="secondary"
              label={loading ? "加载中…" : "加载更多"}
              onPress={onLoadMore}
            />
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const connectionStatusLabels: Record<WorkspaceImStatus, string | null> = {
  error: "连接异常",
  issuing_session: "连接中",
  kicked_out: "连接已断开",
  logging_in: "连接中",
  not_ready: "连接中断",
  ready: null,
  signed_out: "未连接",
  waiting_sdk_ready: "连接中",
};

function connectionStatusLabel(status: WorkspaceImStatus): string | null {
  return connectionStatusLabels[status];
}

function ConnectionBadge({ status }: { status: WorkspaceImStatus }) {
  const label = connectionStatusLabel(status);

  if (!label) {
    return null;
  }

  return (
    <View style={styles.connectionBadge}>
      <View
        style={[
          styles.connectionDot,
          status === "ready"
            ? styles.connectionDotReady
            : styles.connectionDotWaiting,
        ]}
      />
      <Text style={styles.connectionText}>{label}</Text>
    </View>
  );
}

function isRecoverableImStatus(status: WorkspaceImStatus): boolean {
  return (
    status === "not_ready" || status === "kicked_out" || status === "error"
  );
}

function directIdentitySummary(member: Member | undefined): string | null {
  if (!member) {
    return null;
  }

  const actor = member.kind === "agent" ? "Agent" : "自然人";
  const handle = memberIdentityLabel(member);
  return handle ? `${actor} · ${handle}` : actor;
}

function directConversationDescription(member: Member | undefined): string {
  if (!member) {
    return "与你的私密协作会话";
  }

  const actor = member.kind === "agent" ? "Agent" : "自然人";
  const handle = memberIdentityLabel(member);
  return handle ? `${actor} 私信 · ${handle}` : `${actor} 私信`;
}

function CompactHeader({
  activeDirectConversation,
  activeDirectMember,
  channelMemberCount,
  canSearch,
  channel,
  imStatus,
  navigationOpen,
  onOpenChannelMembers,
  onOpenNavigation,
  onSearch,
  searchOpen,
  server,
}: {
  activeDirectConversation: DirectConversation | undefined;
  activeDirectMember: Member | undefined;
  channelMemberCount: number;
  canSearch: boolean;
  channel: Channel | undefined;
  imStatus: WorkspaceImStatus;
  navigationOpen: boolean;
  onOpenChannelMembers(): void | Promise<void>;
  onOpenNavigation(): void;
  onSearch(): void;
  searchOpen: boolean;
  server: Server | undefined;
}) {
  const connectionLabel = connectionStatusLabel(imStatus);
  return (
    <View style={styles.compactHeader}>
      {searchOpen ? null : (
        <Pressable
          accessibilityLabel={
            navigationOpen ? "关闭会话选择" : "打开 Server 与 Channel"
          }
          accessibilityRole="button"
          accessibilityState={{ expanded: navigationOpen }}
          onPress={onOpenNavigation}
          style={({ pressed }) => [
            styles.compactPickerButton,
            styles.compactHeaderNavigationButton,
            pressed && styles.railItemPressed,
          ]}
        >
          <View testID="compact-header-menu-icon">
            {navigationOpen ? (
              <X
                color={velaTheme.semantic.color.iconAccent}
                size={velaTheme.semantic.icon.size.large}
                strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
              />
            ) : (
              <Menu
                color={velaTheme.semantic.color.iconAccent}
                size={velaTheme.semantic.icon.size.large}
                strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
              />
            )}
          </View>
        </Pressable>
      )}
      <View style={styles.compactHeaderCopy}>
        <Text numberOfLines={1} style={styles.compactEyebrow}>
          {activeDirectConversation
            ? directConversationDescription(activeDirectMember)
            : `${server?.name ?? "VELA"}${channel ? ` · ${channelKindLongLabel(channel)}` : ""}${connectionLabel ? ` · ${connectionLabel}` : ""}`}
        </Text>
        <Text numberOfLines={1} style={styles.compactTitle}>
          {navigationOpen
            ? "选择会话"
            : activeDirectConversation
              ? activeDirectConversation.peerDisplayName
              : channel
                ? `# ${channel.name}`
                : "选择会话"}
        </Text>
      </View>
      {navigationOpen || searchOpen ? null : (
        <Pressable
          accessibilityLabel={
            activeDirectConversation ? "搜索当前私信" : "搜索当前 Channel"
          }
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSearch, expanded: false }}
          disabled={!canSearch}
          onPress={onSearch}
          style={styles.compactManageButton}
        >
          <View testID="compact-header-search-icon">
            <Search
              color={velaTheme.semantic.color.iconSecondary}
              size={velaTheme.semantic.icon.size.medium}
              strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
            />
          </View>
        </Pressable>
      )}
      {!activeDirectConversation &&
      channel &&
      !navigationOpen &&
      !searchOpen ? (
        <Pressable
          accessibilityLabel={`查看 Channel ${channel.name} 的 ${channelMemberCount} 位成员`}
          accessibilityRole="button"
          disabled={!channel}
          onPress={onOpenChannelMembers}
          style={styles.compactMembersButton}
        >
          <UsersRound
            color={velaTheme.semantic.color.iconSecondary}
            size={velaTheme.semantic.icon.size.medium}
            strokeWidth={velaTheme.semantic.icon.stroke.regular}
          />
          <Text style={styles.compactMembersCount}>{channelMemberCount}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChannelManagementPanel({
  canManageMembers,
  channel,
  channelMembers,
  compact = false,
  currentImUserId,
  disabled,
  members,
  mode,
  onAddMember,
  onClose,
  onCreate,
  onRemoveMember,
  onUpdate,
}: {
  canManageMembers: boolean;
  channel: Channel | undefined;
  channelMembers: Member[];
  compact?: boolean;
  currentImUserId?: string;
  disabled: boolean;
  members: Member[];
  mode: "create" | "edit" | "members";
  onAddMember(memberId: string): void | Promise<void>;
  onClose(): void;
  onCreate(
    input: CreateChannelInput,
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onRemoveMember(memberId: string): void | Promise<void>;
  onUpdate(channelId: string, input: UpdateChannelInput): void | Promise<void>;
}) {
  const [description, setDescription] = useState(
    mode === "edit" ? (channel?.description ?? "") : "",
  );
  const [name, setName] = useState(
    mode === "edit" ? (channel?.name ?? "") : "",
  );
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  const [visibility, setVisibility] = useState<Channel["visibility"]>("public");
  const memberIds = new Set(channelMembers.map((item) => item.id));
  const humanCount = channelMembers.filter(
    (member) => member.kind === "human",
  ).length;
  const agentCount = channelMembers.length - humanCount;
  const availableAgents = members.filter(
    (member) => member.kind === "agent" && !memberIds.has(member.id),
  );
  const availableHumans = members.filter(
    (member) => member.kind === "human" && !memberIds.has(member.id),
  );
  const pendingRemovalHandle = pendingRemoval
    ? visibleMemberHandle(pendingRemoval)
    : null;
  const pendingRemovalIdentity = pendingRemoval
    ? pendingRemovalHandle
      ? `${pendingRemoval.displayName}（@${pendingRemovalHandle}）`
      : pendingRemoval.displayName
    : "";
  const pendingRemovalAccessibleIdentity = pendingRemoval
    ? pendingRemovalHandle
      ? `${pendingRemoval.displayName} @${pendingRemovalHandle}`
      : pendingRemoval.displayName
    : "";

  function renderMember(member: Member, joined: boolean): ReactElement {
    const visibleHandle = visibleMemberHandle(member);
    const memberKind = member.kind === "agent" ? "Agent" : "自然人";
    const isCurrentMember =
      joined && Boolean(currentImUserId) && member.imUserId === currentImUserId;
    const canChangeMembership =
      channel?.systemKey !== "all" &&
      (joined ? isCurrentMember || canManageMembers : canManageMembers);
    const actionLabel = joined ? (isCurrentMember ? "退出" : "移出") : "添加";
    const actionIdentity =
      !isCurrentMember && visibleHandle
        ? `${member.displayName} @${visibleHandle}`
        : member.displayName;
    return (
      <View key={member.id} style={styles.channelMemberRow}>
        <View
          style={[
            styles.channelMemberAvatar,
            member.kind === "agent" && styles.channelMemberAvatarAgent,
          ]}
        >
          {member.kind === "agent" ? (
            <Bot
              color={velaTheme.semantic.color.iconAccent}
              size={velaTheme.semantic.icon.size.small}
              strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
            />
          ) : (
            <Text style={styles.channelMemberAvatarText}>
              {member.displayName.slice(0, 1).toUpperCase()}
            </Text>
          )}
        </View>
        <View style={styles.channelMemberIdentity}>
          <Text numberOfLines={1} style={styles.channelMemberName}>
            {member.displayName}
          </Text>
          <View style={styles.channelMemberMetaRow}>
            {visibleHandle ? (
              <Text numberOfLines={1} style={styles.channelMemberMeta}>
                @{visibleHandle}
              </Text>
            ) : null}
            <Text style={styles.channelMemberKind}>{memberKind}</Text>
          </View>
        </View>
        {canChangeMembership ? (
          <Pressable
            accessibilityLabel={`${joined ? actionLabel : "添加"} Channel ${actionIdentity}`}
            accessibilityRole="button"
            disabled={disabled}
            onPress={() =>
              joined ? setPendingRemoval(member) : onAddMember(member.id)
            }
            style={
              joined ? styles.channelMemberRemove : styles.channelMemberAdd
            }
          >
            <Text
              style={
                joined
                  ? styles.channelMemberRemoveText
                  : styles.channelMemberAddText
              }
            >
              {actionLabel}
            </Text>
          </Pressable>
        ) : joined ? (
          <Text style={styles.channelMemberJoined}>已加入</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={[
        styles.channelManagementPanel,
        compact && styles.channelManagementPanelCompact,
      ]}
      testID="channel-management-panel"
    >
      <View style={styles.channelPanelHeader}>
        <View style={styles.channelPanelHeaderCopy}>
          <Text style={styles.messageEyebrow}>频道设置</Text>
          <Text style={styles.channelPanelTitle}>
            {mode === "create"
              ? "新建 Channel"
              : mode === "members"
                ? `#${channel?.name ?? ""} · ${channelMembers.length} 位成员`
                : `编辑 #${channel?.name ?? ""}`}
          </Text>
          {mode === "members" ? (
            <Text style={styles.channelPanelSummary}>
              {channel ? `${channelKindLongLabel(channel)} · ` : ""}
              {humanCount} 位自然人 · {agentCount} 个 Agent
            </Text>
          ) : null}
        </View>
        <IconActionButton
          accessibilityLabel="关闭 Channel 管理"
          icon={X}
          iconTestID="channel-management-close-icon"
          onPress={onClose}
        />
      </View>
      {mode === "members" ? (
        <ScrollView contentContainerStyle={styles.channelMemberList}>
          {channel?.systemKey === "all" ? null : (
            <View style={styles.channelMembershipContext}>
              <Text style={styles.channelMembershipContextText}>
                {channel?.visibility === "public"
                  ? "Server 成员可发现并自助加入；成员名单仍只属于这个 Channel。"
                  : "仅被添加的 Server 成员可以进入；成员名单只属于这个 Channel。"}
              </Text>
            </View>
          )}
          <UserPicker
            accessibilityLabel="搜索 Channel 成员"
            emptyDescription="换个关键词试试。"
            emptyTitle="没有匹配的成员或 Agent。"
            getItemKey={(member) => member.id}
            getSearchValues={(member) => [
              member.displayName,
              visibleMemberHandle(member) ?? "",
            ]}
            placeholder="搜索成员或 @handle"
            renderItem={(member, sectionId) =>
              renderMember(member, sectionId === "current")
            }
            sections={[
              {
                emptyText: "这个 Channel 还没有成员。",
                id: "current",
                items: channelMembers,
                title: "当前成员",
              },
              ...(canManageMembers && channel?.systemKey !== "all"
                ? [
                    {
                      emptyText: "Server 中的 Agent 都已加入这个 Channel。",
                      id: "agents",
                      items: availableAgents,
                      title: "添加 Agent",
                    },
                    {
                      hideWhenEmpty: true,
                      id: "humans",
                      items: availableHumans,
                      title: "添加成员",
                    },
                  ]
                : []),
            ]}
          />
        </ScrollView>
      ) : (
        <View style={styles.channelForm}>
          <View style={styles.channelField}>
            <Text style={styles.channelFieldLabel}>Channel 名称</Text>
            <TextInput
              accessibilityLabel={
                mode === "create" ? "Channel 名称" : "编辑 Channel 名称"
              }
              editable={!disabled}
              onChangeText={setName}
              placeholder="例如：delivery"
              style={styles.channelInput}
              value={name}
            />
          </View>
          <View style={styles.channelField}>
            <Text style={styles.channelFieldLabel}>Channel 描述</Text>
            <TextInput
              accessibilityLabel={
                mode === "create" ? "Channel 描述" : "编辑 Channel 描述"
              }
              editable={!disabled}
              multiline
              onChangeText={setDescription}
              placeholder="这个 Channel 用来做什么？"
              style={[styles.channelInput, styles.channelTextarea]}
              value={description}
            />
          </View>
          {mode === "create" ? (
            <View style={styles.channelVisibilityField}>
              <View style={styles.channelVisibilityRow}>
                {(["public", "private"] as const).map((value) => (
                  <Pressable
                    accessibilityLabel={
                      value === "private"
                        ? "设为私密 Channel"
                        : "设为公开 Channel"
                    }
                    accessibilityRole="button"
                    accessibilityState={{ selected: visibility === value }}
                    key={value}
                    onPress={() => setVisibility(value)}
                    style={[
                      styles.channelVisibilityButton,
                      visibility === value &&
                        styles.channelVisibilityButtonActive,
                    ]}
                  >
                    <Text style={styles.channelManagementButtonText}>
                      {value === "private" ? "私密" : "公开"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.channelVisibilityNotice}>
                {visibility === "public"
                  ? "Server 成员可以发现并自助加入。"
                  : "仅被添加的 Server 成员可以进入。"}
              </Text>
            </View>
          ) : (
            <Text style={styles.channelVisibilityNotice}>
              可见性在创建后不可修改：
              {channel?.visibility === "private" ? "私密" : "公开"}
            </Text>
          )}
          <Pressable
            accessibilityLabel={
              mode === "create" ? "创建 Channel" : "保存 Channel"
            }
            accessibilityRole="button"
            disabled={disabled || name.trim().length === 0}
            onPress={async () => {
              if (mode === "create") {
                await onCreate({
                  description: description.trim() || undefined,
                  name: name.trim(),
                  visibility,
                });
              } else if (channel) {
                await onUpdate(channel.id, {
                  description: description.trim(),
                  name: name.trim(),
                });
              }
              onClose();
            }}
            style={styles.channelPanelSubmit}
          >
            <Text style={styles.channelPanelSubmitText}>
              {mode === "create" ? "创建 Channel" : "保存 Channel"}
            </Text>
          </Pressable>
        </View>
      )}
      {pendingRemoval ? (
        <Modal
          animationType="fade"
          onRequestClose={() => setPendingRemoval(null)}
          transparent
          visible
        >
          <View style={styles.channelMemberConfirmBackdrop}>
            <View
              accessibilityViewIsModal
              style={styles.channelMemberConfirmDialog}
              testID="channel-member-removal-confirmation"
            >
              <View style={styles.channelMemberConfirmMark}>
                {pendingRemoval.imUserId === currentImUserId ? (
                  <LogOut
                    color={velaTheme.semantic.color.statusDanger}
                    size={velaTheme.semantic.icon.size.feature}
                    strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                  />
                ) : (
                  <UsersRound
                    color={velaTheme.semantic.color.statusDanger}
                    size={velaTheme.semantic.icon.size.feature}
                    strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                  />
                )}
              </View>
              <Text style={styles.channelMemberConfirmTitle}>
                {pendingRemoval.imUserId === currentImUserId
                  ? `退出 #${channel?.name ?? ""}？`
                  : `移出 ${pendingRemovalIdentity}？`}
              </Text>
              <Text style={styles.channelMemberConfirmDescription}>
                {pendingRemoval.imUserId === currentImUserId
                  ? `退出后，你将无法继续收发 #${channel?.name ?? ""} 的消息。之后可由管理员重新添加。`
                  : `移出后，${pendingRemovalIdentity}将无法继续收发 #${channel?.name ?? ""} 的消息。之后仍可重新添加。`}
              </Text>
              <View style={styles.channelMemberConfirmActions}>
                <Pressable
                  accessibilityLabel={
                    pendingRemoval.imUserId === currentImUserId
                      ? `取消退出 ${channel?.name ?? ""}`
                      : `取消移出 ${pendingRemoval.displayName}`
                  }
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={() => setPendingRemoval(null)}
                  style={styles.channelMemberConfirmCancel}
                >
                  <Text
                    numberOfLines={1}
                    style={styles.channelMemberConfirmCancelText}
                  >
                    {pendingRemoval.imUserId === currentImUserId
                      ? "继续留在 Channel"
                      : "取消"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={
                    pendingRemoval.imUserId === currentImUserId
                      ? `确认退出 ${channel?.name ?? ""}`
                      : `确认移出 ${pendingRemovalAccessibleIdentity}`
                  }
                  accessibilityRole="button"
                  disabled={disabled}
                  onPress={async () => {
                    await onRemoveMember(pendingRemoval.id);
                    setPendingRemoval(null);
                  }}
                  style={styles.channelMemberConfirmSubmit}
                >
                  <Text
                    numberOfLines={1}
                    style={styles.channelMemberConfirmSubmitText}
                  >
                    {pendingRemoval.imUserId === currentImUserId
                      ? "确认退出"
                      : "确认移出"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function CompactConversationPicker({
  account,
  activeConversation,
  canManageChannels,
  channelHref,
  channels,
  conversationDrafts,
  conversationSummaries,
  currentChannel,
  currentChannelId,
  currentServerId,
  directCandidates,
  directConversations,
  directHref,
  directConversationSync,
  imStatus,
  members,
  onCreateChannel,
  onEditChannel,
  onManageMembers,
  onLogout,
  onNewDirect,
  onSelectChannel,
  onSelectDirect,
  onSelectServer,
  serverHref,
  servers,
}: Pick<
  WorkspaceShellProps,
  | "channelHref"
  | "channels"
  | "currentChannelId"
  | "currentServerId"
  | "onSelectChannel"
  | "onSelectServer"
  | "serverHref"
  | "servers"
> & {
  account?: Account | null;
  activeConversation: ActiveConversation | null;
  canManageChannels: boolean;
  conversationDrafts: Record<string, ComposerDraft>;
  conversationSummaries: ConversationSummary[];
  currentChannel: Channel | undefined;
  directCandidates: Member[];
  directConversations: DirectConversation[];
  directHref?: WorkspaceShellProps["directHref"];
  directConversationSync: "complete" | "idle" | "pending";
  imStatus: WorkspaceImStatus;
  members: Member[];
  onCreateChannel(): void;
  onEditChannel(): void;
  onManageMembers(): void;
  onLogout?: (() => void | Promise<void>) | undefined;
  onNewDirect(): void;
  onSelectDirect(peerUserId: string): void | Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleChannels = normalizedFilter
    ? channels.filter((channel) =>
        [
          channel.name,
          channel.description ?? "",
          channelConversationSummary(channel, conversationSummaries)
            ?.lastMessagePreview ?? "",
          composerDraftPreview(conversationDrafts[`channel:${channel.id}`]),
        ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
      )
    : channels;
  const visibleDirectConversations = normalizedFilter
    ? directConversations.filter((conversation) =>
        [
          conversation.peerDisplayName,
          memberIdentityLabel(
            memberByImUserId(members, conversation.peerUserId),
          ) ?? "",
          conversation.lastMessagePreview,
          composerDraftPreview(
            conversationDrafts[`direct:${conversation.peerMemberId}`],
          ),
        ].some((value) => value.toLocaleLowerCase().includes(normalizedFilter)),
      )
    : directConversations;
  const visibleMembers = normalizedFilter
    ? directCandidates.filter((member) =>
        [member.displayName, member.handle, member.kind].some((value) =>
          value.toLocaleLowerCase().includes(normalizedFilter),
        ),
      )
    : [];
  const noMatches =
    Boolean(normalizedFilter) &&
    visibleChannels.length === 0 &&
    visibleDirectConversations.length === 0 &&
    visibleMembers.length === 0;
  return (
    <ScrollView
      contentContainerStyle={styles.compactPicker}
      testID="compact-conversation-picker"
    >
      {account ? (
        <View
          style={styles.compactAccountSummary}
          testID="compact-account-summary"
        >
          <HumanAccountIdentity account={account} imStatus={imStatus} />
        </View>
      ) : null}
      <Text style={styles.sectionLabel}>SERVERS</Text>
      <View style={styles.compactServerList}>
        {servers.map((server) => {
          const selected = server.id === currentServerId;
          const href = serverHref?.(server);
          return (
            <MaybeLink href={href} key={server.id}>
              <Pressable
                accessibilityLabel={`打开 Server ${server.name}`}
                accessibilityRole={href ? "link" : "button"}
                accessibilityState={{ selected }}
                onPress={href ? undefined : () => onSelectServer(server.id)}
                style={[
                  styles.compactServerButton,
                  selected && styles.compactServerButtonSelected,
                ]}
              >
                <Text style={styles.compactServerInitial}>
                  {server.name.slice(0, 1).toUpperCase()}
                </Text>
                <Text style={styles.compactServerName}>{server.name}</Text>
              </Pressable>
            </MaybeLink>
          );
        })}
      </View>
      <View style={styles.compactDirectorySearch}>
        <Search
          color={velaTheme.semantic.color.iconMuted}
          size={velaTheme.semantic.icon.size.small}
          strokeWidth={velaTheme.semantic.icon.stroke.regular}
        />
        <TextInput
          accessibilityLabel="搜索频道、私信与成员"
          onChangeText={setFilter}
          placeholder="搜索频道、私信与成员"
          placeholderTextColor={velaTheme.semantic.color.fieldPlaceholder}
          style={styles.compactDirectorySearchInput}
          value={filter}
        />
        {normalizedFilter ? (
          <Pressable
            accessibilityLabel="清除会话搜索"
            accessibilityRole="button"
            hitSlop={velaTheme.semantic.interaction.hitTargetInset}
            onPress={() => setFilter("")}
            style={styles.compactDirectorySearchClear}
          >
            <X
              color={velaTheme.semantic.color.iconMuted}
              size={velaTheme.semantic.icon.size.small}
              strokeWidth={velaTheme.semantic.icon.stroke.regular}
            />
          </Pressable>
        ) : null}
      </View>
      {noMatches ? (
        <View style={styles.compactDirectorySearchEmpty}>
          <Text style={styles.compactDirectorySearchEmptyTitle}>
            没有匹配的会话。
          </Text>
          <Text style={styles.channelMeta}>换个关键词试试。</Text>
        </View>
      ) : null}
      {!noMatches && (!normalizedFilter || visibleChannels.length > 0) ? (
        <Text style={styles.sectionLabel}>频道</Text>
      ) : null}
      {!noMatches && !normalizedFilter && canManageChannels ? (
        <View style={styles.compactChannelActions}>
          <Pressable
            accessibilityLabel="新建 Channel"
            accessibilityRole="button"
            onPress={onCreateChannel}
            style={styles.channelManagementButton}
          >
            <View style={styles.compactActionContent}>
              <View testID="compact-channel-create-icon">
                <Plus
                  color={velaTheme.semantic.color.iconAccent}
                  size={velaTheme.semantic.icon.size.small}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
              </View>
              <Text style={styles.channelManagementButtonText}>新建</Text>
            </View>
          </Pressable>
          {currentChannel?.systemKey !== "all" && currentChannel ? (
            <Pressable
              accessibilityLabel={`编辑 Channel ${currentChannel.name}`}
              accessibilityRole="button"
              onPress={onEditChannel}
              style={styles.channelManagementButton}
            >
              <View style={styles.compactActionContent}>
                <Pencil
                  color={velaTheme.semantic.color.iconSecondary}
                  size={velaTheme.semantic.icon.size.small}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
                <Text style={styles.channelManagementButtonText}>编辑</Text>
              </View>
            </Pressable>
          ) : null}
          {currentChannel && currentChannel.systemKey !== "all" ? (
            <Pressable
              accessibilityLabel={`管理 Channel ${currentChannel.name} 的成员`}
              accessibilityRole="button"
              onPress={onManageMembers}
              style={styles.channelManagementButton}
            >
              <View style={styles.compactActionContent}>
                <UsersRound
                  color={velaTheme.semantic.color.iconSecondary}
                  size={velaTheme.semantic.icon.size.small}
                  strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                />
                <Text style={styles.channelManagementButtonText}>成员</Text>
              </View>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!noMatches && (!normalizedFilter || visibleChannels.length > 0) ? (
        <View style={styles.compactChannelList}>
          {visibleChannels.map((channel) => {
            const selected = channel.id === currentChannelId;
            const href = channelHref?.(channel);
            const draftPreview = composerDraftPreview(
              conversationDrafts[`channel:${channel.id}`],
            );
            const summary = channelConversationSummary(
              channel,
              conversationSummaries,
            );
            return (
              <MaybeLink href={href} key={channel.id}>
                <Pressable
                  accessibilityLabel={`打开 Channel ${channel.name}`}
                  accessibilityRole={href ? "link" : "button"}
                  accessibilityState={{ selected }}
                  onPress={href ? undefined : () => onSelectChannel(channel.id)}
                  style={[
                    styles.compactChannelButton,
                    selected && styles.compactChannelButtonSelected,
                  ]}
                >
                  <View style={styles.compactChannelIdentity}>
                    <Hash
                      color={velaTheme.semantic.color.iconMuted}
                      size={velaTheme.semantic.icon.size.small}
                      strokeWidth={velaTheme.semantic.icon.stroke.regular}
                    />
                    <View style={styles.channelButtonCopy}>
                      <View style={styles.channelNameRow}>
                        <Text
                          numberOfLines={1}
                          style={[styles.channelName, styles.channelNameInRow]}
                        >
                          {channel.name}
                        </Text>
                        <ChannelKindBadge channel={channel} />
                      </View>
                      <Text
                        numberOfLines={1}
                        style={
                          draftPreview ? styles.draftMeta : styles.channelMeta
                        }
                      >
                        {draftPreview
                          ? `[草稿] ${draftPreview}`
                          : !channel.joined
                            ? channel.visibility === "public"
                              ? "公开频道 · 可加入"
                              : "私密频道 · 尚未加入"
                            : summary?.lastMessagePreview ||
                              channel.description ||
                              (channel.systemKey === "all"
                                ? "全体成员根群"
                                : "Human 与 Agent 的日常协作")}
                      </Text>
                    </View>
                  </View>
                  {!selected && (summary?.unreadCount ?? 0) > 0 ? (
                    <Text style={styles.channelArrow}>
                      {(summary?.unreadCount ?? 0) > 99
                        ? "99+"
                        : summary?.unreadCount}
                    </Text>
                  ) : (
                    <View testID={`compact-channel-chevron-${channel.name}`}>
                      <ChevronRight
                        color={velaTheme.semantic.color.iconMuted}
                        size={velaTheme.semantic.icon.size.medium}
                        strokeWidth={velaTheme.semantic.icon.stroke.regular}
                      />
                    </View>
                  )}
                </Pressable>
              </MaybeLink>
            );
          })}
        </View>
      ) : null}
      {!noMatches &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.compactSectionRow}>
          <Text style={styles.sectionLabel}>私信</Text>
          <Text style={styles.sidebarCount}>
            {directConversationSync === "pending"
              ? "SYNC"
              : directConversations.length}
          </Text>
        </View>
      ) : null}
      {!noMatches && !normalizedFilter ? (
        <Pressable
          accessibilityLabel="新建私信"
          accessibilityRole="button"
          onPress={onNewDirect}
          style={styles.compactDirectNew}
        >
          <View style={styles.compactActionContent}>
            <Plus
              color={velaTheme.semantic.color.iconAccent}
              size={velaTheme.semantic.icon.size.small}
              strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
            />
            <Text style={styles.channelManagementButtonText}>新建私信</Text>
          </View>
        </Pressable>
      ) : null}
      {!noMatches &&
      (!normalizedFilter || visibleDirectConversations.length > 0) ? (
        <View style={styles.compactChannelList}>
          {visibleDirectConversations.map((conversation) => {
            const selected =
              activeConversation?.kind === "direct" &&
              activeConversation.peerUserId === conversation.peerUserId;
            const href = directHref?.(conversation.peerUserId);
            const draftPreview = composerDraftPreview(
              conversationDrafts[`direct:${conversation.peerMemberId}`],
            );
            const directMember = memberByImUserId(
              members,
              conversation.peerUserId,
            );
            const identityLabel = memberIdentityLabel(directMember);
            const identitySummary = directIdentitySummary(directMember);
            return (
              <MaybeLink href={href} key={conversation.conversationId}>
                <Pressable
                  accessibilityLabel={`打开私信 ${conversation.peerDisplayName}${identityLabel ? ` ${identityLabel}` : ""}`}
                  accessibilityRole={href ? "link" : "button"}
                  accessibilityState={{ selected }}
                  onPress={
                    href
                      ? undefined
                      : () => onSelectDirect(conversation.peerUserId)
                  }
                  style={[
                    styles.compactChannelButton,
                    selected && styles.compactChannelButtonSelected,
                  ]}
                >
                  <View style={styles.channelButtonCopy}>
                    <View style={styles.directHeader}>
                      <Text
                        numberOfLines={1}
                        style={[styles.channelName, styles.directDisplayName]}
                      >
                        {conversation.peerDisplayName}
                      </Text>
                      {identitySummary ? (
                        <Text numberOfLines={1} style={styles.directHandle}>
                          {identitySummary}
                        </Text>
                      ) : null}
                    </View>
                    {draftPreview ? (
                      <Text numberOfLines={1} style={styles.draftMeta}>
                        [草稿] {draftPreview}
                      </Text>
                    ) : null}
                  </View>
                  {conversation.unreadCount > 0 ? (
                    <Text style={styles.channelArrow}>
                      {conversation.unreadCount > 99
                        ? "99+"
                        : conversation.unreadCount}
                    </Text>
                  ) : (
                    <ChevronRight
                      color={velaTheme.semantic.color.iconMuted}
                      size={velaTheme.semantic.icon.size.medium}
                      strokeWidth={velaTheme.semantic.icon.stroke.regular}
                    />
                  )}
                </Pressable>
              </MaybeLink>
            );
          })}
        </View>
      ) : null}
      {normalizedFilter && visibleMembers.length > 0 ? (
        <>
          <View style={styles.compactSectionRow}>
            <Text style={styles.sectionLabel}>成员</Text>
            <Text style={styles.sidebarCount}>
              {visibleMembers.length}
            </Text>
          </View>
          <View style={styles.compactChannelList}>
            {visibleMembers.map((member) => (
              <DirectMemberRow
                directHref={directHref}
                key={member.id}
                member={member}
                onSelect={onSelectDirect}
              />
            ))}
          </View>
        </>
      ) : null}
      {onLogout ? (
        <Pressable
          accessibilityLabel="退出当前账号"
          accessibilityRole="button"
          onPress={onLogout}
          style={styles.compactLogout}
        >
          <View style={styles.compactActionContent}>
            <LogOut
              color={velaTheme.semantic.color.iconMuted}
              size={velaTheme.semantic.icon.size.small}
              strokeWidth={velaTheme.semantic.icon.stroke.regular}
            />
            <Text style={styles.channelManagementButtonText}>退出当前账号</Text>
          </View>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function channelConversationSummary(
  channel: Channel,
  summaries: ConversationSummary[],
): ConversationSummary | undefined {
  const conversationId = channelAddress(channel)?.conversationId;
  if (!conversationId) return undefined;
  return summaries.find(
    (summary) =>
      summary.kind === "group" && summary.conversationId === conversationId,
  );
}

function DirectConversationPicker({
  directHref,
  embedded = false,
  members,
  onClose,
  onNavigateMembers,
  onSelect,
}: {
  directHref?: WorkspaceShellProps["directHref"];
  embedded?: boolean;
  members: Member[];
  onClose(): void;
  onNavigateMembers(): void;
  onSelect(peerUserId: string): void | Promise<void>;
}) {
  return (
    <View
      style={[styles.compactPicker, embedded && styles.directPickerEmbedded]}
    >
      <View style={styles.directPickerHeader}>
        <Text style={styles.compactPickerTitle}>新建私信</Text>
        <IconActionButton
          accessibilityLabel="关闭新建私信"
          icon={X}
          onPress={onClose}
        />
      </View>
      {members.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.directPickerScrollerContent}
          keyboardShouldPersistTaps="handled"
          style={styles.directScroller}
        >
          <UserPicker
            accessibilityLabel="搜索私信对象"
            clearAccessibilityLabel="清除私信对象搜索"
            emptyContent={<DirectPickerSearchEmptyState />}
            emptyDescription="试试输入名称或 @handle"
            emptyTitle="没有找到匹配的私信对象"
            getItemKey={(member) => member.id}
            getSearchValues={(member) => [
              member.displayName,
              visibleMemberHandle(member) ?? "",
            ]}
            placeholder="搜索成员或 @handle"
            renderItem={(member) => (
              <DirectMemberRow
                directHref={directHref}
                member={member}
                onSelect={onSelect}
              />
            )}
            sections={[
              {
                id: "direct",
                items: members,
                title: "可私信",
              },
            ]}
          />
        </ScrollView>
      ) : (
        <DirectPickerEmptyState onNavigateMembers={onNavigateMembers} />
      )}
    </View>
  );
}

function DirectPickerSearchEmptyState() {
  return (
    <View style={styles.directPickerSearchEmpty}>
      <View style={styles.directPickerEmptyIcon}>
        <Search
          color={velaTheme.semantic.color.iconAccent}
          size={velaTheme.semantic.icon.size.large}
          strokeWidth={velaTheme.semantic.icon.stroke.regular}
        />
      </View>
      <Text style={styles.directPickerEmptyTitle}>没有找到匹配的私信对象</Text>
      <Text style={styles.directPickerEmptyDescription}>
        试试输入名称或 @handle
      </Text>
    </View>
  );
}

function DirectPickerEmptyState({
  onNavigateMembers,
}: {
  onNavigateMembers(): void;
}) {
  return (
    <View style={styles.directPickerEmpty}>
      <View style={styles.directPickerEmptyIcon}>
        <UsersRound
          color={velaTheme.semantic.color.iconAccent}
          size={velaTheme.semantic.icon.size.large}
          strokeWidth={velaTheme.semantic.icon.stroke.regular}
        />
      </View>
      <Text style={styles.directPickerEmptyTitle}>暂无新的私信对象</Text>
      <Text style={styles.directPickerEmptyDescription}>
        已有私信可从会话列表继续。也可以前往成员页查看或邀请新成员。
      </Text>
      <Pressable
        accessibilityLabel="前往成员页"
        accessibilityRole="button"
        onPress={onNavigateMembers}
        style={styles.directPickerEmptyAction}
      >
        <Text style={styles.directPickerEmptyActionText}>查看成员</Text>
        <ArrowRight
          color={velaTheme.semantic.color.iconInverse}
          size={velaTheme.semantic.icon.size.small}
          strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
        />
      </Pressable>
    </View>
  );
}

function MobileBottomNavigation({
  activeSection,
  canManageServer,
  navigationOpen,
  onNavigateSection,
  onToggle,
  sectionHref,
}: {
  activeSection: WorkspaceSection;
  canManageServer: boolean;
  navigationOpen: boolean;
  onNavigateSection(section: WorkspaceSection): void;
  onToggle(): void;
  sectionHref?: WorkspaceShellProps["sectionHref"];
}) {
  return (
    <View style={styles.mobileBottomNavigation} testID="mobile-bottom-nav">
      {visibleSectionNavigation(canManageServer).map((item) => {
        const selected = item.id === activeSection;
        const chatLabel = navigationOpen ? "返回聊天" : "选择会话";
        const togglesPicker = item.id === "chat" && selected;
        const href = togglesPicker ? undefined : sectionHref?.(item.id);
        const NavigationIcon = item.icon;
        return (
          <View
            key={item.id}
            style={styles.mobileNavigationItem}
            testID={`mobile-nav-item-${item.id}`}
          >
            <MaybeLink href={href}>
              <Pressable
                accessibilityLabel={
                  togglesPicker ? chatLabel : item.accessibilityLabel
                }
                accessibilityRole={href ? "link" : "button"}
                accessibilityState={{ selected }}
                onPress={
                  href
                    ? undefined
                    : () => {
                        if (togglesPicker) {
                          onToggle();
                          return;
                        }
                        onNavigateSection(item.id);
                      }
                }
                style={[
                  styles.mobileNavigationButton,
                  selected && styles.mobileNavigationButtonActive,
                ]}
              >
                {item.id === "chat" && navigationOpen ? (
                  <ArrowLeft
                    color={velaTheme.semantic.color.iconAccent}
                    size={velaTheme.semantic.icon.size.large}
                    strokeWidth={velaTheme.semantic.icon.stroke.emphasis}
                  />
                ) : (
                  <NavigationIcon
                    color={
                      selected
                        ? velaTheme.semantic.color.iconAccent
                        : velaTheme.semantic.color.iconMuted
                    }
                    size={velaTheme.semantic.icon.size.large}
                    strokeWidth={selected ? velaTheme.semantic.icon.stroke.emphasis : velaTheme.semantic.icon.stroke.regular}
                  />
                )}
                <Text numberOfLines={1} style={styles.mobileNavigationLabel}>
                  {item.label}
                </Text>
              </Pressable>
            </MaybeLink>
          </View>
        );
      })}
    </View>
  );
}

function MaybeLink({
  children,
  href,
}: {
  children: ReactElement;
  href: string | undefined;
}) {
  const NavigationLink = useContext(NavigationLinkContext);
  return href && NavigationLink ? (
    <NavigationLink href={href}>{children}</NavigationLink>
  ) : (
    children
  );
}

const sectionNavigation: Array<{
  accessibilityLabel: string;
  icon: LucideIcon;
  id: WorkspaceSection;
  label: string;
}> = [
  {
    accessibilityLabel: "打开聊天",
    icon: MessageCircle,
    id: "chat",
    label: "聊天",
  },
  {
    accessibilityLabel: "打开任务",
    icon: ListChecks,
    id: "tasks",
    label: "任务",
  },
  {
    accessibilityLabel: "打开 Agent",
    icon: Bot,
    id: "agents",
    label: "Agent",
  },
  {
    accessibilityLabel: "打开 Computer",
    icon: Monitor,
    id: "computers",
    label: "Computer",
  },
  {
    accessibilityLabel: "打开成员",
    icon: UsersRound,
    id: "members",
    label: "成员",
  },
  {
    accessibilityLabel: "打开 Server 设置",
    icon: Settings,
    id: "settings",
    label: "设置",
  },
];

function visibleSectionNavigation(canManageServer: boolean) {
  return canManageServer
    ? sectionNavigation
    : sectionNavigation.filter(item => item.id !== "settings");
}

const styles = StyleSheet.create((theme) => ({
  accountDisplayName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  accountEmail: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  accountIdLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.microTracked,
  },
  accountIdPanel: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.control,
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  accountIdValue: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.navigationLabel,
  },
  accountIdentity: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minWidth: 0,
  },
  accountIdentityCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  accountLogoutButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.xs,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
  },
  accountLogoutText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  accountPopover: {
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    bottom: theme.recipes.overlay.accountPopoverBottomInset,
    elevation: theme.semantic.elevation.overlay,
    gap: theme.spacing.md,
    left: theme.recipes.overlay.accountPopoverLeftInset,
    padding: theme.spacing.md,
    position: "absolute",
    shadowColor: theme.shadows.overlay.color,
    shadowOffset: { height: theme.shadows.overlay.offsetY, width: 0 },
    shadowOpacity: theme.shadows.overlay.opacity,
    shadowRadius: theme.shadows.overlay.radius,
    width: theme.recipes.overlay.accountMenuWidth,
    zIndex: theme.semantic.layer.overlay,
  },
  accountRailButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.identity.avatarAccountSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarAccountSize,
    ...theme.semantic.motion.transition.control,
  },
  accountRailButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: velaTheme.semantic.color.borderInteractive,
    ...theme.semantic.motion.transition.control,
  },
  accountStatusDot: {
    backgroundColor: velaTheme.semantic.color.statusWarning,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  accountStatusDotError: {
    backgroundColor: velaTheme.semantic.color.statusDanger,
  },
  accountStatusDotReady: {
    backgroundColor: velaTheme.semantic.color.statusPositive,
  },
  accountStatusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.xxs,
  },
  accountStatusText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  compactDirectNew: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.sm,
  },
  compactAccountSummary: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    padding: theme.spacing.md,
  },
  compactLogout: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  compactSectionRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  directAvatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.avatarPeerSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.avatarRowSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarRowSize,
  },
  directAvatarText: {
    color: theme.semantic.color.avatarPeerText,
    ...theme.semantic.typography.bodyCompact,
  },
  directButton: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.conversationWorkspace.directRowMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        backgroundColor: theme.semantic.color.interactiveHoverSurface,
      },
    },
  },
  directButtonSelected: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.selectionSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.pane,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.conversationWorkspace.directRowMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        backgroundColor: theme.semantic.color.selectionHoverSurface,
      },
    },
  },
  directHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  directFooter: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  directDisplayName: {
    flexShrink: 1,
    minWidth: 0,
  },
  directHandle: {
    color: theme.semantic.color.textMuted,
    flexShrink: 0,
    ...theme.semantic.typography.navigationLabel,
  },
  directPreview: {
    flex: 1,
    minWidth: 0,
  },
  draftMeta: {
    color: theme.semantic.color.statusInfoText,
    ...theme.semantic.typography.captionEmphasis,
  },
  directTime: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.micro,
    marginLeft: "auto",
  },
  directList: {
    paddingBottom: theme.spacing.md,
  },
  directEmpty: {
    paddingHorizontal: theme.spacing.sm,
  },
  directScroller: {
    flex: 1,
  },
  directPickerHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  directPickerEmbedded: {
    flex: 1,
    padding: theme.spacing.md,
  },
  directPickerScrollerContent: {
    paddingBottom: theme.spacing.lg,
  },
  directPickerSearchEmpty: {
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
  },
  directPickerEmpty: {
    alignItems: "center",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xl,
  },
  directPickerEmptyAction: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.xs,
    justifyContent: "center",
    marginTop: theme.spacing.xs,
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.lg,
  },
  directPickerEmptyActionText: {
    color: velaTheme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  directPickerEmptyDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
    textAlign: "center",
  },
  directPickerEmptyIcon: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.control.height,
    justifyContent: "center",
    width: theme.recipes.control.squareSize,
  },
  directPickerEmptyTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  unreadBadge: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderColor: theme.semantic.color.statusInfoDivider,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    borderRadius: theme.semantic.radius.compactControl,
    minHeight: theme.recipes.status.badgeMinSize,
    minWidth: theme.recipes.status.badgeMinSize,
    paddingHorizontal: theme.spacing.xs,
  },
  unreadBadgeText: {
    color: theme.semantic.color.statusInfoText,
    ...theme.semantic.typography.navigationLabel,
  },
  channelForm: {
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  channelField: {
    gap: theme.spacing.sm,
  },
  channelFieldLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  channelInput: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    ...theme.semantic.typography.body,
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  channelJoinStage: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  channelManagementButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    minHeight: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
    minWidth: theme.recipes.conversationWorkspace.channelManagementActionMinWidth,
    paddingHorizontal: theme.spacing.xs,
  },
  channelManagementButtonText: {
    ...theme.semantic.typography.captionEmphasis,
  },
  channelManagementPanel: {
    backgroundColor: theme.semantic.color.overlaySurface,
    borderLeftColor: theme.semantic.color.separator,
    borderLeftWidth: theme.semantic.stroke.hairline,
    maxWidth: "100%",
    minWidth: theme.recipes.overlay.contextPanelMinWidth,
    width: theme.recipes.overlay.contextPanelWidth,
  },
  channelManagementPanelCompact: {
    borderLeftWidth: 0,
    flex: 1,
    minWidth: 0,
    width: "100%",
  },
  channelMemberAdd: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.iconControl.denseSize,
    paddingHorizontal: theme.spacing.md,
  },
  channelMemberAddText: {
    color: theme.semantic.color.actionTonalText,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  channelMemberAvatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.avatarRowSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarRowSize,
  },
  channelMemberAvatarAgent: {
    backgroundColor: theme.semantic.color.avatarAgentSurface,
  },
  channelMemberAvatarText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  channelMemberConfirmActions: {
    alignSelf: "stretch",
    flexDirection: "row",
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  channelMemberConfirmBackdrop: {
    alignItems: "center",
    backgroundColor: velaTheme.semantic.color.modalBackdrop,
    flex: 1,
    justifyContent: "center",
    padding: theme.spacing.lg,
  },
  channelMemberConfirmCancel: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    justifyContent: "center",
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  channelMemberConfirmCancelText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  channelMemberConfirmDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
    textAlign: "center",
  },
  channelMemberConfirmDialog: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.overlay,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.sm,
    maxWidth: theme.recipes.overlay.confirmDialogMaxWidth,
    padding: theme.spacing.xl,
    elevation: theme.semantic.elevation.overlay,
    shadowColor: theme.shadows.overlay.color,
    shadowOffset: { height: theme.shadows.overlay.offsetY, width: 0 },
    shadowOpacity: theme.shadows.overlay.opacity,
    shadowRadius: theme.shadows.overlay.radius,
    width: "100%",
  },
  channelMemberConfirmMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.emptyState.iconSize,
    justifyContent: "center",
    marginBottom: theme.spacing.xs,
    width: theme.recipes.emptyState.iconSize,
  },
  channelMemberConfirmSubmit: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionDangerEmphasisSurface,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    justifyContent: "center",
    minHeight: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  channelMemberConfirmSubmitText: {
    color: theme.semantic.color.actionDangerEmphasisText,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  channelMemberConfirmTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.dialogTitle,
    textAlign: "center",
  },
  channelMemberIdentity: {
    flex: 1,
    minWidth: 0,
  },
  channelMemberKind: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.navigationLabel,
  },
  channelMemberList: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
  },
  channelMembershipContext: {
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderColor: velaTheme.semantic.color.statusInfoDivider,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  channelMembershipContextText: {
    color: theme.semantic.color.statusInfoText,
    ...theme.semantic.typography.bodySmall,
  },
  channelMemberMeta: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.navigationLabel,
  },
  channelMemberMetaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  channelMemberName: {
    ...theme.semantic.typography.bodyEmphasis,
  },
  channelMemberJoined: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  channelMemberRemove: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionDangerTonalSurface,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.iconControl.denseSize,
    paddingHorizontal: theme.spacing.md,
  },
  channelMemberRemoveText: {
    color: theme.semantic.color.actionDangerText,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  channelMemberRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.conversationWorkspace.channelMemberRowMinHeight,
    paddingHorizontal: theme.spacing.md,
  },
  channelPanelHeader: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.desktopWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.md,
  },
  channelPanelHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  channelPanelSummary: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
    marginTop: theme.spacing.xxs,
  },
  channelPanelSubmit: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    minHeight: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
  },
  channelPanelSubmitText: {
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  channelPanelTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  channelArrow: {
    ...theme.semantic.typography.messageBody,
  },
  channelButton: {
    alignItems: "center",
    borderWidth: 0,
    borderRadius: theme.semantic.radius.pane,
    flexDirection: "row",
    minHeight: theme.recipes.desktopWorkspace.conversationRowMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        backgroundColor: theme.semantic.color.interactiveHoverSurface,
      },
    },
  },
  channelButtonCopy: {
    flex: 1,
    gap: theme.spacing.xxs,
    minWidth: 0,
  },
  channelButtonSelected: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.selectionSurface,
    borderWidth: 0,
    borderRadius: theme.semantic.radius.pane,
    flexDirection: "row",
    minHeight: theme.recipes.desktopWorkspace.conversationRowMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
    _web: {
      _hover: {
        backgroundColor: theme.semantic.color.selectionHoverSurface,
      },
    },
  },
  channelList: {
    gap: 0,
    paddingHorizontal: 0,
    paddingBottom: 0,
    paddingTop: 0,
  },
  channelScroller: {
    flexGrow: 0,
    flexShrink: 0,
    maxHeight: "44%",
  },
  channelIcon: {
    alignItems: "center",
    backgroundColor: velaTheme.semantic.color.surfaceSubtle,
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.iconControl.denseSize,
    justifyContent: "center",
    marginRight: theme.spacing.md,
    width: theme.recipes.iconControl.denseSize,
    ...theme.semantic.motion.transition.control,
  },
  channelIconSelected: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
    ...theme.semantic.motion.transition.control,
  },
  channelMeta: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  channelKindBadge: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderRadius: theme.semantic.radius.pill,
    justifyContent: "center",
    minHeight: theme.recipes.status.badgeMinSize,
    paddingHorizontal: theme.spacing.sm,
  },
  channelKindBadgePrivate: {
    backgroundColor: theme.semantic.color.surfaceMuted,
  },
  channelKindBadgeSystem: {
    backgroundColor: velaTheme.semantic.color.statusInfoSurface,
  },
  channelKindBadgeText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.micro,
  },
  channelName: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
    ...theme.semantic.motion.transition.control,
  },
  channelNameInRow: {
    flexShrink: 1,
    minWidth: 0,
  },
  channelNameRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minWidth: 0,
  },
  channelNameSelected: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.motion.transition.control,
  },
  channelTextarea: {
    minHeight: theme.recipes.managementWorkspace.textareaMinHeight,
    textAlignVertical: "top",
  },
  channelVisibilityButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.pill,
    flex: 1,
    minHeight: theme.recipes.control.height,
    justifyContent: "center",
    ...theme.semantic.motion.transition.control,
  },
  channelVisibilityButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderWidth: theme.semantic.stroke.hairline,
    ...theme.semantic.motion.transition.control,
  },
  channelVisibilityNotice: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  channelVisibilityField: {
    gap: theme.spacing.xs,
  },
  channelVisibilityRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  compactChannelButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: theme.recipes.compactWorkspace.listRowMinHeight,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  compactChannelButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: velaTheme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  compactChannelActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.sm,
  },
  compactActionContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
  },
  compactChannelList: {
    gap: theme.spacing.sm,
  },
  compactChannelIdentity: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minWidth: 0,
  },
  compactDirectorySearch: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  compactDirectorySearchClear: {
    alignItems: "center",
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  compactDirectorySearchEmpty: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderSection,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.xl,
  },
  compactDirectorySearchEmptyTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyEmphasis,
  },
  compactDirectorySearchInput: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
    minWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  compactEyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.overline,
  },
  compactHeader: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.paneSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    height: theme.recipes.desktopWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.md,
  },
  compactHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  compactHeaderNavigationButton: {
    marginRight: theme.spacing.sm,
  },
  compactManageButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    height: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
    marginLeft: theme.spacing.sm,
    width: theme.semantic.interaction.minimumTargetSize,
  },
  compactMembersButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.xs,
    height: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
    marginLeft: theme.spacing.sm,
    minWidth: theme.semantic.interaction.minimumTargetSize,
    paddingHorizontal: theme.spacing.md,
  },
  compactMembersCount: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  compactPicker: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flexGrow: 1,
    gap: theme.spacing.md,
    padding: theme.spacing.lg,
  },
  compactPickerButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderColor: theme.semantic.color.borderInteractive,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    height: theme.semantic.interaction.minimumTargetSize,
    justifyContent: "center",
    width: theme.semantic.interaction.minimumTargetSize,
  },
  compactPickerTitle: {
    ...theme.semantic.typography.pickerTitle,
  },
  compactServerButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.md,
    minHeight: theme.recipes.compactWorkspace.switcherRowMinHeight,
    paddingHorizontal: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
  },
  compactServerButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: velaTheme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  compactServerInitial: {
    backgroundColor: theme.semantic.color.avatarServerSurface,
    borderRadius: theme.semantic.radius.control,
    color: theme.semantic.color.avatarServerText,
    ...theme.semantic.typography.serverInitial,
    height: theme.recipes.identity.avatarCompactSize,
    textAlign: "center",
    width: theme.recipes.identity.avatarCompactSize,
  },
  compactServerList: {
    gap: theme.spacing.sm,
  },
  compactServerName: {
    ...theme.semantic.typography.messageSender,
  },
  compactShell: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
  },
  compactTitle: {
    ...theme.semantic.typography.compactTitle,
  },
  connectionBadge: {
    alignItems: "center",
    borderWidth: 0,
    borderRadius: theme.semantic.radius.pane,
    backgroundColor: theme.semantic.color.surfaceTransparent,
    flexDirection: "row",
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: theme.spacing.sm,
  },
  connectionDot: {
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.identity.connectionDotSize,
    width: theme.recipes.identity.connectionDotSize,
  },
  connectionDotReady: {
    backgroundColor: theme.semantic.color.statusPositive,
  },
  connectionDotWaiting: {
    backgroundColor: theme.semantic.color.statusWarning,
  },
  connectionText: {
    ...theme.semantic.typography.micro,
  },
  conversationSidebar: {
    backgroundColor: theme.semantic.color.sidebarSurface,
    borderRadius: theme.semantic.radius.pane,
    borderRightColor: theme.semantic.color.separator,
    borderRightWidth: theme.semantic.stroke.hairline,
    minWidth: theme.recipes.desktopWorkspace.sidebarWidth,
    overflow: "hidden",
    width: theme.recipes.desktopWorkspace.sidebarWidth,
  },
  empty: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompact,
  },
  chatErrorToast: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: velaTheme.semantic.color.borderDanger,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    maxWidth: theme.recipes.contentMeasure.noticeMaxWidth,
    minHeight: theme.recipes.status.toastMinHeight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    width: "100%",
  },
  chatErrorToastClose: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  chatErrorToastIcon: {
    alignItems: "center",
    backgroundColor: velaTheme.semantic.color.statusDangerSurface,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.compactSize,
  },
  chatErrorToastLayer: {
    alignItems: "center",
    left: 0,
    paddingHorizontal: theme.spacing.md,
    position: "absolute",
    right: 0,
    top: theme.recipes.conversationWorkspace.toastTopInset,
    zIndex: theme.semantic.layer.modal,
  },
  chatErrorToastLayerCompact: {
    top: theme.spacing.md,
  },
  chatErrorToastText: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  reconnectNotice: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderBottomColor: theme.semantic.color.statusInfoDivider,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.status.bannerMinHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
  },
  reconnectNoticeText: {
    color: theme.semantic.color.statusInfoText,
    flex: 1,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  messageEyebrow: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.overline,
  },
  messageHeader: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    backgroundColor: theme.semantic.color.surfaceTransparent,
    flexDirection: "row",
    height: theme.recipes.desktopWorkspace.headerHeight,
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.xl,
  },
  messageHeaderActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  messageHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  messageHeaderIcon: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.iconAccentSurface,
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.iconControl.denseSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.denseSize,
  },
  messageHeaderIdentity: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing.md,
    minWidth: 0,
  },
  messageSubtitle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
    marginTop: theme.spacing.xxs,
  },
  messageStage: {
    backgroundColor: theme.semantic.color.canvasSurface,
    borderRadius: theme.semantic.radius.pane,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  onlineAgentsBadge: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderRadius: theme.semantic.radius.pane,
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: theme.recipes.status.summaryMinHeight,
    paddingHorizontal: theme.spacing.xs,
  },
  onlineAgentsBadgeEmpty: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
  },
  onlineAgentsDot: {
    backgroundColor: theme.semantic.color.statusPositive,
    borderRadius: theme.semantic.radius.circle,
    height: theme.recipes.identity.statusDotSize,
    width: theme.recipes.identity.statusDotSize,
  },
  onlineAgentsDotEmpty: {
    backgroundColor: theme.semantic.color.statusNeutral,
  },
  onlineAgentsText: {
    color: velaTheme.semantic.color.statusPositiveText,
    ...theme.semantic.typography.navigationLabel,
  },
  onlineAgentsTextEmpty: {
    color: theme.semantic.color.textMuted,
  },
  operationStatus: {
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    padding: theme.spacing.sm,
  },
  messageTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  headerActionButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderWidth: 0,
    justifyContent: "center",
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.iconControl.smallSize,
    width: theme.recipes.iconControl.smallSize,
  },
  mobileBottomNavigation: {
    alignItems: "stretch",
    backgroundColor: theme.semantic.color.paneSurface,
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.compactWorkspace.bottomNavigationHeight,
    flexDirection: "row",
    justifyContent: "space-evenly",
  },
  mobileNavigationButton: {
    alignItems: "center",
    flex: 1,
    gap: theme.spacing.xs,
    height: "100%",
    justifyContent: "center",
    minWidth: theme.recipes.compactWorkspace.navigationItemMinWidth,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  mobileNavigationItem: {
    alignItems: "stretch",
    flex: 1,
    minWidth: theme.recipes.compactWorkspace.navigationItemMinWidth,
  },
  mobileNavigationButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    ...theme.semantic.motion.transition.control,
  },
  mobileNavigationLabel: {
    ...theme.semantic.typography.navigationLabel,
  },
  railBrand: {
    alignItems: "center",
    height: theme.recipes.desktopWorkspace.headerHeight,
    justifyContent: "center",
    width: "100%",
  },
  railItemPressed: {
    opacity: theme.semantic.opacity.inactive,
    ...theme.semantic.motion.transition.control,
  },
  railNavigation: {
    alignItems: "center",
    gap: theme.recipes.desktopWorkspace.navigationGap,
    paddingTop: theme.recipes.desktopWorkspace.navigationTopInset,
    width: "100%",
    ...theme.semantic.motion.transition.control,
  },
  railNavigationButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    justifyContent: "center",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
  },
  railNavigationActive: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.selectionSurface,
    borderRadius: theme.semantic.radius.compactControl,
    borderWidth: 0,
    height: theme.recipes.desktopWorkspace.navigationControlSize,
    justifyContent: "center",
    width: theme.recipes.desktopWorkspace.navigationControlSize,
    ...theme.semantic.motion.transition.control,
  },
  railNavigationHovered: {
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderColor: theme.semantic.color.borderControl,
    ...theme.semantic.motion.transition.control,
  },
  railNavigationItem: {
    height: theme.recipes.identity.avatarAccountSize,
    position: "relative",
    width: theme.recipes.identity.avatarAccountSize,
    zIndex: theme.semantic.layer.navigation,
  },
  railFooter: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    paddingBottom: theme.spacing.md,
    paddingTop: theme.spacing.md,
    position: "relative",
    width: "100%",
    zIndex: theme.semantic.layer.docked,
  },
  railSpacer: {
    flex: 1,
  },
  railTooltip: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.inverseSurface,
    borderRadius: theme.semantic.radius.compactControl,
    height: theme.recipes.iconControl.compactSize,
    justifyContent: "center",
    left: theme.recipes.overlay.railTooltipLeftInset,
    paddingHorizontal: theme.spacing.md,
    position: "absolute",
    shadowColor: velaTheme.shadows.overlay.color,
    elevation: theme.semantic.elevation.overlay,
    shadowOffset: { height: velaTheme.shadows.overlay.offsetY, width: 0 },
    shadowOpacity: velaTheme.shadows.overlay.opacity,
    shadowRadius: velaTheme.shadows.overlay.radius,
    top: theme.recipes.overlay.railTooltipTopInset,
    zIndex: theme.semantic.layer.tooltip,
  },
  railTooltipText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.tooltip,
    whiteSpace: "nowrap",
  },
  humanAvatar: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.avatarAccountSurface,
    borderRadius: theme.semantic.radius.section,
    height: theme.recipes.identity.avatarProminentSize,
    justifyContent: "center",
    position: "relative",
    width: theme.recipes.identity.avatarProminentSize,
  },
  humanAvatarStatus: {
    backgroundColor: velaTheme.semantic.color.statusWarning,
    borderColor: theme.semantic.color.paneSurface,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.statusRing,
    bottom: -theme.semantic.stroke.hairline,
    height: theme.recipes.identity.presenceDotSize,
    position: "absolute",
    right: -theme.semantic.stroke.hairline,
    width: theme.recipes.identity.presenceDotSize,
  },
  humanAvatarStatusError: {
    backgroundColor: velaTheme.semantic.color.statusDanger,
  },
  humanAvatarStatusReady: {
    backgroundColor: velaTheme.semantic.color.statusPositive,
  },
  humanAvatarText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.avatarLabel,
  },
  rootNotice: {
    backgroundColor: theme.semantic.color.statusInfoSurface,
    borderBottomColor: theme.semantic.color.statusInfoDivider,
    borderBottomWidth: theme.semantic.stroke.hairline,
    color: theme.semantic.color.statusInfoText,
    ...theme.semantic.typography.bodyCompactEmphasis,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  searchControls: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  searchEmpty: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
    paddingVertical: theme.spacing.md,
  },
  searchInput: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
    height: theme.semantic.interaction.minimumTargetSize,
    minWidth: 0,
    paddingHorizontal: theme.spacing.sm,
  },
  searchPanel: {
    backgroundColor: theme.semantic.color.overlaySurface,
    borderColor: theme.semantic.color.borderOverlay,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.sm,
    margin: theme.spacing.sm,
    maxHeight: theme.recipes.overlay.searchPanelMaxHeight,
    padding: theme.spacing.md,
  },
  searchPanelCompact: {
    flex: 1,
    maxHeight: "100%",
    minHeight: 0,
  },
  searchPanelError: {
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderColor: velaTheme.semantic.color.borderDanger,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    padding: theme.spacing.md,
  },
  searchPanelErrorHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  searchPanelErrorText: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodySmall,
  },
  searchPanelErrorTitle: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  searchResult: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceSubtle,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flexDirection: "row",
    gap: theme.spacing.xs,
    justifyContent: "space-between",
    minHeight: theme.recipes.managementWorkspace.rowMinHeight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    ...theme.semantic.motion.transition.control,
  },
  searchResultAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
    minHeight: theme.semantic.interaction.minimumTargetSize,
  },
  searchResultActionText: {
    color: theme.semantic.color.textLink,
    ...theme.semantic.typography.captionEmphasis,
  },
  searchResultBody: {
    flex: 1,
    gap: theme.spacing.xs,
    minWidth: 0,
  },
  searchResultDisabled: {
    opacity: theme.semantic.opacity.contentSubtle,
    ...theme.semantic.motion.transition.control,
  },
  searchResultMeta: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  searchResultSender: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.captionEmphasis,
  },
  searchResultPressed: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  searchResultText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompact,
  },
  searchResultTime: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.micro,
  },
  searchResults: {
    gap: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
  },
  searchResultsViewport: {
    flex: 1,
    minHeight: 0,
  },
  searchLocateError: {
    backgroundColor: velaTheme.semantic.color.statusWarningSurface,
    borderColor: velaTheme.semantic.color.statusWarningDivider,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xxs,
    padding: theme.spacing.sm,
  },
  searchLocateErrorHint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  searchLocateErrorText: {
    color: theme.semantic.color.statusWarningText,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  sectionLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.overline,
  },
  serverMark: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderColor: theme.semantic.color.borderTransparent,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    height: theme.recipes.identity.avatarNavigationSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarNavigationSize,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkSelected: {
    backgroundColor: theme.semantic.color.avatarServerSurface,
    borderColor: velaTheme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkText: {
    ...theme.semantic.typography.messageBody,
    ...theme.semantic.motion.transition.control,
  },
  serverMarkTextSelected: {
    color: theme.semantic.color.avatarServerText,
    ...theme.semantic.motion.transition.control,
  },
  serverMarks: {
    alignItems: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
  },
  serverMarksScroller: {
    flexGrow: 0,
    maxHeight: theme.recipes.overlay.serverListMaxHeight,
  },
  serverRail: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.navigationSurface,
    borderRadius: theme.semantic.radius.pane,
    borderRightColor: theme.semantic.color.separator,
    borderRightWidth: theme.semantic.stroke.hairline,
    position: "relative",
    width: theme.recipes.desktopWorkspace.railWidth,
    zIndex: theme.semantic.layer.popover,
  },
  shell: {
    backgroundColor: theme.semantic.color.canvasSurface,
    borderRadius: theme.semantic.radius.pane,
    borderWidth: 0,
    flex: 1,
    flexDirection: "row",
    gap: 0,
    margin: 0,
    overflow: "hidden",
    padding: 0,
  },
  sidebarCount: {
    ...theme.semantic.typography.navigationLabel,
  },
  sidebarSectionActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.xxs,
  },
  sidebarHeader: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.sidebarSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.desktopWorkspace.headerHeight,
    paddingHorizontal: theme.spacing.md,
  },
  sidebarHeaderCopy: {
    flex: 1,
    minWidth: 0,
  },
  sidebarHeaderIcon: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.avatarServerSurface,
    borderColor: theme.semantic.color.borderTransparent,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    height: theme.recipes.identity.avatarNavigationSize,
    justifyContent: "center",
    width: theme.recipes.identity.avatarNavigationSize,
  },
  sidebarHeaderIconText: {
    color: theme.semantic.color.textInverse,
    ...theme.semantic.typography.bodySmall,
  },
  sidebarSearchClear: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.section,
    height: theme.recipes.iconControl.microSize,
    justifyContent: "center",
    width: theme.recipes.iconControl.microSize,
  },
  sidebarSearchEmpty: {
    alignItems: "center",
    flex: 1,
    gap: theme.spacing.xs,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  sidebarSearchInput: {
    color: theme.semantic.color.textPrimary,
    flex: 1,
    ...theme.semantic.typography.bodyCompact,
    minWidth: 0,
    paddingHorizontal: theme.spacing.xxs,
    paddingVertical: 0,
  },
  sidebarSearchWrap: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.sm,
    height: theme.recipes.control.height,
    marginHorizontal: theme.spacing.md,
    marginVertical: theme.spacing.md,
    paddingHorizontal: theme.spacing.md,
  },
  sidebarSectionHeader: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    height: theme.recipes.control.height,
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
  },
  sidebarSubtitle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  sidebarTitle: {
    ...theme.semantic.typography.workspaceTitle,
  },
}));
