import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  VeladClientError,
  applyConversationLiveOverlay,
  commandAckRejectionMessage,
  createIdempotencyKey,
  createFetchVelaEventStreamTransport,
  createStreamRefreshScheduler,
  createVeladClient,
  imageFileToInputPart,
  mergeConversationSnapshot,
  needsConversationRefreshAfterLiveOverlay,
  parseConversationWireView,
  parseSseJsonFrames,
  readVelaStreamEvent,
  isVelaStreamEventFreshForCursor,
  isVelaStreamEventForSession,
  selectSessionEventStreamAfterId,
  streamReadModelRefreshPlan,
  streamReadModelRefreshPlanForCursors,
  subscribeVelaEventSource,
} from "../src/index";

const clientSource = readClientSource();

function readClientSource() {
  const srcDir = new URL("../src/", import.meta.url);
  return readdirSync(srcDir)
    .filter((file) => file.endsWith(".ts"))
    .sort()
    .map((file) => `// ${file}\n${readFileSync(new URL(file, srcDir), "utf8")}`)
    .join("\n");
}

async function waitUntil(done: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(done(), true);
}

function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_1",
    backend: "pi",
    status: "idle",
    title: "New chat",
    working_directory: "/tmp/project",
    created_at: "2026-06-19T00:00:00Z",
    updated_at: "2026-06-19T00:00:00Z",
    ...overrides,
  };
}

function conversationFixture({
  items = [],
  cursor = { event_id: "evt_1", epoch: 1, seq: 1 },
  window = { has_older: false, has_newer: false },
}: {
  items?: Array<Record<string, unknown>>;
  cursor?: Record<string, unknown>;
  window?: Record<string, unknown>;
} = {}) {
  return {
    session_id: "sess_1",
    cursor,
    window,
    items,
  };
}

function assistantConversationItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    kind: "assistant_message" as const,
    created_at: "2026-06-19T00:00:00Z",
    updated_at: "2026-06-19T00:00:00Z",
    revision: 1,
    text: "",
    status: "streaming" as const,
    source_event_ids: ["evt_1"],
    source_event_ranges: [
      { from_event_id: "evt_1", to_event_id: "evt_1", from_seq: 1, to_seq: 1 },
    ],
    ...overrides,
  };
}

test("builds conversation and event URLs for local velad", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client.conversationUrl("sess_123").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/conversation",
  );
  assert.equal(
    client.sessionEventStreamUrl("sess_123", "evt_9").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/events/stream?after_id=evt_9",
  );
});

test("uses injected fetch instead of assuming browser network reachability", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      throw new Error("global fetch must not be used");
    },
  });

  try {
    const client = createVeladClient({
      baseUrl: "http://127.0.0.1:3857/api/v1/",
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ session: sessionFixture({ id: "ses_remote" }) }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    });

    const response = await client.getSession("ses_remote");

    assert.equal(response.session.id, "ses_remote");
    assert.deepEqual(requests, [
      "http://127.0.0.1:3857/api/v1/sessions/ses_remote",
    ]);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
    });
  }
});

test("reports a clear SDK error when no fetch transport is available", async () => {
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: undefined,
  });

  try {
    const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

    await assert.rejects(
      () => client.getSession("ses_missing_fetch"),
      /pass a VeladFetch to createVeladClient\(\{ baseUrl, fetch \}\)/,
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
    });
  }
});

test("rejects invalid session path and event cursor parameter types", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () => client.getSession(42 as unknown as string),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_session_id" &&
      /session_id/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.sendUserMessage({
        sessionId: { id: "sess_123" } as unknown as string,
        text: "hello",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_session_id" &&
      /session_id/.test(err.message),
  );

  assert.throws(
    () => client.conversationUrl({ id: "sess_123" } as unknown as string),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_session_id" &&
      /session_id/.test(err.message),
  );

  assert.throws(
    () => client.sessionEventStreamUrl("sess_123", 9 as unknown as string),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_after_id" &&
      /after_id/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("builds conversation direction anchor URLs", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client
      .conversationUrl("sess_123", {
        direction: "before",
        anchorItemId: "item_9",
        limit: 40,
      })
      .toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/conversation?limit=40&direction=before&anchor_item_id=item_9",
  );
  assert.equal(
    client
      .conversationUrl("sess_123", {
        direction: "tail",
        limit: 80,
      })
      .toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/conversation?limit=80&direction=tail",
  );
});

test("rejects invalid conversation direction anchor options before fetch", async () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  await assert.rejects(
    () => client.getConversation("sess_123", { direction: "before" }),
    /anchorItemId is required/,
  );
  await assert.rejects(
    () => client.getConversation("sess_123", { direction: "tail", anchorItemId: "item_1" }),
    /direction=tail cannot include anchorItemId/,
  );
  await assert.rejects(
    () => client.getConversation("sess_123", { anchorItemId: "item_1" }),
    /anchorItemId requires direction/,
  );
});

test("builds pending requests view URLs with status filters", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client.requestsUrl("sess_123").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/requests",
  );
  assert.equal(
    client.requestsUrl("sess_123", { status: "pending" }).toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/requests?status=pending",
  );
});

test("fetch event stream transport reports normal stream completion", async () => {
  const events: string[] = [];
  let closeCount = 0;
  const requests: RequestInit[] = [];
  const spans: Array<{ ended?: boolean; status?: { code: number; message?: string } }> = [];
  const observability = {
    startSpan() {
      const span = {
        setAttribute() {},
        setStatus(status: { code: number; message?: string }) {
          this.status = status;
        },
        end() {
          this.ended = true;
        },
      };
      spans.push(span);
      return span;
    },
    recordError() {},
    traceparent() {
      return "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    },
  };
  const transport = createFetchVelaEventStreamTransport(async (_url, init) => {
    requests.push(init ?? {});
    return new Response(
      'event: turn.completed\ndata: {"type":"turn.completed","event_id":"evt_1","epoch":1,"seq":1}\n\n',
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }, {
    observability,
  });

  transport.subscribe(new URL("http://127.0.0.1:3857/api/v1/sessions/sess_1/events/stream"), {
    onClose: () => {
      closeCount += 1;
    },
    onEvent: (event) => {
      events.push(event.type);
    },
  });

  await waitUntil(() => closeCount === 1);
  assert.deepEqual(events, ["turn.completed"]);
  assert.equal(
    new Headers(requests[0].headers).get("traceparent"),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assert.equal(spans[0].ended, true);
});

test("builds diff review view URLs", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client.diffsUrl("sess_123").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/diffs",
  );
});

test("rejects invalid pending request status filters before fetch", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () => client.getRequests("sess_123", { status: "blocked" as never }),
    /status/,
  );
  assert.equal(requests.length, 0);
});

test("rejects invalid conversation view window options before fetch", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () => client.getConversation("sess_123", { limit: 0 }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_conversation_window_options" &&
      /limit/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getConversation("sess_123", {
        direction: "sideways",
        anchorItemId: "item_1",
      } as unknown as Parameters<typeof client.getConversation>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_conversation_window_options" &&
      /direction/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getConversation("sess_123", {
        direction: "before",
        anchorItemId: 123,
      } as unknown as Parameters<typeof client.getConversation>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_conversation_window_options" &&
      /anchorItemId/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("validates conversation view item shape at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [
            {
              id: "msg_bad",
              kind: "assistant_message",
              created_at: "2026-06-19T00:00:00Z",
              status: "streaming",
              source_event_ids: ["evt_1"],
            },
          ],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getConversation("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_conversation_view" &&
      /updated_at/.test(err.message),
  );
});

test("validates conversation message parts at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [
            {
              id: "msg_bad_parts",
              kind: "user_message",
              created_at: "2026-06-19T00:00:00Z",
              updated_at: "2026-06-19T00:00:00Z",
              revision: 1,
              text: "see image",
              status: "completed",
              source_event_ids: ["evt_1"],
              source_event_ranges: [
                { epoch: 1, from_event_id: "evt_1", to_event_id: "evt_1", from_seq: 1, to_seq: 1 },
              ],
              parts: [
                {
                  id: "part_image",
                  type: "image",
                  data: "not an object",
                },
              ],
            },
          ],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getConversation("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_conversation_view" &&
      /parts\[0\]\.data/.test(err.message),
  );
});

