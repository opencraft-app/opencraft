import type {
  Account,
  Invite,
  InviteSecret,
  Member,
  Operation,
  Server,
} from "@vela/client-core";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import {Text} from "react-native";

import {
  MembersScreen,
  PresentationProvider,
  type HumanClientPresenter,
  type ManagementPageModel,
} from "@/ui";
import {velaTheme} from "@/ui";

const account: Account = {
  displayName: "Skip",
  email: "skip@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
};

const server: Server = {
  id: "server-1",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-owner",
  revision: 1,
  slug: "atlas",
};

const owner: Member = {
  accountId: account.id,
  displayName: account.displayName,
  handle: "skip",
  id: "member-owner",
  imState: "ready",
  imUserId: account.imUserId,
  kind: "human",
  revision: 1,
  role: "owner",
  serverId: server.id,
  status: "active",
};

const member: Member = {
  accountId: "account-2",
  displayName: "小王",
  handle: "xiaowang",
  id: "member-2",
  imState: "ready",
  imUserId: "human-2",
  kind: "human",
  revision: 1,
  role: "member",
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

const inviteSecret: InviteSecret = {
  invite,
  token: "one-time-invite-token",
};

const memberRemovalOperation: Operation = {
  createdAt: "2026-08-01T03:00:00.000Z",
  id: "operation-member-remove",
  kind: "im.membership.remove",
  service: "im",
  state: "running",
};

describe("MembersScreen", () => {
  it("publishes Member collection semantics to the injected presenter", async () => {
    let model: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        model = value;
        return <Text testID="semantic-member-presenter">{value.empty?.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <MembersScreen
          accountId={account.id}
          currentServerId={server.id}
          error={null}
          invites={[]}
          loading={false}
          members={[]}
          onAcceptInvite={jest.fn()}
          onCreateInvite={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRemoveMember={jest.fn()}
          onRevokeInvite={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateMember={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    expect(screen.getByTestId("semantic-member-presenter")).toHaveTextContent("还没有成员");
    expect(model).toMatchObject({
      collection: {items: [], label: "成员"},
      header: {eyebrow: "成员管理", title: "成员"},
      id: "members",
    });
  });

  it("publishes invite creation as semantic fields and actions", async () => {
    let latestModel: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        latestModel = value;
        return <Text>{value.form?.title ?? value.header.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    await render(
      <PresentationProvider presenter={presenter}>
        <MembersScreen
          accountId={account.id}
          currentServerId={server.id}
          error={null}
          invites={[]}
          loading={false}
          members={[owner]}
          onAcceptInvite={jest.fn()}
          onCreateInvite={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRemoveMember={jest.fn()}
          onRevokeInvite={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateMember={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).commands
        .find(action => action.id === "create-invite")?.run();
    });

    expect((latestModel as unknown as ManagementPageModel).form).toMatchObject({
      actions: [
        {id: "cancel-create-invite"},
        {id: "submit-create-invite"},
      ],
      fields: [
        {id: "invite-role"},
        {id: "invite-expires-at"},
        {id: "invite-max-uses"},
      ],
      title: "创建邀请",
    });
    expect("content" in ((latestModel as unknown as ManagementPageModel).form ?? {})).toBe(false);
  });

  it("uses a compact member directory instead of a card-gallery layout", async () => {
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[]}
        loading={false}
        members={[owner, member]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("member-sidebar")).toHaveStyle({
      borderRadius: 0,
      width: 312,
    });
    expect(
      screen.getByRole("button", {name: "打开成员 小王 @xiaowang"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight});
    expect(screen.getByTestId("member-detail")).toHaveStyle({
      alignSelf: "center",
      borderRadius: 0,
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
      width: "100%",
    });
    expect(screen.getByTestId("member-hero-avatar")).toHaveStyle({
      backgroundColor: "#EEF0FF",
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.resourceIdentity.markSize,
      width: velaTheme.recipes.resourceIdentity.markSize,
    });
    expect(screen.queryByTestId("member-fact-list")).toBeNull();
    expect(screen.getByTestId("member-metadata-list")).toHaveStyle({
      flexDirection: "column",
    });
    expect(screen.getByTestId("member-hero-metadata")).toHaveTextContent(
      "@skip · 自然人",
    );
  });

  it("hides generated Human handles while preserving Agent handles", async () => {
    const generatedHandle = "u_QMOCEB6GXFXNPZTFZHW3";
    const systemOwner: Member = {
      ...owner,
      displayName: "12",
      handle: generatedHandle,
    };
    const agentMember: Member = {
      ...member,
      accountId: undefined,
      displayName: "444",
      handle: "44",
      id: "member-agent",
      kind: "agent",
    };
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[]}
        loading={false}
        members={[systemOwner, agentMember]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByText(/QMOCEB/u)).toBeNull();
    expect(
      screen.getByRole("button", {name: "切换成员，当前 12"}),
    ).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换成员，当前 12"}),
    );
    await fireEvent.press(
      screen.getByRole("option", {name: "打开成员 444 @44"}),
    );

    expect(screen.getByTestId("member-hero-metadata")).toHaveTextContent(
      "@44 · Agent",
    );
  });

  it("distinguishes duplicate member names before opening their details", async () => {
    const duplicateAgentA: Member = {
      ...member,
      accountId: undefined,
      displayName: "444",
      handle: "44",
      id: "member-agent-44",
      imUserId: "agent-im-44",
      kind: "agent",
    };
    const duplicateAgentB: Member = {
      ...duplicateAgentA,
      handle: "123",
      id: "member-agent-123",
      imUserId: "agent-im-123",
    };
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[]}
        loading={false}
        members={[owner, duplicateAgentA, duplicateAgentB]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(
      screen.getByRole("button", {name: "打开成员 444 @44"}),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "打开成员 444 @123"}),
    ).toBeVisible();
    expect(screen.getByText("@44 · Agent · 成员")).toBeVisible();
    expect(screen.getByText("@123 · Agent · 成员")).toBeVisible();
  });

  it("manages Human roles, removals and one-time invites", async () => {
    const onAcceptInvite = jest.fn(async () => null);
    const onCreateInvite = jest.fn(async () => inviteSecret);
    const onRemoveMember = jest.fn(async () => undefined);
    const onRevokeInvite = jest.fn(async () => undefined);
    const onUpdateMember = jest.fn(async () => undefined);
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[invite]}
        loading={false}
        members={[owner, member]}
        onAcceptInvite={onAcceptInvite}
        onCreateInvite={onCreateInvite}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={onRemoveMember}
        onRevokeInvite={onRevokeInvite}
        onSelectServer={jest.fn()}
        onUpdateMember={onUpdateMember}
        pendingAction={null}
        servers={[server]}
        viewportWidth={980}
      />,
    );

    // 980 shares the chrome-wide collection column with Computer / Agent.
    expect(screen.getByTestId("member-sidebar")).toHaveStyle({
      height: "100%",
      width: 312,
    });
    expect(
      screen.getByRole("button", {name: "打开成员 小王 @xiaowang"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight});
    expect(screen.queryByText("TEAM / 02")).toBeNull();
    expect(screen.getByText("所有者")).toBeVisible();
    expect(screen.getByText("自然人")).toBeVisible();
    expect(screen.getByText("已连接")).toBeVisible();
    expect(screen.getByText("正常")).toBeVisible();
    expect(screen.queryByText("human")).toBeNull();
    expect(screen.queryByText("ready")).toBeNull();
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.getByTestId("member-create-icon")).toBeVisible();
    expect(screen.getByTestId("member-refresh-icon")).toBeVisible();
    expect(screen.getByRole("button", {name: "创建邀请"})).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderColor: velaTheme.semantic.color.borderTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.queryByTestId("member-accept-invite")).toBeNull();
    expect(
      screen.getByRole("button", {name: "接受其他 Server 邀请"}),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "打开成员 小王 @xiaowang"}),
    );
    await fireEvent.press(
      screen.getByRole("button", {
        name: "将 小王 设为管理员",
      }),
    );
    expect(onUpdateMember).toHaveBeenCalledWith(member.id, {
      role: "admin",
    });

    await fireEvent.press(
      screen.getByRole("button", {name: "移除成员 小王"}),
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "确认移除"}),
    );
    expect(onRemoveMember).toHaveBeenCalledWith(member.id);

    const dateNow = jest.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-08-10T04:02:30.000Z"),
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "创建邀请"}),
    );
    dateNow.mockRestore();
    expect(screen.getAllByText("创建邀请")).toHaveLength(1);
    expect(screen.getByText("普通成员")).toBeVisible();
    expect(screen.getByText("管理员")).toBeVisible();
    expect(
      screen.getByRole("radio", {name: "邀请普通成员"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.height});
    expect(screen.getByText("有效期")).toBeVisible();
    expect(screen.getByText("最大使用次数")).toBeVisible();
    expect(screen.getByLabelText("邀请有效期").props.value).toBe(
      "2026-08-17T12:00",
    );
    expect(screen.getByTestId("member-invite-form")).toHaveStyle({
      alignSelf: "center",
      maxWidth: velaTheme.recipes.managementWorkspace.formMaxWidth,
      width: "100%",
    });
    expect(
      screen.queryByRole("button", {name: "创建邀请"}),
    ).toBeNull();
    await fireEvent.changeText(
      screen.getByLabelText("邀请有效期"),
      "2026-08-30 16:00",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "生成邀请链接"}),
    );
    await waitFor(() => {
      expect(screen.getByText("one-time-invite-token")).toBeVisible();
    });
    expect(onCreateInvite).toHaveBeenCalledWith({
      expiresAt: "2026-08-30T16:00:00+08:00",
      maxUses: 1,
      role: "member",
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "关闭一次性邀请"}),
    );
    expect(screen.queryByText("one-time-invite-token")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "撤销邀请 invite-1"}),
    );
    expect(onRevokeInvite).toHaveBeenCalledWith(invite.id);

    await fireEvent.press(
      screen.getByRole("button", {name: "接受其他 Server 邀请"}),
    );
    await fireEvent.changeText(
      screen.getByLabelText("接受邀请 token"),
      "rfi_example",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "接受邀请"}),
    );
    expect(onAcceptInvite).toHaveBeenCalledWith("rfi_example");
    expect(screen.getByTestId("member-accept-invite")).toHaveStyle({
      alignSelf: "stretch",
      gap: velaTheme.spacing.sm,
    });
    expect(screen.getByTestId("member-accept-invite-body")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      borderWidth: 1,
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "取消接受邀请"}),
    );
    expect(screen.queryByTestId("member-accept-invite")).toBeNull();
  });

  it("rejects expired invites and non-positive usage limits before submit", async () => {
    const onCreateInvite = jest.fn();
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[]}
        loading={false}
        members={[owner]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={onCreateInvite}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "创建邀请"}),
    );
    await fireEvent.changeText(
      screen.getByLabelText("邀请有效期"),
      "2020-01-01T00:00",
    );
    await fireEvent.changeText(
      screen.getByLabelText("邀请最大使用次数"),
      "0",
    );

    expect(
      screen.getByText("有效期需在 5 分钟后至 30 天内。"),
    ).toBeVisible();
    expect(
      screen.getByText("最大使用次数需为 1–1000 的整数。"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "生成邀请链接"}),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {name: "生成邀请链接"}),
    ).toHaveStyle({opacity: 0.5});
    await fireEvent.press(
      screen.getByRole("button", {name: "生成邀请链接"}),
    );
    expect(onCreateInvite).not.toHaveBeenCalled();
  });

  it("uses a complete expandable member switcher on a phone", async () => {
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[invite]}
        loading={false}
        members={[owner, member]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("member-sidebar")).toBeNull();
    expect(screen.getByTestId("member-mobile-switcher")).toHaveStyle({
      width: "100%",
    });
    expect(
      screen.getByRole("button", {name: "切换成员，当前 Skip @skip"}),
    ).toHaveProp("accessibilityState", {expanded: false});
    expect(
      screen.queryByRole("option", {name: "打开成员 小王 @xiaowang"}),
    ).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换成员，当前 Skip @skip"}),
    );

    expect(
      screen.getByRole("option", {name: "打开成员 小王 @xiaowang"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight, width: "100%"});
  });

  it("keeps the horizontal member collection at the tablet breakpoint", async () => {
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[invite]}
        loading={false}
        members={[owner, member]}
        onAcceptInvite={jest.fn()}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={768}
      />,
    );

    expect(screen.queryByTestId("member-mobile-switcher")).toBeNull();
    expect(screen.getByTestId("member-sidebar")).toHaveStyle({height: velaTheme.recipes.managementWorkspace.collectionCompactHeight});
    expect(
      screen.getByRole("button", {name: "打开成员 小王 @xiaowang"}),
    ).toHaveStyle({height: velaTheme.recipes.control.rowHeight, width: 220});
  });

  it("keeps asynchronous member removal status visible after the row disappears", async () => {
    const onContinueOperation = jest.fn();
    const screen = await render(
      <MembersScreen
        accountId={account.id}
        currentServerId={server.id}
        error={null}
        invites={[]}
        loading={false}
        members={[owner]}
        onAcceptInvite={jest.fn()}
        onContinueOperation={onContinueOperation}
        onCreateInvite={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveMember={jest.fn()}
        onRevokeInvite={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateMember={jest.fn()}
        operations={[{
          operation: memberRemovalOperation,
          pollingState: "timed_out",
          resourceId: member.id,
        }]}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("执行中")).toBeVisible();
    fireEvent.press(screen.getByRole("button", {
      name: "继续查询操作 operation-member-remove",
    }));
    expect(onContinueOperation).toHaveBeenCalledWith(memberRemovalOperation.id);
  });
});
