import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatDocumentCompiler,
  chatDocumentPlainText,
  ChatDocumentStreamingSession,
  findMarkdownLink,
  preprocessChatMarkdown,
  preprocessUserMessageMarkdown,
  type ChatDocumentNode,
} from "@opencraft/chat-document";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function semanticDocument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticDocument);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "stableKey" && key !== "completeness")
    .map(([key, entry]) => [key, semanticDocument(entry)]));
}

test("streaming prefix cache preserves full-parser semantics at every input split", () => {
  const examples = [
    "    \"sampleServer\": {\n\n      \"url\": \"https://example.test/mcp\",\n\n\"timeout\": 20000,\n\n\"headers\": {\n\n\"PRIVATE-TOKEN\": \"REDACTED\"\n\n      },\n\n\"transportType\": \"streamable-http\"\n\n    }",
    "- a\n\n- b",
    "- a\n\n  continuation\n\n  - nested\n\n- b\n\nnext",
    "1. one\n\n2. two\n\nnext",
    "    a\n\n    b\n\nnext",
    "> a\n>\n> b\n\nlazy continuation\n\nnext",
    "[x][id]\n\n[id]: https://example.com",
    "[id]: https://example.com\n\n[x][id]",
    "````\na\n```\n\nb\n````\n\nnext",
    "~~~ts\na\n~~~ wrong closer\nb\n~~~\n\nnext",
    "title\n---\n\n| a | b |\n| --- | --- |\n| x | y |\n\nnext",
    "first **bold**\n\nsecond *italic*\n\nthird",
    "$$\na+b\n$$\n\nnext",
    "$$\na\n\nb\n$$\n\nnext",
    "<div>\ninside\n\nmore\n</div>\n\nnext",
    "same\n\nsame\n\nsame",
    'Before\n\n{\n  "nested": {\n    "value": true\n  }\n}after\n\nnext',
    '请使用 "sampleServer": {\n    "url": "https://example.test"\n\n}这个来提交',
  ];
  for (const dialect of ["assistant", "user-message"] as const) {
    for (const source of examples) {
      const compiler = new ChatDocumentCompiler();
      for (let end = 1; end <= source.length; end++) {
        const input = source.slice(0, end);
        const normalized = dialect === "user-message" ? preprocessUserMessageMarkdown(input) : input;
        const repaired = preprocessChatMarkdown(normalized, { streaming: true }).markdown;
        const expected = new ChatDocumentCompiler().compile(repaired).nodes;
        assert.deepEqual(semanticDocument(compiler.compile(input, { dialect, streaming: true }).nodes),
          semanticDocument(expected), `${dialect} split ${end}: ${JSON.stringify(input)}`);
      }
    }
  }
});

test("stable nodes and segment identities are reused without replaying entering state", () => {
  const session = new ChatDocumentStreamingSession("prefix-reuse");
  const first = session.compile("稳定段落。\n\n正在", { streaming: true });
  first.commit();
  const second = session.compile("稳定段落。\n\n正在输出", { streaming: true });
  second.commit();
  const third = session.compile("稳定段落。\n\n正在输出更多", { streaming: true });
  assert.equal(second.snapshot.nodes[0]?.stableKey, first.snapshot.nodes[0]?.stableKey);
  assert.equal(third.snapshot.nodes[0], second.snapshot.nodes[0]);
  assert.ok(flatten(third.snapshot.nodes.slice(0, 1)).every((node) =>
    !("segments" in node) || node.segments.every((segment) => !segment.entering)));
});

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

