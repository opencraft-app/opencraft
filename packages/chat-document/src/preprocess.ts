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

function stripIncompleteReference(source: string): string {
  const start = source.indexOf("\uE200", source.lastIndexOf("\uE201") + 1);
  return start < 0 ? source : source.slice(0, start);
}

/** Only the final nonblank line can be an unfinished standalone image. */
function hideIncompleteImage(source: string): string {
  const end = source.trimEnd().length;
  const start = source.lastIndexOf("\n", end - 1) + 1;
  const line = source.slice(start, end).trimStart();
  if (!line.startsWith("![")) return source;
  const closingLabel = line.indexOf("]", 2);
  if (closingLabel >= 0) {
    const target = line.slice(closingLabel + 1);
    if (target !== "" && (!target.startsWith("(") || target.includes(")"))) return source;
  }
  return source.slice(0, start);
}

/** Scan once; failed bracket candidates must not rescan the remaining suffix. */
function hideIncompleteLinkTarget(source: string): string {
  const start = source.lastIndexOf("\n") + 1;
  const lastClosingTarget = source.lastIndexOf(")");
  let openingLabel = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "[" && openingLabel < 0) openingLabel = index;
    if (source[index] !== "]") continue;
    if (openingLabel >= 0 && index > openingLabel + 1 && source[index + 1] === "("
      && index + 2 < source.length && index > lastClosingTarget) {
      return source.slice(0, openingLabel) + source.slice(openingLabel + 1, index);
    }
    openingLabel = -1;
  }
  return source;
}

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


export function preprocessUserMessageMarkdown(source: string): string {
  const output: string[] = [];
  let list: UserMessageListKind = null;
  let fence: "```" | "~~~" | null = null;
  for (const line of source.split(/\r\n?|\n/u)) {
    let indentation = 0;
    while (line[indentation] === " " || line[indentation] === "\t") indentation += 1;
    const prefix = line.substring(indentation, indentation + 3);
    const marker = prefix === "```" || prefix === "~~~" ? prefix : null;
    if (fence !== null) {
      output.push(line);
      if (marker === fence) fence = null;
      continue;
    }
    const kind = userMessageListKind(line);
    const blank = line.length === 0;
    if (list !== null && !blank && indentation === 0 && kind !== list) output.push("");
    output.push(line);
    if (marker !== null) fence = marker;
    if (blank) {
      list = null;
    } else if (kind !== null) {
      list = kind;
    } else if (indentation === 0) {
      list = null;
    }
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
 * Streaming normalization preserves parser stability:
 * incomplete syntax is hidden or temporarily closed without changing the
 * canonical source stored by the session. Math normalization remains OpenCraft's
 * typed extension and is deliberately excluded from fenced source.
 */
export function preprocessChatMarkdown(
  source: string,
  options: PreprocessChatMarkdownOptions = {},
): PreprocessedChatMarkdown {
  let markdown = stripIncompleteReference(source);
  const openFence = locateOpenFence(markdown);
  if (options.streaming !== true || markdown.length === 0) return { markdown, openFence };

  // Marked accepts an EOF-terminated fence; appending a synthetic triple fence
  // corrupts longer delimiters and can turn code bytes into prose.
  if (openFence !== null) return { markdown, openFence };

  if (markdown.includes("`") && hasOddInlineBackticks(markdown)) {
    return { markdown, openFence: null };
  }
  if (markdown.includes("![")) markdown = hideIncompleteImage(markdown);
  if (markdown.includes("](")) markdown = hideIncompleteLinkTarget(markdown);
  markdown = closeOddDelimiter(markdown, "**");
  markdown = closeOddDelimiter(markdown, "*");
  return { markdown, openFence };
}
