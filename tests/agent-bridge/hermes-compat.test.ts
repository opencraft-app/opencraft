import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  createCordisThreadSessionRuntime,
  type CordisThreadSessionRuntime,
} from "@opencraft/appserver-session";
import {
  MemoryTransport,
  type InMemoryAppServer,
  type InMemoryAppServerPeer,
} from "@opencraft/appserver-transport-memory";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  parseJsonRpcMessage,
  type AppServerNotification,
} from "@opencraft/appserver-protocol";
import { createAppServerConversationCommandPort } from "@opencraft/composer-appserver";
import { SubmissionOutcomeUnknownError } from "@opencraft/chat-runtime";
import { asHostId, asTurnId, createConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";

/**
 * P9 regression: the current client must keep reading and sending against the
 * pre-existing Hermes AppServer bridge without requiring agent-bridge additions.
 *
 * The server-side fixture is recorded from the unchanged Hermes bridge in
 * `apps/bridges/hermes/tests/appserver-contract.test.ts`. This test never
 * imports or starts the bridge; it treats the recording as the legacy peer and
 * drives the real client read, notification projection and send-receipt paths.
 */

interface ContractCase {
  id: string;
  method: string;
  request: unknown;
  response: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  notifications?: Array<{ method: string; params: unknown }>;
}
interface ContractFile { schemaVersion: 1; cases: ContractCase[] }

const HOST_ID = asHostId("hermes-compat");
const FIXTURE = new URL("../../apps/bridges/hermes/tests/fixtures/hermes-appserver-contract.json", import.meta.url);

const ALIASES: Record<string, string | number> = {
  "<turn-1>": "hermes-turn-contract-1",
  "<turn-2>": "hermes-turn-contract-2",
  "<turn-3>": "hermes-turn-contract-3",
  "<user-1>": "hermes-user-contract-1",
  "<user-2>": "hermes-user-contract-2",
  "<user-3>": "hermes-user-contract-3",
  "<agent-1>": "hermes-agent-contract-1",
  "<agent-2>": "hermes-agent-contract-2",
  "<agent-3>": "hermes-agent-contract-3",
  "<queue-1>": "hermes-queue-contract-1",
  "<queue-2>": "hermes-queue-contract-2",
  "<time-s>": 1_700_000_200,
  "<time-ms>": 1_700_000_200_000,
  "<duration-ms>": 1_000,
};

function materialize<T>(value: T): T {
  if (typeof value === "string") {
    const alias = ALIASES[value];
    return (alias ?? value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => materialize(entry)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, materialize(entry)])) as T;
  }
  return value;
}

function loadContract(): Map<string, ContractCase> {
  const file = JSON.parse(readFileSync(fileURLToPath(FIXTURE), "utf8")) as ContractFile;
  assert.equal(file.schemaVersion, 1);
  return new Map(file.cases.map((entry) => [entry.id, { ...entry,
    request: materialize(entry.request),
    response: materialize(entry.response),
    ...(entry.notifications === undefined ? {} : { notifications: materialize(entry.notifications) }),
  }]));
}

function intent(target: SubmitIntent["target"]): SubmitIntent {
  return {
    commandId: "p9-command",
    clientMessageId: "p9-message",
    target,
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Build it" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 1,
  };
}

interface OldBridgeHarness {
  readonly client: JsonRpcAppServerClient;
  readonly runtime: CordisThreadSessionRuntime;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }>;
  readonly notifications: string[];
  close(): Promise<void>;
}

