import assert from "node:assert/strict";
import test from "node:test";
import { ChatDocumentCompiler, ChatDocumentStreamingSession, chatDocumentPlainText } from "@opencraft/chat-document";
function annotations(value: unknown): any[] {
  if (Array.isArray(value)) return value.flatMap(annotations);
  if (!value || typeof value !== "object") return [];
  const v = value as any;
  return [
    ...(v.literalSourceRange ? [v] : []),
    ...Object.entries(v)
      .filter(([k]) => k !== "literalSourceRange")
      .flatMap(([, x]) => annotations(x)),
  ];
}
test("source-selected spans survive bold, CRLF, nested Markdown and repeated labels, without reinterpreting names", () => {
  for (const source of [
    "**@Bob**",
    "Hi\r\n@Bob",
    "> 1. ~~@Bob~~",
    "a\n\n**@Bob** and @Bob",
    "@B_ob*[]",
    "\uE300OCSPAN0\uE301 **@Bob**",
  ]) {
    const label = source === "@B_ob*[]" ? source : "@Bob",
      start = source.indexOf(label),
      spans = [{ start, end: start + label.length }],
      compiler = new ChatDocumentCompiler();
    // An already-cached unannotated version must not suppress an annotation.
    compiler.compile(source, { dialect: "user-message" });
    for (const streaming of [false, true]) {
      const doc = compiler.compile(source, {
          dialect: "user-message",
          streaming,
          literalSpans: spans,
        }),
        nodes = annotations(doc.nodes);
      assert.equal(nodes.length, 1, source);
      assert.equal(nodes[0].text, label);
      assert.deepEqual(nodes[0].literalSourceRange, spans[0]);
      assert.ok(chatDocumentPlainText(doc.nodes).includes(label));
    }
    assert.equal(annotations(compiler.compile(source).nodes).length, 0);
  }
});
test("typed code and link destinations preserve bytes without receiving identity annotations", () => {
  for (const source of [
    "`@Bob`",
    "```text\n@Bob\n```",
    "[link](https://example.test/@Bob)",
    "![alt](https://example.test/@Bob)",
  ]) {
    const start = source.indexOf("@Bob"),
      doc = new ChatDocumentCompiler().compile(source, {
        literalSpans: [{ start, end: start + 4 }],
      });
    assert.equal(annotations(doc.nodes).length, 0, source);
    assert.ok(JSON.stringify(doc.nodes).includes("@Bob"));
    assert.ok(!JSON.stringify(doc.nodes).includes("OCSPAN"));
  }
});
test("literal annotation validation and session cache include the exact span set", () => {
  const compiler = new ChatDocumentCompiler(),
    source = "@Bob @Bob";
  for (const spans of [
    [{ start: -1, end: 4 }],
    [{ start: 0, end: 99 }],
    [
      { start: 0, end: 4 },
      { start: 2, end: 5 },
    ],
    [{ start: 0.5, end: 4 }],
  ])
    assert.throws(() => compiler.compile(source, { literalSpans: spans }), /span/i);
  const session = new ChatDocumentStreamingSession("literal", compiler),
    a = session.compile(source);
  a.commit();
  const b = session.compile(source, { literalSpans: [{ start: 5, end: 9 }] });
  b.commit();
  assert.equal(annotations(b.snapshot.nodes)[0].literalSourceRange.start, 5);
  const c = session.compile(source, { literalSpans: [{ start: 0, end: 4 }] });
  c.commit();
  assert.equal(annotations(c.snapshot.nodes)[0].literalSourceRange.start, 0);
  const d = session.compile(source);
  assert.equal(annotations(d.snapshot.nodes).length, 0);
});
