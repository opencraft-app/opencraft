import type {Agent, Reminder, Task} from "@vela/client-core";

export const taskStatusLabel: Record<Task["status"], string> = {
  closed: "已关闭",
  done: "已完成",
  in_progress: "进行中",
  in_review: "待验收",
  todo: "待处理",
};

export const taskStatusTone = {
  closed: "neutral",
  done: "positive",
  in_progress: "info",
  in_review: "warning",
  todo: "neutral",
} as const;

export const reminderStatusLabel: Record<Reminder["status"], string> = {
  active: "生效中",
  canceled: "已取消",
  completed: "已完成",
  paused: "已暂停",
};

export const reminderStatusTone = {
  active: "positive",
  canceled: "danger",
  completed: "positive",
  paused: "warning",
} as const;

export interface TaskListItemViewModel {
  accessibilityLabel: string;
  id: string;
  meta: string;
  selected: boolean;
  status: string;
  subtitle?: string;
  title: string;
}

export function taskListItemViewModel(
  task: Task,
  selected: boolean,
): TaskListItemViewModel {
  return {
    accessibilityLabel: `打开任务 ${task.number}`,
    id: task.id,
    meta: `#${task.number}`,
    selected,
    status: taskStatusLabel[task.status],
    subtitle: task.description ?? undefined,
    title: task.title,
  };
}

export interface ReminderListItemViewModel {
  accessibilityLabel: string;
  id: string;
  meta: string;
  selected: boolean;
  status: string;
  subtitle: string;
  title: string;
}

export function reminderListItemViewModel(
  reminder: Reminder,
  agent: Agent | undefined,
  selected: boolean,
): ReminderListItemViewModel {
  const agentLabel = agent?.displayName ?? "未知 Agent";
  const status = reminderStatusLabel[reminder.status];
  return {
    accessibilityLabel: `打开提醒 ${reminder.text}`,
    id: reminder.id,
    meta: agentLabel,
    selected,
    status,
    subtitle: `${status} · ${agentLabel}`,
    title: reminder.text,
  };
}
