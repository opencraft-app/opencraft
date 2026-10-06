import { summarizeTurnDiff } from "@opencraft/chat-core";

/** Select one file's existing unified diff without changing the Turn model. */
export function reviewDiffForFile(unifiedDiff: string, path: string | null): string {
  if (path === null) return unifiedDiff;
  return indexReviewFileDiffs(unifiedDiff).get(path) ?? unifiedDiff;
}

/** One pass per resource revision, rather than reparsing the full Turn per row. */
export function indexReviewFileDiffs(unifiedDiff: string): ReadonlyMap<string, string> {
  const lines = unifiedDiff.replace(/\r\n?/gu, "\n").split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0) chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  const byPath = new Map<string, string[]>();
  for (const chunk of chunks) for (const file of summarizeTurnDiff(chunk).files) {
    const entries = byPath.get(file.path) ?? [];
    entries.push(chunk);
    byPath.set(file.path, entries);
  }
  return new Map([...byPath].map(([path, entries]) => [path, entries.join("\n")]));
}
