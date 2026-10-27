import {
  Marked,
  Tokenizer,
  type Token,
  type Tokens,
  type TokenizerExtension,
} from "marked";

import type {
  ChatDocumentNode,
  ChatDocumentNodeCompleteness,
  ChatDocumentSourceRange,
} from "./model";
import {
  preprocessChatMarkdown,
  preprocessUserMessageMarkdown,
  type ChatDocumentDialect,
} from "./preprocess";
import { findStableMarkdownPrefix } from "./streaming/code-boundary";
import { jsonBlockTokenizer } from "./json-block";

type MarkdownToken = Record<string, unknown>;

export interface ChatDocumentCompilerOptions {
  readonly streaming?: boolean;
  readonly dialect?: ChatDocumentDialect;
}

export interface ParsedChatDocument {
  readonly source: string;
  readonly nodes: readonly ChatDocumentNode[];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokens(value: unknown): readonly MarkdownToken[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is MarkdownToken => typeof entry === "object" && entry !== null)
    : [];
}

function range(start: number, raw: string): ChatDocumentSourceRange {
  return { start, end: start + raw.length };
}

function emptyBase<K extends ChatDocumentNode["kind"]>(
  kind: K,
  sourceRange: ChatDocumentSourceRange,
  completeness: ChatDocumentNodeCompleteness = "complete",
): { kind: K; stableKey: string; sourceRange: ChatDocumentSourceRange; completeness: ChatDocumentNodeCompleteness } {
  return { kind, stableKey: "", sourceRange, completeness };
}

function parseDirective(raw: string, sourceRange: ChatDocumentSourceRange): ChatDocumentNode | null {
  const match = /^\s*::([a-z][\w-]*)(?:\{([^}]*)\})?\s*$/i.exec(raw);
  if (match === null) return null;
  const attributes: Record<string, string> = {};
  for (const part of (match[2] ?? "").match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1).replace(/^"|"$/g, "");
    attributes[name] = value;
  }
  return {
    ...emptyBase("directive", sourceRange),
    name: match[1] ?? "unknown",
    attributes,
    raw,
  };
}

interface TextDecoration {
  readonly index: number;
  readonly content: string;
  readonly kind: "reference" | "color-swatch" | "file-citation";
  readonly citation?: {
    readonly path: string;
    readonly lineRangeStart: string;
    readonly lineRangeEnd?: string;
  };
}