test("validates conversation agent work detail at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [
            {
              id: "work_bad_detail",
              kind: "agent_work",
              created_at: "2026-06-19T00:00:00Z",
              updated_at: "2026-06-19T00:00:00Z",
              revision: 1,
              status: "completed",
              title: "Ran command",
              detail: { command: "ls -la" },
              source_event_ids: ["evt_1"],
              source_event_ranges: [
                { epoch: 1, from_event_id: "evt_1", to_event_id: "evt_1", from_seq: 1, to_seq: 1 },
              ],
            },
          ],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getConversation("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_work_detail" &&
      /detail\.type/.test(err.message),
  );
});

test("keeps OpenAPI-required conversation item fields required in the client wire model", async () => {
  const source = clientSource;
  const baseInterface =
    source.match(/export interface ConversationWireItemBase \{[\s\S]*?\n\}/)?.[0] ?? "";
  const viewInterface =
    source.match(/export interface ConversationWireView \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(viewInterface, /items:\s*ConversationWireItem\[\]/);
  assert.match(baseInterface, /updated_at:\s*string/);
  assert.match(baseInterface, /revision:\s*number/);
  assert.match(baseInterface, /status:\s*ConversationItemStatusWire/);
  assert.match(baseInterface, /source_event_ids:\s*string\[\]/);
  assert.match(baseInterface, /source_event_ranges:\s*SourceEventRangeWire\[\]/);
  assert.doesNotMatch(baseInterface, /updated_at\?:\s*string/);
  assert.doesNotMatch(baseInterface, /revision\?:\s*number/);
  assert.doesNotMatch(baseInterface, /status\?:\s*string/);
  assert.doesNotMatch(baseInterface, /source_event_ids\?:\s*string\[\]/);
  assert.doesNotMatch(baseInterface, /source_event_ranges\?:\s*SourceEventRangeWire\[\]/);
});

test("keeps OpenAPI conversation and agent work enums narrow in the client wire model", async () => {
  const source = clientSource;
  const baseInterface =
    source.match(/export interface ConversationWireItemBase \{[\s\S]*?\n\}/)?.[0] ?? "";
  const partInterface =
    source.match(/export interface MessagePartWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const detailUnion =
    source.match(/export type AgentWorkDetailWire\s*=[\s\S]*?AgentWorkGenericDetailWire;/)?.[0] ??
    "";

  assert.match(source, /export type ConversationItemKindWire\s*=/);
  assert.match(source, /export type ConversationItemStatusWire\s*=/);
  assert.match(source, /export type MessagePartTypeWire\s*=/);
  assert.match(baseInterface, /kind:\s*ConversationItemKindWire/);
  assert.match(baseInterface, /status:\s*ConversationItemStatusWire/);
  assert.match(partInterface, /type:\s*MessagePartTypeWire/);
  assert.match(source, /export type AgentWorkDetailWire\s*=/);
  assert.match(detailUnion, /AgentWorkShellDetailWire/);
  assert.match(detailUnion, /AgentWorkFileDetailWire/);
  assert.match(detailUnion, /AgentWorkSearchDetailWire/);
  assert.match(detailUnion, /AgentWorkFetchDetailWire/);
  assert.match(detailUnion, /AgentWorkGenericDetailWire/);
  assert.doesNotMatch(source, /export interface ChatTranscriptWireView/);
  assert.doesNotMatch(source, /export interface ActivityWireView/);
});

test("keeps OpenAPI backend status enum separate from conversation item status", async () => {
  const source = clientSource;
  const backendInterface = source.match(/export interface BackendWire \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type BackendStatusWire\s*=/);
  assert.match(source, /export type BackendLocationKindWire\s*=/);
  assert.match(backendInterface, /status:\s*BackendStatusWire/);
  assert.match(backendInterface, /location:\s*BackendLocationWire/);
  assert.match(source, /kind:\s*kind as BackendLocationKindWire/);
  assert.doesNotMatch(backendInterface, /status:\s*string/);
  assert.match(source, /status:\s*status as BackendStatusWire/);
  assert.doesNotMatch(source, /status:\s*status as ConversationItemStatusWire,\n\s*display_name/);
});

test("keeps OpenAPI session backend and status enums narrow in the client wire model", async () => {
  const source = clientSource;
  const sessionInterface = source.match(/export interface SessionWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const createSessionInputInterface =
    source.match(/export interface CreateSessionInput \{[\s\S]*?\n\}/)?.[0] ?? "";
  const runtimeInfoInterface =
    source.match(/export interface SessionRuntimeInfoWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const veladClientInterface =
    source.match(/export interface VeladClient \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type BackendKindWire\s*=/);
  assert.match(source, /export type SessionStatusWire\s*=/);
  assert.match(source, /export type SessionActivityPhaseWire\s*=/);
  assert.match(source, /export type SessionActivityAttentionWire\s*=/);
  assert.match(sessionInterface, /backend:\s*BackendKindWire/);
  assert.match(createSessionInputInterface, /backend:\s*BackendKindWire/);
  assert.match(veladClientInterface, /getBackend:\s*\(backend:\s*BackendKindWire\)/);
  assert.match(veladClientInterface, /probeBackend:\s*\(backend:\s*BackendKindWire\)/);
  assert.match(sessionInterface, /status:\s*SessionStatusWire/);
  assert.match(sessionInterface, /activity\?:\s*SessionActivityWire/);
  assert.match(runtimeInfoInterface, /provider:\s*BackendKindWire/);
  assert.match(source, /backend:\s*backend as BackendKindWire/);
  assert.match(source, /status:\s*status as SessionStatusWire/);
  assert.match(source, /phase:\s*phase as SessionActivityPhaseWire/);
  assert.match(source, /attention:\s*attention as SessionActivityAttentionWire/);
  assert.match(source, /provider:\s*provider as BackendKindWire/);
  assert.doesNotMatch(sessionInterface, /backend:\s*"pi"\s*\|\s*string/);
  assert.doesNotMatch(createSessionInputInterface, /backend\?:/);
  assert.doesNotMatch(createSessionInputInterface, /backend:[\s\S]*\|\s*string/);
  assert.doesNotMatch(veladClientInterface, /getBackend:\s*\(backend:\s*string\)/);
  assert.doesNotMatch(veladClientInterface, /probeBackend:\s*\(backend:\s*string\)/);
  assert.doesNotMatch(sessionInterface, /status:\s*string/);
  assert.doesNotMatch(runtimeInfoInterface, /provider:\s*string/);
});

test("keeps OpenAPI-required Session fields required in the client wire model", async () => {
  const source = clientSource;
  const sessionInterface = source.match(/export interface SessionWire \{[\s\S]*?\n\}/)?.[0] ?? "";

  for (const field of ["title", "working_directory", "created_at", "updated_at"]) {
    assert.match(sessionInterface, new RegExp(`${field}:\\s*string`));
    assert.doesNotMatch(sessionInterface, new RegExp(`${field}\\?:\\s*string`));
    assert.match(source, new RegExp(`requiredViewString\\(data,\\s*"${field}"`));
  }
});

test("keeps OpenAPI EventCursor separate from cursor windows in the client wire model", async () => {
  const source = clientSource;
  const eventCursorInterface = source.match(/export interface EventCursorWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const cursorWindowInterface = source.match(/export interface CursorWindow \{[\s\S]*?\n\}/)?.[0] ?? "";

  for (const field of ["event_id", "epoch", "seq"]) {
    assert.match(eventCursorInterface, new RegExp(`${field}:\\s*`));
  }
  assert.doesNotMatch(eventCursorInterface, /latest_event_id/);
  assert.doesNotMatch(eventCursorInterface, /next_event_id/);
  assert.match(cursorWindowInterface, /from_seq\?:\s*number/);
  assert.match(cursorWindowInterface, /to_seq\?:\s*number/);
  assert.match(cursorWindowInterface, /latest_event_id\?:\s*string/);
  assert.match(cursorWindowInterface, /next_event_id\?:\s*string/);
  assert.match(source, /optionalViewInteger\(value,\s*"from_seq"/);
  assert.match(source, /optionalViewInteger\(value,\s*"to_seq"/);
  assert.match(
    source,
    /isVelaStreamEventFreshForCursor\(\s*cursor:\s*EventCursorWire\s*\|\s*CursorWindow\s*\|\s*undefined/,
  );
});

test("parses conversation item source event ranges as required lineage", () => {
  const parsed = parseConversationWireView(
    conversationFixture({
      items: [
        assistantConversationItem({
          source_event_ranges: [
            { epoch: 1, from_event_id: "evt_1", to_event_id: "evt_3", from_seq: 1, to_seq: 3 },
          ],
        }),
      ],
    }),
  );

  assert.deepEqual(parsed.items[0]?.source_event_ranges, [
    { epoch: 1, from_event_id: "evt_1", to_event_id: "evt_3", from_seq: 1, to_seq: 3 },
  ]);

  assert.throws(
    () =>
      parseConversationWireView(
        conversationFixture({
          items: [
            {
              ...assistantConversationItem(),
              source_event_ranges: undefined,
            },
          ],
        }),
      ),
    /source_event_ranges/,
  );
});

test("keeps OpenAPI backend feature discriminators narrow in the client wire model", async () => {
  const source = clientSource;
  const toggleInterface =
    source.match(/export interface BackendToggleFeatureWire(?: extends \w+)? \{[\s\S]*?\n\}/)?.[0] ??
    "";
  const selectInterface =
    source.match(/export interface BackendSelectFeatureWire(?: extends \w+)? \{[\s\S]*?\n\}/)?.[0] ??
    "";

  assert.match(
    source,
    /export type BackendFeatureWire\s*=\s*BackendToggleFeatureWire\s*\|\s*BackendSelectFeatureWire/,
  );
  assert.match(toggleInterface, /type:\s*"toggle"/);
  assert.match(toggleInterface, /default_value:\s*boolean/);
  assert.match(selectInterface, /type:\s*"select"/);
  assert.match(selectInterface, /options:\s*ReasoningEffortOptionWire\[\]/);
  assert.match(source, /type:\s*"toggle"/);
  assert.match(source, /type:\s*"select"/);
  assert.doesNotMatch(source, /export interface BackendFeatureWire \{[\s\S]*?type:\s*string/);
});

test("keeps OpenAPI backend capabilities required booleans in the client wire model", async () => {
  const source = clientSource;
  const capabilitiesInterface =
    source.match(/export interface BackendCapabilitiesWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const backendInterface = source.match(/export interface BackendWire \{[\s\S]*?\n\}/)?.[0] ?? "";

  for (const field of [
    "streaming",
    "cancel",
    "permission_requests",
    "structured_diff",
    "session_agent_config",
  ]) {
    assert.match(capabilitiesInterface, new RegExp(`${field}:\\s*boolean`));
  }
  assert.match(backendInterface, /capabilities:\s*BackendCapabilitiesWire/);
  assert.match(
    source,
    /function requiredBackendCapabilities\([\s\S]*?data: Record<string, unknown>[\s\S]*?owner: string[\s\S]*?\): BackendCapabilitiesWire/,
  );
  assert.doesNotMatch(backendInterface, /capabilities:\s*Record<string, unknown>/);
});

test("keeps OpenAPI AgentConfig fields non-null while runtime info may be nullable", async () => {
  const source = clientSource;
  const agentConfigInterface = source.match(/export interface AgentConfigWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const runtimeInfoInterface =
    source.match(/export interface SessionRuntimeInfoWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_config" }),
          effective_after: "current_session",
          cursor: { event_id: "evt_config", epoch: 1, seq: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.doesNotMatch(agentConfigInterface, /model\?:\s*string\s*\|\s*null/);
  assert.doesNotMatch(agentConfigInterface, /reasoning_effort\?:\s*string\s*\|\s*null/);
  assert.doesNotMatch(agentConfigInterface, /permission_mode\?:\s*PermissionModeWire\s*\|\s*null/);
  assert.match(runtimeInfoInterface, /model\?:\s*string\s*\|\s*null/);
  assert.match(runtimeInfoInterface, /reasoning_effort\?:\s*string\s*\|\s*null/);
  assert.match(runtimeInfoInterface, /permission_mode\?:\s*PermissionModeWire\s*\|\s*null/);

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_null_model",
        patch: { model: null } as unknown as Parameters<
          typeof client.updateAgentConfig
        >[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /model/.test(err.message),
  );
  assert.equal(requests.length, 0);
});

test("keeps OpenAPI agent request enums narrow in the client wire model", async () => {
  const source = clientSource;
  const requestInterface = source.match(/export interface AgentRequestWire \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type AgentRequestTypeWire\s*=/);
  assert.match(source, /export type RequestStatusWire\s*=/);
  assert.match(requestInterface, /type:\s*AgentRequestTypeWire/);
  assert.match(requestInterface, /status:\s*RequestStatusWire/);
  assert.match(source, /type:\s*type as AgentRequestTypeWire/);
  assert.match(source, /status:\s*status as RequestStatusWire/);
  assert.doesNotMatch(requestInterface, /type:\s*string/);
  assert.doesNotMatch(requestInterface, /status:\s*string/);
});

test("validates diff review view at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          diffs: [
            {
              file_path: "src/app.ts",
              status: "modified",
              additions: 12,
              deletions: 3,
            },
            {
              file_path: "README.md",
              status: "added",
            },
          ],
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  assert.deepEqual(await client.getDiffs("sess_123"), {
    diffs: [
      {
        file_path: "src/app.ts",
        status: "modified",
        additions: 12,
        deletions: 3,
      },
      {
        file_path: "README.md",
        status: "added",
      },
    ],
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
  });
});

test("validates diff summary required fields at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          diffs: [{ file_path: "src/app.ts" }],
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getDiffs("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_diff_review_view" &&
      /status/.test(err.message),
  );
});

test("validates pending requests view at the client wire boundary", async () => {
  let fetchCount = 0;
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          requests: [
            {
              id: "req_1",
              session_id: "sess_123",
              type: "permission",
              status: "pending",
              title: "Allow command?",
              description: "The agent wants to run ls",
              payload: { command: "ls" },
              backend_ref: { event_id: "backend_evt_1" },
              created_at: "2026-06-19T00:00:00Z",
            },
          ],
          cursor: { epoch: 1, from_seq: 10, to_seq: 11, next_event_id: "evt_2" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const expected = {
    requests: [
      {
        id: "req_1",
        session_id: "sess_123",
        type: "permission",
        status: "pending",
        title: "Allow command?",
        description: "The agent wants to run ls",
        payload: { command: "ls" },
        backend_ref: { event_id: "backend_evt_1" },
        created_at: "2026-06-19T00:00:00Z",
      },
    ],
    cursor: { epoch: 1, from_seq: 10, to_seq: 11, next_event_id: "evt_2" },
  };

  assert.deepEqual(await client.getRequests("sess_123", { status: "pending" }), expected);
  assert.deepEqual(await client.getPendingRequests("sess_123", { status: "pending" }), expected);
  assert.equal(fetchCount, 2);
});

test("validates pending request required fields at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          requests: [
            {
              id: "req_bad",
              session_id: "sess_123",
              type: "permission",
              created_at: "2026-06-19T00:00:00Z",
            },
          ],
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getRequests("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_pending_requests_view" &&
      /status/.test(err.message),
  );
});

test("creates a local pi session with idempotency key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_created", title: "New chat" }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const created = await client.createSession({
    idempotencyKey: "ses_created",
    backend: "pi",
    title: "New chat",
    workingDirectory: "/tmp/project",
  });

  assert.equal(created.session.id, "ses_created");
  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal((requests[0]?.init?.headers as Record<string, string>)["Idempotency-Key"], "ses_created");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    backend: "pi",
    working_directory: "/tmp/project",
    title: "New chat",
  });
});

test("adds traceparent header and records failed create session fetches", async () => {
  const spans: Array<{
    name: string;
    attributes?: Record<string, unknown>;
    status?: { code: number; message?: string };
    ended?: boolean;
    error?: string;
  }> = [];
  const logs: Array<{
    body: string;
    severityText?: string;
    attributes?: Record<string, unknown>;
  }> = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const observability = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span = {
        name,
        attributes: options?.attributes,
        setAttribute(key: string, value: string | number | boolean) {
          this.attributes = { ...this.attributes, [key]: value };
        },
        setStatus(status: { code: number; message?: string }) {
          this.status = status;
        },
        end() {
          this.ended = true;
        },
      };
      spans.push(span);
      return span;
    },
    recordError(span: (typeof spans)[number], error: unknown) {
      span.error = error instanceof Error ? error.message : String(error);
      span.status = { code: 2, message: span.error };
    },
    traceparent() {
      return "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    },
    emitLog(record: { body: string; severityText?: string; attributes?: Record<string, unknown> }) {
      logs.push(record);
    },
  };
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    observability,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      throw new Error("failed to fetch");
    },
  });

  await assert.rejects(
    () =>
      client.createSession({
        idempotencyKey: "ses_created",
        backend: "codex",
        workingDirectory: "/tmp/project",
      }),
    /failed to fetch/,
  );

  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).traceparent,
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assert.equal(spans[0].name, "velad.session.create");
  assert.equal(spans[0].error, "failed to fetch");
  assert.equal(spans[0].ended, true);
  assert.equal(logs[0].severityText, "ERROR");
  assert.equal(logs[0].body, "failed to fetch");
  assert.equal(logs[0].attributes?.["vela.operation"], "velad.session.create");
});

