import { indexTurnDiffFiles } from "@opencraft/chat-core";

/** Select one file's existing unified diff without changing the Turn model. */
export function reviewDiffForFile(unifiedDiff: string, path: string | null): string {
  if (path === null) return unifiedDiff;
  return indexReviewFileDiffs(unifiedDiff).get(path) ?? unifiedDiff;
}

export const indexReviewFileDiffs = indexTurnDiffFiles;
