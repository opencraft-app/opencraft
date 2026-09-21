export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type ExecutionStatus = "inProgress" | "completed" | "failed" | "interrupted";

export interface DisplayFileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "modified" | "added" | "deleted";
}

export interface UserMessageDisplayItem {
  type: "user-message";
  id: string;
  message: string;
  sentAtMs: number;
}

export interface AssistantMessageDisplayItem {
  type: "assistant-message";
  id: string;
  content: string;
  completed: boolean;
  phase?: "commentary" | "final_answer";
  sentAtMs?: number;
}

export interface ReasoningDisplayItem {
  type: "reasoning";
  id: string;
  content: string;
  detail?: string;
  completed: boolean;
}

export interface ExecDisplayItem {
  type: "exec";
  id: string;
  callId: string;
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  executionStatus: ExecutionStatus;
}

export interface PatchDisplayItem {
  type: "patch";
  id: string;
  callId: string;
  title: string;
  changes: DisplayFileChange[];
  success: boolean | null;
}

export type DisplayItem =
  | UserMessageDisplayItem
  | AssistantMessageDisplayItem
  | ReasoningDisplayItem
  | ExecDisplayItem
  | PatchDisplayItem;

export interface DisplayTurn {
  id: string;
  status: TurnStatus;
  items: DisplayItem[];
  startedAtMs: number;
  completedAtMs?: number;
}
