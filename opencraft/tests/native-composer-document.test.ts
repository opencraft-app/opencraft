import assert from "node:assert/strict";
import test from "node:test";
import { composerDocumentToPlainText, type ComposerDocument } from "@opencraft/composer-core";
const nativeDocument = await import("../apps/workbench-expo/src/runtime/native-composer-document.ts");
const { hasNativeComposerMarks, insertNativeComposerText, nativeComposerLinkAt, normalizeNativeComposerLinkAddress, rebaseNativeComposerSelection, replaceNativeComposerText, setNativeComposerLink, toggleNativeComposerMark, projectNativeComposerPreviewRuns, projectNativeComposerVisualRuns } = nativeDocument.default ?? nativeDocument;

test("native text changes keep a usable cursor until the next selection event", () => {
  assert.deepEqual(rebaseNativeComposerSelection("abc", "abxc", { start: 2, end: 2 }), { start: 3, end: 3 });
  assert.deepEqual(rebaseNativeComposerSelection("abc", "ac", { start: 2, end: 2 }), { start: 1, end: 1 });
  assert.deepEqual(rebaseNativeComposerSelection("abc", "aZc", { start: 1, end: 2 }), { start: 2, end: 2 });
  assert.deepEqual(rebaseNativeComposerSelection("abc", "abxc", { start: 0, end: 0 }), { start: 0, end: 0 });
  assert.deepEqual(rebaseNativeComposerSelection("😀a", "😀ba", { start: 2, end: 2 }), { start: 3, end: 3 });
  assert.deepEqual(rebaseNativeComposerSelection("aa", "a", { start: 1, end: 1 }), { start: 0, end: 0 });
});

test("native edits retain marks around an insertion, including UTF-16 emoji offsets", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "Hi 😀 ", marks: ["strong"] },
    { type: "text", text: "friend", marks: ["emphasis"] },
  ] }] };
  const next = replaceNativeComposerText(original, "Hi 😀 dear friend");
  assert.equal(composerDocumentToPlainText(next), "Hi 😀 dear friend");
  assert.deepEqual(next.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Hi 😀 dear ", marks: ["strong"] },
    { type: "text", text: "friend", marks: ["emphasis"] },
  ] });
});

test("the native selection distinguishes identical formatted characters", () => {
  const paragraph = { type: "paragraph" as const, children: [
    { type: "text" as const, text: "a", marks: ["strong" as const] },
    { type: "text" as const, text: "a", marks: ["emphasis" as const] },
  ] };
  const document: ComposerDocument = { version: 1, blocks: [paragraph] };
  assert.deepEqual(replaceNativeComposerText(document, "a", { start: 1, end: 1 }).blocks[0], {
    type: "paragraph", children: [paragraph.children[1]],
  });
  assert.deepEqual(replaceNativeComposerText(document, "a", { start: 2, end: 2 }).blocks[0], {
    type: "paragraph", children: [paragraph.children[0]],
  });
  assert.deepEqual(replaceNativeComposerText(document, "aaa", { start: 1, end: 1 }).blocks[0], {
    type: "paragraph", children: [
      { type: "text", text: "aa", marks: ["strong"] }, paragraph.children[1],
    ],
  });

  const afterNewline: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "X" }] }, paragraph,
  ] };
  assert.deepEqual(replaceNativeComposerText(afterNewline, "X\na", { start: 3, end: 3 }).blocks, [
    afterNewline.blocks[0], { type: "paragraph", children: [paragraph.children[1]] },
  ]);
});

test("long repeated input keeps the selected formatted run", () => {
  const strong = "a".repeat(10_000);
  const emphasis = "a".repeat(10_000);
  const document: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: strong, marks: ["strong"] },
    { type: "text", text: emphasis, marks: ["emphasis"] },
  ] }] };
  const inserted = replaceNativeComposerText(document, "a".repeat(20_001), { start: 10_001, end: 10_001 });
  assert.deepEqual(inserted.blocks[0], { type: "paragraph", children: [
    { type: "text", text: strong, marks: ["strong"] },
    { type: "text", text: "a".repeat(10_001), marks: ["emphasis"] },
  ] });
  assert.deepEqual(
    rebaseNativeComposerSelection("a".repeat(20_000), "a".repeat(20_001), { start: 10_001, end: 10_001 }),
    { start: 10_002, end: 10_002 },
  );
});

