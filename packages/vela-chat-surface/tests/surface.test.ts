import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatSurfaceFromReadModels,
  buildConversationHistoryPrependPlan,
  canApplyConversationHistoryPrependPlan,
  deriveConversationWindowState,
  prependActivityWindow,
  prependTranscriptWindow,
} from "../src";

test("normalizes transcript wire rows into stable semantic surface rows", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_1",
    transcript: {
      rows: [
        {
          id: "evt_user_1",
          kind: "user_message",
          created_at: "2026-06-18T10:00:00Z",
          text: "导入功能在哪了 至少前端没看到?",
          parts: [
            {
              id: "evt_user_1:part:0",
              type: "text",
              text: "导入功能在哪了 至少前端没看到?",
            },
            {
              id: "evt_user_1:part:1",
              type: "image",
              data: {
                mime_type: "image/png",
                data: "aGVsbG8=",
                size_bytes: 5,
              },
            },
          ],
          status: "completed",
          source_event_ids: ["evt_user_1"],
        },
        {
          id: "evt_assistant_1",
          kind: "assistant_message",
          created_at: "2026-06-18T10:00:01Z",
          text: "我先按前端入口查。",
          status: "completed",
          source_event_ids: ["evt_assistant_started", "evt_assistant_delta"],
        },
      ],
      window: {
        first_row_id: "evt_user_1",
        last_row_id: "evt_assistant_1",
        has_older: true,
        has_newer: false,
      },
      cursor: { latest_event_id: "evt_assistant_1", has_more: false },
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
          event_range: {
            from_event_id: "evt_turn_started",
            to_event_id: "evt_turn_failed",
          },
        },
      ],
      cursor: { latest_event_id: "evt_turn_failed", has_more: false },
    },
  });

  assert.equal(surface.session_id, "sess_1");
  assert.deepEqual(
    surface.transcript.rows.map((row) => row.role),
    ["user", "assistant"],
  );
  assert.equal(surface.transcript.rows[0]?.debug.projection, "transcript");
  assert.equal(surface.transcript.rows[0]?.parts[1]?.type, "image");
  assert.equal(surface.transcript.rows[0]?.parts[1]?.data?.mime_type, "image/png");
  assert.deepEqual(surface.transcript.rows[0]?.debug.source_event_ids, ["evt_user_1"]);
  assert.deepEqual(surface.transcript.rows[1]?.debug.source_event_ids, [
    "evt_assistant_started",
    "evt_assistant_delta",
  ]);
  assert.equal(surface.transcript.window?.has_older, true);
  assert.equal(surface.transcript.window?.last_row_id, "evt_assistant_1");
  assert.equal(surface.activity.items[0]?.status, "failed");
  assert.equal(surface.activity.items[0]?.summary, "No API key found for the selected model.");
  assert.deepEqual(surface.activity.items[0]?.debug.source_event_ids, [
    "evt_turn_started",
    "evt_turn_failed",
  ]);
  assert.equal(surface.cursors.transcript?.latest_event_id, "evt_assistant_1");
  assert.equal(surface.cursors.activity?.latest_event_id, "evt_turn_failed");
});

test("normalizes pending requests as a separate surface lane", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_requests",
    transcript: {
      rows: [],
      cursor: { latest_event_id: "evt_transcript" },
    },
    requests: {
      requests: [
        {
          id: "req_allow_shell",
          session_id: "sess_requests",
          type: "permission",
          status: "pending",
          title: "Allow command?",
          description: "bash: npm test",
          payload: { command: "npm test" },
          created_at: "2026-06-18T10:00:02Z",
        },
      ],
      cursor: { latest_event_id: "evt_request_opened" },
    },
  });

  assert.equal(surface.pending_requests.items.length, 1);
  assert.equal(surface.pending_requests.items[0]?.id, "req_allow_shell");
  assert.equal(surface.pending_requests.items[0]?.title, "Allow command?");
  assert.equal(surface.pending_requests.items[0]?.debug.projection, "requests");
  assert.deepEqual(surface.pending_requests.items[0]?.debug.source_event_ids, [
    "req_allow_shell",
  ]);
  assert.equal(surface.cursors.requests?.latest_event_id, "evt_request_opened");
});

