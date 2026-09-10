import assert from "node:assert/strict";
import test from "node:test";

import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";
import { asTurnId, createConversationKey } from "@opencraft/chat-core";
import {
  createReplicaConversationRuntime,
  ContinuationCommandError,
  SubmissionOutcomeUnknownError,
  type ConversationCommandPort,
  type ConversationReplicaReader,
} from "@opencraft/chat-runtime";
import {
  createComposerController,
  type SubmissionReceipt,
} from "@opencraft/composer-core";

class FakeReplica implements ConversationReplicaReader {
  private readonly listeners = new Set<() => void>();
  private value: ReplicaClientSnapshot<ReplicaJsonValue>;

  constructor(entity: ReplicaJsonValue, authoritative = true) {
    this.value = {
      revision: 1,
      storageKey: "fixture",
      scope: "codex-thread:local:thread-one",
      phase: authoritative ? "live" : "painted",
      authoritative,
      epoch: "epoch-one",
      nextSeq: 2,
      journalStartSeq: 1,
      entities: new Map([["thread-one", entity]]),
      lastError: null,
    };
  }

  getSnapshot = () => this.value;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setEntity(entity: ReplicaJsonValue): void {
    this.value = {
      ...this.value,
      revision: this.value.revision + 1,
      entities: new Map([["thread-one", entity]]),
    };
    for (const listener of this.listeners) listener();
  }
}

function threadView(
  overrides: Record<string, ReplicaJsonValue> = {},
): ReplicaJsonValue {
  return {
    hostId: "local",
    threadId: "thread-one",
    thread: {
      id: "thread-one",
      name: "Replica thread",
      status: { type: "active" },
      turns: [],
    },
    execution: {
      model: "gpt-5.6",
      reasoningEffort: "high",
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace", "/shared"],
      activePermissionProfile: { id: ":workspace", extends: null },
    },
    turns: [
      {
        id: "turn-one",
        status: "inProgress",
        startedAt: 1_728_000_000,
        params: {
          clientUserMessageId: "client-user-one",
          input: [{ type: "text", text: "Run tests" }],
        },
        items: [
          {
            id: "user-one",
            type: "userMessage",
            clientId: "client-user-one",
            content: [{ type: "text", text: "Run tests" }],
          },
          { id: "assistant-one", type: "agentMessage", text: "Running them." },
        ],
      },
    ],
    pendingInteractions: [
      {
        requestId: "request-one",
        method: "item/commandExecution/requestApproval",
        threadId: "thread-one",
        turnId: "turn-one",
        itemId: "approval-one",
        receivedAtMs: 101,
        params: {
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "approval-one",
          startedAtMs: 100,
          environmentId: null,
          command: "npm test",
        },
      },
    ],
    turnsPagination: {
      olderCursor: "older:1",
      hasLoadedOldest: false,
      isLoadingOlder: false,
    },
    ...overrides,
  };
}

function receipt(
  commandId: string,
  clientMessageId: string,
): SubmissionReceipt {
  return {
    commandId,
    clientMessageId,
    hostId: "local",
    threadId: "thread-one",
    turnId: "turn-two",
    acceptedAt: 200,
    replayed: false,
  };
}

function commands(
  overrides: Partial<ConversationCommandPort> = {},
): ConversationCommandPort {
  return {
    async submit(intent) {
      return receipt(intent.commandId, intent.clientMessageId);
    },
    async interrupt() {},
    async continueTurn() {
      return receipt("retry", "retry-message");
    },
    async respond() {},
    async updateQueuedSubmission(_key, queuedSubmissionId, input) {
      return {
        id: queuedSubmissionId,
        clientUserMessageId: "queued-client",
        input: [...input],
        createdAt: 1,
        pausedReason: null,
      };
    },
    async deleteQueuedSubmission() {
      return true;
    },
    async reorderQueuedSubmissions() {},
    async startQueuedSubmission() {
      return asTurnId("queued-turn");
    },
    async steerQueuedSubmission() {
      return asTurnId("steered-turn");
    },
    ...overrides,
  };
}

test("Replica work clocks survive a fresh runtime and stay independent from Turn duration", () => {
  const replica = new FakeReplica(threadView({ pendingInteractions: [], turns: [{
    id: "timed", status: "completed", turnStartedAtMs: 10_000,
    firstTurnWorkItemStartedAtMs: 10_100, finalAssistantStartedAtMs: 12_600,
    durationMs: 20_000,
    items: [{ id: "work", type: "reasoning", summary: [] }, { id: "answer", type: "agentMessage", text: "Done", phase: "final_answer", completed: true }],
  }] }));
  for (let mount = 0; mount < 2; mount += 1) {
    const runtime = createReplicaConversationRuntime({ key: createConversationKey("local", "thread-one"), replica, commands: commands(), history: { async loadOlder() {} } });
    try {
      const frame = runtime.getSnapshot().timeline.frames.find((frame) => frame.type === "assistant");
      assert.deepEqual(frame?.workStatus, { type: "worked-for", status: "worked", startedAtMs: 10_000, completedAtMs: 12_600 });
      assert.equal(frame?.durationMs, 20_000);
    } finally { runtime.dispose(); }
  }
});

test("Conversation Runtime derives its complete UI snapshot from Replica authority", () => {
  const replica = new FakeReplica(threadView());
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.authoritative, true);
    assert.equal(snapshot.phase, "live");
    assert.equal(snapshot.title, "Replica thread");
    assert.deepEqual(snapshot.execution, {
      model: "gpt-5.6",
      effort: "high",
      permissionProfile: ":workspace",
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace", "/shared"],
    });
    assert.equal(snapshot.activeTurn?.turnId, "turn-one");
    assert.deepEqual(
      snapshot.timeline.frames.map((frame) => frame.type),
      ["user", "assistant", "interaction"],
    );
    assert.equal(snapshot.pendingInteractions[0]?.requestId, "request-one");
    assert.equal(
      snapshot.pendingInteractions[0]?.method,
      "item/commandExecution/requestApproval",
    );
    const userMessage = snapshot.timeline.frames
      .flatMap((frame) => frame.blocks)
      .find((block) => block.type === "user-message");
    assert.equal(userMessage?.type, "user-message");
    if (userMessage?.type === "user-message") {
      assert.equal(userMessage.clientId, "client-user-one");
      assert.equal(userMessage.sentAtMs, 1_728_000_000_000);
    }
    const command = snapshot.timeline.frames
      .flatMap((frame) => frame.blocks)
      .find((block) => block.type === "command-execution");
    assert.equal(command?.type, "command-execution");
    if (command?.type === "command-execution") {
      assert.equal(command.callId, "approval-one");
      assert.equal(command.command, "npm test");
      assert.equal(command.startedAtMs, 100);
      assert.equal(command.status, "running");
      assert.equal(command.output, null);
      assert.deepEqual(command.sourceItemIds, ["approval-one"]);
    }
    const approval = snapshot.timeline.frames
      .flatMap((frame) => frame.blocks)
      .find((block) => block.type === "approval");
    assert.equal(approval?.type, "approval");
    if (approval?.type === "approval") {
      assert.equal(approval.approvalKind, "command");
      assert.equal(approval.command, "npm test");
    }
    assert.equal(snapshot.history.cursor, "older:1");
    assert.equal(snapshot.history.hasOlder, true);
  } finally {
    runtime.dispose();
  }
});

