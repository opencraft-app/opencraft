/** Stable IDs. UI labels are localized independently; unknown read values survive edits. */
export const TASK_KINDS = ["unclassified", "feature", "improvement", "bug", "engineering", "harness", "research", "documentation", "operations", "growth", "task"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export interface TaskPlanning {
  readonly kind: string;
  readonly acceptanceCriteria: string;
}
export type TaskEventType = "created" | "updated" | "status_changed" | "linked" | "unlinked" | "deleted" | "restored" | "progress";
/** Supplied by trusted Host context, never accepted as client request fields. */
export interface TaskEventActor { readonly kind: string; readonly id: string; readonly label?: string }
export interface TaskEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly taskId: string;
  readonly type: TaskEventType;
  readonly taskRevision: number;
  readonly actor: TaskEventActor | null;
  readonly channel: "api" | "agent" | "system";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}
export interface TaskProgressSummary { readonly eventId: string; readonly text: string; readonly createdAt: number }
export interface TaskEventsPage { readonly events: readonly TaskEvent[]; readonly nextBeforeSeq: number | null }
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["none", "low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
/** Optional public profile reference, never authentication or an access grant. */
export interface TaskMemberIdentity { readonly kind: string; readonly id: string; }
export interface TaskMember { readonly id: string; readonly name: string; readonly revision: number; readonly identity?: TaskMemberIdentity | null; }
export const TASK_AI_RESEARCH = ["unassessed", "proactive", "needs_context", "needs_decision"] as const;
export type TaskAiResearch = (typeof TASK_AI_RESEARCH)[number];
export interface TaskProperties {
  /** First-round triage only; never launches work or starts decision waiting. */
  readonly aiResearch?: string;
  readonly aiResearchReason?: string;
  readonly assigneeId: string | null;
  readonly priority: TaskPriority;
  /** Calendar date, YYYY-MM-DD. No timezone conversion. */
  readonly dueDate: string | null;
}
export interface TaskContent extends Partial<TaskProperties>, Partial<TaskPlanning> {
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
  /** Independent of workflow state and deletion; absent on older authorities. */
  readonly archivedAt?: number | null;
  readonly latestProgress?: TaskProgressSummary | null;
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
  readonly members?: readonly TaskMember[];
  /** Recoverable deletions, omitted by older authorities. */
  readonly recycled?: readonly TaskDetail[];
}
export interface TaskArchiveCursor { readonly archivedAt: number; readonly id: string }
export interface TaskArchivePage {
  readonly tasks: readonly TaskDetail[];
  readonly nextCursor: TaskArchiveCursor | null;
}
export const TASKS = {
  archive: "opencraft/tasks/archive",
  unarchive: "opencraft/tasks/unarchive",
  archives: "opencraft/tasks/archive/list",
  events: "opencraft/tasks/events/list",
  event: "opencraft/tasks/events/read",
  progress: "opencraft/tasks/progress/append",
  properties: "opencraft/tasks/properties/update",
  members: "opencraft/tasks/members/upsert",
  capabilities: "opencraft/tasks/capabilities",
  list: "opencraft/tasks/list",
  read: "opencraft/tasks/read",
  create: "opencraft/tasks/create",
  update: "opencraft/tasks/update",
  move: "opencraft/tasks/move",
  remove: "opencraft/tasks/remove",
  restore: "opencraft/tasks/restore",
  attach: "opencraft/tasks/conversations/attach",
  detach: "opencraft/tasks/conversations/detach",
  forConversation: "opencraft/tasks/conversations/tasks",
} as const;
export const TASKS_CHANGED = "opencraft/tasks/changed";
export interface TasksMethodMap {
  "opencraft/tasks/archive": {
    params: { id: string; expectedRevision: number };
    result: TasksSnapshot;
  };
  "opencraft/tasks/unarchive": {
    params: { id: string; expectedRevision: number };
    result: TasksSnapshot;
  };
  "opencraft/tasks/archive/list": {
    params: { search?: string; limit?: number; before?: TaskArchiveCursor };
    result: TaskArchivePage;
  };
  "opencraft/tasks/events/list": {
    params: { taskId: string; beforeSeq?: number; limit?: number };
    result: TaskEventsPage;
  };
  "opencraft/tasks/events/read": {
    params: { taskId: string; eventId: string };
    result: TaskEvent | null;
  };
  "opencraft/tasks/progress/append": {
    /** Stable eventId reconciles a lost acknowledgement without content CAS. */
    params: { taskId: string; eventId: string; text: string };
    result: TaskEvent;
  };
  "opencraft/tasks/properties/update": {
    /** At least one property; omitted fields retain their current values. */
    params: Partial<TaskProperties> & { id: string; expectedRevision: number };
    result: TasksSnapshot;
  };
  "opencraft/tasks/members/upsert": {
    /** Omit identity to retain it, null to remove it. */
    params: { id: string; name: string; expectedRevision: number | null; identity?: TaskMemberIdentity | null };
    result: TasksSnapshot;
  };
  "opencraft/tasks/capabilities": {
    params: Record<string, never>;
    result: { version: 1; storage: "sqlite-rows"; archive?: true; aiResearch?: true; properties?: true; memberIdentity?: true; planning?: true; supportedKinds?: readonly string[]; activity?: true; progress?: true; recycleBinRetentionMs?: number };
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
  "opencraft/tasks/restore": {
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
  | typeof TASKS.events
  | typeof TASKS.event
  | typeof TASKS.progress
  | typeof TASKS.archives
>;
export interface TasksRequestPort {
  request<M extends TasksMethod>(
    method: M,
    params: TasksMethodMap[M]["params"],
  ): Promise<TasksMethodMap[M]["result"]>;
}
