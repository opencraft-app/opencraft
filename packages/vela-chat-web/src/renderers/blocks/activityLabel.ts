import type { WebBlock } from "../../adapters/toWebBlocks";

export type ActivityLabelBlock = Extract<WebBlock, { kind: "status" | "agent_work" }>;

export function activityAccessibleLabel(block: ActivityLabelBlock): string {
  if (block.kind === "status") return block.label;
  return joinLabelParts([block.title, activityVisualSummary(block.summary, block.title)]);
}

export function activityVisualStatus(block: ActivityLabelBlock): string | undefined {
  if (block.kind === "agent_work") return block.status;
  if (block.status === "failed") return "failed";
  if (block.label.startsWith("处理失败：")) return "failed";
  return undefined;
}

export function activityVisualSummary(summary: string, title: string): string {
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
