import type { SubagentTimelineBlock, TimelineExecutionStatus } from "./timeline";

export type SubagentTaskStatus = "waiting" | "working" | "done" | "failed";
export type SubagentDisplayStatus = "active" | "updated" | "interrupted" | "done";

export interface SubagentActivityAgent {
  readonly threadId: string;
  readonly displayName: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly status: SubagentTaskStatus;
  readonly statusLabel: string;
  readonly statusMessage: string | null;
  readonly displayStatus: SubagentDisplayStatus;
}

export interface SubagentActivityPresentation {
  readonly agents: readonly SubagentActivityAgent[];
  readonly actionLabel: string;
  readonly groupStatusLabel: "started working" | "updated" | "interrupted" | "finished" | "failed";
  readonly expandable: boolean;
}

export interface SubagentActivityGroupPresentation extends SubagentActivityPresentation {
  readonly blocks: readonly SubagentTimelineBlock[];
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nameFromPath(path: string | null): string | null {
  if (path === null) return null;
  const parts = path.split(/[\\/]/u).filter(Boolean);
  const value = parts.at(-1)?.replace(/[-_]+/gu, " ").trim() ?? "";
  return value.length === 0 ? null : value;
}

export function mapSubagentTaskStatus(value: unknown): SubagentTaskStatus {
  if (value === "pendingInit") return "waiting";
  if (value === "running") return "working";
  if (value === "errored" || value === "notFound" || value === "failed") return "failed";
  return "done";
}

export function subagentTaskStatusLabel(value: unknown): string {
  if (value === "pendingInit") return "pending init";
  if (value === "running") return "running";
  if (value === "interrupted") return "interrupted";
  if (value === "shutdown") return "shutdown";
  if (value === "completed") return "completed";
  if (value === "errored") return "errored";
  if (value === "notFound") return "not found";
  if (value === "failed") return "failed";
  return "completed";
}

function actionLabel(tool: SubagentTimelineBlock["tool"], status: TimelineExecutionStatus): string {
  const running = status === "pending" || status === "running";
  const failed = status === "failed";
  switch (tool) {
    case "spawnAgent": return failed ? "Failed to create" : running ? "Creating" : "Created";
    case "sendInput": return failed ? "Failed to message" : running ? "Messaging" : "Messaged";
    case "resumeAgent": return failed ? "Failed to resume" : running ? "Resuming" : "Resumed";
    case "closeAgent": return failed ? "Failed to close" : running ? "Closing" : "Closed";
    case "wait": return failed ? "Failed waiting for" : running ? "Waiting for" : "Finished waiting for";
    case null: return running ? "Working with" : failed ? "Failed working with" : "Worked with";
  }
}

function uniqueThreadIds(block: SubagentTimelineBlock, states: Readonly<Record<string, unknown>>): readonly string[] {
  const ids: string[] = [];
  const add = (value: string | null) => {
    if (value !== null && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const id of block.receiverThreadIds) add(id);
  add(block.agentId);
  for (const id of Object.keys(states)) add(id);
  if (ids.length === 0) add(block.id);
  return ids;
}

function displayStatusFor(block: SubagentTimelineBlock, status: SubagentTaskStatus): SubagentDisplayStatus {
  if (block.activityKind === "interrupted" || block.status === "interrupted") return "interrupted";
  if (block.activityKind === "interacted") return "updated";
  if (block.activityKind === "started") return "active";
  return status === "waiting" || status === "working" ? "active" : "done";
}

/** Renderer-neutral projection of Codex collaboration calls and task states. */
export function deriveSubagentActivityPresentation(block: SubagentTimelineBlock): SubagentActivityPresentation {
  const states = record(block.agentStates) ?? {};
  const pathName = nameFromPath(block.agentPath);
  const agents = uniqueThreadIds(block, states).map((threadId): SubagentActivityAgent => {
    const source = record(states[threadId]);
    const rawStatus = source?.status ?? (block.status === "running" || block.status === "pending" ? "running"
      : block.status === "failed" ? "errored"
      : block.status === "interrupted" ? "interrupted"
      : "completed");
    const status = mapSubagentTaskStatus(rawStatus);
    const defaultName = block.label !== "Agent" ? block.label : pathName;
    return {
      threadId,
      displayName: text(source?.displayName) ?? text(source?.agentName) ?? text(source?.name) ?? defaultName ?? "Agent",
      role: text(source?.role),
      model: text(source?.model) ?? block.model,
      status,
      statusLabel: subagentTaskStatusLabel(rawStatus),
      statusMessage: text(source?.message),
      displayStatus: displayStatusFor(block, status),
    };
  });
  const displayStatuses = agents.map((agent) => agent.displayStatus);
  const taskStatuses = agents.map((agent) => agent.status);
  const groupStatusLabel = displayStatuses.some((status) => status === "interrupted") ? "interrupted"
    : displayStatuses.some((status) => status === "updated") ? "updated"
    : taskStatuses.some((status) => status === "failed") ? "failed"
    : taskStatuses.length > 0 && taskStatuses.every((status) => status === "done") ? "finished"
    : "started working";
  return {
    agents,
    actionLabel: actionLabel(block.tool, block.status),
    groupStatusLabel,
    expandable: Boolean(block.prompt || block.action || block.model || block.reasoningEffort || block.agentPath || agents.some((agent) => agent.statusMessage)),
  };
}

/**
 * Codex replaces a consecutive run of collaboration messages with one
 * aggregate activity item at the run's final position. Agent identity is
 * stable across create/message/wait/close updates; the newest state wins.
 */
export function deriveSubagentActivityGroupPresentation(
  blocks: readonly SubagentTimelineBlock[],
): SubagentActivityGroupPresentation {
  const agentsByThreadId = new Map<string, SubagentActivityAgent>();
  let action = "Worked with";
  let expandable = false;
  for (const block of blocks) {
    const presentation = deriveSubagentActivityPresentation(block);
    action = presentation.actionLabel;
    expandable ||= presentation.expandable;
    for (const agent of presentation.agents) {
      const previous = agentsByThreadId.get(agent.threadId);
      agentsByThreadId.set(agent.threadId, {
        ...previous,
        ...agent,
        displayName: agent.displayName === "Agent" && previous !== undefined
          ? previous.displayName
          : agent.displayName,
        model: agent.model ?? previous?.model ?? null,
        role: agent.role ?? previous?.role ?? null,
        statusMessage: agent.statusMessage ?? (agent.status === "working" || agent.status === "waiting" ? null : previous?.statusMessage ?? null),
      });
    }
    if (block.tool === "wait" && block.status === "complete") {
      for (const [threadId, agent] of agentsByThreadId) {
        if (agent.status === "working" || agent.status === "waiting") {
          agentsByThreadId.set(threadId, {
            ...agent,
            displayStatus: "done",
            status: "done",
            statusLabel: "completed",
          });
        }
      }
    }
  }
  const agents = [...agentsByThreadId.values()];
  const displayStatuses = agents.map((agent) => agent.displayStatus);
  const taskStatuses = agents.map((agent) => agent.status);
  const groupStatusLabel = displayStatuses.some((status) => status === "interrupted") ? "interrupted"
    : displayStatuses.some((status) => status === "updated") ? "updated"
    : taskStatuses.some((status) => status === "failed") ? "failed"
    : taskStatuses.length > 0 && taskStatuses.every((status) => status === "done") ? "finished"
    : "started working";
  return { blocks, agents, actionLabel: action, groupStatusLabel, expandable };
}

export function subagentInlineStatusLabel(agent: SubagentActivityAgent): string {
  if (agent.displayStatus === "active") return agent.displayName + " started working";
  if (agent.displayStatus === "updated") return agent.displayName + " updated";
  if (agent.displayStatus === "interrupted") return agent.displayName + " interrupted";
  return agent.displayName + " finished";
}