const variableOrMentionRegex = /\$(?:\[[^\]\n]+\]|[A-Za-z][\w-]*)|@[A-Za-z0-9][\w.-]*[\\/][\w./-]*/gu;
const hexColorRegex = /(^|\s)(#[\da-fA-F]{6})(?!\w)/gu;
const fileCitationRegex = /【([^】\n]+?)†L(\d+)(?:-L(\d+))?】/gu;

function collectTextDecorations(text: string): readonly TextDecoration[] {
  const result: TextDecoration[] = [];
  for (const match of text.matchAll(variableOrMentionRegex)) {
    result.push({ index: match.index, content: match[0], kind: "reference" });
  }
  for (const match of text.matchAll(fileCitationRegex)) {
    const path = match[1]?.trim();
    const lineRangeStart = match[2];
    if (path === undefined || path.length === 0 || lineRangeStart === undefined) continue;
    result.push({
      index: match.index,
      content: match[0],
      kind: "file-citation",
      citation: {
        path,
        lineRangeStart,
        ...(match[3] === undefined ? {} : { lineRangeEnd: match[3] }),
      },
    });
  }
  const hasPullRequestContext = /\bprs?\b/iu.test(text);
  for (const match of text.matchAll(hexColorRegex)) {
    const prefix = match[1] ?? "";
    const color = match[2];
    if (color === undefined) continue;
    const index = match.index + prefix.length;
    const preceding = text.slice(0, index);
    if (/\b(?:issue|pr)\W*$/iu.test(preceding)) continue;
    if (hasPullRequestContext && /^#\d{6}$/u.test(color)) continue;
    result.push({ index, content: color, kind: "color-swatch" });
  }
  return result.sort((left, right) => left.index - right.index);
}

function decoratedTextNodes(text: string, sourceStart: number): readonly ChatDocumentNode[] {
  const decorations = collectTextDecorations(text);
  if (decorations.length === 0) {
    return [{ ...emptyBase("text", range(sourceStart, text)), text, segments: [] }];
  }
  const result: ChatDocumentNode[] = [];
  let cursor = 0;
  for (const decoration of decorations) {
    if (decoration.index < cursor) continue;
    if (decoration.index > cursor) {
      const plain = text.slice(cursor, decoration.index);
      result.push({ ...emptyBase("text", range(sourceStart + cursor, plain)), text: plain, segments: [] });
    }
    const sourceRange = range(sourceStart + decoration.index, decoration.content);
    if (decoration.kind === "reference") {
      result.push({
        ...emptyBase("reference", sourceRange),
        text: decoration.content,
        referenceKind: decoration.content.startsWith("@") ? "workspace-file" : "variable",
        segments: [],
      });
    } else if (decoration.kind === "color-swatch") {
      result.push({
        ...emptyBase("color-swatch", sourceRange),
        text: decoration.content,
        color: decoration.content,
        segments: [],
      });
    } else {
      result.push({
        ...emptyBase("directive", sourceRange),
        name: "file-citation",
        attributes: {
          path: decoration.citation!.path,
          line_range_start: decoration.citation!.lineRangeStart,
          ...(decoration.citation!.lineRangeEnd === undefined
            ? {}
            : { line_range_end: decoration.citation!.lineRangeEnd }),
        },
        raw: decoration.content,
      });
    }
    cursor = decoration.index + decoration.content.length;
  }
  if (cursor < text.length) {
    const plain = text.slice(cursor);
    result.push({ ...emptyBase("text", range(sourceStart + cursor, plain)), text: plain, segments: [] });
  }
  return result;
}

function textNodes(text: string, sourceStart: number): readonly ChatDocumentNode[] {
  return decoratedTextNodes(text, sourceStart);
}

function tokenStart(raw: string, source: string, cursor: { value: number }, baseOffset: number): number {
  const found = raw.length === 0 ? cursor.value : source.indexOf(raw, cursor.value);
  const start = found < 0 ? cursor.value : found;
  cursor.value = Math.max(cursor.value, start + raw.length);
  return baseOffset + start;
}

function mapInlineTokens(
  entries: readonly MarkdownToken[],
  fallbackText: string,
  sourceStart: number,
  decorateText = true,
): readonly ChatDocumentNode[] {
  const mapText = (text: string, start: number) => decorateText
    ? textNodes(text, start)
    : [{ ...emptyBase("text", range(start, text)), text, segments: [] } satisfies ChatDocumentNode];
  if (entries.length === 0) return mapText(fallbackText, sourceStart);
  const nodes: ChatDocumentNode[] = [];
  let relativeOffset = 0;
  for (const token of entries) {
    const type = string(token.type);
    const raw = string(token.raw) || string(token.text);
    const sourceRange = range(sourceStart + relativeOffset, raw);
    relativeOffset += raw.length;
    switch (type) {
      case "text": {
        const childTokens = tokens(token.tokens);
        if (childTokens.length > 0) {
          nodes.push(...mapInlineTokens(childTokens, string(token.text) || raw, sourceRange.start, decorateText));
        } else {
          nodes.push(...mapText(string(token.text) || raw, sourceRange.start));
        }
        break;
      }
      case "escape":
        nodes.push(...mapText(string(token.text) || raw, sourceRange.start));
        break;
      case "strong":
        nodes.push({
          ...emptyBase("strong", sourceRange),
          children: mapInlineTokens(tokens(token.tokens), string(token.text), sourceRange.start, decorateText),
        });
        break;
      case "em":
        nodes.push({
          ...emptyBase("emphasis", sourceRange),
          children: mapInlineTokens(tokens(token.tokens), string(token.text), sourceRange.start, decorateText),
        });
        break;
      case "del":
        nodes.push({
          ...emptyBase("delete", sourceRange),
          children: mapInlineTokens(tokens(token.tokens), string(token.text), sourceRange.start, decorateText),
        });
        break;
      case "codespan":
        nodes.push({ ...emptyBase("inline-code", sourceRange), code: string(token.text) });
        break;
      case "br":
        nodes.push(emptyBase("line-break", sourceRange));
        break;
      case "html":
        if (/^\s*<br\s*\/?>\s*$/iu.test(raw)) {
          nodes.push(emptyBase("line-break", sourceRange));
        } else {
          nodes.push(...mapText(raw, sourceRange.start));
        }
        break;
      case "link": {
        const { href, title, text: label, tokens: labelTokens } = token;
        // A link owns its action; label text must not create another action.
        const labelNodes = mapInlineTokens(
          tokens(labelTokens), string(label), sourceRange.start, false,
        );
        const linkNode: Extract<ChatDocumentNode, { kind: "link" }> = {
          ...emptyBase("link", sourceRange),
          href: string(href),
          title: typeof title === "string" ? title : null,
          children: labelNodes,
        };
        nodes.push(linkNode);
        break;
      }
      case "image":
        nodes.push({
          ...emptyBase("image", sourceRange),
          src: string(token.href),
          alt: string(token.text),
          title: typeof token.title === "string" ? token.title : null,
        });
        break;
      case "math":
        nodes.push({
          ...emptyBase("math", sourceRange),
          source: string(token.text).trim(),
          display: token.display === true,
        });
        break;
      default:
        nodes.push(...mapText(string(token.text) || raw, sourceRange.start));
    }
  }
  return nodes;
}

function mapBlockTokens(
  entries: readonly MarkdownToken[],
  source: string,
  baseOffset: number,
): readonly ChatDocumentNode[] {
  const cursor = { value: 0 };
  const nodes: ChatDocumentNode[] = [];
  for (const token of entries) {
    const type = string(token.type);
    const raw = string(token.raw);
    const start = tokenStart(raw, source, cursor, baseOffset);
    const sourceRange = range(start, raw);
    switch (type) {
      case "space":
        break;
      case "bareJson": {
        const prefix = string(token.prefix);
        if (prefix.trim()) nodes.push({
          ...emptyBase("paragraph", range(start, prefix)),
          children: mapInlineTokens(tokens(token.tokens), prefix.trimEnd(), start),
        });
        nodes.push({
          ...emptyBase("code-fence", range(start + prefix.length, string(token.text))),
          language: "json", code: string(token.text), meta: null,
        });
        break;
      }
      case "paragraph":
      case "text": {
        const directive = parseDirective(raw, sourceRange);
        if (directive !== null) {
          nodes.push(directive);
          break;
        }
        const children = mapInlineTokens(tokens(token.tokens), string(token.text), start);
        if (children.length === 1 && children[0]?.kind === "math" && children[0].display) {
          nodes.push(children[0]);
        } else {
          nodes.push({ ...emptyBase("paragraph", sourceRange), children });
        }
        break;
      }
      case "heading": {
        const depth = Math.max(1, Math.min(6, Number(token.depth) || 1)) as 1 | 2 | 3 | 4 | 5 | 6;
        nodes.push({
          ...emptyBase("heading", sourceRange),
          depth,
          children: mapInlineTokens(tokens(token.tokens), string(token.text), start),
        });
        break;
      }
      case "blockquote":
        nodes.push({
          ...emptyBase("blockquote", sourceRange),
          children: mapBlockTokens(tokens(token.tokens), raw, start),
        });
        break;
      case "list": {
        const children = tokens(token.items).map((item): ChatDocumentNode => {
          const itemRaw = string(item.raw);
          return {
            ...emptyBase("list-item", range(start, itemRaw)),
            checked: typeof item.checked === "boolean" ? item.checked : null,
            children: mapBlockTokens(tokens(item.tokens), itemRaw, start),
          };
        });
        nodes.push({
          ...emptyBase("list", sourceRange),
          ordered: token.ordered === true,
          start: typeof token.start === "number" ? token.start : null,
          children,
        });
        break;
      }
      case "code": {
        const languageInfo = typeof token.lang === "string" ? token.lang.trim() : "";
        const [language, ...meta] = languageInfo.split(/\s+/);
        // Nested containers have their own de-indented token source; a global
        // top-level fence offset cannot describe their completion state.
        const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(raw);
        const end = raw.trimEnd().length;
        const lastLineStart = raw.lastIndexOf("\n", end - 1) + 1;
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(raw.slice(lastLineStart, end));
        const open = fence !== null && (lastLineStart === 0 || closing === null
          || closing[1]?.[0] !== fence[1]?.[0] || (closing[1]?.length ?? 0) < (fence[1]?.length ?? 0));
        nodes.push({
          ...emptyBase("code-fence", sourceRange, open ? "open" : "complete"),
          language: language ? language.toLowerCase() : null,
          code: string(token.text),
          meta: meta.length === 0 ? null : meta.join(" "),
        });
        break;
      }
      case "hr":
        nodes.push(emptyBase("horizontal-rule", sourceRange));
        break;
      case "table": {
        const mapCell = (cell: unknown): readonly ChatDocumentNode[] => {
          if (typeof cell !== "object" || cell === null) return [];
          const record = cell as MarkdownToken;
          return mapInlineTokens(tokens(record.tokens), string(record.text), start);
        };
        const header = Array.isArray(token.header) ? token.header.map(mapCell) : [];
        const rows = Array.isArray(token.rows)
          ? token.rows.map((row) => Array.isArray(row) ? row.map(mapCell) : [])
          : [];
        const align = Array.isArray(token.align)
          ? token.align.map((value) => value === "left" || value === "center" || value === "right" ? value : null)
          : [];
        nodes.push({
          ...emptyBase("table", sourceRange),
          markdownSource: raw.trim(),
          header,
          rows,
          align,
        });
        break;
      }
      case "math":
        nodes.push({
          ...emptyBase("math", sourceRange),
          source: string(token.text).trim(),
          display: token.display === true,
        });
        break;
      case "html":
        // other raw HTML remains inert text unless a typed surface owns it.
        if (/^\s*<br\s*\/?>\s*$/iu.test(raw)) {
          nodes.push(emptyBase("line-break", sourceRange));
        } else {
          nodes.push({ ...emptyBase("text", sourceRange), text: raw, segments: [] });
        }
        break;
      default:
        nodes.push({ ...emptyBase("unknown", sourceRange), tokenType: type || "unknown", raw });
    }
  }
  return nodes;
}

export interface MarkdownLinkMatch {
  readonly start: number;
  readonly end: number;
  readonly label: string;
  readonly path: string;
}


export function findMarkdownLink(text: string, startIndex: number): MarkdownLinkMatch | null {
  if (!(startIndex < text.length)) return null;
  let phase: "search" | "label" | "path" = "search";
  let opening = -1;
  let labelEnd = -1;
  let pathStart = -1;
  let escaped = false;
  for (let cursor = Math.max(0, Math.trunc(startIndex)); cursor < text.length; cursor += 1) {
    if (phase === "search") {
      const nextOpening = text.indexOf("[", cursor);
      if (nextOpening < 0) return null;
      cursor = nextOpening;
      opening = cursor;
      escaped = false;
      phase = "label";
      continue;
    }
    const character = text[cursor];
    if (character === "\r" || character === "\n") {
      phase = "search";
      escaped = false;
      continue;
    }
    // A ]( label boundary wins even after a backslash. Destination closing
    // parentheses, in contrast, can be shielded by a preceding escape.
    if (phase === "label" && character === "]" && text[cursor + 1] === "(") {
      labelEnd = cursor;
      pathStart = cursor + 2;
      phase = cursor > opening + 1 ? "path" : "search";
      escaped = false;
      cursor += 1;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (phase === "label" && character === "]") phase = "search";
    if (phase === "path" && character === ")") {
      if (cursor > pathStart) return {
        start: opening, end: cursor + 1,
        label: text.slice(opening + 1, labelEnd),
        path: text.slice(pathStart, cursor),
      };
      phase = "search";
    }
  }
  return null;
}

function unescapeMarkdownLabel(input: string): string {
  return input.replaceAll("\\](", "](").replaceAll("\\]", "]").replaceAll("\\\\", "\\");
}

function unescapeBackslashPairs(input: string): string {
  return input.replaceAll("\\)", ")").replaceAll("\\\\", "\\");
}

function textToken(raw: string, text = raw): Tokens.Generic {
  return { type: "text", raw, text };
}

const userMessageImageTokenizer: TokenizerExtension = {
  name: "userMessageImage",
  level: "inline",
  start(source) {
    return source.indexOf("![");
  },
  tokenizer(source) {
    if (!source.startsWith("![")) return undefined;
    const tokenizer = this.lexer.options.tokenizer;
    const image = tokenizer?.link(source)
      ?? tokenizer?.reflink(source, this.lexer.tokens.links);
    if (image?.type !== "image") return undefined;
    const linkRaw = image.raw.slice(1);
    const label = image.text;
    const link: Tokens.Link = {
      type: "link",
      raw: linkRaw,
      href: image.href,
      title: image.title,
      text: label,
      tokens: this.lexer.inlineTokens(label),
    };
    return {
      type: "text",
      raw: image.raw,
      text: `!${label}`,
      tokens: [textToken("!"), link] as Token[],
    };
  },
  childTokens: ["tokens"],
};

const composerLinkTokenizer: TokenizerExtension = {
  name: "composerLink",
  level: "inline",
  start(source) {
    const index = source.indexOf("[");
    if (index === -1) return undefined;
    const previous = source[index - 1];
    return previous === ":" || previous === "!" ? index - 1 : index;
  },
  tokenizer(source) {
    if (source.startsWith(":[") && findMarkdownLink(source, 1)?.start === 1) {
      return textToken(":");
    }
    if (!source.startsWith("[")) return undefined;
    const match = findMarkdownLink(source, 0);
    if (match?.start === 0) {
      const label = unescapeMarkdownLabel(match.label);
      return {
        type: "link",
        raw: source.slice(0, match.end),
        href: unescapeBackslashPairs(match.path),
        title: null,
        text: label,
        tokens: [textToken(label)],
      } satisfies Tokens.Link;
    }
    const firstLine = source.split("\n", 1)[0] ?? "";
    return firstLine.includes("](") ? textToken(firstLine) : undefined;
  },
};


const mathBlockTokenizer: TokenizerExtension = {
  name: "math",
  level: "block",
  start(source) {
    if (!source.includes("$$") && !source.includes("\\[")) return undefined;
    let candidate = 0;
    let eligible = true;
    for (let position = 0; position < source.length; position += 1) {
      if (eligible && (source.startsWith("$$", position) || source.startsWith("\\[", position))) return candidate;
      const character = source[position];
      if (character === "\n") {
        candidate = position;
        eligible = true;
      } else if (character !== " " && character !== "\t") eligible = false;
    }
    return undefined;
  },
  tokenizer(source) {
    const closing = source.startsWith("$$") ? "$$" : source.startsWith("\\[") ? "\\]" : null;
    if (closing === null) return undefined;
    const boundary = source.indexOf(closing, 2);
    if (boundary < 0) return undefined;
    let remainder = boundary + closing.length;
    while (source[remainder] === " " || source[remainder] === "\t") remainder += 1;
    if (remainder < source.length && source[remainder] !== "\n") return undefined;
    const raw = source.substring(0, boundary + closing.length);
    return { type: "math", raw, text: raw.substring(2, raw.length - 2).trim(), display: true } as Token;
  },
};

const mathInlineTokenizer: TokenizerExtension = {
  name: "math",
  level: "inline",
  start(source) {
    const position = source.indexOf("\\(");
    return position < 0 ? undefined : position;
  },
  tokenizer(source) {
    if (!source.startsWith("\\(")) return undefined;
    for (let position = 2; position < source.length; position += 1) {
      if (source[position] === "\n") return undefined;
      if (source.startsWith("\\)", position)) {
        const raw = source.substring(0, position + 2);
        return { type: "math", raw, text: raw.substring(2, raw.length - 2).trim(), display: false } as Token;
      }
    }
    return undefined;
  },
};

/** Keep Marked's delimiter matching/code masking, relaxing only Han/punctuation
 * boundaries rejected by CommonMark (e.g. 是***“重点”*** and **句子。**后文).
 * The mask keeps UTF-16 offsets; canonical source and token raw bytes are intact.
 */
const hanEmphasisTokenizer = {
  emStrong(this: Tokenizer, source: string, maskedSource: string, previous = "") {
    const standard = Tokenizer.prototype.emStrong.call(this, source, maskedSource, previous);
    if (standard || !source.startsWith("*")) return standard ?? false;
    const previousBoundary = /\p{Script=Han}$/u.test(previous) && /^\*+\p{P}/u.test(source)
      ? "" : previous;
    const relaxedMask = maskedSource.replace(/(\p{P})(\*+)(\p{Script=Han})/gu,
      (match, punctuation: string, delimiter: string, han: string) => punctuation === "*" ? match : `${punctuation}${delimiter}${" ".repeat(han.length)}`);
    if (previousBoundary === previous && relaxedMask === maskedSource) return false;
    return Tokenizer.prototype.emStrong.call(this, source, relaxedMask, previousBoundary) ?? false;
  },
};

const assistantMarked = new Marked({
  gfm: true,
  breaks: true,
  tokenizer: hanEmphasisTokenizer,
  extensions: [mathBlockTokenizer, mathInlineTokenizer, jsonBlockTokenizer],
});

const userMessageMarked = new Marked({
  gfm: true,
  breaks: true,
  tokenizer: hanEmphasisTokenizer,
  extensions: [mathBlockTokenizer, mathInlineTokenizer, userMessageImageTokenizer, composerLinkTokenizer, jsonBlockTokenizer],
});

function lex(markdown: string, dialect: ChatDocumentDialect): readonly MarkdownToken[] {
  const result = dialect === "user-message"
    // Passing a fresh MarkedOptions object here replaces instance extension
    // state in Marked 18. The dialect instance already owns gfm/breaks.
    ? userMessageMarked.lexer(markdown)
    : assistantMarked.lexer(markdown);
  return result as unknown as readonly MarkdownToken[];
}

export class ChatDocumentCompiler {
  private readonly prefixCache = new Map<string, readonly ChatDocumentNode[]>();
  private prefixCacheCharacters = 0;
  // Pure syntax only: identity, resource policy and platform rendering belong
  // to each Session/View. Streaming repairs must never enter this cache.
  private readonly completedCache = new Map<string, ParsedChatDocument>();
  private completedCacheCharacters = 0;

  clearCaches(): void {
    this.prefixCache.clear();
    this.prefixCacheCharacters = 0;
    this.completedCache.clear();
    this.completedCacheCharacters = 0;
  }

  compile(source: string, options: ChatDocumentCompilerOptions = {}): ParsedChatDocument {
    const dialect = options.dialect ?? "assistant";
    const completedKey = options.streaming !== true && source.length <= 1_000_000
      ? `${dialect}\0${source}` : null;
    if (completedKey !== null) {
      const cached = this.completedCache.get(completedKey);
      if (cached !== undefined) {
        this.completedCache.delete(completedKey);
        this.completedCache.set(completedKey, cached);
        return cached;
      }
    }
    const dialectSource = dialect === "user-message"
      ? preprocessUserMessageMarkdown(source)
      : source;
    const preprocessed = preprocessChatMarkdown(dialectSource, { streaming: options.streaming });
    const openFenceStart = preprocessed.openFence?.start ?? null;
    // Reference definitions can reinterpret earlier blocks; unresolved shortcuts
    // also matter. Braces can turn earlier Markdown blocks into one JSON block
    // when a later closing delimiter arrives; do not freeze those prefixes.
    // Marked normalizes CRLF internally, so raw offsets cannot be reused here.
    if (options.streaming !== true || /[\[{\r]/u.test(preprocessed.markdown)
      || preprocessed.markdown.includes("$$")) {
      const parsed: ParsedChatDocument = {
        source,
        nodes: mapBlockTokens(lex(preprocessed.markdown, dialect), preprocessed.markdown, 0),
      };
      if (completedKey !== null) {
        this.completedCache.set(completedKey, parsed);
        this.completedCacheCharacters += completedKey.length;
        while (this.completedCache.size > 100 || this.completedCacheCharacters > 6_000_000) {
          const oldest = this.completedCache.keys().next().value;
          if (oldest === undefined) break;
          this.completedCache.delete(oldest);
          this.completedCacheCharacters -= oldest.length;
        }
      }
      return parsed;
    }

    const namespace = `${dialect}\0`;
    let prefixEnd = 0;
    let prefixNodes: readonly ChatDocumentNode[] = [];
    for (const [key, nodes] of this.prefixCache) {
      if (!key.startsWith(namespace)) continue;
      const prefix = key.slice(namespace.length);
      if (prefix.length > prefixEnd && preprocessed.markdown.startsWith(prefix)) {
        prefixEnd = prefix.length;
        prefixNodes = nodes;
      }
    }
    const tail = preprocessed.markdown.slice(prefixEnd);
    const tailTokens = lex(tail, dialect);
    const stable = findStableMarkdownPrefix(tailTokens);
    const stableEnd = prefixEnd + stable.sourceEnd;
    // Never promote repaired/open fenced source into a persistent prefix.
    const promote = stable.sourceEnd > 0 && (openFenceStart === null || stableEnd <= openFenceStart);
    const stableNodes = promote ? [
      ...prefixNodes,
      ...mapBlockTokens(tailTokens.slice(0, stable.tokenCount), tail, prefixEnd),
    ] : prefixNodes;
    if (promote) {
      const key = `${namespace}${preprocessed.markdown.slice(0, stableEnd)}`;
      if (!this.prefixCache.has(key)) {
        this.prefixCache.set(key, stableNodes);
        this.prefixCacheCharacters += key.length;
        while (this.prefixCache.size > 64 || this.prefixCacheCharacters > 1_000_000) {
          const oldest = this.prefixCache.keys().next().value;
          if (oldest === undefined) break;
          this.prefixCache.delete(oldest);
          this.prefixCacheCharacters -= oldest.length;
        }
      }
    }
    return {
      source,
      nodes: [
        ...stableNodes,
        ...mapBlockTokens(promote ? tailTokens.slice(stable.tokenCount) : tailTokens,
          promote ? tail.slice(stable.sourceEnd) : tail, promote ? stableEnd : prefixEnd),
      ],
    };
  }
}
