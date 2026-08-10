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
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
  CollectionRow,
  DetailHeading,
  DetailSection,
  ManagementCollectionFooterAction,
  ManagementResourceDirectory,
  ManagementDateTimeInput,
  ManagementDetailCanvas,
  ManagementDetailScroll,
  ManagementField,
  ManagementForm,
  ManagementFormFooter,
  ManagementHeader,
  ManagementHeaderActions,
  ManagementStage,
  ManagementTextInput,
} from "../components/management-workspace";
import {SystemButton, SystemIconButton} from "../primitives/system-button";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemTabs} from "../primitives/system-tabs";
import {SystemSelectField} from "../primitives/system-select-field";
import {SystemSegmentedControl} from "../primitives/system-segmented-control";
import {deviceTimezone, normalizeLocalDateTime} from "../date-time";
import {reminderEmptyCopy, taskEmptyCopy} from "../management-empty-copy";
import { managementSurfaceLayout } from "../management-surface-layout";
import {
  buildManagementShellModel,
  ManagementPresentation,
  type ManagementPageModel,
  type PresentationAction,
  type PresentationForm,
} from "../presentation";
import {
  reminderListItemViewModel,
  reminderStatusLabel,
  reminderStatusTone,
  taskListItemViewModel,
  taskStatusLabel,
  taskStatusTone,
  type ReminderListItemViewModel,
  type TaskListItemViewModel,
} from "../presentation/resources/task";
import type { PlatformFrameProps } from "../layouts/app-frame";
import { ManagementScreenFrame } from "../layouts/management-screen-frame";
import type { WorkspaceSection } from "../layouts/workspace-section";

export interface TasksScreenProps {
  agents?: Agent[];
  canManage?: boolean;
  currentAccount?: PlatformFrameProps["account"];
  currentServerId: string | null;
  error: string | null;
  /**
   * When false, render section body only. Parent WorkspaceChrome owns the
   * shared rail / bottom bar so navigation membership stays stable.
   */
  framed?: boolean;
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
    framed = true,
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
  const surface = managementSurfaceLayout(resolvedViewportWidth);
  const {density, stackedCollection} = surface;
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
  const taskItems = tasks.map(task => ({
    resource: task,
    view: taskListItemViewModel(task, task.id === selectedTask?.id),
  }));
  const reminderItems = reminders.map(reminder => ({
    resource: reminder,
    view: reminderListItemViewModel(
      reminder,
      agents.find(agent => agent.id === reminder.agentId),
      reminder.id === selectedReminder?.id,
    ),
  }));
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