async function createOldBridgeHarness(cases: Map<string, ContractCase>): Promise<OldBridgeHarness> {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notifications: string[] = [];
  let peer: InMemoryAppServerPeer | null = null;
  const respond = (requestId: string | number, caseId: string) => {
    const entry = cases.get(caseId);
    assert.ok(entry, `missing contract case ${caseId}`);
    if (entry.response.error !== undefined) {
      peer!.send(encodeJsonRpcMessage({ id: requestId, error: entry.response.error }));
      return;
    }
    peer!.send(encodeJsonRpcMessage({ id: requestId, result: entry.response.result }));
    for (const notification of entry.notifications ?? []) {
      peer!.send(encodeJsonRpcMessage({ method: notification.method, params: notification.params }));
    }
  };
  const fail = (requestId: string | number, error: { code: number; message: string }) => {
    peer!.send(encodeJsonRpcMessage({ id: requestId, error }));
  };
  const server: InMemoryAppServer = {
    connected(connectedPeer) { peer = connectedPeer; },
    receive(frame, connectedPeer) {
      peer = connectedPeer;
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      const params = (message.params ?? {}) as Record<string, unknown>;
      requests.push({ method: message.method, params });
      switch (message.method) {
        case "initialize":
          respond(message.id, "initialize");
          return;
        case "thread/list":
          respond(message.id, "thread-list");
          return;
        case "thread/read":
          respond(message.id, params.includeTurns === true ? "thread-read-full" : "thread-read-metadata");
          return;
        case "thread/turns/list":
          respond(message.id, "thread-turns-list");
          return;
        case "thread/items/list":
          respond(message.id, "thread-items-list");
          return;
        case "thread/resume":
          respond(message.id, "thread-resume");
          return;
        case "thread/start":
          respond(message.id, "thread-start");
          return;
        case "turn/start": {
          const threadId = String(params.threadId ?? "");
          const caseId = threadId === "session-new" ? "turn-start-new"
            : threadId === "session-steer" ? "turn-start-steer"
            : threadId === "session-error" ? "turn-start-gateway-error" : "turn-start-existing";
          respond(message.id, caseId);
          return;
        }
        case "turn/steer":
          respond(message.id, "turn-steer");
          return;
        case "turn/interrupt":
          respond(message.id, "turn-interrupt");
          return;
        case "thread/queue/add":
          respond(message.id, "thread-queue-add");
          return;
        case "thread/queue/list":
          respond(message.id, "thread-queue-list");
          return;
        default:
          // This is the key compatibility assertion: the old bridge never
          // advertised the agent-bridge additions, so the current client must
          // not call them during ordinary read/send work.
          fail(message.id, { code: -32601, message: `Method not supported by Hermes bridge: ${message.method}` });
      }
    },
  };
  const client = new JsonRpcAppServerClient({ hostId: HOST_ID, transport: new MemoryTransport(server), requestTimeoutMs: 2_000 });
  try {
    await client.connect({
      clientInfo: { name: "p9-hermes-compat", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.subscribeNotification((notification: AppServerNotification) => notifications.push(notification.method));
    const runtime = await createCordisThreadSessionRuntime({ client, hostKind: "local", pageSize: 10, requestTimeoutMs: 2_000 });
    return {
      client,
      runtime,
      requests,
      notifications,
      async close() { await runtime.dispose(); await client.close(); },
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("current client reads and sends against the recorded legacy Hermes contract", async () => {
  const cases = loadContract();
  const harness = await createOldBridgeHarness(cases);
  try {
    assert.equal(harness.client.initializeResult?.capabilities, undefined, "the old bridge advertises no extensions");

    // Read path 1: the sidebar catalog shape is unchanged and carries no
    // OpenCraft catalog metadata that a native AppServer never sent.
    const list = await harness.client.request("thread/list", { limit: 20 });
    assert.deepEqual(Object.keys(list).sort(), ["backwardsCursor", "data", "nextCursor"]);
    assert.equal((list as { catalog?: unknown }).catalog, undefined);
    assert.deepEqual(list.data.map((thread) => thread.id), ["session-alpha", "session-new", "session-steer", "session-queue", "session-error"]);

    // Read path 2: presentation history and execution resume through the real
    // appserver-session projectors.
    const view = await harness.runtime.resume.read("session-alpha");
    assert.equal(view.thread?.id, "session-alpha");
    assert.equal(view.historySource, "paginated");
    assert.equal(view.turns.length, 1);
    assert.deepEqual(view.turns[0]?.items?.map((item) => item.type), ["userMessage", "agentMessage", "dynamicToolCall"]);
    assert.equal((view.turns[0]?.items?.[1] as { text?: string } | undefined)?.text, "world");
    assert.equal((view.turns[0]?.items?.[2] as { tool?: string } | undefined)?.tool, "terminal");

    const full = await harness.client.request("thread/read", { threadId: "session-alpha", includeTurns: true });
    assert.deepEqual(full.thread.turns[0]?.items?.map((item) => item.type), ["userMessage", "agentMessage", "dynamicToolCall"]);
    const items = await harness.client.request("thread/items/list", {
      threadId: "session-alpha", turnId: "hermes-turn-session-alpha-1", cursor: null, limit: 10, sortDirection: "asc",
    });
    assert.deepEqual(items.data.map((item) => item.type), ["userMessage", "agentMessage", "dynamicToolCall"]);

    const resumed = await harness.runtime.resume.resume({ threadId: "session-alpha" });
    assert.equal(resumed.resumeState, "resumed");
    assert.equal(resumed.execution.model, "hermes");
    assert.equal(resumed.execution.modelProvider, "hermes");
    assert.equal(resumed.execution.cwd, "/workspace/project");
    assert.equal(resumed.execution.approvalPolicy, "on-request");
    assert.equal(resumed.execution.approvalsReviewer, "user");
    assert.deepEqual(resumed.execution.runtimeWorkspaceRoots, ["/workspace/project"]);

    // Send path: a new submission returns the legacy receipt, and its existing
    // notifications still project into the already-read Thread view.
    const port = createAppServerConversationCommandPort({
      hostId: HOST_ID,
      client: harness.client,
      interactions: { respond: async () => undefined },
      now: () => 1_700_000_300_000,
    });
    const notificationStart = harness.notifications.length;
    const existing = await port.submit(intent({
      type: "existing-thread",
      key: createConversationKey(HOST_ID, "session-alpha"),
    }));
    assert.deepEqual(existing, {
      commandId: "p9-command",
      clientMessageId: "p9-message",
      hostId: HOST_ID,
      threadId: "session-alpha",
      turnId: "hermes-turn-contract-1",
      acceptedAt: 1_700_000_300_000,
      replayed: false,
    });
    await waitFor(() => harness.notifications.length > notificationStart
      && harness.notifications.includes("turn/completed"), "projected completion");
    assert.deepEqual(harness.notifications.slice(notificationStart), [
      "turn/started",
      "item/started",
      "item/agentMessage/delta",
      "item/started",
      "item/completed",
      "item/completed",
      "turn/completed",
    ]);
    const completed = harness.runtime.views.get("session-alpha")?.turns.find((turn) => turn.id === "hermes-turn-contract-1");
    assert.ok(completed);
    assert.equal(completed.status, "completed");
    assert.equal((completed.items?.find((item) => item.type === "agentMessage") as { text?: string } | undefined)?.text, "pong");
    // The legacy bridge's final full snapshot lists only the user and agent
    // items; the streamed tool item is intentionally not replayed here. This
    // is the pre-existing behavior the regression locks, not a new projection.
    assert.deepEqual(completed.items?.map((item) => item.type), ["userMessage", "agentMessage"]);

    // Send path: new-thread creation still uses the legacy thread/start +
    // turn/start receipt pair.
    const created = await port.submit(intent({
      type: "new-thread",
      draftId: "p9-draft",
      execution: { hostId: HOST_ID, workspace: { cwd: "/workspace/project", runtimeWorkspaceRoots: ["/workspace/project"] } },
    }));
    assert.deepEqual(created, {
      commandId: "p9-command",
      clientMessageId: "p9-message",
      hostId: HOST_ID,
      threadId: "session-new",
      turnId: "hermes-turn-contract-2",
      acceptedAt: 1_700_000_300_000,
      replayed: false,
    });

    // Steer and interrupt retain their old response shapes. The old bridge has
    // no disposition/evidence field, so the receipt must not invent `queue`.
    const steer = await port.submit(intent({
      type: "steer-active-turn",
      key: createConversationKey(HOST_ID, "session-alpha"),
      turnId: asTurnId("hermes-turn-contract-1"),
    }));
    assert.deepEqual(steer, {
      commandId: "p9-command",
      clientMessageId: "p9-message",
      hostId: HOST_ID,
      threadId: "session-alpha",
      turnId: "hermes-turn-contract-3",
      acceptedAt: 1_700_000_300_000,
      replayed: false,
    });
    assert.equal((steer as { disposition?: unknown }).disposition, undefined);
    await port.interrupt(
      createConversationKey(HOST_ID, "session-alpha"),
      asTurnId("hermes-turn-contract-1"),
    );
    assert.deepEqual(harness.requests.filter((request) => request.method === "turn/interrupt").at(-1)?.params, {
      threadId: "session-alpha",
      turnId: "hermes-turn-contract-1",
    });

    // The old bridge forwards a Hermes gateway failure with its `hermesCode`
    // envelope. The current command port must keep classifying it as an
    // unknown outcome rather than a confirmed rejection or success.
    await assert.rejects(
      port.submit(intent({
        type: "existing-thread",
        key: createConversationKey(HOST_ID, "session-error"),
      })),
      SubmissionOutcomeUnknownError,
    );

    // Queue receipts also keep the exact legacy acknowledgement.
    const queued = await port.submit(intent({
      type: "enqueue-follow-up",
      key: createConversationKey(HOST_ID, "session-alpha"),
    }));
    assert.deepEqual(queued, {
      commandId: "p9-command",
      clientMessageId: "p9-message",
      hostId: HOST_ID,
      threadId: "session-alpha",
      turnId: null,
      queuedSubmissionId: "hermes-queue-contract-1",
      acceptedAt: 1_700_000_300_000,
      replayed: false,
    });

    // No agent-bridge method or notification may be required by this path.
    assert.equal(
      harness.requests.some((request) => request.method.startsWith("opencraft/")),
      false,
      `old bridge received an unexpected extension request: ${harness.requests.map((request) => request.method).join(", ")}`,
    );
    assert.equal(
      harness.notifications.some((method) => method.startsWith("opencraft/steerEvidence")),
      false,
    );
  } finally {
    await harness.close();
  }
});
