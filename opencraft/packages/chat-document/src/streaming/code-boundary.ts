/**
 * Finds a prefix whose block structure cannot be changed by appended stream
 * text. The unstable tail always retains at least the final Markdown block.
 */
export function findStableMarkdownPrefix(source: string, openFenceStart: number | null): number {
  const searchEnd = openFenceStart ?? source.length;
  if (searchEnd <= 0) return 0;

  let inFence: "`" | "~" | null = null;
  let lastBlankBoundary = 0;
  let offset = 0;
  for (const line of source.slice(0, searchEnd).split(/(?<=\n)/)) {
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      const kind = fence[1]?.[0] === "~" ? "~" : "`";
      inFence = inFence === null ? kind : inFence === kind ? null : inFence;
    } else if (inFence === null && /^\s*$/.test(line)) {
      lastBlankBoundary = offset + line.length;
    }
    offset += line.length;
  }
  return Math.min(lastBlankBoundary, searchEnd);
}