test("archives a session with explicit archive action endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_archive",
            status: "archived",
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const response = await client.archiveSession({ sessionId: "ses_archive" });

  assert.equal(response.session.id, "ses_archive");
  assert.equal(response.session.status, "archived");
  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions/ses_archive/archive");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(requests[0]?.init?.body, undefined);
});

test("lists recent sessions for debug launchers", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          sessions: [
            sessionFixture({
              id: "ses_recent",
              backend: "acp",
              title: "Hermes debug",
              working_directory: "/tmp/project",
            }),
          ],
          cursor: { event_id: "evt_1", epoch: 1, seq: 1, has_older: false, has_newer: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const response = await client.listSessions({ limit: 12 });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions?limit=12");
  assert.equal(requests[0]?.init?.method, undefined);
  assert.equal(response.sessions[0]?.id, "ses_recent");
  assert.equal(response.sessions[0]?.backend, "acp");
  assert.equal(response.cursor.event_id, "evt_1");
});

test("reads SessionListView from UI read-model endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          sessions: [
            {
              id: "ses_recent",
              backend: "acp",
              status: "running",
              title: "Hermes debug",
              working_directory: "/tmp/project",
              created_at: "2026-06-19T00:00:00Z",
              updated_at: "2026-06-19T00:10:00Z",
              last_activity_at: "2026-06-19T00:10:00Z",
              preview: "Inspecting the repo",
              pending_request_count: 2,
              activity: {
                phase: "idle",
                attention: "waiting_for_user",
                pending_request_count: 2,
              },
              running: true,
              agent_config: {
                model: "minimax-m2.7",
                reasoning_effort: "medium",
              },
            },
          ],
          cursor: { event_id: "evt_9", epoch: 1, seq: 9, has_older: false, has_newer: true },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const response = await client.getSessionListView({ limit: 20, afterId: "ses_anchor" });

  assert.equal(
    requests[0]?.url,
    "http://127.0.0.1:3857/api/v1/views/sessions?limit=20&after_id=ses_anchor",
  );
  assert.equal(requests[0]?.init?.method, undefined);
  assert.equal(response.sessions[0]?.id, "ses_recent");
  assert.equal(response.sessions[0]?.working_directory, "/tmp/project");
  assert.equal(response.sessions[0]?.preview, "Inspecting the repo");
  assert.equal(response.sessions[0]?.pending_request_count, 2);
  assert.equal(response.sessions[0]?.activity?.phase, "idle");
  assert.equal(response.sessions[0]?.activity?.attention, "waiting_for_user");
  assert.equal(response.sessions[0]?.activity?.pending_request_count, 2);
  assert.equal(response.sessions[0]?.running, true);
  assert.equal(response.sessions[0]?.agent_config?.model, "minimax-m2.7");
});

