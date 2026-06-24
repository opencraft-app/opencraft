import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildChatRenderModel, splitMarkdownBlocks } from "../src";
import type {
  ChatSurface,
  ChatSurfaceConversationItem,
} from "../../vela-chat-surface/src";

const root = process.cwd();

function surface(items: ChatSurfaceConversationItem[] = []): ChatSurface {
  return {
    session_id: "sess_1",
    conversation: {
      items,
      window: {
        first_item_id: items[0]?.id ?? null,
        last_item_id: items[items.length - 1]?.id ?? null,
        has_older: false,
        has_newer: false,
      },
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };
}

function debug(source_event_ids: string[] = []) {
  return {
    projection: "conversation" as const,
    source_event_ids,
    source_event_ranges: source_event_ids.map((eventId, index) => ({
      epoch: 1,
      from_event_id: eventId,
      to_event_id: eventId,
      from_seq: index + 1,
      to_seq: index + 1,
    })),
  };
}

function baseItem(
  overrides: Partial<ChatSurfaceConversationItem> & Pick<ChatSurfaceConversationItem, "id" | "kind">,
): ChatSurfaceConversationItem {
  const base = {
    created_at: "2026-06-18T10:00:00Z",
    updated_at: "2026-06-18T10:00:00Z",
    revision: 1,
    status: "completed" as const,
    debug: debug([`evt_${overrides.id}`]),
  };

  switch (overrides.kind) {
    case "user_message":
      return {
        ...base,
        kind: "user_message",
        id: overrides.id,
        text: "",
        parts: [],
        ...overrides,
      };
    case "assistant_message":
      return {
        ...base,
        kind: "assistant_message",
        id: overrides.id,
        text: "",
        parts: [],
        ...overrides,
      };
    case "turn_meta":
      return {
        ...base,
        kind: "turn_meta",
        id: overrides.id,
        turn_id: "turn_1",
        ...overrides,
      };
    case "agent_work":
      return {
        ...base,
        kind: "agent_work",
        id: overrides.id,
        title: "Tool call",
        summary: "",
        ...overrides,
      };
    case "status":
      return {
        ...base,
        kind: "status",
        id: overrides.id,
        text: "",
        ...overrides,
      };
  }
}

test("agent work render row declares the agent work id it emits", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-render-model/src/agent-work/tools.ts"),
    "utf8",
  );

  assert.match(
    source,
    /export interface AgentWorkRenderRow \{[\s\S]*\n  agentWorkId\?: string;/,
  );
});

test("splits assistant markdown into stable blocks without splitting fenced code", () => {
  assert.deepEqual(
    splitMarkdownBlocks("先查入口。\n\n```ts\nconst x = 1\n\nconsole.log(x)\n```\n\n结论。"),
    ["先查入口。", "```ts\nconst x = 1\n\nconsole.log(x)\n```", "结论。"],
  );
});

test("turns conversation items into host-aware render rows", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "u1",
        kind: "user_message",
        turn_id: "turn_1",
        text: `${"a".repeat(640)}TAIL`,
        parts: [
          { id: "u1:part:0", type: "text", text: `${"a".repeat(640)}TAIL` },
          {
            id: "u1:part:1",
            type: "image",
            data: { mime_type: "image/png", data: "aGVsbG8=", size_bytes: 5 },
          },
        ],
      }),
      baseItem({
        id: "turn_meta:turn_1",
        kind: "turn_meta",
        turn_id: "turn_1",
        status: "running",
      }),
      baseItem({
        id: "a1",
        kind: "assistant_message",
        turn_id: "turn_1",
        text: "第一段\n\n第二段",
        status: "streaming",
        revision: 3,
      }),
      baseItem({
        id: "work_failed",
        kind: "agent_work",
        turn_id: "turn_1",
        status: "failed",
        title: "Backend error",
        summary: "No API key found for the selected model.",
        detail: { type: "plain_text", text: "No API key found for the selected model." },
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.equal(model.rows[0]?.kind, "user_message");
  assert.equal(model.rows[0]?.collapsed, true);
  assert.equal(model.rows[0]?.copy_text.endsWith("TAIL"), true);
  assert.equal(model.rows[0]?.parts[1]?.type, "image");
  assert.equal(model.rows[1]?.kind, "turn_meta");
  assert.equal(model.rows[1]?.label, "处理中");
  assert.equal(model.rows[2]?.kind, "agent_work");
  assert.equal(model.rows[2]?.kind === "agent_work" ? model.rows[2].status : "", "failed");
  assert.equal(model.rows[3]?.kind, "assistant_message");
  assert.equal(model.rows[3]?.status, "streaming");
  assert.equal(model.rows[3]?.streaming, true);
  assert.deepEqual(model.rows[3]?.blocks.map((block) => block.text), ["第一段", "第二段"]);
  assert.equal(model.rows[4], undefined);
});

