import { deriveSubagentActivityPresentation, type TimelineBlock, type TimelineSnapshot, type TodoEntry } from "@opencraft/chat-core";

export interface SummaryFile {
  readonly path: string;
  readonly kind: "add" | "modify" | "delete" | "unknown";
}
export interface SummaryActivity {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "running" | "complete" | "failed" | "interrupted" | "unknown";
  readonly threadId: string | null;
}
export interface ThreadSummary {
  readonly steps: readonly TodoEntry[];
  readonly files: readonly SummaryFile[];
  readonly activities: readonly SummaryActivity[];
  readonly hasHistory: boolean;
}

/** Read structured history only. Partial history is never described as exhaustive. */
export function deriveThreadSummary(timeline: TimelineSnapshot | null): ThreadSummary {
  let steps: readonly TodoEntry[] = [];
  const files = new Map<string, SummaryFile>();
  const activities = new Map<string, SummaryActivity>();
  const consume = (block: TimelineBlock) => {
    if (block.type === "todo") steps = block.entries;
    if (block.type === "patch") {
      for (const change of block.changes) {
        const path = change.movePath ?? change.path;
        if (change.movePath) files.delete(change.path);
        files.set(path, { path, kind: change.kind });
      }
    }
    if (block.type === "turn-diff") {
      for (const file of block.files) if (!files.has(file.path)) files.set(file.path, { path: file.path, kind: "unknown" });
    }
    if (block.type === "command-execution") {
      if (block.status === "running" || block.status === "pending") {
        activities.set(block.id, { id: block.id, label: block.command, status: block.status, threadId: null });
      } else activities.delete(block.id);
    }
    if (block.type === "subagent") {
      const states = block.agentStates !== null && typeof block.agentStates === "object" ? block.agentStates as Record<string, unknown> : {};
      for (const agent of deriveSubagentActivityPresentation(block).agents) {
        // Presentation-only fallback IDs are not navigable conversations.
        if (!block.receiverThreadIds.includes(agent.threadId) && block.agentId !== agent.threadId && !(agent.threadId in states)) continue;
        const state = states[agent.threadId];
        const status = typeof state === "object" && state !== null ? (state as Record<string, unknown>).status : null;
        const known = status === "running" ? "running" : status === "pendingInit" ? "pending"
          : status === "completed" || status === "shutdown" ? "complete"
          : status === "errored" || status === "notFound" || status === "failed" ? "failed"
          : status === "interrupted" || block.activityKind === "interrupted" ? "interrupted" : "unknown";
        activities.set(`agent:${agent.threadId}`, { id: `agent:${agent.threadId}`, label: agent.displayName,
          status: known, threadId: agent.threadId });
      }
    }
  };
  for (const frame of timeline?.frames ?? []) {
    for (const block of frame.blocks) consume(block);
    if (frame.changeSummary) consume(frame.changeSummary);
  }
  return { steps, files: [...files.values()], activities: [...activities.values()], hasHistory: (timeline?.frames.length ?? 0) > 0 };
}
