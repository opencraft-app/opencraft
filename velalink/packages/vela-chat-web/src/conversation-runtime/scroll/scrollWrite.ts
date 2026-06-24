export type ConversationScrollWriteSource =
  | "bottom_follow"
  | "history_prepend"
  | "route_resume"
  | "route_resume_confirmation"
  | "scrollbar_overlay"
  | "user_scroll"
  | "virtualizer_measurement";

export interface ConversationScrollWrite {
  behavior?: ScrollBehavior;
  reason: string;
  scrollTop: number;
  source: ConversationScrollWriteSource;
}

export type ConversationScrollRouteResumeStatus =
  | "idle"
  | "pending"
  | "restored";

export interface ConversationScrollWritePhase {
  routeResumeStatus: ConversationScrollRouteResumeStatus;
}

export type ConversationScrollWriteBlockedBy = "route_resume_pending";

export interface ConversationScrollWriteDecision {
  action: "apply" | "suppress";
  blockedBy: ConversationScrollWriteBlockedBy | null;
  write: ConversationScrollWrite;
}

export interface ConversationScrollWritableElement {
  scrollTop: number;
  scrollTo?: (options: ScrollToOptions) => void;
  style: Pick<CSSStyleDeclaration, "scrollBehavior">;
}

export interface ConversationScrollWriteApplication {
  applied: boolean;
  decision: ConversationScrollWriteDecision;
  nextScrollTop: number;
  previousScrollTop: number;
}

const PASSIVE_WRITE_SOURCES = new Set<ConversationScrollWriteSource>([
  "bottom_follow",
  "history_prepend",
  "virtualizer_measurement",
]);

export function deriveConversationScrollWriteDecision({
  phase,
  write,
}: {
  phase: ConversationScrollWritePhase;
  write: ConversationScrollWrite;
}): ConversationScrollWriteDecision {
  if (
    phase.routeResumeStatus === "pending" &&
    PASSIVE_WRITE_SOURCES.has(write.source)
  ) {
    return {
      action: "suppress",
      blockedBy: "route_resume_pending",
      write,
    };
  }

  return {
    action: "apply",
    blockedBy: null,
    write,
  };
}

export function applyConversationScrollWrite({
  element,
  phase,
  write,
}: {
  element: ConversationScrollWritableElement;
  phase: ConversationScrollWritePhase;
  write: ConversationScrollWrite;
}): ConversationScrollWriteApplication {
  const previousScrollTop = element.scrollTop;
  const decision = deriveConversationScrollWriteDecision({ phase, write });
  if (decision.action !== "apply") {
    return {
      applied: false,
      decision,
      previousScrollTop,
      nextScrollTop: previousScrollTop,
    };
  }

  const behavior = write.behavior ?? "auto";
  if (behavior === "auto" || !element.scrollTo) {
    const previousScrollBehavior = element.style.scrollBehavior;
    element.style.scrollBehavior = "auto";
    element.scrollTop = write.scrollTop;
    element.style.scrollBehavior = previousScrollBehavior;
  } else {
    element.scrollTo({ top: write.scrollTop, behavior });
  }

  return {
    applied: true,
    decision,
    previousScrollTop,
    nextScrollTop: element.scrollTop,
  };
}
