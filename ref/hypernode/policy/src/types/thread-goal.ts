export const THREAD_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;

export type ThreadGoalStatus = typeof THREAD_GOAL_STATUSES[number];

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: ThreadGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadGoalSetParams {
  threadId: string;
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
}

export interface ThreadGoalPort {
  get(threadId: string): ThreadGoal | null;
  set(params: ThreadGoalSetParams): ThreadGoal;
  clear(threadId: string): boolean;
}
