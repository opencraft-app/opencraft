import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MiniChat } from "../../apps/workbench-web/src/features/conversation-overview/mini-chat.tsx";

const render = (assistant: string, user = "再改一部分") => renderToStaticMarkup(createElement(MiniChat, {
  turns: [{ id: "previous", user, assistant }, { id: "last", user: "都点了", assistant: "已发布生效" }], emptyLabel: "没有文字",
}));

test("MiniChat projects shared Markdown semantics and chronological roles without mounting a chat runtime", () => {
  const html = render("已准备**上海 2 区**。\n\n- 保持 10 Mbps\n- 配置为 `servers/join`\n\n```sh\nprintf ready\n```\n\n| 环境 | 状态 |\n| --- | --- |\n| Server | ready |");
  assert.match(html, /data-minichat="readonly"/);
  assert.match(html, /<strong>上海 2 区<\/strong>/);
  assert.match(html, /<ul><li><p[^>]*>保持 10 Mbps<\/p><\/li>/);
  assert.match(html, /<code class="ui-text--inline-code">servers\/join<\/code>/);
  assert.match(html, /<pre[^>]*><code>printf ready/);
  assert.match(html, /<table>/);
  assert.ok(html.indexOf("再改一部分") < html.indexOf("都点了"));
  assert.equal((html.match(/mini-chat__exchange /g) ?? []).length, 2);
});

test("MiniChat untrusted links/media/HTML stay static text and never acquire interaction or loading DOM", () => {
  const html = render('[点这里](javascript:alert(1)) ![图片](https://untrusted.invalid/a.png)\n\n<script>window.attack=1</script>\n\n<iframe src="https://untrusted.invalid/"></iframe>');
  assert.doesNotMatch(html, /<(?:a|img|script|iframe|audio|video|button|input|textarea)\b/);
  assert.doesNotMatch(html, /<[^>]+\b(?:href|src|tabindex|contenteditable|onclick)=/);
  assert.match(html, /mini-chat__link/);
  assert.match(html, /mini-chat__attachment/);
  assert.doesNotMatch(html, /untrusted\.invalid\/a\.png/);
});
