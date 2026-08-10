import type {
  Agent,
  InboxItem,
  Reminder,
  Server,
  Task,
} from "@vela/client-core";
import {
  act,
  fireEvent,
  render,
} from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import {
  PresentationProvider,
  TasksScreen,
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

const task: Task = {
  assignmentRevision: 1,
  createdByMemberId: "member-1",
  id: "task-1",
  number: 12,
  revision: 1,
  serverId: server.id,
  status: "todo",
  title: "验证 Agent 自动回复",
  updatedByMemberId: "member-1",
};

const inbox: InboxItem = {
  id: "inbox-1",
  kind: "task",
  resourceId: task.id,
  serverId: server.id,
  status: "todo",
  title: task.title,
  updatedAt: "2026-07-31T08:00:00.000Z",
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
  runtime: {kind: "codex"},
  serverId: server.id,
};

const reminder: Reminder = {
  agentId: agent.id,
  createdByMemberId: "member-1",
  id: "reminder-1",
  nextFireAt: "2026-08-02T01:00:00.000Z",
  revision: 1,
  schedule: "2026-08-02T01:00:00.000Z",
  scheduleKind: "once",
  serverId: server.id,
  status: "active",
  text: "汇报项目进展",
  timezone: "Asia/Shanghai",
};

describe("TasksScreen", () => {
  it("publishes task semantics to an injected presenter without duplicating task state", async () => {
    let latestModel: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_model, fallback) {
        return fallback;
      },
      renderManagementPage(model) {
        latestModel = model;
        const primaryAction = model.form?.actions.find(
          action => action.kind === "primary",
        ) ?? model.empty?.action;
        return (
          <Pressable
            accessibilityLabel={primaryAction?.label}
            accessibilityRole="button"
            disabled={!primaryAction}
            onPress={primaryAction?.run}
            testID="semantic-task-presenter"
          >
            <Text>{model.form?.title ?? model.empty?.title ?? model.header.title}</Text>
          </Pressable>
        );
      },
      renderWorkspaceSetup(_model, fallback) {
        return fallback;
      },
    };
    const onCreateTask = jest.fn(async () => undefined);
    const screen = await render(
      <PresentationProvider presenter={presenter}>
        <TasksScreen
          currentServerId={server.id}
          error={null}
          inbox={[]}
          loading={false}
          onCreateTask={onCreateTask}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateTask={jest.fn()}
          pendingAction={null}
          servers={[server]}
          tasks={[]}
          viewportWidth={1_280}
        />
      </PresentationProvider>,
    );

    expect(screen.getByTestId("semantic-task-presenter")).toBeVisible();
    expect(screen.queryByTestId("platform-frame")).toBeNull();
    expect(latestModel).toMatchObject({
      collection: {items: []},
      empty: {
        action: {label: "创建第一个任务"},
        title: "还没有任务",
      },
      header: {
        eyebrow: "协作任务",
        title: "任务",
      },
      id: "tasks",
      segments: [
        {id: "tasks", label: "任务", selected: true},
        {id: "reminders", label: "提醒", selected: false},
      ],
    });

    await fireEvent.press(
      screen.getByRole("button", {name: "创建第一个任务"}),
    );
    expect(screen.getByText("新建任务")).toBeVisible();
    expect(
      (latestModel as ManagementPageModel | null)?.form?.fields.map(
        field => field.label,
      ),
    ).toEqual([
      "任务标题",
      "执行 Agent",
      "任务描述",
    ]);
  });

  it("publishes reminder creation through the same semantic form contract", async () => {
    let latestModel: ManagementPageModel | null = null;
    const presenter: HumanClientPresenter = {
      kind: "terminal",
      renderConversationPage(_model, fallback) {
        return fallback;
      },
      renderManagementPage(model) {
        latestModel = model;
        return <Text>{model.form?.title ?? model.header.title}</Text>;
      },
      renderWorkspaceSetup(_model, fallback) {
        return fallback;
      },
    };
    await render(
      <PresentationProvider presenter={presenter}>
        <TasksScreen
          agents={[agent]}
          currentServerId={server.id}
          error={null}
          inbox={[]}
          loading={false}
          loadingReminders={false}
          onCancelReminder={jest.fn()}
          onCreateReminder={jest.fn()}
          onCreateTask={jest.fn()}
          onNavigateSection={jest.fn()}
          onRefresh={jest.fn()}
          onRefreshReminders={jest.fn()}
          onSelectServer={jest.fn()}
          onUpdateReminder={jest.fn()}
          onUpdateTask={jest.fn()}
          pendingAction={null}
          reminders={[]}
          servers={[server]}
          tasks={[]}
        />
      </PresentationProvider>,
    );

    await act(async () => {
      (latestModel as unknown as ManagementPageModel).segments?.find(
        segment => segment.id === "reminders",
      )?.onSelect();
    });
    await act(async () => {
      await (latestModel as unknown as ManagementPageModel).commands
        .find(action => action.id === "create-reminder")?.run();
    });

    expect((latestModel as unknown as ManagementPageModel).form).toMatchObject({
      actions: [
        {id: "cancel-create-reminder"},
        {id: "submit-create-reminder"},
      ],
      fields: [
        {id: "reminder-kind"},
        {id: "reminder-agent"},
        {id: "reminder-text"},
        {id: "reminder-schedule"},
        {id: "reminder-timezone"},
      ],
      title: "新建提醒",
    });
  });

  it("keeps wide-screen task content readable instead of leaving it compressed", async () => {
    const screen = await render(
      <TasksScreen
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        servers={[server]}
        tasks={[task]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("task-sidebar")).toHaveStyle({
      borderRadius: 0,
      width: 312,
    });
    expect(
      screen.getByRole("button", {name: "打开任务 12"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight});
    expect(screen.getByTestId("task-detail")).toHaveStyle({
      alignSelf: "center",
      borderRadius: 0,
      maxWidth: velaTheme.recipes.managementWorkspace.contentMaxWidth,
      width: "100%",
    });
  });

  it("uses the platform frame and lets Human create work for an Agent", async () => {
    const onCreateTask = jest.fn(async () => undefined);
    const onUpdateTask = jest.fn(async () => undefined);
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={onCreateTask}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn(async () => undefined)}
        onSelectServer={jest.fn()}
        onUpdateTask={onUpdateTask}
        pendingAction={null}
        servers={[server]}
        tasks={[task]}
        viewportWidth={980}
      />,
    );

    // 980 keeps the vertical task sidebar once chrome leaves compact — shelf
    // stacking is only for sub-960 widths.
    expect(screen.getByTestId("task-sidebar")).toHaveStyle({
      height: "100%",
      width: 312,
    });
    expect(screen.getByTestId("task-collection-toolbar")).toHaveStyle({
      borderBottomWidth: velaTheme.semantic.stroke.hairline,
      paddingHorizontal: velaTheme.spacing.md,
    });
    expect(screen.queryByTestId("task-collection-shelf")).toBeNull();
    expect(
      screen.getByRole("button", {name: "打开任务 12"}),
    ).toHaveStyle({minHeight: velaTheme.recipes.control.rowHeight});
    expect(screen.getByTestId("server-rail")).toBeVisible();
    expect(screen.queryByTestId("mobile-bottom-nav")).toBeNull();
    expect(screen.getByText("待处理 1")).toBeVisible();
    expect(screen.getAllByText(task.title).length).toBeGreaterThan(0);

    await fireEvent.press(
      screen.getByRole("button", { name: "新建任务" }),
    );
    expect(screen.getByText("任务标题")).toBeVisible();
    expect(screen.getByText("任务描述")).toBeVisible();
    expect(screen.getByTestId("task-create-form")).toHaveStyle({
      alignSelf: "center",
      maxWidth: velaTheme.recipes.managementWorkspace.formMaxWidth,
      width: "100%",
    });
    await fireEvent.changeText(
      screen.getByLabelText("任务标题"),
      "补齐移动端",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "创建任务" }),
    );
    expect(onCreateTask).toHaveBeenCalledWith({
      description: undefined,
      ownerMemberId: agent.id,
      title: "补齐移动端",
    });
    expect(screen.queryByText("领取任务")).toBeNull();
    expect(screen.queryByText("设为进行中")).toBeNull();
    expect(onUpdateTask).not.toHaveBeenCalled();
  });

  it("reserves execution for Agent and gives Human review controls", async () => {
    const onUpdateTask = jest.fn(async () => undefined);
    const reviewTask: Task = {
      ...task,
      ownerMemberId: agent.id,
      status: "in_review",
    };
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={onUpdateTask}
        pendingAction={null}
        servers={[server]}
        tasks={[reviewTask]}
        viewportWidth={980}
      />,
    );

    expect(screen.getByText(/研究助手 · @research/)).toBeVisible();
    await fireEvent.press(screen.getByRole("button", {name: "退回修改"}));
    expect(onUpdateTask).toHaveBeenCalledWith(task.id, {
      status: "in_progress",
    });
    await fireEvent.press(screen.getByRole("button", {name: "验收通过"}));
    expect(onUpdateTask).toHaveBeenCalledWith(task.id, {status: "done"});
  });

  it("uses a resource select instead of a button strip for dynamic Agent assignment", async () => {
    const onUpdateTask = jest.fn(async () => undefined);
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={onUpdateTask}
        pendingAction={null}
        servers={[server]}
        tasks={[task]}
        viewportWidth={1_280}
      />,
    );

    const assignment = screen.getByRole("combobox", {name: "指派执行 Agent"});
    await fireEvent.press(assignment);
    expect(screen.getByRole("listbox", {name: "指派执行 Agent"})).toBeVisible();
    await fireEvent.press(screen.getByRole("option", {name: "指派给 研究助手"}));
    expect(onUpdateTask).toHaveBeenCalledWith(task.id, {ownerMemberId: agent.id});
  });

  it("turns the empty state into the primary path for creating work", async () => {
    const screen = await render(
      <TasksScreen
        currentServerId={server.id}
        error={null}
        inbox={[]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        servers={[server]}
        tasks={[]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("task-sidebar")).toHaveStyle({
      borderRadius: 0,
      width: 312,
    });
    expect(screen.queryByTestId("task-empty-toolbar")).toBeNull();
    expect(screen.queryByTestId("task-empty-mode-tabs")).toBeNull();
    expect(screen.queryByText("00")).toBeNull();
    expect(
      screen.queryByRole("button", {name: "从侧栏新建任务"}),
    ).toBeNull();
    expect(screen.queryByRole("button", {name: "新建任务"})).toBeNull();
    expect(screen.getByTestId("management-empty-state")).toHaveStyle({
      alignItems: "flex-start",
      minHeight: velaTheme.recipes.emptyState.stageMinHeight,
    });
    await fireEvent.press(
      screen.getByRole("button", {name: "从空状态新建任务"}),
    );
    expect(screen.getByLabelText("任务标题")).toBeVisible();
    expect(
      screen.getByRole("button", {name: "创建任务"}),
    ).toHaveStyle({opacity: 0.5});
    expect(screen.queryByTestId("task-empty-toolbar")).toBeNull();
    expect(screen.queryByTestId("management-empty-state")).toBeNull();
  });

  it("keeps the desktop Collection stable when switching to an empty Reminder mode", async () => {
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        loadingReminders={false}
        onCancelReminder={jest.fn()}
        onCreateReminder={jest.fn()}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRefreshReminders={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateReminder={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        reminders={[]}
        servers={[server]}
        tasks={[task]}
        viewportWidth={1_440}
      />,
    );

    expect(screen.getByTestId("task-sidebar")).toHaveStyle({width: 312});
    expect(screen.queryByTestId("task-empty-toolbar")).toBeNull();
    expect(screen.getByRole("tablist", {name: "任务视图"})).toBeVisible();
    expect(screen.getByRole("tab", {name: "任务"}).props["aria-controls"]).toBe(
      "tasks-panel",
    );
    expect(screen.getByRole("tabpanel").props.nativeID).toBe("tasks-panel");

    await fireEvent.press(screen.getByRole("tab", {name: "提醒"}));

    expect(screen.getByTestId("task-sidebar")).toHaveStyle({width: 312});
    expect(screen.queryByTestId("task-empty-toolbar")).toBeNull();
    expect(screen.getByRole("tabpanel").props.nativeID).toBe("reminders-panel");
    expect(screen.getByText("还没有提醒")).toBeVisible();
  });

  it("uses semantic icons for task management actions", async () => {
    const screen = await render(
      <TasksScreen
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        servers={[server]}
        tasks={[task]}
        viewportWidth={1_280}
      />,
    );

    expect(screen.getByTestId("task-create-icon")).toBeVisible();
    expect(screen.getByTestId("task-refresh-icon")).toBeVisible();
    expect(screen.getByRole("button", {name: "新建任务"})).toHaveStyle({
      backgroundColor: velaTheme.semantic.color.surfaceTransparent,
      borderColor: velaTheme.semantic.color.borderTransparent,
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.queryByText("↻")).toBeNull();
  });

  it("keeps all five sections reachable on a compact screen", async () => {
    const screen = await render(
      <TasksScreen
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        servers={[server]}
        tasks={[task]}
        viewportWidth={390}
      />,
    );

    expect(screen.getByTestId("mobile-bottom-nav")).toBeVisible();
    expect(screen.getByRole("button", {name: "刷新任务"})).toHaveStyle({
      height: velaTheme.recipes.managementWorkspace.headerActionHeight,
      width: velaTheme.recipes.managementWorkspace.headerActionHeight,
    });
    expect(screen.getByTestId("task-stage-header-copy")).toHaveStyle({
      flex: 1,
      minWidth: 0,
    });
    expect(screen.getByTestId("task-stage-title").props.numberOfLines).toBe(1);
    expect(
      screen.getByRole("button", { name: "打开成员" }),
    ).toBeVisible();
    expect(screen.getAllByText(task.title).length).toBeGreaterThan(0);
  });

  it("keeps the Task and Reminder modes reachable on a compact screen", async () => {
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        loadingReminders={false}
        onCancelReminder={jest.fn()}
        onCreateReminder={jest.fn()}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRefreshReminders={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateReminder={jest.fn()}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        reminders={[reminder]}
        servers={[server]}
        tasks={[task]}
        viewportWidth={390}
      />,
    );

    await fireEvent.press(screen.getByRole("tab", {name: "提醒"}));
    expect(screen.getAllByText(reminder.text).length).toBeGreaterThan(0);
  });

  it("manages Reminders from the Task page secondary tab", async () => {
    const onCreateReminder = jest.fn(async () => reminder);
    const onUpdateReminder = jest.fn(async () => undefined);
    const onCancelReminder = jest.fn(async () => undefined);
    const screen = await render(
      <TasksScreen
        agents={[agent]}
        currentServerId={server.id}
        error={null}
        inbox={[inbox]}
        loading={false}
        loadingReminders={false}
        onCancelReminder={onCancelReminder}
        onCreateReminder={onCreateReminder}
        onCreateTask={jest.fn()}
        onNavigateSection={jest.fn()}
        onRefresh={jest.fn()}
        onRefreshReminders={jest.fn()}
        onSelectServer={jest.fn()}
        onUpdateReminder={onUpdateReminder}
        onUpdateTask={jest.fn()}
        pendingAction={null}
        reminders={[reminder]}
        servers={[server]}
        tasks={[task]}
        viewportWidth={1_280}
      />,
    );

    await fireEvent.press(screen.getByRole("tab", {name: "提醒"}));
    expect(screen.getAllByText(reminder.text).length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByRole("button", {name: "新建提醒"}));
    expect(screen.getByText("提醒类型")).toBeVisible();
    expect(screen.getByText("执行 Agent")).toBeVisible();
    expect(screen.getByText("提醒内容")).toBeVisible();
    expect(screen.getByText("执行时间")).toBeVisible();
    expect(screen.getByText("时区")).toBeVisible();
    expect(screen.getByText("周期")).toBeVisible();
    expect(screen.queryByText("Cron")).toBeNull();
    expect(screen.getByLabelText("提醒执行时间")).toBeVisible();
    expect(screen.queryByLabelText("提醒周期规则")).toBeNull();
    expect(screen.queryByLabelText("提醒时间或 Cron")).toBeNull();
    expect(screen.getByLabelText("提醒执行时间").props.accessibilityHint).toBe(
      "时区 Asia/Shanghai",
    );
    await fireEvent.press(
      screen.getByRole("radio", {name: "选择周期提醒"}),
    );
    expect(screen.getByLabelText("提醒周期规则")).toBeVisible();
    expect(screen.queryByLabelText("提醒执行时间")).toBeNull();
    await fireEvent.press(
      screen.getByRole("radio", {name: "选择一次提醒"}),
    );
    await fireEvent.changeText(
      screen.getByLabelText("提醒内容"),
      "检查线上状态",
    );
    await fireEvent.changeText(
      screen.getByLabelText("提醒执行时间"),
      "2026-08-03T09:00",
    );
    await fireEvent.changeText(
      screen.getByLabelText("提醒时区"),
      "America/New_York",
    );
    expect(screen.getByLabelText("提醒执行时间").props.accessibilityHint).toBe(
      "时区 America/New_York",
    );
    await fireEvent.press(screen.getByRole("combobox", {name: "执行 Agent"}));
    await fireEvent.press(
      screen.getByRole("option", {name: "选择提醒 Agent 研究助手"}),
    );
    await fireEvent.press(screen.getByRole("button", {name: "创建提醒"}));
    expect(onCreateReminder).toHaveBeenCalledWith(expect.objectContaining({
      agentId: agent.id,
      schedule: "2026-08-03T09:00:00-04:00",
      scheduleKind: "once",
      text: "检查线上状态",
      timezone: "America/New_York",
    }));

    await fireEvent.press(screen.getByRole("button", {name: "暂停提醒"}));
    expect(onUpdateReminder).toHaveBeenCalledWith(reminder.id, {
      status: "paused",
    });
    await fireEvent.press(screen.getByRole("button", {name: "取消提醒"}));
    expect(onCancelReminder).toHaveBeenCalledWith(reminder.id);
  });
});
