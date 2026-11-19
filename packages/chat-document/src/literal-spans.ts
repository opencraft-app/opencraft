import type { TokenizerExtension } from "marked";
import type { ChatDocumentNode, ChatDocumentSourceRange } from "./model";

/** Syntax-only source spans. The caller owns any identity/presentation metadata.
 * A private lexer token makes selected text literal without searching rendered
 * names or relying on offsets after Markdown/CRLF normalization. */
export function prepareLiteralSpans(source: string, spans: readonly ChatDocumentSourceRange[]) {
  if (spans.length > 64) throw RangeError("Too many literal spans");
  let previous = 0;
  for (const s of spans) {
    if (
      !Number.isSafeInteger(s.start) ||
      !Number.isSafeInteger(s.end) ||
      s.start < previous ||
      s.end <= s.start ||
      s.end > source.length
    )
      throw RangeError("Invalid literal span");
    previous = s.end;
  }
  let prefix = "\uE300OCSPAN";
  while (source.includes(prefix)) prefix += "X";
  const entries = spans.map((span, index) => ({
    span,
    text: source.slice(span.start, span.end),
    marker: prefix + index + "\uE301",
  }));
  let offset = 0,
    masked = "";
  for (const e of entries) {
    masked += source.slice(offset, e.span.start) + e.marker;
    offset = e.span.end;
  }
  masked += source.slice(offset);
  const byMarker = new Map(entries.map((e) => [e.marker, e]));
  const pattern = new RegExp(prefix + "[0-9]+\uE301", "gu");
  const extension: TokenizerExtension = {
    name: "literalSpan",
    level: "inline",
    start(value) {
      return value.indexOf(prefix);
    },
    tokenizer(value) {
      if (!value.startsWith(prefix)) return;
      const end = value.indexOf("\uE301");
      if (end < 0) return;
      const marker = value.slice(0, end + 1),
        entry = byMarker.get(marker);
      if (!entry) return;
      return {
        type: "literalSpan",
        raw: marker,
        text: entry.text,
        literalStart: entry.span.start,
        literalEnd: entry.span.end,
      };
    },
  };
  const restoreString = (value: string) => value.replace(pattern, (marker) => byMarker.get(marker)?.text ?? marker);
  // Code, link destinations, math and directive attributes stay their original
  // typed nodes: restore bytes there, never create a mention/action inside them.
  function restoreValue(value: unknown): unknown {
    if (typeof value === "string") return restoreString(value);
    if (Array.isArray(value)) return value.map(restoreValue);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreValue(v)]));
    return value;
  }
  return {
    masked,
    extension,
    restore: (nodes: readonly ChatDocumentNode[]) => restoreValue(nodes) as readonly ChatDocumentNode[],
  };
}
