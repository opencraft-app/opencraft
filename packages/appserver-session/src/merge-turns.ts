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
 * Stable-ID merge for incremental streaming notifications.
 * Callers may explicitly replace Item membership only for an authoritative
 * full notification such as `turn/completed`. Ordered history hydration uses
 * reconcileHistoryTurns instead, before buffered notifications are replayed.
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

/** Reconcile a contiguous, chronologically ordered history span. Stable IDs
 * identify rows, but cannot establish their order: a cached final Item may
 * have arrived before older Items were hydrated. The incoming window owns the
 * order between its first and last shared anchors. Rows outside those anchors
 * remain visible until a complete snapshot or a later notification settles
 * them. */
function mergeOrderedWindow<T extends { id: string }>(
  existing: readonly T[], incoming: readonly T[],
  noOverlap: "before" | "after",
  merge: (previous: T, history: T) => T,
): readonly T[] {
  if (incoming.length === 0) return existing;
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const incomingIds = new Set(incoming.map((row) => row.id));
  const ordered = incoming.map((row) => {
    const previous = existingById.get(row.id);
    return previous === undefined ? row : merge(previous, row);
  });
  const firstAnchor = existing.findIndex((row) => incomingIds.has(row.id));
  if (firstAnchor < 0) {
    return noOverlap === "before" ? [...ordered, ...existing] : [...existing, ...ordered];
  }
  let lastAnchor = firstAnchor;
  for (let index = firstAnchor + 1; index < existing.length; index += 1) {
    if (incomingIds.has(existing[index]!.id)) lastAnchor = index;
  }
  return [
    ...existing.slice(0, firstAnchor).filter((row) => !incomingIds.has(row.id)),
    ...ordered,
    ...existing.slice(lastAnchor + 1).filter((row) => !incomingIds.has(row.id)),
  ];
}

function isTerminalTurn(turn: AppServerTurn): boolean {
  return turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed";
}

/** Keep observations absent from a snapshot at their existing neighbour, not
 * at a newly sorted tail. The snapshot still owns the order of shared rows. */
function retainObservedRows<T extends { id: string }>(
  ordered: readonly T[], existing: readonly T[], retain: (row: T) => boolean,
): readonly T[] {
  const known = new Set(ordered.map(row => row.id));
  const after = new Map<string, T[]>();
  const leading: T[] = [];
  let anchor: string | null = null;
  let firstAnchor: string | null = null;
  for (const row of existing) {
    if (known.has(row.id)) {
      firstAnchor ??= row.id;
      anchor = row.id;
    } else if (retain(row)) {
      if (anchor === null) leading.push(row);
      else {
        const rows = after.get(anchor) ?? [];
        rows.push(row);
        after.set(anchor, rows);
      }
    }
  }
  return [
    ...ordered.flatMap(row => [
      ...(row.id === firstAnchor ? leading : []), row, ...(after.get(row.id) ?? []),
    ]),
    ...(firstAnchor === null ? leading : []),
  ];
}

function mergeHistoryTurn(
  existing: AppServerTurn, history: AppServerTurn,
  observationBaseline?: { readonly turn: AppServerTurn | undefined },
): AppServerTurn {
  const historyIsOlder = isTerminalTurn(existing) && history.status === "inProgress";
  const existingItems = existing.items ?? [];
  const historyItems = history.items ?? [];
  const existingById = new Map(existingItems.map((item) => [item.id, item]));
  const baselineById = new Map((observationBaseline?.turn?.items ?? []).map(item => [item.id, item]));
  const observedSinceRequest = (item: AppServerThreadItem) => observationBaseline !== undefined
    && baselineById.get(item.id) !== item;
  const mergeItem = (previous: AppServerThreadItem, item: AppServerThreadItem): AppServerThreadItem => {
    // A terminal observation can be newer than an in-progress history page.
    // Preserve its content and lifecycle while accepting history's position.
    const keepObserved = observedSinceRequest(previous) || historyIsOlder || (history.status === "inProgress"
      && previous.completed === true && item.completed !== true);
    return keepObserved ? { ...item, ...previous } : {
      ...(history.itemsView === "full" ? {} : previous),
      ...item,
      ...(item.startedAtMs == null && previous.startedAtMs != null ? { startedAtMs: previous.startedAtMs } : {}),
      ...(item.completedAtMs == null && previous.completedAtMs != null ? { completedAtMs: previous.completedAtMs } : {}),
    };
  };
  const hydratedItems = history.itemsView === "full" && !historyIsOlder
    ? historyItems.map((item) => {
        const previous = existingById.get(item.id);
        return previous === undefined ? item : mergeItem(previous, item);
      })
    : history.itemsView === "notLoaded"
      ? existingItems
      : mergeOrderedWindow(existingItems, historyItems,
        historyIsOlder ? "before" : "after", mergeItem);
  const items = observationBaseline === undefined ? hydratedItems
    : retainObservedRows(hydratedItems, existingItems, observedSinceRequest);
  // Updates are immutable in ThreadViewStore. Compare against the request's
  // captured baseline, not a clock or guessed Item revision. Only fields that
  // actually changed during the read override the snapshot's metadata.
  const observedFields = observationBaseline === undefined ? {}
    : Object.fromEntries(Object.entries(existing).filter(([key, value]) => key !== "items"
      && key !== "itemsView" && observationBaseline.turn?.[key] !== value));
  let itemsView = history.itemsView ?? existing.itemsView;
  if (historyIsOlder) itemsView = existing.itemsView ?? "summary";
  else if (history.itemsView === "notLoaded" && existing.itemsView) itemsView = existing.itemsView;
  else if (existing.itemsView === "full" && history.itemsView !== "full") itemsView = "full";
  return {
    ...existing,
    ...history,
    ...observedFields,
    ...(historyIsOlder ? {
      status: existing.status,
      error: existing.error,
      completedAt: existing.completedAt,
      durationMs: existing.durationMs,
    } : {}),
    ...Object.fromEntries(["turnStartedAtMs", "firstTurnWorkItemStartedAtMs", "finalAssistantStartedAtMs"]
      .flatMap((key) => history[key] == null && existing[key] != null ? [[key, existing[key]]] : [])),
    itemsView,
    items,
  };
}