test("pending command approval derives one Codex-compatible provisional Activity and authority replaces it", () => {
  const pending = threadView({
    turns: [{ id: "turn-one", status: "inProgress", items: [] }],
    pendingInteractions: [
      {
        requestId: "request-compound",
        method: "item/commandExecution/requestApproval",
        threadId: "thread-one",
        turnId: "turn-one",
        itemId: "compound-command",
        receivedAtMs: 401,
        params: {
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "compound-command",
          startedAtMs: 400,
          environmentId: null,
          reason: "Inspect the workspace",
          cwd: "/vela",
          commandActions: [
            {
              type: "read",
              command: "cat package.json",
              name: "package.json",
              path: "/vela/package.json",
            },
            {
              type: "search",
              command: "rg vite src",
              query: "vite",
              path: "src",
            },
          ],
        },
      },
    ],
  });
  const replica = new FakeReplica(pending);
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    let commandsInTimeline = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .filter((block) => block.type === "command-execution");
    assert.equal(commandsInTimeline.length, 1);
    const provisional = commandsInTimeline[0];
    assert.equal(provisional?.type, "command-execution");
    if (provisional?.type === "command-execution") {
      assert.equal(provisional.id, "command-execution:compound-command");
      assert.equal(provisional.command, "cat package.json");
      assert.deepEqual(provisional.actions, [
        {
          type: "read",
          command: "cat package.json",
          name: "package.json",
          path: "/vela/package.json",
        },
      ]);
      assert.equal(provisional.status, "running");
    }

    replica.setEntity(
      threadView({
        turns: [
          {
            id: "turn-one",
            status: "completed",
            items: [
              {
                id: "compound-command",
                type: "commandExecution",
                command: "cat package.json && rg vite src",
                cwd: "/vela",
                processId: null,
                status: "completed",
                commandActions: [
                  {
                    type: "read",
                    command: "cat package.json",
                    name: "package.json",
                    path: "/vela/package.json",
                  },
                  {
                    type: "search",
                    command: "rg vite src",
                    query: "vite",
                    path: "src",
                  },
                ],
                aggregatedOutput: "package.json\nsrc/main.tsx",
                exitCode: 0,
                durationMs: 28,
              },
            ],
          },
        ],
        // Deliberately retain the request for one publication to exercise the
        // Replica race: the authoritative Item must suppress the provisional.
        pendingInteractions: (
          pending as Readonly<Record<string, ReplicaJsonValue>>
        ).pendingInteractions,
      }),
    );

    commandsInTimeline = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .filter((block) => block.type === "command-execution");
    assert.equal(commandsInTimeline.length, 2);
    assert.deepEqual(
      commandsInTimeline.map((block) => block.id),
      [
        "command-execution:compound-command:0",
        "command-execution:compound-command:1",
      ],
    );
    assert.deepEqual(
      commandsInTimeline.map((block) => block.status),
      ["complete", "complete"],
    );
    assert.deepEqual(
      commandsInTimeline.map((block) => block.output),
      ["package.json\nsrc/main.tsx", "package.json\nsrc/main.tsx"],
    );
  } finally {
    runtime.dispose();
  }
});

test("file-change and permission approvals never invent provisional tool Activities", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [{ id: "turn-one", status: "inProgress", items: [] }],
      pendingInteractions: [
        {
          requestId: "request-patch",
          method: "item/fileChange/requestApproval",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "patch-missing",
          receivedAtMs: 500,
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            itemId: "patch-missing",
            reason: "Write files",
            grantRoot: "/vela",
          },
        },
        {
          requestId: "request-permission",
          method: "item/permissions/requestApproval",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: null,
          receivedAtMs: 501,
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            reason: "Use network",
            permissions: { network: { enabled: true } },
          },
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const blocks = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks);
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["approval", "approval"],
    );
  } finally {
    runtime.dispose();
  }
});

test("Conversation Runtime projects the authoritative Turn aggregate diff as a trailing resource", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [
        {
          id: "turn-one",
          status: "completed",
          diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra",
          items: [
            {
              id: "patch-one",
              type: "fileChange",
              status: "completed",
              changes: [{ path: "src/a.ts", kind: "modify" }],
            },
          ],
        },
      ],
      pendingInteractions: [],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const blocks = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks);
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["patch", "turn-diff"],
    );
    const turnDiff = blocks[1];
    assert.equal(turnDiff?.type, "turn-diff");
    if (turnDiff?.type === "turn-diff") {
      assert.deepEqual(turnDiff.files, [
        { path: "src/a.ts", additions: 2, deletions: 1 },
      ]);
    }
  } finally {
    runtime.dispose();
  }
});

