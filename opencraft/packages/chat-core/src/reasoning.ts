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

/**
 * A summary and a detailed reasoning stream can describe the same Item. Pick
 * one body instead of concatenating them or repeating the summary above it.
 * Empty Items stay protocol facts and cannot create an empty disclosure.
 */
export function presentReasoning(
  block: ReasoningTimelineBlock,
  active = block.streaming,
): ReasoningContentPresentation | null {
  const summary = block.summary.trim();
  const detail = block.detail?.trim() ?? "";
  const content = summary || detail;
  if (content.length === 0) return null;
  // Header and body share the assistant Markdown grammar, but only the body
  // is a rich content tree. A transient compiler holds no cross-Item preferences
  // or private-text cache. Actual body source is never rewritten.
  const nodes = new ChatDocumentCompiler().compile(content, { streaming: active }).nodes;
  const lines = chatDocumentPlainText(nodes).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return {
    content,
    header: (active ? lines.at(-1) : lines[0]) ?? "",
    source: summary.length > 0 ? "summary" : "detail",
    initiallyCollapsed: true,
  };
}
