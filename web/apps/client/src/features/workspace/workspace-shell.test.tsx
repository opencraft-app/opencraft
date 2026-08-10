import {createComposerTextDocument} from "@vela/client-core";
import type {
  Account,
  ActiveConversation,
  Agent,
  Channel,
  DirectConversation,
  Member,
  Message,
  MessageThread,
  Operation,
  Server,
} from "@vela/client-core";
import {act, fireEvent, render, within} from "@testing-library/react-native";
import { cloneElement, type ReactElement } from "react";
import {Text} from "react-native";

jest.mock("../../ui/components/composer-editor", () => {
  const React = require("react") as typeof import("react");
  const {TextInput} = require("react-native") as typeof import("react-native");
  const core = require("@vela/client-core") as typeof import("@vela/client-core");
  return {
    ComposerEditor: React.forwardRef(function MockComposerEditor(
      props: {
        disabled?: boolean;
        document: import("@vela/client-core").ComposerDocument;
        onSnapshotChange(value: unknown): void;
        onSubmit(value: unknown): void;
        placeholder: string;
      },
      ref: React.ForwardedRef<{
        focus(): void;
        replaceDocument(value: import("@vela/client-core").ComposerDocument): void;
        requestSubmit(): void;
      }>,
    ) {
      const [document, setDocument] = React.useState(props.document);
      const latest = React.useRef(document);
      latest.current = document;
      React.useEffect(() => setDocument(props.document), [props.document]);
      React.useImperativeHandle(ref, () => ({
        focus() {},
        replaceDocument(value) {
          latest.current = value;
          setDocument(value);
        },
        requestSubmit() {
          props.onSubmit({
            document: latest.current,
            selection: null,
            text: core.composerDocumentText(latest.current),
          });
        },
      }));
      return (
        <TextInput
          accessibilityLabel="消息内容"
          editable={!props.disabled}
          onBlur={() => undefined}
          onChangeText={(text) => {
            const next = core.createComposerTextDocument(text);
            latest.current = next;
            setDocument(next);
            props.onSnapshotChange({document: next, selection: null, text});
          }}
          placeholder={props.placeholder}
          value={core.composerDocumentText(document)}
        />
      );
    }),
  };
});
import {
  NavigationLinkProvider,
  PresentationProvider,
  pointerDensity,
  type ConversationPageModel,
  type HumanClientPresenter,
  type NavigationLinkProps,
  velaTheme,
} from "@/ui";
import { WorkspaceShell } from "./workspace-shell";

const server: Server = {
  id: "server-1",
  description: "Agent 协作空间",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
};

const secondServer: Server = {
  ...server,
  id: "server-2",
  name: "Beta",
  slug: "beta",
};

const account: Account = {
  displayName: "Skip",
  email: "skip@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
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

const message: Message = {
  content: { kind: "text", text: "已完成。" },
  conversationId: "GROUPtopic-1",
  createdAt: "2026-07-31T10:00:00.000Z",
  delivery: { state: "sent" },
  direction: "incoming",
  id: "message-1",
  kind: "text",
  mentions: [],
  rawType: "TIMTextElem",
  reactions: [],
  read: { state: "unknown" },
  senderId: agent.imUserId,
  senderName: agent.displayName,
  text: "已完成。",
};

const channelOperation: Operation = {
  createdAt: "2026-08-01T03:00:00.000Z",
  id: "operation-channel-1",
  kind: "tencent.im.topic.create",
  service: "im",
  state: "retry_wait",
};

const ownerMember: Member = {
  accountId: "account-1",
  displayName: "Skip",
  handle: "skip",
  id: "member-owner",
  imState: "ready",
  imUserId: "human-1",
  kind: "human",
  revision: 1,
  role: "owner",
  serverId: server.id,
  status: "active",
};

const agentMember: Member = {
  displayName: agent.displayName,
  handle: agent.handle,
  id: "member-agent",
  imState: "ready",
  imUserId: agent.imUserId,
  kind: "agent",
  revision: 1,
  role: "member",
  serverId: server.id,
  status: "active",
};

const productMember: Member = {
  accountId: "account-product",
  displayName: "产品团队",
  handle: "product-team",
  id: "member-product",
  imState: "ready",
  imUserId: "human-product",
  kind: "human",
  revision: 1,
  role: "member",
  serverId: server.id,
  status: "active",
};

const directConversation: DirectConversation = {
  conversationId: "GROUPan_dm_direct_1",
  directConversationId: "direct-1",
  imGroupId: "an_dm_direct_1",
  imState: "ready",
  lastMessageAt: "2026-07-31T10:00:00.000Z",
  lastMessagePreview: "已完成。",
  peerDisplayName: "研究助手",
  peerMemberId: agentMember.id,
  peerUserId: "agent-im-1",
  unreadCount: 2,
};

const directActive: ActiveConversation = {
  directConversationId: directConversation.directConversationId,
  kind: "direct",
  peerMemberId: directConversation.peerMemberId,
  peerUserId: "agent-im-1",
};

const duplicateAgentMemberA: Member = {
  ...agentMember,
  displayName: "444",
  handle: "44",
  id: "member-agent-44",
  imUserId: "agent-im-44",
};

const duplicateAgentMemberB: Member = {
  ...agentMember,
  displayName: "444",
  handle: "123",
  id: "member-agent-123",
  imUserId: "agent-im-123",
};

const duplicateDirectConversationA: DirectConversation = {
  ...directConversation,
  conversationId: "GROUPan_dm_direct_44",
  directConversationId: "direct-44",
  imGroupId: "an_dm_direct_44",
  peerDisplayName: "444",
  peerMemberId: duplicateAgentMemberA.id,
  peerUserId: "agent-im-44",
};

const duplicateDirectConversationB: DirectConversation = {
  ...directConversation,
  conversationId: "GROUPan_dm_direct_123",
  directConversationId: "direct-123",
  imGroupId: "an_dm_direct_123",
  peerDisplayName: "444",
  peerMemberId: duplicateAgentMemberB.id,
  peerUserId: "agent-im-123",
};

function countLegacyPointerEvents(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce(
      (total, child) => total + countLegacyPointerEvents(child),
      0,
    );
  }
  if (!node || typeof node !== "object") return 0;
  const candidate = node as {
    children?: unknown;
    props?: {pointerEvents?: unknown};
  };
  return (
    (candidate.props?.pointerEvents === "none" ? 1 : 0) +
    countLegacyPointerEvents(candidate.children)
  );
}