test("document label projection preserves visible literals and block boundaries, not Markdown controls or targets", () => {
  const input = ["# **First**", "", "- *Read* [the file](file:///work/a.ts)", "- `a_b * literal` and \\*escaped\\*", "",
    "```js", "const a_b = '*';", "```", "", "![Screen](https://example.test/image.png)", "",
    "| **Name** | Value |", "| --- | --- |", "| entry | `a_b` |"].join("\n");
  const text = chatDocumentPlainText(new ChatDocumentCompiler().compile(input).nodes);
  assert.deepEqual(text.split(/\n/u).filter(Boolean), ["First", "Read the file", "a_b * literal and *escaped*",
    "const a_b = '*';", "Screen", "Name\tValue", "entry\ta_b"]);
  assert.doesNotMatch(text, /file:\/\/|https:\/\/|```|\*\*First|^- /mu);
});

test("document label projection shares streaming repair without modifying canonical source", () => {
  const source = "# **Calculating**\n\nRead [the source](file:///work/incomplete";
  const parsed = new ChatDocumentCompiler().compile(source, { streaming: true });
  assert.equal(parsed.source, source);
  assert.deepEqual(chatDocumentPlainText(parsed.nodes).split(/\n/u).filter(Boolean), ["Calculating", "Read the source"]);
  const html = new ChatDocumentCompiler().compile("<script>inert</script>\n\n**Current check**");
  assert.equal(chatDocumentPlainText(html.nodes).trim().split(/\n/u).at(-1), "Current check");
});

test("chat document compiles prose, GFM, code, math, links and tables", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile([
    "# Result",
    "",
    "Use **strong**, `inline()` and \\(x^2\\) at [source](file:///opencraft/a.ts).",
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
  assert.ok(nodes.some((node) => node.kind === "link" && node.href === "file:///opencraft/a.ts"));
  assert.ok(nodes.some((node) => node.kind === "list-item" && node.checked === true));
  assert.ok(nodes.some((node) => node.kind === "table" && node.rows.length === 1));
  assert.ok(nodes.some((node) => node.kind === "table" && node.markdownSource.startsWith("| name | value |")));
  assert.ok(nodes.some((node) => node.kind === "code-fence" && node.language === "ts" && node.completeness === "complete"));
});

test("Markdown prose preserves Han rhythm, nested-list grammar and block streaming entry", () => {
  assert.match(proseStyles, /> p\[data-markdown-han-text\]:has\(\+ p\[data-markdown-han-text\]\)/u);
  assert.match(proseStyles, /strong \{ font-weight: var\(--typography-prose-strong-weight\); \}/u);
  assert.match(proseStyles, /\.chat-media-paragraph \{[\s\S]{0,120}?text-align: left;/u);
  assert.match(proseStyles, /li \+ li \{ margin-top: 0\.5rem; \}/u);
  assert.match(proseStyles, /ul ul \{ list-style-type: circle; \}/u);
  assert.match(proseStyles, /ul ul ul \{ list-style-type: square; \}/u);
  assert.match(proseStyles, /:is\(\.chat-stream-fade-in, hr, li, tr, blockquote\)/u);
});

test("Markdown tables use the reading surface rather than a bordered card", () => {
  assert.match(tableRendererSource, /data-markdown-table="true"/u);
  assert.match(tableRendererSource, /"text\/plain": node\.markdownSource/u);
  assert.match(tableRendererSource, /"text\/html": table\.outerHTML/u);
  assert.match(tableRendererSource, /aria-label=\{intl\.formatMessage\(\{ id: "chat\.table\.expand", defaultMessage: "Expand table"/u);
  assert.match(tableStyles, /@include wide-content\.bounds/u);
  assert.match(tableStyles, /width: var\(--wide-block-width\)/u);
  assert.match(tableStyles, /border-collapse: separate/u);
  assert.doesNotMatch(tableStyles, /100cqw/u, "the reading surface supplies the wide-content budget");
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

test("nested and longer fences retain open state until their actual delimiter closes", () => {
  const compiler = new ChatDocumentCompiler();
  for (const source of ["> ```mermaid\n> graph TD\n> A-->B", "- code\n\n    ````mermaid\n    A-->B\n    ```"]) {
    const node = flatten(compiler.compile(source, { streaming: true }).nodes).find(node => node.kind === "code-fence");
    assert.equal(node?.completeness, "open");
  }
  const closed = flatten(compiler.compile("> ````mermaid\n> A-->B\n> ```\n> ````", { streaming: true }).nodes)
    .find(node => node.kind === "code-fence");
  assert.equal(closed?.completeness, "complete");
});

test("streaming suffix repairs preserve complete text and nested literal brackets", () => {
  const repair = (source: string) => preprocessChatMarkdown(source, { streaming: true }).markdown;
  for (const source of ["![complete](image.png)", "prefix ![partial", "![label] [reference]", "[label]", "[label]()", "[label](", "[label](url) trailing", "![line\ntext"]) {
    assert.equal(repair(source), source);
  }
  assert.equal(repair("Ready\n  ![label](url\n\t\n"), "Ready\n");
  assert.equal(repair("Ready\n![label]  \n"), "Ready\n");
  assert.equal(repair("[outer[inner](target"), "outer[inner");
  assert.equal(repair("[] before [label](target"), "[] before label");
  assert.equal(repair("[label](one](two"), "label");
  assert.equal(repair("a\uE200one\uE200two"), "a");
  assert.equal(repair("a\uE200complete\uE201b\uE200partial"), "a\uE200complete\uE201b");
});

test("streaming suffix repair handles adversarial marker runs without repeated suffix scans", () => {
  const length = 128_000;
  const sources = ["\uE200".repeat(length) + "\uE201", "![" + " ".repeat(length) + "])", "[\\".repeat(length) + "](x)", "[\\](" + "[(]((".repeat(length) + ")"];
  const started = performance.now();
  for (const source of sources) assert.equal(preprocessChatMarkdown(source, { streaming: true }).markdown, source);
  assert.ok(performance.now() - started < 5_000, "suffix repair must remain responsive on repeated markers");
});

test("streaming markdown stabilizes incomplete syntax without mutating canonical source", () => {
  const image = preprocessChatMarkdown("Ready\n\n![screen](https://assets.exam", { streaming: true });
  assert.equal(image.markdown, "Ready\n\n");

  const link = preprocessChatMarkdown("Read [the source](file:///opencraft/src", { streaming: true });
  assert.equal(link.markdown, "Read the source");

  const emphasis = preprocessChatMarkdown("This is **still streaming", { streaming: true });
  assert.equal(emphasis.markdown, "This is **still streaming**");

  const inlineCode = preprocessChatMarkdown("Use `unfinished", { streaming: true });
  assert.equal(inlineCode.markdown, "Use `unfinished");

  const reference = preprocessChatMarkdown("Visible\uE200partial-control", { streaming: true });
  assert.equal(reference.markdown, "Visible");
});

test("isolated HTML breaks retain layout semantics without enabling arbitrary HTML", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile("before<br>after\n\n<script>alert(1)</script>");
  const nodes = flatten(parsed.nodes);
  assert.ok(nodes.some((node) => node.kind === "line-break"));
  assert.ok(nodes.some((node) => node.kind === "text" && node.text.includes("<script>")));
});

