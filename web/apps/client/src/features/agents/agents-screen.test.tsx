import type {
  Agent,
  Computer,
  Server,
} from "@vela/client-core";
import {
  act,
  fireEvent,
  render,
} from "@testing-library/react-native";
import {Text} from "react-native";

import {
  AgentsScreen,
  PresentationProvider,
  type HumanClientPresenter,
  type ManagementPageModel,
} from "@/ui";
import {velaTheme} from "@/ui";

const server: Server = {
  id: "server-1",
  imState: "ready",
  name: "Atlas",
  ownerMemberId: "member-1",
  revision: 1,
  slug: "atlas",
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

const agent: Agent = {
  availability: "offline",
  computerId: computer.id,
  credentialVersion: 1,
  desiredState: "stopped",
  displayName: "研究助手",
  handle: "research",
  id: "agent-1",
  imState: "ready",
  imPresence: "offline",
  imTransportState: "disconnected",
  imUserId: "agent-im-1",
  observedState: "stopped",
  replyPolicy: "mention_and_dm",
  revision: 1,
  runtime: {kind: "codex"},
  serverId: server.id,
};

describe("AgentsScreen", () => {
  it("publishes Agent collection semantics to the injected presenter", async () => {
    let model: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        model = value;
        return <Text testID="semantic-agent-presenter">{value.empty?.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <AgentsScreen
          agents={[]}
          computers={[computer]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateAgent={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRunAgentAction={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateAgent={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    expect(screen.getByTestId("semantic-agent-presenter")).toHaveTextContent("还没有 Agent");
    expect(model).toMatchObject({
      collection: {items: [], label: "Agent"},
      header: {eyebrow: "Agent 管理", title: "Agent"},
      id: "agents",
    });
  });

  it("publishes Agent creation as terminal-native semantic fields and actions", async () => {
    let latestModel: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        latestModel = value;
        return <Text testID="semantic-agent-form">{value.form?.title ?? value.header.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    await render(
      <PresentationProvider presenter={presenter}>
        <AgentsScreen
          agents={[]}
          computers={[computer]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateAgent={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRunAgentAction={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateAgent={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).commands
        .find(action => action.id === "create-agent")?.run();
    });

    expect((latestModel as unknown as ManagementPageModel).form).toMatchObject({
      actions: [
        {id: "cancel-create-agent"},
        {id: "submit-create-agent"},
      ],
      fields: [
        {id: "agent-display-name"},
        {id: "agent-handle"},
        {id: "agent-runtime"},
        {id: "agent-reply-policy"},
        {id: "agent-computer"},
      ],
      title: "新建 Agent",
    });
    expect("content" in ((latestModel as unknown as ManagementPageModel).form ?? {})).toBe(false);
  });

  it("publishes Agent editing and credential rotation as shared semantic actions", async () => {
    let latestModel: ManagementPageModel | null = null;
    const onRotateCredential = jest.fn(async () => null);
    const onUpdateAgent = jest.fn(async () => undefined);
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        latestModel = value;
        return <Text>{value.form?.title ?? value.detail?.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    await render(
      <PresentationProvider presenter={presenter}>
        <AgentsScreen
          agents={[agent]}
          canManage
          computers={[computer]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateAgent={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRotateCredential={onRotateCredential}
          onRunAgentAction={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateAgent={onUpdateAgent}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).detail?.actions
        .find(action => action.id === "edit-agent")?.run();
    });
    const editModel = latestModel as unknown as ManagementPageModel;
    expect(editModel.form?.fields.map(field => field.id)).toEqual([
      "edit-agent-display-name",
      "edit-agent-runtime",
      "edit-agent-reply-policy",
      "edit-agent-computer",
    ]);
    await act(async () => {
      editModel.form?.fields
        .find(field => field.id === "edit-agent-display-name")
        ?.onChange("研究 Agent");
    });
    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).form?.actions
        .find(action => action.id === "submit-edit-agent")?.run();
    });
    expect(onUpdateAgent).toHaveBeenCalledWith(agent.id, expect.objectContaining({
      displayName: "研究 Agent",
    }));

    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).detail?.actions
        .find(action => action.id === "rotate-agent-credential")?.run();
    });
    expect((latestModel as unknown as ManagementPageModel).form?.title).toContain("轮换");
    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).form?.actions
        .find(action => action.id === "confirm-rotate-agent-credential")?.run();
    });
    expect(onRotateCredential).toHaveBeenCalledWith(agent.id);
  });

  it("gives the desktop Agent workspace a full-width readable detail surface", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("agent-sidebar")).toHaveStyle({
      borderRadius: 0,
      width: 312,
    });
    expect(
      screen.getByRole("button", {name: "打开 Agent research"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.managementWorkspace.rowMinHeight});
    expect(screen.getByTestId("agent-detail")).toHaveStyle({
      alignSelf: "center",
      borderRadius: 0,
      maxWidth: 960,
      width: "100%",
    });
  });

  it("presents Agent identity without repeating editable runtime configuration", async () => {
    const runningAgent: Agent = {
      ...agent,
      availability: "online",
      desiredState: "running",
      observedState: "running",
    };
    const screen = await render(
      <AgentsScreen
        agents={[runningAgent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("agent-hero-avatar")).toHaveStyle({
      backgroundColor: "#17C964",
      borderRadius: 10,
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("agent-detail-title")).toHaveStyle({
      fontSize: 22,
      lineHeight: 28,
    });
    expect(screen.queryByTestId("agent-fact-strip")).toBeNull();
    expect(screen.getByTestId("agent-settings-section")).toHaveStyle({
      borderTopWidth: 1,
    });
    expect(
      screen.getByRole("button", {name: "重启 Agent research"}),
    ).toHaveStyle({
      backgroundColor: "#EAF4FF",
      minHeight: velaTheme.recipes.managementWorkspace.actionHeight,
    });
    expect(screen.getByRole("button", {name: "保存 Agent"})).toHaveStyle({
      alignSelf: "flex-start",
      minHeight: velaTheme.recipes.managementWorkspace.actionHeight,
    });
  });

  it("keeps the compact Agent identity readable instead of squeezing the title", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={320}
      />,
    );

    expect(screen.getByTestId("agent-hero")).toHaveStyle({
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
    });
    expect(screen.getByTestId("agent-hero-identity")).toHaveStyle({
      flex: 1,
      flexDirection: "row",
    });
    expect(screen.getByTestId("agent-detail-title")).toHaveStyle({
      fontSize: 22,
      lineHeight: 28,
    });
  });

  it("creates, edits and starts an Agent with real protocol fields", async () => {
    const onCreateAgent = jest.fn(async () => null);
    const onRunAgentAction = jest.fn(async () => null);
    const onUpdateAgent = jest.fn(async () => undefined);
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={onCreateAgent}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={onRunAgentAction}
        onSelectServer={jest.fn()}
        onUpdateAgent={onUpdateAgent}
        pendingAction={null}
        servers={[server]}
        viewportWidth={980}
      />,
    );

    expect(screen.queryByTestId("agent-sidebar")).toBeNull();
    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("Agent");
    expect(screen.getByTestId("agent-detail")).toBeVisible();
    expect(screen.queryByText("RUNTIMES / 01")).toBeNull();
    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByText("STOPPED")).toBeNull();
    expect(screen.getAllByText("研发机").length).toBeGreaterThan(0);

    await fireEvent.press(
      screen.getByRole("button", {name: "新建 Agent"}),
    );
    expect(screen.getAllByText("新建 Agent")).toHaveLength(1);
    expect(
      screen.getByRole("button", {name: "选择 codex"}),
    ).toHaveStyle({minHeight: 48, minWidth: 48});
    expect(
      screen.getByRole("button", {name: "绑定 Computer 研发机"}),
    ).toHaveStyle({minHeight: 48, minWidth: 48});
    await fireEvent.changeText(
      screen.getByLabelText("Agent 显示名"),
      "交付助手",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Agent handle"),
      "delivery",
    );
		expect(
			screen.getByRole("button", {name: "创建 Agent"}),
		).toBeDisabled();
    await fireEvent.press(
      screen.getByRole("button", {name: "选择 hermes-gateway"}),
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "绑定 Computer 研发机"}),
    );
		expect(
			screen.getByRole("button", {name: "创建 Agent"}),
		).toBeEnabled();
    await fireEvent.press(
      screen.getByRole("button", {name: "创建 Agent"}),
    );
    expect(onCreateAgent).toHaveBeenCalledWith({
      computerId: computer.id,
      displayName: "交付助手",
      handle: "delivery",
      replyPolicy: "mention_and_dm",
      runtime: {kind: "hermes-gateway"},
    });
    expect(onRunAgentAction).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText("编辑 Agent 显示名"),
      "研究 Agent",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "保存 Agent"}),
    );
    expect(onUpdateAgent).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({displayName: "研究 Agent"}),
    );
		expect(
			screen.queryByRole("button", {name: "解除 Computer 绑定"}),
		).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "启动 Agent research"}),
    );
    expect(onRunAgentAction).toHaveBeenCalledWith(agent.id, "start");
  });

  it("offers Agent creation directly from a semantic empty state", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.queryByText("00")).toBeNull();
    expect(
      screen.queryByRole("button", {name: "从侧栏新建 Agent"}),
    ).toBeNull();
    expect(screen.queryByRole("button", {name: "新建 Agent"})).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态新建 Agent"}),
    );
    expect(screen.getByLabelText("Agent 显示名")).toBeVisible();
    expect(screen.getByText("显示名称")).toBeVisible();
    expect(screen.getByText("Handle")).toBeVisible();
    expect(screen.getByTestId("agent-create-form")).toHaveStyle({
      maxWidth: 900,
      width: "100%",
    });
    expect(screen.queryByTestId("management-empty-state")).toBeNull();
  });

  it("explains the Agent handle contract and rejects spaces before submit", async () => {
    const onCreateAgent = jest.fn();
    const screen = await render(
      <AgentsScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={onCreateAgent}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态新建 Agent"}),
    );
    await fireEvent.changeText(
      screen.getByLabelText("Agent 显示名"),
      "交付助手",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Agent handle"),
      "a b",
    );

    expect(
      screen.getByText(
        "Handle 需为 2–32 位小写字母、数字、下划线或连字符。",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {name: "创建 Agent"}),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {name: "创建 Agent"}),
    ).toHaveStyle({opacity: 0.5});
    await fireEvent.press(
      screen.getByRole("button", {name: "创建 Agent"}),
    );
    expect(onCreateAgent).not.toHaveBeenCalled();
  });

  it("uses semantic icons for Agent management actions", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("agent-create-icon")).toBeVisible();
    expect(screen.getByTestId("agent-refresh-icon")).toBeVisible();
    expect(screen.getByRole("button", {name: "新建 Agent"})).toHaveStyle({
      backgroundColor: "#EAF4FF",
      borderColor: "#EAF4FF",
      minHeight: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.queryByText("↻")).toBeNull();
  });

  it("removes a redundant compact collection when there is only one Agent", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("agent-sidebar")).toBeNull();
    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("Agent");
    expect(screen.getByTestId("agent-detail")).toBeVisible();
  });

  it("uses a complete expandable Agent switcher on a phone", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[
          agent,
          {...agent, displayName: "交付助手", handle: "delivery", id: "agent-2"},
        ]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("agent-sidebar")).toBeNull();
    expect(screen.getByTestId("agent-mobile-switcher")).toHaveStyle({
      width: "100%",
    });
    expect(
      screen.getByRole("button", {name: "切换 Agent，当前 research"}),
    ).toHaveProp("accessibilityState", {expanded: false});
    expect(
      screen.queryByRole("button", {name: "打开 Agent delivery"}),
    ).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换 Agent，当前 research"}),
    );

    expect(
      screen.getByRole("button", {name: "打开 Agent delivery"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.managementWorkspace.switcherOptionMinHeight, width: "100%"});
  });

  it("keeps the horizontal Agent collection at the tablet breakpoint", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[
          agent,
          {...agent, displayName: "交付助手", handle: "delivery", id: "agent-2"},
        ]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={768}
      />,
    );

    expect(screen.queryByTestId("agent-mobile-switcher")).toBeNull();
    expect(screen.getByTestId("agent-sidebar")).toHaveStyle({height: 96});
    expect(
      screen.getByRole("button", {name: "打开 Agent delivery"}),
    ).toHaveStyle({height: velaTheme.recipes.managementWorkspace.rowMinHeight, width: 220});
  });

  it("only exposes lifecycle actions that are valid for the current runtime state", async () => {
    const offlineComputer: Computer = {
      ...computer,
      connectionState: "offline",
    };
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        computers={[offlineComputer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(
      screen.getByText("绑定的 Computer 当前不可用，请恢复连接后再操作。"),
    ).toBeVisible();
    for (const action of ["部署", "启动", "停止", "重启"]) {
      expect(
        screen.getByRole("button", {name: `${action} Agent research`}),
      ).toBeDisabled();
    }

    await screen.rerender(
      <AgentsScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(
      screen.getByRole("button", {name: "部署 Agent research"}),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {name: "启动 Agent research"}),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {name: "停止 Agent research"}),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {name: "重启 Agent research"}),
    ).toBeDisabled();
  });

  it("explains an unknown runtime state from the Computer binding", async () => {
    const unknownAgent: Agent = {
      ...agent,
      observedState: "unknown",
    };
    const screen = await render(
      <AgentsScreen
        agents={[unknownAgent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getAllByText("待部署").length).toBeGreaterThan(0);
    expect(screen.queryByText("未知")).toBeNull();
  });

  it("collapses an empty compact collection header instead of reserving a dead band", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("agent-sidebar")).toBeNull();
  });

  it("visually distinguishes unavailable credential rotation", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[
          {
            ...agent,
            desiredState: "running",
            observedState: "unknown",
          },
        ]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRotateCredential={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    const rotateButton = screen.getByRole("button", {
      name: "轮换 Agent research 的运行凭证",
    });
    expect(rotateButton).toBeDisabled();
    expect(rotateButton).toHaveStyle({opacity: 0.5});
  });

  it("groups credential and deletion controls into one restrained security section", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onDeleteAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRotateCredential={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("agent-security-section")).toHaveStyle({
      borderRadius: 0,
      borderTopWidth: 1,
      paddingHorizontal: 0,
    });
    expect(screen.getByTestId("agent-credential-section")).toHaveStyle({
      borderTopWidth: 1,
      minHeight: 72,
    });
    expect(screen.getByTestId("agent-delete-section")).toHaveStyle({
      borderTopWidth: 1,
      minHeight: 72,
    });
  });

  it("rotates credentials only after explicit confirmation and displays Operation state", async () => {
    const onRotateCredential = jest.fn(async () => null);
    const onContinueOperation = jest.fn(async () => undefined);
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onContinueOperation={onContinueOperation}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRotateCredential={onRotateCredential}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        operations={[{
          operation: {
            createdAt: "2026-08-01T03:00:00.000Z",
            id: "operation-credential-1",
			kind: "agent.credential.rotate",
			service: "platform",
			state: "succeeded",
          },
			pollingState: "terminal",
        }]}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

		expect(screen.getByText("成功")).toBeVisible();
		expect(screen.getByText("轮换运行凭证")).toBeVisible();
		expect(screen.queryByText("agent.credential.rotate")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "轮换 Agent research 的运行凭证"}),
    );
    expect(screen.getByText("安装成功前旧凭证仍有效")).toBeVisible();
    expect(onRotateCredential).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole("button", {name: "确认轮换运行凭证"}),
    );
    expect(onRotateCredential).toHaveBeenCalledWith(agent.id);
  });

  it("deletes an Agent only after an owner confirms the Computer-safe consequences", async () => {
    const onDeleteAgent = jest.fn(async () => null);
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onDeleteAgent={onDeleteAgent}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "删除 Agent research"}),
    );

    expect(onDeleteAgent).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Computer 和 TAT 不会停止，其他 Agent 不受影响。Agent 的工作区和历史消息会保留。",
      ),
    ).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "确认删除 Agent research"}),
    );
    expect(onDeleteAgent).toHaveBeenCalledWith(agent.id);
  });
});