describe("WorkspaceShell", () => {
  it("publishes conversations, messages and composer through the semantic presenter", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text testID="semantic-conversation-presenter">{value.header.title}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onSend = jest.fn();
    const onSelectChannel = jest.fn();
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          account={account}
          activeConversation={{channelId: channel.id, kind: "channel"}}
          agents={[agent]}
          channels={[channel]}
          conversationDrafts={{
            [`channel:${channel.id}`]: {
              attachments: [],
              document: createComposerTextDocument("@research 请继续"),
            },
          }}
          currentChannelId={channel.id}
          currentServerId={server.id}
          imStatus="ready"
          messages={[message]}
          onDraftChange={jest.fn()}
          onSelectChannel={onSelectChannel}
          onSelectServer={jest.fn()}
          onSend={onSend}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    expect(screen.getByTestId("semantic-conversation-presenter").props.children).toBe("# general");
    const model = captured.model;
    expect(model).toBeDefined();
    if (!model) throw new Error("semantic conversation model missing");
    expect(model.conversations).toHaveLength(1);
    expect(model.messages[0]?.text).toBe("已完成。");
    await model.conversations[0]?.onSelect();
    await model.composer.onSend();
    expect(onSelectChannel).toHaveBeenCalledWith(channel.id);
    expect(onSend).toHaveBeenCalledWith({
      attachments: [],
      document: createComposerTextDocument("@research 请继续"),
    });
  });

  it("keeps terminal search and local attachment form state in the shared screen", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text testID="semantic-conversation-form">{value.form?.title ?? "idle"}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onAttachLocalPath = jest.fn();
    const onSearchMessages = jest.fn();
    await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          activeConversation={{channelId: channel.id, kind: "channel"}}
          agents={[agent]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          imStatus="ready"
          messages={[]}
          onAttachLocalPath={onAttachLocalPath}
          onSearchMessages={onSearchMessages}
          onSelectChannel={jest.fn()}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          servers={[server]}
        />
      </PresentationProvider>,
    );
    if (!captured.model) throw new Error("semantic conversation model missing");
    await act(async () => {
      await captured.model?.commands.find(item => item.id === "search")?.run();
    });
    expect(captured.model?.form?.title).toBe("搜索消息");
    await act(async () => {
      captured.model?.form?.fields[0]?.onChange("Agent 回复");
    });
    await act(async () => {
      await captured.model?.form?.actions.find(item => item.id === "submit")?.run();
    });
    expect(onSearchMessages).toHaveBeenCalledWith("Agent 回复");

    await act(async () => {
      await captured.model?.composer.actions.find(item => item.id === "attach-file")?.run();
    });
    expect(captured.model?.form?.title).toBe("添加文件");
    await act(async () => {
      captured.model?.form?.fields[0]?.onChange("/tmp/report.txt");
    });
    await act(async () => {
      await captured.model?.form?.actions.find(item => item.id === "submit")?.run();
    });
    expect(onAttachLocalPath).toHaveBeenCalledWith({
      kind: "file",
      path: "/tmp/report.txt",
    });
  });

  it("publishes Server switching through the shared shell model", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text>{value.header.title}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onSelectServer = jest.fn();
    await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          agents={[]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          imStatus="ready"
          messages={[]}
          onSelectChannel={jest.fn()}
          onSelectServer={onSelectServer}
          onSend={jest.fn()}
          servers={[server, secondServer]}
        />
      </PresentationProvider>,
    );

    const serverOptions = (captured.model?.shell as unknown as {
      serverOptions?: Array<{id: string; onSelect(): unknown; selected: boolean}>;
    } | undefined)?.serverOptions;
    expect(serverOptions?.map((item) => [item.id, item.selected])).toEqual([
      [server.id, true],
      [secondServer.id, false],
    ]);
    await serverOptions?.[1]?.onSelect();
    expect(onSelectServer).toHaveBeenCalledWith(secondServer.id);
  });

  it("publishes Channel create, edit and membership forms through shared actions", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text>{value.form?.title ?? value.header.title}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onAddChannelMember = jest.fn();
    const onCreateChannel = jest.fn(async () => null);
    const onOpenChannelManagement = jest.fn();
    const onUpdateChannel = jest.fn();
    await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          account={account}
          activeConversation={{channelId: channel.id, kind: "channel"}}
          agents={[]}
          canManageChannels
          channelMembers={[ownerMember]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          imStatus="ready"
          members={[ownerMember, productMember]}
          messages={[]}
          onAddChannelMember={onAddChannelMember}
          onCreateChannel={onCreateChannel}
          onOpenChannelManagement={onOpenChannelManagement}
          onSelectChannel={jest.fn()}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          onUpdateChannel={onUpdateChannel}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await captured.model?.commands.find((item) => item.id === "create-channel")?.run();
    });
    expect(captured.model?.form?.title).toBe("新建 Channel");
    await act(async () => {
      captured.model?.form?.fields.find((field) => field.id === "channel-name")?.onChange("研发");
      captured.model?.form?.fields.find((field) => field.id === "visibility")?.onChange("private");
    });
    await act(async () => {
      await captured.model?.form?.actions.find((item) => item.id === "submit")?.run();
    });
    expect(onCreateChannel).toHaveBeenCalledWith({
      name: "研发",
      visibility: "private",
    });

    await act(async () => {
      await captured.model?.commands.find((item) => item.id === "edit-channel")?.run();
    });
    expect(captured.model?.form?.fields.find((field) => field.id === "channel-name")?.value).toBe("general");
    await act(async () => {
      captured.model?.form?.fields.find((field) => field.id === "channel-name")?.onChange("general-2");
    });
    await act(async () => {
      await captured.model?.form?.actions.find((item) => item.id === "submit")?.run();
    });
    expect(onUpdateChannel).toHaveBeenCalledWith(channel.id, {
      name: "general-2",
      visibility: "public",
    });

    await act(async () => {
      await captured.model?.commands.find((item) => item.id === "manage-channel-members")?.run();
    });
    expect(onOpenChannelManagement).toHaveBeenCalled();
    expect(captured.model?.form?.title).toBe("管理 #general 成员");
    await act(async () => {
      await captured.model?.form?.actions.find((item) => item.id === `add-${productMember.id}`)?.run();
    });
    expect(onAddChannelMember).toHaveBeenCalledWith(productMember.id);
  });

  it("publishes a new-DM picker using eligible Server member identities", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text>{value.form?.title ?? value.header.title}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onSelectDirect = jest.fn();
    await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          account={account}
          agents={[agent]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          directConversations={[directConversation]}
          imStatus="ready"
          members={[ownerMember, agentMember, productMember]}
          messages={[]}
          onSelectChannel={jest.fn()}
          onSelectDirect={onSelectDirect}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await captured.model?.commands.find((item) => item.id === "new-direct")?.run();
    });
    expect(captured.model?.form?.title).toBe("新建私信");
    expect(captured.model?.form?.actions.map((item) => item.id)).toContain(`direct-${productMember.id}`);
    expect(captured.model?.form?.actions.map((item) => item.id)).not.toContain(`direct-${agentMember.id}`);
    await act(async () => {
      await captured.model?.form?.actions.find((item) => item.id === `direct-${productMember.id}`)?.run();
    });
    expect(onSelectDirect).toHaveBeenCalledWith(productMember.imUserId);
  });

  it("publishes recall only for an outgoing Human message", async () => {
    const captured: {model?: ConversationPageModel} = {};
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(value) {
        captured.model = value;
        return <Text>{value.header.title}</Text>;
      },
      renderManagementPage(_value, fallback) {
        return fallback;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const onRevokeMessage = jest.fn();
    const outgoing = {
      ...message,
      direction: "outgoing" as const,
      senderId: account.imUserId ?? account.id,
      senderName: account.displayName,
    };
    const incoming = {...message, id: "incoming-message-2"};
    await render(
      <PresentationProvider presenter={presenter}>
        <WorkspaceShell
          {...({onRevokeMessage} as Record<string, unknown>)}
          account={account}
          activeConversation={{channelId: channel.id, kind: "channel"}}
          agents={[]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          imStatus="ready"
          messages={[outgoing, incoming]}
          onSelectChannel={jest.fn()}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    const ownActions = captured.model?.messages.find(item => item.id === outgoing.id)?.actions;
    const incomingActions = captured.model?.messages.find(item => item.id === incoming.id)?.actions;
    expect(ownActions?.map(item => item.id)).toContain("revoke");
    expect(incomingActions?.map(item => item.id)).not.toContain("revoke");
    await ownActions?.find(item => item.id === "revoke")?.run();
    expect(onRevokeMessage).toHaveBeenCalledWith(outgoing.id);
  });

  it("renders Server, section, Channel and DM navigation as canonical links", async () => {
    function MockNavigationLink({ children, href }: NavigationLinkProps) {
      return cloneElement(children as ReactElement<{ testID?: string }>, {
        testID: `href:${href}`,
      });
    }
    const screen = await render(
      <NavigationLinkProvider component={MockNavigationLink}>
        <WorkspaceShell
          agents={[agent]}
          channelHref={(item) => `/s/atlas/c/${item.id}`}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          directConversations={[directConversation]}
          directHref={(peerUserId) => `/dm/${peerUserId}`}
          imStatus="ready"
          messages={[message]}
          onSelectChannel={jest.fn()}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          sectionHref={(section) => `/s/atlas/${section}`}
          serverHref={(item) => `/s/${item.slug}`}
          servers={[server]}
          viewportWidth={1_280}
        />
      </NavigationLinkProvider>,
    );

    expect(screen.getByTestId("href:/s/atlas").props.accessibilityRole).toBe(
      "link",
    );
    expect(
      screen.getByTestId("href:/s/atlas/c/channel-1").props.accessibilityRole,
    ).toBe("link");
    expect(
      Array.isArray(
        screen.getByTestId("href:/s/atlas/c/channel-1").props.style,
      ),
    ).toBe(false);
    expect(screen.getByTestId("href:/s/atlas/c/channel-1")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.selectionSurface,
      flexDirection: "row",
      minHeight: velaTheme.recipes.control.rowHeight,
    });
    expect(
      screen.getByTestId("href:/dm/agent-im-1").props.accessibilityRole,
    ).toBe("link");
    expect(
      screen.getByTestId("href:/s/atlas/tasks").props.accessibilityRole,
    ).toBe("link");
    expect(countLegacyPointerEvents(screen.toJSON())).toBe(0);
  });

  it("renders the Vela Server, Channel and Message hierarchy on wide screens", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("server-rail")).toBeVisible();
    expect(screen.getByTestId("agent-network-mark")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.identity.brandMarkCompactSize,
      width: velaTheme.recipes.identity.brandMarkCompactSize,
    });
    expect(screen.getByText("AN")).toBeVisible();
    expect(screen.getByTestId("rail-icon-chat")).toBeVisible();
    expect(screen.getByTestId("rail-icon-tasks")).toBeVisible();
    expect(screen.getByTestId("rail-icon-agents")).toBeVisible();
    expect(screen.getByTestId("rail-section-agents")).toBeVisible();
    expect(screen.getByTestId("rail-icon-computers")).toBeVisible();
    expect(screen.getByTestId("rail-icon-members")).toBeVisible();
    expect(screen.queryByText("□")).toBeNull();
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.queryByText("◎")).toBeNull();
    expect(screen.queryByText("▣")).toBeNull();
    expect(screen.getByTestId("conversation-sidebar")).toBeVisible();
    expect(screen.getByTestId("message-stage")).toBeVisible();
    expect(screen.getByText("频道")).toBeVisible();
    expect(screen.queryByText("CHAT")).toBeNull();
    expect(screen.getByText("Atlas")).toBeVisible();
    expect(screen.getByText("2 位成员 · 1 个 Agent")).toBeVisible();
    expect(screen.getByPlaceholderText("搜索频道、私信与成员")).toBeVisible();
    expect(screen.getByText("1 个 Agent 在线")).toBeVisible();
    expect(screen.getByText("还没有私信。")).toHaveStyle({
      paddingHorizontal: 8,
    });
    expect(
      screen.getAllByText("Human 与 Agent 的日常协作").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText("公开频道 · Human 与 Agent 的日常协作"),
    ).toBeVisible();
    expect(screen.getAllByText("general").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("已完成。")).toBeVisible();
    expect(screen.getByText("研究助手")).toBeVisible();
    expect(screen.getByTestId("message-actor-badge-message-1")).toHaveTextContent(
      "Agent",
    );
  });

  it("keeps ordinary public channels visibly distinct from private channels and the all-members root", async () => {
    const rootChannel: Channel = {
      ...channel,
      id: "channel-all",
      name: "全员",
      systemKey: "all",
    };
    const privateChannel: Channel = {
      ...channel,
      id: "channel-private",
      name: "管理组",
      visibility: "private",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[rootChannel, channel, privateChannel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(
      within(screen.getByTestId("channel-row-channel-all")).getByText("系统"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("channel-row-channel-1")).getByText("公开"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("channel-row-channel-private")).getByText(
        "私密",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("公开频道 · Human 与 Agent 的日常协作"),
    ).toBeVisible();
  });

  it("keeps the active public Channel type visible in compact mode", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByText("Atlas · 公开频道")).toBeVisible();
  });

  it("closes message actions when the composer receives focus", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    if (pointerDensity) {
      await fireEvent.press(
        screen.getByRole("button", {name: "更多消息操作 已完成。"}),
      );
    } else {
      await fireEvent(screen.getByTestId("message-message-1"), "longPress");
    }
    expect(screen.getByTestId("message-actions-message-1")).toBeVisible();

    await fireEvent(screen.getByLabelText("消息内容"), "focus");
    expect(screen.queryByTestId("message-actions-message-1")).toBeNull();
  });

  it("distinguishes an empty search result from an actually empty Server", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("搜索频道、私信与成员"),
      "notfound",
    );

    expect(screen.getByText("没有匹配的会话。")).toBeVisible();
    expect(screen.getByText("换个关键词试试。")).toBeVisible();
    expect(screen.queryByText("没有匹配的 Channel。")).toBeNull();
    expect(screen.queryByText("没有匹配的私信。")).toBeNull();
    expect(screen.queryByText("这个 Server 还没有 Channel。")).toBeNull();
    expect(screen.queryByText("还没有私信。")).toBeNull();
  });

  it("labels the conversation filter honestly and lets the user clear it", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    const filter = screen.getByPlaceholderText("搜索频道、私信与成员");
    expect(screen.queryByText("⌘ K")).toBeNull();
    await fireEvent.changeText(filter, "notfound");
    await fireEvent.press(screen.getByRole("button", { name: "清除会话搜索" }));

    expect(filter).toHaveProp("value", "");
    expect(screen.getAllByText("general")[0]).toBeVisible();
    expect(screen.getAllByText("研究助手")[0]).toBeVisible();
  });

  it("finds a Server member directly from wide conversation search", async () => {
    const onSelectDirect = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember, productMember]}
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectDirect={onSelectDirect}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("搜索频道、私信与成员"),
      "产品",
    );

    expect(screen.getByText("成员")).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "私信 产品团队 @product-team"}),
    );
    expect(onSelectDirect).toHaveBeenCalledTimes(1);
    expect(onSelectDirect).toHaveBeenCalledWith("human-product");
    expect(
      screen.queryByRole("button", {name: "私信 产品团队 @product-team"}),
    ).toBeNull();
  });

  it("does not duplicate a member already represented by a DM search result", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember, productMember]}
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.changeText(
      screen.getByPlaceholderText("搜索频道、私信与成员"),
      "研究",
    );

    expect(screen.getAllByText("研究助手")[0]).toBeVisible();
    expect(screen.getByText("Agent · @research")).toBeVisible();
    expect(
      screen.queryByRole("button", {name: "私信 研究助手 @research"}),
    ).toBeNull();
  });

  it("keeps Channel management in compact section actions", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        canManageChannels
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("channel-create-action")).toHaveStyle({
      height: velaTheme.recipes.control.squareSize,
      width: velaTheme.recipes.control.squareSize,
    });
    expect(screen.getByTestId("channel-edit-action")).toHaveStyle({
      height: velaTheme.recipes.control.squareSize,
      width: velaTheme.recipes.control.squareSize,
    });
    expect(screen.queryByText("＋ 新建")).toBeNull();
    expect(screen.queryByText("✎ 编辑")).toBeNull();
  });

  it("renders a guided wide-screen empty state without the legacy 00 counter", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.queryByText("00")).toBeNull();
    expect(screen.getByText("从这里开始协作")).toBeVisible();
    expect(
      screen.getByText("发送第一条消息，或 @Agent 分配一项工作。"),
    ).toBeVisible();
  });

  it("shows a history loading state instead of a false empty conversation", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        initializingMessages
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByLabelText("正在加载消息历史")).toBeVisible();
    expect(screen.queryByText("从这里开始协作")).toBeNull();
    expect(screen.getByLabelText("消息内容")).toHaveProp("editable", false);
  });

  it("does not advertise Agent actions when the Server has no Agent", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("暂无在线 Agent")).toBeVisible();
    expect(screen.getByText("发送第一条消息，开始与成员协作。")).toBeVisible();
    expect(
      screen.queryByText("发送第一条消息，或 @Agent 分配一项工作。"),
    ).toBeNull();
  });

  it("uses a neutral status when Agents exist but none are online", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[
          {
            ...agent,
            availability: "offline",
            desiredState: "stopped",
            imPresence: "offline",
            imTransportState: "disconnected",
            observedState: "stopped",
          },
        ]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("0 个 Agent 在线")).toHaveStyle({
      color: "#71717A",
    });
    expect(screen.getByTestId("online-agents-badge")).toHaveStyle({
      backgroundColor: "transparent",
    });
    expect(screen.getByTestId("online-agents-dot")).toHaveStyle({
      backgroundColor: "#D4D4D8",
    });
  });

  it("shows the current Channel asynchronous operation and can continue polling", async () => {
    const onContinueOperation = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onContinueOperation={onContinueOperation}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        operations={[
          {
            operation: channelOperation,
            pollingState: "timed_out",
            resourceId: channel.id,
          },
        ]}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("等待重试")).toBeVisible();
    fireEvent.press(
      screen.getByRole("button", {
        name: "继续查询操作 operation-channel-1",
      }),
    );
    expect(onContinueOperation).toHaveBeenCalledWith(channelOperation.id);
  });

  it("renders a Server 内私信 group under Channels and hides Channel-only actions", async () => {
    const onSelectDirect = jest.fn();
    const directMessage: Message = {
      ...message,
      conversationId: directConversation.conversationId,
    };
    const ownDirectMessage: Message = {
      ...directMessage,
      createdAt: "2026-07-31T10:02:00.000Z",
      direction: "outgoing",
      id: "direct-own-message",
      read: {state: "read"},
      senderId: "human-1",
      senderName: account.displayName,
      text: "我会继续处理。",
      content: {kind: "text", text: "我会继续处理。"},
    };
    const screen = await render(
      <WorkspaceShell
        activeConversation={directActive}
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[directMessage, ownDirectMessage]}
        onSelectChannel={jest.fn()}
        onSelectDirect={onSelectDirect}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        serverAgents={[agent]}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("私信")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText("2 位成员 · 1 个 Agent")).toBeVisible();
    expect(screen.getAllByText("研究助手").length).toBeGreaterThan(0);
    expect(screen.getByText("Agent · @research")).toBeVisible();
    expect(screen.queryByText("@ 研究助手")).toBeNull();
    expect(screen.getByPlaceholderText("发消息")).toBeVisible();
    expect(screen.getByLabelText("Agent 研究助手")).toBeVisible();
    expect(screen.getByTestId("message-direct-own-message")).toHaveStyle({
      flexDirection: "row",
    });
    expect(screen.getByTestId("message-sender-direct-own-message")).toHaveTextContent("我");
    expect(screen.getByText("已读")).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "在 Thread 回复 已完成。",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "将消息转为 Task 已完成。",
      }),
    ).toBeNull();
    expect(screen.queryByText("@研究助手")).toBeNull();
    expect(
      screen.queryByRole("button", {name: "提及 Agent"}),
    ).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {
        name: "打开私信 研究助手 @research",
      }),
    );
    expect(onSelectDirect).toHaveBeenCalledWith("agent-im-1");
  });

  it("uses stable Agent handles to distinguish duplicate DM display names", async () => {
    const screen = await render(
      <WorkspaceShell
        activeConversation={{kind: "direct", peerMemberId: duplicateAgentMemberA.id, peerUserId: "agent-im-44"}}
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[
          duplicateDirectConversationA,
          duplicateDirectConversationB,
        ]}
        imStatus="ready"
        members={[ownerMember, duplicateAgentMemberA, duplicateAgentMemberB]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(
      screen.getByRole("button", {name: "打开私信 444 @44"}),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "打开私信 444 @123"}),
    ).toBeVisible();
    expect(screen.getByText("Agent 私信 · @44")).toBeVisible();
    expect(screen.getByText("Agent · @44")).toBeVisible();
    expect(screen.getByText("Agent · @123")).toBeVisible();
  });

  it("keeps duplicate DM identities distinct in the compact picker", async () => {
    const screen = await render(
      <WorkspaceShell
        activeConversation={{kind: "direct", peerMemberId: duplicateAgentMemberA.id, peerUserId: "agent-im-44"}}
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[
          duplicateDirectConversationA,
          duplicateDirectConversationB,
        ]}
        imStatus="ready"
        members={[ownerMember, duplicateAgentMemberA, duplicateAgentMemberB]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByText("Agent 私信 · @44")).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    expect(
      screen.getByRole("button", {name: "打开私信 444 @44"}),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "打开私信 444 @123"}),
    ).toBeVisible();
  });

  it("resolves a new DM title from the matching member before conversation sync", async () => {
    const screen = await render(
      <WorkspaceShell
        activeConversation={directActive}
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByText("研究助手")).toBeVisible();
    expect(screen.getByText("Agent 私信 · @research")).toBeVisible();
    expect(screen.queryByText("@ agent-im-1")).toBeNull();
    expect(screen.getByPlaceholderText("发消息")).toBeVisible();
  });

  it("starts a DM only from ready Server members and excludes the current Human", async () => {
    const onSelectDirect = jest.fn();
    const unavailable: Member = {
      ...agentMember,
      displayName: "离线 Agent",
      id: "member-agent-offline",
      imState: "provisioning",
      imUserId: "agent-offline",
    };
    const screen = await render(
      <WorkspaceShell
        activeConversation={{
          channelId: channel.id,
          kind: "channel",
        }}
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember, unavailable]}
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectDirect={onSelectDirect}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "新建私信" }));

    expect(screen.queryByRole("button", { name: "私信 Skip @skip" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "私信 离线 Agent @research" }),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "私信 研究助手 @research" }),
    );
    expect(onSelectDirect).toHaveBeenCalledWith("agent-im-1");
  });

  it("uses an explicit wide empty state when every ready member already has a DM", async () => {
    const onNavigateSection = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[message]}
        onNavigateSection={onNavigateSection}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "新建私信" }));

    expect(screen.getByText("暂无新的私信对象")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭新建私信" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "私信 研究助手 @research" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "前往成员页" }));
    expect(onNavigateSection).toHaveBeenCalledWith("members");
  });

  it("turns desktop new-DM creation into a focused UserPicker task", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember, productMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("button", {name: "新建私信"}));

    expect(screen.getByLabelText("搜索私信对象")).toBeVisible();
    expect(screen.getByText("可私信")).toBeVisible();
    expect(
      screen.queryByLabelText("搜索频道、私信与成员"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {name: "打开 Channel general"}),
    ).toBeNull();
    expect(
      screen.getByRole("button", {name: "私信 产品团队 @product-team"}),
    ).toHaveTextContent(/自然人/u);

    await fireEvent.press(
      screen.getByRole("button", {name: "关闭新建私信"}),
    );
    expect(screen.getByLabelText("搜索频道、私信与成员")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "打开 Channel general"}),
    ).toBeVisible();
  });

  it("uses a dedicated compact context while choosing a new DM", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        canManageChannels
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "打开 Server 与 Channel" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "新建私信" }));

    expect(screen.getByText("新建私信")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭新建私信" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "搜索当前 Channel" }),
    ).toBeNull();
    expect(screen.queryByTestId("compact-header-menu-icon")).toBeNull();
    expect(screen.queryByTestId("compact-header-edit-icon")).toBeNull();
  });

  it("filters compact DM candidates by display name or handle", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember, productMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    await fireEvent.press(screen.getByRole("button", {name: "新建私信"}));
    const filter = screen.getByPlaceholderText("搜索成员或 @handle");
    expect(filter).not.toHaveProp("autoFocus", true);
    await fireEvent.changeText(filter, "product-team");

    expect(
      screen.getByRole("button", {name: "私信 产品团队 @product-team"}),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {name: "私信 研究助手 @research"}),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "清除私信对象搜索"}),
    );
    expect(
      screen.getByRole("button", {name: "私信 研究助手 @research"}),
    ).toBeVisible();
  });

  it("distinguishes an empty compact DM search from having no eligible members", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    await fireEvent.press(screen.getByRole("button", {name: "新建私信"}));
    await fireEvent.changeText(
      screen.getByPlaceholderText("搜索成员或 @handle"),
      "不存在",
    );

    expect(screen.getByText("没有找到匹配的私信对象")).toBeVisible();
    expect(screen.queryByText("暂无新的私信对象")).toBeNull();
    expect(screen.queryByRole("button", {name: "前往成员页"})).toBeNull();
  });

  it("lets compact users search Channels, DMs and members without scrolling the whole directory", async () => {
    const releaseChannel = {
      ...channel,
      id: "channel-2",
      imTopicId: "topic-2",
      name: "release",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel, releaseChannel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    const filter = screen.getByPlaceholderText("搜索频道、私信与成员");

    await fireEvent.changeText(filter, "release");
    expect(screen.getByText("release")).toBeVisible();
    expect(screen.queryByText("general")).toBeNull();
    expect(screen.queryByText("研究助手")).toBeNull();

    await fireEvent.changeText(filter, "研究");
    expect(screen.getByText("研究助手")).toBeVisible();
    expect(screen.queryByText("release")).toBeNull();

    await fireEvent.changeText(filter, "没有这个会话");
    expect(screen.getByText("没有匹配的会话。")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "清除会话搜索"}),
    );
    expect(filter).toHaveProp("value", "");
    expect(screen.getByText("general")).toBeVisible();
    expect(screen.getByText("研究助手")).toBeVisible();
  });

  it("finds and opens a Server member from compact conversation search", async () => {
    const onSelectDirect = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember, productMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={onSelectDirect}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    const filter = screen.getByPlaceholderText("搜索频道、私信与成员");
    await fireEvent.changeText(filter, "产品");

    expect(
      screen.getByRole("button", {name: "私信 产品团队 @product-team"}),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "私信 产品团队 @product-team"}),
    );
    expect(onSelectDirect).toHaveBeenCalledTimes(1);
    expect(onSelectDirect).toHaveBeenCalledWith("human-product");
    expect(screen.queryByText("产品团队")).toBeNull();
  });

  it("uses the same compact empty state when existing DMs exhaust the candidates", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "打开 Server 与 Channel" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "新建私信" }));

    expect(screen.getByText("暂无新的私信对象")).toBeVisible();
    expect(screen.queryByRole("button", { name: "私信 研究助手 @research" })).toBeNull();
  });

  it("keeps new DM reachable and explains when no ready peer exists", async () => {
    const onNavigateSection = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember]}
        messages={[]}
        onNavigateSection={onNavigateSection}
        onSelectChannel={jest.fn()}
        onSelectDirect={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "新建私信" }));

    expect(screen.getByText("暂无新的私信对象")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭新建私信" })).toBeVisible();
    await fireEvent.press(screen.getByRole("button", { name: "前往成员页" }));
    expect(onNavigateSection).toHaveBeenCalledWith("members");
  });

  it("keeps account logout reachable from the wide workspace", async () => {
    const onLogoutWide = jest.fn();
    const wide = await render(
      <WorkspaceShell
        account={account}
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onLogout={onLogoutWide}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );
    expect(
      wide.getByRole("button", {name: "打开当前账号 Skip"}),
    ).toBeVisible();
    await fireEvent.press(
      wide.getByRole("button", {name: "打开当前账号 Skip"}),
    );
    expect(wide.getByText("skip@example.test")).toBeVisible();
    expect(wide.getByText("IM 已连接")).toBeVisible();
    await fireEvent.press(wide.getByRole("button", { name: "退出当前账号" }));
    expect(onLogoutWide).toHaveBeenCalledTimes(1);
  });

  it("keeps account logout reachable from the compact workspace", async () => {
    const onLogoutCompact = jest.fn();
    const compact = await render(
      <WorkspaceShell
        account={account}
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onLogout={onLogoutCompact}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );
    await fireEvent.press(
      compact.getByRole("button", { name: "打开 Server 与 Channel" }),
    );
    expect(compact.getByTestId("compact-conversation-picker")).toBeVisible();
    expect(compact.getByTestId("compact-account-summary")).toBeVisible();
    expect(compact.getByText("Skip")).toBeVisible();
    expect(compact.getByText("skip@example.test")).toBeVisible();
    expect(compact.getByText("IM 已连接")).toBeVisible();
    await fireEvent.press(
      compact.getByRole("button", { name: "退出当前账号" }),
    );
    expect(onLogoutCompact).toHaveBeenCalledTimes(1);
  });

  it("offers an explicit chat reconnect when Tencent IM is unavailable", async () => {
    const onReconnect = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="not_ready"
        imStatusMessage="消息连接已中断，请重新连接"
        messages={[]}
        onReconnect={onReconnect}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("连接中断")).toBeVisible();
    expect(screen.queryByText("NOT_READY")).toBeNull();
    expect(screen.getByText("消息连接已中断，请重新连接")).toBeVisible();
    await fireEvent.press(screen.getByRole("button", { name: "重新连接聊天" }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("renders a chat action failure as a dismissible toast", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        error="没有访问该 Work 资源的权限"
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    const toast = screen.getByTestId("chat-error-toast");
    expect(toast).toBeVisible();
    expect(toast.props.accessibilityRole).toBe("alert");
    expect(
      within(toast).getByText("没有访问该 Work 资源的权限"),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "关闭错误提示"}),
    );
    expect(screen.queryByTestId("chat-error-toast")).toBeNull();
  });

  it("automatically retires a chat action failure after eight seconds", async () => {
    jest.useFakeTimers();
    try {
      const screen = await render(
        <WorkspaceShell
          agents={[]}
          channels={[channel]}
          currentChannelId={channel.id}
          currentServerId={server.id}
          error="Thread 暂时无法打开"
          imStatus="ready"
          messages={[]}
          onSelectChannel={jest.fn()}
          onSelectServer={jest.fn()}
          onSend={jest.fn()}
          servers={[server]}
          viewportWidth={390}
        />,
      );

      expect(screen.getByTestId("chat-error-toast")).toBeVisible();
      await act(async () => {
        jest.advanceTimersByTime(8_000);
      });
      expect(screen.queryByTestId("chat-error-toast")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ["signed_out", "未连接"],
    ["issuing_session", "连接中"],
    ["logging_in", "连接中"],
    ["waiting_sdk_ready", "连接中"],
    ["kicked_out", "连接已断开"],
    ["error", "连接异常"],
  ] as const)("presents %s as a user-facing connection state", async (status, label) => {
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus={status}
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText(status.toUpperCase())).toBeNull();
  });

  it("keeps an uploading image media-first while showing live progress", async () => {
    const uploading: Message = {
      ...message,
      clientRequestId: "request-image-1",
      content: {
        kind: "image",
        name: "diagram.png",
        size: 456_789,
        url: "file:///private/diagram.png",
      },
      delivery: { progress: 0.4, state: "uploading" },
      id: "local:request-image-1",
      kind: "image",
      rawType: "local:image",
      text: "[图片]",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[uploading]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.queryByText("diagram.png")).toBeNull();
    expect(screen.getByText("上传 40%")).toBeVisible();
  });

  it("keeps older history and failed-message retry reachable in the feed", async () => {
    const onLoadOlder = jest.fn();
    const onRetryMessage = jest.fn();
    const failed: Message = {
      ...message,
      clientRequestId: "request-failed-1",
      delivery: {
        error: "网络暂时不可用",
        retryable: true,
        state: "failed",
      },
      id: "local:request-failed-1",
      text: "稍后重试",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        historyCompleted={false}
        imStatus="ready"
        messages={[failed]}
        onLoadOlder={onLoadOlder}
        onRetryMessage={onRetryMessage}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "加载更早消息" }));
    await fireEvent.press(
      screen.getByRole("button", { name: "重试消息 稍后重试" }),
    );

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onRetryMessage).toHaveBeenCalledWith("local:request-failed-1");
  });

  it("renders quoted context and exposes quote as a message action", async () => {
    const onQuoteMessage = jest.fn();
    const quoted: Message = {
      ...message,
      quote: {
        messageId: "root-1",
        preview: "先核对接口。",
        senderId: "human-2",
        senderName: "小林",
      },
      direction: "outgoing",
      read: { state: "read" },
      text: "按这个方案继续",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[quoted]}
        onQuoteMessage={onQuoteMessage}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("小林 · 先核对接口。")).toBeVisible();
    expect(screen.queryByText("已读")).toBeNull();
    if (pointerDensity) {
      await fireEvent.press(
        screen.getByRole("button", {name: "更多消息操作 按这个方案继续"}),
      );
    } else {
      await fireEvent(screen.getByTestId("message-message-1"), "longPress");
    }
    expect(screen.queryByText("已读")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {
        name: "引用消息 按这个方案继续",
      }),
    );
    expect(onQuoteMessage).toHaveBeenCalledWith("message-1");
  });

  it("opens Tencent cloud search and renders returned message results", async () => {
    const onSearchMessages = jest.fn();
    const onLocateSearchResult = jest.fn();
    const searchResult: Message = {
      ...message,
      id: "search-1",
      text: "搜索命中的协议讨论",
      content: {
        kind: "text",
        text: "搜索命中的协议讨论",
      },
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onLocateSearchResult={onLocateSearchResult}
        onSearchMessages={onSearchMessages}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        searchQuery="协议"
        searchResults={[searchResult]}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "搜索当前 Channel" }),
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("搜索消息"),
      "腾讯协议",
    );
    await fireEvent.press(screen.getByRole("button", { name: "执行消息搜索" }));

    expect(onSearchMessages).toHaveBeenCalledWith("腾讯协议");
    expect(screen.getByText("搜索命中的协议讨论")).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {
        name: "定位到消息 搜索命中的协议讨论",
      }),
    );
    expect(onLocateSearchResult).toHaveBeenCalledWith("search-1");
  });

  it("keeps search results actionable when locating one of them fails", async () => {
    const searchResult: Message = {
      ...message,
      id: "search-1",
      text: "搜索命中的协议讨论",
      content: {kind: "text", text: "搜索命中的协议讨论"},
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onLocateSearchResult={jest.fn()}
        onSearchMessages={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        searchLocateError="无法定位这条消息：网络暂时不可用"
        searchQuery="协议"
        searchResults={[searchResult]}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "搜索当前 Channel"}),
    );

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText("无法定位这条消息：网络暂时不可用")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "定位到消息 搜索命中的协议讨论",
      }),
    ).toBeEnabled();
  });

  it("distinguishes a completed empty search from the initial search hint", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSearchMessages={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        searchCompleted
        searchQuery="zzzz-no-result-2026"
        searchResults={[]}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "搜索当前 Channel" }),
    );

    expect(
      screen.getByText("没有找到与「zzzz-no-result-2026」相关的消息。"),
    ).toBeVisible();
    expect(screen.queryByText("输入关键词，搜索历史消息。")).toBeNull();
  });

  it("shows Channel and DM drafts in navigation and restores the active draft", async () => {
    const onDraftChange = jest.fn();
    const screen = await render(
      <WorkspaceShell
        activeConversation={{ channelId: channel.id, kind: "channel" }}
        agents={[agent]}
        channels={[channel]}
        conversationDrafts={{
          "channel:channel-1": {
            attachments: [],
            document: createComposerTextDocument("Channel 待发送内容"),
          },
          "direct:member-agent": {
            attachments: [],
            document: createComposerTextDocument("私信待发送内容"),
          },
        }}
        currentChannelId={channel.id}
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        messages={[]}
        onDraftChange={onDraftChange}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("[草稿] Channel 待发送内容")).toBeVisible();
    expect(screen.getByText("[草稿] 私信待发送内容")).toBeVisible();
    expect(screen.getByLabelText("消息内容")).toHaveProp(
      "value",
      "Channel 待发送内容",
    );

    await fireEvent.changeText(screen.getByLabelText("消息内容"), "继续补充");
    await fireEvent(screen.getByLabelText("消息内容"), "blur");
    expect(onDraftChange).toHaveBeenCalledWith({
      attachments: [],
      document: createComposerTextDocument("继续补充"),
    });
  });

  it("uses Tencent group summaries for Channel recovery while keeping drafts first", async () => {
    const unreadChannel = {...channel, id: "channel-2", imTopicId: "topic-2", name: "release"};
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel, unreadChannel]}
        conversationDrafts={{
          "channel:channel-1": {
            attachments: [],
            document: createComposerTextDocument("尚未发送的草稿"),
          },
        }}
        conversationSummaries={[
          {
            conversationId: "GROUPtopic-1",
            kind: "group",
            lastMessageAt: yesterday,
            lastMessagePreview: "这条消息应被草稿覆盖",
            title: "general",
            unreadCount: 0,
          },
          {
            conversationId: "GROUPtopic-2",
            kind: "group",
            lastMessageAt: yesterday,
            lastMessagePreview: "生产发布已经完成",
            title: "release",
            unreadCount: 108,
          },
        ]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("[草稿] 尚未发送的草稿")).toBeVisible();
    expect(screen.queryByText("这条消息应被草稿覆盖")).toBeNull();
    expect(screen.getByText("生产发布已经完成")).toBeVisible();
    expect(screen.getAllByText("昨天")).toHaveLength(2);
    expect(screen.getByText("99+")).toBeVisible();
  });

  it("renders a search failure as the only result state and clears it on close", async () => {
    const onClearMessageSearch = jest.fn();
    const screen = await render(
      <WorkspaceShell
        activeConversation={directActive}
        agents={[]}
        channels={[channel]}
        currentChannelId={null}
        currentServerId={server.id}
        directConversations={[directConversation]}
        imStatus="ready"
        messages={[]}
        onClearMessageSearch={onClearMessageSearch}
        onSearchMessages={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        searchCompleted={false}
        searchError="消息服务暂时不可用"
        searchQuery="。"
        searchResults={[]}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "搜索当前私信" }));

    expect(screen.getByText("消息服务暂时不可用")).toBeVisible();
    expect(screen.queryByText("加载更多")).toBeNull();
    expect(screen.queryByText("没有找到与「。」相关的消息。")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "关闭消息搜索" }));
    expect(onClearMessageSearch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("消息服务暂时不可用")).toBeNull();
  });

  it("uses message search as an exclusive compact task and restores chat on close", async () => {
    const searchResult: Message = {
      ...message,
      content: {kind: "text", text: "搜索结果消息"},
      id: "search-result-1",
      text: "搜索结果消息",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSearchMessages={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        searchQuery="结果"
        searchResults={[searchResult]}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("compact-header-search-icon")).toBeVisible();
    expect(screen.getByTestId("message-message-1")).toBeVisible();
    expect(screen.getByTestId("message-composer")).toBeVisible();
    expect(screen.getByTestId("mobile-bottom-nav")).toBeVisible();
    expect(screen.queryByText("搜索当前 Channel")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "搜索当前 Channel" }),
    );
    expect(
      screen.queryByRole("button", { name: "搜索当前 Channel" }),
    ).toBeNull();
    expect(screen.getByPlaceholderText("搜索消息")).toBeVisible();
    expect(screen.getByText("搜索结果消息")).toBeVisible();
    expect(screen.getByTestId("message-search-close-icon")).toBeVisible();
    expect(screen.queryByTestId("message-message-1")).toBeNull();
    expect(screen.queryByTestId("message-composer")).toBeNull();
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    expect(screen.queryByTestId("compact-header-menu-icon")).toBeNull();

    await fireEvent.press(screen.getByRole("button", {name: "关闭消息搜索"}));
    expect(screen.getByTestId("message-message-1")).toBeVisible();
    expect(screen.getByTestId("message-composer")).toBeVisible();
    expect(screen.getByTestId("mobile-bottom-nav")).toBeVisible();
    expect(screen.getByTestId("compact-header-menu-icon")).toBeVisible();
  });

  it("renders a Vela right-side Thread panel and keeps it independently closable", async () => {
    const onCloseThread = jest.fn();
    const onRetryMessage = jest.fn();
    const onRetryThreadReplyIndex = jest.fn();
    const onSendThreadReply = jest.fn();
    const root = {
      ...message,
      content: {kind: "text" as const, text: "这是根消息"},
      id: "root-message-1",
      reference: {
        kind: "group" as const,
        messageId: "root-message-1",
        sequence: 100,
        timestamp: 1_785_400_000,
      },
      text: "这是根消息",
    };
    const thread: MessageThread = {
      channelId: channel.id,
      createdAt: root.createdAt,
      id: "019fb45a-41bf-78d4-a5c0-a97b85046fc2",
      lastReplyAt: message.createdAt,
      replyCount: 1,
      rootMessageRef: {
        ...root.reference,
        groupId: channel.imGroupId,
        topicId: channel.imTopicId,
      },
      serverId: server.id,
      unreadCount: 0,
    };
    const reply = {
      ...message,
      content: { kind: "text" as const, text: "Thread 回复" },
      direction: "outgoing" as const,
      id: "reply-message-1",
      senderId: "human-1",
      senderName: account.displayName,
      text: "Thread 回复",
      thread: {
        role: "reply" as const,
        rootMessageRef: thread.rootMessageRef,
        threadId: thread.id,
      },
    };
    const failedReply: Message = {
      ...reply,
      content: {kind: "text", text: "Thread 失败"},
      createdAt: "2026-07-31T10:02:00.000Z",
      delivery: {error: "连接中断", retryable: true, state: "failed"},
      direction: "outgoing",
      id: "reply-message-failed",
      text: "Thread 失败",
    };
    const screen = await render(
      <WorkspaceShell
        activeThread={thread}
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId="human-1"
        currentServerId={server.id}
        imStatus="ready"
        messages={[root]}
        onCloseThread={onCloseThread}
        onRetryMessage={onRetryMessage}
        onRetryThreadReplyIndex={onRetryThreadReplyIndex}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        onSendThreadReply={onSendThreadReply}
        pendingThreadIndexMessageIds={["reply-message-1"]}
        servers={[server]}
        threadMessages={[reply, failedReply]}
        threadRootMessage={root}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("thread-panel")).toBeVisible();
    expect(screen.getByRole("button", { name: "关闭 Thread" })).toHaveStyle({
      height: velaTheme.recipes.control.squareSize,
      width: velaTheme.recipes.control.squareSize,
    });
    expect(screen.getByText("话题")).toBeVisible();
    expect(
      within(screen.getByTestId("thread-panel")).getByTestId("message-root-message-1"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("thread-panel")).getByText("这是根消息"),
    ).toBeVisible();
    expect(screen.getByText("Thread 回复")).toBeVisible();
    expect(screen.getByTestId("message-status-reply-message-1")).toHaveTextContent(/^等待收录/);
    expect(screen.getByText("发送失败 · 连接中断")).toBeVisible();
    if (pointerDensity) {
      await fireEvent.press(
        screen.getByRole("button", {name: "更多消息操作 Thread 回复"}),
      );
    } else {
      await fireEvent(
        screen.getByTestId("message-reply-message-1"),
        "longPress",
      );
    }
    expect(screen.getByTestId("message-actions-reply-message-1")).toBeVisible();
    await fireEvent(
      within(screen.getByTestId("thread-panel")).getByPlaceholderText("发消息"),
      "focus",
    );
    expect(
      screen.queryByTestId("message-actions-reply-message-1"),
    ).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", { name: "重新收录消息 Thread 回复" }),
    );
    expect(onRetryThreadReplyIndex).toHaveBeenCalledWith("reply-message-1");
    await fireEvent.press(
      screen.getByRole("button", {name: "重试消息 Thread 失败"}),
    );
    expect(onRetryMessage).toHaveBeenCalledWith("reply-message-failed");
    await fireEvent.press(screen.getByRole("button", { name: "关闭 Thread" }));
    expect(onCloseThread).toHaveBeenCalledTimes(1);
  });

  it("uses one restrained desktop workspace instead of three floating cards", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("workspace-shell")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.shellBackdrop,
      borderRadius: 0,
      borderWidth: 0,
      gap: 0,
      margin: 0,
      overflow: "hidden",
      padding: 0,
    });
    expect(screen.getByTestId("server-rail")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.navigationSurface,
      borderRadius: 0,
      borderRightWidth: 1,
      width: velaTheme.recipes.desktopWorkspace.railWidth,
    });
    expect(screen.getByTestId("agent-network-mark")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.identity.brandMarkCompactSize,
      width: velaTheme.recipes.identity.brandMarkCompactSize,
    });
    expect(screen.getByTestId("rail-navigation")).toHaveStyle({
      gap: 8,
      paddingTop: 12,
    });
    expect(screen.getByRole("button", { name: "打开聊天" })).toHaveStyle({
      height: velaTheme.recipes.desktopWorkspace.navigationControlSize,
      width: velaTheme.recipes.desktopWorkspace.navigationControlSize,
    });
    expect(screen.queryByTestId("server-marks")).toBeNull();
    expect(screen.getByTestId("conversation-sidebar")).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.sidebarSurface,
      borderRadius: 0,
      borderRightWidth: 1,
      width: 312,
    });
    expect(screen.getByRole("button", { name: "打开聊天" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "打开 Channel general" }),
    ).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.selectionSurface,
      borderRadius: velaTheme.semantic.radius.compactControl,
      borderWidth: 0,
    });
    expect(screen.getByTestId("channel-row-channel-1")).toHaveStyle({
      flexDirection: "row",
      minHeight: velaTheme.recipes.control.rowHeight,
    });
    expect(screen.getByTestId("channel-scroller")).toHaveStyle({
      flexGrow: 0,
      flexShrink: 0,
    });
    expect(screen.getByTestId("message-message-1")).toHaveStyle({
      alignSelf: "stretch",
      borderWidth: 0,
      width: "100%",
    });
    expect(screen.getByTestId("message-stage")).toHaveStyle({
      backgroundColor: "#FFFFFF",
      borderRadius: 0,
    });
    expect(screen.getByRole("button", { name: "打开聊天" })).toBeVisible();
  });

  it("keeps the rail Server switcher when more than one Server is available", async () => {
    const secondServer: Server = {
      ...server,
      id: "server-2",
      name: "Beta",
      slug: "beta",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server, secondServer]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("server-marks")).toHaveStyle({
      flexGrow: 0,
      maxHeight: 160,
    });
    expect(
      screen.getByRole("button", { name: "打开 Server Beta" }),
    ).toBeVisible();
  });

  it("keeps conversation navigation reachable in compact mode", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("mobile-bottom-nav")).toHaveStyle({
      height: 68,
    });
    expect(screen.getByText("聊天")).toHaveStyle({ fontSize: 10 });
    expect(screen.getByText("聊天").props.numberOfLines).toBe(1);
    for (const section of ["chat", "tasks", "agents", "computers", "members"]) {
      expect(screen.getByTestId(`mobile-nav-item-${section}`)).toHaveStyle({
        flex: 1,
        minWidth: 0,
      });
    }
    expect(screen.getByRole("button", { name: "选择会话" })).toBeVisible();
    expect(screen.getByTestId("message-stage")).toBeVisible();
    expect(screen.getAllByText("# general")).toHaveLength(1);
  });

  it("hides the ready SDK enum in the compact chat header", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByText("Atlas · 公开频道")).toBeVisible();
    expect(screen.queryByText("Atlas · READY")).toBeNull();
  });

  it("budgets compact header actions while keeping Channel editing in the picker", async () => {
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        canManageChannels
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("compact-header-menu-icon")).toBeVisible();
    expect(screen.getByTestId("compact-header-search-icon")).toBeVisible();
    expect(screen.queryByTestId("compact-header-edit-icon")).toBeNull();
    expect(screen.queryByText("☰")).toBeNull();
    expect(screen.queryByText("✎")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Server 与 Channel"}),
    );
    expect(screen.getByTestId("compact-conversation-picker")).toBeVisible();
    expect(screen.queryByText("会话")).toBeNull();
    expect(screen.getAllByText("选择会话")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "搜索当前 Channel" }),
    ).toBeNull();
    expect(screen.queryByTestId("compact-header-edit-icon")).toBeNull();
    expect(screen.getByRole("button", { name: "关闭会话选择" })).toBeVisible();
    expect(screen.getByTestId("compact-channel-create-icon")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "编辑 Channel general"}),
    ).toBeVisible();
    expect(screen.getByTestId("compact-channel-chevron-general")).toBeVisible();
    expect(screen.queryByText("01")).toBeNull();
    expect(screen.queryByText("→")).toBeNull();
  });

  it("routes Server and Channel selections through actions", async () => {
    const onSelectServer = jest.fn();
    const onSelectChannel = jest.fn();
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={onSelectChannel}
        onSelectServer={onSelectServer}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "打开 Server Atlas" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "打开 Channel general" }),
    );

    expect(onSelectServer).toHaveBeenCalledWith(server.id);
    expect(onSelectChannel).toHaveBeenCalledWith(channel.id);
  });

  it("keeps Server members separate from the current Channel member list", async () => {
    const onNavigateSection = jest.fn();
    const onAddChannelMember = jest.fn();
    const onRemoveChannelMember = jest.fn();
    const generatedOwnerMember: Member = {
      ...ownerMember,
      handle: "u_QMOCEB6GXFXNPZTFZHW3",
    };
    const desktop = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        canManageChannels
        channelMembers={[generatedOwnerMember, agentMember]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId={generatedOwnerMember.imUserId ?? undefined}
        currentServerId={server.id}
        imStatus="ready"
        members={[
          generatedOwnerMember,
          agentMember,
          duplicateAgentMemberA,
        ]}
        messages={[]}
        onAddChannelMember={onAddChannelMember}
        onNavigateSection={onNavigateSection}
        onOpenChannelManagement={jest.fn()}
        onRemoveChannelMember={onRemoveChannelMember}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(desktop.getByRole("button", { name: "打开任务" })).toBeVisible();
    expect(desktop.getByRole("button", { name: "打开 Agent" })).toBeVisible();
    expect(
      desktop.getByRole("button", { name: "打开 Computer" }),
    ).toBeVisible();
    expect(desktop.getByRole("button", { name: "打开成员" })).toBeVisible();
    expect(
      desktop.getByRole("button", {name: "打开 Server 设置"}),
    ).toBeVisible();
    expect(
      desktop.getByRole("button", {
        name: "查看 Channel general 的 2 位成员",
      }),
    ).toBeVisible();
    await fireEvent.press(desktop.getByRole("button", { name: "打开任务" }));
    expect(onNavigateSection).toHaveBeenCalledWith("tasks");
    await fireEvent.press(
      desktop.getByRole("button", {
        name: "查看 Channel general 的 2 位成员",
      }),
    );
    const memberPanel = desktop.getByTestId("channel-management-panel");
    expect(within(memberPanel).getByText("#general · 2 位成员")).toBeVisible();
    expect(within(memberPanel).getByText("当前成员")).toBeVisible();
    expect(within(memberPanel).getByText("添加 Agent")).toBeVisible();
    expect(within(memberPanel).getByText("自然人")).toBeVisible();
    expect(within(memberPanel).getAllByText("Agent")).toHaveLength(2);
    expect(within(memberPanel).queryByText(/QMOCEB/u)).toBeNull();
    expect(within(memberPanel).queryByText("human")).toBeNull();
    expect(within(memberPanel).queryByText("agent")).toBeNull();
    expect(
      within(memberPanel).getByRole("button", {
        name: "退出 Channel Skip",
      }),
    ).toBeVisible();
    await fireEvent.press(
      within(memberPanel).getByRole("button", {
        name: "移出 Channel 研究助手 @research",
      }),
    );
    expect(onRemoveChannelMember).not.toHaveBeenCalled();
    expect(desktop.getByText("移出 研究助手（@research）？")).toBeVisible();
    expect(
      desktop.getByText(
        "移出后，研究助手（@research）将无法继续收发 #general 的消息。之后仍可重新添加。",
      ),
    ).toBeVisible();
    await fireEvent.press(
      desktop.getByRole("button", {name: "取消移出 研究助手"}),
    );
    expect(desktop.queryByText("移出 研究助手（@research）？")).toBeNull();
    await fireEvent.press(
      within(memberPanel).getByRole("button", {
        name: "移出 Channel 研究助手 @research",
      }),
    );
    await fireEvent.press(
      desktop.getByRole("button", {name: "确认移出 研究助手 @research"}),
    );
    expect(onRemoveChannelMember).toHaveBeenCalledWith(agentMember.id);
    await fireEvent.press(
      within(memberPanel).getByRole("button", {
        name: "添加 Channel 444 @44",
      }),
    );
    expect(onAddChannelMember).toHaveBeenCalledWith(duplicateAgentMemberA.id);
    expect(onNavigateSection).not.toHaveBeenCalledWith("members");

    const compact = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        channelMembers={[ownerMember, agentMember]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onNavigateSection={onNavigateSection}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(compact.getByRole("button", { name: "打开成员" })).toBeVisible();
    expect(
      compact.queryByRole("button", {name: "打开 Server 设置"}),
    ).toBeNull();
    expect(
      compact.getByRole("button", {
        name: "查看 Channel general 的 2 位成员",
      }),
    ).toBeVisible();
    expect(compact.getByTestId("mobile-bottom-nav")).toBeVisible();
  });

  it("lets a regular member leave only after explicit confirmation", async () => {
    const onRemoveChannelMember = jest.fn();
    const screen = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        canManageChannels={false}
        channelMembers={[productMember, agentMember]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentImUserId={productMember.imUserId ?? undefined}
        currentServerId={server.id}
        imStatus="ready"
        members={[productMember, agentMember]}
        messages={[]}
        onOpenChannelManagement={jest.fn()}
        onRemoveChannelMember={onRemoveChannelMember}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {
        name: "查看 Channel general 的 2 位成员",
      }),
    );
    const panel = screen.getByTestId("channel-management-panel");
    expect(
      within(panel).getByRole("button", {
        name: "退出 Channel 产品团队",
      }),
    ).toBeVisible();
    expect(
      within(panel).queryByRole("button", {
        name: "移出 Channel 研究助手 @research",
      }),
    ).toBeNull();

    await fireEvent.press(
      within(panel).getByRole("button", {
        name: "退出 Channel 产品团队",
      }),
    );
    expect(onRemoveChannelMember).not.toHaveBeenCalled();
    expect(screen.getByText("退出 #general？")).toBeVisible();
    expect(
      screen.getByText(
        "退出后，你将无法继续收发 #general 的消息。之后可由管理员重新添加。",
      ),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "确认退出 general"}),
    );
    expect(onRemoveChannelMember).toHaveBeenCalledWith(productMember.id);
  });

  it("keeps the add-Agent capability visible when every Agent already joined", async () => {
    const screen = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        canManageChannels
        channelMembers={[ownerMember, agentMember]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onAddChannelMember={jest.fn()}
        onOpenChannelManagement={jest.fn()}
        onRemoveChannelMember={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {
        name: "查看 Channel general 的 2 位成员",
      }),
    );
    const panel = screen.getByTestId("channel-management-panel");
    expect(within(panel).getByText("添加 Agent")).toBeVisible();
    expect(
      within(panel).getByText("Server 中的 Agent 都已加入这个 Channel。"),
    ).toBeVisible();
  });

  it("reveals desktop rail labels on hover and keyboard focus", async () => {
    const screen = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onNavigateSection={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    const agentButton = screen.getByRole("button", {name: "打开 Agent"});
    const computerButton = screen.getByRole("button", {
      name: "打开 Computer",
    });

    expect(
      screen.queryByTestId("rail-tooltip-agents", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
    await fireEvent(agentButton, "hoverIn");
    expect(
      screen.getByTestId("rail-tooltip-agents", {
        includeHiddenElements: true,
      }),
    ).toHaveTextContent("Agent");
    await fireEvent(agentButton, "hoverOut");
    expect(
      screen.queryByTestId("rail-tooltip-agents", {
        includeHiddenElements: true,
      }),
    ).toBeNull();

    await fireEvent(computerButton, "focus");
    expect(
      screen.getByTestId("rail-tooltip-computers", {
        includeHiddenElements: true,
      }),
    ).toHaveTextContent("Computer");
    await fireEvent(computerButton, "blur");
    expect(
      screen.queryByTestId("rail-tooltip-computers", {
        includeHiddenElements: true,
      }),
    ).toBeNull();
  });

  it("restores the desktop shell at 1024px without using the mobile navigation", async () => {
    const screen = await render(
      <WorkspaceShell
        activeSection="chat"
        agents={[agent]}
        channels={[channel]}
        currentChannelId={channel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[message]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_024}
      />,
    );

    expect(screen.getByTestId("server-rail")).toBeVisible();
    expect(screen.getByTestId("conversation-sidebar")).toBeVisible();
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
  });

  it("renders the Community root as a full sendable conversation", async () => {
    const rootChannel: Channel = {
      ...channel,
      id: "channel-all",
      imTopicId: "topic-all",
      name: "全员",
      systemKey: "all",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        channelMembers={[ownerMember, agentMember]}
        channels={[rootChannel]}
        currentChannelId={rootChannel.id}
        currentServerId={server.id}
        imStatus="ready"
        messages={[]}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(
      screen.queryByText("全员是成员根群，请选择一个 Channel 开始对话。"),
    ).toBeNull();
    expect(
      screen.getByText("发送第一条消息，或 @Agent 分配一项工作。"),
    ).toBeVisible();
    expect(
      screen.getByPlaceholderText("发消息"),
    ).toBeVisible();
    expect(screen.getByLabelText("搜索当前 Channel")).toBeEnabled();
    expect(
      screen.getByLabelText("查看 Channel 全员 的 2 位成员"),
    ).toBeEnabled();
  });

  it("uses a fourth context panel for Channel create, edit and private membership", async () => {
    const privateChannel: Channel = {
      ...channel,
      visibility: "private",
    };
    const onAddChannelMember = jest.fn(async () => undefined);
    const onCreateChannel = jest.fn(async () => null);
    const onUpdateChannel = jest.fn(async () => undefined);
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        canManageChannels
        channelMembers={[ownerMember]}
        channels={[privateChannel]}
        currentChannelId={privateChannel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onAddChannelMember={onAddChannelMember}
        onCreateChannel={onCreateChannel}
        onOpenChannelManagement={jest.fn()}
        onRemoveChannelMember={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        onUpdateChannel={onUpdateChannel}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "新建 Channel" }));
    expect(screen.getByTestId("channel-management-panel")).toBeVisible();
    await fireEvent.changeText(
      screen.getByLabelText("Channel 名称"),
      "delivery",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "设为私密 Channel" }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "创建 Channel" }));
    expect(onCreateChannel).toHaveBeenCalledWith({
      description: undefined,
      name: "delivery",
      visibility: "private",
    });

    await fireEvent.press(
      screen.getByRole("button", { name: "编辑 Channel general" }),
    );
    await fireEvent.changeText(
      screen.getByLabelText("编辑 Channel 名称"),
      "delivery-team",
    );
    await fireEvent.press(screen.getByRole("button", { name: "保存 Channel" }));
    expect(onUpdateChannel).toHaveBeenCalledWith(privateChannel.id, {
      description: "",
      name: "delivery-team",
    });

    await fireEvent.press(
      screen.getByRole("button", {
        name: "管理 Channel general 的成员",
      }),
    );
    await fireEvent.press(
      screen.getByRole("button", {
        name: "添加 Channel 研究助手 @research",
      }),
    );
    expect(onAddChannelMember).toHaveBeenCalledWith(agentMember.id);
  });

  it("keeps Channel creation and private membership reachable on compact screens", async () => {
    const privateChannel: Channel = {
      ...channel,
      visibility: "private",
    };
    const screen = await render(
      <WorkspaceShell
        agents={[agent]}
        canManageChannels
        channelMembers={[ownerMember]}
        channels={[privateChannel]}
        currentChannelId={privateChannel.id}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onAddChannelMember={jest.fn()}
        onCreateChannel={jest.fn()}
        onOpenChannelManagement={jest.fn()}
        onRemoveChannelMember={jest.fn()}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        onUpdateChannel={jest.fn()}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "打开 Server 与 Channel" }),
    );
    expect(screen.getByRole("button", { name: "新建 Channel" })).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "管理 Channel general 的成员",
      }),
    ).toBeVisible();
    await fireEvent.press(screen.getByRole("button", { name: "新建 Channel" }));
    expect(screen.getByTestId("channel-management-panel")).toHaveStyle({
      flex: 1,
      minWidth: 0,
      width: "100%",
    });
    expect(screen.getByText("Channel 名称")).toBeVisible();
    expect(screen.getByText("Channel 描述")).toBeVisible();
    expect(screen.getByTestId("channel-management-close-icon")).toBeVisible();
    expect(screen.queryByTestId("compact-header-edit-icon")).toBeNull();
    expect(screen.queryByTestId("compact-header-menu-icon")).toBeNull();
    expect(screen.getByLabelText("Channel 名称")).toBeVisible();
  });

  it("lets a Human join a discoverable public Channel before opening IM", async () => {
    const onAddChannelMember = jest.fn();
    const discoverableChannel: Channel = {...channel, joined: false};
    const screen = await render(
      <WorkspaceShell
        account={account}
        agents={[agent]}
        channelMembers={[]}
        channels={[discoverableChannel]}
        currentChannelId={discoverableChannel.id}
        currentImUserId={ownerMember.imUserId ?? undefined}
        currentServerId={server.id}
        imStatus="ready"
        members={[ownerMember, agentMember]}
        messages={[]}
        onAddChannelMember={onAddChannelMember}
        onSelectChannel={jest.fn()}
        onSelectServer={jest.fn()}
        onSend={jest.fn()}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("这是一个公开频道")).toBeVisible();
    expect(screen.getByTestId("channel-join-empty-state")).toHaveStyle({
      borderRadius: 0,
    });
    expect(screen.queryByLabelText("消息内容")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "加入 #general"}),
    );
    expect(onAddChannelMember).toHaveBeenCalledWith(ownerMember.id);
  });
});
