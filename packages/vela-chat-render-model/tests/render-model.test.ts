import assert from "node:assert/strict";
import test from "node:test";

import { buildChatRenderModel, splitMarkdownBlocks } from "../src";
import type { ChatSurface } from "../../vela-chat-surface/src";

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
          status: "completed",
          revision: 1,
          debug: { projection: "transcript", source_event_ids: ["u1"] },
        },
        {
          id: "a1",
          role: "assistant",
          text: "第一段\n\n第二段",
          created_at: "2026-06-18T10:00:01Z",
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
  assert.equal(model.rows[1]?.kind, "assistant_message");
  assert.equal(model.rows[1]?.status, "streaming");
  assert.equal(model.rows[1]?.streaming, true);
  assert.equal(model.rows[1]?.revision, 3);
  assert.deepEqual(model.rows[1]?.blocks.map((block) => block.text), ["第一段", "第二段"]);
  assert.equal(model.rows[2]?.kind, "status");
  assert.match(model.rows[2]?.label ?? "", /No API key/);
  assert.equal(model.host.kind, "desktop_web");
});

test("builds a request dock from pending surface requests without mixing it into transcript rows", () => {
  const surface: ChatSurface = {
    session_id: "sess_requests",
    transcript: { rows: [] },
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
    transcript: { rows: [] },
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
    transcript: { rows: [] },
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

test("keeps agent work separate from transcript and derives worked label from message boundaries", () => {
  const surface: ChatSurface = {
    session_id: "sess_work",
    transcript: {
      rows: [
        {
          id: "u1",
          role: "user",
          text: "查一下入口",
          created_at: "2026-06-18T10:00:00Z",
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
    ["user_message", "agent_work", "assistant_message"],
  );

  const work = model.rows[1];
  assert.equal(work.kind, "agent_work");
  assert.equal(work.title, "Searched code");
  assert.equal(work.status, "completed");
  assert.equal(work.summary, "12 matches");

  const assistant = model.rows[2];
  assert.equal(assistant.kind, "assistant_message");
  assert.equal(assistant.settledLabel, "Worked for 5s");
});

test("formats short worked labels using elapsed whole seconds", () => {
  const surface: ChatSurface = {
    session_id: "sess_short_work",
    transcript: {
      rows: [
        {
          id: "u1",
          role: "user",
          text: "快查一下",
          created_at: "2026-06-18T10:00:00.000Z",
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
  const assistant = model.rows.find((row) => row.kind === "assistant_message");

  assert.equal(assistant?.kind, "assistant_message");
  assert.equal(assistant?.settledLabel, "Worked for 1s");
});

test("attaches worked labels only to the terminal assistant row in a user segment", () => {
  const surface: ChatSurface = {
    session_id: "sess_multi_assistant_work",
    transcript: {
      rows: [
        {
          id: "user_1",
          role: "user",
          text: "investigate this",
          parts: [],
          created_at: "2026-06-18T10:00:00Z",
          updated_at: "2026-06-18T10:00:00Z",
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

  assert.equal(assistants.length, 2);
  assert.equal(assistants[0]?.settledLabel, undefined);
  assert.equal(assistants[1]?.settledLabel, "Worked for 5s");
});

test("renders canonical tool details as agent work instead of generic Tool labels", () => {
  const surface: ChatSurface = {
    session_id: "sess_tool_detail",
    transcript: { rows: [] },
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
    transcript: { rows: [] },
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

test("turns provider-style activity titles into quiet action labels", () => {
  const surface: ChatSurface = {
    session_id: "sess_raw_titles",
    transcript: { rows: [] },
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
