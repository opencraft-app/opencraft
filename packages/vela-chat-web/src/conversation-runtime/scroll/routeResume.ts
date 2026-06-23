import type { ConversationScrollClientState } from "../../../../vela-chat-host-state/src";
import type { BottomAnchorBlockedReason } from "./bottomAnchorDriver";

export type ConversationScrollResumeState = ConversationScrollClientState;

export interface ConversationScrollResumeDecisionInput {
  contentHeight: number;
  isHistoryReady: boolean;
  pendingVerification: boolean;
  resumeState: ConversationScrollResumeState | null;
  viewportHeight: number;
  viewportWidth: number;
}

export interface ConversationScrollResumeDecision {
  blockedReason: BottomAnchorBlockedReason | null;
  shouldRestore: boolean;
  scrollTop: number | null;
}

export function shouldRequestInitialBottomAnchorAfterResumeAttempt({
  didRestore,
  hasPendingResumeState,
}: {
  didRestore: boolean;
  hasPendingResumeState: boolean;
}): boolean {
  return !didRestore && !hasPendingResumeState;
}

export function deriveConversationScrollResumeDecision({
  contentHeight,
  isHistoryReady,
  resumeState,
  viewportHeight,
  viewportWidth,
}: ConversationScrollResumeDecisionInput): ConversationScrollResumeDecision {
  if (!resumeState || resumeState.followOutput) {
    return { blockedReason: null, shouldRestore: false, scrollTop: null };
  }
  if (!isHistoryReady) {
    return {
      blockedReason: "waiting_for_history_readiness",
      shouldRestore: false,
      scrollTop: null,
    };
  }
  if (
    ![viewportHeight, viewportWidth].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return {
      blockedReason: "waiting_for_measurable_viewport",
      shouldRestore: false,
      scrollTop: null,
    };
  }
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    return {
      blockedReason: "waiting_for_measurable_content",
      shouldRestore: false,
      scrollTop: null,
    };
  }
  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  if (resumeState.scrollTop > maxScrollTop) {
    return {
      blockedReason: null,
      shouldRestore: true,
      scrollTop: maxScrollTop,
    };
  }

  return {
    blockedReason: null,
    shouldRestore: true,
    scrollTop: Math.max(0, resumeState.scrollTop),
  };
}