test("composer exposes running state from the session stream", () => {
  const runningSurface = surface([]);
  runningSurface.stream = { connected: true, running: true };

  const model = buildChatRenderModel(runningSurface, { kind: "desktop_web" });

  assert.equal(model.composer.is_running, true);
});

test("does not infer turn metadata without explicit turn_meta items", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({ id: "u1", kind: "user_message", text: "hello", parts: [] }),
      baseItem({
        id: "a1",
        kind: "assistant_message",
        text: "streaming",
        parts: [],
        status: "streaming",
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "assistant_message"],
  );
});

test("turn metadata render status stays narrower than conversation item status", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "turn_meta:turn_1",
        kind: "turn_meta",
        turn_id: "turn_1",
        status: "streaming",
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.equal(model.rows[0]?.kind, "turn_meta");
  assert.equal(model.rows[0]?.kind === "turn_meta" ? model.rows[0].status : "", "running");
});

test("builds a request dock without mixing requests into conversation rows", () => {
  const input = surface();
  input.pending_requests.items = [
    {
      id: "req_tool",
      type: "tool_confirmation",
      status: "pending",
      title: "Allow command?",
      description: "bash: npm test",
      created_at: "2026-06-18T10:00:00Z",
      debug: { projection: "requests", source_event_ids: ["req_tool"] },
    },
    {
      id: "req_question",
      type: "question",
      status: "pending",
      title: "Choose an option",
      description: "A or B?",
      created_at: "2026-06-18T10:00:01Z",
      debug: { projection: "requests", source_event_ids: ["req_question"] },
    },
  ];

  const model = buildChatRenderModel(input, { kind: "desktop_web" });

  assert.equal(model.rows.length, 0);
  assert.equal(model.requests.items.length, 2);
  assert.equal(model.requests.items[0]?.confirmable, true);
  assert.equal(model.requests.items[1]?.response_kind, "answer");
});

test("renders normalized agent work details without provider-label fallbacks", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "shell_1",
        kind: "agent_work",
        title: "Ran command",
        summary: "ls -la",
        detail: { type: "shell", command: "ls -la" },
      }),
      baseItem({
        id: "read_1",
        kind: "agent_work",
        title: "Read file",
        summary: "README.md",
        detail: { type: "read", file_path: "README.md" },
      }),
      baseItem({
        id: "search_1",
        kind: "agent_work",
        title: "Searched code",
        summary: "query",
        detail: { type: "search", query: "query", mode: "code", num_matches: 3 },
      }),
    ]),
    { kind: "desktop_web" },
  );

  const agentWorkRows = model.rows.flatMap((row) => {
    if (row.kind === "agent_work_group") return row.children;
    if (row.kind === "agent_work") return [row];
    return [];
  });

  assert.deepEqual(
    agentWorkRows.map((row) => [row.title, row.summary]),
    [
      ["Ran command", "ls -la"],
      ["Read file", "README.md"],
      ["Searched code", "query · 3 matches"],
    ],
  );

  const source = readFileSync(
    join(root, "packages/vela-chat-render-model/src/agent-work/tools.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /providerLabelPresentation/);
  assert.doesNotMatch(source, /legacyToolTitle/);
  assert.doesNotMatch(source, /legacyToolSummary/);
});