  const collectionToolbar = (
    <TaskCollectionToolbar
      inboxCount={reminderMode ? reminders.length : inbox.length}
      onRefresh={() => refresh?.()}
      onSelectMode={setMode}
      reminderMode={reminderMode}
      refreshDisabled={activeLoading || !refresh}
      refreshTestID="task-refresh-icon"
    />
  );
  const collectionList = (
    <TaskCollectionPanel reminderMode={reminderMode}>
      {reminderMode ? (
        <ReminderList
          items={reminderItems}
          onSelect={setSelectedReminderId}
        />
      ) : (
        <TaskList
          items={taskItems}
          onSelect={setSelectedTaskId}
        />
      )}
    </TaskCollectionPanel>
  );
  const sidebar = (
    <ManagementResourceDirectory
      eyebrow={`${tasks.length} 个任务 · ${reminders.length} 个提醒`}
      footer={(reminderMode ? reminders.length : tasks.length) > 0 ? (
        <ManagementCollectionFooterAction
          accessibilityLabel={reminderMode ? "从侧栏新建提醒" : "从侧栏新建任务"}
          icon={Plus}
          label={`新建${reminderMode ? "提醒" : "任务"}`}
          onPress={() => reminderMode
            ? setCreatingReminder(true)
            : setCreating(true)}
        />
      ) : null}
      icon={ListChecks}
      scroll={false}
      testID="task-sidebar"
      title="任务"
      toolbar={collectionToolbar}
    >
      {collectionList}
    </ManagementResourceDirectory>
  );

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
        ? reminderItems.map(({resource, view}) => ({
            ...view,
            onSelect: () => setSelectedReminderId(resource.id),
          }))
        : taskItems.map(({resource, view}) => ({
            ...view,
            onSelect: () => setSelectedTaskId(resource.id),
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
              description: reminderEmptyCopy.description,
              title: reminderEmptyCopy.title,
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
              description: taskEmptyCopy.description,
              title: taskEmptyCopy.title,
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
                accessibilityLabel: "任务标题",
                disabled: pendingAction !== null,
                id: "task-title",
                label: "任务标题",
                onChange: setTitle,
                placeholder: "要完成什么？",
                value: title,
              },
              {
                accessibilityLabel: "执行 Agent",
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
                accessibilityLabel: "任务描述",
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
                accessibilityLabel: "提醒内容",
                disabled: pendingAction !== null,
                id: "reminder-text",
                label: "提醒内容",
                multiline: true,
                onChange: setReminderText,
                placeholder: "Agent 到时要完成什么？",
                value: reminderText,
              },
              {
                accessibilityLabel: reminderScheduleKind === "once"
                  ? "提醒执行时间"
                  : "提醒周期规则",
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
                accessibilityLabel: "提醒时区",
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
    shell: buildManagementShellModel({
      accountLabel: currentAccount?.displayName ?? currentAccount?.email,
      activeSection: "tasks",
      canManageServer: canManage,
      currentServerId,
      ...(onLogout ? {onLogout} : {}),
      onNavigateSection,
      onSelectServer,
      servers,
    }),
  });

  const navigation = stackedCollection ? null : sidebar;
  const renderStage = (pageModel: ManagementPageModel) => (
    <ManagementStage testID="task-stage">
      <ManagementHeader
        actions={(
          <ManagementHeaderActions
            createAccessibilityLabel={reminderMode ? "新建提醒" : "新建任务"}
            createIconTestID="task-create-icon"
            createLabel="新建"
            createVisible={(reminderMode ? reminders.length : tasks.length) > 0 &&
              !(reminderMode ? creatingReminder : creating)}
            onCreate={() => reminderMode
              ? setCreatingReminder(true)
              : setCreating(true)}
          />
        )}
        copyTestID="task-stage-header-copy"
        title={pageModel.header.title}
        titleTestID="task-stage-title"
      />
      {pageModel.error ? (
        <SystemFeedback kind="inline" message={pageModel.error} tone="danger" />
      ) : null}
      {stackedCollection && !activeCreation ? (
        <View
          style={styles.compactListBlock}
          testID="task-collection-shelf"
        >
          <TaskCollectionToolbar
            inboxCount={reminderMode ? reminders.length : inbox.length}
            onRefresh={() => refresh?.()}
            onSelectMode={setMode}
            reminderMode={reminderMode}
            refreshDisabled={!refresh}
            refreshTestID="task-compact-refresh-icon"
          />
          <TaskCollectionPanel reminderMode={reminderMode}>
            {reminderMode ? (
              <ReminderList
                horizontal
                items={reminderItems}
                onSelect={setSelectedReminderId}
              />
            ) : (
              <TaskList
                horizontal
                items={taskItems}
                onSelect={setSelectedTaskId}
              />
            )}
          </TaskCollectionPanel>
        </View>
      ) : null}
      <ManagementDetailScroll
        density={density}
        testID="task-detail-scroll"
      >
        {!reminderMode && creating ? (
          <TaskCreateForm
            form={pageModel.form!}
          />
        ) : reminderMode && creatingReminder && onCreateReminder ? (
          <ReminderCreateForm
            form={pageModel.form!}
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
              actionLabel={onCreateReminder ? "新建提醒" : undefined}
              description={pageModel.empty?.description ?? reminderEmptyCopy.description}
              onAction={onCreateReminder ? () => setCreatingReminder(true) : undefined}
              title={pageModel.empty?.title ?? reminderEmptyCopy.title}
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
            actionLabel="新建任务"
            description={pageModel.empty?.description ?? taskEmptyCopy.description}
            onAction={() => setCreating(true)}
            title={pageModel.empty?.title ?? taskEmptyCopy.title}
          />
        )}
      </ManagementDetailScroll>
    </ManagementStage>
  );

  return (
    <ManagementPresentation model={semanticModel}>
      {(pageModel) => (
        <ManagementScreenFrame
          account={currentAccount}
          activeSection="tasks"
          canManageServer={canManage}
          currentServerId={currentServerId}
          framed={framed}
          imStatus={imStatus}
          navigation={navigation}
          onLogout={onLogout}
          onNavigateSection={onNavigateSection}
          onSelectServer={onSelectServer}
          sectionHref={sectionHref}
          serverHref={serverHref}
          servers={servers}
          viewportWidth={viewportWidth}
        >
          {renderStage(pageModel)}
        </ManagementScreenFrame>
      )}
    </ManagementPresentation>
  );
}

function TaskCollectionToolbar({
  inboxCount,
  onRefresh,
  onSelectMode,
  reminderMode,
  refreshDisabled,
  refreshTestID,
}: {
  inboxCount: number;
  onRefresh(): void;
  onSelectMode(mode: "reminders" | "tasks"): void;
  reminderMode: boolean;
  refreshDisabled: boolean;
  refreshTestID: string;
}) {
  return (
    <View style={styles.collectionToolbar} testID="task-collection-toolbar">
      <SystemTabs
        accessibilityLabel="任务视图"
        onChange={onSelectMode}
        options={[
          {label: "任务", panelId: "tasks-panel", value: "tasks"},
          {label: "提醒", panelId: "reminders-panel", value: "reminders"},
        ]}
        testID="task-mode-tabs"
        value={reminderMode ? "reminders" : "tasks"}
      />
      <View style={styles.inboxBand}>
        <Text style={styles.inboxLabel}>
          {reminderMode ? "提醒" : "待处理"} {inboxCount}
        </Text>
        <SystemIconButton
          accessibilityLabel={reminderMode ? "刷新提醒" : "刷新任务"}
          disabled={refreshDisabled}
          icon={RefreshCw}
          onPress={onRefresh}
          testID={refreshTestID}
        />
      </View>
    </View>
  );
}

function TaskCollectionPanel({
  children,
  reminderMode,
}: {
  children: ReactNode;
  reminderMode: boolean;
}) {
  const label = reminderMode ? "提醒列表" : "任务列表";
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole={"tabpanel" as never}
      nativeID={reminderMode ? "reminders-panel" : "tasks-panel"}
      style={styles.collectionPanel}
    >
      {children}
    </View>
  );
}

