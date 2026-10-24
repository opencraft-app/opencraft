/** Read-only snapshot; native conversation and identity owners remain authoritative. */
export type OverviewState = "running" | "waiting" | "completed" | "failed" | "interrupted" | "empty" | "unknown";
export interface OverviewConversation {
  hostId: string; id: string; title: string; project: string;
  createdAt: number; updatedAt: number; completedAt: number | null;
  archived: boolean; pinned: boolean | null; state: OverviewState;
  participants: readonly string[] | null; creator: string | null;
}
export interface OverviewSource {
  id: string; label: string; catalog: "complete" | "partial" | "error";
  pins: boolean; people: boolean; unknownTurns: number;
}
export interface ConversationOverviewSnapshot {
  asOf: number; conversations: readonly OverviewConversation[]; sources: readonly OverviewSource[];
}
export interface ConversationOverviewPort {
  read(sources: readonly { id: string; label: string }[], signal: AbortSignal, progress: (count: number) => void): Promise<ConversationOverviewSnapshot>;
}
export type OverviewPeriod = "today" | "7d" | "30d" | "90d" | "all" | "custom";
export function periodBounds(period: OverviewPeriod, now: number, from = "", to = ""): [number, number] {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const end = new Date(day); end.setDate(end.getDate() + 1);
  if (period === "custom") {
    const start = new Date(`${from}T00:00:00`), finish = new Date(`${to}T00:00:00`);
    finish.setDate(finish.getDate() + 1);
    return [start.getTime(), finish.getTime()];
  }
  if (period === "all") return [0, end.getTime()];
  day.setDate(day.getDate() - (period === "today" ? 0 : Number.parseInt(period) - 1));
  return [day.getTime(), end.getTime()];
}
export function projectOverview(rows: readonly OverviewConversation[], start: number, end: number) {
  const inside = (seconds: number | null) => seconds !== null && seconds * 1000 >= start && seconds * 1000 < end;
  const states = Object.fromEntries((["running", "waiting", "completed", "failed", "interrupted", "empty", "unknown"] as const).map(state => [state, rows.filter(row => row.state === state).length])) as Record<OverviewState, number>;
  const active = rows.filter(row => inside(row.updatedAt));
  const completed = rows.filter(row => row.state === "completed" && inside(row.completedAt));
  const people = new Map<string, { id: string; conversations: number; running: number; completed: number; pinned: number; created: number }>();
  for (const row of active) {
    for (const id of new Set(row.participants ?? [])) {
      const person = people.get(id) ?? { id, conversations: 0, running: 0, completed: 0, pinned: 0, created: 0 };
      person.conversations++; person.running += Number(row.state === "running" || row.state === "waiting");
      person.completed += Number(row.state === "completed"); person.pinned += Number(row.pinned === true);
      people.set(id, person);
    }
    if (row.creator) {
      const person = people.get(row.creator) ?? { id: row.creator, conversations: 0, running: 0, completed: 0, pinned: 0, created: 0 };
      person.created++; people.set(row.creator, person);
    }
  }
  const projects = new Map<string, { name: string; total: number; running: number; completed: number }>();
  for (const row of active) {
    const name = row.project || "—", key = JSON.stringify([row.hostId, name]);
    const item = projects.get(key) ?? { name, total: 0, running: 0, completed: 0 };
    item.total++; item.running += Number(row.state === "running" || row.state === "waiting"); item.completed += Number(row.state === "completed"); projects.set(key, item);
  }
  // Maximum 16 calendar buckets, including sparse dates and zero-count periods.
  const earliest = rows.reduce((value, row) => row.createdAt >= 0 ? Math.min(value, row.createdAt * 1000) : value, end);
  const first = new Date(start || earliest); first.setHours(0, 0, 0, 0);
  const days = Math.max(1, Math.ceil((end - first.getTime()) / 86400000));
  const step = Math.max(1, Math.ceil(days / 16));
  const trend: { start: number; end: number; created: number; completed: number }[] = [];
  for (let cursor = first.getTime(); cursor < end;) {
    const next = new Date(cursor); next.setDate(next.getDate() + step);
    const limit = Math.min(next.getTime(), end);
    trend.push({ start: cursor, end: limit,
      created: rows.filter(row => row.createdAt * 1000 >= cursor && row.createdAt * 1000 < limit).length,
      completed: completed.filter(row => row.completedAt! * 1000 >= cursor && row.completedAt! * 1000 < limit).length });
    cursor = limit;
  }
  return { states, active, completed: completed.length, created: rows.filter(row => inside(row.createdAt)).length,
    people: [...people.values()].sort((a, b) => b.conversations - a.conversations || a.id.localeCompare(b.id)),
    projects: [...projects.values()].sort((a, b) => b.total - a.total), trend,
    collaborative: active.filter(row => (row.participants?.length ?? 0) > 1).length,
    knownPeople: active.filter(row => row.participants !== null).length };
}