test("native formatting toggles only the selected span and keeps other blocks", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "First" }] },
    { type: "paragraph", children: [{ type: "text", text: "Second" }] },
  ] };
  const bold = toggleNativeComposerMark(original, 6, 12, "strong");
  assert.ok(bold);
  assert.deepEqual(bold.blocks[0], original.blocks[0]);
  assert.deepEqual(bold.blocks[1], { type: "paragraph", children: [{ type: "text", text: "Second", marks: ["strong"] }] });
  assert.deepEqual(toggleNativeComposerMark(bold, 6, 12, "strong"), original);
  const edited = replaceNativeComposerText(bold, "First\nSecond!");
  assert.deepEqual(edited.blocks[0], original.blocks[0]);
  assert.deepEqual(edited.blocks[1], { type: "paragraph", children: [{ type: "text", text: "Second!", marks: ["strong"] }] });
});

test("editing beside a mention preserves its identity, while editing through it converts only that span", () => {
  const mention = { type: "mention" as const, id: "agent-1", label: "Vela", mentionKind: "agent" as const };
  const original: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "Ask " }, mention, { type: "text", text: " today" },
  ] }] };
  const beside = replaceNativeComposerText(original, "Ask @Vela again today");
  assert.deepEqual(beside.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Ask " }, mention, { type: "text", text: " again today" },
  ] });
  const through = replaceNativeComposerText(original, "Ask @Vel today");
  assert.deepEqual(through.blocks[0], { type: "paragraph", children: [{ type: "text", text: "Ask @Vel today" }] });
});

test("native edits and formatting retain link destinations and nested marks", () => {
  const link = { type: "link" as const, href: "https://example.com/article", children: [
    { type: "text" as const, text: "Read", marks: ["strong" as const] },
    { type: "text" as const, text: " more", marks: ["emphasis" as const] },
  ] };
  const original: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "Please " }, link, { type: "text", text: " now" },
  ] }] };
  const edited = replaceNativeComposerText(original, "Please Ready more now", { start: 10, end: 10 });
  assert.deepEqual(edited.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Please " },
    { type: "link", href: link.href, children: [
      { type: "text", text: "Ready", marks: ["strong"] },
      { type: "text", text: " more", marks: ["emphasis"] },
    ] },
    { type: "text", text: " now" },
  ] });
  const formatted = toggleNativeComposerMark(original, 7, 11, "code");
  assert.ok(formatted);
  assert.deepEqual(formatted.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Please " },
    { type: "link", href: link.href, children: [
      { type: "text", text: "Read", marks: ["strong", "code"] },
      { type: "text", text: " more", marks: ["emphasis"] },
    ] },
    { type: "text", text: " now" },
  ] });
  assert.deepEqual(toggleNativeComposerMark(formatted, 7, 11, "code"), original);
  const beside = replaceNativeComposerText(original, "Please Read more now!", { start: 20, end: 20 });
  assert.deepEqual(beside.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Please " }, link, { type: "text", text: " now!" },
  ] });
  const replaced = replaceNativeComposerText(original, "Please text now", { start: 7, end: 16 });
  assert.deepEqual(replaced.blocks[0], { type: "paragraph", children: [{ type: "text", text: "Please text now" }] });
  const plain = composerDocumentToPlainText(original);
  for (let index = 7; index < 16; index += 1) {
    const changed = replaceNativeComposerText(original,
      `${plain.slice(0, index)}X${plain.slice(index + 1)}`, { start: index, end: index + 1 });
    const paragraph = changed.blocks[0];
    assert.ok(paragraph?.type === "paragraph");
    assert.ok(paragraph.children[1]?.type === "link");
    assert.equal(paragraph.children[1].href, link.href);
  }
  const quoted: ComposerDocument = { version: 1, blocks: [{ type: "quote", children: [
    { type: "paragraph", children: [link] },
  ] }] };
  const quotedEdit = replaceNativeComposerText(quoted, "Ready more", { start: 3, end: 3 });
  assert.deepEqual(quotedEdit.blocks[0], { type: "quote", children: [{ type: "paragraph", children: [
    { type: "link", href: link.href, children: [
      { type: "text", text: "Ready", marks: ["strong"] },
      { type: "text", text: " more", marks: ["emphasis"] },
    ] },
  ] }] });
  const quotedFormat = toggleNativeComposerMark(quoted, 0, 4, "code");
  assert.ok(quotedFormat);
  assert.deepEqual(quotedFormat.blocks, [{ type: "quote", children: [{ type: "paragraph", children: [
    { type: "link", href: link.href, children: [
      { type: "text", text: "Read", marks: ["strong", "code"] },
      { type: "text", text: " more", marks: ["emphasis"] },
    ] },
  ] }] }]);
});

