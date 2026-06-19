import type { WebBlock } from "../../adapters/toWebBlocks";

export type ActivityLabelBlock = Extract<WebBlock, { kind: "status" | "agent_work" }>;

export function activityAccessibleLabel(block: ActivityLabelBlock): string {
  if (block.kind === "status") return block.label;
  return joinLabelParts([block.title, nonDuplicateSummary(block.summary, block.title)]);
}

function nonDuplicateSummary(summary: string, title: string): string {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary || normalizedSummary === title.trim()) return "";
  return normalizedSummary;
}

function joinLabelParts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(": ");
}
