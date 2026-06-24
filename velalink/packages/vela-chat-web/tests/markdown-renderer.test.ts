import assert from "node:assert/strict";
import test from "node:test";

import { parseMarkdownTokens } from "../src/renderers/markdown/parse";
import { createStreamingTokenCache, parseStreamingMarkdownTokens } from "../src/renderers/markdown/prefixTokenCache";
import { repairStreamingMarkdown } from "../src/renderers/markdown/streamingRepair";

test("streaming markdown repair closes an open fenced code block for parsing", () => {
  const repaired = repairStreamingMarkdown("```ts\nconst value = 1");

  assert.equal(repaired.isCodeFenceOpen, true);
  assert.equal(repaired.markdown, "```ts\nconst value = 1\n```");
});

test("streaming markdown repair suppresses partial image and link syntax", () => {
  assert.equal(repairStreamingMarkdown("before ![alt](htt").markdown, "before ");
  assert.equal(repairStreamingMarkdown("see [docs](htt").markdown, "see [docs](htt)");
  assert.equal(repairStreamingMarkdown("see [docs](https://example.com").markdown, "see [docs]");
});

test("streaming markdown repair balances unfinished emphasis only when it is safe", () => {
  assert.equal(repairStreamingMarkdown("hello **world").markdown, "hello **world**");
  assert.equal(repairStreamingMarkdown("hello **").markdown, "hello **");
  assert.equal(repairStreamingMarkdown("hello *world").markdown, "hello *world*");
});

test("streaming markdown parser reuses stable completed prefix tokens", () => {
  const cache = createStreamingTokenCache();
  const first = parseStreamingMarkdownTokens("Intro paragraph.\n\nTail one", cache);
  const second = parseStreamingMarkdownTokens("Intro paragraph.\n\nTail two", cache);

  assert.notEqual(first, second);
  assert.equal(first[0], second[0]);
  assert.notEqual(first[first.length - 1], second[second.length - 1]);
});

test("static markdown parser handles table and fenced code tokens", () => {
  const tokens = parseMarkdownTokens("| A | B |\n| - | - |\n| 1 | 2 |\n\n```bash\necho hi\n```");

  assert.equal(tokens[0]?.type, "table");
  assert.equal(tokens[1]?.type, "space");
  assert.equal(tokens[2]?.type, "code");
});
