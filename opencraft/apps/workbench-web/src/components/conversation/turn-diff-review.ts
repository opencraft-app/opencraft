import { summarizeTurnDiff } from "@opencraft/chat-core";

/** Select one file's existing unified diff without changing the Turn model. */
export function reviewDiffForFile(unifiedDiff: string, path: string | null): string {
  if (path === null) return unifiedDiff;
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
  const selected = chunks.filter((chunk) => summarizeTurnDiff(chunk).files.some((file) => file.path === path));
  return selected.length > 0 ? selected.join("\n") : unifiedDiff;
}