test("Guardian auto-reviews attach to target tools and keep unmatched failures standalone", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [
        {
          id: "turn-one",
          status: "inProgress",
          items: [
            {
              id: "command-one",
              type: "commandExecution",
              command: "git status",
              status: "inProgress",
            },
            {
              id: "mcp-one",
              type: "mcpToolCall",
              server: "files",
              tool: "read",
              status: "inProgress",
            },
          ],
        },
      ],
      pendingInteractions: [],
      guardianApprovalReviews: [
        {
          reviewId: "review-command",
          turnId: "turn-one",
          targetItemId: "command-one",
          startedAtMs: 10,
          completedAtMs: 20,
          status: "denied",
          riskLevel: "high",
          userAuthorization: "low",
          rationale: "Repository metadata may be exposed.",
          action: {
            type: "command",
            source: "shell",
            command: "git status",
            cwd: "/workspace",
          },
          decisionSource: "agent",
        },
        {
          reviewId: "review-approved",
          turnId: "turn-one",
          targetItemId: "mcp-one",
          startedAtMs: 21,
          completedAtMs: 25,
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Read-only.",
          action: {
            type: "mcpToolCall",
            server: "files",
            toolName: "read",
            connectorId: null,
            connectorName: null,
            toolTitle: null,
          },
          decisionSource: "agent",
        },
        {
          reviewId: "review-network",
          turnId: "turn-one",
          targetItemId: null,
          startedAtMs: 30,
          completedAtMs: 40,
          status: "timedOut",
          riskLevel: null,
          userAuthorization: null,
          rationale: null,
          action: {
            type: "networkAccess",
            target: "api.example.com",
            host: "api.example.com",
            protocol: "https",
            port: 443,
          },
          decisionSource: "agent",
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const blocks = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks);
    const command = blocks.find((block) => block.type === "command-execution");
    assert.equal(command?.type, "command-execution");
    if (command?.type === "command-execution") {
      assert.equal(command.automaticApprovalReviews.length, 1);
      assert.equal(command.automaticApprovalReviews[0]?.id, "review-command");
      assert.equal(command.automaticApprovalReviews[0]?.status, "denied");
    }
    const mcp = blocks.find((block) => block.type === "tool-call");
    assert.equal(mcp?.type, "tool-call");
    if (mcp?.type === "tool-call")
      assert.equal(mcp.automaticApprovalReviews.length, 0);
    const standalone = blocks.find(
      (block) => block.type === "automatic-approval-review",
    );
    assert.equal(standalone?.type, "automatic-approval-review");
    if (standalone?.type === "automatic-approval-review") {
      assert.equal(standalone.review.id, "review-network");
      assert.equal(standalone.review.status, "timedOut");
    }
  } finally {
    runtime.dispose();
  }
});

test("commandExecution commandActions become stable Codex activity rows sharing source identity and reviews", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [
        {
          id: "turn-command-actions",
          status: "completed",
          items: [
            {
              id: "compound-command",
              type: "commandExecution",
              command: "cat package.json && rg vite src",
              cwd: "/vela",
              status: "completed",
              commandActions: [
                {
                  type: "read",
                  command: "cat package.json",
                  name: "package.json",
                  path: "/vela/package.json",
                },
                {
                  type: "search",
                  command: "rg vite src",
                  query: "vite",
                  path: "/vela/src",
                },
              ],
              aggregatedOutput: "match",
              exitCode: 0,
            },
          ],
        },
      ],
      pendingInteractions: [],
      guardianApprovalReviews: [
        {
          reviewId: "compound-review",
          turnId: "turn-command-actions",
          targetItemId: "compound-command",
          startedAtMs: 1,
          completedAtMs: 2,
          status: "denied",
          riskLevel: "medium",
          userAuthorization: "low",
          rationale: "Review",
          action: {
            type: "command",
            source: "shell",
            command: "cat package.json && rg vite src",
            cwd: "/vela",
          },
          decisionSource: "agent",
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const blocks = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .filter((block) => block.type === "command-execution");
    assert.deepEqual(
      blocks.map((block) => block.id),
      [
        "command-execution:compound-command:0",
        "command-execution:compound-command:1",
      ],
    );
    assert.deepEqual(
      blocks.map((block) => block.callId),
      ["compound-command:0", "compound-command:1"],
    );
    assert.deepEqual(
      blocks.map((block) => block.command),
      ["cat package.json", "rg vite src"],
    );
    assert.deepEqual(
      blocks.map((block) => block.sourceItemIds),
      [["compound-command"], ["compound-command"]],
    );
    assert.deepEqual(
      blocks.map((block) => block.automaticApprovalReviews[0]?.id),
      ["compound-review", "compound-review"],
    );
  } finally {
    runtime.dispose();
  }
});

