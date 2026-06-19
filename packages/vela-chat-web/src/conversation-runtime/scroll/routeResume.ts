import type { BottomAnchorRouteBlockedReason } from "./bottomAnchor";

export const CONVERSATION_SCROLL_RESUME_STORAGE_PREFIX =
  "vela-chat:conversation-scroll:";

export interface ConversationScrollResumeState {
  routeKey: string;
  scrollTop: number;
  followOutput: boolean;
}

export interface ConversationScrollResumeDecisionInput {
  contentHeight: number;
  isHistoryReady: boolean;
  pendingVerification: boolean;
  resumeState: ConversationScrollResumeState | null;
  viewportHeight: number;
  viewportWidth: number;
}

export interface ConversationScrollResumeDecision {
  blockedReason: BottomAnchorRouteBlockedReason | null;
  shouldRestore: boolean;
  scrollTop: number | null;
}

interface SerializedConversationScrollResumeState {
  version: 1;
  route_key: string;
  scroll_top: number;
  follow_output: boolean;
}

export function buildConversationScrollResumeStorageKey(
  routeKey: string | null | undefined,
): string | null {
  if (!routeKey) return null;
  return `${CONVERSATION_SCROLL_RESUME_STORAGE_PREFIX}${encodeURIComponent(routeKey)}`;
}

export function serializeConversationScrollResumeState(
  state: ConversationScrollResumeState,
): string {
  const payload: SerializedConversationScrollResumeState = {
    version: 1,
    route_key: state.routeKey,
    scroll_top: state.scrollTop,
    follow_output: state.followOutput,
  };
  return JSON.stringify(payload);
}

export function parseConversationScrollResumeState(
  raw: string | null,
  expectedRouteKey: string,
): ConversationScrollResumeState | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<SerializedConversationScrollResumeState>;
  if (value.version !== 1) return null;
  if (value.route_key !== expectedRouteKey) return null;
  if (
    typeof value.scroll_top !== "number" ||
    !Number.isFinite(value.scroll_top) ||
    value.scroll_top < 0
  ) {
    return null;
  }
  if (typeof value.follow_output !== "boolean") return null;

  return {
    routeKey: value.route_key,
    scrollTop: value.scroll_top,
    followOutput: value.follow_output,
  };
}

export function readConversationScrollResumeState(
  storage: Pick<Storage, "getItem"> | null | undefined,
  routeKey: string | null | undefined,
): ConversationScrollResumeState | null {
  const storageKey = buildConversationScrollResumeStorageKey(routeKey);
  if (!storage || !storageKey || !routeKey) return null;

  try {
    return parseConversationScrollResumeState(
      storage.getItem(storageKey),
      routeKey,
    );
  } catch {
    return null;
  }
}

export function persistConversationScrollResumeState(
  storage: Pick<Storage, "setItem"> | null | undefined,
  state: ConversationScrollResumeState,
): void {
  const storageKey = buildConversationScrollResumeStorageKey(state.routeKey);
  if (!storage || !storageKey) return;

  try {
    storage.setItem(storageKey, serializeConversationScrollResumeState(state));
  } catch {
    // Storage may be disabled or full; scroll resume is a best-effort comfort.
  }
}

export function deriveConversationScrollResumeDecision({
  contentHeight,
  isHistoryReady,
  pendingVerification,
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
  if (pendingVerification) {
    return {
      blockedReason: "waiting_for_post_layout_verification",
      shouldRestore: false,
      scrollTop: null,
    };
  }

  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  return {
    blockedReason: null,
    shouldRestore: true,
    scrollTop: Math.min(Math.max(0, resumeState.scrollTop), maxScrollTop),
  };
}
