import { TASKS, type TaskDetail, type TaskEvent, type TasksRequestPort } from "@opencraft/appserver-protocol";

/** Explicit report envelope carried by the existing durable progress authority. */
export const RESEARCH_HANDOFF_PREFIX = "AI_RESEARCH_HANDOFF_V1\n";
export const HUMAN_WAIT_THRESHOLD_MS = 72 * 60 * 60 * 1000;
export interface ResearchHandoff {
  readonly output: string;
  readonly decision: string;
  readonly nextStep: string;
}
export interface ReadyResearchHandoff extends ResearchHandoff {
  readonly eventId: string;
  readonly readyAt: number;
}
export function parseResearchHandoff(text: unknown): ResearchHandoff | null {
  if (typeof text !== "string" || !text.startsWith(RESEARCH_HANDOFF_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(text.slice(RESEARCH_HANDOFF_PREFIX.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    if (Object.keys(fields).some(key => !["output", "decision", "nextStep"].includes(key))) return null;
    if (![fields.output, fields.decision, fields.nextStep].every(field => typeof field === "string" && field.trim().length > 0 && !field.includes("\0"))) return null;
    return { output: String(fields.output).trim(), decision: String(fields.decision).trim(), nextStep: String(fields.nextStep).trim() };
  } catch { return null; }
}

/** Only the current review cycle counts. Ordinary edits/reports never reset it. */
export function researchHandoff(events: readonly TaskEvent[]): ReadyResearchHandoff | null {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let handoff: ReadyResearchHandoff | null = null;
  let reviewAt: number | null = null;
  for (const event of ordered) {
    if (event.type === "deleted" || event.type === "restored" ||
      (event.type === "status_changed" && event.payload.to !== "in_review")) {
      handoff = null; reviewAt = null;
    }
    if ((event.type === "created" && event.payload.status === "in_review") ||
      (event.type === "status_changed" && event.payload.to === "in_review")) reviewAt = event.createdAt;
    if (event.type === "progress") {
      const report = parseResearchHandoff(event.payload.text);
      if (report && !handoff) handoff = { ...report, eventId: event.eventId, readyAt: event.createdAt };
    }
  }
  return handoff && reviewAt !== null ? { ...handoff, readyAt: Math.max(handoff.readyAt, reviewAt) } : null;
}

export async function readResearchHandoff(port: TasksRequestPort, taskId: string): Promise<ReadyResearchHandoff | null> {
  const events: TaskEvent[] = [];
  let beforeSeq: number | undefined;
  // Bounded history read. Stop at the current cycle's boundary, never guess on truncation.
  for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
    const page = await port.request(TASKS.events, { taskId, limit: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) });
    events.push(...page.events);
    const boundary = page.events.some(event => event.type === "created" || event.type === "deleted" || event.type === "restored" || (event.type === "status_changed" && event.payload.to !== "in_review"));
    if (boundary || page.nextBeforeSeq === null) return researchHandoff(events);
    if (beforeSeq !== undefined && page.nextBeforeSeq >= beforeSeq) throw new Error("Invalid task activity cursor");
    beforeSeq = page.nextBeforeSeq;
  }
  throw new Error("Research handoff history is incomplete");
}

export function isMorningResearchTask(task: TaskDetail): boolean {
  return task.deletedAt === null && !task.archivedAt && task.status !== "done" && task.status !== "canceled" &&
    (task.aiResearch === "proactive" || (task.aiResearch === "needs_decision" && task.status === "in_review"));
}
export function isOverdueHandoff(handoff: ReadyResearchHandoff, now: number): boolean {
  return Number.isFinite(handoff.readyAt) && now - handoff.readyAt > HUMAN_WAIT_THRESHOLD_MS;
}
