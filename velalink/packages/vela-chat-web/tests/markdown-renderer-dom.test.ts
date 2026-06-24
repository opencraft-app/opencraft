import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./css-module-loader.mjs", import.meta.url));

const finalText = [
  "# 秋夜怀古",
  "",
  "夜色如墨，月光倾泻在古老的城。",
  "",
  "秦时明月依旧",
  "",
  "人生代代无穷已，江月年年望相似。历史的长河淘",
  "",
  "我站在城墙之上，俯瞰这座古老的城市。万家灯火，车水马龙，一",
  "",
  "秋风",
  "",
  "夜深了，我转身离去，心中却多了几分旷远。",
].join("\n");

test("completed markdown renderer keeps all visible Chinese text in rendered HTML", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MarkdownRenderer } = await import(
    "../src/renderers/markdown/MarkdownRenderer"
  );

  const html = renderToStaticMarkup(
    React.createElement(MarkdownRenderer, null, finalText),
  );

  assert.match(html, /秋夜怀古/);
  assert.match(html, /夜色如墨，月光倾泻在古老的城。/);
  assert.match(html, /人生代代无穷已，江月年年望相似。历史的长河淘/);
  assert.match(html, /心中却多了几分旷远。/);
});

test("streaming markdown renderer keeps all server-rendered text present", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { StreamingMarkdownRenderer } = await import(
    "../src/renderers/markdown/StreamingMarkdownRenderer"
  );

  const html = renderToStaticMarkup(
    React.createElement(
      StreamingMarkdownRenderer,
      { streaming: true },
      finalText,
    ),
  );
  const text = textContentFromHtml(html);

  assert.match(text, /秋夜怀古/);
  assert.match(text, /夜深了，我转身离去，心中却多了几分旷远。/);
  assert.doesNotMatch(html, /copy|download|fullscreen/i);
});

test("markdown renderer preserves tables and fenced code without third-party chrome", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MarkdownRenderer } = await import(
    "../src/renderers/markdown/MarkdownRenderer"
  );
  const markdown = [
    "## 核心模块",
    "",
    "| Crate | 职责 |",
    "| --- | --- |",
    "| `vela-core` | 核心接口定义 |",
    "| `vela-runtime` | 命令权限控制 |",
    "",
    "```bash",
    "npm test",
    "npm run build",
    "```",
  ].join("\n");

  const html = renderToStaticMarkup(
    React.createElement(MarkdownRenderer, null, markdown),
  );

  assert.match(html, /<table/);
  assert.match(html, /核心接口定义/);
  assert.match(html, /<pre/);
  assert.match(html, /npm test/);
  assert.doesNotMatch(html, /language[^>]*(copy|download|fullscreen)/i);
});

test("completed assistant markdown keeps one response container across multiple blocks", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AssistantMarkdownRenderer } = await import(
    "../src/renderers/blocks/AssistantMarkdownRenderer"
  );
  const block = {
    kind: "assistant_markdown",
    id: "assistant_settled",
    blocks: [
      { id: "assistant_settled:block:0", text: "第一段已经完成。" },
      { id: "assistant_settled:block:1", text: "第二段也应该保持同一套行距。" },
      { id: "assistant_settled:block:2", text: "第三段不能换成另一个 wrapper。" },
    ],
    streaming: false,
  };

  const html = renderToStaticMarkup(
    React.createElement(AssistantMarkdownRenderer, { block }),
  );
  const responseCount = (html.match(/class="messageResponse"/g) ?? []).length;

  assert.equal(responseCount, 1);
  assert.match(html, /第一段已经完成。/);
  assert.match(html, /第二段也应该保持同一套行距。/);
  assert.match(html, /第三段不能换成另一个 wrapper。/);
});

function textContentFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