test("creates a session with selected backend and agent config", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_acp",
            backend: "acp",
            title: "Hermes test",
            agent_config: {
              model: "minimax-m2.7",
              reasoning_effort: "medium",
              permission_mode: "auto",
            },
          }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await client.createSession({
    idempotencyKey: "ses_acp",
    backend: "acp",
    title: "Hermes test",
    workingDirectory: "/tmp/project",
    agentConfig: {
      model: "minimax-m2.7",
      reasoning_effort: "medium",
      permission_mode: "auto",
    },
  });

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    backend: "acp",
    working_directory: "/tmp/project",
    title: "Hermes test",
    agent_config: {
      model: "minimax-m2.7",
      reasoning_effort: "medium",
      permission_mode: "auto",
    },
  });
});

test("rejects invalid create session requests before sending", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_created" }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await assert.rejects(
    () =>
      client.createSession({
        workingDirectory: 42,
      } as unknown as Parameters<typeof client.createSession>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_request" &&
      /working_directory/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.createSession({
        workingDirectory: "/tmp/project",
      } as unknown as Parameters<typeof client.createSession>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_request" &&
      /backend/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.createSession({
        backend: "unknown_backend",
        workingDirectory: "/tmp/project",
      } as unknown as Parameters<typeof client.createSession>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_request" &&
      /backend/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.createSession({
        backend: "pi",
        workingDirectory: "/tmp/project",
        agentConfig: { permission_mode: "god_mode" },
      } as unknown as Parameters<typeof client.createSession>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_request" &&
      /permission_mode/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("rejects invalid idempotency key header values before mutating requests", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 202 });
    },
  });

  await assert.rejects(
    () =>
      client.createSession({
        idempotencyKey: 99 as unknown as string,
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_idempotency_key" &&
      /Idempotency-Key/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: { key: "cfg_1" } as unknown as string,
        patch: { model: "minimax-m2.7" },
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_idempotency_key" &&
      /Idempotency-Key/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.sendUserMessage({
        sessionId: "ses_message",
        idempotencyKey: false as unknown as string,
        text: "hello",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_idempotency_key" &&
      /Idempotency-Key/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("validates session mutation response envelopes at the client wire boundary", async () => {
  const createClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_missing_cursor" }),
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      createClient.createSession({
        idempotencyKey: "ses_missing_cursor",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /cursor/.test(err.message),
  );

  const badSessionIdClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: 123 }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionIdClient.createSession({
        idempotencyKey: "ses_bad_id",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /session\.id/.test(err.message),
  );

  const badSessionBackendClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_bad_backend", backend: "unknown" }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionBackendClient.createSession({
        idempotencyKey: "ses_bad_backend",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /session\.backend/.test(err.message),
  );

  const badSessionStatusClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_bad_status", status: "sleeping" }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionStatusClient.createSession({
        idempotencyKey: "ses_bad_status",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /session\.status/.test(err.message),
  );

  const missingSessionTitleClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_missing_title", title: undefined }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      missingSessionTitleClient.createSession({
        idempotencyKey: "ses_missing_title",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /session requires title/.test(err.message),
  );

  const badSessionAgentConfigClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_bad_agent_config",
            agent_config: { permission_mode: "god_mode" },
          }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionAgentConfigClient.createSession({
        idempotencyKey: "ses_bad_agent_config",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /agent_config permission_mode/.test(err.message),
  );

  const badSessionRuntimeInfoClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_bad_runtime_info",
            runtime_info: { model: "minimax-m2.7" },
          }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionRuntimeInfoClient.createSession({
        idempotencyKey: "ses_bad_runtime_info",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /runtime_info\.provider/.test(err.message),
  );

  const badSessionOperationsClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_bad_operations",
            operations: {
              update_agent_config: { effective_after: "next_turn" },
            },
          }),
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      badSessionOperationsClient.createSession({
        idempotencyKey: "ses_bad_operations",
        backend: "pi",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /operations\.update_agent_config\.available/.test(err.message),
  );

  const updateClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_bad_effect" }),
          effective_after: "immediate",
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      updateClient.updateAgentConfig({
        sessionId: "ses_bad_effect",
        patch: { model: "minimax-m2.7" },
        idempotencyKey: "cfg_bad_effect",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_update_agent_config_response" &&
      /effective_after/.test(err.message),
  );
});

test("validates query response envelopes at the client wire boundary", async () => {
  const sessionClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(JSON.stringify({ cursor: { event_id: "evt_1", epoch: 1, seq: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assert.rejects(
    () => sessionClient.getSession("ses_missing_session"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_session_response" &&
      /session/.test(err.message),
  );

  const backendClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(JSON.stringify({ backends: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assert.rejects(
    () => backendClient.getBackends(),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backends_response" &&
      /backends/.test(err.message),
  );

  const backendItemClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(JSON.stringify({ backends: [{ kind: "pi", status: "available" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assert.rejects(
    () => backendItemClient.getBackends(),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backends_response" &&
      /display_name/.test(err.message),
  );
});

test("validates backend catalog nested option shapes at the client wire boundary", async () => {
  const backendWith = (overrides: Record<string, unknown>) => ({
    kind: "pi",
    display_name: "Pi Coding",
    status: "available",
    location: { kind: "local", label: "Local" },
    capabilities: {
      streaming: true,
      cancel: true,
      permission_requests: false,
      structured_diff: false,
      session_agent_config: true,
    },
    models: [],
    permission_modes: [{ id: "full_access", label: "Full access" }],
    features: [],
    ...overrides,
  });

  const modelClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({ backends: [backendWith({ models: [{ id: "minimax-m2.7" }] })] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => modelClient.getBackends(),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backends_response" &&
      /models\[0\].label/.test(err.message),
  );

  const permissionClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          backends: [backendWith({ permission_modes: [{ id: "god_mode", label: "God" }] })],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => permissionClient.getBackends(),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backends_response" &&
      /permission_modes\[0\].id/.test(err.message),
  );

  const featureClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          backends: [backendWith({ features: [{ type: "select", id: "mode", label: "Mode" }] })],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => featureClient.getBackends(),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backends_response" &&
      /features\[0\].options/.test(err.message),
  );
});

test("parses backend error snapshots with status message", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          backends: [
            {
              kind: "codex",
              display_name: "Codex",
              status: "error",
              status_message: "model discovery failed: invalid config",
              location: { kind: "local", label: "Local" },
              capabilities: {
                streaming: true,
                cancel: true,
                permission_requests: true,
                structured_diff: true,
                session_agent_config: true,
              },
              models: [],
              permission_modes: [{ id: "auto", label: "Default permissions" }],
              features: [],
              snapshot_protocol: "velad.backend_snapshot.v1",
              fetched_at: "2026-06-25T00:00:00Z",
              diagnostics: {
                model_source: "none",
                error: {
                  code: "model_discovery_failed",
                  stage: "model_discovery",
                  message: "invalid config",
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  const response = await client.getBackends();

  assert.equal(response.backends[0]?.status, "error");
  assert.equal(response.backends[0]?.status_message, "model discovery failed: invalid config");
  assert.equal(response.backends[0]?.snapshot_protocol, "velad.backend_snapshot.v1");
  assert.equal(response.backends[0]?.fetched_at, "2026-06-25T00:00:00Z");
  assert.deepEqual(response.backends[0]?.models, []);
});

test("fetches one backend detail and validates backend path kind before fetch", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          backend: {
            kind: "pi",
            display_name: "Pi Coding",
            status: "available",
            location: { kind: "local", label: "Local" },
            capabilities: {
              streaming: true,
              cancel: true,
              permission_requests: false,
              structured_diff: false,
              session_agent_config: true,
            },
            models: [{ id: "minimax-m2.7", label: "MiniMax M2.7" }],
            permission_modes: [{ id: "full_access", label: "Full access" }],
            features: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const backend = await client.getBackend("pi");

  assert.equal(backend.backend.kind, "pi");
  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/backends/pi");

  await assert.rejects(
    () => client.getBackend("unknown_backend" as unknown as Parameters<typeof client.getBackend>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backend_kind" &&
      /backend/.test(err.message),
  );
  assert.equal(requests.length, 1);
});

test("probes backend health and validates probe response before callers see it", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          backend: "pi",
          status: "available",
          message: "ready",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await client.probeBackend("pi");

  assert.deepEqual(result, { backend: "pi", status: "available", message: "ready" });
  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/backends/pi/probe");
  assert.equal(requests[0]?.init?.method, "POST");

  await assert.rejects(
    () => client.probeBackend("unknown_backend" as unknown as Parameters<typeof client.probeBackend>[0]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backend_kind" &&
      /backend/.test(err.message),
  );
  assert.equal(requests.length, 1);
});

test("rejects malformed backend probe responses at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(JSON.stringify({ backend: "pi", status: "sleepy" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assert.rejects(
    () => client.probeBackend("pi"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_backend_probe_response" &&
      /status/.test(err.message),
  );
});

test("fetches session, backend catalog, and patches agent config", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/backends")) {
        return new Response(
          JSON.stringify({
            backends: [
              {
                kind: "pi",
                display_name: "Pi Coding",
                status: "available",
                location: { kind: "local", label: "Local" },
                capabilities: {
                  streaming: true,
                  cancel: true,
                  permission_requests: false,
                  structured_diff: false,
                  session_agent_config: true,
                },
                models: [{ id: "minimax-m2.7", label: "MiniMax M2.7" }],
                permission_modes: [{ id: "full_access", label: "Full access" }],
                features: [],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (String(url).endsWith("/agent-config")) {
        return new Response(
          JSON.stringify({
            session: sessionFixture({
              id: "ses_config",
              agent_config: {
                model: "minimax-m2.7",
                reasoning_effort: "high",
                permission_mode: "full_access",
              },
            }),
            effective_after: "current_session",
            cursor: { event_id: "evt_config", epoch: 1, seq: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          session: sessionFixture({
            id: "ses_config",
            agent_config: { model: "minimax-m2.7" },
            runtime_info: { provider: "pi", model: "minimax-m2.7" },
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const session = await client.getSession("ses_config");
  const backends = await client.getBackends();
  const updated = await client.updateAgentConfig({
    sessionId: "ses_config",
    idempotencyKey: "cfg_1",
    patch: {
      model: "minimax-m2.7",
      reasoning_effort: "high",
      permission_mode: "full_access",
    },
  });

  assert.equal(session.session.agent_config?.model, "minimax-m2.7");
  assert.equal(backends.backends[0]?.models[0]?.id, "minimax-m2.7");
  assert.equal(updated.effective_after, "current_session");
  assert.equal(requests[2]?.url, "http://127.0.0.1:3857/api/v1/sessions/ses_config/agent-config");
  assert.equal(requests[2]?.init?.method, "PATCH");
  assert.equal((requests[2]?.init?.headers as Record<string, string>)["Idempotency-Key"], "cfg_1");
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
    model: "minimax-m2.7",
    reasoning_effort: "high",
    permission_mode: "full_access",
  });
});

test("rejects invalid agent config patches before sending", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: sessionFixture({ id: "ses_config" }),
          effective_after: "current_session",
          cursor: { event_id: "evt_config", epoch: 1, seq: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_empty",
        patch: {} as Parameters<typeof client.updateAgentConfig>[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /at least one field/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_unknown",
        patch: { temperature: 0.5 } as unknown as Parameters<
          typeof client.updateAgentConfig
        >[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /temperature/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_bad_model",
        patch: { model: 5 } as unknown as Parameters<
          typeof client.updateAgentConfig
        >[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /model/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_bad_permission",
        patch: { permission_mode: "god_mode" } as unknown as Parameters<
          typeof client.updateAgentConfig
        >[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /permission_mode/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.updateAgentConfig({
        sessionId: "ses_config",
        idempotencyKey: "cfg_bad_features",
        patch: { feature_values: "fast" } as unknown as Parameters<
          typeof client.updateAgentConfig
        >[0]["patch"],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_agent_config_patch" &&
      /feature_values/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("builds URLs from same-origin proxy base paths", () => {
  const client = createVeladClient({ baseUrl: "/chat/api/velad/api/v1/" });

  assert.equal(
    client.conversationUrl("sess_123").toString(),
    "http://localhost/chat/api/velad/api/v1/sessions/sess_123/views/conversation",
  );
});

test("parses SSE json data frames and ignores keepalive comments", () => {
  assert.deepEqual(parseSseJsonFrames(": keepalive\n\ndata: {\"event_id\":\"evt_1\"}\n\n"), [
    { event_id: "evt_1" },
  ]);
});

test("reads velad stream events from browser MessageEvent payloads", () => {
  const event = readVelaStreamEvent(
    new MessageEvent("assistant.message.delta", {
      data: JSON.stringify({
        event_id: "evt_2",
        epoch: 1,
        seq: 2,
        session_id: "sess_1",
        type: "assistant.message.delta",
        created_at: "2026-06-19T00:00:00Z",
        affected_views: ["conversation"],
        payload: { message_id: "msg_1", delta: "hi" },
      }),
    }),
  );

  assert.equal(event?.event_id, "evt_2");
  assert.equal(event?.type, "assistant.message.delta");
  assert.deepEqual(event?.affected_views, ["conversation"]);
  assert.equal(event?.payload?.delta, "hi");
});

test("ignores named velad stream events with non-object JSON payloads", () => {
  assert.equal(
    readVelaStreamEvent(
      new MessageEvent("assistant.message.delta", {
        data: JSON.stringify("not an event object"),
      }),
    ),
    null,
  );
});

test("plans assistant delta stream events as local overlay only", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_delta",
      type: "assistant.message.delta",
      payload: { message_id: "msg_1", delta: "好" },
    }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
});

test("plans non-message stream events as scoped read-model refreshes", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_session_config",
      type: "session.config.updated",
    }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_session_status",
      type: "session.status.changed",
    }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_session_closed", type: "session.closed" }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_backend_status",
      type: "backend.status.changed",
    }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: true,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_input_queued", type: "input.queued" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_input_rejected", type: "input.rejected" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_turn_started", type: "turn.started" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_turn_cancel_accepted",
      type: "turn.cancel.accepted",
    }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_request_response",
      type: "request.response.accepted",
    }),
    {
      conversation: true,
      requests: true,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_request_opened",
      type: "request.opened",
    }),
    {
      conversation: true,
      requests: true,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_tool", type: "tool.started" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_tool_completed", type: "tool.completed" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_task", type: "task.updated" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_turn", type: "turn.completed" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_turn_cancelled", type: "turn.cancelled" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_usage", type: "usage.updated" }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: true,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_error", type: "error.raised" }),
    {
      conversation: true,
      requests: false,
      diffs: false,
      session: false,
      backends: false,
    },
  );
});

test("uses affected_views as forward-compatible refresh hints for canonical stream events", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_workbench_hint",
      type: "projection.invalidated",
      affected_views: ["workbench"],
    }),
    {
      conversation: true,
      requests: true,
      diffs: true,
      session: true,
      backends: true,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_future",
      type: "future.provider.event",
      affected_views: ["requests", "diffs"],
    }),
    {
      conversation: false,
      requests: true,
      diffs: true,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_backend_hint",
      type: "future.backend.event",
      affected_views: ["backends"],
    }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: false,
      backends: true,
    },
  );
});

test("plans diff stream events for the DiffReviewView read model", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_diff", type: "diff.updated" }),
    {
      conversation: true,
      requests: false,
      diffs: true,
      session: false,
      backends: false,
    },
  );
  assert.equal(
    streamReadModelRefreshPlan({
      event_id: "evt_diff_hint",
      type: "projection.invalidated",
      affected_views: ["diffs"],
    }).diffs,
    true,
  );
});

test("plans workbench sync resets as full workbench refreshes", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_reset",
      type: "sync.reset",
      views: ["workbench"],
    }),
    {
      conversation: true,
      requests: true,
      diffs: true,
      session: true,
      backends: true,
    },
  );
});

test("accepts plural session view hints in sync resets", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_reset_sessions",
      type: "sync.reset",
      views: ["sessions"],
    }),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
});

test("matches stream events to the active session while accepting cursorless events", () => {
  assert.equal(
    isVelaStreamEventForSession("sess_1", {
      event_id: "evt_same",
      session_id: "sess_1",
      type: "turn.completed",
    }),
    true,
  );
  assert.equal(
    isVelaStreamEventForSession("sess_1", {
      event_id: "evt_cursorless",
      type: "turn.completed",
    }),
    true,
  );
  assert.equal(
    isVelaStreamEventForSession("sess_1", {
      event_id: "evt_other",
      session_id: "sess_2",
      type: "turn.completed",
    }),
    false,
  );
});

test("matches stream events to cursor order while accepting cursorless events", () => {
  const cursor = { event_id: "evt_5", epoch: 1, seq: 5 };
  const windowCursor = { epoch: 1, from_seq: 1, to_seq: 5 };

  assert.equal(
    isVelaStreamEventFreshForCursor(cursor, {
      event_id: "evt_6",
      epoch: 1,
      seq: 6,
      type: "turn.completed",
    }),
    true,
  );
  assert.equal(
    isVelaStreamEventFreshForCursor(cursor, {
      event_id: "evt_5",
      epoch: 1,
      seq: 5,
      type: "turn.completed",
    }),
    false,
  );
  assert.equal(
    isVelaStreamEventFreshForCursor(cursor, {
      event_id: "evt_old_epoch",
      epoch: 0,
      seq: 99,
      type: "turn.completed",
    }),
    false,
  );
  assert.equal(
    isVelaStreamEventFreshForCursor(windowCursor, {
      event_id: "evt_6",
      epoch: 1,
      seq: 6,
      type: "turn.completed",
    }),
    true,
  );
  assert.equal(
    isVelaStreamEventFreshForCursor(windowCursor, {
      event_id: "evt_5",
      epoch: 1,
      seq: 5,
      type: "turn.completed",
    }),
    false,
  );
  assert.equal(
    isVelaStreamEventFreshForCursor(cursor, {
      event_id: "evt_cursorless",
      type: "turn.completed",
    }),
    true,
  );
});

test("selects a conservative session stream replay cursor from event-cursor read models", () => {
  assert.equal(
    selectSessionEventStreamAfterId({
      conversation: { event_id: "evt_conversation_100", epoch: 1, seq: 100 },
    }),
    "evt_conversation_100",
  );
  assert.equal(
    selectSessionEventStreamAfterId({
      conversation: null,
    }),
    null,
  );
});

test("filters stream refresh plans with the conversation read-model cursor", () => {
  assert.deepEqual(
    streamReadModelRefreshPlanForCursors(
      {
        event_id: "evt_turn_completed_95",
        epoch: 1,
        seq: 95,
        session_id: "sess_1",
        type: "turn.completed",
      },
      {
        conversation: { event_id: "evt_conversation_100", epoch: 1, seq: 100 },
      },
    ),
    {
      conversation: false,
      requests: false,
      diffs: false,
      session: true,
      backends: false,
    },
  );
});

test("rejects already-seen stream event ids even when order fields are absent", () => {
  assert.equal(
    isVelaStreamEventFreshForCursor(
      { event_id: "evt_same" },
      {
        event_id: "evt_same",
        type: "assistant.message.delta",
        payload: { delta: "duplicate" },
      },
    ),
    false,
  );
});

test("rejects already-seen stream event cursor aliases when order fields are absent", () => {
  for (const cursor of [
    { latest_event_id: "evt_same" },
    { next_event_id: "evt_same" },
  ]) {
    assert.equal(
      isVelaStreamEventFreshForCursor(cursor, {
        event_id: "evt_same",
        type: "assistant.message.delta",
        payload: { delta: "duplicate" },
      }),
      false,
    );
  }
});

test("applies assistant delta live overlays to existing conversation assistant items immediately", () => {
  const conversation = conversationFixture({
    items: [assistantConversationItem({ text: "你" })],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_2",
    epoch: 1,
    seq: 2,
    session_id: "sess_1",
    type: "assistant.message.delta",
    created_at: "2026-06-19T00:00:01Z",
    payload: { message_id: "msg_1", delta: "好" },
  });

  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "你好");
  assert.equal(next.items[0]?.revision, 2);
  assert.equal(next.cursor.event_id, "evt_2");
});

test("appends assistant delta live overlays after existing conversation text", () => {
  const conversation = conversationFixture({
    items: [
      assistantConversationItem({
        text: "第一段",
        parts: [{ id: "msg_1:part:0", type: "text" as const, text: "第一段" }],
      }),
    ],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_2",
    epoch: 1,
    seq: 2,
    session_id: "sess_1",
    type: "assistant.message.delta",
    created_at: "2026-06-19T00:00:01Z",
    payload: { message_id: "msg_1", delta: "第二段" },
  });

  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "第一段第二段");
  assert.equal(next.items[0]?.revision, 2);
});

test("does not append duplicate assistant delta live overlays", () => {
  const conversation = conversationFixture({
    cursor: { event_id: "evt_2", epoch: 1, seq: 2 },
    items: [
      assistantConversationItem({
        revision: 2,
        text: "你好",
        source_event_ids: ["evt_1", "evt_2"],
      }),
    ],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_2",
    epoch: 1,
    seq: 2,
    session_id: "sess_1",
    type: "assistant.message.delta",
    payload: { message_id: "msg_1", delta: "好" },
  });

  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "你好");
  assert.equal(next.items[0]?.revision, 2);
});

test("does not resurrect completed assistant items from late delta overlays", () => {
  const conversation = conversationFixture({
    cursor: { event_id: "evt_completed", epoch: 1, seq: 10 },
    items: [
      assistantConversationItem({
        updated_at: "2026-06-19T00:00:10Z",
        revision: 4,
        text: "已经完成",
        status: "completed" as const,
        source_event_ids: ["evt_1", "evt_completed"],
      }),
    ],
  });
  const event = {
    event_id: "evt_late_delta",
    epoch: 1,
    seq: 11,
    session_id: "sess_1",
    type: "assistant.message.delta",
    created_at: "2026-06-19T00:00:11Z",
    payload: { message_id: "msg_1", delta: "迟到" },
  };

  const next = applyConversationLiveOverlay(conversation, event);

  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "已经完成");
  assert.equal(next.items[0]?.status, "completed");
  assert.equal(next.items[0]?.revision, 4);
  assert.equal(needsConversationRefreshAfterLiveOverlay(conversation, event), true);
});

test("ignores stale assistant delta live overlay events", () => {
  const conversation = conversationFixture({
    cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
    items: [assistantConversationItem({ revision: 12, text: "新文本", source_event_ids: ["evt_live"] })],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_old",
    epoch: 1,
    seq: 10,
    session_id: "sess_1",
    type: "assistant.message.delta",
    payload: { message_id: "msg_1", delta: "旧" },
  });

  assert.equal(next, conversation);
  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "新文本");
  assert.equal(next.cursor.event_id, "evt_live");
  assert.equal(next.cursor.seq, 12);
});

test("ignores stale non-delta live overlay events", () => {
  const conversation = conversationFixture({
    cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
    items: [assistantConversationItem({ revision: 12, text: "done", status: "completed" as const })],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_old",
    epoch: 1,
    seq: 10,
    session_id: "sess_1",
    type: "turn.completed",
  });

  assert.equal(next, conversation);
  assert.equal(next.cursor.event_id, "evt_live");
  assert.equal(next.cursor.seq, 12);
});

test("drops stale conversation snapshots behind live cursor state", () => {
  const current = conversationFixture({
    cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
    items: [
      assistantConversationItem({
        text: "live text",
        revision: 12,
        source_event_ids: ["evt_live"],
        source_event_ranges: [
          { from_event_id: "evt_live", to_event_id: "evt_live", from_seq: 12, to_seq: 12 },
        ],
      }),
    ],
  });
  const staleSnapshot = conversationFixture({
    cursor: { event_id: "evt_old", epoch: 1, seq: 10 },
    items: [
      assistantConversationItem({
        text: "old text",
        revision: 10,
        source_event_ids: ["evt_old"],
        source_event_ranges: [
          { from_event_id: "evt_old", to_event_id: "evt_old", from_seq: 10, to_seq: 10 },
        ],
      }),
    ],
  });
  const freshSnapshot = conversationFixture({
    cursor: { event_id: "evt_new", epoch: 1, seq: 13 },
    items: [
      assistantConversationItem({
        text: "fresh text",
        revision: 13,
        source_event_ids: ["evt_new"],
        source_event_ranges: [
          { from_event_id: "evt_new", to_event_id: "evt_new", from_seq: 13, to_seq: 13 },
        ],
      }),
    ],
  });

  assert.equal(mergeConversationSnapshot(current, staleSnapshot), current);
  const next = mergeConversationSnapshot(current, freshSnapshot);
  assert.notEqual(next, current);
  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "fresh text");
  assert.equal(next.cursor.seq, 13);
});

test("merges tail snapshots without discarding a wider preloaded conversation window", () => {
  const current = conversationFixture({
    cursor: { event_id: "evt_10", epoch: 1, seq: 10 },
    window: {
      first_item_id: "older_user",
      last_item_id: "tail_assistant",
      has_older: false,
      has_newer: false,
    },
    items: [
      assistantConversationItem({
        id: "older_user",
        kind: "user_message",
        text: "old question",
        status: "completed",
        source_event_ids: ["evt_1"],
        source_event_ranges: [
          { from_event_id: "evt_1", to_event_id: "evt_1", from_seq: 1, to_seq: 1 },
        ],
      }),
      assistantConversationItem({
        id: "tail_assistant",
        text: "tail answer",
        status: "completed",
        source_event_ids: ["evt_10"],
        source_event_ranges: [
          { from_event_id: "evt_10", to_event_id: "evt_10", from_seq: 10, to_seq: 10 },
        ],
      }),
    ],
  });
  const tailSnapshot = conversationFixture({
    cursor: { event_id: "evt_11", epoch: 1, seq: 11 },
    window: {
      first_item_id: "tail_assistant",
      last_item_id: "new_tail",
      has_older: true,
      has_newer: false,
    },
    items: [
      assistantConversationItem({
        id: "tail_assistant",
        text: "tail answer",
        status: "completed",
        source_event_ids: ["evt_10"],
        source_event_ranges: [
          { from_event_id: "evt_10", to_event_id: "evt_10", from_seq: 10, to_seq: 10 },
        ],
      }),
      assistantConversationItem({
        id: "new_tail",
        text: "new answer",
        status: "completed",
        source_event_ids: ["evt_11"],
        source_event_ranges: [
          { from_event_id: "evt_11", to_event_id: "evt_11", from_seq: 11, to_seq: 11 },
        ],
      }),
    ],
  });

  const merged = mergeConversationSnapshot(current, tailSnapshot);

  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["older_user", "tail_assistant", "new_tail"],
  );
  assert.equal(merged.window.first_item_id, "older_user");
  assert.equal(merged.window.last_item_id, "new_tail");
  assert.equal(merged.window.has_older, false);
  assert.equal(merged.cursor.seq, 11);
});

test("applies message-id-free assistant delta live overlays only to the latest streaming item", () => {
  const conversation = conversationFixture({
    items: [
      assistantConversationItem({ id: "old", text: "old", source_event_ids: ["evt_old"] }),
      assistantConversationItem({
        id: "latest",
        created_at: "2026-06-19T00:00:01Z",
        text: "new",
        source_event_ids: ["evt_new"],
      }),
    ],
  });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { delta: "!" },
  });

  assert.equal(next.items[0]?.kind, "assistant_message");
  assert.equal(next.items[0]?.text, "old");
  assert.equal(next.items[1]?.kind, "assistant_message");
  assert.equal(next.items[1]?.text, "new!");
});

test("does not invent conversation items from live overlay events", () => {
  const conversation = conversationFixture({ items: [] });

  const next = applyConversationLiveOverlay(conversation, {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { message_id: "msg_backend_owned", delta: "server truth" },
  });

  assert.deepEqual(next.items, []);
  assert.equal(next.cursor.event_id, "evt_2");
});

test("requests conversation refresh when assistant delta overlay has no local item", () => {
  const event = {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { message_id: "msg_backend_owned", delta: "server truth" },
  };

  assert.equal(needsConversationRefreshAfterLiveOverlay(conversationFixture({ items: [] }), event), true);
  assert.equal(
    needsConversationRefreshAfterLiveOverlay(
      conversationFixture({
        items: [assistantConversationItem({ id: "msg_backend_owned" })],
      }),
      event,
    ),
    false,
  );
  assert.equal(
    needsConversationRefreshAfterLiveOverlay(
      conversationFixture({ items: [] }),
      {
        event_id: "evt_other_session",
        epoch: 1,
        seq: 2,
        session_id: "sess_2",
        type: "assistant.message.delta",
        payload: { message_id: "msg_backend_owned", delta: "server truth" },
      },
    ),
    false,
  );
  assert.equal(
    needsConversationRefreshAfterLiveOverlay(
      conversationFixture({ cursor: { event_id: "evt_live", epoch: 1, seq: 12 }, items: [] }),
      {
        event_id: "evt_old",
        epoch: 1,
        seq: 10,
        type: "assistant.message.delta",
        payload: { message_id: "msg_backend_owned", delta: "server truth" },
      },
    ),
    false,
  );
});

test("subscribes to named velad SSE events as stream updates", () => {
  const source = new FakeEventSource();
  let updates = 0;
  const unsubscribe = subscribeVelaEventSource(source as unknown as EventSource, {
    onEvent: () => {
      updates += 1;
    },
  });

  source.emit("assistant.message.delta");
  source.emit("turn.completed");
  source.emit("session.config.updated");
  source.emit("session.status.changed");
  source.emit("session.closed");
  source.emit("input.queued");
  source.emit("input.rejected");
  source.emit("turn.cancel.accepted");
  source.emit("request.response.accepted");
  source.emit("turn.cancelled");
  source.emit("usage.updated");
  source.emit("tool.completed");
  source.emit("task.updated");
  source.emit("projection.invalidated");
  source.emitMessage();

  assert.equal(updates, 15);
  unsubscribe();
  source.emit("assistant.message.delta");
  source.emit("session.status.changed");
  source.emit("input.queued");
  source.emit("usage.updated");
  source.emit("tool.completed");
  assert.equal(updates, 15);
});

test("stream refresh scheduler paints the first event immediately and throttles bursts", () => {
  const clock = new ManualClock();
  const calls: number[] = [];
  const scheduler = createStreamRefreshScheduler({
    minIntervalMs: 120,
    now: () => clock.now,
    refresh: () => {
      calls.push(clock.now);
    },
    setTimeout: (callback, delay) => clock.setTimeout(callback, delay),
    clearTimeout: (timer) => clock.clearTimeout(timer),
  });

  scheduler.notifyStreamEvent();
  clock.advanceTo(50);
  scheduler.notifyStreamEvent();
  clock.advanceTo(100);
  scheduler.notifyStreamEvent();

  assert.deepEqual(calls, [0]);

  clock.advanceTo(120);

  assert.deepEqual(calls, [0, 120]);
  scheduler.dispose();
});

test("creates command-scoped idempotency keys", () => {
  assert.match(createIdempotencyKey(), /^cmd_[a-z0-9_-]{16,}$/);
});

test("encodes image files as base64 input parts", async () => {
  const file = new File(["hello"], "hello.png", { type: "image/png" });

  const part = await imageFileToInputPart(file);

  assert.deepEqual(part, {
    type: "image",
    data: "aGVsbG8=",
    mime_type: "image/png",
  });
});

test("sends explicit mixed content parts for image messages", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          status: "accepted",
          command_id: "cmd_image",
          session_id: "ses_image",
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        {
        status: 202,
        headers: { "Content-Type": "application/json" },
        },
      );
    },
  });

  const ack = await client.sendUserMessage({
    sessionId: "ses_image",
    idempotencyKey: "cmd_image",
    content: [
      { type: "text", text: "look" },
      { type: "image", data: "aGVsbG8=", mime_type: "image/png" },
    ],
  });

  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    events: [
      {
        type: "user.message",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "aGVsbG8=", mime_type: "image/png" },
        ],
      },
    ],
  });
  assert.equal(ack.status, "accepted");
  assert.equal(ack.command_id, "cmd_image");
});

