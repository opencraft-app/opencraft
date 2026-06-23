export type VelaConversationHistoryPolicy = "full_preload" | "tail_only";
export type VelaConversationHistoryPhase =
  | "unselected"
  | "hydrating_history"
  | "ready";

export const DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY: VelaConversationHistoryPolicy =
  "full_preload";

export function hasCompletedConversationHistoryHydration(
  completedSessionIds: ReadonlySet<string>,
  sessionId: string,
) {
  const normalizedSessionId = sessionId.trim();
  return Boolean(
    normalizedSessionId && completedSessionIds.has(normalizedSessionId),
  );
}

export function rememberCompletedConversationHistoryHydration(
  completedSessionIds: ReadonlySet<string>,
  sessionId: string,
): ReadonlySet<string> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return completedSessionIds;
  if (completedSessionIds.has(normalizedSessionId)) return completedSessionIds;

  const nextCompletedSessionIds = new Set(completedSessionIds);
  nextCompletedSessionIds.add(normalizedSessionId);
  return nextCompletedSessionIds;
}

interface ConversationHistoryPhaseInput {
  activeSessionId: string;
  error: string | null;
  hasCompletedInitialHydration: boolean;
  hasOlder: boolean;
  isConversationReady: boolean;
  isLoadingOlder: boolean;
  policy: VelaConversationHistoryPolicy;
}

export function deriveConversationHistoryPhase({
  activeSessionId,
  error,
  hasCompletedInitialHydration,
  hasOlder,
  isConversationReady,
  isLoadingOlder,
  policy,
}: ConversationHistoryPhaseInput): VelaConversationHistoryPhase {
  if (!activeSessionId) return "unselected";
  if (
    policy === "full_preload" &&
    !error &&
    !hasCompletedInitialHydration &&
    (!isConversationReady || hasOlder || isLoadingOlder)
  ) {
    return "hydrating_history";
  }
  return "ready";
}

export function shouldAutoPreloadOlderConversation({
  activeSessionId,
  error,
  hasCompletedInitialHydration,
  hasOlder,
  isConversationReady,
  isLoadingOlder,
  policy,
}: {
  activeSessionId: string;
  error: string | null;
  hasCompletedInitialHydration: boolean;
  hasOlder: boolean;
  isConversationReady: boolean;
  isLoadingOlder: boolean;
  policy: VelaConversationHistoryPolicy;
}) {
  return Boolean(
    policy === "full_preload" &&
      activeSessionId &&
      !error &&
      !hasCompletedInitialHydration &&
      isConversationReady &&
      hasOlder &&
      !isLoadingOlder,
  );
}