test("Conversation Runtime projects every pending request_user_input question", () => {
  const replica = new FakeReplica(
    threadView({
      pendingInteractions: [
        {
          requestId: "request-questions",
          method: "item/tool/requestUserInput",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "question-one",
          receivedAtMs: 101,
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            itemId: "question-one",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "runtime",
                header: "Runtime",
                question: "Which runtime?",
                isOther: false,
                isSecret: false,
                options: [{ label: "Web", description: "Browser" }],
              },
              {
                id: "detail",
                header: "Detail",
                question: "Add a note",
                isOther: true,
                isSecret: false,
                options: null,
              },
            ],
          },
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const block = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .find((candidate) => candidate.type === "question");
    assert.equal(block?.type, "question");
    if (block?.type !== "question") return;
    assert.deepEqual(
      block.questions.map((question) => question.id),
      ["runtime", "detail"],
    );
    assert.equal(block.questions[0]?.options[0]?.description, "Browser");
    assert.equal(block.questions[1]?.isOther, true);
  } finally {
    runtime.dispose();
  }
});

test("Conversation Runtime projects request_option_picker arguments from dynamic tool requests", () => {
  const replica = new FakeReplica(
    threadView({
      pendingInteractions: [
        {
          requestId: "request-picker",
          method: "item/tool/call",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "option-call",
          receivedAtMs: 102,
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            callId: "option-call",
            namespace: null,
            tool: "request_option_picker",
            arguments: {
              question: "Choose platforms",
              options: [
                { label: "Web", description: "Browser" },
                { label: "iOS" },
              ],
              allowMultiple: true,
              submitLabel: "Continue",
              skipLabel: "Not now",
            },
          },
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const block = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .find((candidate) => candidate.type === "option-picker");
    assert.equal(block?.type, "option-picker");
    if (block?.type !== "option-picker") return;
    assert.equal(block.question, "Choose platforms");
    assert.equal(block.allowMultiple, true);
    assert.deepEqual(
      block.options.map((option) => option.label),
      ["Web", "iOS"],
    );
    assert.equal(block.submitLabel, "Continue");
  } finally {
    runtime.dispose();
  }
});

test("Conversation Runtime projects every Codex onboarding tool without capturing setup completion", () => {
  const base = {
    threadId: "thread-one",
    turnId: "turn-one",
    namespace: null,
  } as const;
  const replica = new FakeReplica(
    threadView({
      pendingInteractions: [
        {
          requestId: "request-onboarding",
          method: "item/tool/call",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "onboarding-call",
          receivedAtMs: 103,
          params: {
            ...base,
            callId: "onboarding-call",
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
        },
        {
          requestId: "request-role",
          method: "item/tool/call",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "role-call",
          receivedAtMs: 104,
          params: {
            ...base,
            callId: "role-call",
            tool: "setup_codex_step",
            arguments: { step: "role" },
          },
        },
        {
          requestId: "request-context",
          method: "item/tool/call",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "context-call",
          receivedAtMs: 105,
          params: {
            ...base,
            callId: "context-call",
            tool: "setup_codex_context_picker",
            arguments: {},
          },
        },
        {
          requestId: "request-legacy-context",
          method: "item/tool/requestSetupCodexContextPicker",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "legacy-context-call",
          receivedAtMs: 106,
          params: {
            threadId: "thread-one",
            turnId: "turn-one",
            itemId: "legacy-context-call",
          },
        },
        {
          requestId: "request-complete",
          method: "item/tool/call",
          threadId: "thread-one",
          turnId: "turn-one",
          itemId: "complete-call",
          receivedAtMs: 107,
          params: {
            ...base,
            callId: "complete-call",
            tool: "setup_codex_step",
            arguments: { step: "complete" },
          },
        },
      ],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const interactions = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .filter(
        (block) =>
          block.type === "question" ||
          block.type === "setup-codex-step" ||
          block.type === "setup-context-picker",
      );
    assert.deepEqual(
      interactions.map((block) => block.type),
      [
        "question",
        "setup-codex-step",
        "setup-context-picker",
        "setup-context-picker",
      ],
    );
    const question = interactions[0];
    assert.equal(question?.type, "question");
    if (question?.type === "question") {
      assert.equal(question.questions[0]?.isOther, true);
      assert.deepEqual(
        question.questions[0]?.options.map((option) => option.label),
        ["Build", "Fix"],
      );
    }
    assert.equal(
      runtime
        .getSnapshot()
        .pendingInteractions.some(
          (interaction) => interaction.requestId === "request-complete",
        ),
      false,
    );
  } finally {
    runtime.dispose();
  }
});

test("painted cache is visible but never pages before Resume becomes authoritative", async () => {
  let historyLoads = 0;
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView(), false),
    commands: commands(),
    history: {
      async loadOlder() {
        historyLoads += 1;
      },
    },
  });
  try {
    assert.equal(runtime.getSnapshot().phase, "painted");
    assert.equal(runtime.getSnapshot().authoritative, false);
    assert.equal(runtime.getSnapshot().timeline.frames.length, 3);
    assert.equal(runtime.getSnapshot().history.hasOlder, false);
    await assert.doesNotReject(runtime.loadOlder());
    assert.equal(historyLoads, 0);
  } finally {
    runtime.dispose();
  }
});

test("Replica publication, not Session mutation, drives Timeline updates", () => {
  const replica = new FakeReplica(threadView());
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  let notifications = 0;
  runtime.subscribe(() => (notifications += 1));
  replica.setEntity(
    threadView({
      turns: [
        {
          id: "turn-two",
          status: "completed",
          items: [{ id: "future-one", type: "futureItem", payload: 1 }],
        },
      ],
      pendingInteractions: [],
    }),
  );
  try {
    assert.equal(notifications, 1);
    assert.equal(
      runtime.getSnapshot().timeline.frames[0]?.blocks[0]?.type,
      "unknown",
    );
    assert.equal(runtime.getSnapshot().activeTurn, null);
  } finally {
    runtime.dispose();
  }
});

test("Replica Hook runs become final assistant action-row statistics", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [
        {
          id: "turn-hook",
          status: "completed",
          items: [
            { id: "assistant-hook", type: "agentMessage", text: "Done." },
          ],
          hookRuns: [
            {
              id: "hook-one",
              run: {
                id: "hook-one",
                eventName: "afterToolUse",
                source: "project",
                status: "failed",
                statusMessage: "Hook failed",
                entries: [
                  { kind: "error", text: "Lint hook exited with code 1." },
                ],
              },
            },
          ],
        },
      ],
      pendingInteractions: [],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const assistant = runtime
      .getSnapshot()
      .timeline.frames.find((frame) => frame.type === "assistant");
    assert.equal(assistant?.hookStats?.count, 1);
    assert.equal(assistant?.hookStats?.errorCount, 1);
    assert.deepEqual(assistant?.hookStats?.entries, [
      { kind: "error", text: "Lint hook exited with code 1." },
    ]);
  } finally {
    runtime.dispose();
  }
});

function failedConversation(code = "serverOverloaded") {
  return threadView({
    thread: { id: "thread-one", status: { type: "idle" } },
    pendingInteractions: [],
    turns: [{ id: "failed", status: "failed", items: [], error: { message: "Failure", codexErrorInfo: code } }],
  });
}

test("continuation owns eligibility and blocks historical, duplicate and stale-snapshot starts", async () => {
  let resolve!: (value: SubmissionReceipt) => void;
  let calls = 0;
  const replica = new FakeReplica(failedConversation());
  const composer = createComposerController({
    type: "existing-thread", key: createConversationKey("local", "thread-one"),
  }, { now: () => 100, createId: () => "next-message" });
  composer.dispatch({ type: "set-document", document: {
    version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Next message" }] }],
  } });
  const nextMessage = composer.createSubmitIntent();
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"), replica,
    commands: commands({ continueTurn: async () => {
      calls++;
      return new Promise<SubmissionReceipt>((done) => { resolve = done; });
    } }), history: { async loadOlder() {} },
  });
  try {
    assert.equal(runtime.getSnapshot().continuation.turnId, "failed");
    await assert.rejects(runtime.continueTurn(asTurnId("older")));
    const pending = runtime.continueTurn(asTurnId("failed"));
    assert.equal(runtime.getSnapshot().continuation.pending, true);
    await assert.rejects(runtime.submit(nextMessage), /Waiting for continuation/);
    await assert.rejects(runtime.continueTurn(asTurnId("failed")));
    assert.equal(calls, 1);
    resolve(receipt("continue", "continue-message"));
    await pending;
    assert.equal(runtime.getSnapshot().continuation.pending, false);
    assert.equal(runtime.getSnapshot().continuation.turnId, null);
    await assert.rejects(runtime.submit(nextMessage), /Waiting for continuation/);
    await assert.rejects(runtime.continueTurn(asTurnId("failed")));
    assert.equal(calls, 1);
  } finally { runtime.dispose(); }
});