test("cancels a running session with idempotency key", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          status: "accepted",
          command_id: "cmd_cancel",
          session_id: "ses_running",
          cursor: { event_id: "evt_cancel", epoch: 1, seq: 8 },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const ack = await client.cancelSession({
    sessionId: "ses_running",
    idempotencyKey: "cmd_cancel",
  });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions/ses_running/cancel");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal((requests[0]?.init?.headers as Record<string, string>)["Idempotency-Key"], "cmd_cancel");
  assert.deepEqual(ack, {
    status: "accepted",
    command_id: "cmd_cancel",
    session_id: "ses_running",
    cursor: { event_id: "evt_cancel", epoch: 1, seq: 8 },
  });
});

test("sends request response input events through the unified event endpoint", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          status: "accepted",
          command_id: "cmd_request_response",
          session_id: "ses_requests",
          cursor: { event_id: "evt_request_response", epoch: 1, seq: 12 },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const ack = await client.sendSessionInputEvents({
    sessionId: "ses_requests",
    idempotencyKey: "cmd_request_response",
    events: [
      {
        type: "user.tool_confirmation",
        request_id: "req_tool",
        result: "allow",
        scope: "once",
      },
      {
        type: "user.custom_tool_result",
        request_id: "req_custom",
        content: [{ type: "text", text: "result text" }],
      },
      {
        type: "user.request_answer",
        request_id: "req_question",
        answer: "方案 B",
      },
    ],
  });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3857/api/v1/sessions/ses_requests/events");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)["Idempotency-Key"],
    "cmd_request_response",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    events: [
      {
        type: "user.tool_confirmation",
        request_id: "req_tool",
        result: "allow",
        scope: "once",
      },
      {
        type: "user.custom_tool_result",
        request_id: "req_custom",
        content: [{ type: "text", text: "result text" }],
      },
      {
        type: "user.request_answer",
        request_id: "req_question",
        answer: "方案 B",
      },
    ],
  });
  assert.equal(ack.status, "accepted");
  assert.equal(ack.command_id, "cmd_request_response");
});

