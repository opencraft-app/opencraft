export type ConversationHistoryPolicy = "tail_only" | "full_preload";

export const DEFAULT_DESKTOP_CONVERSATION_HISTORY_POLICY: ConversationHistoryPolicy =
  "full_preload";

export interface ConversationHistoryPolicyState {
  activeSessionId: string;
  error?: string | null;
  hasCompletedInitialHydration: boolean;
  hasOlder: boolean;
  isConversationReady: boolean;
  isLoadingOlder: boolean;
  policy: ConversationHistoryPolicy;
}

export function shouldAutoPreloadOlderConversation({
  activeSessionId,
  error,
  hasCompletedInitialHydration,
  hasOlder,
  isConversationReady,
  isLoadingOlder,
  policy,
}: ConversationHistoryPolicyState): boolean {
  return (
    policy === "full_preload" &&
    activeSessionId.length > 0 &&
    !hasCompletedInitialHydration &&
    isConversationReady &&
    hasOlder &&
    !isLoadingOlder &&
    !error
  );
}

export function shouldShowConversationHistoryHydrationGate({
  activeSessionId,
  error,
  hasCompletedInitialHydration,
  hasOlder,
  isConversationReady,
  isLoadingOlder,
  policy,
}: ConversationHistoryPolicyState): boolean {
  return (
    policy === "full_preload" &&
    activeSessionId.length > 0 &&
    !hasCompletedInitialHydration &&
    !error &&
    (!isConversationReady || hasOlder || isLoadingOlder)
  );
}
