export interface StreamingMarkdownRepairResult {
  markdown: string;
  isCodeFenceOpen: boolean;
}

const PARTIAL_IMAGE_PATTERN = /!\[[^\]\n]*(?:\](?:\([^)\n]*)?)?\s*$/;
const PARTIAL_LINK_PATTERN = /\[((?:\\.|[^\]\n])+)\]\(((?:\\.|[^)\n])+)\s*$/;
const TRAILING_PRIVATE_STREAM_MARKER_PATTERN = /\uE200[^\uE201]*$/;

export function repairStreamingMarkdown(markdown: string): StreamingMarkdownRepairResult {
  let repaired = markdown.replace(TRAILING_PRIVATE_STREAM_MARKER_PATTERN, "");

  if (hasUnclosedInlineCode(repaired)) {
    return { markdown: repaired, isCodeFenceOpen: false };
  }

  if (hasOpenCodeFence(repaired)) {
    return {
      markdown: closeCodeFenceForParsing(repaired),
      isCodeFenceOpen: true,
    };
  }

  repaired = suppressPartialImage(repaired);
  repaired = repairPartialLink(repaired);
  repaired = balanceTrailingEmphasis(repaired, "**");
  repaired = balanceTrailingEmphasis(repaired, "*");

  return { markdown: repaired, isCodeFenceOpen: false };
}

function closeCodeFenceForParsing(markdown: string) {
  return markdown.endsWith("\n") ? `${markdown}\`\`\`` : `${markdown}\n\`\`\``;
}

function suppressPartialImage(markdown: string) {
  return markdown.replace(PARTIAL_IMAGE_PATTERN, "");
}

function repairPartialLink(markdown: string) {
  const match = markdown.match(PARTIAL_LINK_PATTERN);
  if (!match) return markdown;

  const [raw, label = "", href = ""] = match;
  const prefix = markdown.slice(0, markdown.length - raw.length);
  if (isSafeCompleteLinkHref(href)) return `${prefix}[${label}]`;
  return `${markdown})`;
}

function isSafeCompleteLinkHref(href: string) {
  if (href.length === 0 || /\s/.test(href)) return false;
  return /^(https?:\/\/|mailto:|file:\/\/|\/|\.{1,2}\/|#)/i.test(href);
}

function balanceTrailingEmphasis(markdown: string, marker: "*" | "**") {
  if (!markdown.includes(marker)) return markdown;
  if (countUnescapedOccurrences(markdown, marker) % 2 === 0) return markdown;

  const lastMarkerIndex = findLastUnescapedOccurrence(markdown, marker);
  if (lastMarkerIndex < 0) return markdown;

  const trailing = markdown.slice(lastMarkerIndex + marker.length);
  if (
    trailing.length === 0 ||
    /^\s/.test(trailing) ||
    trailing.includes("\n") ||
    hasUnclosedInlineCode(trailing)
  ) {
    return markdown;
  }

  return `${markdown}${marker}`;
}

function countUnescapedOccurrences(markdown: string, marker: string) {
  let count = 0;
  for (let index = 0; index <= markdown.length - marker.length;) {
    if (
      markdown.startsWith(marker, index) &&
      !isEscaped(markdown, index) &&
      !isRepeatedSingleMarker(markdown, index, marker)
    ) {
      count += 1;
      index += marker.length;
      continue;
    }
    index += 1;
  }
  return count;
}

function findLastUnescapedOccurrence(markdown: string, marker: string) {
  for (let index = markdown.length - marker.length; index >= 0; index -= 1) {
    if (
      markdown.startsWith(marker, index) &&
      !isEscaped(markdown, index) &&
      !isRepeatedSingleMarker(markdown, index, marker)
    ) {
      return index;
    }
  }
  return -1;
}

function isRepeatedSingleMarker(markdown: string, index: number, marker: string) {
  if (marker.length !== 1) return false;
  return markdown[index - 1] === marker || markdown[index + 1] === marker;
}

function isEscaped(markdown: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function hasOpenCodeFence(markdown: string) {
  return countUnescapedFenceDelimiters(markdown, "```") % 2 === 1;
}

function countUnescapedFenceDelimiters(markdown: string, delimiter: string) {
  let count = 0;
  for (let index = 0; index <= markdown.length - delimiter.length;) {
    if (markdown.startsWith(delimiter, index) && !isEscaped(markdown, index)) {
      count += 1;
      index += delimiter.length;
      continue;
    }
    index += 1;
  }
  return count;
}

function hasUnclosedInlineCode(markdown: string) {
  let count = 0;
  for (let index = 0; index < markdown.length;) {
    if (markdown.startsWith("```", index)) {
      index += 3;
      while (index < markdown.length && !markdown.startsWith("```", index)) {
        index += 1;
      }
      if (index < markdown.length) index += 3;
      continue;
    }
    if (markdown[index] === "`" && !isEscaped(markdown, index)) count += 1;
    index += 1;
  }
  return count % 2 === 1;
}

