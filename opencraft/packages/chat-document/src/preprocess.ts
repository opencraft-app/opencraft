export interface OpenCodeFence {
  readonly start: number;
  readonly marker: "```" | "~~~";
  readonly language: string | null;
  readonly delimiterLength: number;
}

export interface PreprocessedChatMarkdown {
  readonly markdown: string;
  readonly openFence: OpenCodeFence | null;
}

export interface PreprocessChatMarkdownOptions {
  readonly streaming?: boolean;
}

export type ChatDocumentDialect = "assistant" | "user-message";

const incompleteReferenceSuffix = /\uE200[^\uE201]*$/u;
const incompleteImageLine = /(^|\n)[^\S\n]*!\[[^\]\n]*(?:\](?:\([^\)\n]*)?)?\s*$/u;
const incompleteLinkTarget = /\[([^\]\n]+)\]\(([^\)\n]+)$/u;

function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function countUnescaped(text: string, delimiter: string): number {
  let count = 0;
  for (let cursor = 0; cursor <= text.length - delimiter.length;) {
    if (text.startsWith(delimiter, cursor) && !isEscaped(text, cursor)) {
      count += 1;
      cursor += delimiter.length;
    } else {
      cursor += 1;
    }
  }
  return count;
}

function lastUnescapedIndex(text: string, delimiter: string): number {
  for (let cursor = text.length - delimiter.length; cursor >= 0; cursor -= 1) {
    if (text.startsWith(delimiter, cursor) && !isEscaped(text, cursor)) return cursor;
  }
  return -1;
}

/** Codex ignores inline backticks that belong to complete or open fenced blocks. */
function hasOddInlineBackticks(text: string): boolean {
  let count = 0;
  for (let cursor = 0; cursor < text.length;) {
    if (text.startsWith("```", cursor) && !isEscaped(text, cursor)) {
      cursor += 3;
      while (cursor < text.length && !text.startsWith("```", cursor)) cursor += 1;
      if (cursor < text.length) cursor += 3;
      continue;
    }
    if (text[cursor] === "`" && !isEscaped(text, cursor)) count += 1;
    cursor += 1;
  }
  return count % 2 === 1;
}

function locateOpenFence(source: string): OpenCodeFence | null {
  const lines = source.split(/(?<=\n)/u);
  let offset = 0;
  let open: OpenCodeFence | null = null;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\n\r]*)/u.exec(line);
    if (match !== null && !isEscaped(line, match.index)) {
      const marker = match[1]?.startsWith("~") ? "~~~" : "```";
      if (open === null) {
        const info = match[2]?.trim() ?? "";
        if (marker === "```" && info.includes("`")) { offset += line.length; continue; }
        open = {
          start: offset,
          marker,
          language: info.length === 0 ? null : info.split(/\s+/u, 1)[0] ?? null,
          delimiterLength: match[1]?.length ?? 3,
        };
      } else if (open.marker === marker && (match[1]?.length ?? 0) >= open.delimiterLength
        && /^[ \t]*$/u.test(match[2] ?? "")) {
        open = null;
      }
    }
    offset += line.length;
  }
  return open;
}

const userMessageBullet = /^[-+*][ \t]+/u;
const userMessageOrdered = /^\d+\.[ \t]+/u;
const userMessageFence = /^([ \t]*)(`{3,}|~{3,})/u;

type UserMessageListKind = "bullet" | "ordered" | null;

function userMessageListKind(line: string): UserMessageListKind {
  if (userMessageBullet.test(line)) return "bullet";
  if (userMessageOrdered.test(line)) return "ordered";
  return null;
}

/**
 * Source-equivalent block normalization from Codex's UserFormattedText.
 *
 * Composer text is a distinct Markdown dialect. In particular, an adjacent
 * paragraph after a list must not be swallowed into the final list item, and
 * a switch between bullet/ordered lists starts a new block. Fenced source is
 * copied byte-for-byte and never participates in this normalization.
 */
export function preprocessUserMessageMarkdown(source: string): string {
  const output: string[] = [];
  let previousListKind: UserMessageListKind = null;
  let fenceMarker: "`" | "~" | null = null;
  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const fence = userMessageFence.exec(line);
    if (fenceMarker !== null) {
      output.push(line);
      if (fence?.[2]?.startsWith(fenceMarker) === true) fenceMarker = null;
      continue;
    }
    if (fence !== null) {
      if (previousListKind !== null && (fence[1]?.length ?? 0) === 0) {
        output.push("");
        previousListKind = null;
      }
      fenceMarker = fence[2]?.[0] === "~" ? "~" : "`";
      output.push(line);
      continue;
    }
    const nextListKind = userMessageListKind(line);
    if (previousListKind !== null) {
      if (/^[ \t]+/u.test(line)) {
        output.push(line);
        continue;
      }
      if (line.length === 0) {
        previousListKind = null;
        output.push(line);
        continue;
      }
      if (nextListKind !== previousListKind) output.push("");
    }
    previousListKind = nextListKind;
    output.push(line);
  }
  return output.join("\n");
}

function closeOddDelimiter(text: string, delimiter: "**" | "*"): string {
  if (!text.includes(delimiter) || countUnescaped(text, delimiter) % 2 === 0) return text;
  const delimiterIndex = lastUnescapedIndex(text, delimiter);
  if (delimiterIndex < 0) return text;
  const suffix = text.slice(delimiterIndex + delimiter.length);
  if (
    suffix.length === 0
    || /^\s/u.test(suffix)
    || suffix.includes("\n")
    || hasOddInlineBackticks(suffix)
  ) return text;
  return `${text}${delimiter}`;
}

/**
 * Streaming normalization follows Codex r1381's parser-stability contract:
 * incomplete syntax is hidden or temporarily closed without changing the
 * canonical source stored by the session. Math normalization remains OpenCraft's
 * typed extension and is deliberately excluded from fenced source.
 */
export function preprocessChatMarkdown(
  source: string,
  options: PreprocessChatMarkdownOptions = {},
): PreprocessedChatMarkdown {
  let markdown = source.replace(incompleteReferenceSuffix, "");
  const openFence = locateOpenFence(markdown);
  if (options.streaming !== true || markdown.length === 0) return { markdown, openFence };

  // Marked accepts an EOF-terminated fence; appending a synthetic triple fence
  // corrupts longer delimiters and can turn code bytes into prose.
  if (openFence !== null) return { markdown, openFence };

  if (markdown.includes("`") && hasOddInlineBackticks(markdown)) {
    return { markdown, openFence: null };
  }
  if (markdown.includes("![")) markdown = markdown.replace(incompleteImageLine, "$1");
  if (markdown.includes("](")) markdown = markdown.replace(incompleteLinkTarget, "$1");
  markdown = closeOddDelimiter(markdown, "**");
  markdown = closeOddDelimiter(markdown, "*");
  return { markdown, openFence };
}
