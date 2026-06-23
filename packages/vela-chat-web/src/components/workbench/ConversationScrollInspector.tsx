"use client";

import type { ConversationScrollControllerDebug } from "../../conversation-runtime/scroll/useConversationScrollController";
import styles from "../../styles/desktop.module.css";

export interface ConversationScrollInspectorProps {
  debug: ConversationScrollControllerDebug | null;
  historyPhase: "unselected" | "hydrating_history" | "ready";
}

export function ConversationScrollInspector({
  debug,
  historyPhase,
}: ConversationScrollInspectorProps) {
  if (!debug) return null;

  const lastWrite = debug.lastScrollWrite
    ? `${debug.lastScrollWrite.source}:${debug.lastScrollWrite.reason}`
    : "none";

  const rows = [
    ["history", historyPhase],
    ["route", debug.routeResumeStatus],
    ["follow", debug.followOutput ? "yes" : "no"],
    ["mode", debug.bottomAnchorMode],
    ["blocked", debug.bottomAnchorBlockedReason ?? "none"],
    ["pending", debug.bottomAnchorPendingReason ?? "none"],
    ["fulfilled", debug.bottomAnchorLastFulfilledReason ?? "none"],
    ["write", lastWrite],
    ["top", debug.routeResumeScrollTop === null ? "none" : String(debug.routeResumeScrollTop)],
    ["layout", debug.lastLayoutSignal],
    ["signal", debug.lastFollowSignal],
  ] as const;

  return (
    <aside
      aria-label="Conversation scroll inspector"
      className={styles.scrollInspector}
    >
      <div className={styles.scrollInspectorTitle}>Scroll</div>
      <dl className={styles.scrollInspectorGrid}>
        {rows.map(([label, value]) => (
          <div className={styles.scrollInspectorRow} key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