/** Ordered AppServer history is authoritative for its covered window; live
 * notifications use mergeTurns instead. `latest` is a tail hydration, while
 * `older` is a backward page or background drain. */
export function reconcileHistoryTurns(
  existing: readonly AppServerTurn[], history: readonly AppServerTurn[],
  historyPosition: "latest" | "older",
  options: { baselineTurns?: readonly AppServerTurn[] } = {},
): readonly AppServerTurn[] {
  const baseline = options.baselineTurns === undefined ? undefined
    : new Map(options.baselineTurns.map(turn => [turn.id, turn]));
  const ordered = mergeOrderedWindow(existing, history, historyPosition === "older" ? "before" : "after",
    (previous, snapshot) => mergeHistoryTurn(previous, snapshot,
      baseline === undefined ? undefined : { turn: baseline.get(previous.id) }));
  return baseline === undefined ? ordered
    : retainObservedRows(ordered, existing, turn => baseline.get(turn.id) !== turn);
}

/** A locator index is a placement hint for an unloaded Turn, never authority
 * to sort every loaded Turn. Updating an established Turn preserves its slot. */
export function reconcileHydratedTurn(
  existing: readonly AppServerTurn[], turn: AppServerTurn,
  chronologicalTurnIds: readonly string[],
  observationBaseline?: { readonly turn: AppServerTurn | undefined },
): readonly AppServerTurn[] {
  const established = existing.find(candidate => candidate.id === turn.id);
  if (established !== undefined) return existing.map(candidate => candidate.id === turn.id
    ? mergeHistoryTurn(candidate, turn, observationBaseline) : candidate);
  const index = chronologicalTurnIds.indexOf(turn.id);
  const positions = new Map(existing.map((candidate, position) => [candidate.id, position]));
  // Prefer the first loaded successor, then the closest loaded predecessor.
  // With no shared neighbour an unloaded historical Turn precedes the live tail.
  let insertionIndex = 0;
  for (let next = index + 1; index >= 0 && next < chronologicalTurnIds.length; next += 1) {
    const position = positions.get(chronologicalTurnIds[next]!);
    if (position !== undefined) {
      insertionIndex = position;
      return [...existing.slice(0, insertionIndex), turn, ...existing.slice(insertionIndex)];
    }
  }
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const position = positions.get(chronologicalTurnIds[previous]!);
    if (position !== undefined) { insertionIndex = position + 1; break; }
  }
  return [...existing.slice(0, insertionIndex), turn, ...existing.slice(insertionIndex)];
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


/** A bounded recovery tail replaces old canonical coverage. Cached running
 * status alone cannot overrule a newer terminal snapshot. Preserve only
 * observations after the request baseline and explicitly unresolved admissions.
 */
export function reconcileRecoveryWindow(
  existing: readonly AppServerTurn[], incoming: readonly AppServerTurn[],
  baselineTurns: readonly AppServerTurn[], unresolvedTurnIds: readonly string[] = [],
): readonly AppServerTurn[] {
  const ids = new Set(incoming.map(turn => turn.id));
  const baseline = new Map(baselineTurns.map(turn => [turn.id, turn]));
  const unresolved = new Set(unresolvedTurnIds);
  const covered = existing.filter(turn => ids.has(turn.id));
  const canonical = reconcileHistoryTurns(covered, incoming, "latest", { baselineTurns });
  return retainObservedRows(canonical, existing, turn => unresolved.has(turn.id) || baseline.get(turn.id) !== turn);
}
