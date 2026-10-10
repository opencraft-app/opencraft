import assert from "node:assert/strict";
import test from "node:test";

import { composerDocumentToPlainText, type ComposerDocument } from "@opencraft/composer-core";

const nativeActions = await import("../apps/workbench-expo/src/runtime/native-composer-block-actions.ts");
const { formatNativeComposerBlock, nativeComposerBlockFormatAt, splitNativeComposerListItem } = nativeActions.default ?? nativeActions;

const paragraph = (text: string) => ({ type: "paragraph" as const, children: [{ type: "text" as const, text }] });

test("mobile block formatting preserves inline marks and selection while adding a list marker", () => {
  const original: ComposerDocument = { version: 1, blocks: [{
    type: "paragraph", children: [{ type: "text", text: "Hello", marks: ["strong"] }],
  }] };
  const result = formatNativeComposerBlock(original, { start: 2, end: 4 }, "bullets", () => "item-1");
  assert.ok(result);
  assert.equal(composerDocumentToPlainText(result.document), "- Hello");
  assert.deepEqual(result.selection, { start: 4, end: 6 });
  assert.deepEqual(result.document.blocks[0], {
    type: "list", ordered: false, items: [{ id: "item-1", children: original.blocks }],
  });
  assert.equal(nativeComposerBlockFormatAt(result.document, 4), "bullets");
  const plain = formatNativeComposerBlock(result.document, result.selection, "paragraph");
  assert.ok(plain);
  assert.deepEqual(plain.document, original);
  assert.deepEqual(plain.selection, { start: 2, end: 4 });
});

test("mobile list format switch keeps item IDs and maps the caret after marker length changes", () => {
  const original: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [
      { id: "a", children: [paragraph("Alpha")] },
      { id: "b", children: [paragraph("Beta")] },
    ],
  }] };
  const result = formatNativeComposerBlock(original, { start: 11, end: 11 }, "numbers");
  assert.ok(result);
  assert.equal(composerDocumentToPlainText(result.document), "1. Alpha\n2. Beta");
  assert.deepEqual(result.selection, { start: 13, end: 13 });
  assert.deepEqual((result.document.blocks[0] as Extract<ComposerDocument["blocks"][number], { type: "list" }>).items.map(item => item.id), ["a", "b"]);
});

test("mobile block formatting spans paragraphs and preserves marked text and surrounding blocks", () => {
  const marked = { type: "paragraph" as const, children: [{ type: "text" as const, text: "Two", marks: ["strong" as const] }] };
  const original: ComposerDocument = { version: 1, blocks: [paragraph("Before"), paragraph("One"), marked, paragraph("After")] };
  const result = formatNativeComposerBlock(original, { start: 8, end: 13 }, "bullets", (() => {
    const ids = ["one", "two"];
    return () => ids.shift()!;
  })());
  assert.ok(result);
  assert.equal(composerDocumentToPlainText(result.document), "Before\n- One\n- Two\nAfter");
  assert.deepEqual(result.selection, { start: 10, end: 17 });
  assert.deepEqual(result.document.blocks[0], original.blocks[0]);
  assert.deepEqual(result.document.blocks[2], original.blocks[3]);
  assert.deepEqual((result.document.blocks[1] as Extract<ComposerDocument["blocks"][number], { type: "list" }>).items, [
    { id: "one", children: [original.blocks[1]] },
    { id: "two", children: [marked] },
  ]);
});

test("mobile block formatting combines a list with the following paragraph and reuses item IDs", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "list", ordered: false, items: [{ id: "first", children: [paragraph("A")] }] },
    paragraph("B"),
  ] };
  const result = formatNativeComposerBlock(original, { start: 2, end: 5 }, "numbers", () => "second");
  assert.ok(result);
  assert.equal(composerDocumentToPlainText(result.document), "1. A\n2. B");
  assert.deepEqual(result.selection, { start: 3, end: 9 });
  assert.deepEqual((result.document.blocks[0] as Extract<ComposerDocument["blocks"][number], { type: "list" }>).items.map(item => item.id), ["first", "second"]);
});

test("a selection ending at the next paragraph's start does not format that paragraph", () => {
  const original: ComposerDocument = { version: 1, blocks: [paragraph("One"), paragraph("Two")] };
  const result = formatNativeComposerBlock(original, { start: 1, end: 4 }, "quote");
  assert.ok(result);
  assert.deepEqual(result.document.blocks, [{ type: "quote", children: [original.blocks[0]] }, original.blocks[1]]);
  assert.deepEqual(result.selection, { start: 1, end: 4 });
});

test("mobile block formatting leaves an unsupported selected block untouched", () => {
  const original: ComposerDocument = { version: 1, blocks: [paragraph("A"), { type: "divider" }, paragraph("B")] };
  assert.equal(formatNativeComposerBlock(original, { start: 0, end: 4 }, "quote"), null);
  assert.equal(formatNativeComposerBlock(original, { start: 0, end: 999 }, "quote"), null);
});

