import assert from "node:assert/strict";
import test from "node:test";

import { highlightChatCodeHtml, highlightChatCodeTokens } from "@opencraft/chat-render-react/code-highlight";

test("shared Shiki grammar preserves native code text and matches Web theme colors", async () => {
  const code = "const answer = 42;\nconsole.log(answer);\n";
  const signal = new AbortController().signal;
  const [lines, html] = await Promise.all([
    highlightChatCodeTokens(code, "ts", "light", signal),
    highlightChatCodeHtml(code, "typescript", "light", signal),
  ]);
  assert.equal(lines.map(line => line.map(token => token.content).join("")).join("\n"), code);
  assert.ok(lines.flat().some(token => token.color.toLowerCase() !== "#0d0d0d"));
  assert.match(html, /class="shiki codex-light"/u);
});

test("cancelled syntax work cannot commit a stale result", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(highlightChatCodeTokens("let x = 1", "javascript", "light", controller.signal));
});
