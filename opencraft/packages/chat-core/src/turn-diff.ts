import type { TimelineStatus, TurnDiffFileSummary, TurnDiffTimelineBlock } from "./timeline";

/** Resource identity belongs to the Turn, never to an invented protocol Item. */
export function createTurnChangeSummary(
  turnId: string, status: TimelineStatus, unifiedDiff: string | null,
): TurnDiffTimelineBlock | null {
  if (unifiedDiff === null || unifiedDiff.trim().length === 0) return null;
  return {
    type: "turn-diff", id: `${turnId}:turn-diff`, sourceItemIds: [], unifiedDiff,
    ...summarizeTurnDiff(unifiedDiff),
    status: status === "streaming" || status === "pending" ? "running"
      : status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "complete",
  };
}

export interface TurnDiffSummary {
  readonly files: readonly TurnDiffFileSummary[];
  readonly additions: number;
  readonly deletions: number;
}

function normalizeDiffPath(value: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\([\\"])/gu, "$1")
    : value;
  if (unquoted === "/dev/null") return unquoted;
  return unquoted.replace(/^[ab]\//u, "");
}

function diffHeaderPath(line: string): string | null {
  const match = /^diff --git\s+("(?:\\.|[^"])+"|\S+)\s+("(?:\\.|[^"])+"|\S+)$/u.exec(line);
  if (match === null) return null;
  const next = normalizeDiffPath(match[2]!);
  return next === "/dev/null" ? normalizeDiffPath(match[1]!) : next;
}

/** Source-equivalent aggregate used by Codex's TurnDiff card and live chip. */
export function summarizeTurnDiff(unifiedDiff: string): TurnDiffSummary {
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  let current: { path: string; additions: number; deletions: number } | null = null;
  const commit = () => {
    if (current === null) return;
    const previous = files.get(current.path);
    if (previous === undefined) files.set(current.path, current);
    else {
      previous.additions += current.additions;
      previous.deletions += current.deletions;
    }
  };

  for (const line of unifiedDiff.replace(/\r\n?/gu, "\n").split("\n")) {
    const path = diffHeaderPath(line);
    if (path !== null) {
      commit();
      current = { path, additions: 0, deletions: 0 };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("rename to ")) current.path = normalizeDiffPath(line.slice("rename to ".length));
    else if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }
  commit();

  const entries = [...files.values()];
  return {
    files: entries,
    additions: entries.reduce((sum, file) => sum + file.additions, 0),
    deletions: entries.reduce((sum, file) => sum + file.deletions, 0),
  };
}
