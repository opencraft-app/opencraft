import type { ChatSurfaceConversationDebug } from "../../../vela-chat-surface/src";
import { summarizeAgentWorkGroup } from "./summary";
import type { AgentWorkDisplay, AgentWorkRenderRow } from "./tools";

export interface AgentWorkGroupRenderRow {
  kind: "agent_work_group";
  id: string;
  key: string;
  title: string;
  summary: string;
  status: "completed";
  display: AgentWorkDisplay;
  children: AgentWorkRenderRow[];
  createdAt: string;
  updatedAt?: string;
  turnId?: string;
  agentWorkId?: string;
  debug: ChatSurfaceConversationDebug;
}

export type AgentWorkAnyRenderRow = AgentWorkRenderRow | AgentWorkGroupRenderRow;

export function groupAgentWorkRows(
  rows: readonly AgentWorkRenderRow[],
): AgentWorkAnyRenderRow[] {
  if (rows.length < 2 || rows.some((row) => !isGroupableAgentWork(row))) {
    return [...rows];
  }

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const summary = summarizeAgentWorkGroup(rows);
  const id = `agent_work_group:${first.turnId ?? "unscoped"}:${first.agentWorkId ?? first.id}-${last.agentWorkId ?? last.id}`;

  return [
    {
      kind: "agent_work_group",
      id,
      key: id,
      title: summary.title,
      summary: summary.summary,
      status: "completed",
      display: "compact",
      children: [...rows],
      createdAt: first.createdAt,
      updatedAt: newestTimestamp(rows),
      ...(first.turnId !== undefined ? { turnId: first.turnId } : {}),
      agentWorkId: first.agentWorkId,
      debug: mergeDebug(rows),
    },
  ];
}

export function isGroupableAgentWork(row: AgentWorkRenderRow): boolean {
  return row.status !== "running" && row.status !== "pending";
}

function newestTimestamp(rows: readonly AgentWorkRenderRow[]): string | undefined {
  return rows
    .map((row) => row.updatedAt ?? row.createdAt)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function mergeDebug(rows: readonly AgentWorkRenderRow[]): ChatSurfaceConversationDebug {
  const source_event_ids = rows.flatMap((row) => row.debug.source_event_ids);
  const source_event_ranges = rows.flatMap((row) => row.debug.source_event_ranges);
  return {
    projection: "conversation",
    source_event_ids: Array.from(new Set(source_event_ids)),
    source_event_ranges,
  };
}