test("continuation rejection is observable and does not silently disappear", async () => {
  const failure = new ContinuationCommandError("rejected", "Host rejected continuation");
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(failedConversation()),
    commands: commands({ async continueTurn() { throw failure; } }),
    history: { async loadOlder() {} },
  });
  try {
    await assert.rejects(runtime.continueTurn(asTurnId("failed")), failure);
    assert.equal(runtime.getSnapshot().continuation.error, failure);
    assert.equal(runtime.getSnapshot().continuation.pending, false);
    assert.equal(runtime.getSnapshot().continuation.turnId, "failed");
  } finally { runtime.dispose(); }
});

test("a lost continuation acknowledgement is not permission to send it again", async () => {
  const replica = new FakeReplica(failedConversation());
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"), replica,
    commands: commands({ async continueTurn() {
      throw new ContinuationCommandError("unknown", "Lost acknowledgement");
    } }), history: { async loadOlder() {} },
  });
  try {
    await assert.rejects(runtime.continueTurn(asTurnId("failed")));
    assert.equal(runtime.getSnapshot().continuation.turnId, null);
    await assert.rejects(runtime.continueTurn(asTurnId("failed")));
    replica.setEntity(threadView());
    assert.equal(runtime.getSnapshot().continuation.error, null);
  } finally { runtime.dispose(); }
});

test("generic errors and cached history never advertise overload continuation", async () => {
  for (const replica of [new FakeReplica(failedConversation("other")), new FakeReplica(failedConversation(), false)]) {
    const runtime = createReplicaConversationRuntime({
      key: createConversationKey("local", "thread-one"), replica,
      commands: commands({ async continueTurn() { assert.fail("must not send"); } }),
      history: { async loadOlder() {} },
    });
    try {
      assert.equal(runtime.getSnapshot().continuation.turnId, null);
      await assert.rejects(runtime.continueTurn(asTurnId("failed")));
    } finally { runtime.dispose(); }
  }
});

test("automatic reconnect progress coalesces with stable identity and is retired on failure", () => {
  const items = [
    { id: "reconnect-1", type: "error", willRetry: true, message: "Reconnecting 1/2" },
    { id: "reconnect-2", type: "streamError", message: "Reconnecting 2/2" },
  ];
  const replica = new FakeReplica(threadView({ turns: [{ id: "turn-one", status: "inProgress", items }], pendingInteractions: [] }));
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"), replica, commands: commands(), history: { async loadOlder() {} },
  });
  const errors = () => runtime.getSnapshot().timeline.frames.flatMap((frame) => frame.blocks).filter((block) => block.type === "error");
  try {
    assert.equal(errors().length, 1);
    assert.equal(errors()[0]?.message, "Reconnecting 2/2");
    assert.equal(errors()[0]?.recovery, "automatic");
    const identity = errors()[0]?.id;
    replica.setEntity(threadView({ turns: [{ id: "turn-one", status: "inProgress", items: items.slice(0, 1) }], pendingInteractions: [] }));
    assert.equal(errors()[0]?.id, identity);
    replica.setEntity(threadView({ turns: [{ id: "turn-one", status: "failed", items, error: { message: "Disconnected", codexErrorInfo: "other" } }], pendingInteractions: [] }));
    assert.equal(errors().length, 1);
    assert.equal(errors()[0]?.message, "Disconnected");
    assert.equal(errors()[0]?.recovery, "terminal");
  } finally { runtime.dispose(); }
});

test("a failed AppServer Turn preserves the protocol error discriminant and details", () => {
  const replica = new FakeReplica(
    threadView({
      turns: [
        {
          id: "turn-failed",
          status: "failed",
          items: [
            {
              id: "user-failed",
              type: "userMessage",
              content: [{ type: "text", text: "Try it" }],
            },
          ],
          error: {
            message: "Model stream disconnected",
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
            additionalDetails: "Upstream disconnected",
          },
        },
      ],
      pendingInteractions: [],
    }),
  );
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  try {
    const errorBlock = runtime
      .getSnapshot()
      .timeline.frames.flatMap((frame) => frame.blocks)
      .find((block) => block.type === "error");
    assert.equal(errorBlock?.type, "error");
    if (errorBlock?.type !== "error")
      throw new Error("Expected an error block");
    assert.equal(errorBlock.code, "responseStreamDisconnected");
    assert.equal(errorBlock.message, "Model stream disconnected");
    assert.equal(errorBlock.recovery, "terminal");
    assert.equal(errorBlock.additionalDetails, "Upstream disconnected");
  } finally {
    runtime.dispose();
  }
});