function TaskList({
  horizontal = false,
  items,
  onSelect,
}: {
  horizontal?: boolean;
  items: Array<{resource: Task; view: TaskListItemViewModel}>;
  onSelect(taskId: string): void;
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
      {items.map(({resource, view}) => {
        return (
          <CollectionRow
            accessibilityLabel={view.accessibilityLabel}
            key={view.id}
            onPress={() => onSelect(resource.id)}
            orientation={horizontal ? "horizontal" : "vertical"}
            selected={view.selected}
          >
            <Text style={styles.taskReference}>{view.meta}</Text>
            <View style={styles.taskCopy}>
              <Text numberOfLines={2} style={styles.taskTitle}>
                {view.title}
              </Text>
              <Text style={styles.taskStatus}>
                {view.status}
              </Text>
            </View>
          </CollectionRow>
        );
      })}
    </ScrollView>
  );
}

function ReminderList({
  horizontal = false,
  items,
  onSelect,
}: {
  horizontal?: boolean;
  items: Array<{resource: Reminder; view: ReminderListItemViewModel}>;
  onSelect(reminderId: string): void;
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
      {items.map(({resource, view}) => {
        return (
          <CollectionRow
            accessibilityLabel={view.accessibilityLabel}
            key={view.id}
            onPress={() => onSelect(resource.id)}
            orientation={horizontal ? "horizontal" : "vertical"}
            selected={view.selected}
          >
            <Text style={styles.taskReference}>提醒</Text>
            <View style={styles.taskCopy}>
              <Text numberOfLines={2} style={styles.taskTitle}>
                {view.title}
              </Text>
              <Text style={styles.taskStatus}>
                {view.subtitle}
              </Text>
            </View>
          </CollectionRow>
        );
      })}
    </ScrollView>
  );
}

