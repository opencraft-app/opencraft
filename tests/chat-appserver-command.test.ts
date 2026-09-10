import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import {
  AppServerInteractionBroker,
  AppServerConversationCommandError,
  compileSubmitIntent,
  createAppServerConversationCommandPort,
  restoreQueuedInput,
  SubmitCompileError,
  encodeServerRequestId,
} from "@opencraft/composer-appserver";
import {
  MemoryTransport,
  type InMemoryAppServer,
} from "@opencraft/appserver-transport-memory";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  parseJsonRpcMessage,
  type JsonRpcRequest,
} from "@opencraft/appserver-protocol";
import { asHostId, asTurnId, createConversationKey } from "@opencraft/chat-core";
import type { PendingInteraction } from "@opencraft/chat-runtime";
import type { ComposerDocument, SubmitIntent } from "@opencraft/composer-core";

const hostId = asHostId("ssh:9988");
const existingKey = createConversationKey(hostId, "thread-existing");

const document: ComposerDocument = {
  version: 1,
  blocks: [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Inspect " },
        {
          type: "mention",
          id: "source-file",
          label: "runtime.ts",
          mentionKind: "file",
          uri: "file:///workspace/runtime.ts",
        },
        { type: "text", text: " with " },
        {
          type: "resource",
          id: "skill-review",
          title: "Review current changes",
          uri: "skill://review",
          resourceKind: "skill",
          metadata: {
            canonicalName: "review",
            path: "/skills/review/SKILL.md",
          },
        },
        { type: "hard-break" },
        { type: "command", name: "status", argument: "--short" },
      ],
    },
    { type: "code-block", language: "ts", text: "const answer = 42;" },
  ],
};

function intent(
  target: SubmitIntent["target"],
  patch: Partial<SubmitIntent> = {},
): SubmitIntent {
  return {
    commandId: "command-1",
    clientMessageId: "message-1",
    target,
    document,
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 100,
    ...patch,
  };
}

