import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveTextBufferState,
  setLiveTextBufferTarget,
  stepLiveTextBuffer,
} from "../src/renderers/markdown/liveTextBuffer";
import {
  createStreamingTokenCache,
  parseStreamingMarkdownTokens,
} from "../src/renderers/markdown/prefixTokenCache";
import { repairStreamingMarkdown } from "../src/renderers/markdown/streamingRepair";

test("streaming markdown pipeline preserves final text after buffered settling", () => {
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

  let buffer = createLiveTextBufferState("");
  buffer = setLiveTextBufferTarget(buffer, finalText, "streaming");
  buffer = stepLiveTextBuffer(buffer, 16, {
    maxUnitsPerSecond: 32,
    minUnitsPerSecond: 32,
    targetLatencyMs: 120,
  });
  assert.notEqual(buffer.visibleText, finalText);

  buffer = setLiveTextBufferTarget(buffer, finalText, "settling");
  buffer = stepLiveTextBuffer(buffer, 190, { settlingLatencyMs: 190 });

  const repaired = repairStreamingMarkdown(buffer.visibleText).markdown;
  const tokens = parseStreamingMarkdownTokens(repaired, createStreamingTokenCache());
  const tokenText = JSON.stringify(tokens);

  assert.equal(buffer.visibleText, finalText);
  assert.match(tokenText, /秋夜怀古/);
  assert.match(tokenText, /心中却多了几分旷远。/);
});