test("mobile code-block formatting joins plain paragraphs and maps selection", () => {
  const original: ComposerDocument = { version: 1, blocks: [paragraph("One"), paragraph("Two"), paragraph("After")] };
  const result = formatNativeComposerBlock(original, { start: 1, end: 7 }, "code");
  assert.ok(result);
  assert.deepEqual(result.document.blocks, [{ type: "code-block", text: "One\nTwo" }, original.blocks[2]]);
  assert.deepEqual(result.selection, { start: 1, end: 7 });
  assert.equal(nativeComposerBlockFormatAt(result.document, 2), "code");
  const restored = formatNativeComposerBlock(result.document, result.selection, "paragraph");
  assert.ok(restored);
  assert.deepEqual(restored.document, original);
});

test("mobile code-block formatting protects marks and atomic inline identities", () => {
  const marked: ComposerDocument = { version: 1, blocks: [{
    type: "paragraph", children: [{ type: "text", text: "keep bold", marks: ["strong"] }],
  }] };
  assert.equal(formatNativeComposerBlock(marked, { start: 0, end: 4 }, "code"), null);
  const mention: ComposerDocument = { version: 1, blocks: [{
    type: "paragraph", children: [{ type: "mention", id: "agent-1", label: "Vela", mentionKind: "agent" }],
  }] };
  assert.equal(formatNativeComposerBlock(mention, { start: 0, end: 5 }, "code"), null);
});

test("mobile code-block formatting keeps an existing language and can become a list", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "code-block", language: "ts", text: "const x = 1;\nprint(x);" }] };
  const same = formatNativeComposerBlock(original, { start: 4, end: 4 }, "code");
  assert.ok(same);
  assert.deepEqual(same.document, original);
  const list = formatNativeComposerBlock(original, { start: 0, end: composerDocumentToPlainText(original).length }, "bullets", () => "line");
  assert.ok(list);
  assert.equal(composerDocumentToPlainText(list.document), "- const x = 1;\n- print(x);");
});

test("mobile Enter splits a list item without losing text marks", () => {
  const original: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [{ id: "a", children: [{
      type: "paragraph", children: [{ type: "text", text: "Hello", marks: ["emphasis"] }],
    }] }],
  }] };
  const result = splitNativeComposerListItem(original, 4, () => "b");
  assert.ok(result);
  assert.equal(composerDocumentToPlainText(result.document), "- He\n- llo");
  assert.equal(result.cursor, 7);
  assert.deepEqual(result.document.blocks[0], {
    type: "list", ordered: false, items: [
      { id: "a", children: [{ type: "paragraph", children: [{ type: "text", text: "He", marks: ["emphasis"] }] }] },
      { id: "b", children: [{ type: "paragraph", children: [{ type: "text", text: "llo", marks: ["emphasis"] }] }] },
    ],
  });
});

test("mobile Enter renumbers later ordered items and exits an empty list item", () => {
  const ordered: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: true, start: 9, items: [
      { id: "a", children: [paragraph("AlphaBeta")] },
      { id: "c", children: [paragraph("Gamma")] },
    ],
  }] };
  const split = splitNativeComposerListItem(ordered, 8, () => "b");
  assert.ok(split);
  assert.equal(composerDocumentToPlainText(split.document), "9. Alpha\n10. Beta\n11. Gamma");
  assert.equal(split.cursor, 13);

  const empty: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [
      { id: "a", children: [paragraph("Alpha")] },
      { id: "empty", children: [{ type: "paragraph", children: [] }] },
      { id: "c", children: [paragraph("Gamma")] },
    ],
  }] };
  const exited = splitNativeComposerListItem(empty, 10);
  assert.ok(exited);
  assert.equal(composerDocumentToPlainText(exited.document), "- Alpha\n\n- Gamma");
  assert.equal(exited.cursor, 8);
  assert.deepEqual(exited.document.blocks.map(block => block.type), ["list", "paragraph", "list"]);

  const orderedEmpty: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: true, start: 9, items: [
      { id: "a", children: [paragraph("Alpha")] },
      { id: "empty", children: [{ type: "paragraph", children: [] }] },
      { id: "c", children: [paragraph("Gamma")] },
    ],
  }] };
  const orderedExited = splitNativeComposerListItem(orderedEmpty, 13);
  assert.ok(orderedExited);
  assert.equal(composerDocumentToPlainText(orderedExited.document), "9. Alpha\n\n11. Gamma");
});

test("mobile list split never cuts an atomic mention", () => {
  const original: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [{ id: "a", children: [{
      type: "paragraph", children: [{ type: "mention", id: "bot", label: "Vela", mentionKind: "agent" }],
    }] }],
  }] };
  assert.equal(splitNativeComposerListItem(original, 4), null);
});