test("rich Composer documents compile into ordered native Codex UserInput entries", () => {
  const compiled = compileSubmitIntent(
    intent(
      { type: "existing-thread", key: existingKey },
      {
        attachments: [
          {
            id: "image",
            name: "shot.png",
            mimeType: "image/png",
            size: 1,
            uri: "file:///tmp/shot.png",
            lifecycle: "ready",
            error: null,
          },
          {
            id: "inline-image",
            name: "paste.png",
            mimeType: "image/png",
            size: 1,
            uri: "data:image/png;base64,AQID",
            lifecycle: "ready",
            error: null,
          },
          {
            id: "audio",
            name: "note.wav",
            mimeType: "audio/wav",
            size: 2,
            uri: "https://assets/note.wav",
            lifecycle: "ready",
            error: null,
          },
          {
            id: "log",
            name: "run.log",
            mimeType: "text/plain",
            size: 3,
            uri: "/tmp/run.log",
            lifecycle: "ready",
            error: null,
          },
        ],
        context: [
          {
            id: "selection:1",
            kind: "selection",
            title: "runtime selection",
            uri: "file:///workspace/runtime.ts#L1",
            visible: true,
            metadata: { text: "const x = 1" },
          },
          {
            id: "mcp:1",
            kind: "mcp",
            title: "remote data",
            uri: "mcp://data",
            visible: true,
            metadata: { content: "external" },
          },
          {
            id: "hidden",
            kind: "resource",
            title: "hidden",
            uri: null,
            visible: false,
          },
        ],
        selections: {
          model: "gpt-5.6",
          effort: "high",
          permissionProfile: "workspace",
          cwd: "/workspace",
          serviceTier: "priority",
          personality: "pragmatic",
        },
        options: {
          autoContext: true,
          outputSchema: { type: "object", required: ["answer"] },
        },
      },
    ),
  );

  assert.deepEqual(compiled.input, [
    { type: "text", text: "Inspect ", text_elements: [] },
    { type: "mention", name: "runtime.ts", path: "/workspace/runtime.ts" },
    { type: "text", text: " with ", text_elements: [] },
    { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    {
      type: "text",
      text: "\n/status --short\n\n```ts\nconst answer = 42;\n```",
      text_elements: [],
    },
    { type: "localImage", path: "/tmp/shot.png" },
    { type: "image", url: "data:image/png;base64,AQID" },
    { type: "audio", url: "https://assets/note.wav" },
    { type: "mention", name: "run.log", path: "/tmp/run.log" },
  ]);
  assert.deepEqual(compiled.additionalContext, {
    "selection:1": { kind: "application", value: "const x = 1" },
    "mcp:1": { kind: "untrusted", value: "external" },
  });
  assert.deepEqual(compiled.turnOptions, {
    model: "gpt-5.6",
    effort: "high",
    permissions: "workspace",
    cwd: "/workspace",
    serviceTier: "priority",
    personality: "pragmatic",
    outputSchema: { type: "object", required: ["answer"] },
  });
});

test("queued native input restores into the Composer without flattening typed resources", () => {
  const input = [
    { type: "text", text: "Inspect ", text_elements: [] },
    { type: "mention", name: "runtime.ts", path: "/repo/runtime.ts" },
    { type: "text", text: " with ", text_elements: [] },
    { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
    { type: "localImage", path: "/tmp/shot.png" },
    { type: "image", url: "https://assets.example/shot.png" },
    { type: "localAudio", path: "/tmp/note.wav" },
    { type: "audio", url: "https://assets.example/note.wav" },
  ] as const;
  const restored = restoreQueuedInput(input);
  const compiled = compileSubmitIntent(
    intent(
      { type: "existing-thread", key: existingKey },
      {
        document: restored.document,
        attachments: restored.attachments,
        context: restored.context,
      },
    ),
  );

  assert.deepEqual(compiled.input, input);
});

test("compiler rejects unresolved assets and non-JSON output schemas", () => {
  assert.throws(
    () =>
      compileSubmitIntent(
        intent(
          { type: "existing-thread", key: existingKey },
          {
            attachments: [
              {
                id: "pending",
                name: "a.png",
                mimeType: "image/png",
                size: 1,
                uri: null,
                lifecycle: "uploading",
                error: null,
              },
            ],
          },
        ),
      ),
    (error: unknown) =>
      error instanceof SubmitCompileError && error.code === "ASSET_NOT_READY",
  );

  assert.throws(
    () =>
      compileSubmitIntent(
        intent(
          { type: "existing-thread", key: existingKey },
          { options: { autoContext: true, outputSchema: { bad: () => 1 } } },
        ),
      ),
    (error: unknown) =>
      error instanceof SubmitCompileError && error.code === "INVALID_JSON",
  );
});

test("an explicit AppServer-default permission selection compiles as a nullable override", () => {
  const compiled = compileSubmitIntent(
    intent(
      { type: "existing-thread", key: existingKey },
      { selections: { permissionProfile: null } },
    ),
  );
  assert.deepEqual(compiled.turnOptions, { permissions: null });
});

interface Harness {
  readonly client: JsonRpcAppServerClient;
  readonly requests: JsonRpcRequest[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const requests: JsonRpcRequest[] = [];
  let turn = 0;
  const server: InMemoryAppServer = {
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      requests.push(message);
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            codexHome: "/tmp",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "test",
          };
          break;
        case "thread/start":
          result = { thread: { id: "thread-new" } };
          break;
        case "thread/fork":
          result = { thread: { id: "thread-forked" } };
          break;
        case "turn/start":
          result = { turn: { id: `turn-${++turn}` } };
          break;
        case "turn/steer":
          result = { turnId: "turn-active" };
          break;
        case "thread/queue/add":
          result = {
            queuedSubmission: {
              id: "queue-1",
              input: [],
              clientUserMessageId: "message-1",
              createdAt: 1,
              pausedReason: null,
            },
          };
          break;
        case "thread/queue/update":
          result = {
            queuedSubmission: {
              id: "queue-1",
              input: (message.params as { input?: unknown[] }).input ?? [],
              clientUserMessageId: "message-1",
              createdAt: 1,
              pausedReason: null,
            },
          };
          break;
        case "thread/queue/delete":
          result = { deleted: true };
          break;
        case "thread/queue/reorder":
          result = {};
          break;
        case "thread/queue/start":
          result = { turn: { id: "turn-from-queue" } };
          break;
        case "thread/queue/steer":
          result = { turnId: "turn-active" };
          break;
        case "turn/interrupt":
          result = {};
          break;
        default:
          result = {};
      }
      peer.send(encodeJsonRpcMessage({ id: message.id, result }));
    },
  };
  const client = new JsonRpcAppServerClient({
    hostId,
    transport: new MemoryTransport(server),
  });
  await client.connect({
    clientInfo: { name: "composer-tests", version: "1" },
    capabilities: { experimentalApi: true },
  });
  requests.length = 0;
  return { client, requests, close: () => client.close() };
}

