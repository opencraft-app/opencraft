import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { buildChatRenderModel, splitMarkdownBlocks } from "../src";
import type { ChatSurface } from "../../vela-chat-surface/src";

const root = process.cwd();

test("agent work render row declares the activity id it emits", () => {
  const source = readFileSync(
    join(root, "packages/vela-chat-render-model/src/activity/tools.ts"),
    "utf8",
  );

  assert.match(
    source,
    /export interface AgentWorkRenderRow \{[\s\S]*\n  activityId\?: string;/,
  );
});

test("splits assistant markdown into stable blocks without splitting fenced code", () => {
  assert.deepEqual(
    splitMarkdownBlocks("先查入口。\n\n```ts\nconst x = 1\n\nconsole.log(x)\n```\n\n结论。"),
    ["先查入口。", "```ts\nconst x = 1\n\nconsole.log(x)\n```", "结论。"],
  );
});

test("turns surface rows into host-aware render rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_1",
    transcript: {
      turns: [
        {
          turn_id: "turn_1",
          status: "running",
          started_at: "2026-06-18T10:00:01Z",
          first_row_id: "u1",
          last_row_id: "a1",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started"] },
        },
      ],
      rows: [
        {
          id: "u1",
          role: "user",
          text: `${"a".repeat(640)}TAIL`,
          parts: [
            {
              id: "u1:part:0",
              type: "text",
              text: `${"a".repeat(640)}TAIL`,
            },
            {
              id: "u1:part:1",
              type: "image",
              data: {
                mime_type: "image/png",
                data: "aGVsbG8=",
                size_bytes: 5,
              },
            },
          ],
          created_at: "2026-06-18T10:00:00Z",
          turn_id: "turn_1",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["u1"] },
        },
        {
          id: "a1",
          role: "assistant",
          text: "第一段\n\n第二段",
          created_at: "2026-06-18T10:00:01Z",
          turn_id: "turn_1",
          status: "streaming",
          revision: 3,
          debug: { projection: "transcript", source_event_ids: ["a1"] },
        },
      ],
    },
    activity: {
      items: [
        {
          id: "current_turn",
          kind: "runtime",
          status: "failed",
          title: "turn.started",
          summary: "No API key found for the selected model.",
          created_at: "2026-06-18T10:00:02Z",
          updated_at: "2026-06-18T10:00:03Z",
          turn_id: "turn_1",
          debug: {
            projection: "activity",
            source_event_ids: ["evt_turn_started", "evt_turn_failed"],
          },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: { transcript: { latest_event_id: "a1", has_more: false } },
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.equal(model.rows[0]?.kind, "user_message");
  assert.equal(model.rows[0]?.collapsed, true);
  assert.equal(model.rows[0]?.copy_text.endsWith("TAIL"), true);
  assert.equal(model.rows[0]?.parts[1]?.type, "image");
  assert.equal(model.rows[0]?.parts[1]?.data?.mime_type, "image/png");
  assert.equal(model.rows[1]?.kind, "turn_meta");
  assert.equal(model.rows[1]?.label, "处理中");
  assert.equal(model.rows[2]?.kind, "assistant_message");
  assert.equal(model.rows[2]?.status, "streaming");
  assert.equal(model.rows[2]?.streaming, true);
  assert.equal(model.rows[2]?.revision, 3);
  assert.deepEqual(model.rows[2]?.blocks.map((block) => block.text), ["第一段", "第二段"]);
  assert.equal(model.rows[3]?.kind, "status");
  assert.match(model.rows[3]?.kind === "status" ? model.rows[3].label : "", /No API key/);
  assert.equal(model.rows[3]?.activityId, "current_turn");
  assert.equal(model.host.kind, "desktop_web");
});

test("does not infer turn metadata from streaming assistant rows without transcript turn summaries", () => {
  const surface = {
    session_id: "sess_no_turn_summary",
    transcript: {
      turns: [],
      rows: [
        {
          id: "u1",
          role: "user",
          text: "hello",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          updated_at: "2026-06-18T10:00:00Z",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "a1",
          role: "assistant",
          text: "streaming",
          parts: [],
          created_at: "2026-06-18T10:00:02Z",
          updated_at: "2026-06-18T10:00:03Z",
          status: "streaming",
          revision: 2,
          debug: { projection: "transcript", source_event_ids: ["evt_delta"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: true, running: true },
  } as ChatSurface;

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "assistant_message"],
  );
});

test("builds a request dock from pending surface requests without mixing it into transcript rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_requests",
    transcript: { rows: [], turns: [] },
    activity: { items: [] },
    pending_requests: {
      items: [
        {
          id: "req_tool",
          type: "tool_confirmation",
          status: "pending",
          title: "Allow command?",
          description: "bash: npm test",
          created_at: "2026-06-18T10:00:00Z",
          debug: { projection: "requests", source_event_ids: ["req_tool"] },
        },
      ],
    },
    cursors: {},
    stream: { connected: true, running: true },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.equal(model.rows.length, 0);
  assert.equal(model.requests.items.length, 1);
  assert.equal(model.requests.items[0]?.id, "req_tool");
  assert.equal(model.requests.items[0]?.title, "Allow command?");
  assert.equal(model.requests.items[0]?.confirmable, true);
});

test("marks question requests as answerable instead of confirmation-only", () => {
  const surface: ChatSurface = {
    session_id: "sess_requests",
    transcript: { rows: [], turns: [] },
    activity: { items: [] },
    pending_requests: {
      items: [
        {
          id: "req_question",
          type: "question",
          status: "pending",
          title: "Choose an option",
          description: "A or B?",
          created_at: "2026-06-18T10:00:00Z",
          debug: { projection: "requests", source_event_ids: ["req_question"] },
        },
      ],
    },
    cursors: {},
    stream: { connected: true, running: true },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.equal(model.requests.items[0]?.confirmable, false);
  assert.equal(model.requests.items[0]?.response_kind, "answer");
});

test("marks custom input requests as answerable request prompts", () => {
  const surface: ChatSurface = {
    session_id: "sess_custom_input",
    transcript: { rows: [], turns: [] },
    activity: { items: [] },
    pending_requests: {
      items: [
        {
          id: "req_custom_input",
          type: "custom_input",
          status: "pending",
          title: "Need more context",
          description: "Which branch should I inspect?",
          created_at: "2026-06-18T10:00:00Z",
          debug: { projection: "requests", source_event_ids: ["req_custom_input"] },
        },
      ],
    },
    cursors: {},
    stream: { connected: true, running: true },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.equal(model.requests.items[0]?.confirmable, false);
  assert.equal(model.requests.items[0]?.response_kind, "answer");
});

test("preserves transcript status on status render rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_error_status",
    transcript: {
      turns: [],
      rows: [
        {
          id: "row_error",
          role: "working",
          text: "Backend unavailable",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          status: "failed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_error"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const row = model.rows[0];

  assert.equal(row?.kind, "status");
  if (row?.kind !== "status") assert.fail("expected status row");
  assert.equal(row.label, "Backend unavailable");
  assert.equal(row.status, "failed");
});

test("derives user message text from OpenAPI textual parts when row text is absent", () => {
  const surface: ChatSurface = {
    session_id: "sess_user_parts",
    transcript: {
      turns: [],
      rows: [
        {
          id: "u_parts",
          role: "user",
          text: "",
          parts: [
            { id: "u_parts:part:0", type: "markdown", text: "**请看这个**" },
            { id: "u_parts:part:1", type: "code", text: "console.log('hello')" },
            {
              id: "u_parts:part:2",
              type: "image",
              data: { mime_type: "image/png", data: "aGVsbG8=", size_bytes: 5 },
            },
          ],
          created_at: "2026-06-18T10:00:00Z",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user_parts"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const row = model.rows[0];

  assert.equal(row?.kind, "user_message");
  if (row?.kind === "user_message") {
    assert.equal(row.text, "**请看这个**\nconsole.log('hello')");
    assert.equal(row.copy_text, "**请看这个**\nconsole.log('hello')");
    assert.equal(row.parts[2]?.type, "image");
  }
});

test("derives assistant markdown blocks from OpenAPI textual parts when row text is absent", () => {
  const surface: ChatSurface = {
    session_id: "sess_assistant_parts",
    transcript: {
      turns: [],
      rows: [
        {
          id: "a_parts",
          role: "assistant",
          text: "",
          parts: [
            { id: "a_parts:part:0", type: "markdown", text: "第一段" },
            { id: "a_parts:part:1", type: "markdown", text: "第二段" },
            {
              id: "a_parts:part:2",
              type: "image",
              data: { mime_type: "image/png", data: "aGVsbG8=", size_bytes: 5 },
            },
          ],
          created_at: "2026-06-18T10:00:00Z",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant_parts"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const row = model.rows[0];

  assert.equal(row?.kind, "assistant_message");
  if (row?.kind === "assistant_message") {
    assert.deepEqual(row.blocks.map((block) => block.text), ["第一段\n第二段"]);
  }
});

test("keeps agent work separate and renders worked label as turn-level metadata", () => {
  const surface: ChatSurface = {
    session_id: "sess_work",
    transcript: {
      turns: [
        {
          turn_id: "turn_1",
          status: "completed",
          started_at: "2026-06-18T10:00:00Z",
          completed_at: "2026-06-18T10:00:05Z",
          first_row_id: "u1",
          last_row_id: "a1",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started", "evt_turn_completed"] },
        },
      ],
      rows: [
        {
          id: "u1",
          role: "user",
          text: "查一下入口",
          created_at: "2026-06-18T10:00:00Z",
          turn_id: "turn_1",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "a1",
          role: "assistant",
          text: "我看到了入口。",
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:05Z",
          turn_id: "turn_1",
          status: "completed",
          revision: 2,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant"] },
        },
      ],
    },
    activity: {
      items: [
        {
          id: "tool_1",
          kind: "tool",
          status: "completed",
          title: "Searched code",
          summary: "12 matches",
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:03Z",
          turn_id: "turn_1",
          debug: { projection: "activity", source_event_ids: ["evt_tool_start", "evt_tool_done"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "turn_meta", "agent_work", "assistant_message"],
  );

  const meta = model.rows[1];
  assert.equal(meta.kind, "turn_meta");
  assert.equal(meta.label, "已处理 5s");
  assert.equal(meta.turnId, "turn_1");
  const work = model.rows[2];
  assert.equal(work.kind, "agent_work");
  assert.equal(work.title, "Searched code");
  assert.equal(work.status, "completed");
  assert.equal(work.summary, "12 matches");
  assert.equal(work.activityId, "tool_1");

  const assistant = model.rows[3];
  assert.equal(assistant.kind, "assistant_message");
});

test("formats short worked labels using elapsed whole seconds", () => {
  const surface: ChatSurface = {
    session_id: "sess_short_work",
    transcript: {
      turns: [
        {
          turn_id: "turn_short",
          status: "completed",
          started_at: "2026-06-18T10:00:00.500Z",
          completed_at: "2026-06-18T10:00:01.900Z",
          first_row_id: "u1",
          last_row_id: "a1",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started", "evt_turn_completed"] },
        },
      ],
      rows: [
        {
          id: "u1",
          role: "user",
          text: "快查一下",
          created_at: "2026-06-18T10:00:00.000Z",
          turn_id: "turn_short",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "a1",
          role: "assistant",
          text: "查到了。",
          created_at: "2026-06-18T10:00:00.500Z",
          updated_at: "2026-06-18T10:00:01.900Z",
          turn_id: "turn_short",
          status: "completed",
          revision: 2,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const meta = model.rows.find((row) => row.kind === "turn_meta");

  assert.equal(meta?.kind, "turn_meta");
  assert.equal(meta?.label, "已处理 1s");
});

test("renders one worked label before multi-message agent output in a user segment", () => {
  const surface: ChatSurface = {
    session_id: "sess_multi_assistant_work",
    transcript: {
      turns: [
        {
          turn_id: "turn_multi",
          status: "completed",
          started_at: "2026-06-18T10:00:00Z",
          completed_at: "2026-06-18T10:00:05Z",
          first_row_id: "user_1",
          last_row_id: "assistant_final",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started", "evt_turn_completed"] },
        },
      ],
      rows: [
        {
          id: "user_1",
          role: "user",
          text: "investigate this",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          updated_at: "2026-06-18T10:00:00Z",
          turn_id: "turn_multi",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "assistant_progress",
          role: "assistant",
          text: "I found the entry point.",
          parts: [],
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:02Z",
          turn_id: "turn_multi",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant_progress"] },
        },
        {
          id: "assistant_final",
          role: "assistant",
          text: "The fix is ready.",
          parts: [],
          created_at: "2026-06-18T10:00:03Z",
          updated_at: "2026-06-18T10:00:05Z",
          turn_id: "turn_multi",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant_final"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const assistants = model.rows.filter((row) => row.kind === "assistant_message");
  const meta = model.rows.filter((row) => row.kind === "turn_meta");

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "turn_meta", "assistant_message", "assistant_message"],
  );
  assert.equal(meta.length, 1);
  assert.equal(meta[0]?.label, "已处理 5s");
  assert.equal(assistants.length, 2);
});

test("keeps assistant messages and agent work expanded outside the turn header", () => {
  const surface: ChatSurface = {
    session_id: "sess_turn_header",
    transcript: {
      turns: [
        {
          turn_id: "turn_header",
          status: "completed",
          started_at: "2026-06-18T10:00:00Z",
          completed_at: "2026-06-18T10:00:07Z",
          first_row_id: "user_1",
          last_row_id: "assistant_final",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started", "evt_turn_completed"] },
        },
      ],
      rows: [
        {
          id: "user_1",
          role: "user",
          text: "look around",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          turn_id: "turn_header",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "assistant_progress",
          role: "assistant",
          text: "I am checking the repo.",
          parts: [],
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:02Z",
          turn_id: "turn_header",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_progress"] },
        },
        {
          id: "assistant_final",
          role: "assistant",
          text: "The repo is a local agent runtime.",
          parts: [],
          created_at: "2026-06-18T10:00:05Z",
          updated_at: "2026-06-18T10:00:07Z",
          turn_id: "turn_header",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_final"] },
        },
      ],
    },
    activity: {
      items: [
        {
          id: "tool_search",
          kind: "tool",
          status: "completed",
          title: "search: README",
          summary: "search: README",
          created_at: "2026-06-18T10:00:03Z",
          updated_at: "2026-06-18T10:00:04Z",
          turn_id: "turn_header",
          debug: { projection: "activity", source_event_ids: ["evt_tool"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const meta = model.rows.find((row) => row.kind === "turn_meta");

  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "turn_meta", "assistant_message", "agent_work", "assistant_message"],
  );
  assert.equal(meta?.kind, "turn_meta");
  if (meta?.kind !== "turn_meta") assert.fail("expected turn meta");
  const work = model.rows.find((row) => row.kind === "agent_work");
  assert.equal(work?.kind, "agent_work");
  if (work?.kind !== "agent_work") assert.fail("expected agent work row");
  assert.equal(work.activityId, "tool_search");
  assert.deepEqual(
    model.rows
      .filter((row) => row.kind === "assistant_message")
      .map((row) => row.id),
    ["assistant_progress", "assistant_final"],
  );
});

test("does not let stale running status rows move a completed turn back to running", () => {
  const surface: ChatSurface = {
    session_id: "sess_stale_status",
    transcript: {
      turns: [
        {
          turn_id: "turn_stale_status",
          status: "completed",
          started_at: "2026-06-18T10:00:00Z",
          completed_at: "2026-06-18T10:00:06Z",
          first_row_id: "user_1",
          last_row_id: "working_status",
          debug: { projection: "transcript", source_event_ids: ["evt_turn_started", "evt_turn_completed"] },
        },
      ],
      rows: [
        {
          id: "user_1",
          role: "user",
          text: "check date",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          turn_id: "turn_stale_status",
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_user"] },
        },
        {
          id: "assistant_final",
          role: "assistant",
          text: "Today is Thursday.",
          parts: [],
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:05Z",
          turn_id: "turn_stale_status",
          status: "completed",
          revision: 2,
          debug: { projection: "transcript", source_event_ids: ["evt_assistant"] },
        },
        {
          id: "working_status",
          role: "working",
          text: "处理中",
          parts: [],
          created_at: "2026-06-18T10:00:06Z",
          turn_id: "turn_stale_status",
          status: "running",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["evt_status"] },
        },
      ],
    },
    activity: { items: [] },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const meta = model.rows.find((row) => row.kind === "turn_meta");

  assert.equal(meta?.kind, "turn_meta");
  if (meta?.kind !== "turn_meta") assert.fail("expected turn meta");
  assert.equal(meta.status, "completed");
  assert.equal(meta.label, "已处理 6s");
  assert.deepEqual(
    model.rows.map((row) => row.kind),
    ["user_message", "turn_meta", "assistant_message"],
  );
  assert.equal(model.rows.some((row) => row.kind === "status" && row.label === "处理中"), false);
});

test("renders canonical tool details as agent work instead of generic Tool labels", () => {
  const surface: ChatSurface = {
    session_id: "sess_tool_detail",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "tool_search",
          kind: "tool",
          status: "completed",
          title: "Tool",
          summary: "",
          detail: {
            type: "search",
            query: "import CommandAck",
            mode: "code",
            num_matches: 12,
          },
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:03Z",
          debug: { projection: "activity", source_event_ids: ["evt_tool_start", "evt_tool_done"] },
        },
        {
          id: "tool_empty",
          kind: "tool",
          status: "completed",
          title: "Tool",
          summary: "",
          created_at: "2026-06-18T10:00:04Z",
          debug: { projection: "activity", source_event_ids: ["evt_empty"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const workRows = model.rows.filter((row) => row.kind === "agent_work");

  assert.equal(workRows.length, 2);
  assert.equal(workRows[0]?.title, "Searched code");
  assert.equal(workRows[0]?.summary, "import CommandAck · 12 matches");
  assert.equal(workRows[0]?.status, "completed");
  assert.equal(workRows[1]?.title, "Tool call");
  assert.equal(workRows[1]?.summary, "");
  assert.equal(workRows[1]?.status, "completed");
});

test("keeps low-information projected tool items as compact agent work rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_minimal_tool",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "tool_minimal",
          kind: "tool",
          status: "completed",
          title: "Tool",
          summary: "Tool",
          created_at: "2026-06-18T10:00:04Z",
          debug: { projection: "activity", source_event_ids: ["evt_minimal"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const workRows = model.rows.filter((row) => row.kind === "agent_work");

  assert.equal(workRows.length, 1);
  assert.equal(workRows[0]?.title, "Tool call");
  assert.equal(workRows[0]?.summary, "");
  assert.equal(workRows[0]?.display, "compact");
});

test("renders OpenAPI command and task activity items without tool detail", () => {
  const surface: ChatSurface = {
    session_id: "sess_command_task",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "activity_command_1",
          kind: "command",
          status: "completed",
          title: "Ran command",
          summary: "npm test",
          created_at: "2026-06-18T10:00:01Z",
          debug: { projection: "activity", source_event_ids: ["evt_command"] },
        },
        {
          id: "activity_task_1",
          kind: "task",
          status: "running",
          title: "Running task",
          summary: "Indexing workspace",
          created_at: "2026-06-18T10:00:02Z",
          debug: { projection: "activity", source_event_ids: ["evt_task"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const workRows = model.rows.filter((row) => row.kind === "agent_work");

  assert.deepEqual(
    workRows.map((row) => [row.title, row.summary, row.status, row.activityId]),
    [
      ["Ran command", "npm test", "completed", "activity_command_1"],
      ["Running task", "Indexing workspace", "running", "activity_task_1"],
    ],
  );
});

test("renders OpenAPI activity detail fields as informative work rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_activity_detail_display",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "activity_command",
          kind: "command",
          status: "completed",
          title: "Command",
          summary: "",
          detail: {
            type: "shell",
            command: "cargo test -p velad",
            cwd: "/repo",
          },
          created_at: "2026-06-18T10:00:01Z",
          debug: { projection: "activity", source_event_ids: ["evt_command"] },
        },
        {
          id: "activity_read",
          kind: "tool",
          status: "completed",
          title: "read",
          summary: "",
          detail: {
            type: "read",
            file_path: "README.md",
          },
          created_at: "2026-06-18T10:00:02Z",
          debug: { projection: "activity", source_event_ids: ["evt_read"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const workRows = model.rows.filter((row) => row.kind === "agent_work");

  assert.deepEqual(
    workRows.map((row) => [row.title, row.summary, row.display]),
    [
      ["Ran command", "cargo test -p velad", "prominent"],
      ["Read file", "README.md", "compact"],
    ],
  );
});

test("renders OpenAPI warning activity items without tool detail", () => {
  const surface: ChatSurface = {
    session_id: "sess_warning",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "activity_warning_1",
          kind: "warning",
          status: "completed",
          title: "Warning",
          summary: "Provider sent an unsupported extension UI request",
          created_at: "2026-06-18T10:00:03Z",
          debug: { projection: "activity", source_event_ids: ["evt_warning"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const warning = model.rows[0];

  assert.equal(warning?.kind, "agent_work");
  if (warning?.kind !== "agent_work") assert.fail("expected warning activity row");
  assert.equal(warning.title, "Warning");
  assert.equal(warning.summary, "Provider sent an unsupported extension UI request");
  assert.equal(warning.status, "completed");
  assert.equal(warning.activityId, "activity_warning_1");
});

test("does not render non-failed runtime activity as agent work even when detail is present", () => {
  const surface: ChatSurface = {
    session_id: "sess_runtime_detail",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "activity_runtime_1",
          kind: "runtime",
          status: "completed",
          title: "turn.completed",
          summary: "Turn completed",
          detail: {
            type: "plain_text",
            text: "lifecycle bookkeeping",
          },
          created_at: "2026-06-18T10:00:03Z",
          debug: { projection: "activity", source_event_ids: ["evt_turn_completed"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });

  assert.equal(model.rows.length, 0);
});

test("turns provider-style activity titles into quiet action labels", () => {
  const surface: ChatSurface = {
    session_id: "sess_raw_titles",
    transcript: { rows: [], turns: [] },
    activity: {
      items: [
        {
          id: "tool_search",
          kind: "tool",
          status: "completed",
          title: "search: *",
          summary: "search: *",
          created_at: "2026-06-18T10:00:01Z",
          debug: { projection: "activity", source_event_ids: ["evt_search"] },
        },
        {
          id: "tool_terminal",
          kind: "tool",
          status: "completed",
          title: "terminal: ls -la",
          summary: "terminal: ls -la",
          created_at: "2026-06-18T10:00:02Z",
          debug: { projection: "activity", source_event_ids: ["evt_terminal"] },
        },
        {
          id: "tool_read",
          kind: "tool",
          status: "completed",
          title: "read: README.md",
          summary: "read: README.md",
          created_at: "2026-06-18T10:00:03Z",
          debug: { projection: "activity", source_event_ids: ["evt_read"] },
        },
        {
          id: "tool_python",
          kind: "tool",
          status: "completed",
          title: "python: from PIL import Image",
          summary: "python: from PIL import Image",
          created_at: "2026-06-18T10:00:04Z",
          debug: { projection: "activity", source_event_ids: ["evt_python"] },
        },
      ],
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };

  const model = buildChatRenderModel(surface, { kind: "desktop_web" });
  const workRows = model.rows.filter((row) => row.kind === "agent_work");

  assert.deepEqual(
    workRows.map((row) => [row.title, row.summary]),
    [
      ["Searched code", "*"],
      ["Ran command", "ls -la"],
      ["Read file", "README.md"],
      ["Ran Python", "from PIL import Image"],
    ],
  );
  assert.deepEqual(
    workRows.map((row) => [row.title, row.display]),
    [
      ["Searched code", "compact"],
      ["Ran command", "prominent"],
      ["Read file", "compact"],
      ["Ran Python", "prominent"],
    ],
  );
});
