/** Pure display model. Storage, protocol adapters and execution are deliberately absent. */
export type BodyCoverage = "headers" | "partial" | "complete";
export interface HistoryCoverage {
  state: "unknown" | "partial" | "complete";
  next: string | null;
  /** Only this connected source segment is offered by the legacy linear page API. */
  visible: string[] | null;
  source: string;
  generation: string | null;
  query: string;
  evidence: "unknown" | "observed" | "stable";
}
export interface HistoryRecord {
  id: string; groupId: string | null; kind: string; type: string;
  value: Record<string, any>; coverage: BodyCoverage; sourceCursor: string | null;
}
export interface HistoryState {
  metadata: Record<string, any>; archived: boolean; deleted: boolean;
  history: HistoryCoverage; records: Record<string, HistoryRecord>;
  order: Record<string, string[]>;
}
export type HistoryChange =
  | { type: "baseline"; state: HistoryState }
  | { type: "metadata"; value: Record<string, any> }
  | { type: "put"; record: HistoryRecord }
  | { type: "remove"; id: string }
  | { type: "order"; kind: string; groupId: string | null; ids: string[] }
  | { type: "coverage"; value: HistoryCoverage }
  | { type: "archive"; value: boolean };
export interface HistoryEvent { seq: number; id: string; change: HistoryChange }
export const orderKey = (kind: string, groupId: string | null) => JSON.stringify([kind, groupId]);
export const unknownCoverage = (): HistoryCoverage => ({ state: "unknown", next: null, visible: null,
  source: "", generation: null, query: "", evidence: "unknown" });
export const emptyHistory = (): HistoryState => ({ metadata: {}, archived: false, deleted: false,
  history: unknownCoverage(), records: {}, order: {} });
const rank = { headers: 0, partial: 1, complete: 2 };

export function reduceHistory(previous: HistoryState, change: HistoryChange): HistoryState {
  if (change.type === "baseline") return structuredClone(change.state);
  const state = structuredClone(previous);
  if (state.deleted) throw new Error("A deleted history requires an explicit new baseline");
  switch (change.type) {
    case "metadata": state.metadata = { ...state.metadata, ...change.value }; break;
    case "archive": state.archived = change.value; break;
    case "put": {
      const record = structuredClone(change.record), old = state.records[record.id];
      // Sparse/header input cannot erase a previously complete object.
      if (old && rank[old.coverage] > rank[record.coverage]) {
        record.value = { ...record.value, ...old.value }; record.coverage = old.coverage;
      }
      if(old) {
        // Missing snapshot clocks do not revoke observed lifecycle facts.
        for(const key of ["startedAtMs","completedAtMs","turnStartedAtMs","firstTurnWorkItemStartedAtMs","finalAssistantStartedAtMs"])
          if(record.value[key]==null && Number.isFinite(old.value[key]))record.value[key]=old.value[key];
        if(record.kind==="group" && ["completed","failed","interrupted"].includes(old.value.status)
          && !["completed","failed","interrupted"].includes(record.value.status))record.value.status=old.value.status;
      }
      state.records[record.id] = record;
      const key = orderKey(record.kind, record.groupId);
      if (!(state.order[key] ??= []).includes(record.id)) state.order[key].push(record.id);
      break;
    }
    case "remove": {
      delete state.records[change.id];
      for (const key of Object.keys(state.order)) state.order[key] = state.order[key]!.filter(id => id !== change.id);
      break;
    }
    case "order": {
      const expected = Object.values(state.records).filter(row => row.kind === change.kind && row.groupId === change.groupId).map(row => row.id);
      if (new Set(change.ids).size !== change.ids.length || expected.length !== change.ids.length
        || expected.some(id => !change.ids.includes(id))) throw new Error("An order must name exactly its current members");
      state.order[orderKey(change.kind, change.groupId)] = [...change.ids]; break;
    }
    case "coverage": state.history = structuredClone(change.value); break;
  }
  return state;
}

/** Event identity is separate from object identity. Conflicting retries fail closed. */
export function foldHistory(events: readonly HistoryEvent[], initial = emptyHistory()): HistoryState {
  let state = initial, seq = 0;
  const seen = new Map<string, string>();
  for (const event of events) {
    const body = JSON.stringify(event.change), old = seen.get(event.id);
    if (old !== undefined) { if (old !== body) throw new Error("Conflicting history event identity"); continue; }
    if (!Number.isSafeInteger(event.seq) || event.seq <= seq) throw new Error("History sequence must advance");
    seen.set(event.id, body); seq = event.seq; state = reduceHistory(state, event.change);
  }
  return state;
}

/** A shared object does not join ranges. Only a verified cursor chain can extend one. */
export function importCoverage(previous: HistoryCoverage, page: {
  ids: string[]; cursor: string | null; next: string | null;
  source: string; generation: string | null; query: string;
  stable: boolean;
}): HistoryCoverage {
  if(new Set(page.ids).size!==page.ids.length || page.cursor!==null && page.next===page.cursor) throw new Error("History source page made no progress");
  const same = previous.source === page.source && previous.generation === page.generation && previous.query === page.query;
  if (page.cursor !== null && (!same || previous.next !== page.cursor)) throw new Error("History continuation has no matching source range");
  const visible = page.cursor === null ? [...page.ids] : [...page.ids, ...(previous.visible ?? []).filter(id => !page.ids.includes(id))];
  // One complete source read is an observation. Multi-page scans without a stable
  // source generation retain uncertainty even after the continuation reaches EOF.
  const complete = page.next === null && (page.cursor === null || page.stable && previous.evidence === "stable");
  return { state: complete ? "complete" : "partial", next: page.next, visible,
    source: page.source, generation: page.generation, query: page.query,
    evidence: page.stable ? "stable" : "observed" };
}
export function acceptsImport(current: { revision: number; epoch: string; deleted: boolean }, fence: { revision: number; epoch: string }): boolean {
  return !current.deleted && current.revision === fence.revision && current.epoch === fence.epoch;
}