function commandPort(
  h: Harness,
  diagnostics: string[] = [],
  dynamicTools?: Parameters<
    typeof createAppServerConversationCommandPort
  >[0]["dynamicTools"],
) {
  let retryId = 0;
  return createAppServerConversationCommandPort({
    hostId,
    client: h.client,
    interactions: { respond: async () => undefined },
    compiler: { historyMode: "paginated" },
    dynamicTools,
    now: () => 1_000 + retryId,
    createCommandId: () => `retry-command-${++retryId}`,
    createClientMessageId: () => `retry-message-${retryId}`,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
  });
}

test("new DSH threads receive the product dynamic-tool catalog at thread/start", async () => {
  const h = await harness();
  const dynamicTools = [
    {
      type: "namespace" as const,
      name: "vela_browser",
      description: "OpenCraft browser",
      tools: [
        {
          type: "function" as const,
          name: "browser_use",
          description: "Operate browser",
          inputSchema: { type: "object" },
        },
      ],
    },
  ];
  const port = commandPort(h, [], dynamicTools);
  await port.submit(
    intent({
      type: "new-thread",
      draftId: "draft-browser",
      execution: {
        hostId,
        workspace: { cwd: "/repo", runtimeWorkspaceRoots: ["/repo"] },
      },
    }),
  );
  assert.equal(h.requests[0]?.method, "thread/start");
  assert.deepEqual(h.requests[0]?.params?.dynamicTools, dynamicTools);
  await h.close();
});

test("continuation starts an empty turn without replaying submitted input or context", async () => {
  const h = await harness();
  const port = commandPort(h);
  const original = intent(
    { type: "existing-thread", key: existingKey },
    {
      selections: { model: "gpt-5.6", effort: "high" },
      context: [
        {
          id: "ctx",
          kind: "selection",
          title: "selected",
          uri: null,
          visible: true,
          metadata: { value: "context body" },
        },
      ],
    },
  );
  const receipt = await port.submit(original);
  assert.deepEqual(receipt, {
    commandId: "command-1",
    clientMessageId: "message-1",
    hostId,
    threadId: "thread-existing",
    turnId: "turn-1",
    acceptedAt: 1_000,
    replayed: false,
  });
  assert.equal(h.requests[0]?.method, "turn/start");
  assert.deepEqual(h.requests[0]?.params, {
    threadId: "thread-existing",
    clientUserMessageId: "message-1",
    input: compileSubmitIntent(original).input,
    additionalContext: { ctx: { kind: "application", value: "context body" } },
    model: "gpt-5.6",
    effort: "high",
  });

  const retried = await port.continueTurn(existingKey, asTurnId("turn-1"));
  assert.equal(retried.replayed, false);
  assert.equal(retried.commandId, "retry-command-1");
  assert.equal(retried.clientMessageId, "retry-message-1");
  assert.equal(retried.turnId, "turn-2");
  assert.equal(h.requests[1]?.method, "turn/start");
  assert.deepEqual(h.requests[1]?.params, {
    threadId: "thread-existing",
    input: [],
    clientUserMessageId: "retry-message-1",
  });
  await h.close();
});

test("continuation does not require an in-memory submission journal", async () => {
  const h = await harness();
  const result = await commandPort(h).continueTurn(existingKey, asTurnId("historical-turn"));
  assert.equal(result.replayed, false);
  assert.deepEqual(h.requests[0]?.params, {
    threadId: "thread-existing", input: [], clientUserMessageId: "retry-message-1",
  });
  await h.close();
});

