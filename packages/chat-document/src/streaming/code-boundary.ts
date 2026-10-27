/** Marked owns container boundaries. Blank lines alone cannot close a list,
 * quote or indented code block. Always retain the final non-space block.
 * Callers must separately exclude document-global reference dependencies.
 */
export function findStableMarkdownPrefix(tokens: readonly Record<string, unknown>[]): {
  readonly tokenCount: number;
  readonly sourceEnd: number;
} {
  let tokenCount = tokens.length;
  while (tokenCount > 0 && tokens[tokenCount - 1]?.type === "space") tokenCount -= 1;
  tokenCount = Math.max(0, tokenCount - 1);
  // A partial following block (e.g. "2" becoming "2. ") can rejoin a
  // preceding list/quote/code container. Keep that container until another
  // independent block separates it from the live tail.
  while (tokenCount > 0 && ["space", "list", "blockquote", "code", "table", "html"]
    .includes(String(tokens[tokenCount - 1]?.type))) tokenCount -= 1;
  let sourceEnd = 0;
  for (let index = 0; index < tokenCount; index++) {
    const raw = tokens[index]?.raw;
    if (typeof raw !== "string") return { tokenCount: 0, sourceEnd: 0 };
    sourceEnd += raw.length;
  }
  return { tokenCount, sourceEnd };
}
