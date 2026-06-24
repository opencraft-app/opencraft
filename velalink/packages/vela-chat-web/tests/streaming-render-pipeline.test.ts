import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { buildChatRenderModel } from "../../vela-chat-render-model/src";
import type { ChatSurface } from "../../vela-chat-surface/src";
import { toWebChatModel } from "../src/adapters/toWebBlocks";
import { buildConversationStreamItems } from "../src/conversation-runtime/model";
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

register(new URL("./css-module-loader.mjs", import.meta.url));

test("streaming render pipeline preserves final assistant tail across read-model snapshots", async () => {
  const snapshots = [
    surfaceSnapshot({
      status: "streaming",
      text: "夜深了，我转身离去，心中却多",
    }),
    surfaceSnapshot({
      status: "streaming",
      text: "夜深了，我转身离去，心中却多了几分",
    }),
    surfaceSnapshot({
      status: "completed",
      text: "夜深了，我转身离去，心中却多了几分旷远。",
    }),
  ];
  const cache = createStreamingTokenCache();
  let buffer = createLiveTextBufferState("");
  let finalRenderedText = "";

  for (const snapshot of snapshots) {
    const item = onlyAssistantItem(snapshot);
    const targetText = item.block.kind === "assistant_markdown"
      ? item.block.blocks.map((block) => block.text).join("\n\n")
      : "";
    buffer = setLiveTextBufferTarget(
      buffer,
      targetText,
      item.live ? "streaming" : "settling",
    );
    buffer = stepLiveTextBuffer(buffer, item.live ? 33 : 200, {
      maxUnitsPerSecond: 48,
      minUnitsPerSecond: 28,
      settlingLatencyMs: 200,
      targetLatencyMs: 130,
    });
    const repaired = repairStreamingMarkdown(buffer.visibleText).markdown;
    const tokens = parseStreamingMarkdownTokens(repaired, cache);
    finalRenderedText = await renderTokensToText(tokens);

    assert.equal(targetText.startsWith(buffer.visibleText), true);
    assert.equal(finalRenderedText.length <= targetText.length, true);
  }

  assert.equal(buffer.visibleText, "夜深了，我转身离去，心中却多了几分旷远。");
  assert.match(finalRenderedText, /心中却多了几分旷远。/);
});

test("streaming render pipeline keeps streaming assistant markdown as one stable item", async () => {
  const snapshot = surfaceSnapshot({
    status: "streaming",
    text: [
      "第一段已经稳定。",
      "",
      "| 模块 | 职责 |",
      "| --- | --- |",
      "| `vela-core` | 核心接口 |",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "最后一段正在流式输出，心中却多了几分旷远。",
    ].join("\n"),
  });
  const items = assistantItems(snapshot);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.live, true);
  assert.equal(items[0]?.continuation, false);

  const text = await renderTokensToText(
    parseStreamingMarkdownTokens(
      repairStreamingMarkdown(assistantText(items[0]!)).markdown,
      createStreamingTokenCache(),
    ),
  );

  assert.match(text, /第一段已经稳定。/);
  assert.match(text, /vela-core/);
  assert.match(text, /npm test/);
  assert.match(text, /心中却多了几分旷远。/);
});

test("streaming render pipeline keeps assistant item identity stable when markdown splits", () => {
  const oneBlockSnapshot = surfaceSnapshot({
    status: "streaming",
    text: "第一段正在流式输出，还没有段落边界，第二段内容已经露出一些。",
  });
  const splitSnapshot = surfaceSnapshot({
    status: "streaming",
    text: [
      "第一段正在流式输出。",
      "",
      "第二段内容已经露出一些，并继续增长。",
    ].join("\n"),
  });

  const itemBefore = onlyAssistantItem(oneBlockSnapshot);
  const itemAfter = onlyAssistantItem(splitSnapshot);

  assert.equal(itemBefore.key, itemAfter.key);
  assert.equal(itemAfter.live, true);
  assert.match(assistantText(itemAfter), /第二段内容已经露出一些/);
});

test("streaming render pipeline keeps completed assistant markdown as one render item", () => {
  const completedSnapshot = surfaceSnapshot({
    status: "completed",
    text: [
      "第一段已经稳定。",
      "",
      "第二段也已经完成。",
      "",
      "第三段完成。",
    ].join("\n"),
  });

  const items = assistantItems(completedSnapshot);

  assert.equal(items.length, 1);
  assert.equal(items[0]?.live, false);
});

function onlyAssistantItem(surface: ChatSurface) {
  const items = assistantItems(surface);
  assert.equal(items.length, 1);
  return items[0]!;
}

function assistantItems(surface: ChatSurface) {
  const webModel = toWebChatModel(buildChatRenderModel(surface, { kind: "desktop_web" }));
  return buildConversationStreamItems(webModel.turns).filter(
    (item) => item.kind === "assistant_markdown",
  );
}

function assistantText(item: ReturnType<typeof assistantItems>[number]): string {
  return item.block.kind === "assistant_markdown"
    ? item.block.blocks.map((block) => block.text).join("\n\n")
    : "";
}

async function renderTokensToText(tokens: unknown[]): Promise<string> {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { renderMarkdownTokens } = await import("../src/renderers/markdown/renderTokens");
  return textContentFromHtml(
    renderToStaticMarkup(React.createElement(React.Fragment, null, renderMarkdownTokens(tokens as never[]))),
  );
}

function surfaceSnapshot({
  status,
  text,
}: {
  status: "streaming" | "completed";
  text: string;
}): ChatSurface {
  const running = status === "streaming";
  return {
    session_id: "sess_streaming_pipeline",
    conversation: {
      items: [
        {
          id: "user_1",
          kind: "user_message",
          text: "继续",
          parts: [{ id: "user_1:part:0", type: "text", text: "继续" }],
          created_at: "2026-06-22T00:00:00Z",
          updated_at: "2026-06-22T00:00:00Z",
          turn_id: "turn_1",
          status: "completed",
          revision: 1,
          debug: debug("evt_user_1"),
        },
        {
          id: "turn_meta:turn_1",
          kind: "turn_meta",
          turn_id: "turn_1",
          created_at: "2026-06-22T00:00:00Z",
          updated_at: running ? "2026-06-22T00:00:00Z" : "2026-06-22T00:00:04Z",
          completed_at: running ? null : "2026-06-22T00:00:04Z",
          status: running ? "running" : "completed",
          revision: 1,
          debug: debug("evt_turn_1"),
        },
        {
          id: "assistant_1",
          kind: "assistant_message",
          text,
          parts: [{ id: "assistant_1:part:0", type: "text", text }],
          created_at: "2026-06-22T00:00:01Z",
          updated_at: "2026-06-22T00:00:04Z",
          turn_id: "turn_1",
          status,
          revision: status === "completed" ? 3 : 1,
          debug: debug("evt_assistant_1"),
        },
      ],
      window: {
        first_item_id: "user_1",
        last_item_id: "assistant_1",
        has_older: false,
        has_newer: false,
      },
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: true, running },
  };
}

function debug(eventId: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [eventId],
    source_event_ranges: [],
  };
}

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
