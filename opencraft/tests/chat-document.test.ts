import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatDocumentCompiler,
  ChatDocumentStreamingSession,
  findMarkdownLink,
  preprocessChatMarkdown,
  preprocessUserMessageMarkdown,
  type ChatDocumentNode,
} from "@opencraft/chat-document";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const codeBlockStyles = readFileSync(
  resolve(process.cwd(), "packages/chat-render-web/src/renderers/code/code-block.scss"),
  "utf8",
);
const proseStyles = readFileSync(
  resolve(process.cwd(), "packages/chat-render-web/src/renderers/prose/prose.scss"),
  "utf8",
);
const tableStyles = readFileSync(
  resolve(process.cwd(), "packages/chat-render-web/src/renderers/table/table.scss"),
  "utf8",
);
const tableRendererSource = readFileSync(
  resolve(process.cwd(), "packages/chat-render-web/src/renderers/table/table-renderer.tsx"),
  "utf8",
);

function flatten(nodes: readonly ChatDocumentNode[]): ChatDocumentNode[] {
  const result: ChatDocumentNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if ("children" in node) result.push(...flatten(node.children));
    if (node.kind === "table") {
      for (const cell of node.header) result.push(...flatten(cell));
      for (const row of node.rows) for (const cell of row) result.push(...flatten(cell));
    }
  }
  return result;
}

test("chat document compiles prose, GFM, code, math, links and tables", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile([
    "# Result",
    "",
    "Use **strong**, `inline()` and \\(x^2\\) at [source](file:///vela/a.ts).",
    "",
    "- [x] parsed",
    "- [ ] rendered",
    "",
    "| name | value |",
    "| --- | ---: |",
    "| alpha | 1 |",
    "",
    "```ts",
    "const answer = 42;",
    "```",
  ].join("\n"));
  const nodes = flatten(parsed.nodes);
  assert.ok(nodes.some((node) => node.kind === "heading" && node.depth === 1));
  assert.ok(nodes.some((node) => node.kind === "strong"));
  assert.ok(nodes.some((node) => node.kind === "inline-code" && node.code === "inline()"));
  assert.ok(nodes.some((node) => node.kind === "math" && node.source === "x^2" && !node.display));
  assert.ok(nodes.some((node) => node.kind === "link" && node.href === "file:///vela/a.ts"));
  assert.ok(nodes.some((node) => node.kind === "list-item" && node.checked === true));
  assert.ok(nodes.some((node) => node.kind === "table" && node.rows.length === 1));
  assert.ok(nodes.some((node) => node.kind === "table" && node.markdownSource.startsWith("| name | value |")));
  assert.ok(nodes.some((node) => node.kind === "code-fence" && node.language === "ts" && node.completeness === "complete"));
});