test("unknown delivery is fenced until an authoritative Item acknowledges it", async () => {
  const key = createConversationKey("local", "thread-one");
  const replica = new FakeReplica(threadView());
  let calls = 0;
  const runtime = createReplicaConversationRuntime({ key, replica,
    commands: commands({ submit: async () => { calls++; throw new SubmissionOutcomeUnknownError(); } }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "existing-thread", key }, { now: () => 100, createId: () => "unknown-submission" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Hello" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(intent), SubmissionOutcomeUnknownError);
  assert.equal(runtime.getSnapshot().pendingSubmissions[0]?.state, "unknown");
  const user = runtime.getSnapshot().timeline.frames.flatMap(f => f.blocks).find(b => b.type === "user-message" && b.message === "Hello");
  assert.equal(user?.type === "user-message" && user.deliveryStatus, "unknown");
  await assert.rejects(runtime.submit(intent), SubmissionOutcomeUnknownError);
  assert.equal(calls, 1);
  runtime.dismissFailedSubmission(intent.commandId);
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 1);
  replica.setEntity(threadView({ turns: [{ id: "confirmed", status: "inProgress", items: [
    { id: "confirmed-user", type: "userMessage", clientId: intent.clientMessageId, content: [{ type: "text", text: "Hello" }] },
  ] }] }));
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 0);
  runtime.dispose();
});

test("ordinary submission is an optimistic Turn and never a queued follow-up", async () => {
  const expectedError = new Error("network down");
  let rejectSubmission!: (error: Error) => void;
  const pending = new Promise<SubmissionReceipt>((_resolve, reject) => {
    rejectSubmission = reject;
  });
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  let id = 0;
  const composer = createComposerController(
    {
      type: "existing-thread",
      key: createConversationKey("local", "thread-one"),
    },
    { now: () => 100, createId: () => `submission-${++id}` },
  );
  composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [
        { type: "paragraph", children: [{ type: "text", text: "Hello" }] },
      ],
    },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  let snapshot = runtime.getSnapshot();
  assert.equal(snapshot.queuedSubmissions.length, 0);
  assert.equal(snapshot.pendingSubmissions[0]?.state, "submitting");
  const optimisticUserMessage = snapshot.timeline.frames
    .flatMap((frame) => frame.blocks)
    .find(
      (block) =>
        block.type === "user-message" && block.message === "Hello",
    );
  assert.equal(optimisticUserMessage?.type, "user-message");
  if (optimisticUserMessage?.type !== "user-message")
    throw new Error("Expected optimistic user message");
  assert.equal(optimisticUserMessage.message, "Hello");
  assert.equal(optimisticUserMessage.deliveryStatus, "sending");
  rejectSubmission(expectedError);
  await assert.rejects(operation, expectedError);
  snapshot = runtime.getSnapshot();
  assert.equal(snapshot.queuedSubmissions.length, 0);
  assert.equal(snapshot.pendingSubmissions[0]?.state, "failed");
  assert.ok(
    snapshot.timeline.frames
      .flatMap((frame) => frame.blocks)
      .some((block) => block.type === "error"),
  );
  runtime.dismissFailedSubmission(intent.commandId);
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 0);
  runtime.dispose();
});

test("an acknowledged Turn cannot jump ahead of an older failed local Turn", async () => {
  const replica = new FakeReplica(threadView({ pendingInteractions: [] }));
  const key = createConversationKey("local", "thread-one");
  let submission = 0;
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({
      submit: async (intent) => {
        submission += 1;
        if (submission === 1) throw new Error("Attachment is not ready");
        return receipt(intent.commandId, intent.clientMessageId);
      },
    }),
    history: { async loadOlder() {} },
  });
  let id = 0;
  const composer = createComposerController(
    { type: "existing-thread", key },
    { now: () => 100 + id * 100, createId: () => `ordered-${++id}` },
  );
  const setText = (text: string) => composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
    },
  });
  const userMessages = () => runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message")
    .map((block) => block.type === "user-message" ? block.message : "");

  setText("Failed locally");
  const failedIntent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(failedIntent), /Attachment is not ready/);

  setText("Delivered later");
  const deliveredIntent = composer.createSubmitIntent();
  await runtime.submit(deliveredIntent);
  assert.deepEqual(userMessages(), ["Run tests", "Failed locally", "Delivered later"]);

  replica.setEntity(threadView({
    pendingInteractions: [],
    turns: [
      {
        id: "turn-one",
        status: "completed",
        startedAt: 1_728_000_000,
        params: {
          clientUserMessageId: "client-user-one",
          input: [{ type: "text", text: "Run tests" }],
        },
        items: [
          {
            id: "user-one",
            type: "userMessage",
            clientId: "client-user-one",
            content: [{ type: "text", text: "Run tests" }],
          },
          { id: "assistant-one", type: "agentMessage", text: "Done." },
        ],
      },
      {
        id: "turn-two",
        status: "inProgress",
        startedAtMs: 300,
        params: {
          clientUserMessageId: deliveredIntent.clientMessageId,
          input: [{ type: "text", text: "Delivered later" }],
        },
        items: [
          {
            id: "user-two",
            type: "userMessage",
            clientId: deliveredIntent.clientMessageId,
            content: [{ type: "text", text: "Delivered later" }],
          },
        ],
      },
    ],
  }));

  assert.deepEqual(
    userMessages(),
    ["Run tests", "Failed locally", "Delivered later"],
    "authority may replace identity and delivery state, but never insertion order",
  );
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 1);
  assert.equal(runtime.getSnapshot().pendingSubmissions[0]?.commandId, failedIntent.commandId);
  runtime.dispose();
});

test("a newer failed local Turn stays after an older Turn when its acknowledgement arrives", async () => {
  const replica = new FakeReplica(threadView({ pendingInteractions: [] }));
  const key = createConversationKey("local", "thread-one");
  let submission = 0;
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({
      submit: async (intent) => {
        submission += 1;
        if (submission === 2) throw new Error("Hermes input is empty");
        return receipt(intent.commandId, intent.clientMessageId);
      },
    }),
    history: { async loadOlder() {} },
  });
  let id = 0;
  const composer = createComposerController(
    { type: "existing-thread", key },
    { now: () => 100 + id * 100, createId: () => `inverse-${++id}` },
  );
  const setText = (text: string) => composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text }] }],
    },
  });
  const userMessages = () => runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message")
    .map((block) => block.type === "user-message" ? block.message : "");

  setText("Delivered first");
  const deliveredIntent = composer.createSubmitIntent();
  await runtime.submit(deliveredIntent);
  setText("Failed afterward");
  const failedIntent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(failedIntent), /Hermes input is empty/);
  assert.deepEqual(userMessages(), ["Run tests", "Delivered first", "Failed afterward"]);

  replica.setEntity(threadView({
    pendingInteractions: [],
    turns: [
      {
        id: "turn-one",
        status: "completed",
        startedAt: 1_728_000_000,
        params: {
          clientUserMessageId: "client-user-one",
          input: [{ type: "text", text: "Run tests" }],
        },
        items: [
          {
            id: "user-one",
            type: "userMessage",
            clientId: "client-user-one",
            content: [{ type: "text", text: "Run tests" }],
          },
          { id: "assistant-one", type: "agentMessage", text: "Done." },
        ],
      },
      {
        id: "turn-two",
        status: "completed",
        startedAtMs: 200,
        params: {
          clientUserMessageId: deliveredIntent.clientMessageId,
          input: [{ type: "text", text: "Delivered first" }],
        },
        items: [
          {
            id: "user-two",
            type: "userMessage",
            clientId: deliveredIntent.clientMessageId,
            content: [{ type: "text", text: "Delivered first" }],
          },
          { id: "assistant-two", type: "agentMessage", text: "Done too." },
        ],
      },
    ],
  }));

  assert.deepEqual(
    userMessages(),
    ["Run tests", "Delivered first", "Failed afterward"],
    "a delayed acknowledgement must carry later local slots across its new identity",
  );
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 1);
  assert.equal(runtime.getSnapshot().pendingSubmissions[0]?.commandId, failedIntent.commandId);
  runtime.dispose();
});

