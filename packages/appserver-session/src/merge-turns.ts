import type { AppServerThreadItem, AppServerTurn } from "@opencraft/appserver-protocol";

function mergeItems(
  existing: readonly AppServerThreadItem[] = [],
  incoming: readonly AppServerThreadItem[] = [],
): readonly AppServerThreadItem[] {
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  const existingIds = new Set(existing.map((item) => item.id));
  return [
    ...existing.map((item) => incomingById.has(item.id) ? { ...item, ...incomingById.get(item.id) } : item),
    ...incoming.filter((item) => !existingIds.has(item.id)),
  ];
}

function mergeTurn(
  existing: AppServerTurn,
  incoming: AppServerTurn,
  itemsMode: "merge" | "replace",
): AppServerTurn {
  const existingById = new Map((existing.items ?? []).map((item) => [item.id, item]));
  return {
    ...existing,
    ...incoming,
    // A full snapshot owns membership/content, but missing timing fields do
    // not revoke already observed lifecycle facts for the same Turn/Item ID.
    ...Object.fromEntries(["turnStartedAtMs", "firstTurnWorkItemStartedAtMs", "finalAssistantStartedAtMs"]
      .flatMap((key) => incoming[key] == null && existing[key] != null ? [[key, existing[key]]] : [])),
    items: itemsMode === "replace"
      ? (incoming.items ?? []).map((item) => ({
          ...item,
          ...Object.fromEntries(["startedAtMs", "completedAtMs"].flatMap((key) => {
            const previous = existingById.get(item.id);
            return item[key] == null && previous?.[key] != null ? [[key, previous[key]]] : [];
          })),
        }))
      : mergeItems(existing.items, incoming.items),
  };
}

/**
 * Stable-ID merge used when buffered streaming notifications race hydration.
 * Callers may explicitly replace Item membership only for an authoritative
 * full snapshot such as `turn/completed`; ordinary hydration remains additive
 * so a stale response cannot erase newer buffered stream Items.
 */
export function mergeTurns(
  existing: readonly AppServerTurn[],
  incoming: readonly AppServerTurn[],
  options: {
    placement?: "prepend" | "append";
    itemsMode?: "merge" | "replace";
  } = {},
): readonly AppServerTurn[] {
  const incomingById = new Map(incoming.map((turn) => [turn.id, turn]));
  const existingIds = new Set(existing.map((turn) => turn.id));
  const result = existing.map((turn) => {
    const replacement = incomingById.get(turn.id);
    return replacement === undefined ? turn : mergeTurn(turn, replacement, options.itemsMode ?? "merge");
  });
  const uniqueIncoming = incoming.filter((turn) => !existingIds.has(turn.id));
  if (options.placement === "prepend") result.unshift(...uniqueIncoming);
  else result.push(...uniqueIncoming);
  return result;
}

/** A row-window refresh owns only previously projected history membership.
 * It may replace a partial leading group with a larger one. It cannot revoke
 * independently admitted execution Turns or their newer streaming Items. */
export function reconcileHistoryWindow(
  existing: readonly AppServerTurn[], incoming: readonly AppServerTurn[],
  resumeBaseline: readonly AppServerTurn[] = [],
): readonly AppServerTurn[] {
  const baseline = new Set(resumeBaseline);
  const live = existing.filter(turn => turn.status === "inProgress"
    || (typeof turn.historyWindowId !== "string" && !baseline.has(turn)));
  const liveIds = new Set(live.map(turn => turn.id));
  return [
    ...incoming.filter(turn => !liveIds.has(turn.id)),
    ...live,
  ];
}
