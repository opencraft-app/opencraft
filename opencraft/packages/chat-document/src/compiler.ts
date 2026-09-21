import {
  Marked,
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
        name: "codex-file-citation",
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
      case "link":
        nodes.push({
          ...emptyBase("link", sourceRange),
          href: string(token.href),
          title: typeof token.title === "string" ? token.title : null,
          // Source-equivalent to Codex renderInlineTokens(..., false): link
          // labels remain text and cannot contain nested interactive
          // decorations such as workspace mentions or file citations.
          children: mapInlineTokens(tokens(token.tokens), string(token.text), sourceRange.start, false),
        });
        break;
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
  openFenceStart: number | null,
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
          children: mapBlockTokens(tokens(token.tokens), raw, start, openFenceStart),
        });
        break;
      case "list": {
        const children = tokens(token.items).map((item): ChatDocumentNode => {
          const itemRaw = string(item.raw);
          return {
            ...emptyBase("list-item", range(start, itemRaw)),
            checked: typeof item.checked === "boolean" ? item.checked : null,
            children: mapBlockTokens(tokens(item.tokens), itemRaw, start, openFenceStart),
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
        const open = openFenceStart !== null && sourceRange.start <= openFenceStart && sourceRange.end >= openFenceStart;
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
        // Codex always treats an isolated HTML break as layout, while all
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

/** Source-identical scanner used by Codex's composerLink tokenizer. */
export function findMarkdownLink(text: string, startIndex: number): MarkdownLinkMatch | null {
  let cursor = startIndex;
  scanLinks: while (cursor < text.length) {
    const open = text.indexOf("[", cursor);
    if (open === -1) return null;
    let close = open + 1;
    while (close < text.length) {
      const character = text[close];
      const next = text[close + 1];
      if (character === "\n" || character === "\r") {
        cursor = close + 1;
        continue scanLinks;
      }
      if (character === "\\" && (next === "\\" || (next === "]" && text[close + 2] !== "("))) {
        close += 2;
        continue;
      }
      if (character === "]") break;
      close += 1;
    }
    if (close >= text.length) return null;
    if (close === open + 1 || text[close + 1] !== "(") {
      cursor = close + 1;
      continue;
    }
    let end = close + 2;
    while (end < text.length) {
      const character = text[end];
      const next = text[end + 1];
      if (character === "\n" || character === "\r") {
        cursor = end + 1;
        continue scanLinks;
      }
      if (character === "\\" && (next === "\n" || next === "\r")) {
        cursor = end + 2;
        continue scanLinks;
      }
      if (character === "\\" && next !== undefined) {
        end += 2;
        continue;
      }
      if (character === ")") {
        if (end === close + 2) {
          cursor = end + 1;
          continue scanLinks;
        }
        return {
          start: open,
          end: end + 1,
          label: text.slice(open + 1, close),
          path: text.slice(close + 2, end),
        };
      }
      end += 1;
    }
    return null;
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

/** Source-equivalent Codex delimiters: dollar pairs are display-only blocks. */
const mathBlockTokenizer: TokenizerExtension = {
  name: "math",
  level: "block",
  start(source) {
    const match = /(?:^|\n)[ \t]*(?:\\\[|\$\$)/u.exec(source);
    return match?.index;
  },
  tokenizer(source) {
    if (source.startsWith("\\[")) {
      const end = source.indexOf("\\]", 2);
      if (end === -1 || !/^[ \t]*(?:\n|$)/u.test(source.slice(end + 2))) return undefined;
      return { type: "math", raw: source.slice(0, end + 2), text: source.slice(2, end).trim(), display: true } as Token;
    }
    if (!source.startsWith("$$")) return undefined;
    const end = source.indexOf("$$", 2);
    if (end === -1 || !/^[ \t]*(?:\n|$)/u.test(source.slice(end + 2))) return undefined;
    return { type: "math", raw: source.slice(0, end + 2), text: source.slice(2, end).trim(), display: true } as Token;
  },
};

const mathInlineTokenizer: TokenizerExtension = {
  name: "math",
  level: "inline",
  start(source) {
    const index = source.indexOf("\\(");
    return index === -1 ? undefined : index;
  },
  tokenizer(source) {
    if (!source.startsWith("\\(")) return undefined;
    const end = source.indexOf("\\)", 2);
    if (end === -1) return undefined;
    const raw = source.slice(0, end + 2);
    if (raw.includes("\n")) return undefined;
    return { type: "math", raw, text: source.slice(2, end).trim(), display: false } as Token;
  },
};

const assistantMarked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [mathBlockTokenizer, mathInlineTokenizer],
});

const userMessageMarked = new Marked({
  gfm: true,
  breaks: true,
  extensions: [mathBlockTokenizer, mathInlineTokenizer, userMessageImageTokenizer, composerLinkTokenizer],
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

  compile(source: string, options: ChatDocumentCompilerOptions = {}): ParsedChatDocument {
    const dialect = options.dialect ?? "assistant";
    const dialectSource = dialect === "user-message"
      ? preprocessUserMessageMarkdown(source)
      : source;
    const preprocessed = preprocessChatMarkdown(dialectSource, { streaming: options.streaming });
    const openFenceStart = preprocessed.openFence?.start ?? null;
    const prefixEnd = options.streaming === true
      ? findStableMarkdownPrefix(preprocessed.markdown, openFenceStart)
      : 0;
    if (prefixEnd === 0) {
      return {
        source,
        nodes: mapBlockTokens(lex(preprocessed.markdown, dialect), preprocessed.markdown, 0, openFenceStart),
      };
    }

    const prefix = preprocessed.markdown.slice(0, prefixEnd);
    const tail = preprocessed.markdown.slice(prefixEnd);
    const prefixCacheKey = `${dialect}\0${prefix}`;
    let prefixNodes = this.prefixCache.get(prefixCacheKey);
    if (prefixNodes === undefined) {
      prefixNodes = mapBlockTokens(lex(prefix, dialect), prefix, 0, null);
      this.prefixCache.set(prefixCacheKey, prefixNodes);
      if (this.prefixCache.size > 64) this.prefixCache.delete(this.prefixCache.keys().next().value ?? "");
    }
    return {
      source,
      nodes: [
        ...prefixNodes,
        ...mapBlockTokens(lex(tail, dialect), tail, prefixEnd, openFenceStart),
      ],
    };
  }
}
