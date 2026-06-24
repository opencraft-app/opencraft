import { parseMarkdownTokens, type MarkedToken } from "./parse";

export interface StreamingTokenCache {
  readonly prefixTokens: Map<string, MarkedToken[]>;
}

const MAX_PREFIX_CACHE_SIZE = 100;

export function createStreamingTokenCache(): StreamingTokenCache {
  return { prefixTokens: new Map() };
}

export function parseStreamingMarkdownTokens(
  markdown: string,
  cache: StreamingTokenCache,
): MarkedToken[] {
  const prefixEndIndex = findStablePrefixEndIndex(markdown);
  if (prefixEndIndex === 0) return parseMarkdownTokens(markdown);

  const prefix = markdown.slice(0, prefixEndIndex);
  const tail = markdown.slice(prefixEndIndex);
  const prefixTokens = readPrefixTokens(prefix, cache);
  return [...prefixTokens, ...parseMarkdownTokens(tail)];
}

function readPrefixTokens(prefix: string, cache: StreamingTokenCache) {
  const cached = cache.prefixTokens.get(prefix);
  if (cached) return cached;

  let bestPrefix = "";
  let bestTokens: MarkedToken[] | null = null;
  for (const [candidatePrefix, candidateTokens] of cache.prefixTokens) {
    if (candidatePrefix.length > bestPrefix.length && prefix.startsWith(candidatePrefix)) {
      bestPrefix = candidatePrefix;
      bestTokens = candidateTokens;
    }
  }

  const tokens = bestTokens
    ? [...bestTokens, ...parseMarkdownTokens(prefix.slice(bestPrefix.length))]
    : parseMarkdownTokens(prefix);

  cache.prefixTokens.set(prefix, tokens);
  if (cache.prefixTokens.size > MAX_PREFIX_CACHE_SIZE) {
    const oldestKey = cache.prefixTokens.keys().next().value;
    if (typeof oldestKey === "string") cache.prefixTokens.delete(oldestKey);
  }
  return tokens;
}

function findStablePrefixEndIndex(markdown: string) {
  if (!markdown.includes("\n\n")) return 0;

  let stableEndIndex = 0;
  let possibleEndIndex: number | null = null;
  let insideFence = false;
  let directiveDepth = 0;
  let cursor = 0;

  while (cursor <= markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEndIndex = newlineIndex === -1 ? markdown.length : newlineIndex;
    const nextCursor = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
    const rawLine = markdown.slice(cursor, lineEndIndex).replace(/\r$/, "");
    const trimmed = rawLine.trimStart();

    if (possibleEndIndex !== null && trimmed.length > 0 && startsNewTopLevelBlock(rawLine)) {
      stableEndIndex = possibleEndIndex;
      possibleEndIndex = null;
    }
    if (trimmed.length > 0) possibleEndIndex = null;

    if (isFenceDelimiter(trimmed)) {
      insideFence = !insideFence;
    } else if (!insideFence && isDirectiveStart(trimmed)) {
      directiveDepth += 1;
    } else if (!insideFence && directiveDepth > 0 && isDirectiveEnd(trimmed)) {
      directiveDepth -= 1;
    }

    if (!insideFence && directiveDepth === 0 && trimmed.length === 0 && newlineIndex !== -1) {
      possibleEndIndex = nextCursor;
    }

    if (newlineIndex === -1) break;
    cursor = nextCursor;
  }

  return stableEndIndex;
}

function startsNewTopLevelBlock(line: string) {
  return (
    !/^[\t ]/.test(line) &&
    !/^[-+*][\t ]+/.test(line) &&
    !/^\d+\.[\t ]+/.test(line) &&
    !line.startsWith(">")
  );
}

function isFenceDelimiter(trimmedLine: string) {
  return /^(```|~~~)/.test(trimmedLine);
}

function isDirectiveStart(trimmedLine: string) {
  return /^:::[a-zA-Z]/.test(trimmedLine);
}

function isDirectiveEnd(trimmedLine: string) {
  return /^:::[ \t]*$/.test(trimmedLine);
}

