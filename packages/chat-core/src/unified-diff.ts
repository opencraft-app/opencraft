export type UnifiedDiffLineKind = "addition" | "deletion" | "context" | "hunk" | "meta" | "no-newline";

export interface UnifiedDiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

export interface UnifiedDiffLine {
  readonly key: string;
  readonly kind: UnifiedDiffLineKind;
  readonly text: string;
  readonly content: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly oldSegments: readonly UnifiedDiffSegment[] | null;
  readonly newSegments: readonly UnifiedDiffSegment[] | null;
}

export interface UnifiedDiffCollapsedLines {
  readonly key: string;
  readonly kind: "collapsed";
  readonly lines: readonly UnifiedDiffLine[];
}

export type UnifiedDiffRenderRow = UnifiedDiffLine | UnifiedDiffCollapsedLines;

function lineSegments(text: string, prefix: number, suffix: number): readonly UnifiedDiffSegment[] {
  const end = text.length - suffix;
  return [
    ...(prefix > 0 ? [{ text: text.slice(0, prefix), changed: false }] : []),
    ...(end > prefix ? [{ text: text.slice(prefix, end), changed: true }] : []),
    ...(suffix > 0 ? [{ text: text.slice(end), changed: false }] : []),
  ];
}

export function computeIntralineDiff(oldText: string, newText: string): {
  readonly oldSegments: readonly UnifiedDiffSegment[];
  readonly newSegments: readonly UnifiedDiffSegment[];
} {
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;
  return {
    oldSegments: lineSegments(oldText, prefix, suffix),
    newSegments: lineSegments(newText, prefix, suffix),
  };
}

function addIntralineSegments(lines: readonly UnifiedDiffLine[]): readonly UnifiedDiffLine[] {
  const result = [...lines];
  for (let index = 0; index < result.length;) {
    if (result[index]?.kind !== "deletion") { index += 1; continue; }
    const deletionStart = index;
    while (result[index]?.kind === "deletion") index += 1;
    const additionStart = index;
    while (result[index]?.kind === "addition") index += 1;
    const pairCount = Math.min(additionStart - deletionStart, index - additionStart);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const deletionIndex = deletionStart + pairIndex;
      const additionIndex = additionStart + pairIndex;
      const deletion = result[deletionIndex]!;
      const addition = result[additionIndex]!;
      const segments = computeIntralineDiff(deletion.content, addition.content);
      result[deletionIndex] = { ...deletion, oldSegments: segments.oldSegments };
      result[additionIndex] = { ...addition, newSegments: segments.newSegments };
    }
  }
  return result;
}

export function parseUnifiedDiff(diff: string): readonly UnifiedDiffLine[] {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  const consume = (old: boolean, next: boolean) => {
    if (!inHunk) return;
    if (old) { oldRemaining -= 1; oldLine! += 1; }
    if (next) { newRemaining -= 1; newLine! += 1; }
    if (oldRemaining <= 0 && newRemaining <= 0) {
      inHunk = false;
      oldLine = newLine = null;
    }
  };
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  const parsed = lines.map((text, index): UnifiedDiffLine => {
    if (text.startsWith("diff ")) {
      inHunk = false;
      oldLine = newLine = null;
    }
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u.exec(text);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      if (!inHunk) oldLine = newLine = null;
      return { key: String(index) + ":hunk", kind: "hunk", text, content: text, oldLine: null, newLine: null, oldSegments: null, newSegments: null };
    }
    if (text.startsWith("\\ No newline at end of file")) {
      return { key: String(index) + ":no-newline", kind: "no-newline", text, content: text, oldLine: null, newLine: null, oldSegments: null, newSegments: null };
    }
    // A prefix belongs to code while a hunk is open, even +++/---. File
    // headers and binary/rename/mode metadata outside a hunk own no line numbers.
    const isAddition = text.startsWith("+") && (inHunk || !text.startsWith("+++"));
    const isDeletion = text.startsWith("-") && (inHunk || !text.startsWith("---"));
    const isContext = inHunk && text.startsWith(" ");
    const isMeta = !isContext && !isAddition && !isDeletion;
    if (isMeta) {
      return { key: String(index) + ":meta", kind: "meta", text, content: text, oldLine: null, newLine: null, oldSegments: null, newSegments: null };
    }
    if (isAddition) {
      const line = { key: String(index) + ":addition", kind: "addition" as const, text, content: text.slice(1), oldLine: null, newLine, oldSegments: null, newSegments: null };
      consume(false, true);
      return line;
    }
    if (isDeletion) {
      const line = { key: String(index) + ":deletion", kind: "deletion" as const, text, content: text.slice(1), oldLine, newLine: null, oldSegments: null, newSegments: null };
      consume(true, false);
      return line;
    }
    const line = { key: String(index) + ":context", kind: "context" as const, text, content: text.startsWith(" ") ? text.slice(1) : text, oldLine, newLine, oldSegments: null, newSegments: null };
    consume(true, true);
    return line;
  });
  return addIntralineSegments(parsed);
}

/** Collapses only long unchanged runs; change rows and hunk boundaries stay stable. */
export function collapseUnifiedDiffContext(lines: readonly UnifiedDiffLine[], contextLines = 3, threshold = 10): readonly UnifiedDiffRenderRow[] {
  const rows: UnifiedDiffRenderRow[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index]?.kind !== "context") {
      rows.push(lines[index]!);
      index += 1;
      continue;
    }
    const start = index;
    while (lines[index]?.kind === "context") index += 1;
    const run = lines.slice(start, index);
    if (run.length <= threshold) {
      rows.push(...run);
      continue;
    }
    rows.push(...run.slice(0, contextLines));
    rows.push({ key: "collapsed:" + run[0]!.key + ":" + run.at(-1)!.key, kind: "collapsed", lines: run.slice(contextLines, -contextLines) });
    rows.push(...run.slice(-contextLines));
  }
  return rows;
}