test("native link action preserves selected marks and surrounding document structure", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "quote", children: [{ type: "paragraph", children: [
      { type: "text", text: "Read ", marks: ["strong"] },
      { type: "text", text: "docs", marks: ["emphasis"] },
      { type: "text", text: " now" },
    ] }] },
  ] };
  const linked = setNativeComposerLink(original, 7, 16, "https://example.com/docs");
  assert.ok(linked);
  assert.deepEqual(linked.blocks, [original.blocks[0], { type: "quote", children: [{ type: "paragraph", children: [
    { type: "link", href: "https://example.com/docs", children: [
      { type: "text", text: "Read ", marks: ["strong"] },
      { type: "text", text: "docs", marks: ["emphasis"] },
    ] },
    { type: "text", text: " now" },
  ] }] }]);
  assert.equal(nativeComposerLinkAt(linked, 7, 16), "https://example.com/docs");
  assert.equal(nativeComposerLinkAt(linked, 7, 17), null);
  const unlinked = setNativeComposerLink(linked, 7, 16, null);
  assert.ok(unlinked);
  assert.equal(composerDocumentToPlainText(unlinked), composerDocumentToPlainText(original));
  assert.equal(nativeComposerLinkAt(unlinked, 7, 16), null);
  const acrossQuote = setNativeComposerLink(original, 4, 9, "https://example.com");
  assert.ok(acrossQuote);
  assert.deepEqual(acrossQuote.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "Befo" },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "re" }] },
    ] },
    { type: "quote", children: [{ type: "paragraph", children: [
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "Re", marks: ["strong"] }] },
      { type: "text", text: "ad ", marks: ["strong"] },
      { type: "text", text: "docs", marks: ["emphasis"] },
      { type: "text", text: " now" },
    ] }] },
  ]);
  assert.equal(nativeComposerLinkAt(acrossQuote, 4, 9), "https://example.com");
  assert.deepEqual(setNativeComposerLink(acrossQuote, 4, 9, null), original);
  const mention: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "mention", id: "agent", label: "Vela", mentionKind: "agent" },
  ] }] };
  assert.equal(setNativeComposerLink(mention, 0, 5, "https://example.com"), null);
});

test("native links protect list markers, code blocks and dividers across a selection", () => {
  const list: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Intro" }] },
    { type: "list", ordered: false, items: [{ id: "one", children: [
      { type: "paragraph", children: [{ type: "text", text: "Item" }] },
    ] }] },
  ] };
  assert.equal(setNativeComposerLink(list, 3, 9, "https://example.com"), null);
  const linkedItem = setNativeComposerLink(list, 8, 11, "https://example.com");
  assert.deepEqual(linkedItem?.blocks[1], { type: "list", ordered: false, items: [{ id: "one", children: [
    { type: "paragraph", children: [
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "Ite" }] },
      { type: "text", text: "m" },
    ] },
  ] }] });
  const code: ComposerDocument = { version: 1, blocks: [
    list.blocks[0]!, { type: "code-block", text: "const x = 1" },
  ] };
  assert.equal(setNativeComposerLink(code, 3, 10, "https://example.com"), null);
  const divider: ComposerDocument = { version: 1, blocks: [
    list.blocks[0]!, { type: "divider" }, { type: "paragraph", children: [{ type: "text", text: "End" }] },
  ] };
  assert.equal(setNativeComposerLink(divider, 3, 11, "https://example.com"), null);
});

test("native link addresses accept web URLs without breaking Markdown destinations", () => {
  assert.equal(normalizeNativeComposerLinkAddress(" example.com/docs "), "https://example.com/docs");
  assert.equal(normalizeNativeComposerLinkAddress("https://example.com/a(b)"), "https://example.com/a%28b%29");
  assert.equal(normalizeNativeComposerLinkAddress("javascript:alert(1)"), null);
  assert.equal(normalizeNativeComposerLinkAddress("https://user:pass@example.com"), null);
  assert.equal(normalizeNativeComposerLinkAddress("not a URL"), null);
});

