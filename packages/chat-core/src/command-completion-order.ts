import type { TimelineSourceItem, TimelineSourceTurn } from "./projection";

function payload(item: TimelineSourceItem): Record<string, unknown> {
  return item.payload !== null && typeof item.payload === "object"
    ? item.payload as Record<string, unknown> : {};
}

function start(item: TimelineSourceItem): number | undefined {
  const value = payload(item).startedAtMs;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Late completions belong at the execution's known start, not its receipt time. */
export function normalizeCommandCompletionOrder(turn: TimelineSourceTurn): TimelineSourceTurn {
  let items: TimelineSourceItem[] | undefined;
  let latestStart = -Infinity;
  for (let index = 0; index < turn.items.length; index++) {
    const item = (items ?? turn.items)[index]!;
    const startedAt = start(item);
    const delayed = startedAt !== undefined && startedAt < latestStart;
    latestStart = Math.max(latestStart, startedAt ?? -Infinity);
    if (!delayed) continue;
    const data = payload(item);
    if (item.type !== "commandExecution" || !(data.completed === true
      || data.status === "completed" || data.status === "failed" || data.status === "interrupted")) continue;
    if (startedAt === undefined) continue;
    const position = (items ?? turn.items).findIndex((candidate, candidateIndex) =>
      candidateIndex < index && (start(candidate) ?? -Infinity) > startedAt);
    if (position < 0) continue;
    items ??= [...turn.items];
    items.splice(index, 1);
    items.splice(position, 0, item);
  }
  return items === undefined ? turn : { ...turn, items };
}