test("authoritative Turn acknowledgement retires the optimistic submission", async () => {
  let resolveSubmission!: (receipt: SubmissionReceipt) => void;
  const pending = new Promise<SubmissionReceipt>((resolve) => {
    resolveSubmission = resolve;
  });
  const replica = new FakeReplica(threadView({ turns: [] }));
  const key = createConversationKey("local", "thread-one");
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController(
    { type: "existing-thread", key },
    { now: () => 100, createId: () => "acknowledged" },
  );
  composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }],
    },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  replica.setEntity(
    threadView({
      turns: [
        {
          id: "turn-two",
          status: "inProgress",
          items: [
            {
              id: "user-two",
              type: "userMessage",
              clientId: intent.clientMessageId,
              content: [{ type: "text", text: "Hello" }],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(
    runtime.getSnapshot().timeline.frames
      .flatMap((frame) => frame.blocks)
      .filter(
        (block) => block.type === "user-message" && block.message === "Hello",
      ).length,
    1,
    "the server Item identity suppresses the optimistic row before turn/start resolves",
  );
  resolveSubmission({
    commandId: intent.commandId,
    clientMessageId: intent.clientMessageId,
    hostId: "local",
    threadId: "thread-one",
    turnId: "turn-two",
    acceptedAt: 101,
    replayed: false,
  });
  await operation;
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.pendingSubmissions.length, 0);
  assert.equal(
    snapshot.timeline.frames
      .flatMap((frame) => frame.blocks)
      .filter(
        (block) => block.type === "user-message" && block.message === "Hello",
      ).length,
    1,
  );
  runtime.dispose();
});

test("steer remains visible until its authoritative user-message identity joins it", async () => {
  let resolveSubmission!: (receipt: SubmissionReceipt) => void;
  const pending = new Promise<SubmissionReceipt>((resolve) => {
    resolveSubmission = resolve;
  });
  const replica = new FakeReplica(threadView());
  const key = createConversationKey("local", "thread-one");
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController(
    { type: "steer-active-turn", key, turnId: asTurnId("turn-one") },
    { now: () => 100, createId: () => "steer-command" },
  );
  composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Do this instead" }] }],
    },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  const countSteers = () => runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message" && block.message === "Do this instead").length;
  assert.equal(countSteers(), 1);

  resolveSubmission({
    commandId: intent.commandId,
    clientMessageId: intent.clientMessageId,
    hostId: "local",
    threadId: "thread-one",
    turnId: "turn-one",
    acceptedAt: 101,
    replayed: false,
  });
  await operation;
  assert.equal(runtime.getSnapshot().pendingSubmissions[0]?.state, "submitting");
  assert.equal(countSteers(), 1, "RPC admission alone cannot accept or remove a steer");

  replica.setEntity(threadView({
    turns: [{
      id: "turn-one",
      status: "inProgress",
      startedAt: 1_728_000_000,
      params: {
        clientUserMessageId: "client-user-one",
        input: [{ type: "text", text: "Run tests" }],
      },
      items: [
        { id: "user-one", type: "userMessage", clientId: "client-user-one", content: [{ type: "text", text: "Run tests" }] },
        { id: "assistant-one", type: "agentMessage", text: "Running them." },
        { id: "server-steer", type: "userMessage", clientId: null, content: [{ type: "text", text: "Do this instead" }] },
      ],
    }],
    pendingInteractions: [],
  }));
  assert.equal(countSteers(), 1, "local and server identities must normalize into one row");
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 1);
  assert.equal(runtime.getSnapshot().pendingSubmissions[0]?.state, "accepted");
  assert.equal(countSteers(), 1, "RPC acceptance is not user-message acknowledgement");

  replica.setEntity(threadView({
    turns: [{
      id: "turn-one",
      status: "completed",
      startedAt: 1_728_000_000,
      params: {
        clientUserMessageId: "client-user-one",
        input: [{ type: "text", text: "Run tests" }],
      },
      items: [
        { id: "user-one", type: "userMessage", clientId: "client-user-one", content: [{ type: "text", text: "Run tests" }] },
        { id: "assistant-one", type: "agentMessage", text: "Done." },
        { id: "server-steer", type: "userMessage", clientId: null, content: [{ type: "text", text: "Do this instead" }] },
      ],
    }],
    pendingInteractions: [],
  }));
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 0);
  assert.equal(countSteers(), 1);
  runtime.dispose();
});

test("a steer restored by the Host transfers display ownership to the queue", async () => {
  let resolveSubmission!: (receipt: SubmissionReceipt) => void;
  const pending = new Promise<SubmissionReceipt>((resolve) => {
    resolveSubmission = resolve;
  });
  const replica = new FakeReplica(threadView());
  const key = createConversationKey("local", "thread-one");
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController(
    { type: "steer-active-turn", key, turnId: asTurnId("turn-one") },
    { now: () => 100, createId: () => "racing-steer" },
  );
  composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Do this later" }] }],
    },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 1);
  runtime.replaceQueuedSubmissions([{
    id: "restored-queue",
    input: [{ type: "text", text: "Do this later", text_elements: [] }],
    clientUserMessageId: intent.clientMessageId,
    createdAt: 100,
    pausedReason: "Run ended before this message could be steered.",
  }]);
  resolveSubmission({
    commandId: intent.commandId,
    clientMessageId: intent.clientMessageId,
    hostId: "local",
    threadId: "thread-one",
    turnId: null,
    acceptedAt: 101,
    replayed: false,
    disposition: "queue",
  });
  await operation;
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.pendingSubmissions.length, 0);
  assert.equal(snapshot.queuedSubmissions.length, 1);
  assert.equal(snapshot.queuedSubmissions[0]?.pausedReason, "Run ended before this message could be steered.");
  assert.equal(
    snapshot.timeline.frames.flatMap((frame) => frame.blocks)
      .filter((block) => block.type === "user-message" && block.message === "Do this later").length,
    0,
  );
  runtime.dispose();
});

