import { TASKS, type TaskDetail, type TaskEvent, type TasksRequestPort } from "@opencraft/appserver-protocol";
import { parseResearchHandoff, researchHandoff } from "./research-handoff";

export const AI_FOLLOW_UP_PREFIX = "AI_FOLLOW_UP_V1\n";
export const FOLLOW_UP_LANES = ["todo", "working", "needs", "review", "ready"] as const;
export type FollowUpLane = typeof FOLLOW_UP_LANES[number];
/** A recorded collaboration fact, not an execution command or a CI attestation. */
export interface FollowUpReport {
  readonly lane: FollowUpLane;
  readonly summary: string;
  readonly artifact: string;
  readonly phase?: string;
  readonly decision?: string;
  readonly roundId?: string;
  readonly judgeId?: string | null;
}
export interface FollowUpProjection {
  readonly lane: FollowUpLane;
  readonly report: FollowUpReport | null;
  readonly readyAt: number | null;
  /** Server-derived entry into the visible lane; independent of decision rounds. */
  readonly enteredAt: number | null;
  readonly decision: string | null;
  readonly updatedAt: number;
}
export function parseFollowUpReport(text: unknown): FollowUpReport | null {
  if (typeof text !== "string" || text.length > 4096 || !text.startsWith(AI_FOLLOW_UP_PREFIX)) return null;
  try {
    const v = JSON.parse(text.slice(AI_FOLLOW_UP_PREFIX.length));
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["lane", "summary", "artifact", "phase", "decision", "roundId", "judgeId"].includes(k))) return null;
    const nonempty = (s: unknown): s is string => typeof s === "string" && !!s.trim() && !s.includes("\0");
    if (!FOLLOW_UP_LANES.includes(v.lane) || !nonempty(v.summary) || !nonempty(v.artifact)) return null;
    for (const k of ["phase", "decision", "roundId"]) if (v[k] !== undefined && !nonempty(v[k])) return null;
    if (v.judgeId !== undefined && v.judgeId !== null && !nonempty(v.judgeId)) return null;
    if (v.lane === "needs" && (!nonempty(v.decision) || !nonempty(v.roundId))) return null;
    return v as FollowUpReport;
  } catch { return null; }
}
export function activeFollowUpTask(task: TaskDetail): boolean {
  return task.deletedAt === null && !task.archivedAt && task.status !== "done" && task.status !== "canceled";
}
export function followUpProjection(task: TaskDetail, events: readonly TaskEvent[] = []): FollowUpProjection {
  type Current = { report: FollowUpReport; at: number; readyAt: number | null };
  let current: Current | null = null;
  const readyTime = (previous: Current | null, report: FollowUpReport, at: number) => report.lane !== "needs" ? null
    : previous?.report.lane === "needs" && previous.report.roundId === report.roundId ? previous.readyAt : at;
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const initialStatus = ordered.find(e => e.type === "created")?.payload.status
    ?? ordered.find(e => e.type === "status_changed")?.payload.from ?? task.status;
  let status: unknown = initialStatus;
  let legacyAt: number | null = null, reviewAt: number | null = null;
  const compatibleStatus = (lane: FollowUpLane, value: unknown) => lane === "todo" ? value === "backlog" || value === "todo"
    : lane === "working" ? value === "in_progress" : value === "in_review";
  const laneNow = (): FollowUpLane => current && compatibleStatus(current.report.lane, status) ? current.report.lane
    : !current && status === "in_review" && legacyAt !== null && reviewAt !== null ? "needs"
    : status === "backlog" || status === "todo" ? "todo" : status === "in_review" ? "review" : "working";
  let lane = laneNow();
  let enteredAt = Number.isFinite(task.createdAt) ? task.createdAt : null;
  for (const event of ordered) {
    const boundary = ["created", "deleted", "restored"].includes(event.type);
    if (boundary || event.type === "status_changed") current = null;
    if (event.type === "created") status = event.payload.status ?? status;
    if (event.type === "status_changed") status = event.payload.to;
    if (boundary || event.type === "status_changed" && status !== "in_review") { legacyAt = null; reviewAt = null; }
    if ((event.type === "created" || event.type === "status_changed") && status === "in_review") reviewAt = event.createdAt;
    if (event.type === "progress") {
      if (parseResearchHandoff(event.payload.text) && legacyAt === null) legacyAt = event.createdAt;
      const report = parseFollowUpReport(event.payload.text);
      if (report) current = { report, at: event.createdAt, readyAt: readyTime(current, report, event.createdAt) };
    }
    const nextLane = laneNow();
    if (boundary || nextLane !== lane) enteredAt = event.createdAt;
    lane = nextLane;
  }
  const compatible = (lane: FollowUpLane) => lane === "todo" ? ["backlog", "todo"].includes(task.status)
    : lane === "working" ? task.status === "in_progress" : task.status === "in_review";
  if (current && compatible(current.report.lane)) return { lane: current.report.lane, report: current.report, enteredAt: lane === current.report.lane ? enteredAt : null, readyAt: current.readyAt, decision: current.report.decision ?? null, updatedAt: current.at };
  const legacy = !current && task.status === "in_review" ? researchHandoff(events) : null;
  return { lane: legacy ? "needs" : ["todo", "backlog"].includes(task.status) ? "todo" : task.status === "in_review" ? "review" : "working",
    enteredAt: lane === (legacy ? "needs" : ["todo", "backlog"].includes(task.status) ? "todo" : task.status === "in_review" ? "review" : "working") ? enteredAt : null,
    report: null, readyAt: legacy?.readyAt ?? null, decision: legacy?.decision ?? null,
    updatedAt: task.latestProgress?.createdAt ?? task.updatedAt };
}
/** Owner gates lane dwell, not decision judge/round. Product policy may set a fixed rollout floor. */
export function followUpDwellStart(task: TaskDetail, projection: FollowUpProjection, since = 0): number | null {
  return task.assigneeId && activeFollowUpTask(task) && ["todo", "needs", "ready"].includes(projection.lane)
    && projection.enteredAt !== null && Number.isFinite(projection.enteredAt) && Number.isFinite(since)
    ? Math.max(since, projection.enteredAt) : null;
}
/** Lifecycle reads are bounded. A truncated history never supplies a clock. */
export async function readFollowUpEvents(port: TasksRequestPort, taskId: string): Promise<readonly TaskEvent[]> {
  const events: TaskEvent[] = [];
  let beforeSeq: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await port.request(TASKS.events, { taskId, limit: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    events.push(...page.events);
    if (page.events.some(e => ["created", "deleted", "restored"].includes(e.type)) || page.nextBeforeSeq === null) return events;
    if (beforeSeq !== undefined && page.nextBeforeSeq >= beforeSeq) throw new Error("Invalid follow-up activity cursor");
    beforeSeq = page.nextBeforeSeq;
  }
  throw new Error("Follow-up activity is incomplete");
}
export function followUpTaskKey(task: TaskDetail): string {
  return JSON.stringify([task.id, task.revision, task.latestProgress?.eventId]);
}