test("uses transcript row label for non-message rows when wire text is absent", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_labels",
    transcript: {
      rows: [
        {
          id: "row_working_1",
          kind: "working",
          created_at: "2026-06-18T10:00:00Z",
          label: "Searched code",
          status: "completed",
          source_event_ids: ["evt_reasoning_1"],
        },
        {
          id: "row_activity_1",
          kind: "activity_marker",
          created_at: "2026-06-18T10:00:01Z",
          label: "Ran command",
          status: "completed",
          source_event_ids: ["evt_tool_1"],
        },
      ],
      cursor: { event_id: "evt_tool_1", seq: 2 },
    },
  });

  assert.equal(surface.transcript.rows[0]?.role, "working");
  assert.equal(surface.transcript.rows[0]?.text, "Searched code");
  assert.equal(surface.transcript.rows[1]?.role, "activity");
  assert.equal(surface.transcript.rows[1]?.text, "Ran command");
});

test("keeps surface renderer-free", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );

  assert.equal(source.includes("react"), false);
  assert.equal(source.includes("next/"), false);
});

test("does not invent OpenAPI-required transcript row fields in the surface layer", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const rowInterface =
    source.match(/export interface ChatTranscriptWireRow \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(rowInterface, /updated_at:\s*string/);
  assert.match(rowInterface, /revision:\s*number/);
  assert.match(rowInterface, /status:\s*string/);
  assert.match(rowInterface, /source_event_ids:\s*string\[\]/);
  assert.doesNotMatch(rowInterface, /updated_at\?:\s*string/);
  assert.doesNotMatch(rowInterface, /revision\?:\s*number/);
  assert.doesNotMatch(rowInterface, /status\?:\s*string/);
  assert.doesNotMatch(rowInterface, /source_event_ids\?:\s*string\[\]/);
  assert.doesNotMatch(source, /row\.status\s*\?\?/);
  assert.doesNotMatch(source, /row\.revision\s*\?\?/);
  assert.doesNotMatch(source, /row\.source_event_ids\?\./);
});

test("keeps OpenAPI-required read model envelope fields required in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const transcriptViewInterface =
    source.match(/export interface ChatTranscriptWireView \{[\s\S]*?\n\}/)?.[0] ?? "";
  const activityViewInterface =
    source.match(/export interface ActivityWireView \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(transcriptViewInterface, /session_id:\s*string/);
  assert.match(transcriptViewInterface, /window:\s*ChatTranscriptWindow/);
  assert.doesNotMatch(transcriptViewInterface, /session_id\?:\s*string/);
  assert.doesNotMatch(transcriptViewInterface, /window\?:\s*ChatTranscriptWindow/);
  assert.match(activityViewInterface, /session_id:\s*string/);
  assert.match(activityViewInterface, /window:\s*ActivityWindow/);
  assert.doesNotMatch(activityViewInterface, /session_id\?:\s*string/);
  assert.doesNotMatch(activityViewInterface, /window\?:\s*ActivityWindow/);
});

test("keeps OpenAPI activity enums narrow in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const itemInterface = source.match(/export interface ActivityWireItem \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type ActivityItemKindWire\s*=/);
  assert.match(source, /export type ActivityItemStatusWire\s*=/);
  assert.match(source, /export type ActivityDetailTypeWire\s*=/);
  assert.match(itemInterface, /kind:\s*ActivityItemKindWire/);
  assert.match(itemInterface, /status:\s*ActivityItemStatusWire/);
  assert.doesNotMatch(itemInterface, /kind:\s*string/);
  assert.doesNotMatch(itemInterface, /status:\s*string/);
  assert.doesNotMatch(source, /\|\s*\{\s*\n\s*type:\s*string;\s*\n\s*\[key: string\]: unknown;\s*\n\s*\}/);
});

