import type {
  Account,
  Agent,
  Computer,
  RegistrationScript,
  Server,
  TerminalControllerState,
} from "@vela/client-core";
import {
  act,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react-native";
import {Text} from "react-native";

import {
  ComputersScreen,
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

const account: Account = {
  displayName: "Skip",
  email: "skip@example.test",
  id: "account-1",
  imState: "ready",
  imUserId: "human-1",
  revision: 1,
};

const agent: Agent = {
  availability: "online",
  computerId: computer.id,
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
  runtime: {kind: "codex"},
  serverId: server.id,
};

const registration: RegistrationScript = {
  computerId: computer.id,
  expiresAt: "2026-07-31T08:10:00.000Z",
	revision: 2,
  script: "one-time-registration-material",
};

describe("ComputersScreen", () => {
  it("publishes Computer collection semantics to the injected presenter", async () => {
    let model: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_value, fallback) {
        return fallback;
      },
      renderManagementPage(value) {
        model = value;
        return <Text testID="semantic-computer-presenter">{value.empty?.title}</Text>;
      },
      renderWorkspaceSetup(_value, fallback) {
        return fallback;
      },
    };
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <ComputersScreen
          agents={[]}
          computers={[]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateComputer={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRequestRegistrationScript={jest.fn()}
          onSelectServer={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    expect(screen.getByTestId("semantic-computer-presenter")).toHaveTextContent("还没有 Computer");
    expect(model).toMatchObject({
      collection: {items: [], label: "Computer"},
      header: {eyebrow: "计算资源", title: "Computer"},
      id: "computers",
    });
  });

  it("publishes Computer enrollment as a semantic form", async () => {
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
        <ComputersScreen
          agents={[]}
          computers={[]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateComputer={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRequestRegistrationScript={jest.fn()}
          onSelectServer={jest.fn()}
          pendingAction={null}
          servers={[server]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).commands
        .find(action => action.id === "create-computer")?.run();
    });

    expect((latestModel as unknown as ManagementPageModel).form).toMatchObject({
      actions: [
        {id: "cancel-create-computer"},
        {id: "submit-create-computer"},
      ],
      fields: [{id: "computer-name"}],
      title: "纳管 Computer",
    });
    expect("content" in ((latestModel as unknown as ManagementPageModel).form ?? {})).toBe(false);
  });

  it("restores the rail at 1120px with a distinct medium Computer surface", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_120}
      />,
    );

    expect(screen.getByTestId("server-rail")).toBeVisible();
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    expect(screen.getByTestId("computer-stage-title")).toHaveTextContent(
      "Computer",
    );
    expect(screen.getByTestId("computer-detail")).toHaveStyle({
      gap: 24,
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
    });
    expect(screen.getByTestId("computer-detail-scroll-content")).toHaveStyle({
      paddingHorizontal: 24,
    });
    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({
      borderRadius: 0,
      height: "100%",
      width: 312,
    });
    expect(screen.queryByTestId("computer-overview-card")).toBeNull();
    expect(screen.getByTestId("computer-identity-meta")).toBeVisible();
    expect(screen.getByTestId("computer-hero")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("computer-hero-icon")).toHaveStyle({
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("computer-detail-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
    expect(screen.getByTestId("computer-support-grid")).not.toHaveStyle({
      flexDirection: "row",
    });
    expect(screen.getByTestId("computer-install-action-row")).toHaveStyle({
      borderTopWidth: 1,
      minHeight: 72,
    });
  });

  it("stacks Computer support panels at every width, not just narrow ones", async () => {
    // These panels used to sit side by side above a 1080px *viewport*, but
    // they live inside the 760px content column, so the wide case gave the
    // management panel 299px and wrapped its copy inside 190px. The column,
    // not the window, is what constrains them — and it is never wide enough
    // for two, so there is no longer a width at which they split.
    for (const viewportWidth of [1_024, 1_440]) {
      const screen = await render(
        <ComputersScreen
          agents={[agent]}
          computers={[computer]}
          currentServerId={server.id}
          error={null}
          loading={false}
          onCreateComputer={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRequestRegistrationScript={jest.fn()}
          onSelectServer={jest.fn()}
          pendingAction={null}
          servers={[server]}
          viewportWidth={viewportWidth}
        />,
      );

      expect(screen.getByTestId("computer-support-grid")).not.toHaveStyle({
        flexDirection: "row",
      });
      expect(screen.getByTestId("computer-binding-panel")).toBeVisible();
      expect(screen.getByTestId("computer-management-panel")).toBeVisible();
    }
  });

  it("keeps the current Human identity reachable in the shared management frame", async () => {
    const onLogout = jest.fn();
    const screen = await render(
      <ComputersScreen
        agents={[]}
        canManage
        computers={[computer]}
        currentAccount={account}
        currentServerId={server.id}
        error={null}
        imStatus="ready"
        loading={false}
        onCreateComputer={jest.fn()}
        onLogout={onLogout}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开当前账号 Skip"}),
    );
    expect(screen.getByText("skip@example.test")).toBeVisible();
    await fireEvent.press(
      screen.getByRole("button", {name: "退出当前账号"}),
    );
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("creates Computers and reveals installation material only in a dismissible panel", async () => {
    const onCreateComputer = jest.fn(async () => computer);
    const onRequestRegistrationScript = jest.fn(async () => registration);
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={onCreateComputer}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={onRequestRegistrationScript}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={980}
      />,
    );

    expect(screen.getByTestId("computer-sidebar")).toBeVisible();
    expect(screen.getByTestId("computer-stage-title")).toHaveTextContent(
      "Computer",
    );
    expect(screen.getByTestId("computer-detail")).toBeVisible();
    expect(screen.queryByText("HOSTS / 01")).toBeNull();
    expect(screen.getAllByText("在线").length).toBeGreaterThan(0);
    expect(screen.getByText("@research")).toBeVisible();

    await fireEvent.press(
      screen.getByRole("button", {name: "纳管 Computer"}),
    );
    expect(screen.getAllByText("纳管 Computer")).toHaveLength(1);
    await fireEvent.changeText(
      screen.getByLabelText("Computer 名称"),
      "测试机",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "创建 Computer"}),
    );
    expect(onCreateComputer).toHaveBeenCalledWith({
      name: "测试机",
    });

    await fireEvent.press(
      screen.getByRole("button", {
        name: "生成研发机的一键安装命令",
      }),
    );
    await waitFor(() => {
      expect(
        screen.getByText("one-time-registration-material"),
      ).toBeVisible();
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "关闭一键安装命令"}),
    );
    expect(
      screen.queryByText("one-time-registration-material"),
    ).toBeNull();
  });

  it("uses an actionable empty state instead of a decorative zero metric", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.queryByText("00")).toBeNull();
    expect(
      screen.queryByRole("button", {name: "从侧栏纳管 Computer"}),
    ).toBeNull();
    expect(screen.queryByRole("button", {name: "纳管 Computer"})).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态纳管 Computer"}),
    );
    expect(screen.getByLabelText("Computer 名称")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "创建 Computer"}),
    ).toHaveStyle({opacity: 0.5});
    expect(screen.queryByTestId("management-empty-state")).toBeNull();
  });

  it("uses semantic icons for Computer management actions", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("computer-create-icon")).toBeVisible();
    expect(screen.getByTestId("computer-refresh-icon")).toBeVisible();
    expect(screen.queryByText("↻")).toBeNull();
  });

  it("removes a redundant compact collection when there is only one Computer", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("computer-sidebar")).toBeNull();
    expect(screen.getByTestId("computer-stage-title")).toHaveTextContent(
      "Computer",
    );
    expect(screen.getByTestId("computer-detail-scroll-content")).toHaveStyle({
      paddingHorizontal: 16,
    });
    expect(screen.getByTestId("computer-hero-icon")).toHaveStyle({
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("computer-detail-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
    expect(screen.getByTestId("computer-hero")).toHaveStyle({
      alignItems: "center",
      flexDirection: "row",
      flexWrap: "wrap",
    });
    expect(screen.getByTestId("computer-hero-identity")).toHaveStyle({
      flex: 1,
      flexDirection: "row",
    });
  });

  it("keeps a permanent vertical Computer directory on wide screens", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({
      borderRadius: 0,
      height: "100%",
      width: 312,
    });
    expect(
      screen.getByRole("button", {name: "打开 Computer 研发机"}),
    ).toHaveProp("accessibilityState", {selected: true});
    expect(screen.getByTestId("computer-detail")).toBeVisible();
  });

  it("selects the first Computer when the root route receives data after loading", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[]}
        currentServerId={server.id}
        error={null}
        loading
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectComputer={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        selectedComputerId={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    await screen.rerender(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectComputer={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        selectedComputerId={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.queryByText("找不到这台 Computer")).toBeNull();
    expect(screen.getByTestId("computer-detail-title")).toHaveTextContent(
      "研发机",
    );
    expect(
      screen.getByRole("button", {name: "打开 Computer 研发机"}),
    ).toHaveProp("accessibilityState", {selected: true});
  });

  it("projects a route-selected Computer and reports directory navigation", async () => {
    const onSelectComputer = jest.fn();
    const secondComputer = {
      ...computer,
      id: "computer-2",
      name: "测试机",
    };
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer, secondComputer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectComputer={onSelectComputer}
        onSelectServer={jest.fn()}
        pendingAction={null}
        selectedComputerId={secondComputer.id}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("computer-detail-title")).toHaveTextContent(
      "测试机",
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Computer 研发机"}),
    );
    expect(onSelectComputer).toHaveBeenCalledWith(computer.id);
  });

  it("does not project a different Computer into an unknown stable URL", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectComputer={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        selectedComputerId="missing-computer"
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.queryByTestId("computer-detail")).toBeNull();
    expect(screen.getByText("找不到这台 Computer")).toBeVisible();
  });

  it("keeps multiple Computers inside the full-width management canvas", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer, {...computer, id: "computer-2", name: "测试机"}]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.queryByText("HOSTS / 02")).toBeNull();
    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({
      borderRadius: 0,
      height: "100%",
      width: 312,
    });
  });

  it("uses a full-width Computer picker instead of clipping the next card on mobile", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer, {...computer, id: "computer-2", name: "测试机"}]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("computer-mobile-switcher")).toHaveStyle({
      width: "100%",
    });
    expect(
      screen.getByRole("button", {
        name: "切换 Computer，当前 研发机",
      }),
    ).toHaveStyle({minHeight: velaTheme.recipes.managementWorkspace.switcherTriggerMinHeight, width: "100%"});
    expect(
      screen.queryByRole("button", {name: "打开 Computer 测试机"}),
    ).toBeNull();

    await fireEvent.press(
      screen.getByRole("button", {
        name: "切换 Computer，当前 研发机",
      }),
    );
    await fireEvent.press(
      screen.getByRole("button", {name: "打开 Computer 测试机"}),
    );

    expect(screen.getByTestId("computer-detail-title")).toHaveTextContent(
      "测试机",
    );
    expect(
      screen.queryByRole("button", {name: "打开 Computer 研发机"}),
    ).toBeNull();
  });

  it("keeps the complete horizontal Computer switcher at tablet width", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer, {...computer, id: "computer-2", name: "测试机"}]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={768}
      />,
    );

    expect(screen.queryByTestId("computer-mobile-switcher")).toBeNull();
    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({height: 96});
    expect(
      screen.getByRole("button", {name: "打开 Computer 测试机"}),
    ).toBeVisible();
    expect(screen.queryByTestId("computer-overview-card")).toBeNull();
    expect(screen.getByTestId("computer-identity-meta")).toBeVisible();
    expect(screen.getByTestId("computer-hero")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("computer-hero-icon")).toHaveStyle({
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("computer-support-grid")).not.toHaveStyle({
      flexDirection: "row",
    });
  });

  it("uses a comfortable desktop density instead of compressing the detail into the corner", async () => {
    const observedComputer = {
      ...computer,
      lastObservedAt: "2026-08-02T02:31:00.000Z",
    };
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[
          observedComputer,
          {...computer, id: "computer-2", name: "测试机"},
        ]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("computer-sidebar")).toHaveStyle({
      borderRadius: 0,
      height: "100%",
      width: 312,
    });
    expect(screen.getByTestId("computer-detail")).toHaveStyle({
      alignSelf: "center",
      gap: 24,
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
      width: "100%",
    });
    expect(screen.getByTestId("computer-hero-icon")).toHaveStyle({
      backgroundColor: "#EAF4FF",
      borderRadius: 10,
      height: 48,
      width: 48,
    });
    expect(screen.getByTestId("computer-detail-title")).toHaveStyle({
      fontSize: velaTheme.semantic.typography.pageTitle.fontSize,
      lineHeight: velaTheme.semantic.typography.pageTitle.lineHeight,
    });
    expect(screen.getByText(/2026年8月2日/)).toBeVisible();
    expect(screen.queryByText("2026-08-02T02:31:00.000Z")).toBeNull();
  });

  it("keeps Computer actions quiet and reserves emphasis for the page hierarchy", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveComputer={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(
      screen.getByRole("button", {name: "纳管 Computer"}),
    ).toHaveStyle({
      backgroundColor: "#EAF4FF",
      borderColor: "#EAF4FF",
      minHeight: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(
      screen.getByRole("button", {name: "生成研发机的一键安装命令"}),
    ).toHaveStyle({
      backgroundColor: "#FFFFFF",
      minHeight: velaTheme.recipes.managementWorkspace.actionHeight,
    });
    expect(screen.getByTestId("computer-release-section")).toHaveStyle({
      borderRadius: 0,
      borderTopWidth: 1,
    });
  });

  it("renders a completed connection as a restrained positive notice", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error="Computer 已完成连接"
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("computer-feedback")).toHaveStyle({
      backgroundColor: "#E9F9EF",
      borderRadius: 0,
      minHeight: 36,
    });
  });

  it("uses a spacious desktop information surface instead of a shallow strip of cards", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("computer-stage")).toHaveStyle({
      backgroundColor: "#FFFFFF",
    });
    expect(screen.queryByTestId("computer-overview-card")).toBeNull();
    expect(screen.getByTestId("computer-hero")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("computer-identity-meta")).toBeVisible();
    expect(screen.queryByText("连接状态")).toBeNull();
    expect(screen.getByTestId("computer-support-grid")).not.toHaveStyle({
      flexDirection: "row",
    });
    expect(screen.getByTestId("computer-binding-panel")).toHaveStyle({
      borderRadius: 0,
      borderTopWidth: 1,
      paddingHorizontal: 0,
    });
    expect(screen.getByTestId("computer-management-panel")).toBeVisible();
    expect(screen.getByText("安装与重新连接")).toBeVisible();
    expect(screen.getByText("生成一次性安装脚本，连接这台机器。")).toBeVisible();
  });

  it("stacks the richer Computer surface without squeezing mobile content", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={320}
      />,
    );

    expect(screen.queryByTestId("server-rail")).toBeNull();
    expect(screen.queryByTestId("computer-overview-card")).toBeNull();
    expect(screen.getByTestId("computer-hero")).toHaveStyle({
      borderBottomWidth: 0,
      flexDirection: "row",
      flexWrap: "wrap",
      paddingBottom: 20,
    });
    expect(screen.getByTestId("computer-support-grid")).not.toHaveStyle({
      flexDirection: "row",
    });
    expect(screen.getByTestId("computer-binding-panel")).toHaveStyle({
      borderTopWidth: 1,
    });
    expect(screen.getByTestId("computer-management-panel")).toHaveStyle({
      borderTopWidth: 1,
    });
  });

  it("uses a centered, labelled create card without duplicating the header action", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[]}
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "纳管 Computer"}),
    );
    expect(screen.getByText("Computer 名称")).toBeVisible();
    expect(screen.getByTestId("computer-create-form")).toHaveStyle({
      alignSelf: "center",
      maxWidth: velaTheme.recipes.managementWorkspace.formMaxWidth,
      width: "100%",
    });
    expect(
      screen.queryByRole("button", {name: "纳管 Computer"}),
    ).toBeNull();
  });

  it("confirms release without implying that the real machine will be deleted", async () => {
    const onRemoveComputer = jest.fn(async () => true);
    const screen = await render(
      <ComputersScreen
        agents={[]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveComputer={onRemoveComputer}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "解除纳管研发机"}),
    );
    expect(
      screen.getByText("不会删除真实机器上的文件或程序。再次纳管会创建新的 Computer。"),
    ).toBeVisible();
    expect(onRemoveComputer).not.toHaveBeenCalled();

    await fireEvent.press(
      screen.getByRole("button", {name: "确认解除纳管研发机"}),
    );
    expect(onRemoveComputer).toHaveBeenCalledWith(computer.id);
  });

  it("blocks release in the interface while the Computer still has bound Agents", async () => {
    const onRemoveComputer = jest.fn();
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRemoveComputer={onRemoveComputer}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByText("请先迁移或解绑 1 个 Agent")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "解除纳管研发机"}),
    ).toBeDisabled();
    expect(onRemoveComputer).not.toHaveBeenCalled();
  });

  it("opens a provider-neutral terminal for an online Computer", async () => {
    const submitLine = jest.fn();
    const close = jest.fn();
    const controller = {
      close,
      open: jest.fn(async () => undefined),
      resize: jest.fn(),
      sendControl: jest.fn(),
      snapshot: () => ({
        output: new TextEncoder().encode("ready\n"),
        status: "ready" as const,
        truncated: false,
      }),
      submitLine,
      subscribe(listener: (state: TerminalControllerState) => void) {
        listener(this.snapshot());
        return () => undefined;
      },
      write: jest.fn(),
      writeText: jest.fn(),
    };
    const onCreateTerminalController = jest.fn(() => controller);
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onCreateTerminalController={onCreateTerminalController}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", {name: "打开研发机终端"}),
    );
    expect(onCreateTerminalController).toHaveBeenCalledWith(computer.id);
    expect(screen.getByText("终端已连接")).toBeVisible();
    expect(screen.getByText("研发机 / 终端")).toBeVisible();
    expect(screen.getByTestId("computer-terminal-panel")).toHaveStyle({
      backgroundColor: "#FFFFFF",
      borderRadius: 16,
      flex: 1,
      minHeight: 0,
    });
    expect(screen.getByTestId("computer-terminal-output")).toHaveStyle({
      flex: 1,
      minHeight: 260,
    });
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/TAT|PTY|Region/u);
    await fireEvent.changeText(screen.getByLabelText("终端命令"), "pwd");
    await fireEvent.press(screen.getByRole("button", {name: "发送终端命令"}));
    expect(submitLine).toHaveBeenCalledWith("pwd");
    await fireEvent.press(screen.getByRole("button", {name: "关闭终端"}));
    expect(close).toHaveBeenCalled();
  });

  it("explains an unavailable embedded terminal instead of hiding the capability", async () => {
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        terminalUnavailableReason="TUI 当前不支持页面内嵌终端。"
        viewportWidth={1_280}
      />,
    );

    expect(
      screen.getByText("TUI 当前不支持页面内嵌终端。"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {name: "打开研发机终端"}),
    ).toBeNull();
  });

  it("removes the repeated Computer strip while a compact terminal is open", async () => {
    const controller = {
      close: jest.fn(),
      open: jest.fn(async () => undefined),
      resize: jest.fn(),
      sendControl: jest.fn(),
      snapshot: () => ({
        output: new TextEncoder().encode("ready\n"),
        status: "ready" as const,
        truncated: false,
      }),
      submitLine: jest.fn(),
      subscribe(listener: (state: TerminalControllerState) => void) {
        listener(this.snapshot());
        return () => undefined;
      },
      writeText: jest.fn(),
    };
    const screen = await render(
      <ComputersScreen
        agents={[agent]}
        canManage
        computers={[computer]}
        currentServerId={server.id}
        error={null}
        loading={false}
        onCreateComputer={jest.fn()}
        onCreateTerminalController={() => controller}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRequestRegistrationScript={jest.fn()}
        onSelectServer={jest.fn()}
        pendingAction={null}
        servers={[server]}
        viewportWidth={390}
      />,
    );

    expect(screen.queryByTestId("computer-sidebar")).toBeNull();
    await fireEvent.press(
      screen.getByRole("button", {name: "打开研发机终端"}),
    );
    expect(screen.queryByTestId("computer-sidebar")).toBeNull();
    expect(screen.getByTestId("computer-terminal-panel")).toBeVisible();
  });
});
