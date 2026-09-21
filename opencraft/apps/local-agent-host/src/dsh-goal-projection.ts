/** DSH owns the goal; this is a read-only projection, never a TODO mutation. */
export function projectDshGoal(threadId: string, value: unknown) {
  const snapshot = value as { operation?: string; goal?: { objective?: string; phase?: string }; createdAt?: number; updatedAt?: number } | null;
  if (!snapshot || snapshot.operation === "clear" || typeof snapshot.goal?.objective !== "string") return null;
  const status = snapshot.goal.phase;
  if (!["active", "paused", "blocked", "complete"].includes(status ?? "")) return null;
  return {
    threadId, objective: snapshot.goal.objective, status,
    // DSH has no token budget/usage accounting. These protocol-required counters
    // represent no recorded usage, not an estimate of actual model consumption.
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
    createdAt: Math.floor((snapshot.createdAt ?? 0) / 1000),
    updatedAt: Math.floor((snapshot.updatedAt ?? 0) / 1000),
  };
}
