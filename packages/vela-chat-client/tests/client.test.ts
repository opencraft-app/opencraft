import assert from "node:assert/strict";
import test from "node:test";

import {
  VeladClientError,
  applyTranscriptLiveOverlay,
  commandAckRejectionMessage,
  createIdempotencyKey,
  createStreamRefreshScheduler,
  createVeladClient,
  imageFileToInputPart,
  needsTranscriptRefreshAfterLiveOverlay,
  parseSseJsonFrames,
  readVelaStreamEvent,
  isVelaStreamEventFreshForCursor,
  isVelaStreamEventForSession,
  streamReadModelRefreshPlan,
  subscribeVelaEventSource,
} from "../src/index";

test("builds transcript and event URLs for local velad", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client.transcriptUrl("sess_123").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/transcript",
  );
  assert.equal(
    client.sessionEventStreamUrl("sess_123", "evt_9").toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/events/stream?after_id=evt_9",
  );
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
    () => client.transcriptUrl({ id: "sess_123" } as unknown as string),
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

test("builds transcript direction anchor URLs", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client
      .transcriptUrl("sess_123", {
        direction: "before",
        anchorRowId: "row_9",
        limit: 40,
        includeLive: false,
      })
      .toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/transcript?limit=40&direction=before&anchor_row_id=row_9&include_live=false",
  );
  assert.equal(
    client
      .transcriptUrl("sess_123", {
        direction: "tail",
        limit: 80,
      })
      .toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/transcript?limit=80&direction=tail",
  );
});

test("rejects legacy transcript row anchors before fetch", async () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  await assert.rejects(
    () =>
      client.getTranscript("sess_123", {
        beforeRowId: "row_1",
      } as unknown as Parameters<typeof client.getTranscript>[1]),
    /unsupported transcript window option: beforeRowId/,
  );
});

test("rejects invalid transcript direction anchor options before fetch", async () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  await assert.rejects(
    () => client.getTranscript("sess_123", { direction: "before" }),
    /anchorRowId is required/,
  );
  await assert.rejects(
    () => client.getTranscript("sess_123", { direction: "tail", anchorRowId: "row_1" }),
    /direction=tail cannot include anchorRowId/,
  );
});

test("builds activity direction anchor URLs", () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  assert.equal(
    client
      .activityUrl("sess_123", {
        direction: "before",
        anchorItemId: "act_9",
        limit: 40,
      })
      .toString(),
    "http://127.0.0.1:3857/api/v1/sessions/sess_123/views/activity?limit=40&direction=before&anchor_item_id=act_9",
  );
});

test("rejects invalid activity direction anchor options before fetch", async () => {
  const client = createVeladClient({ baseUrl: "http://127.0.0.1:3857/api/v1/" });

  await assert.rejects(
    () => client.getActivity("sess_123", { direction: "before" }),
    /anchorItemId is required/,
  );
  await assert.rejects(
    () => client.getActivity("sess_123", { direction: "tail", anchorItemId: "act_1" }),
    /direction=tail cannot include anchorItemId/,
  );
  await assert.rejects(
    () => client.getActivity("sess_123", { anchorItemId: "act_1" }),
    /anchorItemId requires direction/,
  );
});

test("rejects invalid view window limits before fetch", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () => client.getTranscript("sess_123", { limit: 0 }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_window_options" &&
      /limit/.test(err.message),
  );

  await assert.rejects(
    () => client.getActivity("sess_123", { limit: 501 }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_window_options" &&
      /limit/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("rejects invalid view window query option types before fetch", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    () =>
      client.getTranscript("sess_123", {
        direction: "sideways",
        anchorRowId: "row_1",
      } as unknown as Parameters<typeof client.getTranscript>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_window_options" &&
      /direction/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getTranscript("sess_123", {
        direction: "before",
        anchorRowId: 123,
      } as unknown as Parameters<typeof client.getTranscript>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_window_options" &&
      /anchorRowId/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getTranscript("sess_123", {
        includeLive: "false",
      } as unknown as Parameters<typeof client.getTranscript>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_window_options" &&
      /includeLive/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getActivity("sess_123", {
        direction: "sideways",
        anchorItemId: "act_1",
      } as unknown as Parameters<typeof client.getActivity>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_window_options" &&
      /direction/.test(err.message),
  );

  await assert.rejects(
    () =>
      client.getActivity("sess_123", {
        direction: "before",
        anchorItemId: 123,
      } as unknown as Parameters<typeof client.getActivity>[1]),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_window_options" &&
      /anchorItemId/.test(err.message),
  );

  assert.equal(requests.length, 0);
});

test("validates transcript view envelope at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          rows: [],
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getTranscript("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_view" &&
      /window/.test(err.message),
  );
});

test("validates transcript row shape at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          rows: [
            {
              id: "row_bad",
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
    () => client.getTranscript("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_view" &&
      /updated_at/.test(err.message),
  );
});

test("validates transcript row parts at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          rows: [
            {
              id: "row_bad_parts",
              kind: "user_message",
              created_at: "2026-06-19T00:00:00Z",
              updated_at: "2026-06-19T00:00:00Z",
              revision: 1,
              status: "completed",
              source_event_ids: ["evt_1"],
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
    () => client.getTranscript("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_transcript_view" &&
      /parts\[0\]\.data/.test(err.message),
  );
});

test("validates activity view cursor at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getActivity("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_view" &&
      /cursor/.test(err.message),
  );
});

test("validates activity item shape at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [
            {
              id: "act_bad",
              kind: "tool",
              status: "running",
              created_at: "2026-06-19T00:00:00Z",
            },
          ],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getActivity("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_view" &&
      /title/.test(err.message),
  );
});

