export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export interface TaskContent {
  readonly title: string;
  readonly description: string;
  readonly projectServerId: string | null;
  readonly projectId: string | null;
}
export interface Task extends TaskContent {
  readonly id: string;
  readonly status: TaskStatus;
  readonly sortOrder: number;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}
export interface TaskConversation {
  readonly serverId: string;
  readonly threadId: string;
  readonly createdAt: number;
}
export interface TaskDetail extends Task {
  readonly conversations: readonly TaskConversation[];
}
export interface TasksSnapshot {
  readonly tasks: readonly TaskDetail[];
}
export const TASKS = {
  capabilities: "opencraft/tasks/capabilities",
  list: "opencraft/tasks/list",
  read: "opencraft/tasks/read",
  create: "opencraft/tasks/create",
  update: "opencraft/tasks/update",
  move: "opencraft/tasks/move",
  remove: "opencraft/tasks/remove",
  attach: "opencraft/tasks/conversations/attach",
  detach: "opencraft/tasks/conversations/detach",
  forConversation: "opencraft/tasks/conversations/tasks",
} as const;
export const TASKS_CHANGED = "opencraft/tasks/changed";
export interface TasksMethodMap {
  "opencraft/tasks/capabilities": {
    params: Record<string, never>;
    result: { version: 1; storage: "sqlite-rows" };
  };
  "opencraft/tasks/list": {
    params: Record<string, never>;
    result: TasksSnapshot;
  };
  "opencraft/tasks/read": { params: { id: string }; result: TaskDetail };
  "opencraft/tasks/create": {
    params: TaskContent & { id: string; status: TaskStatus };
    result: TasksSnapshot;
  };
  "opencraft/tasks/update": {
    params: TaskContent & { id: string; expectedRevision: number };
    result: TasksSnapshot;
  };
  "opencraft/tasks/move": {
    params: {
      id: string;
      expectedRevision: number;
      status: TaskStatus;
      beforeId: string | null;
    };
    result: TasksSnapshot;
  };
  "opencraft/tasks/remove": {
    params: { id: string; expectedRevision: number };
    result: TasksSnapshot;
  };
  "opencraft/tasks/conversations/attach": {
    params: {
      id: string;
      expectedRevision: number;
      serverId: string;
      threadId: string;
    };
    result: TasksSnapshot;
  };
  "opencraft/tasks/conversations/detach": {
    params: {
      id: string;
      expectedRevision: number;
      serverId: string;
      threadId: string;
    };
    result: TasksSnapshot;
  };
  "opencraft/tasks/conversations/tasks": {
    params: { serverId: string; threadId: string };
    result: TasksSnapshot;
  };
}
export type TasksMethod = keyof TasksMethodMap;
export type TasksMutation = Exclude<
  TasksMethod,
  | typeof TASKS.capabilities
  | typeof TASKS.list
  | typeof TASKS.read
  | typeof TASKS.forConversation
>;
export interface TasksRequestPort {
  request<M extends TasksMethod>(
    method: M,
    params: TasksMethodMap[M]["params"],
  ): Promise<TasksMethodMap[M]["result"]>;
}