function ReminderCreateForm({form}: {form: PresentationForm}) {
  const kind = form.fields.find(field => field.id === "reminder-kind")!;
  const agent = form.fields.find(field => field.id === "reminder-agent")!;
  const text = form.fields.find(field => field.id === "reminder-text")!;
  const schedule = form.fields.find(field => field.id === "reminder-schedule")!;
  const timezone = form.fields.find(field => field.id === "reminder-timezone")!;
  const cancel = form.actions.find(action => action.id === "cancel-create-reminder")!;
  const submit = form.actions.find(action => action.id === "submit-create-reminder")!;
  return (
    <ManagementForm>
      <Text style={styles.formTitle}>{form.title}</Text>
      <ManagementField label={kind.label}>
        <SystemSegmentedControl
          accessibilityLabel={kind.label}
          disabled={kind.disabled}
          onChange={kind.onChange}
          options={(kind.options ?? []).map(option => ({
            ...option,
            accessibilityLabel: option.value === "once"
              ? "选择一次提醒"
              : "选择周期提醒",
          }))}
          value={kind.value}
        />
      </ManagementField>
      <ManagementField label={agent.label}>
        <SystemSelectField
          accessibilityLabel={agent.label}
          disabled={agent.disabled}
          onChange={agent.onChange}
          options={(agent.options ?? []).map(option => ({
            ...option,
            accessibilityLabel: `选择提醒 Agent ${option.label}`,
          }))}
          overlayId="reminder-create-agent-listbox"
          value={agent.value || null}
        />
      </ManagementField>
      <ManagementField error={text.error} hint={text.hint} label={text.label}>
        <ManagementTextInput
          accessibilityLabel={text.accessibilityLabel ?? text.label}
          editable={!text.disabled}
          multiline
          onChangeText={text.onChange}
          placeholder={text.placeholder}
          value={text.value}
        />
      </ManagementField>
      <ManagementField
        error={schedule.error}
        hint={kind.value === "once"
          ? "按下方时区执行。"
          : "使用五段周期规则，示例表示每周一至周五 09:00。"}
        label={schedule.label}
      >
        {kind.value === "once" ? (
          <ManagementDateTimeInput
            accessibilityLabel={schedule.accessibilityLabel ?? schedule.label}
            disabled={schedule.disabled}
            invalid={Boolean(schedule.error)}
            onChangeText={schedule.onChange}
            placeholder={schedule.placeholder}
            timezone={timezone.value.trim() || "Asia/Shanghai"}
            value={schedule.value}
          />
        ) : (
          <ManagementTextInput
            accessibilityLabel={schedule.accessibilityLabel ?? schedule.label}
            autoCapitalize="none"
            editable={!schedule.disabled}
            invalid={Boolean(schedule.error)}
            onChangeText={schedule.onChange}
            placeholder={schedule.placeholder}
            value={schedule.value}
          />
        )}
      </ManagementField>
      <ManagementField error={timezone.error} hint={timezone.hint} label={timezone.label}>
        <ManagementTextInput
          accessibilityLabel={timezone.accessibilityLabel ?? timezone.label}
          autoCapitalize="none"
          editable={!timezone.disabled}
          onChangeText={timezone.onChange}
          value={timezone.value}
        />
      </ManagementField>
      <ManagementFormFooter
        cancelAction={{
          accessibilityLabel: "取消新建提醒",
          ...cancel,
          onPress: cancel.run,
        }}
        flowAction={{
          accessibilityLabel: "创建提醒",
          intent: "submit",
          ...submit,
          onPress: submit.run,
        }}
      />
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
        <SystemButton
          accessibilityLabel="保存提醒"
          disabled={disabled || !schedule.trim() || !text.trim()}
          variant="default"
          label="保存"
          onPress={() => onUpdate({
            schedule: schedule.trim(),
            text: text.trim(),
            timezone: timezone.trim(),
          })}
        />
        {canToggle ? (
          <SystemButton
            accessibilityLabel={reminder.status === "active" ? "暂停提醒" : "恢复提醒"}
            disabled={disabled}
            variant="secondary"
            label={reminder.status === "active" ? "暂停" : "恢复"}
            onPress={() => onUpdate({
              status: reminder.status === "active" ? "paused" : "active",
            })}
          />
        ) : null}
        <SystemButton
          accessibilityLabel="取消提醒"
          disabled={disabled || reminder.status === "canceled"}
          variant="destructive"
          label="取消提醒"
          onPress={onCancel}
        />
      </View>
    </ManagementDetailCanvas>
  );
}