test("Markdown prose preserves Codex Han rhythm, nested-list grammar and block streaming entry", () => {
  assert.match(proseStyles, /> p\[data-markdown-han-text\]:has\(\+ p\[data-markdown-han-text\]\)/u);
  assert.match(proseStyles, /strong \{ font-weight: 600; \}/u);
  assert.match(proseStyles, /\.chat-media-paragraph \{[\s\S]{0,120}?text-align: left;/u);
  assert.match(proseStyles, /li \+ li \{ margin-top: 0\.5rem; \}/u);
  assert.match(proseStyles, /ul ul \{ list-style-type: circle; \}/u);
  assert.match(proseStyles, /ul ul ul \{ list-style-type: square; \}/u);
  assert.match(proseStyles, /:is\(\.chat-stream-fade-in, hr, li, tr, blockquote\)/u);
});

test("Markdown tables use the Codex reading surface rather than a bordered card", () => {
  assert.match(tableRendererSource, /data-markdown-table="true"/u);
  assert.match(tableRendererSource, /"text\/plain": node\.markdownSource/u);
  assert.match(tableRendererSource, /"text\/html": table\.outerHTML/u);
  assert.match(tableRendererSource, /aria-label="Expand table"/u);
  assert.match(tableStyles, /width: calc\(100% \+ var\(--chat-table-gutter\) \* 2\)/u);
  assert.match(tableStyles, /border-collapse: separate/u);
  assert.match(tableStyles, /100cqw/u);
  assert.match(tableStyles, /--chat-table-toolbar-padding: calc\(var\(--padding-toolbar, 16px\) \* 2\)/u);
  assert.match(tableStyles, /\.chat-table-numeric \{[\s\S]{0,160}?white-space: nowrap;/u);
  assert.doesNotMatch(tableStyles, /min-width:[^;]*100vw/u);
  assert.match(tableStyles, /white-space: normal/u);
  assert.doesNotMatch(tableStyles, /\.chat-table-(?:scroll|container)[^{]*\{[^}]*border:\s*1px solid/u);
});

test("code fences reset the browser figure inset and retain the transcript reading axis", () => {
  assert.match(
    codeBlockStyles,
    /\.chat-code-block\s*\{[\s\S]{0,320}?margin-block:\s*14px;[\s\S]{0,320}?margin-inline:\s*0;/u,
  );
});

test("an incomplete Mermaid fence remains an open source block", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile("Before\n\n```mer\ngraph TD\nA-->B", { streaming: true });
  const code = flatten(parsed.nodes).find((node) => node.kind === "code-fence");
  assert.equal(code?.kind, "code-fence");
  if (code?.kind !== "code-fence") return;
  assert.equal(code.language, "mer");
  assert.equal(code.completeness, "open");
  assert.match(code.code, /graph TD/);
});

test("streaming markdown stabilizes incomplete Codex syntax without mutating canonical source", () => {
  const image = preprocessChatMarkdown("Ready\n\n![screen](https://assets.exam", { streaming: true });
  assert.equal(image.markdown, "Ready\n\n");

  const link = preprocessChatMarkdown("Read [the source](file:///vela/src", { streaming: true });
  assert.equal(link.markdown, "Read the source");

  const emphasis = preprocessChatMarkdown("This is **still streaming", { streaming: true });
  assert.equal(emphasis.markdown, "This is **still streaming**");

  const inlineCode = preprocessChatMarkdown("Use `unfinished", { streaming: true });
  assert.equal(inlineCode.markdown, "Use `unfinished");

  const reference = preprocessChatMarkdown("Visible\uE200partial-control", { streaming: true });
  assert.equal(reference.markdown, "Visible");
});

test("isolated HTML breaks retain Codex layout semantics without enabling arbitrary HTML", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile("before<br>after\n\n<script>alert(1)</script>");
  const nodes = flatten(parsed.nodes);
  assert.ok(nodes.some((node) => node.kind === "line-break"));
  assert.ok(nodes.some((node) => node.kind === "text" && node.text.includes("<script>")));
});

test("Codex math tokenizers ignore dollar prose and never change fenced source", () => {
  const input = "Price is $5, not $10. Inline \\(x^2\\).\n\n\\[y^2\\]\n\n```tex\n\\(inside\\)\n```";
  const compiler = new ChatDocumentCompiler();
  const nodes = flatten(compiler.compile(input).nodes);
  assert.ok(nodes.some((node) => node.kind === "math" && node.source === "x^2" && !node.display));
  assert.ok(nodes.some((node) => node.kind === "math" && node.source === "y^2" && node.display));
  assert.ok(nodes.some((node) => node.kind === "text" && node.text.includes("$5, not $10")));
  assert.ok(nodes.some((node) => node.kind === "code-fence" && node.code.includes("\\(inside\\)")));
});

test("streaming session preserves node and segment identity across appends", () => {
  const session = new ChatDocumentStreamingSession("message-1");
  const first = session.compile("Hello", { streaming: true });
  first.commit();
  const firstText = flatten(first.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(firstText?.kind, "text");

  const second = session.compile("Hello world", { streaming: true });
  const secondText = flatten(second.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(secondText?.kind, "text");
  if (firstText?.kind !== "text" || secondText?.kind !== "text") return;
  assert.equal(secondText.stableKey, firstText.stableKey);
  assert.equal(secondText.segments[0]?.key, firstText.segments[0]?.key);
  assert.equal(secondText.segments.at(-1)?.entering, true);
  second.commit();

  const completed = session.compile("Hello world", { streaming: false });
  const completedText = flatten(completed.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(completedText?.kind, "text");
  if (completedText?.kind === "text") assert.ok(completedText.segments.every((segment) => !segment.entering));
});

test("ASCII streaming segmentation follows Codex punctuation ownership", () => {
  const session = new ChatDocumentStreamingSession("message-ascii-segments");
  const first = session.compile("Hello, ", { streaming: true });
  first.commit();
  const firstText = flatten(first.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(firstText?.kind, "text");
  if (firstText?.kind !== "text") return;
  assert.deepEqual(firstText.segments.map((segment) => segment.text), ["Hello, "]);

  const second = session.compile("Hello, world!", { streaming: true });
  const secondText = flatten(second.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(secondText?.kind, "text");
  if (secondText?.kind !== "text") return;
  assert.deepEqual(secondText.segments.map((segment) => segment.text), ["Hello, ", "world!"]);
  assert.equal(secondText.segments[0]?.key, firstText.segments[0]?.key);
  assert.equal(secondText.segments[0]?.entering, false);
  assert.equal(secondText.segments[1]?.entering, true);
});

test("streaming fade identity is global when Markdown reparses around existing text", () => {
  const session = new ChatDocumentStreamingSession("message-global-segments");
  const first = session.compile("Hello world", { streaming: true });
  first.commit();
  const firstText = flatten(first.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(firstText?.kind, "text");
  if (firstText?.kind !== "text") return;

  const quoted = session.compile("> Hello world", { streaming: true });
  const quotedText = flatten(quoted.snapshot.nodes).find((node) => node.kind === "text");
  assert.equal(quotedText?.kind, "text");
  if (quotedText?.kind !== "text") return;
  assert.deepEqual(
    quotedText.segments.map((segment) => segment.key),
    firstText.segments.map((segment) => segment.key),
  );
  assert.ok(quotedText.segments.every((segment) => !segment.entering));
});

test("link labels suppress nested Codex text decorations", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = flatten(compiler.compile("[$skill @repo/src #AABBCC](https://example.com)").nodes);
  const link = parsed.find((node) => node.kind === "link");
  assert.equal(link?.kind, "link");
  if (link?.kind !== "link") return;
  assert.deepEqual(link.children.map((node) => node.kind), ["text"]);
  assert.equal(link.children[0]?.kind === "text" ? link.children[0].text : null, "$skill @repo/src #AABBCC");
});

test("streaming semantic identity survives prefix insertion and a growing fence language", () => {
  const session = new ChatDocumentStreamingSession("message-semantic-identity");
  const first = session.compile([
    "Alpha paragraph.",
    "",
    "Beta paragraph.",
    "",
    "```mer",
    "graph TD",
  ].join("\n"), { streaming: true });
  first.commit();
  const firstNodes = first.snapshot.nodes;
  const alphaKey = firstNodes[0]?.stableKey;
  const betaKey = firstNodes[1]?.stableKey;
  const fenceKey = firstNodes[2]?.stableKey;

  const second = session.compile([
    "Inserted paragraph.",
    "",
    "Alpha paragraph.",
    "",
    "Beta paragraph.",
    "",
    "```mermaid",
    "graph TD",
  ].join("\n"), { streaming: true });
  assert.equal(second.snapshot.nodes[1]?.stableKey, alphaKey);
  assert.equal(second.snapshot.nodes[2]?.stableKey, betaKey);
  assert.equal(second.snapshot.nodes[3]?.stableKey, fenceKey);
  assert.notEqual(second.snapshot.nodes[0]?.stableKey, alphaKey);
});

test("abandoned candidates cannot poison committed streaming identity", () => {
  const session = new ChatDocumentStreamingSession("message-2");
  const base = session.compile("one", { streaming: true });
  base.commit();
  const abandoned = session.compile("one abandoned", { streaming: true });
  const accepted = session.compile("one accepted", { streaming: true });
  accepted.commit();
  abandoned.commit();
  assert.equal(session.getSnapshot()?.source, "one accepted");
});

test("typed directives are separated from prose", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile("::artifact{path=\"report.html\" mode=preview}");
  const directive = parsed.nodes[0];
  assert.equal(directive?.kind, "directive");
  if (directive?.kind === "directive") {
    assert.equal(directive.name, "artifact");
    assert.equal(directive.attributes.path, "report.html");
    assert.equal(directive.attributes.mode, "preview");
  }
});

test("Codex bracket file citations become typed navigable directives", () => {
  const compiler = new ChatDocumentCompiler();
  const nodes = flatten(compiler.compile("See 【src/runtime.ts†L12-L18】 before editing.").nodes);
  const citation = nodes.find((node) => node.kind === "directive");
  assert.equal(citation?.kind, "directive");
  if (citation?.kind !== "directive") return;
  assert.equal(citation.name, "codex-file-citation");
  assert.deepEqual(citation.attributes, {
    path: "src/runtime.ts",
    line_range_start: "12",
    line_range_end: "18",
  });
  assert.equal(citation.raw, "【src/runtime.ts†L12-L18】");
});

test("Codex text decorations lift skill variables, workspace mentions and color swatches", () => {
  const compiler = new ChatDocumentCompiler();
  const nodes = flatten(compiler.compile("Use $deploy and @src/main.ts with #12abef; issue #123456 stays plain.").nodes);
  assert.ok(nodes.some((node) => node.kind === "reference" && node.referenceKind === "variable" && node.text === "$deploy"));
  assert.ok(nodes.some((node) => node.kind === "reference" && node.referenceKind === "workspace-file" && node.text === "@src/main.ts"));
  assert.ok(nodes.some((node) => node.kind === "color-swatch" && node.color === "#12abef"));
  assert.equal(nodes.some((node) => node.kind === "color-swatch" && node.color === "#123456"), false);
});

test("Codex user-message dialect preserves Composer link semantics", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile([
    "Open [source\\]](file:///vela/src/a\\)b.ts) now.",
    "Malformed [source](file:///vela/src/a.ts remains literal",
    "![screen](https://assets.example.test/screen.png)",
  ].join("\n"), { dialect: "user-message" });
  const nodes = flatten(parsed.nodes);
  const links = nodes.filter((node) => node.kind === "link");
  assert.equal(links.length, 2);
  assert.equal(links[0]?.kind === "link" ? links[0].href : null, "file:///vela/src/a)b.ts");
  assert.equal(links[1]?.kind === "link" ? links[1].href : null, "https://assets.example.test/screen.png");
  assert.equal(nodes.some((node) => node.kind === "image"), false);
  assert.ok(nodes.flatMap((node) => node.kind === "text" ? [node.text] : []).join("").includes("Malformed [source](file:///vela/src/a.ts remains literal"));
  assert.ok(nodes.some((node) => node.kind === "text" && node.text === "!"));
});

test("Codex markdown-link scanner rejects empty, multiline, and incomplete targets", () => {
  assert.deepEqual(findMarkdownLink("x [label](file:///vela/a.ts) y", 0), {
    start: 2,
    end: 28,
    label: "label",
    path: "file:///vela/a.ts",
  });
  assert.equal(findMarkdownLink("[label]()", 0), null);
  assert.equal(findMarkdownLink("[label](file:///vela/a.ts", 0), null);
  assert.equal(findMarkdownLink("[label\n](file:///vela/a.ts)", 0), null);
});

test("Codex user-message block preprocessing separates list kinds and protects fences", () => {
  assert.equal(preprocessUserMessageMarkdown([
    "- bullet",
    "paragraph",
    "1. ordered",
    "```text",
    "- inside fence",
    "```",
  ].join("\n")), [
    "- bullet",
    "",
    "paragraph",
    "1. ordered",
    "",
    "```text",
    "- inside fence",
    "```",
  ].join("\n"));
});