test("splitting an atomic mention never duplicates its full label into the durable draft", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "a" }, { type: "hard-break" },
    { type: "mention", id: "agent-1", label: "aa", mentionKind: "agent" },
  ] }] };
  const oldText = composerDocumentToPlainText(original);
  assert.equal(oldText, "a\n@aa");
  const split = replaceNativeComposerText(original, "a\n@\naa", { start: 3, end: 3 });
  assert.equal(composerDocumentToPlainText(split), "a\n@\naa");
  assert.deepEqual(split.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "a" }, { type: "hard-break" }, { type: "text", text: "@" },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "aa" }] },
  ]);

  for (let start = 0; start <= oldText.length; start += 1) {
    for (let end = start; end <= oldText.length; end += 1) {
      const next = `${oldText.slice(0, start)}\n${oldText.slice(end)}`;
      const result = replaceNativeComposerText(original, next, { start, end });
      const actual = composerDocumentToPlainText(result);
      assert.ok(actual === next || result === original,
        `edit ${start}:${end} must be exact or keep the original document`);
    }
  }
});

test("joining native paragraphs keeps marks and untouched surrounding blocks", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] },
    { type: "paragraph", children: [{ type: "text", text: "next", marks: ["emphasis"] }] },
    { type: "paragraph", children: [{ type: "text", text: "After" }] },
  ] };
  const joined = replaceNativeComposerText(original, "Before\nBoldnext\nAfter");
  assert.deepEqual(joined.blocks, [
    original.blocks[0],
    { type: "paragraph", children: [
      { type: "text", text: "Bold", marks: ["strong"] },
      { type: "text", text: "next", marks: ["emphasis"] },
    ] },
    original.blocks[3],
  ]);
});

test("return and pasted lines create paragraphs without dropping marks or neighboring blocks", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "A" }] },
    { type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] },
    { type: "paragraph", children: [{ type: "text", text: "C" }] },
  ] };
  const pasted = replaceNativeComposerText(original, "A\nBo\nnew\nld\nC");
  assert.deepEqual(pasted.blocks, [
    original.blocks[0],
    { type: "paragraph", children: [{ type: "text", text: "Bo", marks: ["strong"] }] },
    { type: "paragraph", children: [{ type: "text", text: "new", marks: ["strong"] }] },
    { type: "paragraph", children: [{ type: "text", text: "ld", marks: ["strong"] }] },
    original.blocks[2],
  ]);

  const single: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Hello", marks: ["emphasis"] }] },
  ] };
  const entered = replaceNativeComposerText(single, "Hello\n");
  assert.deepEqual(entered.blocks, [
    single.blocks[0],
    { type: "paragraph", children: [] },
  ]);
  assert.equal(composerDocumentToPlainText(entered), "Hello\n");
});

test("external Composer text inserts at the native selection and retains adjacent marks", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [
    { type: "text", text: "Say ", marks: ["strong"] },
    { type: "text", text: "hello", marks: ["emphasis"] },
    { type: "text", text: " now" },
  ] }] };
  const replaced = insertNativeComposerText(original, "goodbye", { start: 4, end: 9 });
  assert.ok(replaced);
  assert.equal(replaced.cursor, 11);
  assert.deepEqual(replaced.document.blocks[0], { type: "paragraph", children: [
    { type: "text", text: "Say goodbye", marks: ["strong"] },
    { type: "text", text: " now" },
  ] });
  const appended = insertNativeComposerText(original, "!", null);
  assert.ok(appended);
  assert.equal(composerDocumentToPlainText(appended.document), "Say hello now!");
  assert.equal(appended.cursor, 14);

  const structured: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Quoted" }] }] },
  ] };
  const insideQuote = insertNativeComposerText(structured, "x", { start: 8, end: 9 });
  assert.ok(insideQuote);
  assert.deepEqual(insideQuote.document.blocks, [
    structured.blocks[0],
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Qxoted" }] }] },
  ]);
});

test("native plain-text edits cannot flatten a structured block across its separator", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Start" }] },
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Quoted" }] }] },
  ] };
  assert.equal(replaceNativeComposerText(original, "StartQuoted"), original);
  assert.deepEqual(replaceNativeComposerText(original, "Start\nChanged").blocks, [
    original.blocks[0],
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Changed" }] }] },
  ]);
});

