import type { WebBlock } from "../../adapters/toWebBlocks";

export type ActivityLabelBlock = Extract<WebBlock, { kind: "status" | "agent_work" }>;

export function activityAccessibleLabel(block: ActivityLabelBlock): string {
  if (block.kind === "status") return block.label;
  return joinLabelParts([block.title, nonDuplicateSummary(block.summary, block.title)]);
}

export function activityVisualStatus(block: ActivityLabelBlock): string | undefined {
  if (block.kind === "agent_work") return block.status;
  if (block.label.startsWith("处理失败：")) return "failed";
  return undefined;
}

function nonDuplicateSummary(summary: string, title: string): string {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary || normalizedSummary === title.trim()) return "";
  return normalizedSummary;
}

function joinLabelParts(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(": ");
}
