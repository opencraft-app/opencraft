import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import type { ChatSurface } from "../../vela-chat-surface/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

const createdAt = "2026-06-22T00:00:00Z";

test("conversation renderer preserves full assistant text through surface to DOM", async () => {
  const html = await renderSurfaceToHtml({
    session_id: "sess_render_full_text",
    conversation: {
      items: [
        userMessage("user_1", "今天写一首诗", "turn_1", "2026-06-22T00:00:00Z"),
        turnMeta("turn_1", "completed", "2026-06-22T00:00:00Z", "2026-06-22T00:00:12Z"),
        agentWork("work_1", "turn_1", "completed", "shell", "date +%Y年%m月%d日是%A", "2026-06-22T00:00:03Z"),
        assistantMessage("assistant_1", finalPoem(), "turn_1", "completed", "2026-06-22T00:00:12Z"),
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
    stream: { connected: true, running: false },
  });
  const text = textContentFromHtml(html);

  assertInOrder(text, [
    "今天写一首诗",
    "已处理 12s",
    "Ran command",
    "date +%Y年%m月%d日是%A",
    "秋夜怀古",
    "秦时明月依旧",
    "心中却多了几分旷远。",
  ]);
});

test("conversation renderer keeps streaming assistant markdown in one live item", async () => {
  const { items, html } = await renderSurfaceToItemsAndHtml({
    session_id: "sess_render_stream_tail",
    conversation: {
      items: [
        userMessage("user_1", "继续", "turn_1", "2026-06-22T00:00:00Z"),
        turnMeta("turn_1", "running", "2026-06-22T00:00:00Z", "2026-06-22T00:00:00Z"),
        assistantMessage(
          "assistant_1",
          [
            "第一段已经稳定。",
            "",
            "第二段也已经稳定。",
            "",
            "最后一段正在流式输出，心中却多了几分旷远。",
          ].join("\n"),
          "turn_1",
          "streaming",
          "2026-06-22T00:00:04Z",
        ),
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
    stream: { connected: true, running: true },
  });
  const assistantItems = items.filter((item) => item.kind === "assistant_markdown");
  const text = textContentFromHtml(html);

  assert.equal(assistantItems.length, 1);
  assert.equal(assistantItems[0]?.live, true);
  assert.equal(assistantItems[0]?.continuation, false);
  assertInOrder(text, [
    "第一段已经稳定。",
    "第二段也已经稳定。",
    "最后一段正在流式输出，心中却多了几分旷远。",
  ]);
});

test("conversation renderer update path does not lose completed tail text", async () => {
  const partialSurface = surfaceWithAssistantText({
    sessionId: "sess_render_update",
    status: "streaming",
    text: "夜深了，我转身离去，心中却多",
  });
  const completedSurface = surfaceWithAssistantText({
    sessionId: "sess_render_update",
    status: "completed",
    text: "夜深了，我转身离去，心中却多了几分旷远。",
  });

  const partialText = textContentFromHtml(await renderSurfaceToHtml(partialSurface));
  const completedText = textContentFromHtml(await renderSurfaceToHtml(completedSurface));

  assert.match(partialText, /心中却多/);
  assert.doesNotMatch(partialText, /心中却多了几分旷远。/);
  assert.match(completedText, /夜深了，我转身离去，心中却多了几分旷远。/);
});

test("conversation renderer keeps agent work groups from swallowing neighboring assistant text", async () => {
  const html = await renderSurfaceToHtml({
    session_id: "sess_render_work_neighbors",
    conversation: {
      items: [
        userMessage("user_1", "分析项目", "turn_1", "2026-06-22T00:00:00Z"),
        turnMeta("turn_1", "completed", "2026-06-22T00:00:00Z", "2026-06-22T00:00:18Z"),
        agentWork("work_1", "turn_1", "completed", "shell", "ls -la", "2026-06-22T00:00:01Z"),
        agentWork("work_2", "turn_1", "completed", "read", "README.md", "2026-06-22T00:00:02Z"),
        assistantMessage(
          "assistant_1",
          "我已经读取了 README，项目核心是本地优先的 agent runtime。",
          "turn_1",
          "completed",
          "2026-06-22T00:00:10Z",
        ),
        agentWork("work_3", "turn_1", "completed", "shell", "npm test", "2026-06-22T00:00:12Z"),
        assistantMessage(
          "assistant_2",
          "测试已经通过，最终结论没有被工具组折叠吞掉。",
          "turn_1",
          "completed",
          "2026-06-22T00:00:18Z",
        ),
      ],
      window: {
        first_item_id: "user_1",
        last_item_id: "assistant_2",
        has_older: false,
        has_newer: false,
      },
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: true, running: false },
  });
  const text = textContentFromHtml(html);

  assertInOrder(text, [
    "已运行 1 条命令并读取 1 个文件",
    "我已经读取了 README",
    "Ran command",
    "npm test",
    "最终结论没有被工具组折叠吞掉。",
  ]);
});

async function renderSurfaceToHtml(surface: ChatSurface): Promise<string> {
  return (await renderSurfaceToItemsAndHtml(surface)).html;
}

async function renderSurfaceToItemsAndHtml(surface: ChatSurface) {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
  const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
  const {
    buildConversationRuntimeSegments,
    buildConversationStreamItems,
  } = await import("../src/conversation-runtime/model");
  const { VelaTurnList } = await import("../src/components/conversation/VelaTurnList");

  const webModel = toWebChatModel(
    buildChatRenderModel(surface, { kind: "desktop_web" }),
  );
  const items = buildConversationStreamItems(webModel.turns);
  const segments = buildConversationRuntimeSegments(items, {
    partialVirtualizationEnabled: false,
  });
  const html = renderToStaticMarkup(
    React.createElement(VelaTurnList, {
      hostKind: "desktop_web",
      segments,
    }),
  );

  return { html, items };
}

function surfaceWithAssistantText({
  sessionId,
  status,
  text,
}: {
  sessionId: string;
  status: "streaming" | "completed";
  text: string;
}): ChatSurface {
  return {
    session_id: sessionId,
    conversation: {
      items: [
        userMessage("user_1", "继续写", "turn_1", "2026-06-22T00:00:00Z"),
        turnMeta("turn_1", status === "completed" ? "completed" : "running", "2026-06-22T00:00:00Z", "2026-06-22T00:00:05Z"),
        assistantMessage("assistant_1", text, "turn_1", status, "2026-06-22T00:00:05Z"),
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
    stream: { connected: true, running: status === "streaming" },
  };
}

function userMessage(
  id: string,
  text: string,
  turnId: string,
  at: string,
): ChatSurface["conversation"]["items"][number] {
  return {
    id,
    kind: "user_message",
    text,
    parts: [{ id: `${id}:part:0`, type: "text", text }],
    created_at: at,
    updated_at: at,
    turn_id: turnId,
    status: "completed",
    revision: 1,
    debug: debug(`evt_${id}`),
  };
}

function assistantMessage(
  id: string,
  text: string,
  turnId: string,
  status: "streaming" | "completed",
  at: string,
): ChatSurface["conversation"]["items"][number] {
  return {
    id,
    kind: "assistant_message",
    text,
    parts: [{ id: `${id}:part:0`, type: "text", text }],
    created_at: at,
    updated_at: at,
    turn_id: turnId,
    status,
    revision: status === "completed" ? 2 : 1,
    debug: debug(`evt_${id}`),
  };
}

function turnMeta(
  turnId: string,
  status: "running" | "completed",
  startedAt: string,
  updatedAt: string,
): ChatSurface["conversation"]["items"][number] {
  return {
    id: `turn_meta:${turnId}`,
    kind: "turn_meta",
    turn_id: turnId,
    created_at: startedAt,
    updated_at: updatedAt,
    completed_at: status === "completed" ? updatedAt : null,
    status,
    revision: 1,
    debug: debug(`evt_${turnId}`),
  };
}

function agentWork(
  id: string,
  turnId: string,
  status: "completed",
  detailType: "shell" | "read",
  value: string,
  at: string,
): ChatSurface["conversation"]["items"][number] {
  return {
    id,
    kind: "agent_work",
    title: detailType === "shell" ? "Tool" : "read",
    summary: value,
    detail:
      detailType === "shell"
        ? { type: "shell", command: value }
        : { type: "read", file_path: value },
    created_at: at,
    updated_at: at,
    turn_id: turnId,
    status,
    revision: 1,
    debug: debug(`evt_${id}`),
  };
}

function finalPoem(): string {
  return [
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
}

function debug(eventId: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [eventId],
    source_event_ranges: [],
  };
}

function assertInOrder(text: string, expected: readonly string[]) {
  let cursor = 0;
  for (const value of expected) {
    const index = text.indexOf(value, cursor);
    assert.notEqual(index, -1, `expected rendered text to include "${value}" after index ${cursor}`);
    cursor = index + value.length;
  }
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