test("groups consecutive completed agent work as a render-model-only row", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "u1",
        kind: "user_message",
        turn_id: "turn_1",
        text: "inspect",
        parts: [{ id: "u1:part:0", type: "text", text: "inspect" }],
      }),
      baseItem({
        id: "turn_meta:turn_1",
        kind: "turn_meta",
        turn_id: "turn_1",
        status: "completed",
        created_at: "2026-06-18T10:00:00Z",
        completed_at: "2026-06-18T10:00:03Z",
      }),
      baseItem({
        id: "shell_1",
        kind: "agent_work",
        turn_id: "turn_1",
        detail: { type: "shell", command: "ls -la" },
        created_at: "2026-06-18T10:00:01Z",
      }),
      baseItem({
        id: "shell_2",
        kind: "agent_work",
        turn_id: "turn_1",
        detail: { type: "shell", command: "git status" },
        created_at: "2026-06-18T10:00:02Z",
      }),
      baseItem({
        id: "read_1",
        kind: "agent_work",
        turn_id: "turn_1",
        detail: { type: "read", file_path: "README.md" },
        created_at: "2026-06-18T10:00:03Z",
      }),
      baseItem({
        id: "a1",
        kind: "assistant_message",
        turn_id: "turn_1",
        text: "done",
        created_at: "2026-06-18T10:00:04Z",
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "turn_meta", "agent_work_group", "assistant_message"],
  );
  const group = model.rows[2];
  assert.equal(group?.kind, "agent_work_group");
  if (group?.kind !== "agent_work_group") assert.fail("expected grouped agent work");
  assert.equal(group.title, "已运行 2 条命令并读取 1 个文件");
  assert.equal("defaultCollapsed" in group, false);
  assert.deepEqual(group.children.map((child) => child.agentWorkId), [
    "shell_1",
    "shell_2",
    "read_1",
  ]);

  const groupingSource = readFileSync(
    join(root, "packages/vela-chat-render-model/src/agent-work/grouping.ts"),
    "utf8",
  );
  assert.doesNotMatch(groupingSource, /defaultCollapsed/);
});

test("agent work grouping stays out of the OpenAPI wire contract", () => {
  const openapi = readFileSync(join(root, "public/openapi/velachat.v1.yaml"), "utf8");

  assert.doesNotMatch(openapi, /agent_work_group/);
});

test("groups failed terminal work with adjacent finished work without synthetic status rows", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "shell_done",
        kind: "agent_work",
        status: "completed",
        detail: { type: "shell", command: "ls -la" },
      }),
      baseItem({
        id: "read_failed",
        kind: "agent_work",
        status: "failed",
        title: "read",
        summary: "content",
        detail: { type: "read", file_path: "content" },
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["agent_work_group"],
  );
  const group = model.rows[0];
  assert.equal(group?.kind, "agent_work_group");
  if (group?.kind !== "agent_work_group") assert.fail("expected grouped agent work");
  assert.equal(group.title, "已运行 1 条命令并读取 1 个文件");
  assert.deepEqual(group.children.map((child) => [child.agentWorkId, child.status]), [
    ["shell_done", "completed"],
    ["read_failed", "failed"],
  ]);
});

test("keeps running agent work out of folded finished work groups", () => {
  const model = buildChatRenderModel(
    surface([
      baseItem({
        id: "shell_running",
        kind: "agent_work",
        status: "running",
        detail: { type: "shell", command: "npm test" },
      }),
      baseItem({
        id: "shell_done",
        kind: "agent_work",
        status: "completed",
        detail: { type: "shell", command: "ls -la" },
      }),
    ]),
    { kind: "desktop_web" },
  );

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["agent_work", "agent_work"],
  );
  assert.equal(model.rows[0]?.kind === "agent_work" ? model.rows[0].display : "", "prominent");
});