test("explicit follow-up submission alone owns optimistic queue state", async () => {
  let resolveSubmission!: (receipt: SubmissionReceipt) => void;
  const pending = new Promise<SubmissionReceipt>((resolve) => {
    resolveSubmission = resolve;
  });
  const key = createConversationKey("local", "thread-one");
  const runtime = createReplicaConversationRuntime({
    key,
    replica: new FakeReplica(threadView()),
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController(
    { type: "enqueue-follow-up", key },
    { now: () => 100, createId: (() => { let id = 0; return () => `queue-${++id}`; })() },
  );
  composer.dispatch({
    type: "set-document",
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "Next" }] }],
    },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.state, "submitting");
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 0);
  resolveSubmission({
    commandId: intent.commandId,
    clientMessageId: intent.clientMessageId,
    hostId: "local",
    threadId: "thread-one",
    turnId: null,
    acceptedAt: 101,
    replayed: false,
  });
  await operation;
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.state, "queued");
  runtime.dispose();
});

test("authoritative AppServer queue replaces optimistic follow-up state", () => {
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands(),
    history: { async loadOlder() {} },
  });
  runtime.replaceQueuedSubmissions([
    {
      id: "queue-one",
      clientUserMessageId: "client-one",
      input: [
        { type: "text", text: "Run the release checks", text_elements: [] },
      ],
      createdAt: 1,
      pausedReason: null,
    },
  ]);
  assert.deepEqual(
    runtime.getSnapshot().queuedSubmissions.map((submission) => ({
      id: submission.serverSubmissionId,
      preview: submission.preview,
      state: submission.state,
    })),
    [
      {
        id: "queue-one",
        preview: "Run the release checks",
        state: "queued",
      },
    ],
  );
  runtime.dispose();
});

test("queued submissions support optimistic edit, reorder, steer, pause, resume, and delete", async () => {
  const calls: string[] = [];
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands({
      async updateQueuedSubmission(_key, id, input) {
        calls.push(`update:${id}`);
        return {
          id,
          clientUserMessageId: `client-${id}`,
          input: [...input],
          createdAt: 1,
          pausedReason: null,
        };
      },
      async reorderQueuedSubmissions(_key, ids) {
        calls.push(`reorder:${ids.join(",")}`);
      },
      async steerQueuedSubmission(_key, submission) {
        calls.push(`steer:${submission.id}`);
        return asTurnId("turn-steered");
      },
      async interrupt() {
        calls.push("interrupt");
      },
      async startQueuedSubmission(_key, id) {
        calls.push(`start:${id ?? "first"}`);
        return asTurnId("turn-resumed");
      },
      async deleteQueuedSubmission(_key, id) {
        calls.push(`delete:${id}`);
        return true;
      },
    }),
    history: { async loadOlder() {} },
  });
  runtime.replaceQueuedSubmissions([
    {
      id: "one",
      clientUserMessageId: "client-one",
      input: [{ type: "text", text: "One", text_elements: [] }],
      createdAt: 1,
      pausedReason: null,
    },
    {
      id: "two",
      clientUserMessageId: "client-two",
      input: [{ type: "text", text: "Two", text_elements: [] }],
      createdAt: 2,
      pausedReason: null,
    },
  ]);

  await runtime.updateQueuedSubmission("one", [
    { type: "text", text: "Edited one", text_elements: [] },
  ]);
  assert.equal(
    runtime.getSnapshot().queuedSubmissions[0]?.preview,
    "Edited one",
  );
  await runtime.reorderQueuedSubmissions(["two", "one"]);
  assert.deepEqual(
    runtime
      .getSnapshot()
      .queuedSubmissions.map((item) => item.serverSubmissionId),
    ["two", "one"],
  );
  await runtime.steerQueuedSubmission("two");
  assert.deepEqual(
    runtime
      .getSnapshot()
      .queuedSubmissions.map((item) => item.serverSubmissionId),
    ["one"],
  );
  await runtime.interrupt(asTurnId("turn-one"));
  await runtime.startQueuedSubmission();
  runtime.replaceQueuedSubmissions([
    {
      id: "one",
      clientUserMessageId: "client-one",
      input: [{ type: "text", text: "Edited one", text_elements: [] }],
      createdAt: 1,
      pausedReason: null,
    },
  ]);
  await runtime.deleteQueuedSubmission("one");
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
  assert.deepEqual(calls, [
    "update:one",
    "reorder:two,one",
    "steer:two",
    "interrupt",
    "start:first",
    "delete:one",
  ]);
  runtime.dispose();
});

test("runtime rejects SubmitIntents for another Host or Thread", async () => {
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands(),
    history: { async loadOlder() {} },
  });
  await assert.rejects(
    runtime.submit({
      commandId: "wrong-command",
      clientMessageId: "wrong-message",
      target: {
        type: "existing-thread",
        key: createConversationKey("ssh:other", "thread-one"),
      },
      document: {
        version: 1,
        blocks: [
          {
            type: "paragraph",
            children: [{ type: "text", text: "Wrong host" }],
          },
        ],
      },
      attachments: [],
      context: [],
      selections: {},
      options: { autoContext: true },
      createdAt: 1,
    }),
    /different Conversation/,
  );
  runtime.dispose();
});

test("interrupt exposes an interrupting transition around the command", async () => {
  let release!: () => void;
  const responses: unknown[] = [];
  const command = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands({
      respond: async (_key, response) => {
        responses.push(response);
      },
      interrupt: async () => command,
    }),
    history: { async loadOlder() {} },
  });
  const operation = runtime.interrupt(asTurnId("turn-one"));
  assert.equal(runtime.getSnapshot().activeTurn?.status, "interrupting");
  release();
  await operation;
  assert.deepEqual(responses, [
    { type: "command-approval", requestId: "request-one", decision: "decline" },
  ]);
  assert.equal(runtime.getSnapshot().activeTurn?.status, "streaming");
  runtime.dispose();
});
