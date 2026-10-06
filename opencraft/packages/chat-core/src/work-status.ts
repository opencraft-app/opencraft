import type { TimelineSourceTurn } from "./projection";
import { formatCodexDuration } from "./format-duration";

/** Codex r3562 worked-for display item. This is not assistant/reasoning text. */
export type WorkStatusItem = {
  readonly type: "worked-for";
  readonly startedAtMs: number;
} & (
  | { readonly status: "working"; readonly completedAtMs: null }
  | { readonly status: "worked" | "stopped"; readonly completedAtMs: number }
);

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * r3562 normalizeTurnToDisplayItems → insertWorkStatusItem. Event clocks are
 * sampled by the session projector, never by this pure projection or React.
 * History without those facts stays unknown; Turn duration is a separate
 * disclosure-label fallback, not a fabricated work interval.
 */
export function deriveTurnWorkStatus(
  turn: TimelineSourceTurn,
): WorkStatusItem | null {
  // Old snapshots may encode the aggregate as an Item. A resource cannot
  // extend work, hide the final answer, or supply a work-start observation.
  turn = { ...turn, items: turn.items.filter(item => item.type !== "turnDiff") };
  const active = turn.status === "streaming" || turn.status === "pending";
  if (
    turn.status === "interrupted" ||
    turn.items.some((item) => item.type === "sleep")
  )
    return null;
  let lastAssistantIndex = -1;
  let lastInputIndex = -1;
  let finalCount = 0;
  let hasAsyncFinal = false;
  let firstObservedWorkStart: number | null = null;
  turn.items.forEach((item, index) => {
    const payload = record(item.payload);
    if (["userMessage", "steeringUserMessage", "hookPrompt", "realtimeTranscript"].includes(item.type)) lastInputIndex = index;
    if (item.type === "agentMessage") {
      const async = payload.delivery === "async" || (Array.isArray(payload.questions) && payload.questions.length > 0);
      if (payload.phase === "final_answer" && async) hasAsyncFinal = true;
      if (!async && payload.phase !== "commentary") {
        lastAssistantIndex = index;
        if (payload.phase === "final_answer") finalCount += 1;
      }
    }
    if (item.type !== "userMessage" && item.type !== "hookPrompt") {
      firstObservedWorkStart ??= timestamp(record(item.payload).startedAtMs);
    }
  });
  const lastAssistant = turn.items[lastAssistantIndex];
  const lastPayload = record(lastAssistant?.payload);
  const hasCurrentFinal = lastAssistantIndex > lastInputIndex
    && lastPayload.phase === "final_answer"
    && !turn.items.slice(lastAssistantIndex + 1).some(item => !["steered", "worktreeInit"].includes(item.type));
  let assistantIndex = active ? hasCurrentFinal ? lastAssistantIndex : -1 : lastAssistantIndex;
  if (active && assistantIndex < 0) assistantIndex = turn.items.length;
  if (assistantIndex < 0) return null;
  const hasWork = turn.items
    .slice(0, assistantIndex)
    .some(
      (item) =>
        ![
          "userMessage",
          "hookPrompt",
          "steered",
          "realtimeTranscript",
          "worktreeInit",
        ].includes(item.type),
    );
  if (!hasWork) return null;
  const firstWorkStartedAtMs =
    turn.firstTurnWorkItemStartedAtMs ?? firstObservedWorkStart;
  if (firstWorkStartedAtMs === null) return null;
  const startedAtMs = turn.startedAtMs ?? firstWorkStartedAtMs;
  const finalStartedAtMs =
    timestamp(lastPayload.startedAtMs) ??
    (finalCount <= 1 && !hasAsyncFinal ? turn.finalAssistantStartedAtMs ?? null : null);
  const hasDisplayableFinal = hasCurrentFinal
    && ((typeof lastPayload.text === "string" && lastPayload.text.trim().length > 0)
      || lastPayload.completed === true || lastPayload.structuredOutput != null);
  const completedAtMs =
    active && !hasDisplayableFinal ? null : finalStartedAtMs;
  if (completedAtMs !== null)
    return { type: "worked-for", status: "worked", startedAtMs, completedAtMs };
  return active
    ? {
        type: "worked-for",
        status: "working",
        startedAtMs,
        completedAtMs: null,
      }
    : null;
}

/** r3562 formatDurationShort: floor seconds, trim zero units, localize units. */
export function formatWorkDuration(durationMs: number, locale = "en"): string {
  return (
    formatCodexDuration(durationMs, {
      locale,
      underOneSecond: "zero",
      trimZeroUnits: true,
    }) ?? "0s"
  );
}

export interface WorkStatusLabel {
  readonly messageId: "working" | "workingFor" | "workedFor" | "stoppedAfter";
  readonly time: string;
}

export function deriveWorkStatusLabel(
  item: WorkStatusItem,
  nowMs: number,
  locale = "en",
): WorkStatusLabel {
  const elapsedMs = Math.max(
    (item.completedAtMs ?? nowMs) - item.startedAtMs,
    0,
  );
  return {
    messageId:
      item.status === "working"
        ? elapsedMs < 1_000
          ? "working"
          : "workingFor"
        : item.status === "stopped"
          ? "stoppedAfter"
          : "workedFor",
    time: formatWorkDuration(elapsedMs, locale),
  };
}

/** Shared default copy; hosts can localize these message IDs without owning timing. */
export function workStatusLabelText(label: WorkStatusLabel): string {
  switch (label.messageId) {
    case "working":
      return "Working";
    case "workingFor":
      return `Working for ${label.time}`;
    case "workedFor":
      return `Worked for ${label.time}`;
    case "stoppedAfter":
      return `You stopped after ${label.time}`;
  }
}