test("native edits and formatting stay inside nested quote and list paragraphs", () => {
  const quote: ComposerDocument = { version: 1, blocks: [{ type: "quote", children: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] },
  ] }] };
  const split = replaceNativeComposerText(quote, "Before\nBo\nld", { start: 9, end: 9 });
  assert.deepEqual(split.blocks, [{ type: "quote", children: [
    { type: "paragraph", children: [{ type: "text", text: "Before" }] },
    { type: "paragraph", children: [{ type: "text", text: "Bo", marks: ["strong"] }] },
    { type: "paragraph", children: [{ type: "text", text: "ld", marks: ["strong"] }] },
  ] }]);
  assert.deepEqual(replaceNativeComposerText(quote, "BeforeBold", { start: 6, end: 7 }).blocks, [{
    type: "quote", children: [{ type: "paragraph", children: [
      { type: "text", text: "Before" },
      { type: "text", text: "Bold", marks: ["strong"] },
    ] }],
  }]);

  const list: ComposerDocument = { version: 1, blocks: [{ type: "list", ordered: true, start: 3, items: [
    { id: "a", children: [{ type: "paragraph", children: [{ type: "text", text: "Alpha" }] }] },
    { id: "b", children: [{ type: "paragraph", children: [{ type: "text", text: "Beta" }] }] },
  ] }] };
  const edited = replaceNativeComposerText(list, "3. AlXpha\n4. Beta", { start: 5, end: 5 });
  assert.equal(composerDocumentToPlainText(edited), "3. AlXpha\n4. Beta");
  assert.deepEqual(edited.blocks[0], { type: "list", ordered: true, start: 3, items: [
    { id: "a", children: [{ type: "paragraph", children: [{ type: "text", text: "AlXpha" }] }] },
    { id: "b", children: [{ type: "paragraph", children: [{ type: "text", text: "Beta" }] }] },
  ] });
  assert.equal(composerDocumentToPlainText(replaceNativeComposerText(list, "3. Alpha\n4. Bxeta", { start: 13, end: 13 })),
    "3. Alpha\n4. Bxeta");
  const formatted = toggleNativeComposerMark(list, 3, 8, "emphasis");
  assert.ok(formatted);
  assert.equal(formatted.blocks[0]?.type, "list");
  assert.deepEqual(toggleNativeComposerMark(formatted, 3, 8, "emphasis"), list);
  assert.equal(toggleNativeComposerMark(list, 2, 4, "strong"), null);
  assert.equal(replaceNativeComposerText(list, "2. Alpha\n4. Beta", { start: 0, end: 1 }), list);
});

test("native backspace joins quote paragraphs without removing the quote or adjacent blocks", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Lead" }] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "Alpha", marks: ["strong"] }] },
      { type: "paragraph", children: [{ type: "text", text: "Beta", marks: ["emphasis"] }] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "Tail" }] },
  ] };
  const joined = replaceNativeComposerText(original, "Lead\nAlphaBeta\nTail", { start: 10, end: 11 });
  assert.deepEqual(joined.blocks, [
    original.blocks[0],
    { type: "quote", children: [{ type: "paragraph", children: [
      { type: "text", text: "Alpha", marks: ["strong"] },
      { type: "text", text: "Beta", marks: ["emphasis"] },
    ] }] },
    original.blocks[2],
  ]);
  assert.equal(replaceNativeComposerText(original, "LeadAlpha\nBeta\nTail", { start: 4, end: 5 }), original);
});

