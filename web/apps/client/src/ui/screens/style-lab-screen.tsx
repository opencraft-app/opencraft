import type {
  Account,
  ActiveConversation,
  Agent,
  Channel,
  Computer,
  ConversationSummary,
  DirectConversation,
  InboxItem,
  Member,
  Message,
  Server,
  Task,
} from "@vela/client-core";
import { useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { AgentsScreen } from "./agents-screen";
import { ComputersScreen } from "./computers-screen";
import { MembersScreen } from "./members-screen";
import { TasksScreen } from "./tasks-screen";
import { WorkspaceShell } from "../layouts/workspace-shell";
import type { TerminalSurfaceController } from "../components/terminal-panel";
import { layoutMode } from "../layout-mode";
import { velaTheme } from "../tokens";

const server: Server = {
  description: "Human 与 Agent 的产品协作空间",
  id: "stylelab-server",
  imState: "ready",
  name: "产品实验室",
  ownerMemberId: "stylelab-member-owner",
  revision: 1,
  slug: "stylelab",
};

const account: Account = {
  displayName: "林墨",
  email: "linmo@example.com",
  id: "stylelab-account-you",
  imState: "ready",
  imUserId: "stylelab-human-linmo",
  revision: 1,
};

const channels: Channel[] = [
  {
    description: "Atlas：首次协作闭环已完成",
    id: "stylelab-general",
    joined: true,
    imGroupId: "stylelab-community",
    imState: "ready",
    imTopicId: "stylelab-topic-general",
    name: "general",
    revision: 1,
    serverId: server.id,
    visibility: "public",
  },
  {
    description: "林墨：整理了设计稿",
    id: "stylelab-product",
    joined: true,
    imGroupId: "stylelab-community",
    imState: "ready",
    imTopicId: "stylelab-topic-product",
    name: "产品讨论",
    revision: 1,
    serverId: server.id,
    visibility: "public",
  },
  {
    description: "2 个 Agent 正在运行",
    id: "stylelab-agent-lab",
    joined: true,
    imGroupId: "stylelab-community",
    imState: "ready",
    imTopicId: "stylelab-topic-agent",
    name: "Agent 实验",
    revision: 1,
    serverId: server.id,
    visibility: "private",
  },
];

const conversationSummaries: ConversationSummary[] = [
  {
    conversationId: "GROUPstylelab-topic-general",
    kind: "group",
    lastMessageAt: "2026-08-03T09:42:00.000Z",
    lastMessagePreview: "Atlas：首次协作闭环已完成",
    title: "general",
    unreadCount: 0,
  },
  {
    conversationId: "GROUPstylelab-topic-product",
    kind: "group",
    lastMessageAt: "2026-08-03T08:18:00.000Z",
    lastMessagePreview: "林墨：整理了设计稿",
    title: "产品讨论",
    unreadCount: 4,
  },
  {
    conversationId: "GROUPstylelab-topic-agent",
    kind: "group",
    lastMessageAt: "2026-08-02T16:35:00.000Z",
    lastMessagePreview: "2 个 Agent 正在运行",
    title: "Agent 实验",
    unreadCount: 12,
  },
];

const agents: Agent[] = [
  {
    availability: "online",
    computerId: "stylelab-computer-design",
    credentialVersion: 1,
    desiredState: "running",
    displayName: "Atlas Agent",
    handle: "atlas",
    id: "stylelab-agent-atlas",
    imState: "ready",
    imPresence: "online",
    imTransportState: "connected",
    imUserId: "stylelab-im-atlas",
    observedState: "running",
    replyPolicy: "mention_and_dm",
    revision: 1,
    runtime: { kind: "codex" },
    serverId: server.id,
  },
  {
    availability: "offline",
    computerId: "stylelab-computer-design",
    credentialVersion: 1,
    desiredState: "stopped",
    displayName: "Runtime Agent",
    handle: "runtime",
    id: "stylelab-agent-runtime",
    imState: "ready",
    imPresence: "offline",
    imTransportState: "disconnected",
    imUserId: "stylelab-im-runtime",
    observedState: "unknown",
    replyPolicy: "mention_and_dm",
    revision: 1,
    runtime: { kind: "hermes-gateway" },
    serverId: server.id,
  },
];

const computers: Computer[] = [
  {
    connectionState: "online",
    id: "stylelab-computer-design",
    lastObservedAt: "2026-08-02T02:31:00.000Z",
    lifecycleState: "active",
    name: "设计工作站",
    osType: "macos",
    revision: 1,
    serverId: server.id,
  },
  {
    connectionState: "offline",
    id: "stylelab-computer-inference",
    lastObservedAt: "2026-08-01T12:18:00.000Z",
    lifecycleState: "active",
    name: "推理节点",
    osType: "linux",
    revision: 1,
    serverId: server.id,
  },
];

const tasks: Task[] = [
  {
    assignmentRevision: 1,
    createdByMemberId: "stylelab-member-you",
    description: "验证聊天、Computer 与 Agent 的真实闭环。",
    id: "stylelab-task-1",
    number: 12,
    revision: 1,
    serverId: server.id,
    status: "in_progress",
    title: "首次协作闭环验收",
    updatedByMemberId: "stylelab-member-you",
  },
];

const inbox: InboxItem[] = [
  {
    id: "stylelab-inbox-1",
    kind: "task",
    resourceId: tasks[0]!.id,
    serverId: server.id,
    status: "in_progress",
    title: tasks[0]!.title,
    updatedAt: "2026-08-02T02:25:30.000Z",
  },
];

const members: Member[] = [
  humanMember("owner", "周岚", "zhoulan", "owner"),
  humanMember("you", "林墨", "linmo", "admin"),
  humanMember("ux", "设计小组", "ux", "member"),
  humanMember("ops", "运行团队", "ops", "member"),
  humanMember("qa", "验收小组", "qa", "member"),
  humanMember("pm", "产品团队", "pm", "member"),
  agentMember(agents[0]!),
  agentMember(agents[1]!),
];

const channelMemberIds: Record<string, string[]> = {
  "stylelab-general": [
    "stylelab-member-owner",
    "stylelab-member-you",
    "stylelab-member-atlas",
  ],
  "stylelab-product": [
    "stylelab-member-owner",
    "stylelab-member-you",
    "stylelab-member-ux",
    "stylelab-member-atlas",
  ],
  "stylelab-agent-lab": [
    "stylelab-member-you",
    "stylelab-member-atlas",
    "stylelab-member-runtime",
  ],
};

const directConversations: DirectConversation[] = [
  {
    conversationId: "GROUPan_dm_stylelab_atlas",
    directConversationId: "stylelab-direct-atlas",
    imGroupId: "an_dm_stylelab_atlas",
    imState: "ready",
    lastMessageAt: "2026-08-02T02:25:00.000Z",
    lastMessagePreview: "Runtime 诊断已完成",
    peerDisplayName: "Atlas Agent",
    peerMemberId: "stylelab-member-atlas",
    peerUserId: "stylelab-im-atlas",
    unreadCount: 0,
  },
  {
    conversationId: "GROUPan_dm_stylelab_zhoulan",
    directConversationId: "stylelab-direct-zhoulan",
    imGroupId: "an_dm_stylelab_zhoulan",
    imState: "ready",
    lastMessageAt: "2026-08-01T08:00:00.000Z",
    lastMessagePreview: "Computer 状态晚点再看",
    peerDisplayName: "周岚",
    peerMemberId: "stylelab-member-owner",
    peerUserId: "stylelab-human-zhoulan",
    unreadCount: 0,
  },
  {
    conversationId: "GROUPan_dm_stylelab_ux",
    directConversationId: "stylelab-direct-ux",
    imGroupId: "an_dm_stylelab_ux",
    imState: "ready",
    lastMessageAt: "2026-07-30T08:00:00.000Z",
    lastMessagePreview: "3 位成员",
    peerDisplayName: "设计小组",
    peerMemberId: "stylelab-member-ux",
    peerUserId: "stylelab-human-ux",
    unreadCount: 0,
  },
];

const styleLabImageUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="${velaTheme.semantic.color.surfaceSubtle}"/>
    <text x="84" y="104" fill="${velaTheme.semantic.color.textPrimary}" font-family="sans-serif" font-size="42" font-weight="700">Human 与 Agent 协作拓扑</text>
    <text x="84" y="154" fill="${velaTheme.semantic.color.textMuted}" font-family="sans-serif" font-size="22">腾讯云 IM 负责消息，平台维护业务事实</text>
    <path d="M356 360h174M750 360h174" stroke="${velaTheme.semantic.color.brandAccent}" stroke-width="8" stroke-linecap="round"/>
    <path d="m510 340 30 20-30 20M904 340l30 20-30 20" fill="none" stroke="${velaTheme.semantic.color.brandAccent}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="84" y="250" width="272" height="220" rx="34" fill="${velaTheme.semantic.color.sectionSurface}" stroke="${velaTheme.semantic.color.surfaceMuted}" stroke-width="3"/>
    <rect x="530" y="250" width="220" height="220" rx="34" fill="${velaTheme.semantic.color.selectionSurface}" stroke="${velaTheme.semantic.color.borderInteractive}" stroke-width="3"/>
    <rect x="924" y="250" width="272" height="220" rx="34" fill="${velaTheme.semantic.color.sectionSurface}" stroke="${velaTheme.semantic.color.surfaceMuted}" stroke-width="3"/>
    <circle cx="220" cy="326" r="32" fill="${velaTheme.semantic.color.avatarAccountSurface}"/>
    <text x="220" y="338" fill="${velaTheme.semantic.color.textInverse}" font-family="sans-serif" font-size="30" text-anchor="middle">人</text>
    <text x="220" y="406" fill="${velaTheme.semantic.color.textPrimary}" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle">Human</text>
    <text x="640" y="350" fill="${velaTheme.semantic.color.brandAccent}" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle">Channel</text>
    <text x="640" y="397" fill="${velaTheme.semantic.color.textMuted}" font-family="sans-serif" font-size="23" text-anchor="middle">消息与上下文</text>
    <rect x="1028" y="294" width="64" height="64" rx="18" fill="${velaTheme.semantic.color.brandAccent}"/>
    <text x="1060" y="338" fill="${velaTheme.semantic.color.textInverse}" font-family="sans-serif" font-size="33" text-anchor="middle">A</text>
    <text x="1060" y="406" fill="${velaTheme.semantic.color.textPrimary}" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle">Agent</text>
    <text x="84" y="618" fill="${velaTheme.semantic.color.textMuted}" font-family="sans-serif" font-size="22">Style Lab · 图片预览回归样本</text>
  </svg>
`)}`;

const messages: Message[] = [
  textMessage(
    "stylelab-message-1",
    "stylelab-human-linmo",
    "林墨",
    "2026-08-02T02:24:00.000Z",
    "我们把新用户的 Server 创建流程再走一遍，确认首次协作没有断点。",
  ),
  textMessage(
    "stylelab-message-2",
    "stylelab-im-atlas",
    "Atlas Agent",
    "2026-08-02T02:25:00.000Z",
    "收到。我会验证 Server、Computer 和 Agent 的状态，并整理成一份可以直接验收的清单。",
  ),
  {
    content: {
      kind: "task",
      status: "进行中",
      taskId: "stylelab-task-1",
      title: "首次协作闭环验收",
    },
    conversationId: "GROUPstylelab-topic-general",
    createdAt: "2026-08-02T02:25:30.000Z",
    delivery: { state: "sent" },
    direction: "incoming",
    id: "stylelab-message-task",
    kind: "task",
    mentions: [],
    rawType: "VELA_TASK",
    reactions: [],
    read: { state: "unknown" },
    senderId: "stylelab-im-atlas",
    senderName: "Atlas Agent",
    text: "首次协作闭环验收",
  },
  textMessage(
    "stylelab-message-3",
    "stylelab-human-linmo",
    "你",
    "2026-08-02T02:27:00.000Z",
    "@Atlas 先把聊天闭环、Computer 的 provisioning 失败记录单独列出来。",
  ),
  textMessage(
    "stylelab-message-4",
    "stylelab-im-atlas",
    "Atlas Agent",
    "2026-08-02T02:28:00.000Z",
    "聊天链路已经验证完成：Human 消息由腾讯云 IM 直达，平台只记录对应的业务引用。",
  ),
  {
    content: {
      height: 720,
      kind: "image",
      name: "协作拓扑.png",
      size: 58_240,
      url: styleLabImageUri,
      width: 1_280,
    },
    conversationId: "GROUPstylelab-topic-general",
    createdAt: "2026-08-02T02:29:00.000Z",
    delivery: { state: "sent" },
    direction: "incoming",
    id: "stylelab-message-image",
    kind: "image",
    mentions: [],
    rawType: "TIMImageElem",
    reactions: [],
    read: { state: "unknown" },
    senderId: "stylelab-im-atlas",
    senderName: "Atlas Agent",
    text: "[图片]",
  },
];

const directMessages: Message[] = [
  {
    ...textMessage(
      "stylelab-direct-message-1",
      "stylelab-im-atlas",
      "Atlas Agent",
      "2026-08-02T02:25:00.000Z",
      "Runtime 诊断已完成，可以继续检查部署状态。",
    ),
    conversationId: directConversations[0]!.conversationId,
  },
  {
    ...textMessage(
      "stylelab-direct-message-2",
      "stylelab-human-linmo",
      "你",
      "2026-08-02T02:27:00.000Z",
      "收到，我会继续验证 Computer 与 Agent 的状态。",
    ),
    conversationId: directConversations[0]!.conversationId,
  },
];

export function StyleLabScreen({
  viewportWidth,
}: { viewportWidth?: number } = {}) {
  const window = useWindowDimensions();
  const hostWidth = viewportWidth ?? window.width;
  const [canvasWidth, setCanvasWidth] = useState<number | null>(
    viewportWidth ?? null,
  );
  const previewWidth = canvasWidth ?? window.width;
  const compact = layoutMode(hostWidth) === "compact";
  const canvasHeight = Math.max(640, window.height - (compact ? 194 : 114));
  const [preview, setPreview] = useState<Preview>("chat");
  const [scenario, setScenario] = useState<ReviewScenario>("normal");
  const [activeConversation, setActiveConversation] =
    useState<ActiveConversation>({
      channelId: channels[0]!.id,
      kind: "channel",
    });
  const [messageFocusRequest, setMessageFocusRequest] = useState<{
    messageId: string;
    revision: number;
  } | null>(null);
  const reviewImStatus = scenario === "disconnected" ? "error" : "ready";
  const reviewAgents = scenario === "empty" ? [] : agents;
  const reviewComputers = scenario === "empty" ? [] : computers;
  const reviewMembers = scenario === "empty" ? [] : members;
  const reviewMessages = scenario === "empty" ? [] : messages;
  const reviewTasks = scenario === "empty" ? [] : tasks;
  const reviewInbox = scenario === "empty" ? [] : inbox;
  const reviewChannels =
    scenario === "unjoined"
      ? channels.map((channel, index) =>
          index === 0 ? { ...channel, joined: false } : channel,
        )
      : channels;
  const activeChannelMembers =
    activeConversation.kind === "channel"
      ? reviewMembers.filter((member) =>
          (channelMemberIds[activeConversation.channelId] ?? []).includes(
            member.id,
          ),
        )
      : [];
  const navigate = (section: Preview) => setPreview(section);
  const selectScenario = (nextScenario: ReviewScenario) => {
    setScenario(nextScenario);
    if (nextScenario !== "normal") {
      setActiveConversation({ channelId: channels[0]!.id, kind: "channel" });
    }
  };

  return (
    <View style={styles.screen} testID="style-lab-screen">
      <View style={styles.toolbar}>
        <View
          style={[
            styles.toolbarContent,
            compact && styles.toolbarContentCompact,
          ]}
          testID="style-lab-toolbar-content"
        >
          <View style={[styles.labCopy, compact && styles.labCopyCompact]}>
            <Text style={styles.labTitle}>Style Lab</Text>
            <Text style={styles.labSubtitle}>
              真实组件 · {Math.round(previewWidth)}px 实时画布
            </Text>
          </View>
          <ScrollView
            contentContainerStyle={[
              styles.previewTabsContent,
              compact && styles.previewTabsContentCompact,
            ]}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.previewTabs, compact && styles.previewTabsCompact]}
            testID="style-lab-preview-tabs"
          >
            {previewOptions.map((option) => (
              <Pressable
                accessibilityLabel={option.accessibilityLabel}
                accessibilityRole="button"
                accessibilityState={{ selected: preview === option.id }}
                key={option.id}
                onPress={() => setPreview(option.id)}
                style={[
                  styles.previewButton,
                  compact && styles.previewButtonCompact,
                  preview === option.id && styles.previewButtonSelected,
                ]}
              >
                <Text
                  style={[
                    styles.previewButtonText,
                    preview === option.id && styles.previewButtonTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView
            contentContainerStyle={styles.canvasTabsContent}
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.canvasTabs, compact && styles.canvasTabsCompact]}
            testID="style-lab-canvas-tabs"
          >
            {canvasPresets.map((preset) => {
              const selected = canvasWidth === preset.width;
              return (
                <Pressable
                  accessibilityLabel={preset.accessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={preset.id}
                  onPress={() => setCanvasWidth(preset.width)}
                  style={[
                    styles.canvasButton,
                    selected && styles.canvasButtonSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.canvasButtonText,
                      selected && styles.canvasButtonTextSelected,
                    ]}
                  >
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        <ScrollView
          contentContainerStyle={styles.scenarioTabsContent}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.scenarioTabs}
          testID="style-lab-scenario-tabs"
        >
          {scenarioOptions.map((option) => (
            <Pressable
              accessibilityLabel={option.accessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ selected: scenario === option.id }}
              key={option.id}
              onPress={() => selectScenario(option.id)}
              style={[
                styles.scenarioButton,
                scenario === option.id && styles.scenarioButtonSelected,
              ]}
            >
              <Text
                style={[
                  styles.scenarioButtonText,
                  scenario === option.id && styles.scenarioButtonTextSelected,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
      <ScrollView
        contentContainerStyle={styles.previewContent}
        horizontal
        showsHorizontalScrollIndicator
        style={styles.preview}
        testID="style-lab-canvas-scroller"
      >
        <View
          style={[styles.canvas, { height: canvasHeight, width: previewWidth }]}
          testID="style-lab-canvas"
        >
          {preview === "chat" ? (
            <WorkspaceShell
              account={account}
              activeConversation={activeConversation}
              agents={activeConversation.kind === "channel" ? reviewAgents : []}
              canManageChannels
              channelMembers={activeChannelMembers}
              channels={reviewChannels}
              conversationSummaries={conversationSummaries}
              currentChannelId={
                activeConversation.kind === "channel"
                  ? activeConversation.channelId
                  : null
              }
              currentImUserId="stylelab-human-linmo"
              currentServerId={server.id}
              directConversations={directConversations}
              directConversationSync="complete"
              imStatus={reviewImStatus}
              imStatusMessage={
                scenario === "disconnected"
                  ? "消息连接已中断，请重新连接"
                  : undefined
              }
              members={reviewMembers}
              mentionMembers={activeChannelMembers.flatMap((member) =>
                member.status === "active" &&
                member.imState === "ready" &&
                member.imUserId
                  ? [
                      {
                        displayName: member.displayName,
                        handle: member.handle,
                        id: member.id,
                        imUserId: member.imUserId,
                        kind: member.kind,
                      },
                    ]
                  : [],
              )}
              messageFocusRequest={messageFocusRequest}
              messages={
                activeConversation.kind === "direct"
                  ? directMessages
                  : reviewMessages
              }
              onCreateTaskFromMessage={() => undefined}
              onNavigateSection={navigate}
              onLogout={() => undefined}
              onLocateSearchResult={(messageId) =>
                setMessageFocusRequest((current) => ({
                  messageId,
                  revision: (current?.revision ?? 0) + 1,
                }))
              }
              onOpenThread={() => undefined}
              onQuoteMessage={() => undefined}
              onReconnect={() => undefined}
              onRetryMessage={() => undefined}
              onSearchMessages={() => undefined}
              onSelectChannel={(channelId) =>
                setActiveConversation({ channelId, kind: "channel" })
              }
              onSelectDirect={(peerUserId) => {
                const conversation = directConversations.find(
                  (item) => item.peerUserId === peerUserId,
                );
                const member = members.find(
                  (item) => item.imUserId === peerUserId,
                );
                if (!member) return;
                setActiveConversation({
                  ...(conversation
                    ? {directConversationId: conversation.directConversationId}
                    : {}),
                  kind: "direct",
                  peerMemberId: member.id,
                  peerUserId,
                });
              }}
              onSelectServer={() => undefined}
              onSend={() => undefined}
              onToggleReaction={() => undefined}
              searchQuery="Agent"
              searchResults={[messages[1]!, messages[4]!]}
              serverAgents={reviewAgents}
              servers={[server]}
              viewportWidth={previewWidth}
            />
          ) : null}
          {preview === "tasks" ? (
            <TasksScreen
              agents={reviewAgents}
              currentAccount={account}
              currentServerId={server.id}
              error={
                scenario === "disconnected"
                  ? "消息连接已中断，请重新连接"
                  : null
              }
              inbox={reviewInbox}
              loading={false}
              imStatus={reviewImStatus}
              onCreateTask={() => undefined}
              onNavigateSection={navigate}
              onLogout={() => undefined}
              onRefresh={() => undefined}
              onSelectServer={() => undefined}
              onUpdateTask={() => undefined}
              pendingAction={null}
              servers={[server]}
              tasks={reviewTasks}
              viewportWidth={previewWidth}
            />
          ) : null}
          {preview === "agents" ? (
            <AgentsScreen
              agents={reviewAgents}
              canManage
              computers={reviewComputers}
              currentAccount={account}
              currentServerId={server.id}
              error={
                scenario === "disconnected"
                  ? "消息连接已中断，请重新连接"
                  : null
              }
              loading={false}
              imStatus={reviewImStatus}
              onCreateAgent={() => null}
              onNavigateSection={navigate}
              onLogout={() => undefined}
              onRefresh={() => undefined}
              onRotateCredential={() => null}
              onRunAgentAction={() => null}
              onSelectServer={() => undefined}
              onUpdateAgent={() => undefined}
              pendingAction={null}
              servers={[server]}
              viewportWidth={previewWidth}
            />
          ) : null}
          {preview === "computers" ? (
            <ComputersScreen
              agents={reviewAgents}
              canManage
              computers={reviewComputers}
              currentAccount={account}
              currentServerId={server.id}
              error={
                scenario === "disconnected"
                  ? "消息连接已中断，请重新连接"
                  : null
              }
              loading={false}
              imStatus={reviewImStatus}
              onCreateComputer={() => null}
              onCreateTerminalController={() =>
                createStyleLabTerminalController()
              }
              onNavigateSection={navigate}
              onLogout={() => undefined}
              onRefresh={() => undefined}
              onRequestRegistrationScript={() => null}
              onSelectServer={() => undefined}
              pendingAction={null}
              servers={[server]}
              viewportWidth={previewWidth}
            />
          ) : null}
          {preview === "members" ? (
            <MembersScreen
              accountId="stylelab-account-you"
              currentAccount={account}
              currentServerId={server.id}
              error={
                scenario === "disconnected"
                  ? "消息连接已中断，请重新连接"
                  : null
              }
              invites={[]}
              loading={false}
              imStatus={reviewImStatus}
              members={reviewMembers}
              onAcceptInvite={() => null}
              onCreateInvite={() => null}
              onNavigateSection={navigate}
              onLogout={() => undefined}
              onRefresh={() => undefined}
              onRemoveMember={() => undefined}
              onRevokeInvite={() => undefined}
              onSelectServer={() => undefined}
              onUpdateMember={() => undefined}
              pendingAction={null}
              servers={[server]}
              viewportWidth={previewWidth}
            />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

type Preview = "agents" | "chat" | "computers" | "members" | "tasks";
type ReviewScenario = "disconnected" | "empty" | "normal" | "unjoined";

const previewOptions: Array<{
  accessibilityLabel: string;
  id: Preview;
  label: string;
}> = [
  { accessibilityLabel: "预览聊天界面", id: "chat", label: "聊天" },
  { accessibilityLabel: "预览任务界面", id: "tasks", label: "任务" },
  { accessibilityLabel: "预览 Agent 界面", id: "agents", label: "Agent" },
  {
    accessibilityLabel: "预览 Computer 界面",
    id: "computers",
    label: "Computer",
  },
  { accessibilityLabel: "预览成员界面", id: "members", label: "成员" },
];

const scenarioOptions: Array<{
  accessibilityLabel: string;
  id: ReviewScenario;
  label: string;
}> = [
  { accessibilityLabel: "切换到正常状态", id: "normal", label: "正常" },
  { accessibilityLabel: "切换到空状态", id: "empty", label: "空状态" },
  {
    accessibilityLabel: "切换到断线状态",
    id: "disconnected",
    label: "断线",
  },
  {
    accessibilityLabel: "切换到未加入状态",
    id: "unjoined",
    label: "未加入",
  },
];

const canvasPresets: Array<{
  accessibilityLabel: string;
  id: string;
  label: string;
  width: number;
}> = [
  {
    accessibilityLabel: "切换到 320px 手机画布",
    id: "phone-320",
    label: "320",
    width: 320,
  },
  {
    accessibilityLabel: "切换到 390px 手机画布",
    id: "phone-390",
    label: "390",
    width: 390,
  },
  {
    accessibilityLabel: "切换到 768px 平板画布",
    id: "tablet-768",
    label: "768",
    width: 768,
  },
  {
    accessibilityLabel: "切换到 1024px 桌面画布",
    id: "desktop-1024",
    label: "1024",
    width: 1_024,
  },
  {
    accessibilityLabel: "切换到 1440px 桌面画布",
    id: "desktop-1440",
    label: "1440",
    width: 1_440,
  },
];

function humanMember(
  suffix: string,
  displayName: string,
  handle: string,
  role: "admin" | "member" | "owner",
): Member {
  return {
    accountId: `stylelab-account-${suffix}`,
    displayName,
    handle,
    id: `stylelab-member-${suffix}`,
    imState: "ready",
    imUserId: `stylelab-human-${handle}`,
    kind: "human",
    revision: 1,
    role,
    serverId: server.id,
    status: "active",
  };
}

function agentMember(agent: Agent): Member {
  return {
    displayName: agent.displayName,
    handle: agent.handle,
    id: `stylelab-member-${agent.handle}`,
    imState: "ready",
    imUserId: agent.imUserId,
    kind: "agent",
    revision: 1,
    role: "member",
    serverId: server.id,
    status: "active",
  };
}

function textMessage(
  id: string,
  senderId: string,
  senderName: string,
  createdAt: string,
  text: string,
): Message {
  return {
    content: { kind: "text", text },
    conversationId: "GROUPstylelab-topic-general",
    createdAt,
    delivery: { state: "sent" },
    direction: senderId === "stylelab-human-linmo" ? "outgoing" : "incoming",
    id,
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: { state: "unknown" },
    senderId,
    senderName,
    text,
  };
}

function createStyleLabTerminalController(): TerminalSurfaceController {
  const snapshot = {
    output: new TextEncoder().encode(
      "Last login: Sun Aug 2 10:31:00 on ttys001\r\n设计工作站 % ",
    ),
    status: "ready" as const,
    truncated: false,
  };

  return {
    close() {},
    async open() {},
    resize() {},
    sendControl() {},
    snapshot: () => snapshot,
    submitLine() {},
    subscribe(listener) {
      listener(snapshot);
      return () => undefined;
    },
    writeText() {},
  };
}

const styles = StyleSheet.create((theme) => ({
  canvas: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flexGrow: 0,
    flexShrink: 0,
    overflow: "hidden",
  },
  canvasButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    height: 32,
    justifyContent: "center",
    minWidth: 48,
    paddingHorizontal: theme.spacing.sm,
    ...theme.semantic.motion.transition.control,
  },
  canvasButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
    ...theme.semantic.motion.transition.control,
  },
  canvasButtonText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.navigationLabel,
    ...theme.semantic.motion.transition.control,
  },
  canvasButtonTextSelected: {
    color: theme.semantic.color.brandAccentStrong,
    ...theme.semantic.motion.transition.control,
  },
  canvasTabs: {
    flexGrow: 0,
    maxWidth: 258,
  },
  canvasTabsCompact: {
    maxWidth: "100%",
    width: "100%",
  },
  canvasTabsContent: {
    alignItems: "center",
    gap: theme.spacing.xs,
  },
  labCopy: {
    gap: theme.spacing.xxs,
    marginRight: theme.spacing.md,
    minWidth: 190,
  },
  labCopyCompact: {
    marginRight: 0,
    minWidth: 0,
  },
  labSubtitle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.caption,
  },
  labTitle: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.messageSender,
  },
  preview: {
    flex: 1,
    minHeight: 0,
  },
  previewContent: {
    alignItems: "flex-start",
    flexGrow: 1,
    justifyContent: "center",
  },
  previewButton: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing.lg,
    ...theme.semantic.motion.transition.control,
  },
  previewButtonCompact: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing.xs,
  },
  previewButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: velaTheme.semantic.color.borderInteractive,
    ...theme.semantic.motion.transition.control,
  },
  previewButtonText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmallEmphasis,
    ...theme.semantic.motion.transition.control,
  },
  previewButtonTextSelected: {
    color: theme.semantic.color.brandAccentStrong,
    ...theme.semantic.motion.transition.control,
  },
  previewTabs: {
    flex: 1,
  },
  previewTabsCompact: {
    flexGrow: 0,
    minHeight: 36,
    width: "100%",
  },
  previewTabsContent: {
    alignItems: "center",
    flexGrow: 1,
    gap: theme.spacing.sm,
  },
  previewTabsContentCompact: {
    paddingRight: 0,
  },
  screen: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flex: 1,
  },
  scenarioButton: {
    alignItems: "center",
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: 30,
    paddingHorizontal: theme.spacing.md,
    ...theme.semantic.motion.transition.control,
  },
  scenarioButtonSelected: {
    backgroundColor: theme.semantic.color.selectionSurface,
    ...theme.semantic.motion.transition.control,
  },
  scenarioButtonText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.captionEmphasis,
    ...theme.semantic.motion.transition.control,
  },
  scenarioButtonTextSelected: {
    color: theme.semantic.color.brandAccentStrong,
    ...theme.semantic.motion.transition.control,
  },
  scenarioTabs: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexGrow: 0,
    minHeight: 42,
  },
  scenarioTabsContent: {
    alignItems: "center",
    gap: theme.spacing.xs,
    paddingHorizontal: theme.spacing.lg,
  },
  toolbar: {
    backgroundColor: theme.semantic.color.paneSurface,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexGrow: 0,
  },
  toolbarContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.sm,
    minHeight: 72,
    paddingHorizontal: theme.spacing.lg,
  },
  toolbarContentCompact: {
    alignItems: "stretch",
    flexDirection: "column",
    minHeight: 144,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
}));