test("prepends transcript windows without duplicating rows and preserves latest cursor", () => {
  const current = {
    session_id: "sess_1",
    rows: [
      {
        id: "row_2",
        kind: "assistant_message" as const,
        created_at: "2026-06-18T10:00:02Z",
        text: "two current",
        status: "streaming",
        revision: 2,
      },
      {
        id: "row_3",
        kind: "assistant_message" as const,
        created_at: "2026-06-18T10:00:03Z",
        text: "three",
      },
    ],
    window: {
      first_row_id: "row_2",
      last_row_id: "row_3",
      has_older: true,
      has_newer: false,
    },
    cursor: { event_id: "evt_latest", seq: 9 },
  };
  const older = {
    session_id: "sess_1",
    rows: [
      {
        id: "row_1",
        kind: "user_message" as const,
        created_at: "2026-06-18T10:00:01Z",
        text: "one",
      },
      {
        id: "row_2",
        kind: "assistant_message" as const,
        created_at: "2026-06-18T10:00:02Z",
        text: "two stale",
        status: "completed",
        revision: 1,
      },
    ],
    window: {
      first_row_id: "row_1",
      last_row_id: "row_2",
      has_older: false,
      has_newer: true,
    },
    cursor: { event_id: "evt_newer", seq: 10 },
  };
  const merged = prependTranscriptWindow(current, older);

  assert.deepEqual(
    merged.rows.map((row) => row.id),
    ["row_1", "row_2", "row_3"],
  );
  assert.equal(merged.rows[1]?.text, "two current");
  assert.equal(merged.rows[1]?.status, "streaming");
  assert.equal(merged.rows[1]?.revision, 2);
  assert.equal(merged.window?.first_row_id, "row_1");
  assert.equal(merged.window?.last_row_id, "row_3");
  assert.equal(merged.window?.has_older, false);
  assert.equal(merged.window?.has_newer, false);
  assert.equal(merged.cursor.event_id, "evt_newer");
  assert.equal(
    prependTranscriptWindow(
      { ...current, cursor: { event_id: "evt_live", epoch: 1, seq: 12 } },
      { ...older, cursor: { event_id: "evt_older", epoch: 1, seq: 10 } },
    ).cursor.event_id,
    "evt_live",
  );
  assert.equal(
    prependTranscriptWindow(
      { ...current, cursor: { event_id: "evt_live", epoch: 1, seq: 12 } },
      { ...older, cursor: { latest_event_id: "evt_legacy" } },
    ).cursor.event_id,
    "evt_live",
  );
  assert.equal(
    prependTranscriptWindow(
      { ...current, cursor: { event_id: "evt_current_legacy" } },
      { ...older, cursor: { event_id: "evt_older_legacy" } },
    ).cursor.event_id,
    "evt_current_legacy",
  );
  assert.strictEqual(
    prependTranscriptWindow(current, { ...older, session_id: "sess_other" }),
    current,
  );
});

test("prepends activity windows without duplicating items and preserves latest cursor", () => {
  const current = {
    session_id: "sess_1",
    items: [
      {
        id: "act_2",
        kind: "tool",
        status: "running",
        title: "Read file",
        summary: "README.md current",
        created_at: "2026-06-18T10:00:02Z",
      },
      {
        id: "act_3",
        kind: "tool",
        status: "completed",
        title: "Ran command",
        created_at: "2026-06-18T10:00:03Z",
      },
    ],
    window: {
      first_item_id: "act_2",
      last_item_id: "act_3",
      has_older: true,
      has_newer: false,
    },
    cursor: { event_id: "evt_latest", seq: 9 },
  };
  const older = {
    session_id: "sess_1",
    items: [
      {
        id: "act_1",
        kind: "tool",
        status: "completed",
        title: "Searched code",
        created_at: "2026-06-18T10:00:01Z",
      },
      {
        id: "act_2",
        kind: "tool",
        status: "completed",
        title: "Read file",
        summary: "README.md stale",
        created_at: "2026-06-18T10:00:02Z",
      },
    ],
    window: {
      first_item_id: "act_1",
      last_item_id: "act_2",
      has_older: false,
      has_newer: true,
    },
    cursor: { event_id: "evt_newer", seq: 10 },
  };
  const merged = prependActivityWindow(current, older);

  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["act_1", "act_2", "act_3"],
  );
  assert.equal(merged.items[1]?.status, "running");
  assert.equal(merged.items[1]?.summary, "README.md current");
  assert.equal(merged.window?.first_item_id, "act_1");
  assert.equal(merged.window?.last_item_id, "act_3");
  assert.equal(merged.window?.has_older, false);
  assert.equal(merged.window?.has_newer, false);
  assert.equal(merged.cursor.event_id, "evt_newer");
  assert.equal(
    prependActivityWindow(
      { ...current, cursor: { event_id: "evt_live", epoch: 1, seq: 12 } },
      { ...older, cursor: { event_id: "evt_older", epoch: 1, seq: 10 } },
    ).cursor.event_id,
    "evt_live",
  );
  assert.equal(
    prependActivityWindow(
      { ...current, cursor: { event_id: "evt_live", epoch: 1, seq: 12 } },
      { ...older, cursor: { latest_event_id: "evt_legacy" } },
    ).cursor.event_id,
    "evt_live",
  );
  assert.equal(
    prependActivityWindow(
      { ...current, cursor: { event_id: "evt_current_legacy" } },
      { ...older, cursor: { event_id: "evt_older_legacy" } },
    ).cursor.event_id,
    "evt_current_legacy",
  );
  assert.strictEqual(
    prependActivityWindow(current, { ...older, session_id: "sess_other" }),
    current,
  );
});