test("native backspace joins paragraphs within one list item and protects the next marker", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "list", ordered: false, items: [
    { id: "first", children: [
      { type: "paragraph", children: [{ type: "text", text: "Alpha", marks: ["strong"] }] },
      { type: "paragraph", children: [{ type: "text", text: "Beta", marks: ["emphasis"] }] },
    ] },
    { id: "second", children: [{ type: "paragraph", children: [{ type: "text", text: "Gamma" }] }] },
  ] }] };
  const joined = replaceNativeComposerText(original, "- AlphaBeta\n- Gamma", { start: 7, end: 8 });
  assert.deepEqual(joined.blocks, [{ type: "list", ordered: false, items: [
    { id: "first", children: [{ type: "paragraph", children: [
      { type: "text", text: "Alpha", marks: ["strong"] },
      { type: "text", text: "Beta", marks: ["emphasis"] },
    ] }] },
    original.blocks[0]?.type === "list" ? original.blocks[0].items[1]! : null,
  ] }]);
  assert.equal(replaceNativeComposerText(original, "- Alpha\nBeta- Gamma", { start: 12, end: 13 }), original);

  const ordered: ComposerDocument = { version: 1, blocks: [{ type: "list", ordered: true, start: 9, items: [
    { id: "first", children: [{ type: "paragraph", children: [{ type: "text", text: "X" }] }] },
    { id: "second", children: [
      { type: "paragraph", children: [{ type: "text", text: "Alpha" }] },
      { type: "paragraph", children: [{ type: "text", text: "Beta" }] },
    ] },
  ] }] };
  const orderedJoined = replaceNativeComposerText(ordered, "9. X\n10. AlphaBeta", { start: 14, end: 15 });
  assert.equal(composerDocumentToPlainText(orderedJoined), "9. X\n10. AlphaBeta");
  assert.deepEqual(orderedJoined.blocks[0]?.type === "list" ? orderedJoined.blocks[0].items[1]?.children : null, [
    { type: "paragraph", children: [{ type: "text", text: "AlphaBeta" }] },
  ]);
});

test("native edits preserve a code block nested in a quote", () => {
  const document: ComposerDocument = { version: 1, blocks: [{ type: "quote", children: [
    { type: "code-block", language: "ts", text: "a\nb" },
  ] }] };
  const edited = replaceNativeComposerText(document, "a\nbc", { start: 3, end: 3 });
  assert.deepEqual(edited.blocks, [{ type: "quote", children: [
    { type: "code-block", language: "ts", text: "a\nbc" },
  ] }]);
});

test("the structured preview keeps list markers plain and nested text marks visible", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "quote", children: [{ type: "paragraph", children: [{ type: "text", text: "Bold", marks: ["strong"] }] }] },
    { type: "list", ordered: false, items: [{ id: "one", children: [{ type: "paragraph", children: [
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "Link", marks: ["emphasis"] }] },
    ] }] }] },
  ] };
  const preview = projectNativeComposerPreviewRuns(document);
  assert.equal(preview.map(run => run.text).join(""), composerDocumentToPlainText(document));
  assert.deepEqual(preview.filter(run => run.marks.length > 0), [
    { text: "Bold", marks: ["strong"] }, { text: "Link", marks: ["emphasis"], href: "https://example.com" },
  ]);
  assert.equal(hasNativeComposerMarks(document), true);
  assert.deepEqual(projectNativeComposerVisualRuns(document), preview);
});

test("formatted native and preview runs match the portable text projection and carry only text marks", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [
      { type: "text", text: "Bold ", marks: ["strong"] },
      { type: "mention", id: "agent-1", label: "Vela", mentionKind: "agent" },
      { type: "hard-break" },
      { type: "text", text: "Code", marks: ["code"] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "End", marks: ["emphasis"] }] },
  ] };
  const runs = projectNativeComposerVisualRuns(document);
  assert.ok(runs);
  assert.equal(runs.map(run => run.text).join(""), composerDocumentToPlainText(document));
  assert.deepEqual(runs.map(run => run.marks), [["strong"], [], [], ["code"], [], ["emphasis"]]);
  assert.equal(hasNativeComposerMarks(document), true);
  assert.equal(hasNativeComposerMarks({ version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "First" }] },
    { type: "paragraph", children: [{ type: "text", text: "Second", marks: ["strong"] }] },
  ] }), true);
  assert.deepEqual(projectNativeComposerVisualRuns({ version: 1, blocks: [
    { type: "code-block", text: "const n = 1" },
  ] }), [{ text: "const n = 1", marks: [] }]);
});

test("nested block visual runs keep the exact shared UTF-16 selection projection", () => {
  const document: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [
      { type: "text", text: "A😀", marks: ["strong"] },
      { type: "hard-break" },
      { type: "link", href: "https://example.com", children: [{ type: "text", text: "link", marks: ["emphasis"] }] },
    ] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "quoted" }] },
      { type: "list", ordered: true, start: 9, items: [
        { id: "nine", children: [{ type: "paragraph", children: [{ type: "text", text: "first" }] }] },
        { id: "ten", children: [
          { type: "code-block", language: "ts", text: "x\ny" },
          { type: "paragraph", children: [{ type: "text", text: "last", marks: ["code"] }] },
        ] },
      ] },
    ] },
    { type: "divider" },
  ] };
  const visual = projectNativeComposerVisualRuns(document);
  const plain = composerDocumentToPlainText(document);
  assert.equal(visual.map(run => run.text).join(""), plain);
  assert.equal(visual.reduce((length, run) => length + run.text.length, 0), plain.length);
  assert.deepEqual(visual.filter(run => run.href), [{ text: "link", marks: ["emphasis"], href: "https://example.com" }]);
});

