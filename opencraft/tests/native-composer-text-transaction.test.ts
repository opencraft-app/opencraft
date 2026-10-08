import assert from "node:assert/strict";
import test from "node:test";

import { composerDocumentToPlainText, type ComposerDocument } from "@opencraft/composer-core";

const nativeTransaction = await import("../apps/workbench-expo/src/runtime/native-composer-text-transaction.ts");
const { applyNativeComposerTextTransaction } = nativeTransaction.default ?? nativeTransaction;

test("a native list Enter reconciles the generated marker and moves the caret", () => {
  const document: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [{ id: "one", children: [{
      type: "paragraph", children: [{ type: "text", text: "Hello", marks: ["strong"] }],
    }] }],
  }] };
  const emittedText = "- He\nllo";
  const edit = applyNativeComposerTextTransaction(document, emittedText, { start: 4, end: 4 }, () => "two");
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, true);
  assert.equal(composerDocumentToPlainText(edit.document), "- He\n- llo");
  assert.deepEqual(edit.selection, { start: 7, end: 7 });
  assert.deepEqual((edit.document.blocks[0] as Extract<ComposerDocument["blocks"][number], { type: "list" }>).items.map(item => item.id), ["one", "two"]);
});

test("Backspace at the first list item start exits the list without losing following items", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "list", ordered: true, start: 3, items: [
      { id: "first", children: [{ type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] }] },
      { id: "second", children: [{ type: "paragraph", children: [{ type: "text", text: "Next" }] }] },
    ] },
  ] };
  const oldText = composerDocumentToPlainText(document);
  const cursor = "Before\n3. ".length;
  const emittedText = `${oldText.slice(0, cursor - 1)}${oldText.slice(cursor)}`;
  const edit = applyNativeComposerTextTransaction(document, emittedText, { start: cursor, end: cursor });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, true);
  assert.deepEqual(edit.selection, { start: "Before\n".length, end: "Before\n".length });
  assert.deepEqual(edit.document.blocks, [
    document.blocks[0],
    { type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] },
    { type: "list", ordered: true, start: 4, items: [
      { id: "second", children: [{ type: "paragraph", children: [{ type: "text", text: "Next" }] }] },
    ] },
  ]);
  assert.equal(composerDocumentToPlainText(edit.document), "Before\nBold\n4. Next");
});

test("Backspace at a later list item joins it to the previous item and renumbers following items", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Intro" }] },
    { type: "list", ordered: true, start: 9, items: [
      { id: "first", children: [{ type: "paragraph", children: [{ type: "text", text: "One", marks: ["strong"] }] }] },
      { id: "second", children: [{ type: "paragraph", children: [{ type: "text", text: "Two", marks: ["emphasis"] }] }] },
      { id: "third", children: [{ type: "paragraph", children: [{ type: "text", text: "Three" }] }] },
    ] },
  ] };
  const oldText = composerDocumentToPlainText(document);
  const cursor = "Intro\n9. One\n10. ".length;
  const emittedText = `${oldText.slice(0, cursor - 1)}${oldText.slice(cursor)}`;
  const edit = applyNativeComposerTextTransaction(document, emittedText, { start: cursor, end: cursor });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, true);
  assert.deepEqual(edit.selection, { start: "Intro\n9. One".length, end: "Intro\n9. One".length });
  assert.equal(composerDocumentToPlainText(edit.document), "Intro\n9. OneTwo\n10. Three");
  assert.deepEqual(edit.document.blocks[1], { type: "list", ordered: true, start: 9, items: [
    { id: "first", children: [{ type: "paragraph", children: [
      { type: "text", text: "One", marks: ["strong"] },
      { type: "text", text: "Two", marks: ["emphasis"] },
    ] }] },
    { id: "third", children: [{ type: "paragraph", children: [{ type: "text", text: "Three" }] }] },
  ] });
});

test("Backspace at a quote start joins its first paragraph without losing marks or remaining quote", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before", marks: ["strong"] }] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "Quoted", marks: ["emphasis"] }] },
      { type: "paragraph", children: [{ type: "text", text: "More", marks: ["code"] }] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "After" }] },
  ] };
  const previous = composerDocumentToPlainText(document);
  const cursor = "Before\n".length;
  const emitted = `${previous.slice(0, cursor - 1)}${previous.slice(cursor)}`;
  const edit = applyNativeComposerTextTransaction(document, emitted, { start: cursor, end: cursor });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, false);
  assert.deepEqual(edit.selection, { start: cursor - 1, end: cursor - 1 });
  assert.deepEqual(edit.document.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "Before", marks: ["strong"] },
      { type: "text", text: "Quoted", marks: ["emphasis"] },
    ] },
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "More", marks: ["code"] }] }] },
    document.blocks[2],
  ]);
  assert.equal(composerDocumentToPlainText(edit.document), emitted);
});