test("validates optional activity item summary at the client wire boundary", async () => {
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session_id: "sess_123",
          items: [
            {
              id: "act_bad_summary",
              kind: "tool",
              status: "completed",
              title: "Read file",
              summary: 123,
              created_at: "2026-06-19T00:00:00Z",
            },
          ],
          window: { has_older: false, has_newer: false },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.getActivity("sess_123"),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_activity_view" &&
      /summary/.test(err.message),
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
          session: { id: "ses_created", backend: "pi", status: "idle", title: "New chat" },
          cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const created = await client.createSession({
    idempotencyKey: "ses_created",
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

test("creates a session with selected backend and agent config", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          session: {
            id: "ses_acp",
            backend: "acp",
            status: "idle",
            title: "Hermes test",
            agent_config: {
              model: "minimax-m2.7",
              reasoning_effort: "medium",
              permission_mode: "auto",
            },
          },
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
          session: { id: "ses_created", backend: "pi", status: "idle" },
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
          session: { id: "ses_missing_cursor", backend: "pi", status: "idle" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    () =>
      createClient.createSession({
        idempotencyKey: "ses_missing_cursor",
        workingDirectory: "/tmp/project",
      }),
    (err) =>
      err instanceof VeladClientError &&
      err.code === "invalid_create_session_response" &&
      /cursor/.test(err.message),
  );

  const updateClient = createVeladClient({
    baseUrl: "http://127.0.0.1:3857/api/v1/",
    fetch: async () =>
      new Response(
        JSON.stringify({
          session: { id: "ses_bad_effect", backend: "pi", status: "idle" },
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
    () => client.getBackend("unknown_backend"),
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
    () => client.probeBackend("unknown_backend"),
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
            session: {
              id: "ses_config",
              backend: "pi",
              status: "idle",
              agent_config: {
                model: "minimax-m2.7",
                reasoning_effort: "high",
                permission_mode: "full_access",
              },
            },
            effective_after: "current_session",
            cursor: { event_id: "evt_config", epoch: 1, seq: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          session: {
            id: "ses_config",
            backend: "pi",
            status: "idle",
            agent_config: { model: "minimax-m2.7" },
            runtime_info: { provider: "pi", model: "minimax-m2.7" },
          },
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
          session: { id: "ses_config", backend: "pi", status: "idle" },
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
    client.transcriptUrl("sess_123").toString(),
    "http://localhost/chat/api/velad/api/v1/sessions/sess_123/views/transcript",
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
        affected_views: ["transcript", "activity"],
        payload: { message_id: "msg_1", delta: "hi" },
      }),
    }),
  );

  assert.equal(event?.event_id, "evt_2");
  assert.equal(event?.type, "assistant.message.delta");
  assert.deepEqual(event?.affected_views, ["transcript", "activity"]);
  assert.equal(event?.payload?.delta, "hi");
});

test("plans assistant delta stream events as local overlay only", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_delta",
      type: "assistant.message.delta",
      payload: { message_id: "msg_1", delta: "好" },
    }),
    {
      transcript: false,
      activity: false,
      session: false,
      backends: false,
    },
  );
});

test("plans non-message stream events as scoped read-model refreshes", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_tool", type: "tool.started" }),
    {
      transcript: false,
      activity: true,
      session: false,
      backends: false,
    },
  );
  assert.deepEqual(
    streamReadModelRefreshPlan({ event_id: "evt_turn", type: "turn.completed" }),
    {
      transcript: true,
      activity: false,
      session: true,
      backends: false,
    },
  );
});

test("uses affected_views as forward-compatible refresh hints for canonical stream events", () => {
  assert.deepEqual(
    streamReadModelRefreshPlan({
      event_id: "evt_future",
      type: "future.provider.event",
      affected_views: ["requests", "diffs"],
    }),
    {
      transcript: false,
      activity: true,
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
      transcript: false,
      activity: false,
      session: false,
      backends: true,
    },
  );
});