test("one native selection formats text across adjacent paragraphs without merging them", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Alpha" }] },
    { type: "paragraph", children: [{ type: "text", text: "Beta" }] },
  ] };
  const bold = toggleNativeComposerMark(original, 2, 8, "strong");
  assert.ok(bold);
  assert.deepEqual(bold.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "Al" }, { type: "text", text: "pha", marks: ["strong"] },
    ] },
    { type: "paragraph", children: [
      { type: "text", text: "Be", marks: ["strong"] }, { type: "text", text: "ta" },
    ] },
  ]);
  assert.deepEqual(toggleNativeComposerMark(bold, 2, 8, "strong"), original);
});

test("one native selection formats paragraphs across a quote while preserving the quote", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Lead" }] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "One" }] },
      { type: "paragraph", children: [{ type: "text", text: "Two" }] },
    ] },
    { type: "paragraph", children: [{ type: "text", text: "Tail" }] },
  ] };
  const bold = toggleNativeComposerMark(original, 2, 15, "strong");
  assert.ok(bold);
  assert.deepEqual(bold.blocks, [
    { type: "paragraph", children: [
      { type: "text", text: "Le" }, { type: "text", text: "ad", marks: ["strong"] },
    ] },
    { type: "quote", children: [
      { type: "paragraph", children: [{ type: "text", text: "One", marks: ["strong"] }] },
      { type: "paragraph", children: [{ type: "text", text: "Two", marks: ["strong"] }] },
    ] },
    { type: "paragraph", children: [
      { type: "text", text: "Ta", marks: ["strong"] }, { type: "text", text: "il" },
    ] },
  ]);
  assert.deepEqual(toggleNativeComposerMark(bold, 2, 15, "strong"), original);
  assert.equal(composerDocumentToPlainText(bold), composerDocumentToPlainText(original));
});

test("a native selection formats list item paragraphs without changing its marker", () => {
  const original: ComposerDocument = { version: 1, blocks: [{ type: "list", ordered: false, items: [{
    id: "first", children: [
      { type: "paragraph", children: [{ type: "text", text: "Alpha" }] },
      { type: "paragraph", children: [{ type: "text", text: "Beta" }] },
    ],
  }] }] };
  const italic = toggleNativeComposerMark(original, 4, 9, "emphasis");
  assert.ok(italic);
  assert.equal(composerDocumentToPlainText(italic), "- Alpha\nBeta");
  assert.deepEqual(italic.blocks[0], { type: "list", ordered: false, items: [{
    id: "first", children: [
      { type: "paragraph", children: [
        { type: "text", text: "Al" }, { type: "text", text: "pha", marks: ["emphasis"] },
      ] },
      { type: "paragraph", children: [{ type: "text", text: "B", marks: ["emphasis"] }, { type: "text", text: "eta" }] },
    ],
  }] });
  assert.equal(toggleNativeComposerMark(original, 1, 4, "emphasis"), null);
});

test("a native selection spanning an atomic mention does not partially format the draft", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Ask" }] },
    { type: "paragraph", children: [
      { type: "mention", id: "agent-1", label: "Vela", mentionKind: "agent" },
      { type: "text", text: " now" },
    ] },
  ] };
  assert.equal(toggleNativeComposerMark(original, 1, 9, "emphasis"), null);
});

test("a native selection cannot apply formatting through a structured block", () => {
  const original: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Start" }] },
    { type: "quote", children: [{ type: "paragraph", children: [] }] },
    { type: "paragraph", children: [{ type: "text", text: "End" }] },
  ] };
  assert.equal(toggleNativeComposerMark(original, 2, 7, "strong"), null);
  const emptyCode: ComposerDocument = { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "A" }] },
    { type: "code-block", text: "" },
    { type: "paragraph", children: [{ type: "text", text: "B" }] },
  ] };
  assert.equal(toggleNativeComposerMark(emptyCode, 0, 3, "strong"), null);
});
