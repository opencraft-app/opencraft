import { ChatDocumentCompiler, chatDocumentPlainText } from "@opencraft/chat-document";
import type { ReasoningTimelineBlock } from "./timeline";

/** Only text actually returned by an engine; never a generated explanation. */
export interface ReasoningContentPresentation {
  readonly content: string;
  readonly header: string;
  readonly source: "summary" | "detail";
  /** Initial presentation only. Stream updates must not overwrite user intent. */
  readonly initiallyCollapsed: true;
}

/** Select returned text without parsing Markdown or inventing content. */
export function readReasoningContent(block: ReasoningTimelineBlock): Omit<ReasoningContentPresentation, "header"> | null {
  const summary = block.summary.trim();
  const content = summary || block.detail?.trim() || "";
  return content.length === 0 ? null : {
    content, source: summary.length > 0 ? "summary" : "detail", initiallyCollapsed: true,
  };
}

function compileReasoning(
  selected: Omit<ReasoningContentPresentation, "header">,
  active: boolean,
): ReasoningContentPresentation {
  // Use the body's grammar, including references, fences and streaming repair.
  // The compiler is transient: this cache retains plain presentation, not ASTs.
  const nodes = new ChatDocumentCompiler().compile(selected.content, { streaming: active }).nodes;
  const lines = chatDocumentPlainText(nodes).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  return { ...selected, header: (active ? lines.at(-1) : lines[0]) ?? "" };
}

/** Standalone callers remain pure; views may explicitly own a bounded cache. */
export function presentReasoning(
  block: ReasoningTimelineBlock,
  active = block.streaming,
): ReasoningContentPresentation | null {
  const selected = readReasoningContent(block);
  return selected === null ? null : compileReasoning(selected, active);
}

/**
 * Owned by one mounted Turn, never shared across conversations or persisted.
 * Compare selected text rather than projected object identity: a single event
 * can recreate every Block of the same source Turn. Keep only the latest
 * presentation per Item, bounded by both entry count and retained characters.
 */
export class ReasoningPresentationCache {
  private readonly entries = new Map<string, { readonly active: boolean; readonly value: ReasoningContentPresentation }>();
  private characters = 0;

  constructor(private readonly maxEntries = 128, private readonly maxCharacters = 1_000_000) {}

  readonly present = (block: ReasoningTimelineBlock, active = block.streaming): ReasoningContentPresentation | null => {
    const selected = readReasoningContent(block);
    const previous = this.entries.get(block.id);
    if (previous !== undefined) {
      this.entries.delete(block.id);
      this.characters -= previous.value.content.length + previous.value.header.length;
      if (selected !== null && previous.active === active
        && previous.value.content === selected.content && previous.value.source === selected.source) {
        this.entries.set(block.id, previous);
        this.characters += previous.value.content.length + previous.value.header.length;
        return previous.value;
      }
    }
    if (selected === null) return null;
    const value = compileReasoning(selected, active);
    const size = value.content.length + value.header.length;
    if (this.maxEntries > 0 && size <= this.maxCharacters) {
      while (this.entries.size >= this.maxEntries || this.characters + size > this.maxCharacters) {
        const oldest = this.entries.entries().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest[0]);
        this.characters -= oldest[1].value.content.length + oldest[1].value.header.length;
      }
      this.entries.set(block.id, { active, value });
      this.characters += size;
    }
    return value;
  };
}