test("Backspace removes a single-paragraph quote wrapper but keeps adjacent blocks", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "A" }] },
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "B", marks: ["strong"] }] }] },
    { type: "paragraph", children: [{ type: "text", text: "C" }] },
  ] };
  const edit = applyNativeComposerTextTransaction(document, "AB\nC", { start: 2, end: 2 });
  assert.deepEqual(edit.document.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "A" },
      { type: "text", text: "B", marks: ["strong"] },
    ] },
    document.blocks[2],
  ]);
  assert.deepEqual(edit.selection, { start: 1, end: 1 });
  assert.equal(edit.reconcileText, false);
});

test("Backspace on a complex list item marker does not flatten its structure", () => {
  const document: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [
      { id: "first", children: [{ type: "paragraph", children: [{ type: "text", text: "One" }] }] },
      { id: "second", children: [
        { type: "paragraph", children: [{ type: "text", text: "Two" }] },
        { type: "paragraph", children: [{ type: "text", text: "More" }] },
      ] },
    ],
  }] };
  const oldText = composerDocumentToPlainText(document);
  const cursor = "- One\n- ".length;
  const emittedText = `${oldText.slice(0, cursor - 1)}${oldText.slice(cursor)}`;
  const edit = applyNativeComposerTextTransaction(document, emittedText, { start: cursor, end: cursor });
  assert.equal(edit.document, document);
  assert.equal(edit.rejected, true);
  assert.equal(edit.reconcileText, true);
});

test("ordinary native text edits retain a rebased caret without rewriting the buffer", () => {
  const document: ComposerDocument = { version: 1, blocks: [{
    type: "paragraph", children: [{ type: "text", text: "ab" }],
  }] };
  const edit = applyNativeComposerTextTransaction(document, "aXb", { start: 1, end: 1 });
  assert.equal(composerDocumentToPlainText(edit.document), "aXb");
  assert.deepEqual(edit.selection, { start: 2, end: 2 });
  assert.equal(edit.reconcileText, false);
  assert.equal(edit.rejected, false);
});

test("native Return inside a code block keeps the code block and its language", () => {
  const document: ComposerDocument = { version: 1, blocks: [{ type: "code-block", language: "ts", text: "let x" }] };
  const edit = applyNativeComposerTextTransaction(document, "let\n x", { start: 3, end: 3 });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, false);
  assert.deepEqual(edit.document.blocks, [{ type: "code-block", language: "ts", text: "let\n x" }]);
  assert.deepEqual(edit.selection, { start: 4, end: 4 });
});

test("a second Enter on an empty quote line exits to a plain paragraph", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "Quoted", marks: ["emphasis"] }] },
      { type: "paragraph", children: [] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "After" }] },
  ] };
  const previous = composerDocumentToPlainText(document);
  const cursor = "Before\nQuoted\n".length;
  const emitted = `${previous.slice(0, cursor)}\n${previous.slice(cursor)}`;
  const edit = applyNativeComposerTextTransaction(document, emitted, { start: cursor, end: cursor });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, true);
  assert.deepEqual(edit.selection, { start: cursor, end: cursor });
  assert.deepEqual(edit.document.blocks, [
    document.blocks[0],
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Quoted", marks: ["emphasis"] }] }] },
    { type: "paragraph", children: [] },
    document.blocks[2],
  ]);
  assert.equal(composerDocumentToPlainText(edit.document), previous);
});

test("Enter on a standalone empty quote exits without inventing an extra newline", () => {
  const document: ComposerDocument = { version: 1, blocks: [{
    type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "" }] }],
  }] };
  const edit = applyNativeComposerTextTransaction(document, "\n", { start: 0, end: 0 });
  assert.equal(edit.rejected, false);
  assert.equal(edit.reconcileText, true);
  assert.deepEqual(edit.selection, { start: 0, end: 0 });
  assert.deepEqual(edit.document.blocks, [{ type: "paragraph", children: [{ type: "text", text: "" }] }]);
  assert.equal(composerDocumentToPlainText(edit.document), "");
});

test("editing a generated list marker rejects and restores the durable projection", () => {
  const document: ComposerDocument = { version: 1, blocks: [{
    type: "list", ordered: false, items: [{ id: "one", children: [{
      type: "paragraph", children: [{ type: "text", text: "Hello" }],
    }] }],
  }] };
  const edit = applyNativeComposerTextTransaction(document, "x Hello", { start: 0, end: 1 });
  assert.equal(edit.document, document);
  assert.deepEqual(edit.selection, { start: 0, end: 1 });
  assert.equal(edit.rejected, true);
  assert.equal(edit.reconcileText, true);
});
