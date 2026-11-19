import { ThreadCatalogUpdates } from "../../../apps/workbench-web/src/runtime/thread-catalog-updates";
import { mergeThreadCatalogPages } from "../../../apps/workbench-web/src/runtime/thread-catalog-query";
import type { Thread, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { ChaosViolation, requireThat } from "./recovery-chaos";

type Id = "A" | "B";
type Status = "idle" | "active" | "systemError";
export type CatalogChaosEvent =
  | { type: "tail" }
  | { type: "rename"; id: Id; name: string }
  | { type: "status"; id: Id; status: Status }
  | { type: "remove"; id: Id }
  | { type: "materialize" }
  | { type: "lagging-read"; partial: boolean }
  | { type: "duplicate" }
  | { type: "switch-scope" }
  | { type: "late-old-scope" };
type Row = Thread & { pinned: boolean };
type Pages = { pages: ThreadListResponse[]; pageParams: Array<string | null> };
const ids: readonly Id[] = ["A", "B"];
const makeRow = (id: Id): Row =>
  ({
    id,
    name: id + "-current",
    cwd: "/synthetic",
    preview: "",
    createdAt: 1,
    updatedAt: 100,
    recencyAt: 100,
    pinned: id === "A",
    status: { type: "active", activeFlags: [] },
    ephemeral: false,
    turns: [],
  }) as unknown as Row;
const page = (rows: readonly Thread[], nextCursor: string | null = null): ThreadListResponse => ({
  data: [...rows],
  nextCursor,
});
const staleA = (): Row => ({
  ...makeRow("A"),
  pinned: false,
  name: "A-old",
  updatedAt: 20,
  recencyAt: 20,
  status: { type: "idle" },
});
const fact = (revision: number, change: any) => ({
  version: 1 as const,
  source: "synthetic-incarnation",
  revision,
  change,
});
const summary = (row: Row) => ({
  id: row.id,
  name: row.name,
  pinned: row.pinned,
  status: row.status.type,
  updatedAt: row.updatedAt,
  recencyAt: row.recencyAt,
});

/** Executes production cache code, not a repaired copy of it. The independent
 * expected view follows admitted field-owner facts, not a last-row-wins merge.
 * A failure is an implementation defect; former counterexamples must now pass without waivers. */
export async function simulateCatalogConsistency(events: readonly CatalogChaosEvent[]) {
  let journal = new ThreadCatalogUpdates("host-fixture");
  journal.enabled = true;
  let retired: ThreadCatalogUpdates | undefined;
  let expected = new Map<Id, Row>(ids.map((id) => [id, makeRow(id)]));
  let data: Pages = { pages: [page([...expected.values()])], pageParams: [null] };
  let revision = 0,
    last: ReturnType<typeof fact> | undefined;
  const coverage: Record<string, number> = {};
  const emit = (change: any) => {
    last = fact(++revision, change);
    journal.receive(last);
  };
  const check = (step: number) => {
    const result = journal.project({ ...data.pages[0]!, data: mergeThreadCatalogPages(data.pages) });
    const actual = new Map((result?.data ?? []).map((row) => [row.id, row as Row]));
    for (const id of ids) {
      const wanted = expected.get(id),
        got = actual.get(id);
      const rule =
        Boolean(wanted) !== Boolean(got)
          ? "CATALOG_MEMBERSHIP"
          : wanted && got && wanted.pinned !== got.pinned
            ? "CATALOG_PIN_OWNER"
            : wanted && got && wanted.name !== got.name
              ? "CATALOG_NAME_OWNER"
              : wanted && got && wanted.status.type !== got.status.type
                ? "CATALOG_STATUS_OWNER"
                : wanted && got && (wanted.updatedAt !== got.updatedAt || wanted.recencyAt !== got.recencyAt)
                  ? "CATALOG_NATIVE_CLOCK"
                  : null;
      if (rule) {
        const error = new ChaosViolation(rule, `step ${step}: ${id} lost an admitted owner fact`);
        error.evidence = {
          step,
          expected: wanted ? summary(wanted) : null,
          actual: got ? summary(got) : null,
          coverage,
        };
        throw error;
      }
    }
  };
  check(-1);
  for (const [step, event] of events.entries()) {
    coverage[event.type] = (coverage[event.type] ?? 0) + 1;
    switch (event.type) {
      case "tail":
        // Duplicate is expected in the real backfilled-pins + recent-pages path.
        data = { pages: [{ ...data.pages[0]!, nextCursor: "tail" }, page([staleA()])], pageParams: [null, "tail"] };
        break;
      case "rename": {
        const old = expected.get(event.id);
        if (old) {
          expected.set(event.id, { ...old, name: event.name });
          emit({ type: "patch", threadId: event.id, name: event.name });
        }
        break;
      }
      case "status": {
        const old = expected.get(event.id);
        if (old) {
          const status =
            event.status === "active" ? { type: "active" as const, activeFlags: [] } : { type: event.status };
          expected.set(event.id, { ...old, status });
          emit({ type: "patch", threadId: event.id, status });
        }
        break;
      }
      case "remove":
        expected.delete(event.id);
        emit({ type: "remove", threadId: event.id });
        break;
      case "materialize":
        data = journal.materialize(data)!;
        break;
      case "lagging-read": {
        // Read starts after the committed event but the index may still lag.
        const response = journal.markRead(
          {
            ...page(ids.map(makeRow)),
            ...(event.partial ? { catalog: { state: "warming", coverage: "partial" } } : {}),
          },
          journal.getSnapshot(),
        );
        journal.acknowledge(response);
        data = { pages: [response], pageParams: [null] };
        break;
      }
      case "duplicate":
        if (last) journal.receive(last);
        break;
      case "switch-scope":
        retired = journal;
        retired.enabled = false;
        journal = new ThreadCatalogUpdates("host-fixture");
        journal.enabled = true;
        expected = new Map(ids.map((id) => [id, { ...makeRow(id), name: id + "-successor" }]));
        data = { pages: [page([...expected.values()])], pageParams: [null] };
        last = undefined;
        revision = 0;
        break;
      case "late-old-scope":
        retired?.receive(fact(1000, { type: "patch", threadId: "A", name: "retired-secret" }));
        break;
    }
    check(step);
  }
  return { events: events.length, coverage, target: "production-cache" };
}

export function generateCatalogConsistencyChaos(seed: number, steps: number): CatalogChaosEvent[] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const trace: CatalogChaosEvent[] = [];
  // Seed-dependent adversarial schedules, not sleeps or a live environment.
  const mode = random() % 4,
    id = ids[random() % 2]!;
  if (mode === 0) trace.push({ type: "tail" }, { type: "rename", id, name: "renamed" }, { type: "materialize" });
  if (mode === 1) trace.push({ type: "tail" }, { type: "status", id: "B", status: "idle" }, { type: "materialize" });
  if (mode === 2) trace.push({ type: "rename", id, name: "committed-name" }, { type: "lagging-read", partial: true });
  if (mode === 3) trace.push({ type: "switch-scope" }, { type: "late-old-scope" }, { type: "duplicate" });
  while (trace.length < steps) {
    const pick = random() % 6,
      target = ids[random() % 2]!;
    trace.push(
      pick === 0
        ? { type: "tail" }
        : pick === 1
          ? { type: "rename", id: target, name: "name-" + (random() % 10) }
          : pick === 2
            ? { type: "status", id: target, status: random() % 2 ? "active" : "idle" }
            : pick === 3
              ? { type: "materialize" }
              : pick === 4
                ? { type: "duplicate" }
                : { type: "remove", id: target },
    );
  }
  return trace.slice(0, steps);
}
export function parseCatalogConsistencyTrace(value: unknown): CatalogChaosEvent[] {
  requireThat(Array.isArray(value) && value.length <= 10000, "TRACE_SCHEMA", "expected at most 10000 catalog events");
  for (const item of value) {
    requireThat(item && typeof item === "object" && !Array.isArray(item), "TRACE_SCHEMA", "invalid event");
    const e = item as Record<string, unknown>;
    const fields: Record<string, string[]> = {
      tail: [],
      materialize: [],
      duplicate: [],
      "switch-scope": [],
      "late-old-scope": [],
      rename: ["id", "name"],
      status: ["id", "status"],
      remove: ["id"],
      "lagging-read": ["partial"],
    };
    requireThat(typeof e.type === "string" && Object.hasOwn(fields, e.type), "TRACE_SCHEMA", "unknown event");
    requireThat(
      Object.keys(e).every((key) => key === "type" || fields[e.type as string]!.includes(key)),
      "TRACE_SCHEMA",
      "unexpected event field",
    );
    if (["rename", "status", "remove"].includes(e.type as string))
      requireThat(ids.includes(e.id as Id), "TRACE_SCHEMA", "invalid identity");
    if (e.type === "rename")
      requireThat(typeof e.name === "string" && e.name.trim() && e.name.length <= 128, "TRACE_SCHEMA", "invalid name");
    if (e.type === "status")
      requireThat(["idle", "active", "systemError"].includes(e.status as string), "TRACE_SCHEMA", "invalid status");
    if (e.type === "lagging-read") requireThat(typeof e.partial === "boolean", "TRACE_SCHEMA", "invalid coverage");
  }
  return value as CatalogChaosEvent[];
}
