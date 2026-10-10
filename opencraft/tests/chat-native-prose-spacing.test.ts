import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDocumentNode } from "@opencraft/chat-document";

import { nativeHeadingSpacing, nativeParagraphSpacing, nativeRuleSpacing } from "../packages/chat-render-native/src/renderers/prose-spacing";

function paragraph(text: string): Extract<ChatDocumentNode, { kind: "paragraph" }> {
  return {
    kind: "paragraph",
    stableKey: `p-${text}`,
    completeness: "complete",
    sourceRange: { start: 0, end: text.length },
    children: [{ kind: "text", stableKey: `t-${text}`, completeness: "complete", sourceRange: { start: 0, end: text.length }, text, segments: [] }],
  };
}

test("native user messages keep Web's paragraph rhythm without list or bubble gaps", () => {
  const topLevel = { parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: null } as const;
  assert.deepEqual(nativeParagraphSpacing("user-message", topLevel), { marginTop: 20, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("user-message", { ...topLevel, parentKind: "list-item" }), { marginTop: 0, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("user-message", { ...topLevel, parentKind: "blockquote" }), { marginTop: 20, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("user-message", { ...topLevel, previousSiblingKind: null }), { marginTop: 0, marginBottom: 0 });
});

test("native assistant paragraphs have no trailing document margin", () => {
  assert.deepEqual(nativeParagraphSpacing("assistant", { parentKind: null, previousSiblingKind: null, nextSiblingKind: "paragraph" }), { marginTop: 0, marginBottom: 10 });
  assert.deepEqual(nativeParagraphSpacing("assistant", { parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: null }), { marginTop: 0, marginBottom: 0 });
});

test("list items and quotes let their child blocks own spacing", () => {
  const listParagraphBeforeNestedList = {
    parentKind: "list-item", previousSiblingKind: null, nextSiblingKind: "list",
  } as const;
  assert.deepEqual(nativeParagraphSpacing("assistant", listParagraphBeforeNestedList), { marginTop: 0, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("assistant", {
    parentKind: "list-item", previousSiblingKind: "paragraph", nextSiblingKind: null,
  }), { marginTop: 11, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("assistant", {
    parentKind: "blockquote", previousSiblingKind: "paragraph", nextSiblingKind: "paragraph",
  }), { marginTop: 0, marginBottom: 0 });
});

test("consecutive Han paragraphs use Web's compact gap only at document level", () => {
  const first = paragraph("你好");
  const next = paragraph("世界");
  const position = { parentKind: null, previousSiblingKind: null, nextSiblingKind: "paragraph", nextSibling: next } as const;
  assert.deepEqual(nativeParagraphSpacing("assistant", position, first), { marginTop: 0, marginBottom: 4 });
  assert.deepEqual(nativeParagraphSpacing("assistant", { ...position, nextSibling: paragraph("Hello") }, first), { marginTop: 0, marginBottom: 10 });
  assert.deepEqual(nativeParagraphSpacing("assistant", { ...position, parentKind: "blockquote" }, first), { marginTop: 0, marginBottom: 0 });
  assert.deepEqual(nativeParagraphSpacing("user-message", position, first), { marginTop: 0, marginBottom: 0 });
});

test("native headings and dividers keep Web's first and last block edges", () => {
  assert.deepEqual(nativeHeadingSpacing({ parentKind: null, previousSiblingKind: null, nextSiblingKind: "paragraph" }), { marginTop: 0, marginBottom: 10 });
  assert.deepEqual(nativeHeadingSpacing({ parentKind: null, previousSiblingKind: "horizontal-rule", nextSiblingKind: null }), { marginTop: 0, marginBottom: 0 });
  assert.deepEqual(nativeRuleSpacing({ parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: null }), { marginTop: 18, marginBottom: 0 });
  assert.deepEqual(nativeRuleSpacing({ parentKind: null, previousSiblingKind: null, nextSiblingKind: "heading" }), { marginTop: 0, marginBottom: 28 });
  assert.deepEqual(nativeHeadingSpacing({ parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: "paragraph" }), { marginTop: 10, marginBottom: 10 });
  assert.deepEqual(nativeHeadingSpacing({ parentKind: null, previousSiblingKind: "blockquote", nextSiblingKind: null }), { marginTop: 12, marginBottom: 0 });
  assert.deepEqual(nativeRuleSpacing({ parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: "paragraph" }), { marginTop: 18, marginBottom: 28 });
  assert.deepEqual(nativeRuleSpacing({ parentKind: null, previousSiblingKind: "horizontal-rule", nextSiblingKind: null }), { marginTop: 0, marginBottom: 0 });
  assert.deepEqual(nativeHeadingSpacing({ parentKind: null, previousSiblingKind: "paragraph", nextSiblingKind: null }, "user-message"), { marginTop: 20, marginBottom: 0 });
  assert.deepEqual(nativeRuleSpacing({ parentKind: null, previousSiblingKind: "list", nextSiblingKind: null }, "user-message"), { marginTop: 28, marginBottom: 0 });
});