test("new, fork, steer, queue and interrupt targets use their native Codex methods", async () => {
  const h = await harness();
  const diagnostics: string[] = [];
  const port = commandPort(h, diagnostics);

  const created = await port.submit(
    intent(
      {
        type: "new-thread",
        draftId: "draft-new-thread",
        execution: {
          hostId,
          workspace: {
            cwd: "/repo",
            runtimeWorkspaceRoots: ["/repo", "/shared"],
            projectId: "project-1",
          },
        },
      },
      {
        selections: { agentId: "builtin.dsh", model: "gpt-5.6" },
        options: {
          autoContext: true,
          developerInstructions: "Use repository rules",
        },
      },
    ),
  );
  assert.equal(created.threadId, "thread-new");
  assert.equal(created.turnId, "turn-1");
  assert.equal(h.requests[0]?.method, "thread/start");
  assert.deepEqual(h.requests[0]?.params, {
    agentId: "builtin.dsh",
    model: "gpt-5.6",
    developerInstructions: "Use repository rules",
    historyMode: "paginated",
    cwd: "/repo",
    runtimeWorkspaceRoots: ["/repo", "/shared"],
    projectId: "project-1",
  });
  assert.equal(h.requests[1]?.method, "turn/start");
  assert.equal(
    (h.requests[1]?.params as { threadId?: string }).threadId,
    "thread-new",
  );

  const forked = await port.submit(
    intent({
      type: "fork-thread",
      key: existingKey,
      fromTurnId: asTurnId("turn-source"),
    }),
  );
  assert.equal(forked.threadId, "thread-forked");
  assert.deepEqual(h.requests[2]?.params, {
    threadId: "thread-existing",
    lastTurnId: "turn-source",
  });
  assert.equal(h.requests[3]?.method, "turn/start");

  const steered = await port.submit(
    intent(
      {
        type: "steer-active-turn",
        key: existingKey,
        turnId: asTurnId("turn-active"),
      },
      { selections: { effort: "high" } },
    ),
  );
  assert.equal(steered.turnId, "turn-active");
  assert.deepEqual(h.requests[4]?.params, {
    threadId: "thread-existing",
    clientUserMessageId: "message-1",
    input: compileSubmitIntent(
      intent({ type: "existing-thread", key: existingKey }),
    ).input,
    expectedTurnId: "turn-active",
  });

  const queued = await port.submit(
    intent(
      { type: "enqueue-follow-up", key: existingKey },
      {
        context: [
          {
            id: "ctx",
            kind: "mcp",
            title: "external",
            uri: null,
            visible: true,
          },
        ],
      },
    ),
  );
  assert.equal(queued.turnId, null);
  assert.equal(h.requests[5]?.method, "thread/queue/add");

  await port.interrupt(existingKey, asTurnId("turn-active"));
  assert.deepEqual(h.requests[6], {
    jsonrpc: "2.0",
    id: h.requests[6]?.id,
    method: "turn/interrupt",
    params: { threadId: "thread-existing", turnId: "turn-active" },
  });
  assert.deepEqual(diagnostics, [
    "TARGET_OPTION_NOT_SUPPORTED",
    "TARGET_OPTION_NOT_SUPPORTED",
  ]);
  await h.close();
});

test("steer rebinds once only when the Host names the replacement active Turn", async () => {
  const expectedTurnIds: string[] = [];
  const server: InMemoryAppServer = {
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (!isJsonRpcRequest(message)) return;
      if (message.method === "initialize") {
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          result: {
            codexHome: "/tmp",
            platformFamily: "unix",
            platformOs: "linux",
            userAgent: "test",
          },
        }));
        return;
      }
      if (message.method !== "turn/steer") throw new Error(`Unexpected ${message.method}`);
      const expectedTurnId = String((message.params as { expectedTurnId?: unknown }).expectedTurnId ?? "");
      expectedTurnIds.push(expectedTurnId);
      if (expectedTurnIds.length === 1) {
        peer.send(encodeJsonRpcMessage({
          id: message.id,
          error: {
            code: -32009,
            message: "active Turn changed",
            data: {
              code: "EXPECTED_TURN_MISMATCH",
              retryable: true,
              actualTurnId: "turn-rebound",
            },
          },
        }));
        return;
      }
      peer.send(encodeJsonRpcMessage({ id: message.id, result: { turnId: expectedTurnId } }));
    },
  };
  const client = new JsonRpcAppServerClient({
    hostId,
    transport: new MemoryTransport(server),
  });
  await client.connect({
    clientInfo: { name: "steer-rebind-test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const port = createAppServerConversationCommandPort({
    hostId,
    client,
    interactions: { respond: async () => undefined },
  });
  const result = await port.submit(intent({
    type: "steer-active-turn",
    key: existingKey,
    turnId: asTurnId("turn-obsolete"),
  }));
  assert.equal(result.turnId, "turn-rebound");
  assert.deepEqual(expectedTurnIds, ["turn-obsolete", "turn-rebound"]);
  await client.close();
});

