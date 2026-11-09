/** Native Agent observations, separate from the server's allocation ledger. */
export interface AgentTokenCounts {
  totalTokens: number | null; inputTokens: number | null; outputTokens: number | null;
  cachedInputTokens: number | null; reasoningOutputTokens: number | null;
}
export interface AgentConversationUsage {
  threadId: string; providerId: string; observedAt: number;
  context: { usedTokens: number; limitTokens: number } | null;
  total: AgentTokenCounts | null; last: AgentTokenCounts | null;
}
export interface AgentUsageWindow {
  kind: "rateLimit" | "plan" | "spend";
  durationMinutes: number | null; usedPercent: number; resetsAt: number | null;
  cost: { usedCents: number; limitCents: number; currency: "USD" } | null;
  scope?: "team" | "account";
}
export interface AgentProviderUsage {
  id: "codex" | "cursor"; status: "ok" | "signedOut" | "expired" | "unavailable";
  plan: string | null; observedAt: number | null; windows: AgentUsageWindow[];
}
export interface AgentUsageSnapshot {
  providers: AgentProviderUsage[]; conversation: AgentConversationUsage | null; readAt: number;
}
export interface AgentUsageMethodMap {
  "opencraft/agents/usage": { params: { threadId?: string; force?: boolean }; result: AgentUsageSnapshot };
}