test("math tokenizers ignore dollar prose and never change fenced source", () => {
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

test("ASCII streaming segmentation preserves punctuation ownership", () => {
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

test("link labels suppress nested text decorations", () => {
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
  assert.equal(citation.name, "file-citation");
  assert.deepEqual(citation.attributes, {
    path: "src/runtime.ts",
    line_range_start: "12",
    line_range_end: "18",
  });
  assert.equal(citation.raw, "【src/runtime.ts†L12-L18】");
});

test("Text decorations lift skill variables, workspace mentions and color swatches", () => {
  const compiler = new ChatDocumentCompiler();
  const nodes = flatten(compiler.compile("Use $deploy and @src/main.ts with #12abef; issue #123456 stays plain.").nodes);
  assert.ok(nodes.some((node) => node.kind === "reference" && node.referenceKind === "variable" && node.text === "$deploy"));
  assert.ok(nodes.some((node) => node.kind === "reference" && node.referenceKind === "workspace-file" && node.text === "@src/main.ts"));
  assert.ok(nodes.some((node) => node.kind === "color-swatch" && node.color === "#12abef"));
  assert.equal(nodes.some((node) => node.kind === "color-swatch" && node.color === "#123456"), false);
});

test("The user-message dialect preserves Composer link semantics", () => {
  const compiler = new ChatDocumentCompiler();
  const parsed = compiler.compile([
    "Open [source\\]](file:///opencraft/src/a\\)b.ts) now.",
    "Malformed [source](file:///opencraft/src/a.ts remains literal",
    "![screen](https://assets.example.test/screen.png)",
  ].join("\n"), { dialect: "user-message" });
  const nodes = flatten(parsed.nodes);
  const links = nodes.filter((node) => node.kind === "link");
  assert.equal(links.length, 2);
  assert.equal(links[0]?.kind === "link" ? links[0].href : null, "file:///opencraft/src/a)b.ts");
  assert.equal(links[1]?.kind === "link" ? links[1].href : null, "https://assets.example.test/screen.png");
  assert.equal(nodes.some((node) => node.kind === "image"), false);
  assert.ok(nodes.flatMap((node) => node.kind === "text" ? [node.text] : []).join("").includes("Malformed [source](file:///opencraft/src/a.ts remains literal"));
  assert.ok(nodes.some((node) => node.kind === "text" && node.text === "!"));
});

test("The Markdown-link scanner rejects empty, multiline, and incomplete targets", () => {
  assert.deepEqual(findMarkdownLink("x [label](file:///opencraft/a.ts) y", 0), {
    start: 2,
    end: 33,
    label: "label",
    path: "file:///opencraft/a.ts",
  });
  assert.equal(findMarkdownLink("[label]()", 0), null);
  assert.equal(findMarkdownLink("[label](file:///opencraft/a.ts", 0), null);
  assert.equal(findMarkdownLink("[label\n](file:///opencraft/a.ts)", 0), null);
});

test("User-message block preprocessing separates list kinds and protects fences", () => {
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


test("Han-adjacent punctuation emphasis from the Capacitor reply renders without literal markers", () => {
  const compiler = new ChatDocumentCompiler();
  const source = '你找不到是正常的，**Capacitor 不是 App Store 里的应用，而是供开发者制作 App 的框架。**官网是 [capacitorjs.com](https://capacitorjs.com)。\n\n如果你要找的是***“下载一个现成的 iOS App，就能打开网页，并给网页提供额外原生能力”***，Capacitor 不符合。';
  for (const dialect of ["assistant", "user-message"] as const) {
    for (const streaming of [false, true]) {
      const parsed = compiler.compile(source, { dialect, streaming });
      assert.equal(parsed.source, source);
      const nodes = flatten(parsed.nodes);
      const strong = nodes.filter(node => node.kind === "strong");
      assert.equal(strong.length, 2);
      assert.ok(nodes.some(node => node.kind === "emphasis"));
      assert.match(chatDocumentPlainText(strong[0].children), /Capacitor.*框架。/u);
      assert.match(chatDocumentPlainText(strong[1].children), /“下载.*原生能力”/u);
      assert.doesNotMatch(chatDocumentPlainText(parsed.nodes), /\*\*/u);
      assert.ok(nodes.some(node => node.kind === "link" && node.href === "https://capacitorjs.com"));
    }
  }
});

test("Han emphasis relaxation preserves code, escaped delimiters and English punctuation rules", () => {
  const compiler = new ChatDocumentCompiler();
  for (const source of ['`是***“代码”***`', '```text\n**句子。**后文\n```', String.raw`是\*\*“原样”\*\*`, 'word**“quoted”**word', '** leading**', '**trailing **']) {
    const parsed = compiler.compile(source);
    assert.equal(flatten(parsed.nodes).filter(node => node.kind === "strong").length, 0, source);
  }
  const parsed = compiler.compile('**包含 `**。**后文` 的句子。**结束');
  assert.equal(flatten(parsed.nodes).filter(node => node.kind === "strong").length, 1);
  assert.ok(flatten(parsed.nodes).some(node => node.kind === "inline-code" && node.code === '**。**后文'));
  assert.equal(chatDocumentPlainText(compiler.compile('是***“还在输出').nodes).trimEnd(), '是***“还在输出');
});


test("Bare multiline JSON and named configuration stay in one lossless code block", () => {
  const config = '"sampleServer": {\n    "url": "https://example.test/mcp",\n\n  "timeout": 20000,\n\n  "headers": {\n\n  "PRIVATE-TOKEN": "REDACTED"\n    },\n\n  "transportType": "streamable-http"\n}';
  for (const code of [config, `{${config}}`, '[\n  {"value": "escaped \\\" } [ and **literal**"},\n  true\n]']) {
    const source = `请使用  ${code}这个来提交`;
    for (const dialect of ["assistant", "user-message"] as const) {
      const compiler = new ChatDocumentCompiler();
      for (const streaming of [false, true]) {
        const parsed = compiler.compile(source, { dialect, streaming });
        assert.equal(parsed.source, source);
        const blocks = flatten(parsed.nodes).filter(node => node.kind === "code-fence");
        assert.equal(blocks.length, 1, source);
        assert.equal(blocks[0].code, code);
        assert.equal(blocks[0].language, "json");
        assert.equal(source.slice(blocks[0].sourceRange.start, blocks[0].sourceRange.end), code);
        assert.match(chatDocumentPlainText(parsed.nodes), /这个来提交/u);
      }
    }
  }
});

test("JSON recognition preserves fences, inline snippets, Markdown containers and invalid input", () => {
  const compiler = new ChatDocumentCompiler();
  for (const source of ['{"inline": true}', '`{"inline": true}`', '{\n  "value": invalid\n}', '{\n  "value": true', '- list\n  continuation', '> quote\n> continuation']) {
    assert.equal(flatten(compiler.compile(source).nodes).some(node => node.kind === "code-fence" && node.language === "json"), false, source);
  }
  const source = '```text\n{\n  "literal": true\n}\n```';
  const blocks = flatten(compiler.compile(source).nodes).filter(node => node.kind === "code-fence");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].language, "text");
  assert.equal(blocks[0].code, '{\n  "literal": true\n}');
});


test("Bare JSON leaves program statements and malformed nested input under Markdown", () => {
  for (const source of ['return {\n  "value": true\n};', 'callback({\n "value": true\n})', '{\n "value": true\n};', 'Text\n{\n{\n "nested": true\n}\ninvalid\n}']) {
    const nodes = flatten(new ChatDocumentCompiler().compile(source).nodes);
    assert.equal(nodes.some(node => node.kind === "code-fence" && node.language === "json"), false, source);
  }
});