test("rejects invalid request response input events before sending", async () => {
  let fetchCalled = false;
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}", { status: 202 });
    },
  });

  await assert.rejects(
    () =>
      client.sendSessionInputEvents({
        sessionId: "ses_requests",
        events: [],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_input_event" &&
      /at least one/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.sendSessionInputEvents({
        sessionId: "ses_requests",
        events: [{ type: "user.tool_confirmation", request_id: "req_tool", result: "maybe" } as never],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_input_event" &&
      /result/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.sendSessionInputEvents({
        sessionId: "ses_requests",
        events: [{ type: "user.request_answer", request_id: "req_question" } as never],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_input_event" &&
      /answer/.test(err.message),
  );

  assert.equal(fetchCalled, false);
});

test("rejects invalid InputPart oneOf branches before sending", async () => {
  let fetchCalled = false;
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () => {
      fetchCalled = true;
      return new Response("{}", { status: 202 });
    },
  });

  await assert.rejects(
    () =>
      client.sendUserMessage({
        sessionId: "ses_image",
        content: [{ type: "image", data: "aGVsbG8=" } as never],
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_input_part" &&
      /mime_type/.test(err.message),
  );
  await assert.rejects(
    () =>
      client.sendUserMessage({
        sessionId: "ses_image",
        content: { type: "text", text: "not an array" } as never,
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_input_part" &&
      /array/.test(err.message),
  );
  assert.equal(fetchCalled, false);
});

test("validates CommandAck oneOf branches at the client wire boundary", async () => {
  const validAcks = [
    {
      status: "queued",
      command_id: "cmd_queued",
      session_id: "ses_1",
      queued_message_id: "queued_1",
      cursor: { event_id: "evt_2", epoch: 1, seq: 2 },
    },
    {
      status: "rejected",
      code: "duplicate_command",
      message: "idempotency key was reused with different command content",
    },
  ];
  for (const ack of validAcks) {
    const client = createVeladClient({
      baseUrl: "http://127.0.0.1:3857/api/v1/",
      fetch: async () =>
        new Response(JSON.stringify(ack), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    });

    assert.deepEqual(await client.sendUserMessage({ sessionId: "ses_1", text: "hello" }), ack);
  }

  const invalidClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          status: "queued",
          command_id: "cmd_queued",
          session_id: "ses_1",
          cursor: { event_id: "evt_2", epoch: 1, seq: 2 },
        }),
        {
          status: 202,
          headers: { "Content-Type": "application/json" },
        },
      ),
  });

  await assert.rejects(
    () => invalidClient.sendUserMessage({ sessionId: "ses_1", text: "hello" }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_command_ack" &&
      /queued_message_id/.test(err.message),
  );
});

test("extracts user-visible rejected CommandAck messages without treating accepted or queued as errors", () => {
  assert.equal(
    commandAckRejectionMessage({
      status: "accepted",
      command_id: "cmd_1",
      session_id: "ses_1",
      cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
    }),
    null,
  );
  assert.equal(
    commandAckRejectionMessage({
      status: "queued",
      command_id: "cmd_2",
      session_id: "ses_1",
      queued_message_id: "queued_1",
      cursor: { event_id: "evt_2", epoch: 1, seq: 2 },
    }),
    null,
  );
  assert.equal(
    commandAckRejectionMessage({
      status: "rejected",
      code: "duplicate_command",
      message: "Idempotency key was reused with different command content",
    }),
    "Idempotency key was reused with different command content",
  );
});

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new Event(type));
    }
  }

  emitMessage() {
    this.onmessage?.(new MessageEvent("message"));
  }
}

class ManualClock {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delay: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  }

  clearTimeout(id: number) {
    this.timers.delete(id);
  }

  advanceTo(nextNow: number) {
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= nextNow)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
    }
    this.now = nextNow;
  }
}
