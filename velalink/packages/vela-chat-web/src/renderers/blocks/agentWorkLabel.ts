import type { WebBlock } from "../../adapters/toWebBlocks";

export type AgentWorkLabelBlock = Extract<
  WebBlock,
  { kind: "status" | "agent_work" | "agent_work_group" }
>;

export function agentWorkAccessibleLabel(block: AgentWorkLabelBlock): string {
  if (block.kind === "status") return block.label;
  return joinLabelParts([block.title, agentWorkVisualSummary(block.summary, block.title)]);
}

export function agentWorkVisualStatus(block: AgentWorkLabelBlock): string | undefined {
  if (block.kind === "agent_work" || block.kind === "agent_work_group") return block.status;
  if (block.status === "failed") return "failed";
  if (block.label.startsWith("处理失败：")) return "failed";
  return undefined;
}

export function agentWorkVisualSummary(summary: string, title: string): string {
  return nonDuplicateSummary(summary, title);
}

function nonDuplicateSummary(summary: string, title: string): string {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary || normalizedSummary === title.trim()) return "";
  return normalizedSummary;
}

function joinLabelParts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(": ");
}