test("host identity is enforced before any network request", async () => {
  const h = await harness();
  const port = commandPort(h);
  await assert.rejects(
    port.submit(
      intent({
        type: "existing-thread",
        key: createConversationKey("other", "thread-existing"),
      }),
    ),
    (error: unknown) =>
      error instanceof AppServerConversationCommandError &&
      error.code === "HOST_MISMATCH",
  );
  assert.equal(h.requests.length, 0);
  await h.close();
});

test("queued-message command port preserves the AppServer queue ABI", async () => {
  const h = await harness();
  const port = commandPort(h);
  const key = existingKey;
  const input = [
    { type: "text" as const, text: "Edited follow-up", text_elements: [] },
  ];
  await port.updateQueuedSubmission(key, "queue-1", input);
  await port.reorderQueuedSubmissions(key, ["queue-2", "queue-1"]);
  const started = await port.startQueuedSubmission(key, "queue-1");
  assert.equal(started, "turn-from-queue");
  await port.steerQueuedSubmission(
    key,
    {
      id: "queue-2",
      clientUserMessageId: "message-2",
      input,
      createdAt: 1,
      pausedReason: null,
    },
    asTurnId("turn-active"),
  );
  await port.deleteQueuedSubmission(key, "queue-1");
  assert.deepEqual(
    h.requests.map((request) => request.method),
    [
      "thread/queue/update",
      "thread/queue/reorder",
      "thread/queue/start",
      "thread/queue/steer",
      "thread/queue/delete",
    ],
  );
  assert.deepEqual(h.requests[1]?.params, {
    threadId: "thread-existing",
    queuedSubmissionIds: ["queue-2", "queue-1"],
  });
  await h.close();
});

