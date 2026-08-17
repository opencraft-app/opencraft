import type {
  Agent,
  AgentProfileCapabilities,
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
          canManage
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
        {id: "continue-create-agent"},
      ],
      fields: [
        {id: "agent-display-name"},
        {id: "agent-handle"},
        {id: "agent-reply-policy"},
      ],
      title: "它叫什么",
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
        canManage
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
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight});
    expect(screen.getByTestId("agent-detail")).toHaveStyle({
      alignSelf: "center",
      borderRadius: 0,
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
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
      borderRadius: velaTheme.semantic.radius.control,
      height: velaTheme.recipes.resourceIdentity.markSize,
      width: velaTheme.recipes.resourceIdentity.markSize,
    });
    expect(screen.getByTestId("agent-detail-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
    expect(screen.queryByTestId("agent-fact-strip")).toBeNull();
    expect(screen.getByTestId("agent-settings-section-body")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      borderWidth: 1,
    });
    expect(
      screen.getByRole("button", {name: "重启 Agent research"}),
    ).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.actionSecondarySurface,
      height: velaTheme.recipes.control.height,
    });
    expect(screen.getByRole("button", {name: "保存 Agent"})).toHaveStyle({
      alignSelf: "flex-start",
      height: velaTheme.recipes.control.height,
    });
  });

  it("keeps the compact Agent identity readable instead of squeezing the title", async () => {
    const screen = await render(
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
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
  });

  it("creates an Agent through the wizard and deploys+starts by default", async () => {
    const onCreateAgent = jest.fn(async () => ({
      operations: [],
      resourceId: "agent-new",
    }));
    const onRunAgentAction = jest.fn(async () => ({
      createdAt: "2026-08-10T08:00:00.000Z",
      id: "op-1",
      kind: "agent.deploy",
      service: "platform" as const,
      state: "succeeded" as const,
    }));
    const onUpdateAgent = jest.fn(async () => undefined);
    const screen = await render(
      <AgentsScreen
        agents={[agent]}
        canManage
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

    // 980 is past the chrome compact cutover: collection stays vertical beside
    // the stage (same threshold Computer already used).
    expect(screen.getByTestId("agent-sidebar")).toHaveStyle({
      height: "100%",
      width: 312,
    });
    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("Agent");
    expect(screen.getByTestId("agent-detail")).toBeVisible();
    expect(screen.queryByText("RUNTIMES / 01")).toBeNull();
    expect(screen.getAllByText("已停止").length).toBeGreaterThan(0);
    expect(screen.queryByText("STOPPED")).toBeNull();
    expect(screen.getAllByText("研发机").length).toBeGreaterThan(0);

    await fireEvent.press(
      screen.getByRole("button", {name: "新建 Agent"}),
    );
    expect(screen.getByTestId("agent-stage-title")).toHaveTextContent("新建 Agent");
    expect(screen.getByText("它叫什么")).toBeVisible();
    await fireEvent.changeText(
      screen.getByLabelText("Agent 显示名"),
      "交付助手",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Agent handle"),
      "delivery",
    );
    await fireEvent.press(screen.getByRole("button", {name: "继续"}));

    expect(screen.getByText("跑在哪台 Computer")).toBeVisible();
    expect(
      screen.getByRole("radio", {name: "选择 codex"}),
    ).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.headerActionHeight,
      minWidth: velaTheme.recipes.control.height,
    });
    expect(
      screen.getByRole("combobox", {name: "Computer"}),
    ).toHaveStyle({
      height: velaTheme.recipes.control.fieldHeight,
    });
    await fireEvent.press(
      screen.getByRole("radio", {name: "选择 hermes-gateway"}),
    );
    await fireEvent.press(screen.getByRole("combobox", {name: "Computer"}));
    await fireEvent.press(
      screen.getByRole("option", {name: "绑定 Computer 研发机"}),
    );
    await fireEvent.press(screen.getByRole("button", {name: "继续"}));

    expect(screen.getByText("创建后自动完成")).toBeVisible();
    expect(
      screen.getByRole("switch", {name: "部署并启动"}),
    ).toBeChecked();
    await fireEvent.press(
      screen.getByRole("button", {name: "创建并启动"}),
    );
    expect(onCreateAgent).toHaveBeenCalledWith(
      {
        computerId: computer.id,
        displayName: "交付助手",
        handle: "delivery",
        replyPolicy: "mention_and_dm",
        runtime: {kind: "hermes-gateway"},
      },
      {deployAndStart: true},
    );
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

  it("preserves a configured model when saving unrelated Agent settings", async () => {
    const configuredAgent: Agent = {
      ...agent,
      runtime: {kind: "codex", model: "gpt-5.6-sol"},
    };
    const onUpdateAgent = jest.fn(async () => undefined);
    const screen = await render(
      <AgentsScreen
        agents={[configuredAgent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateAgent={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={onUpdateAgent}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("编辑 Agent 显示名"),
      "新的显示名",
    );
    await fireEvent.press(screen.getByRole("button", {name: "保存 Agent"}));

    expect(onUpdateAgent).toHaveBeenCalledWith(
      configuredAgent.id,
      expect.objectContaining({
        displayName: "新的显示名",
        runtime: {kind: "codex", model: "gpt-5.6-sol"},
      }),
    );
  });

  it("renders Profile models, workspace and effective Skills", async () => {
    const capabilities: AgentProfileCapabilities = {
      agentId: agent.id,
      models: {
        configuredModelId: null,
        effectiveDefaultModelId: "gpt-5.6-sol",
        items: [{
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          serviceTiers: [],
          supportedReasoningEfforts: ["medium", "high"],
        }],
        selectedAvailability: "unknown",
        selectionMode: "follow_runtime_default",
        truncated: false,
        warnings: [],
      },
      observedAt: "2026-08-18T00:00:00Z",
      refreshOperation: null,
      skills: {
        items: [{
          availability: "available",
          description: "Review pull requests",
          enabled: true,
          id: "github-review",
          missingDependencyCount: 0,
          missingDependencyTypes: [],
          name: "github-review",
          scope: "project",
        }],
        truncated: false,
        warnings: [],
      },
      snapshotState: "current",
      source: {
        discoveryMode: "active_session",
        forceReload: false,
        protocol: "codex_app_server",
        runtimeVersion: "1.0.0",
      },
      staleReasons: [],
      subject: {
        authorityContextKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        computerId: computer.id,
        contextGeneration: 1,
        observedThroughSequence: 1,
        profileFingerprint: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        profileKind: "codex_home",
        runtimeContextGeneration: 1,
        runtimeKind: "codex",
        workspacePath: "/workspaces/agent-1",
      },
    };
    const onRefreshProfileCapabilities = jest.fn(async () => null);
    const screen = await render(
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
        onRefreshProfileCapabilities={onRefreshProfileCapabilities}
        onRunAgentAction={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateAgent={jest.fn()}
        pendingAction={null}
        profileCapabilitiesById={{[agent.id]: capabilities}}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByRole("combobox", {name: "Agent 模型"})).toBeVisible();
    expect(screen.getByText("/workspaces/agent-1")).toBeVisible();
    expect(screen.getByText("github-review")).toBeVisible();
    await fireEvent.press(screen.getByRole("button", {name: "刷新 Agent research 运行能力"}));
    expect(onRefreshProfileCapabilities).toHaveBeenCalledTimes(1);
  });

  it("offers Agent creation directly from a semantic empty state", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[]}
        canManage
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
    expect(
      screen.getByText("创建后部署并启动，即可在 Channel 里 @ 它"),
    ).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态新建 Agent"}),
    );
    expect(screen.getByText("它叫什么")).toBeVisible();
    expect(screen.getByLabelText("Agent 显示名")).toBeVisible();
    expect(screen.getByText("显示名称")).toBeVisible();
    expect(screen.getByText("Handle")).toBeVisible();
    expect(screen.getByTestId("agent-create-form")).toHaveStyle({
      maxWidth: velaTheme.recipes.managementWorkspace.formMaxWidth,
      width: "100%",
    });
    expect(screen.queryByTestId("management-empty-state")).toBeNull();
  });

  it("does not offer Agent creation to an ordinary Server member", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[]}
        canManage={false}
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

    expect(screen.queryByRole("button", {name: "从空状态新建 Agent"})).toBeNull();
    expect(
      screen.getByText("还没有可用 Agent，请联系 Server Owner 或 Admin 创建。"),
    ).toBeVisible();
  });

  it("explains the Agent handle contract and rejects spaces before continuing", async () => {
    const onCreateAgent = jest.fn();
    const screen = await render(
      <AgentsScreen
        agents={[]}
        canManage
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
      screen.getByRole("button", {name: "继续"}),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {name: "继续"}),
    ).toHaveStyle({opacity: 0.5});
    await fireEvent.press(
      screen.getByRole("button", {name: "继续"}),
    );
    expect(screen.getByText("它叫什么")).toBeVisible();
    expect(onCreateAgent).not.toHaveBeenCalled();
  });

  it("uses semantic icons for Agent management actions", async () => {
    const screen = await render(
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
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderColor: velaTheme.semantic.color.borderTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
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
      screen.queryByRole("option", {name: "打开 Agent delivery"}),
    ).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "切换 Agent，当前 research"}),
    );

    expect(
      screen.getByRole("option", {name: "打开 Agent delivery"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight, width: "100%"});
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
    expect(screen.getByTestId("agent-sidebar")).toHaveStyle({height: velaTheme.recipes.managementWorkspace.collectionCompactHeight});
    expect(
      screen.getByRole("button", {name: "打开 Agent delivery"}),
    ).toHaveStyle({height: velaTheme.recipes.control.rowHeight, width: 220});
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

  it("presents lifecycle progress through one collapsed glass status island", async () => {
    const screen = await render(
      <AgentsScreen
        agents={[{...agent, desiredState: "running", observedState: "starting"}]}
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
        operations={[{
          operation: {
            createdAt: "2026-08-17T15:14:45.000Z",
            id: "operation-start",
            kind: "agent.start",
            service: "platform",
            state: "running",
          },
          pollingState: "polling",
        }]}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("agent-status-island")).toBeVisible();
    expect(screen.getByText("启动 Agent · 执行中 · 0/1")).toBeVisible();
    expect(screen.queryByText("Agent 正在切换状态，请等待当前操作完成。")).toBeNull();
    expect(screen.queryByText("后台执行状态")).toBeNull();
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

    expect(screen.getByTestId("agent-security-section-body")).toHaveStyle({
      borderRadius: velaTheme.semantic.radius.control,
      borderWidth: 1,
    });
    expect(screen.getByTestId("agent-credential-section-content")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.resourceActionMinHeight,
    });
    expect(screen.getByTestId("agent-delete-section-content")).toHaveStyle({
      minHeight: velaTheme.recipes.managementWorkspace.resourceActionMinHeight,
    });
    expect(screen.getByTestId("agent-security-section-separator-1")).toHaveStyle({
      height: velaTheme.semantic.stroke.hairline,
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

		expect(screen.getByText("操作已完成 · 1/1")).toBeVisible();
		await act(async () => {
			fireEvent.press(screen.getByRole("button", {name: "操作已完成 · 1/1"}));
		});
		expect(screen.getByText("成功")).toBeVisible();
		expect(screen.getByText("轮换运行凭证")).toBeVisible();
		expect(screen.queryByText("agent.credential.rotate")).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {name: "轮换 Agent research 的运行凭证"}),
    );
    expect(screen.getByText("安装成功前旧凭证仍有效")).toBeVisible();
    expect(onRotateCredential).not.toHaveBeenCalled();
    await fireEvent.press(
      screen.getByRole("button", {name: "确认轮换"}),
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
      screen.getByRole("button", {name: "确认删除"}),
    );
    expect(onDeleteAgent).toHaveBeenCalledWith(agent.id);
  });
});