test("matches stream events to the active session while accepting legacy events", () => {
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
      event_id: "evt_legacy",
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

test("matches stream events to cursor order while accepting legacy cursorless events", () => {
  const cursor = { event_id: "evt_5", epoch: 1, seq: 5 };

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
    isVelaStreamEventFreshForCursor(cursor, {
      event_id: "evt_legacy",
      type: "turn.completed",
    }),
    true,
  );
});

test("applies assistant delta live overlays to existing transcript rows immediately", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
    rows: [
      {
        id: "msg_1",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:00Z",
        updated_at: "2026-06-19T00:00:00Z",
        revision: 1,
        text: "你",
        status: "streaming",
        source_event_ids: ["evt_1"],
      },
    ],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_2",
    epoch: 1,
    seq: 2,
    session_id: "sess_1",
    type: "assistant.message.delta",
    created_at: "2026-06-19T00:00:01Z",
    payload: { message_id: "msg_1", delta: "好" },
  });

  assert.equal(next.rows[0]?.text, "你好");
  assert.equal(next.rows[0]?.revision, 2);
  assert.equal(next.cursor.event_id, "evt_2");
});

test("does not append duplicate assistant delta live overlays", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_2", epoch: 1, seq: 2 },
    rows: [
      {
        id: "msg_1",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:00Z",
        revision: 2,
        text: "你好",
        status: "streaming",
        source_event_ids: ["evt_1", "evt_2"],
      },
    ],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_2",
    epoch: 1,
    seq: 2,
    session_id: "sess_1",
    type: "assistant.message.delta",
    payload: { message_id: "msg_1", delta: "好" },
  });

  assert.equal(next.rows[0]?.text, "你好");
  assert.equal(next.rows[0]?.revision, 2);
});

test("ignores stale assistant delta live overlay events", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
    rows: [
      {
        id: "msg_1",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:00Z",
        revision: 12,
        text: "新文本",
        status: "streaming",
        source_event_ids: ["evt_live"],
      },
    ],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_old",
    epoch: 1,
    seq: 10,
    session_id: "sess_1",
    type: "assistant.message.delta",
    payload: { message_id: "msg_1", delta: "旧" },
  });

  assert.equal(next, transcript);
  assert.equal(next.rows[0]?.text, "新文本");
  assert.equal(next.cursor.event_id, "evt_live");
  assert.equal(next.cursor.seq, 12);
});

test("ignores stale non-delta live overlay events", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
    rows: [
      {
        id: "msg_1",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:00Z",
        revision: 12,
        text: "done",
        status: "completed",
      },
    ],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_old",
    epoch: 1,
    seq: 10,
    session_id: "sess_1",
    type: "turn.completed",
  });

  assert.equal(next, transcript);
  assert.equal(next.cursor.event_id, "evt_live");
  assert.equal(next.cursor.seq, 12);
});

test("applies message-id-free assistant delta live overlays only to the latest streaming row", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
    rows: [
      {
        id: "old",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:00Z",
        revision: 1,
        text: "old",
        status: "streaming",
        source_event_ids: ["evt_old"],
      },
      {
        id: "latest",
        kind: "assistant_message" as const,
        created_at: "2026-06-19T00:00:01Z",
        revision: 1,
        text: "new",
        status: "streaming",
        source_event_ids: ["evt_new"],
      },
    ],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { delta: "!" },
  });

  assert.equal(next.rows[0]?.text, "old");
  assert.equal(next.rows[1]?.text, "new!");
});

test("does not invent transcript rows from live overlay events", () => {
  const transcript = {
    session_id: "sess_1",
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
    rows: [],
  };

  const next = applyTranscriptLiveOverlay(transcript, {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { message_id: "msg_backend_owned", delta: "server truth" },
  });

  assert.deepEqual(next.rows, []);
  assert.equal(next.cursor.event_id, "evt_2");
});

test("requests transcript refresh when assistant delta overlay has no local row", () => {
  const event = {
    event_id: "evt_2",
    type: "assistant.message.delta",
    payload: { message_id: "msg_backend_owned", delta: "server truth" },
  };

  assert.equal(
    needsTranscriptRefreshAfterLiveOverlay(
      {
        session_id: "sess_1",
        cursor: { event_id: "evt_1" },
        rows: [],
      },
      event,
    ),
    true,
  );
  assert.equal(
    needsTranscriptRefreshAfterLiveOverlay(
      {
        session_id: "sess_1",
        cursor: { event_id: "evt_1" },
        rows: [
          {
            id: "msg_backend_owned",
            kind: "assistant_message",
            created_at: "2026-06-19T00:00:00Z",
            status: "streaming",
          },
        ],
      },
      event,
    ),
    false,
  );
  assert.equal(
    needsTranscriptRefreshAfterLiveOverlay(
      {
        session_id: "sess_1",
        cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
        rows: [],
      },
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
    needsTranscriptRefreshAfterLiveOverlay(
      {
        session_id: "sess_1",
        cursor: { event_id: "evt_live", epoch: 1, seq: 12 },
        rows: [],
      },
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
  source.emitMessage();

  assert.equal(updates, 3);
  unsubscribe();
  source.emit("assistant.message.delta");
  assert.equal(updates, 3);
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
      code: "turn_running",
      message: "turn is running",
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
      code: "turn_running",
      message: "A turn is already running",
    }),
    "A turn is already running",
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