function TaskCreateForm({form}: {form: PresentationForm}) {
  const title = form.fields.find(field => field.id === "task-title")!;
  const agent = form.fields.find(field => field.id === "task-agent")!;
  const description = form.fields.find(field => field.id === "task-description")!;
  const cancel = form.actions.find(action => action.id === "cancel-create-task")!;
  const submit = form.actions.find(action => action.id === "submit-create-task")!;
  return (
    <ManagementForm testID="task-create-form">
      <Text style={styles.formTitle}>{form.title}</Text>
      <ManagementField error={title.error} hint={title.hint} label={title.label}>
        <ManagementTextInput
          accessibilityLabel={title.accessibilityLabel ?? title.label}
          editable={!title.disabled}
          onChangeText={title.onChange}
          placeholder={title.placeholder}
          value={title.value}
        />
      </ManagementField>
      <ManagementField label={agent.label}>
        <SystemSelectField
          accessibilityLabel={agent.label}
          disabled={agent.disabled}
          onChange={agent.onChange}
          options={(agent.options ?? []).map(option => ({
            ...option,
            accessibilityLabel: option.value
              ? `选择任务 Agent ${option.label}`
              : "创建未指派任务",
          }))}
          overlayId="task-create-agent-listbox"
          value={agent.value || null}
        />
      </ManagementField>
      <ManagementField
        error={description.error}
        hint={description.hint}
        label={description.label}
      >
        <ManagementTextInput
          accessibilityLabel={description.accessibilityLabel ?? description.label}
          editable={!description.disabled}
          multiline
          onChangeText={description.onChange}
          placeholder={description.placeholder}
          value={description.value}
        />
      </ManagementField>
      <ManagementFormFooter
        cancelAction={{
          accessibilityLabel: "取消新建任务",
          ...cancel,
          onPress: cancel.run,
        }}
        flowAction={{
          accessibilityLabel: "创建任务",
          intent: "submit",
          ...submit,
          onPress: submit.run,
        }}
      />
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
          <SystemSelectField
            accessibilityLabel="指派执行 Agent"
            disabled={disabled}
            onChange={ownerMemberId => onUpdate({ownerMemberId})}
            options={agents.map(agent => ({
              accessibilityLabel: `指派给 ${agent.displayName}`,
              label: `${agent.displayName} · @${agent.handle}`,
              value: agent.id,
            }))}
            overlayId={`task-${task.id}-agent-listbox`}
            placeholder="选择执行 Agent"
            value={task.ownerMemberId ?? null}
          />
        </ManagementField>
      ) : null}
      <View style={styles.detailActions}>
        {task.status === "in_review" ? (
          <>
            <SystemButton
              accessibilityLabel="退回修改"
              disabled={disabled}
              variant="secondary"
              label="退回修改"
              onPress={() => onUpdate({status: "in_progress"})}
            />
            <SystemButton
              accessibilityLabel="验收通过"
              disabled={disabled}
              variant="default"
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

const styles = StyleSheet.create((theme) => ({
  collectionToolbar: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderBottomColor: theme.semantic.color.separator,
    borderBottomWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    paddingBottom: theme.spacing.xs,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  collectionPanel: {
    flex: 1,
    minHeight: 0,
  },
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
    flexDirection: "row",
    height: theme.recipes.managementWorkspace.headerActionHeight,
    justifyContent: "space-between",
  },
  inboxLabel: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.label,
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
