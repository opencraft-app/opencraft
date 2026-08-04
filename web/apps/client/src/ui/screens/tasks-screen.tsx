import type {
  Agent,
  CreateReminderInput,
  CreateTaskInput,
  InboxItem,
  Reminder,
  Server,
  Task,
  UpdateReminderInput,
  UpdateTaskInput,
} from "@vela/client-core";
import { useEffect, useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Bell from "lucide-react-native/icons/bell";
import ListChecks from "lucide-react-native/icons/list-checks";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";

import {ManagementEmptyState} from "../components/management-empty-state";
import {
  ActionButton,
  CollectionRow,
  DetailHeading,
  DetailSection,
  IconActionButton,
  InlineFeedback,
  ManagementCollectionFooterAction,
  ManagementCollectionHeader,
  ManagementCollectionPane,
  ManagementDateTimeInput,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormActions,
  ManagementHeader,
  ManagementTab,
  ManagementTabBar,
  ManagementStage,
  ManagementTextInput,
  SelectionButton,
  SelectionGroup,
} from "../components/management-workspace";
import {breakpoints} from "../theme";
import {deviceTimezone, normalizeLocalDateTime} from "../date-time";
import { layoutMode } from "../layout-mode";
import {
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
} from "../presentation";
import {
  PlatformFrame,
  type PlatformFrameProps,
  type WorkspaceSection,
} from "../layouts/workspace-shell";

export interface TasksScreenProps {
  agents?: Agent[];
  canManage?: boolean;
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
  inbox: InboxItem[];
  imStatus?: PlatformFrameProps["imStatus"];
  loading: boolean;
  loadingReminders?: boolean;
  onCancelReminder?(reminderId: string): void | Promise<void>;
  onCreateTask(input: CreateTaskInput): void | Promise<void>;
  onCreateReminder?(
    input: CreateReminderInput,
  ): Reminder | null | Promise<Reminder | null>;
  onLogout?: PlatformFrameProps["onLogout"];
  onNavigateSection(section: WorkspaceSection): void;
  onRefresh(): void | Promise<void>;
  onRefreshReminders?(): void | Promise<void>;
  onSelectServer(serverId: string): void | Promise<void>;
  onUpdateTask(
    taskId: string,
    input: UpdateTaskInput,
  ): void | Promise<void>;
  onUpdateReminder?(
    reminderId: string,
    input: UpdateReminderInput,
  ): void | Promise<void>;
  pendingAction: string | null;
  sectionHref?: PlatformFrameProps["sectionHref"];
  serverHref?: PlatformFrameProps["serverHref"];
  servers: Server[];
  reminders?: Reminder[];
  tasks: Task[];
  viewportWidth?: number;
}

export function TasksScreen(props: TasksScreenProps) {
  const {
    agents = [],
    canManage = false,
    currentAccount,
    currentServerId,
    error,
    inbox,
    imStatus,
    loading,
    loadingReminders = false,
    onCancelReminder,
    onCreateTask,
    onCreateReminder,
    onLogout,
    onNavigateSection,
    onRefresh,
    onRefreshReminders,
    onSelectServer,
    onUpdateTask,
    onUpdateReminder,
    pendingAction,
    sectionHref,
    serverHref,
    servers,
    reminders = [],
    tasks,
    viewportWidth,
  } = props;
  const window = useWindowDimensions();
  const resolvedViewportWidth = viewportWidth ?? window.width;
  const frameMode = layoutMode(resolvedViewportWidth);
  const compact = frameMode === "compact";
  const medium = frameMode === "medium";
  const phone = resolvedViewportWidth < breakpoints.medium;
  const stackedCollection = compact || medium;
  const [creating, setCreating] = useState(false);
  const [creatingReminder, setCreatingReminder] = useState(false);
  const [reminderAgentId, setReminderAgentId] = useState(agents[0]?.id ?? "");
  const [reminderSchedule, setReminderSchedule] = useState("");
  const [reminderScheduleKind, setReminderScheduleKind] =
    useState<Reminder["scheduleKind"]>("once");
  const [reminderText, setReminderText] = useState("");
  const [reminderTimezone, setReminderTimezone] = useState(deviceTimezone());
  const [mode, setMode] = useState<"reminders" | "tasks">("tasks");
  const [description, setDescription] = useState("");
  const [ownerMemberId, setOwnerMemberId] = useState(
    agents[0]?.id ?? "",
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    tasks[0]?.id ?? null,
  );
  const [title, setTitle] = useState("");
  const [selectedReminderId, setSelectedReminderId] = useState<
    string | null
  >(reminders[0]?.id ?? null);
  const selectedTask = useMemo(
    () =>
      tasks.find((task) => task.id === selectedTaskId) ??
      tasks[0] ??
      null,
    [selectedTaskId, tasks],
  );
  const selectedReminder = useMemo(
    () =>
      reminders.find((item) => item.id === selectedReminderId) ??
      reminders[0] ??
      null,
    [reminders, selectedReminderId],
  );
  const reminderMode = mode === "reminders";
  const activeLoading = reminderMode ? loadingReminders : loading;
  const refresh = reminderMode ? onRefreshReminders : onRefresh;
  const activeCreation = reminderMode ? creatingReminder : creating;

  useEffect(() => {
    if (!ownerMemberId && agents[0]) {
      setOwnerMemberId(agents[0].id);
    }
    if (!reminderAgentId && agents[0]) {
      setReminderAgentId(agents[0].id);
    }
  }, [agents, ownerMemberId, reminderAgentId]);

  const submitTask = async () => {
    const normalized = title.trim();
    if (!normalized) return;
    await onCreateTask({
      description: description.trim() || undefined,
      ownerMemberId: ownerMemberId || undefined,
      title: normalized,
    });
    setCreating(false);
    setDescription("");
    setTitle("");
  };
  const cancelReminderCreation = () => {
    setCreatingReminder(false);
    setReminderAgentId(agents[0]?.id ?? "");
    setReminderSchedule("");
    setReminderScheduleKind("once");
    setReminderText("");
    setReminderTimezone(deviceTimezone());
  };
  const submitReminder = async () => {
    if (
      !onCreateReminder ||
      !reminderAgentId ||
      !reminderSchedule.trim() ||
      !reminderText.trim()
    ) return;
    await onCreateReminder({
      agentId: reminderAgentId,
      schedule: reminderScheduleKind === "once"
        ? normalizeLocalDateTime(reminderSchedule, reminderTimezone)
        : reminderSchedule.trim(),
      scheduleKind: reminderScheduleKind,
      text: reminderText.trim(),
      timezone: reminderTimezone.trim() || "Asia/Shanghai",
    });
    cancelReminderCreation();
  };

  const sidebar = (
    <ManagementCollectionPane testID="task-sidebar">
      <ManagementCollectionHeader
        eyebrow={`${tasks.length} 个任务 · ${reminders.length} 个提醒`}
        icon={ListChecks}
        title="任务"
      />
      <ManagementTabBar>
        <ManagementTab
          accessibilityLabel="打开任务队列"
          label="任务"
          onPress={() => setMode("tasks")}
          selected={!reminderMode}
        />
        <ManagementTab
          accessibilityLabel="打开提醒"
          label="提醒"
          onPress={() => setMode("reminders")}
          selected={reminderMode}
        />
      </ManagementTabBar>
      <View style={styles.inboxBand}>
        <Text style={styles.inboxLabel}>
          {reminderMode ? "提醒" : "待处理"}{" "}
          {reminderMode ? reminders.length : inbox.length}
        </Text>
        <IconActionButton
          accessibilityLabel={reminderMode ? "刷新提醒" : "刷新任务"}
          context="compact"
          disabled={activeLoading || !refresh}
          icon={RefreshCw}
          onPress={() => refresh?.()}
          testID="task-refresh-icon"
        />
      </View>
      {reminderMode ? (
        <ReminderList
          agents={agents}
          onSelect={setSelectedReminderId}
          reminders={reminders}
          selectedReminderId={selectedReminder?.id ?? null}
        />
      ) : (
        <TaskList
          onSelect={setSelectedTaskId}
          selectedTaskId={selectedTask?.id ?? null}
          tasks={tasks}
        />
      )}
      {(reminderMode ? reminders.length : tasks.length) > 0 ? (
        <ManagementCollectionFooterAction
          accessibilityLabel={reminderMode ? "从侧栏新建提醒" : "从侧栏新建任务"}
          icon={Plus}
          label={`新建${reminderMode ? "提醒" : "任务"}`}
          onPress={() => reminderMode
            ? setCreatingReminder(true)
            : setCreating(true)}
        />
      ) : null}
    </ManagementCollectionPane>
  );

  const selectedServer = servers.find(item => item.id === currentServerId);
  const refreshAction: PresentationAction = {
    disabled: activeLoading || !refresh,
    id: reminderMode ? "refresh-reminders" : "refresh-tasks",
    label: reminderMode ? "刷新提醒" : "刷新任务",
    run: () => refresh?.(),
    shortcut: "R",
  };
  const createAction: PresentationAction | undefined = reminderMode
    ? onCreateReminder
      ? {
          disabled: pendingAction !== null,
          id: "create-reminder",
          kind: "primary",
          label: reminders.length === 0 ? "创建第一个提醒" : "新建提醒",
          run: () => setCreatingReminder(true),
          shortcut: "N",
        }
      : undefined
    : {
        disabled: pendingAction !== null,
        id: "create-task",
        kind: "primary",
        label: tasks.length === 0 ? "创建第一个任务" : "新建任务",
        run: () => setCreating(true),
        shortcut: "N",
      };
  const semanticModel = (): ManagementPageModel => ({
    collection: {
      items: reminderMode
        ? reminders.map(reminder => {
            const agent = agents.find(item => item.id === reminder.agentId);
            return {
              id: reminder.id,
              meta: agent?.displayName ?? "未知 Agent",
              onSelect: () => setSelectedReminderId(reminder.id),
              selected: reminder.id === selectedReminder?.id,
              status: reminderStatusLabel[reminder.status],
              title: reminder.text,
            };
          })
        : tasks.map(item => ({
            id: item.id,
            meta: `#${item.number}`,
            onSelect: () => setSelectedTaskId(item.id),
            selected: item.id === selectedTask?.id,
            status: taskStatusLabel[item.status],
            subtitle: item.description,
            title: item.title,
          })),
      label: reminderMode ? "提醒" : "任务",
    },
    commands: [
      ...(createAction ? [createAction] : []),
      refreshAction,
    ],
    ...(reminderMode
      ? selectedReminder
        ? {
            detail: {
              actions: [
                ...(selectedReminder.status === "active" ||
                selectedReminder.status === "paused"
                  ? [{
                      disabled: pendingAction !== null,
                      id: "toggle-reminder",
                      label: selectedReminder.status === "active" ? "暂停" : "恢复",
                      run: () => onUpdateReminder?.(selectedReminder.id, {
                        status: selectedReminder.status === "active" ? "paused" : "active",
                      }),
                    } satisfies PresentationAction]
                  : []),
                {
                  disabled: pendingAction !== null || selectedReminder.status === "canceled",
                  id: "cancel-reminder",
                  kind: "danger",
                  label: "取消提醒",
                  run: () => onCancelReminder?.(selectedReminder.id),
                },
              ],
              description: `${agents.find(item => item.id === selectedReminder.agentId)?.displayName ?? "未知 Agent"} · ${selectedReminder.scheduleKind} · ${selectedReminder.nextFireAt ?? "暂无下次时间"}`,
              meta: selectedReminder.schedule,
              status: reminderStatusLabel[selectedReminder.status],
              title: selectedReminder.text,
            },
          }
        : {
            empty: {
              ...(createAction ? {action: createAction} : {}),
              description: "为 Agent 安排一次或周期工作。",
              title: "还没有提醒",
            },
          }
      : selectedTask
        ? {
            detail: {
              actions: selectedTask.status === "in_review"
                ? [
                    {
                      disabled: pendingAction !== null,
                      id: "return-task",
                      label: "退回修改",
                      run: () => onUpdateTask(selectedTask.id, {
                        status: "in_progress",
                      }),
                    },
                    {
                      disabled: pendingAction !== null,
                      id: "approve-task",
                      kind: "primary" as const,
                      label: "验收通过",
                      run: () => onUpdateTask(selectedTask.id, {
                        status: "done",
                      }),
                    },
                  ]
                : [],
              description: selectedTask.description || "暂无描述。",
              meta: `#${selectedTask.number}`,
              status: taskStatusLabel[selectedTask.status],
              title: selectedTask.title,
            },
          }
        : {
            empty: {
              action: createAction,
              description: "创建第一项工作，或从 Agent 对话生成 Task。",
              title: "还没有任务",
            },
          }),
    error: error ?? undefined,
    ...(!reminderMode && creating
      ? {
          form: {
            actions: [
              {
                id: "cancel-create-task",
                label: "取消",
                run: () => setCreating(false),
              },
              {
                disabled: pendingAction !== null || title.trim().length === 0,
                id: "submit-create-task",
                kind: "primary" as const,
                label: "创建任务",
                run: submitTask,
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "task-title",
                label: "任务标题",
                onChange: setTitle,
                placeholder: "要完成什么？",
                value: title,
              },
              {
                disabled: pendingAction !== null,
                id: "task-agent",
                label: "执行 Agent",
                onChange: setOwnerMemberId,
                options: [
                  {label: "未指派", value: ""},
                  ...agents.map(agent => ({
                    label: agent.displayName,
                    value: agent.id,
                  })),
                ],
                value: ownerMemberId,
              },
              {
                disabled: pendingAction !== null,
                id: "task-description",
                label: "任务描述",
                multiline: true,
                onChange: setDescription,
                placeholder: "补充背景、验收标准或链接（可选）",
                value: description,
              },
            ],
            title: "新建任务",
          },
        }
      : {}),
    ...(reminderMode && creatingReminder && onCreateReminder
      ? {
          form: {
            actions: [
              {
                id: "cancel-create-reminder",
                label: "取消",
                run: cancelReminderCreation,
              },
              {
                disabled:
                  pendingAction !== null ||
                  !reminderAgentId ||
                  !reminderSchedule.trim() ||
                  !reminderText.trim(),
                id: "submit-create-reminder",
                kind: "primary" as const,
                label: "创建提醒",
                run: submitReminder,
              },
            ],
            fields: [
              {
                disabled: pendingAction !== null,
                id: "reminder-kind",
                label: "提醒类型",
                onChange: value => setReminderScheduleKind(value as Reminder["scheduleKind"]),
                options: [
                  {label: "一次", value: "once"},
                  {label: "周期", value: "cron"},
                ],
                value: reminderScheduleKind,
              },
              {
                disabled: pendingAction !== null,
                id: "reminder-agent",
                label: "执行 Agent",
                onChange: setReminderAgentId,
                options: agents.map(agent => ({
                  label: agent.displayName,
                  value: agent.id,
                })),
                value: reminderAgentId,
              },
              {
                disabled: pendingAction !== null,
                id: "reminder-text",
                label: "提醒内容",
                multiline: true,
                onChange: setReminderText,
                placeholder: "Agent 到时要完成什么？",
                value: reminderText,
              },
              {
                disabled: pendingAction !== null,
                id: "reminder-schedule",
                label: reminderScheduleKind === "once" ? "执行时间" : "周期规则",
                onChange: setReminderSchedule,
                placeholder: reminderScheduleKind === "once"
                  ? "例如：2026-08-05 09:00"
                  : "例如：0 9 * * 1-5",
                value: reminderSchedule,
              },
              {
                disabled: pendingAction !== null,
                id: "reminder-timezone",
                label: "时区",
                onChange: setReminderTimezone,
                value: reminderTimezone,
              },
            ],
            title: "新建提醒",
          },
        }
      : {}),
    header: {
      eyebrow: reminderMode ? "定时提醒" : "协作任务",
      summary: `${reminderMode ? "提醒" : "待处理"} ${reminderMode ? reminders.length : inbox.length}`,
      title: reminderMode ? "提醒" : "任务",
    },
    id: "tasks",
    segments: [
      {
        id: "tasks",
        label: "任务",
        onSelect: () => setMode("tasks"),
        selected: !reminderMode,
      },
      {
        id: "reminders",
        label: "提醒",
        onSelect: () => setMode("reminders"),
        selected: reminderMode,
      },
    ],
    shell: {
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "tasks",
      navigation: [
        ["chat", "聊天"],
        ["tasks", "任务"],
        ["agents", "Agent"],
        ["computers", "Computer"],
        ["members", "成员"],
      ].map(([section, label]) => ({
        id: `navigate-${section}`,
        label: label!,
        run: () => onNavigateSection(section as WorkspaceSection),
      })),
      ...(onLogout ? {onLogout} : {}),
      serverName: selectedServer?.name,
      serverOptions: servers.map(server => ({
        id: server.id,
        label: server.name,
        onSelect: () => onSelectServer(server.id),
        selected: server.id === currentServerId,
      })),
    },
  });

  return (
    <ManagementPresentation model={semanticModel}>
    <PlatformFrame
      account={currentAccount}
      activeSection="tasks"
      canManageServer={canManage}
      currentServerId={currentServerId}
      imStatus={imStatus}
      navigation={stackedCollection ? null : sidebar}
      onLogout={onLogout}
      onNavigateSection={onNavigateSection}
      onSelectServer={onSelectServer}
      sectionHref={sectionHref}
      serverHref={serverHref}
      servers={servers}
      viewportWidth={viewportWidth}
    >
      <ManagementStage testID="task-stage">
        <ManagementHeader
          actions={(reminderMode ? reminders.length : tasks.length) > 0 &&
          !(reminderMode ? creatingReminder : creating) ? (
            <ActionButton
              accessibilityLabel={reminderMode ? "新建提醒" : "新建任务"}
              context="header"
              icon={Plus}
              iconTestID="task-create-icon"
              importance="tonal"
              label="新建"
              onPress={() => reminderMode
                ? setCreatingReminder(true)
                : setCreating(true)}
            />
          ) : undefined}
          copyTestID="task-stage-header-copy"
          title={reminderMode ? "提醒" : "任务"}
          titleTestID="task-stage-title"
        />
        {error ? <InlineFeedback message={error} /> : null}
        {stackedCollection && !activeCreation ? (
          <View
            style={styles.compactListBlock}
            testID="task-collection-shelf"
          >
            <View>
              <ManagementTabBar>
              <ManagementTab
                accessibilityLabel="打开任务队列"
                label="任务"
                onPress={() => setMode("tasks")}
                selected={!reminderMode}
              />
              <ManagementTab
                accessibilityLabel="打开提醒"
                label="提醒"
                onPress={() => setMode("reminders")}
                selected={reminderMode}
              />
              </ManagementTabBar>
            </View>
            <View style={styles.inboxBand}>
              <Text style={styles.inboxLabel}>
                {reminderMode ? "提醒" : "待处理"}{" "}
                {reminderMode ? reminders.length : inbox.length}
              </Text>
              <IconActionButton
                accessibilityLabel={reminderMode ? "刷新提醒" : "刷新任务"}
                context="compact"
                disabled={!refresh}
                icon={RefreshCw}
                onPress={() => refresh?.()}
                testID="task-compact-refresh-icon"
              />
            </View>
            {reminderMode ? (
              <ReminderList
                agents={agents}
                horizontal
                onSelect={setSelectedReminderId}
                reminders={reminders}
                selectedReminderId={selectedReminder?.id ?? null}
              />
            ) : (
              <TaskList
                horizontal
                onSelect={setSelectedTaskId}
                selectedTaskId={selectedTask?.id ?? null}
                tasks={tasks}
              />
            )}
          </View>
        ) : null}
        <ManagementDetailScroll
          density={phone ? "compact" : medium ? "medium" : "comfortable"}
          testID="task-detail-scroll"
        >
          {!reminderMode && creating ? (
            <TaskCreateForm
              agents={agents}
              description={description}
              disabled={pendingAction !== null}
              onCancel={() => setCreating(false)}
              onChangeDescription={setDescription}
              onChangeOwnerMemberId={setOwnerMemberId}
              onChangeTitle={setTitle}
              onSubmit={async () => {
                await submitTask();
              }}
              ownerMemberId={ownerMemberId}
              title={title}
            />
          ) : reminderMode && creatingReminder && onCreateReminder ? (
            <ReminderCreateForm
              agentId={reminderAgentId}
              agents={agents}
              disabled={pendingAction !== null}
              onCancel={cancelReminderCreation}
              onChangeAgentId={setReminderAgentId}
              onChangeSchedule={setReminderSchedule}
              onChangeScheduleKind={setReminderScheduleKind}
              onChangeText={setReminderText}
              onChangeTimezone={setReminderTimezone}
              onSubmit={submitReminder}
              schedule={reminderSchedule}
              scheduleKind={reminderScheduleKind}
              text={reminderText}
              timezone={reminderTimezone}
            />
          ) : reminderMode ? (
            selectedReminder ? (
              <ReminderDetail
                agent={agents.find((item) => item.id === selectedReminder.agentId)}
                disabled={pendingAction !== null}
                key={selectedReminder.id}
                onCancel={() => onCancelReminder?.(selectedReminder.id)}
                onUpdate={(input) =>
                  onUpdateReminder?.(selectedReminder.id, input)}
                reminder={selectedReminder}
              />
            ) : (
              <ManagementEmptyState
                actionAccessibilityLabel="从空状态新建提醒"
                actionLabel={onCreateReminder ? "创建第一个提醒" : undefined}
                description="为 Agent 安排一次或周期工作。"
                icon={Bell}
                onAction={onCreateReminder ? () => setCreatingReminder(true) : undefined}
                title="还没有提醒"
              />
            )
          ) : selectedTask ? (
            <TaskDetail
              agents={agents}
              disabled={pendingAction !== null}
              onUpdate={(input) =>
                onUpdateTask(selectedTask.id, input)
              }
              task={selectedTask}
            />
          ) : (
            <ManagementEmptyState
              actionAccessibilityLabel="从空状态新建任务"
              actionLabel="创建第一个任务"
              description="创建第一项工作，或从 Agent 对话生成 Task。"
              icon={ListChecks}
              onAction={() => setCreating(true)}
              title="还没有任务"
            />
          )}
        </ManagementDetailScroll>
      </ManagementStage>
    </PlatformFrame>
    </ManagementPresentation>
  );
}

function TaskList({
  horizontal = false,
  onSelect,
  selectedTaskId,
  tasks,
}: {
  horizontal?: boolean;
  onSelect(taskId: string): void;
  selectedTaskId: string | null;
  tasks: Task[];
}) {
  return (
    <ScrollView
      contentContainerStyle={[
        styles.taskList,
        horizontal && styles.taskListStacked,
      ]}
      horizontal={horizontal}
      showsHorizontalScrollIndicator={false}
    >
      {tasks.map((task) => {
        const selected = task.id === selectedTaskId;
        return (
          <CollectionRow
            accessibilityLabel={`打开任务 ${task.number}`}
            key={task.id}
            onPress={() => onSelect(task.id)}
            orientation={horizontal ? "horizontal" : "vertical"}
            selected={selected}
          >
            <Text style={styles.taskReference}>#{task.number}</Text>
            <View style={styles.taskCopy}>
              <Text numberOfLines={2} style={styles.taskTitle}>
                {task.title}
              </Text>
              <Text style={styles.taskStatus}>
                {taskStatusLabel[task.status]}
              </Text>
            </View>
          </CollectionRow>
        );
      })}
    </ScrollView>
  );
}

function ReminderList({
  agents,
  horizontal = false,
  onSelect,
  reminders,
  selectedReminderId,
}: {
  agents: Agent[];
  horizontal?: boolean;
  onSelect(reminderId: string): void;
  reminders: Reminder[];
  selectedReminderId: string | null;
}) {
  return (
    <ScrollView
      contentContainerStyle={[
        styles.taskList,
        horizontal && styles.taskListStacked,
      ]}
      horizontal={horizontal}
      showsHorizontalScrollIndicator={false}
    >
      {reminders.map((reminder) => {
        const selected = reminder.id === selectedReminderId;
        const agent = agents.find((item) => item.id === reminder.agentId);
        return (
          <CollectionRow
            accessibilityLabel={`打开提醒 ${reminder.text}`}
            key={reminder.id}
            onPress={() => onSelect(reminder.id)}
            orientation={horizontal ? "horizontal" : "vertical"}
            selected={selected}
          >
            <Text style={styles.taskReference}>提醒</Text>
            <View style={styles.taskCopy}>
              <Text numberOfLines={2} style={styles.taskTitle}>
                {reminder.text}
              </Text>
              <Text style={styles.taskStatus}>
                {reminderStatusLabel[reminder.status]} · {agent?.displayName ?? "未知 Agent"}
              </Text>
            </View>
          </CollectionRow>
        );
      })}
    </ScrollView>
  );
}

function ReminderCreateForm({
  agentId,
  agents,
  disabled,
  onCancel,
  onChangeAgentId,
  onChangeSchedule,
  onChangeScheduleKind,
  onChangeText,
  onChangeTimezone,
  onSubmit,
  schedule,
  scheduleKind,
  text,
  timezone,
}: {
  agentId: string;
  agents: Agent[];
  disabled: boolean;
  onCancel(): void;
  onChangeAgentId(value: string): void;
  onChangeSchedule(value: string): void;
  onChangeScheduleKind(value: Reminder["scheduleKind"]): void;
  onChangeText(value: string): void;
  onChangeTimezone(value: string): void;
  onSubmit(): void | Promise<void>;
  schedule: string;
  scheduleKind: Reminder["scheduleKind"];
  text: string;
  timezone: string;
}) {
  return (
    <ManagementForm>
      <Text style={styles.formTitle}>新建提醒</Text>
      <ManagementField label="提醒类型">
        <SelectionGroup inset>
          {(["once", "cron"] as const).map((kind) => (
            <SelectionButton
              accessibilityLabel={kind === "once" ? "选择一次提醒" : "选择周期提醒"}
              key={kind}
              label={kind === "once" ? "一次" : "周期"}
              layout="equal"
              onPress={() => onChangeScheduleKind(kind)}
              selected={scheduleKind === kind}
            />
          ))}
        </SelectionGroup>
      </ManagementField>
      <ManagementField label="执行 Agent">
        <SelectionGroup>
          {agents.map((agent) => (
            <SelectionButton
              accessibilityLabel={`选择提醒 Agent ${agent.displayName}`}
              key={agent.id}
              label={agent.displayName}
              onPress={() => onChangeAgentId(agent.id)}
              selected={agent.id === agentId}
            />
          ))}
        </SelectionGroup>
      </ManagementField>
      <ManagementField label="提醒内容">
        <ManagementTextInput
          accessibilityLabel="提醒内容"
          editable={!disabled}
          multiline
          onChangeText={onChangeText}
          placeholder="Agent 到时要完成什么？"
          value={text}
        />
      </ManagementField>
      <ManagementField
        hint={scheduleKind === "once"
          ? "按下方时区执行。"
          : "使用五段周期规则，示例表示每周一至周五 09:00。"}
        label={scheduleKind === "once" ? "执行时间" : "周期规则"}
      >
        {scheduleKind === "once" ? (
          <ManagementDateTimeInput
            accessibilityLabel="提醒执行时间"
            disabled={disabled}
            onChangeText={onChangeSchedule}
            placeholder="选择执行日期和时间"
            value={schedule}
          />
        ) : (
          <ManagementTextInput
            accessibilityLabel="提醒周期规则"
            autoCapitalize="none"
            editable={!disabled}
            onChangeText={onChangeSchedule}
            placeholder="例如：0 9 * * 1-5"
            value={schedule}
          />
        )}
      </ManagementField>
      <ManagementField label="时区">
        <ManagementTextInput
          accessibilityLabel="提醒时区"
          autoCapitalize="none"
          editable={!disabled}
          onChangeText={onChangeTimezone}
          value={timezone}
        />
      </ManagementField>
      <ManagementFormActions>
        <ActionButton
          accessibilityLabel="取消新建提醒"
          importance="secondary"
          label="取消"
          onPress={onCancel}
        />
        <ActionButton
          accessibilityLabel="创建提醒"
          disabled={disabled || !agentId || !schedule.trim() || !text.trim()}
          importance="primary"
          label="创建提醒"
          onPress={onSubmit}
        />
      </ManagementFormActions>
    </ManagementForm>
  );
}

function ReminderDetail({
  agent,
  disabled,
  onCancel,
  onUpdate,
  reminder,
}: {
  agent?: Agent;
  disabled: boolean;
  onCancel(): void | Promise<void>;
  onUpdate(input: UpdateReminderInput): void | Promise<void>;
  reminder: Reminder;
}) {
  const [schedule, setSchedule] = useState(reminder.schedule);
  const [text, setText] = useState(reminder.text);
  const [timezone, setTimezone] = useState(reminder.timezone);
  const canToggle = reminder.status === "active" || reminder.status === "paused";
  return (
    <ManagementDetailCanvas testID="reminder-detail">
      <DetailHeading
        metadata={[
          agent ? `${agent.displayName} · @${agent.handle}` : "未知 Agent",
          reminder.scheduleKind,
          reminder.nextFireAt ?? "暂无下次时间",
        ]}
        status={{
          label: reminderStatusLabel[reminder.status],
          tone: reminderStatusTone[reminder.status],
        }}
        testID="reminder-identity"
        title={reminder.text}
      />
      <ManagementField label="提醒内容">
        <ManagementTextInput
          accessibilityLabel="编辑提醒内容"
          editable={!disabled}
          onChangeText={setText}
          value={text}
        />
      </ManagementField>
      <ManagementField label="执行时间或 Cron">
        <ManagementTextInput
          accessibilityLabel="编辑提醒时间或 Cron"
          editable={!disabled}
          onChangeText={setSchedule}
          value={schedule}
        />
      </ManagementField>
      <ManagementField label="时区">
        <ManagementTextInput
          accessibilityLabel="编辑提醒时区"
          editable={!disabled}
          onChangeText={setTimezone}
          value={timezone}
        />
      </ManagementField>
      <View style={styles.detailActions}>
        <ActionButton
          accessibilityLabel="保存提醒"
          disabled={disabled || !schedule.trim() || !text.trim()}
          importance="primary"
          label="保存"
          onPress={() => onUpdate({
            schedule: schedule.trim(),
            text: text.trim(),
            timezone: timezone.trim(),
          })}
        />
        {canToggle ? (
          <ActionButton
            accessibilityLabel={reminder.status === "active" ? "暂停提醒" : "恢复提醒"}
            disabled={disabled}
            importance="secondary"
            label={reminder.status === "active" ? "暂停" : "恢复"}
            onPress={() => onUpdate({
              status: reminder.status === "active" ? "paused" : "active",
            })}
          />
        ) : null}
        <ActionButton
          accessibilityLabel="取消提醒"
          disabled={disabled || reminder.status === "canceled"}
          importance="danger"
          label="取消提醒"
          onPress={onCancel}
        />
      </View>
    </ManagementDetailCanvas>
  );
}

function TaskCreateForm({
  agents,
  description,
  disabled,
  onCancel,
  onChangeDescription,
  onChangeOwnerMemberId,
  onChangeTitle,
  onSubmit,
  ownerMemberId,
  title,
}: {
  agents: Agent[];
  description: string;
  disabled: boolean;
  onCancel(): void;
  onChangeDescription(value: string): void;
  onChangeOwnerMemberId(value: string): void;
  onChangeTitle(value: string): void;
  onSubmit(): void | Promise<void>;
  ownerMemberId: string;
  title: string;
}) {
  return (
    <ManagementForm testID="task-create-form">
      <Text style={styles.formTitle}>新建任务</Text>
      <ManagementField label="任务标题">
        <ManagementTextInput
          accessibilityLabel="任务标题"
          editable={!disabled}
          onChangeText={onChangeTitle}
          placeholder="要完成什么？"
          value={title}
        />
      </ManagementField>
      <ManagementField
        hint={agents.length > 0 ? undefined : "暂无 Agent，可先创建未指派任务。"}
        label="执行 Agent"
      >
        {agents.length > 0 ? (
          <SelectionGroup>
            {agents.map((agent) => (
              <SelectionButton
                accessibilityLabel={`选择任务 Agent ${agent.displayName}`}
                key={agent.id}
                label={agent.displayName}
                onPress={() => onChangeOwnerMemberId(agent.id)}
                selected={ownerMemberId === agent.id}
              />
            ))}
          </SelectionGroup>
        ) : null}
      </ManagementField>
      <ManagementField label="任务描述">
        <ManagementTextInput
          accessibilityLabel="任务描述"
          editable={!disabled}
          multiline
          onChangeText={onChangeDescription}
          placeholder="补充背景、验收标准或链接（可选）"
          value={description}
        />
      </ManagementField>
      <ManagementFormActions>
        <ActionButton
          accessibilityLabel="取消新建任务"
          importance="secondary"
          label="取消"
          onPress={onCancel}
        />
        <ActionButton
          accessibilityLabel="创建任务"
          disabled={disabled || title.trim().length === 0}
          importance="primary"
          label="创建任务"
          onPress={onSubmit}
        />
      </ManagementFormActions>
    </ManagementForm>
  );
}

function TaskDetail({
  agents,
  disabled,
  onUpdate,
  task,
}: {
  agents: Agent[];
  disabled: boolean;
  onUpdate(input: UpdateTaskInput): void | Promise<void>;
  task: Task;
}) {
  const owner = agents.find((agent) => agent.id === task.ownerMemberId);
  return (
    <ManagementDetailCanvas testID="task-detail">
      <DetailHeading
        metadata={[
          `#${task.number}`,
          owner ? `${owner.displayName} · @${owner.handle}` : "尚未指派执行 Agent",
        ]}
        status={{
          label: taskStatusLabel[task.status],
          tone: taskStatusTone[task.status],
        }}
        testID="task-identity"
        title={task.title}
      />
      <DetailSection>
      <Text style={styles.detailDescription}>
        {task.description || "暂无描述。"}
      </Text>
      {task.status === "todo" && agents.length > 0 ? (
        <ManagementField label="指派执行">
          <SelectionGroup>
            {agents.map((agent) => (
              <SelectionButton
                accessibilityLabel={`指派给 ${agent.displayName}`}
                disabled={disabled || task.ownerMemberId === agent.id}
                key={agent.id}
                label={`${agent.displayName} · @${agent.handle}`}
                onPress={() => onUpdate({ownerMemberId: agent.id})}
                selected={task.ownerMemberId === agent.id}
              />
            ))}
          </SelectionGroup>
        </ManagementField>
      ) : null}
      <View style={styles.detailActions}>
        {task.status === "in_review" ? (
          <>
            <ActionButton
              accessibilityLabel="退回修改"
              disabled={disabled}
              importance="secondary"
              label="退回修改"
              onPress={() => onUpdate({status: "in_progress"})}
            />
            <ActionButton
              accessibilityLabel="验收通过"
              disabled={disabled}
              importance="primary"
              label="验收通过"
              onPress={() => onUpdate({status: "done"})}
            />
          </>
        ) : null}
      </View>
      </DetailSection>
    </ManagementDetailCanvas>
  );
}

const taskStatusLabel: Record<Task["status"], string> = {
  closed: "已关闭",
  done: "已完成",
  in_progress: "进行中",
  in_review: "待验收",
  todo: "待处理",
};

const taskStatusTone = {
  closed: "neutral",
  done: "positive",
  in_progress: "info",
  in_review: "warning",
  todo: "neutral",
} as const;

const reminderStatusLabel: Record<Reminder["status"], string> = {
  active: "生效中",
  canceled: "已取消",
  completed: "已完成",
  paused: "已暂停",
};

const reminderStatusTone = {
  active: "positive",
  canceled: "danger",
  completed: "positive",
  paused: "warning",
} as const;

const styles = StyleSheet.create((theme) => ({
  compactListBlock: {
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    maxHeight: theme.recipes.taskWorkspace.compactListMaxHeight,
  },
  detailActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  detailDescription: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.body,
  },
  formTitle: {
    ...theme.semantic.typography.sectionTitle,
  },
  inboxBand: {
    alignItems: "center",
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    height: theme.recipes.control.height,
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.md,
  },
  inboxLabel: {
    ...theme.semantic.typography.meta,
  },
  taskCopy: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  taskList: {
    gap: theme.spacing.xs,
    padding: theme.spacing.sm,
  },
  taskListStacked: {
    alignItems: "center",
  },
  taskReference: {
    color: theme.semantic.color.textMuted,
    flexShrink: 0,
    minWidth: theme.spacing.xl,
    ...theme.semantic.typography.meta,
  },
  taskStatus: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.meta,
  },
  taskTitle: {
    ...theme.semantic.typography.bodyEmphasis,
  },
}));