test("legacy prepend fixtures keep working without session ids", () => {
  const transcript = prependTranscriptWindow(
    {
      rows: [
        {
          id: "row_2",
          kind: "assistant_message",
          created_at: "2026-06-18T10:00:02Z",
          text: "two",
        },
        {
          id: "row_3",
          kind: "assistant_message",
          created_at: "2026-06-18T10:00:03Z",
          text: "three",
        },
      ],
      window: {
        first_row_id: "row_2",
        last_row_id: "row_3",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_latest", seq: 9 },
    },
    {
      rows: [
        {
          id: "row_1",
          kind: "user_message",
          created_at: "2026-06-18T10:00:01Z",
          text: "one",
        },
        {
          id: "row_2",
          kind: "assistant_message",
          created_at: "2026-06-18T10:00:02Z",
          text: "two",
        },
      ],
      window: {
        first_row_id: "row_1",
        last_row_id: "row_2",
        has_older: false,
        has_newer: true,
      },
      cursor: { event_id: "evt_newer", seq: 10 },
    },
  );

  assert.deepEqual(
    transcript.rows.map((row) => row.id),
    ["row_1", "row_2", "row_3"],
  );
  assert.equal(transcript.window?.first_row_id, "row_1");
  assert.equal(transcript.window?.last_row_id, "row_3");
  assert.equal(transcript.window?.has_older, false);
  assert.equal(transcript.window?.has_newer, false);
  assert.equal(transcript.cursor.event_id, "evt_newer");

  const activity = prependActivityWindow(
    {
      items: [
        {
          id: "act_2",
          kind: "tool",
          status: "completed",
          title: "Read file",
          created_at: "2026-06-18T10:00:02Z",
        },
        {
          id: "act_3",
          kind: "tool",
          status: "completed",
          title: "Ran command",
          created_at: "2026-06-18T10:00:03Z",
        },
      ],
      window: {
        first_item_id: "act_2",
        last_item_id: "act_3",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_latest", seq: 9 },
    },
    {
      items: [
        {
          id: "act_1",
          kind: "tool",
          status: "completed",
          title: "Searched code",
          created_at: "2026-06-18T10:00:01Z",
        },
        {
          id: "act_2",
          kind: "tool",
          status: "completed",
          title: "Read file",
          created_at: "2026-06-18T10:00:02Z",
        },
      ],
      window: {
        first_item_id: "act_1",
        last_item_id: "act_2",
        has_older: false,
        has_newer: true,
      },
      cursor: { event_id: "evt_newer", seq: 10 },
    },
  );

  assert.deepEqual(
    activity.items.map((item) => item.id),
    ["act_1", "act_2", "act_3"],
  );
  assert.equal(activity.window?.first_item_id, "act_1");
  assert.equal(activity.window?.last_item_id, "act_3");
  assert.equal(activity.window?.has_older, false);
  assert.equal(activity.window?.has_newer, false);
  assert.equal(activity.cursor.event_id, "evt_newer");
});

test("rejects stale conversation history prepend plans after the visible window changes", () => {
  const plan = buildConversationHistoryPrependPlan({
    transcript: {
      session_id: "sess_old",
      rows: [],
      cursor: {},
      window: {
        first_row_id: "row_10",
        last_row_id: "row_20",
        has_older: true,
        has_newer: false,
      },
    },
    activity: {
      session_id: "sess_old",
      items: [],
      cursor: {},
      window: {
        first_item_id: "act_10",
        last_item_id: "act_20",
        has_older: true,
        has_newer: false,
      },
    },
  });

  assert.equal(Reflect.get(plan.transcript ?? {}, "sessionId"), "sess_old");
  assert.equal(Reflect.get(plan.activity ?? {}, "sessionId"), "sess_old");
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      transcript: {
        session_id: "sess_old",
        rows: [],
        cursor: {},
        window: {
          first_row_id: "row_10",
          last_row_id: "row_21",
          has_older: true,
          has_newer: false,
        },
      },
      activity: {
        session_id: "sess_old",
        items: [],
        cursor: {},
        window: {
          first_item_id: "act_10",
          last_item_id: "act_21",
          has_older: true,
          has_newer: false,
        },
      },
    }),
    true,
  );
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      transcript: {
        session_id: "sess_new",
        rows: [],
        cursor: {},
        window: {
          first_row_id: "row_10",
          last_row_id: "row_21",
          has_older: true,
          has_newer: false,
        },
      },
      activity: {
        session_id: "sess_new",
        items: [],
        cursor: {},
        window: {
          first_item_id: "act_10",
          last_item_id: "act_21",
          has_older: true,
          has_newer: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      transcript: {
        session_id: "sess_old",
        rows: [],
        cursor: {},
        window: {
          first_row_id: "row_09",
          last_row_id: "row_21",
          has_older: true,
          has_newer: false,
        },
      },
      activity: {
        session_id: "sess_old",
        items: [],
        cursor: {},
        window: {
          first_item_id: "act_10",
          last_item_id: "act_21",
          has_older: true,
          has_newer: false,
        },
      },
    }),
    false,
  );
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      transcript: {
        session_id: "sess_old",
        rows: [],
        cursor: {},
        window: {
          first_row_id: "row_10",
          last_row_id: "row_21",
          has_older: true,
          has_newer: false,
        },
      },
      activity: {
        session_id: "sess_old",
        items: [],
        cursor: {},
        window: {
          first_item_id: "act_09",
          last_item_id: "act_21",
          has_older: true,
          has_newer: false,
        },
      },
    }),
    false,
  );
});

