import type {
  CanonicalContentPart,
  CanonicalItem,
  CanonicalParams,
  CanonicalTurnSeed,
} from "./canonical-timeline.js";

export type AppServerItemStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type AppServerPlanStatus = "pending" | "inProgress" | "completed";

export interface AppServerPlanEntry {
  step: string;
  status: AppServerPlanStatus;
}

export interface ShellCommandAction {
  type: string;
  command: string;
  name?: string;
  path?: string | null;
  query?: string | null;
}

export interface CommandExecutionItem extends CanonicalItem {
  id: string;
  type: "commandExecution";
  command: string;
  cwd: string;
  processId: null;
  source: "agent";
  status: AppServerItemStatus;
  commandActions: ShellCommandAction[];
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export interface DynamicToolContentItem {
  type: "inputText" | "inputImage";
  text?: string;
  imageUrl?: string;
}

export interface DynamicToolCallItem extends CanonicalItem {
  id: string;
  type: "dynamicToolCall";
  namespace: "deepseek-harness";
  tool: string;
  arguments: unknown;
  status: AppServerItemStatus;
  contentItems: DynamicToolContentItem[] | null;
  success: boolean | null;
  durationMs: number | null;
}

export type ProjectedToolItem = CommandExecutionItem | DynamicToolCallItem;

export interface DshContentBlock {
  type?: string;
  text?: unknown;
  data?: unknown;
  mediaType?: unknown;
}

export interface DshSessionEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: unknown;
}

export interface ProjectedTurn {
  id: string;
  items: CanonicalItem[];
  status: AppServerItemStatus;
  error: unknown;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  itemsView: string;
  [key: string]: unknown;
}

export interface UserMessageItem extends CanonicalItem {
  id: string;
  type: "userMessage";
  clientId: string | null;
  content: CanonicalItem[];
}

export interface AgentMessageItem extends CanonicalItem {
  id: string;
  type: "agentMessage";
  text: string;
  phase: string | null;
  memoryCitation: unknown;
}

export interface ReasoningItem extends CanonicalItem {
  id: string;
  type: "reasoning";
  summary: unknown[];
  content: CanonicalContentPart[];
}

export interface ProjectedUserTurnRecord extends ProjectedTurnRecord {
  userItem: UserMessageItem;
}

export interface ProjectedTurnRecord {
  threadId: string;
  turn: ProjectedTurn;
  userItem: UserMessageItem | null;
  agentItem?: AgentMessageItem;
  agentItems?: AgentMessageItem[];
  reasoningItem?: ReasoningItem;
  reasoningItems?: ReasoningItem[];
  projectedItems?: CanonicalItem[];
  itemLedger: CanonicalItem[];
  startedAtMs: number;
  plan?: AppServerPlanEntry[];
  [key: string]: unknown;
}

export interface DshProjectedCall {
  callId: string;
  item: ProjectedToolItem;
  startedAtMs: number;
  completed?: boolean;
}

export interface DshProjectionState {
  cwd: string;
  calls: Map<string, DshProjectedCall>;
}

export interface DshProjectionActiveTurn {
  record: ProjectedTurnRecord;
  dshProjection?: DshProjectionState;
  [key: string]: unknown;
}

export interface DshProjectionWorker {
  threadId: string;
}

export interface AppServerNotificationPort {
  broadcastNotification(
    method: string,
    params: CanonicalParams,
    options?: { sensitive?: boolean },
  ): void;
}

export interface ShellCommandClassifierPort {
  classify(command: string, options?: { cwd?: string }): ShellCommandAction[];
}

export interface TurnProjectionManagerPort {
  appendItem(record: ProjectedTurnRecord, item: CanonicalItem): CanonicalItem;
  itemLedger(record: ProjectedTurnRecord): CanonicalItem[];
  start(
    threadId: string,
    input: CanonicalItem[],
    clientUserMessageId?: string | null,
  ): ProjectedUserTurnRecord;
  startAgent(threadId: string): ProjectedTurnRecord;
  prepareAgent(record: ProjectedTurnRecord): AgentMessageItem;
  createAgent(record: ProjectedTurnRecord, phase?: string | null): AgentMessageItem;
  createUser(
    record: ProjectedTurnRecord,
    content: CanonicalItem[],
    clientId?: string | null,
  ): UserMessageItem;
  prepareReasoning(record: ProjectedTurnRecord): ReasoningItem;
  createReasoning(record: ProjectedTurnRecord): ReasoningItem;
  complete(
    record: ProjectedTurnRecord,
    agentText?: string | null,
    agentItem?: AgentMessageItem | null,
  ): ProjectedTurnRecord;
  fail(
    record: ProjectedTurnRecord,
    message: string,
    completedAt?: number,
  ): ProjectedTurnRecord;
  interrupt(
    record: ProjectedTurnRecord,
    agentText?: string,
    completedAt?: number,
  ): ProjectedTurnRecord;
}

export interface ProjectedThreadState {
  id: string;
  cwd: string;
  status: { type: string; [key: string]: unknown };
  name?: string;
  preview?: string;
  path?: string | null;
  projectId?: string | null;
  turns?: CanonicalTurnSeed[];
  [key: string]: unknown;
}

/** Mutable read model derived from canonical execution facts for AppServer clients. */
export interface ThreadProjectionManagerPort {
  find(threadId: string): ProjectedThreadState | null | undefined;
  get(threadId: string): ProjectedThreadState;
  project(
    threadId: string,
    source?: Record<string, unknown>,
    mapPath?: (value: string) => string,
  ): ProjectedThreadState;
  projectTurn(
    threadId: string,
    turn: CanonicalTurnSeed,
    phase?: "started" | "completed" | null,
  ): ProjectedThreadState;
  archive(threadId: string): ProjectedThreadState;
  unarchive(threadId: string): ProjectedThreadState;
}

export interface DshAppServerProjectionPort {
  begin(active: DshProjectionActiveTurn, options?: { cwd?: string }): void;
  handle(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    event: DshSessionEvent,
  ): boolean;
  settle(
    worker: DshProjectionWorker,
    active: DshProjectionActiveTurn,
    status?: "failed" | "interrupted",
  ): void;
}
