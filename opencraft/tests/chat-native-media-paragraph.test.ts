import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDocumentNode } from "@opencraft/chat-document";
import { splitNativeMediaParagraph } from "../packages/chat-render-native/src/renderers/media-paragraph";

test("native media paragraphs keep text runs intact around independently sized images", () => {
  const base = (stableKey: string) => ({ stableKey, completeness: "complete" as const, sourceRange: { start: 0, end: 1 } });
  const nodes: ChatDocumentNode[] = [
    { ...base("before"), kind: "text", text: "Before ", segments: [] },
    { ...base("bold"), kind: "strong", children: [{ ...base("word"), kind: "text", text: "image", segments: [] }] },
    { ...base("picture"), kind: "image", src: "https://example.com/image.png", alt: "Image", title: null },
    { ...base("after"), kind: "text", text: " after", segments: [] },
  ];
  const parts = splitNativeMediaParagraph(nodes);
  assert.deepEqual(parts.map(part => [part.kind, part.key]), [
    ["text", "before"], ["image", "picture"], ["text", "after"],
  ]);
  assert.equal(parts[0]?.kind === "text" ? parts[0].nodes.length : 0, 2);
});