test("derives conversation window state across transcript and activity windows", () => {
  const state = deriveConversationWindowState({
    transcript: {
      rows: [],
      window: {
        first_row_id: "row_1",
        last_row_id: "row_2",
        has_older: false,
        has_newer: false,
      },
      cursor: { event_id: "evt_transcript" },
    },
    activity: {
      items: [],
      window: {
        first_item_id: "act_1",
        last_item_id: "act_8",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_activity" },
    },
  });

  assert.equal(state.has_older, true);
  assert.equal(state.has_newer, false);
  assert.equal(state.first_row_id, "row_1");
  assert.equal(state.first_activity_item_id, "act_1");
});

test("plans older conversation loads even when only activity has older items", () => {
  const plan = buildConversationHistoryPrependPlan({
    transcript: {
      rows: [],
      window: {
        first_row_id: "row_1",
        last_row_id: "row_2",
        has_older: false,
        has_newer: false,
      },
      cursor: { event_id: "evt_transcript" },
    },
    activity: {
      items: [],
      window: {
        first_item_id: "act_1",
        last_item_id: "act_8",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_activity" },
    },
    limit: 80,
  });

  assert.equal(plan.has_older, true);
  assert.equal(plan.transcript, null);
  assert.deepEqual(plan.activity, {
    direction: "before",
    anchorItemId: "act_1",
    limit: 80,
  });
});