test("server-initiated approvals and questions remain pending until an exact typed response completes the RPC", async () => {
  const observedResults: unknown[] = [];
  let initiatingRequestId: string | number | null = null;
  const server: InMemoryAppServer = {
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (isJsonRpcSuccess(message)) {
        observedResults.push(message.result);
        peer.send(
          encodeJsonRpcMessage({
            id: initiatingRequestId,
            result: { interactionResult: message.result },
          }),
        );
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      if (message.method === "initialize") {
        peer.send(
          encodeJsonRpcMessage({
            id: message.id,
            result: {
              codexHome: "/tmp",
              platformFamily: "unix",
              platformOs: "linux",
              userAgent: "test",
            },
          }),
        );
        return;
      }
      initiatingRequestId = message.id;
      if (message.method === "trigger-command-approval") {
        peer.send(
          encodeJsonRpcMessage({
            id: 701,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              itemId: "item-command",
              startedAtMs: 1,
              environmentId: null,
              command: "npm test",
            },
          }),
        );
      } else if (message.method === "trigger-question") {
        peer.send(
          encodeJsonRpcMessage({
            id: "question-rpc",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              itemId: "item-question",
              questions: [
                {
                  id: "framework",
                  header: "Framework",
                  question: "Which runtime?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: "Vite", description: "Web" },
                    { label: "Expo", description: "Native" },
                  ],
                },
              ],
              isBlocking: true,
              autoResolutionMs: null,
            },
          }),
        );
      } else if (message.method === "trigger-option-picker") {
        peer.send(
          encodeJsonRpcMessage({
            id: "option-rpc",
            method: "item/tool/call",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              callId: "option-call",
              namespace: null,
              tool: "request_option_picker",
              arguments: {
                question: "Choose platforms",
                options: [{ label: "Web" }, { label: "iOS" }],
                allowMultiple: true,
              },
            },
          }),
        );
      } else if (message.method === "trigger-onboarding-input") {
        peer.send(
          encodeJsonRpcMessage({
            id: "onboarding-rpc",
            method: "item/tool/call",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              callId: "onboarding-call",
              namespace: null,
              tool: "request_onboarding_input",
              arguments: {
                questions: [
                  {
                    id: "goal",
                    header: "First task",
                    question: "What should we do?",
                    options: [{ label: "Build" }, { label: "Fix" }],
                  },
                ],
              },
            },
          }),
        );
      } else if (message.method === "trigger-setup-role") {
        peer.send(
          encodeJsonRpcMessage({
            id: "setup-role-rpc",
            method: "item/tool/call",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              callId: "setup-role-call",
              namespace: null,
              tool: "setup_codex_step",
              arguments: { step: "role" },
            },
          }),
        );
      } else if (message.method === "trigger-setup-context") {
        peer.send(
          encodeJsonRpcMessage({
            id: "setup-context-rpc",
            method: "item/tool/call",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              callId: "setup-context-call",
              namespace: null,
              tool: "setup_codex_context_picker",
              arguments: {},
            },
          }),
        );
      } else if (message.method === "trigger-legacy-setup-context") {
        peer.send(
          encodeJsonRpcMessage({
            id: "legacy-setup-context-rpc",
            method: "item/tool/requestSetupCodexContextPicker",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              itemId: "legacy-context-call",
            },
          }),
        );
      } else if (message.method === "trigger-server-resolved") {
        peer.send(
          encodeJsonRpcMessage({
            id: "resolved-rpc",
            method: "item/tool/call",
            params: {
              threadId: "thread-existing",
              turnId: "turn-live",
              callId: "resolved-call",
              namespace: null,
              tool: "request_option_picker",
              arguments: {
                question: "Cancelled?",
                options: [{ label: "Yes" }, { label: "No" }],
              },
            },
          }),
        );
        peer.send(
          encodeJsonRpcMessage({
            method: "serverRequest/resolved",
            params: { threadId: "thread-existing", requestId: "resolved-rpc" },
          }),
        );
        peer.send(
          encodeJsonRpcMessage({ id: message.id, result: { resolved: true } }),
        );
      }
    },
  };
  const client = new JsonRpcAppServerClient({
    hostId,
    transport: new MemoryTransport(server),
  });
  await client.connect({
    clientInfo: { name: "interaction-tests", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const pending = new Map<
    string,
    PendingInteraction & { readonly threadId: string }
  >();
  const broker = new AppServerInteractionBroker({
    hostId,
    client,
    now: () => 500,
    store: {
      upsertPendingInteraction(interaction) {
        pending.set(interaction.requestId, interaction);
      },
      removePendingInteraction(_threadId, requestId) {
        pending.delete(requestId);
      },
    },
  });

  const commandOperation = client.requestRaw<{ interactionResult: unknown }>(
    "trigger-command-approval",
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const commandRequestId = encodeServerRequestId(701);
  assert.equal(
    pending.get(commandRequestId)?.method,
    "item/commandExecution/requestApproval",
  );
  assert.equal(pending.get(commandRequestId)?.receivedAtMs, 500);
  await broker.respond(existingKey, {
    type: "command-approval",
    requestId: commandRequestId,
    decision: "acceptForSession",
  });
  assert.deepEqual(await commandOperation, {
    interactionResult: { decision: "acceptForSession" },
  });
  assert.equal(pending.size, 0);

  const questionOperation = client.requestRaw<{ interactionResult: unknown }>(
    "trigger-question",
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const questionRequestId = encodeServerRequestId("question-rpc");
  await assert.rejects(
    broker.respond(existingKey, {
      type: "command-approval",
      requestId: questionRequestId,
      decision: "decline",
    }),
    /cannot answer item\/tool\/requestUserInput/,
  );
  assert.equal(
    pending.has(questionRequestId),
    true,
    "a mismatched UI response must not consume the server request",
  );
  await broker.respond(existingKey, {
    type: "question",
    requestId: questionRequestId,
    answers: { framework: ["Vite", "Expo"] },
  });
  assert.deepEqual(await questionOperation, {
    interactionResult: {
      answers: { framework: { answers: ["Vite", "Expo"] } },
    },
  });

  const optionOperation = client.requestRaw<{ interactionResult: unknown }>(
    "trigger-option-picker",
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const optionRequestId = encodeServerRequestId("option-rpc");
  assert.equal(pending.get(optionRequestId)?.method, "item/tool/call");
  assert.equal(
    pending.get(optionRequestId)?.itemId,
    "option-call",
    "dynamic callId is the attachment identity",
  );
  await broker.respond(existingKey, {
    type: "option-picker",
    requestId: optionRequestId,
    action: "submit",
    selectedOptions: ["Web", "iOS"],
    freeformAnswer: "visionOS",
  });
  assert.deepEqual(await optionOperation, {
    interactionResult: {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "submit",
            selectedOptions: ["Web", "iOS"],
            freeformAnswer: "visionOS",
          }),
        },
      ],
      success: true,
    },
  });

  const onboardingOperation = client.requestRaw<{ interactionResult: unknown }>(
    "trigger-onboarding-input",
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const onboardingRequestId = encodeServerRequestId("onboarding-rpc");
  assert.equal(pending.get(onboardingRequestId)?.itemId, "onboarding-call");
  await broker.respond(existingKey, {
    type: "question",
    requestId: onboardingRequestId,
    answers: { goal: ["Build"] },
  });
  assert.deepEqual(await onboardingOperation, {
    interactionResult: {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ answers: { goal: { answers: ["Build"] } } }),
        },
      ],
      success: true,
    },
  });

  const setupRoleOperation = client.requestRaw<{ interactionResult: unknown }>(
    "trigger-setup-role",
    {},
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const setupRoleRequestId = encodeServerRequestId("setup-role-rpc");
  await broker.respond(existingKey, {
    type: "setup-codex-step",
    requestId: setupRoleRequestId,
    step: "role",
    action: "submit",
    selectedRoles: ["engineering"],
  });
  assert.deepEqual(await setupRoleOperation, {
    interactionResult: {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "submit",
            selectedRoles: ["engineering"],
          }),
        },
      ],
      success: true,
    },
  });

  const setupContextOperation = client.requestRaw<{
    interactionResult: unknown;
  }>("trigger-setup-context", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const setupContextRequestId = encodeServerRequestId("setup-context-rpc");
  await broker.respond(existingKey, {
    type: "setup-context-picker",
    requestId: setupContextRequestId,
    action: "continue",
    selectedSources: ["slack"],
  });
  assert.deepEqual(await setupContextOperation, {
    interactionResult: {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "continue",
            selectedSources: ["slack"],
          }),
        },
      ],
      success: true,
    },
  });

  const legacyContextOperation = client.requestRaw<{
    interactionResult: unknown;
  }>("trigger-legacy-setup-context", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const legacyContextRequestId = encodeServerRequestId(
    "legacy-setup-context-rpc",
  );
  await broker.respond(existingKey, {
    type: "setup-context-picker",
    requestId: legacyContextRequestId,
    action: "dismiss",
    selectedSources: [],
  });
  assert.deepEqual(await legacyContextOperation, {
    interactionResult: { action: "dismiss", selectedSources: [] },
  });
  const observedBeforeResolved = observedResults.length;
  const resolvedOperation = client.requestRaw<{ resolved: boolean }>(
    "trigger-server-resolved",
    {},
  );
  assert.deepEqual(await resolvedOperation, { resolved: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    pending.has(encodeServerRequestId("resolved-rpc")),
    false,
    "serverRequest/resolved must release the Composer surface",
  );
  assert.equal(
    observedResults.length,
    observedBeforeResolved,
    "the client must not send a late response to a server-resolved request",
  );
  assert.deepEqual(observedResults, [
    { decision: "acceptForSession" },
    { answers: { framework: { answers: ["Vite", "Expo"] } } },
    {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "submit",
            selectedOptions: ["Web", "iOS"],
            freeformAnswer: "visionOS",
          }),
        },
      ],
      success: true,
    },
    {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ answers: { goal: { answers: ["Build"] } } }),
        },
      ],
      success: true,
    },
    {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "submit",
            selectedRoles: ["engineering"],
          }),
        },
      ],
      success: true,
    },
    {
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            action: "continue",
            selectedSources: ["slack"],
          }),
        },
      ],
      success: true,
    },
    { action: "dismiss", selectedSources: [] },
  ]);

  broker.dispose();
  await client.close();
});
