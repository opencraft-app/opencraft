import { indexTurnDiffFiles, type HookStats, type TurnDiffTimelineBlock } from "@opencraft/chat-core";

/** Turn resources are not ordered messages. Cache their visible shape, never
 * executable payloads, Hook output text or full unified-diff bodies. */
export interface ConversationDisplayResources {
  readonly hookStats: HookStats | null;
  readonly changeSummary: TurnDiffTimelineBlock | null;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function hookIndicator(value: unknown): HookStats | null {
  const hook = object(value);
  if (!hook || !count(hook.count) || !count(hook.blockedCount) || !count(hook.errorCount)) return null;
  return {
    contentAvailable: false,
    count: hook.count,
    blockedCount: hook.blockedCount,
    errorCount: hook.errorCount,
    blockedMessages: [],
    blockedSources: [],
    entries: [],
    feedbackMessages: [],
    runs: [],
  };
}

function diffSummary(value: unknown, project: boolean): TurnDiffTimelineBlock | null {
  const diff = object(value);
  if (
    !diff ||
    diff.type !== "turn-diff" ||
    typeof diff.id !== "string" ||
    diff.id.length > 512 ||
    !["complete", "failed", "interrupted"].includes(String(diff.status)) ||
    !count(diff.additions) ||
    !count(diff.deletions) ||
    !Array.isArray(diff.files)
  )
    return null;
  const files: TurnDiffTimelineBlock["files"][number][] = [];
  const unifiedDiff = project && typeof diff.unifiedDiff === "string" ? diff.unifiedDiff : "";
  const byPath = project ? indexTurnDiffFiles(unifiedDiff) : new Map<string, string>();
  for (const candidate of diff.files) {
    const file = object(candidate);
    if (!file || typeof file.path !== "string" || !count(file.additions) || !count(file.deletions)) return null;
    const lines = project
      ? (byPath.get(file.path) ?? unifiedDiff).split("\n").length
      : count(file.inlinePreviewLineCount)
        ? file.inlinePreviewLineCount
        : 0;
    files.push({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      inlinePreviewLineCount: lines,
    });
  }
  return {
    type: "turn-diff",
    id: diff.id,
    sourceItemIds: [],
    status: diff.status as TurnDiffTimelineBlock["status"],
    contentAvailable: false,
    ...(diff.statsAvailable === false ? { statsAvailable: false } : {}),
    unifiedDiff: "",
    files,
    additions: diff.additions,
    deletions: diff.deletions,
  };
}

/** The same narrow allowlist is applied to observed and persisted metadata. */
export function displayResources(value: unknown, project = false): ConversationDisplayResources | undefined {
  const resources = object(value);
  if (!resources) return undefined;
  const hookStats = hookIndicator(resources.hookStats),
    changeSummary = diffSummary(resources.changeSummary, project);
  return hookStats === null && changeSummary === null ? undefined : { hookStats, changeSummary };
}
