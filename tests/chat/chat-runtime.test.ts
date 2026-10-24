import assert from "node:assert/strict";
import test from "node:test";

import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";
import { createDefaultTimelineProjectorRegistry, asTurnId, createConversationKey, createTimelineTurnPresentationPlan, groupTimelineFramesByTurn, resolveAgentActivityLayout, timelineTurnRenderKey } from "@opencraft/chat-core";
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
      scope: "appserver-thread:local:thread-one",
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

  setAuthority(authoritative: boolean): void {
    this.value = { ...this.value, revision: this.value.revision + 1, authoritative, phase: authoritative ? "live" : "reconnecting" };
    for (const listener of this.listeners) listener();
  }

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
    async discardUnconfirmedSteer() {
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
      serviceTier: null,
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
      assert.equal(approval.title, "Allow this command to run?");
    }
    assert.equal(snapshot.history.cursor, "older:1");
    assert.equal(snapshot.history.hasOlder, true);
  } finally {
    runtime.dispose();
  }
});

test("replica approval prompts retain the reason and network destination without assuming a provider", () => {
  for (const [extra, title] of [
    [{}, "Allow this command to run?"],
    [{ reason: "Inspect the workspace" }, "Inspect the workspace"],
    [{ networkApprovalContext: { host: "api.example.com", protocol: "https" } }, "Allow a connection to https://api.example.com?"],
    [{ networkApprovalContext: { host: "api.example.com", protocol: "tcp" } }, "Allow a connection to api.example.com?"],
  ] as const) {
    const initial = threadView();
    const runtime = createReplicaConversationRuntime({
      key: createConversationKey("local", "thread-one"),
      replica: new FakeReplica({
        ...initial,
        pendingInteractions: initial.pendingInteractions.map(interaction => ({
          ...interaction, params: { ...interaction.params, ...extra },
        })),
      }),
      commands: commands(),
      history: { async loadOlder() {} },
    });
    try {
      const approval = runtime.getSnapshot().timeline.frames
        .flatMap(frame => frame.blocks).find(block => block.type === "approval");
      assert.equal(approval?.type, "approval");
      if (approval?.type === "approval") assert.equal(approval.title, title);
    } finally {
      runtime.dispose();
    }
  }
});

test("pending command approval derives one provisional Activity and authority replaces it", () => {
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
          cwd: "/opencraft",
          commandActions: [
            {
              type: "read",
              command: "cat package.json",
              name: "package.json",
              path: "/opencraft/package.json",
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
          path: "/opencraft/package.json",
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
                cwd: "/opencraft",
                processId: null,
                status: "completed",
                commandActions: [
                  {
                    type: "read",
                    command: "cat package.json",
                    name: "package.json",
                    path: "/opencraft/package.json",
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
            grantRoot: "/opencraft",
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
      ["patch"],
    );
    const turnDiff = runtime.getSnapshot().timeline.frames[0]?.changeSummary;
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

test("Replica diff updates leave active work open across later Items and restored runtimes", () => {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
  const work = [{ id: "progress", type: "agentMessage", phase: "commentary", text: "Progress", completed: true },
    { id: "command", type: "commandExecution", command: "test", status: "inProgress", completed: false }];
  const entity = (changes: string | null, later = false) => threadView({ pendingInteractions: [], turns: [{
    id: "active", status: "inProgress", turnStartedAtMs: 1000, firstTurnWorkItemStartedAtMs: 1100,
    diff: changes, unifiedDiff: diff, items: later ? [...work, { id: "later", type: "reasoning", summary: [], completed: false }] : work,
  }] });
  const replica = new FakeReplica(entity(null));
  const create = () => createReplicaConversationRuntime({ key: createConversationKey("local", "thread-one"), replica,
    commands: commands(), history: { async loadOlder() {} } });
  const runtime = create();
  const presentation = () => createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(runtime.getSnapshot().timeline)[0]!, undefined, { isMostRecentTurn: true });
  try {
    const initial = presentation();
    replica.setEntity(entity(diff));
    assert.deepEqual(presentation().assistant!.slots, initial.assistant!.slots);
    assert.equal(presentation().assistant!.changeSummary?.status, "running");
    replica.setEntity(entity(diff, true));
    const updated = presentation();
    const activity = updated.assistant!.slots.find(s => s.type === "agent-activity")!;
    if (activity.type === "agent-activity") assert.equal(resolveAgentActivityLayout(activity, true).isCollapsed, false);
    const restored = create();
    try { assert.deepEqual(createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(restored.getSnapshot().timeline)[0]!, undefined, { isMostRecentTurn: true }), updated); }
    finally { restored.dispose(); }
    replica.setEntity(entity(null, true));
    assert.equal(presentation().assistant!.changeSummary, null);
  } finally { runtime.dispose(); }
});

test("Turn diff remains reviewable without an assistant Item, including clear and restore", () => {
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new";
  const user = { id: "resource-user", type: "userMessage", content: [{ type: "text", text: "Update files" }] };
  const answer = { id: "resource-answer", type: "agentMessage", phase: "final_answer", text: "Done" };
  for (const status of ["inProgress", "completed", "interrupted", "failed"]) {
    for (const items of [[], [user], [user, answer]]) {
      const entity = (changes: string | null) => threadView({ pendingInteractions: [], turns: [{
        id: "turn-one", status, error: null, diff: changes, items,
      }] });
      const replica = new FakeReplica(entity(diff));
      const create = () => createReplicaConversationRuntime({ key: createConversationKey("local", "thread-one"), replica,
        commands: commands(), history: { async loadOlder() {} } });
      const runtime = create();
      const presentation = () => {
        const turn = groupTimelineFramesByTurn(runtime.getSnapshot().timeline)[0];
        return turn ? createTimelineTurnPresentationPlan(turn, undefined, { isMostRecentTurn: true }) : null;
      };
      try {
        const initial = presentation();
        assert.ok(initial);
        assert.equal(initial.assistant?.changeSummary?.unifiedDiff, diff, `${status} with ${items.length} native Items retains its Turn resource`);
        assert.equal(initial.userFrames.length, items.length ? 1 : 0);
        assert.equal(initial.assistantFrame?.blocks.some(block => block.type === "turn-diff"), false);
        const restored = create();
        try { assert.deepEqual(createTimelineTurnPresentationPlan(groupTimelineFramesByTurn(restored.getSnapshot().timeline)[0]!,
          undefined, { isMostRecentTurn: true }), initial); }
        finally { restored.dispose(); }
        replica.setEntity(entity(null));
        assert.equal(presentation()?.assistant?.changeSummary ?? null, null);
        replica.setEntity(entity(diff));
        assert.equal(presentation()?.assistant?.changeSummary?.id, initial.assistant?.changeSummary?.id);
      } finally { runtime.dispose(); }
    }
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

test("commandExecution commandActions become stable activity rows sharing source identity and reviews", () => {
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
              cwd: "/opencraft",
              status: "completed",
              commandActions: [
                {
                  type: "read",
                  command: "cat package.json",
                  name: "package.json",
                  path: "/opencraft/package.json",
                },
                {
                  type: "search",
                  command: "rg vite src",
                  query: "vite",
                  path: "/opencraft/src",
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
            cwd: "/opencraft",
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
          block.type === "setup-step" ||
          block.type === "setup-context-picker",
      );
    assert.deepEqual(
      interactions.map((block) => block.type),
      [
        "question",
        "setup-step",
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

test("older Codex Hosts automatically continue capacity failures after a delay", async () => {
  let calls = 0;
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(failedConversation()),
    canAutoContinueCapacity: () => true,
    commands: commands({ async continueTurn() { calls++; return receipt("capacity-retry", "capacity-message"); } }),
    history: { async loadOlder() {} },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(calls, 0);
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(calls, 1);
    assert.equal(runtime.getSnapshot().continuation.turnId, null);
  } finally { runtime.dispose(); }
});

test("a Host-owned capacity retry capability suppresses the client timer", async () => {
  let calls = 0;
  let hostOwnsRetry = true;
  const replica = new FakeReplica(failedConversation());
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"), replica,
    canAutoContinueCapacity: () => !hostOwnsRetry,
    commands: commands({ async continueTurn() { calls++; return receipt("capacity-retry", "capacity-message"); } }),
    history: { async loadOlder() {} },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(calls, 0);
    hostOwnsRetry = false;
    replica.setEntity(failedConversation());
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(calls, 1);
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

test("outgoing bubble remains mounted while Turn acknowledgement arrives before its user Item", async () => {
  let resolveSubmission!: (receipt: SubmissionReceipt) => void;
  const pending = new Promise<SubmissionReceipt>((resolve) => { resolveSubmission = resolve; });
  const replica = new FakeReplica(threadView({ turns: [], pendingInteractions: [] }));
  const key = createConversationKey("local", "thread-one");
  const runtime = createReplicaConversationRuntime({
    key,
    replica,
    commands: commands({ submit: async () => pending }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController(
    { type: "existing-thread", key },
    { now: () => 100, createId: () => "handoff" },
  );
  composer.dispatch({
    type: "set-document",
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Hello" }] }] },
  });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  const visibleIdentity = () => {
    const timeline = runtime.getSnapshot().timeline;
    const messages = timeline.frames.flatMap((frame) => frame.blocks)
      .filter((block) => block.type === "user-message" && block.message === "Hello");
    assert.equal(messages.length, 1, "the outgoing bubble must never disappear or duplicate");
    const frame = timeline.frames.find((candidate) => candidate.blocks.includes(messages[0]!));
    assert.ok(frame);
    const turn = groupTimelineFramesByTurn(timeline).find((candidate) => candidate.turnId === frame.turnId);
    assert.ok(turn);
    return { blockId: messages[0]!.id, frameId: frame.id, renderKey: timelineTurnRenderKey(turn) };
  };
  const optimistic = visibleIdentity();
  resolveSubmission(receipt(intent.commandId, intent.clientMessageId));
  await operation;
  assert.deepEqual(visibleIdentity(), optimistic, "the RPC receipt must not remount the bubble");
  assert.equal(groupTimelineFramesByTurn(runtime.getSnapshot().timeline)[0]?.turnKey, "turn-two",
    "the navigation and measurement locator remains the authoritative Turn ID");

  replica.setEntity(threadView({ turns: [{ id: "turn-two", status: "inProgress", items: [] }], pendingInteractions: [] }));
  assert.deepEqual(visibleIdentity(), optimistic, "an empty acknowledged Turn must keep the optimistic bubble");

  replica.setEntity(threadView({ turns: [{ id: "turn-two", status: "inProgress", params: {
    clientUserMessageId: intent.clientMessageId,
  }, items: [] }], pendingInteractions: [] }));
  assert.deepEqual(visibleIdentity(), optimistic, "a client ID without message content is not a display acknowledgement");

  const params = { clientUserMessageId: intent.clientMessageId, input: [{ type: "text", text: "Hello" }] };
  replica.setEntity(threadView({ turns: [{ id: "turn-two", status: "inProgress", params, items: [] }], pendingInteractions: [] }));
  assert.deepEqual(visibleIdentity(), optimistic, "Turn.params must inherit the same display identity");

  replica.setEntity(threadView({ turns: [{ id: "turn-two", status: "inProgress", items: [{
    id: "user-two", type: "userMessage", clientId: intent.clientMessageId,
    content: [{ type: "text", text: "Hello" }],
  }] }], pendingInteractions: [] }));
  assert.deepEqual(visibleIdentity(), optimistic, "an Item-only snapshot must keep the same display identity");

  replica.setEntity(threadView({ turns: [{ id: "turn-two", status: "inProgress", params, items: [{
    id: "user-two", type: "userMessage", clientId: intent.clientMessageId,
    content: [{ type: "text", text: "Hello" }],
  }] }], pendingInteractions: [] }));
  assert.deepEqual(visibleIdentity(), optimistic, "the authoritative Item must not remount the bubble");
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

test("strict queue steer transfers presentation immediately while Host admission is pending", async () => {
  let resolveSteer!: (turnId: ReturnType<typeof asTurnId>) => void;
  const pendingSteer = new Promise<ReturnType<typeof asTurnId>>((resolve) => {
    resolveSteer = resolve;
  });
  const replica = new FakeReplica(threadView({ pendingInteractions: [] }));
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands({ steerQueuedSubmission: async () => pendingSteer }),
    history: { async loadOlder() {} },
  });
  runtime.replaceQueuedSubmissions([{
    id: "queued-steer",
    clientUserMessageId: "queued-steer-client",
    input: [{ type: "text", text: "Change direction", text_elements: [] }],
    createdAt: 100,
    pausedReason: null,
  }]);

  const operation = runtime.steerQueuedSubmission("queued-steer");
  const countSteers = () => runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message" && block.message === "Change direction").length;
  assert.deepEqual(runtime.getSnapshot().queuedSubmissions, []);
  assert.equal(countSteers(), 1);

  resolveSteer(asTurnId("turn-one"));
  await operation;
  assert.equal(countSteers(), 1);
  runtime.dispose();
});

test("authoritative steering baseline survives refresh and hands off once to durable history", () => {
  const replica = new FakeReplica(threadView({ pendingInteractions: [] }));
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica,
    commands: commands(),
    history: { async loadOlder() {} },
  });
  const countSteers = () => runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .filter((block) => block.type === "user-message" && block.message === "Persist this steer").length;

  runtime.replaceQueuedSubmissions([], [{
    id: "steering-one",
    clientUserMessageId: "steering-client-one",
    input: [{ type: "text", text: "Persist this steer", text_elements: [] }],
    createdAt: 101,
    pausedReason: null,
    targetTurnId: "turn-one",
  }]);
  assert.equal(countSteers(), 1);

  replica.setEntity(threadView({
    pendingInteractions: [],
    turns: [{
      id: "turn-one",
      status: "inProgress",
      startedAt: 1_728_000_000,
      params: { clientUserMessageId: "client-user-one", input: [{ type: "text", text: "Run tests" }] },
      items: [
        { id: "user-one", type: "userMessage", clientId: "client-user-one", content: [{ type: "text", text: "Run tests" }] },
        { id: "assistant-one", type: "agentMessage", text: "Running them." },
        { id: "durable-steer", type: "userMessage", clientId: "steering-client-one", content: [{ type: "text", text: "Persist this steer" }] },
      ],
    }],
  }));
  assert.equal(countSteers(), 1);

  runtime.replaceQueuedSubmissions([], []);
  assert.equal(countSteers(), 1);
  runtime.dispose();
});

test("a restarted Host steering claim is shown as unconfirmed, not sent", () => {
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView({ pendingInteractions: [] })),
    commands: commands(),
    history: { async loadOlder() {} },
  });
  runtime.replaceQueuedSubmissions([], [{
    id: "uncertain-steer",
    clientUserMessageId: "uncertain-client",
    input: [{ type: "text", text: "Maybe delivered", text_elements: [] }],
    createdAt: 101,
    pausedReason: "steer-delivery-unconfirmed",
    targetTurnId: "turn-one",
  }]);
  const message = runtime.getSnapshot().timeline.frames
    .flatMap((frame) => frame.blocks)
    .find((block) => block.type === "user-message" && block.message === "Maybe delivered");
  assert.equal(message?.type === "user-message" && message.deliveryStatus, "unknown");
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
  assert.equal(runtime.getSnapshot().timeline.frames.flatMap((frame) => frame.blocks)
    .some((block) => block.type === "user-message" && block.message === "Next"), false);
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
  assert.equal(runtime.getSnapshot().timeline.frames.flatMap((frame) => frame.blocks)
    .some((block) => block.type === "user-message" && block.message === "Next"), false);
  runtime.dispose();
});

for (const lostAck of [false, true]) test(`late queue admission ${lostAck ? "failure" : "success"} does not resurrect an entry already observed and consumed`, async () => {
  const key = createConversationKey("local", "thread-one");
  let accept!: (receipt: SubmissionReceipt) => void;
  let reject!: (error: Error) => void;
  const runtime = createReplicaConversationRuntime({
    key, replica: new FakeReplica(threadView()),
    commands: commands({ submit: () => new Promise((resolve, fail) => { accept = resolve; reject = fail; }) }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "late-queue" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Next" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 1, "queue paints before the RPC resolves");
  runtime.replaceQueuedSubmissions([{
    id: "server-next", clientUserMessageId: intent.clientMessageId,
    input: [{ type: "text", text: "Next", text_elements: [] }], createdAt: 101, pausedReason: null,
  }]);
  runtime.replaceQueuedSubmissions([]);
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
  if (lostAck) {
    reject(new SubmissionOutcomeUnknownError());
    await assert.rejects(operation, SubmissionOutcomeUnknownError);
  } else {
    accept({ commandId: intent.commandId, clientMessageId: intent.clientMessageId,
      hostId: "local", threadId: "thread-one", turnId: null, acceptedAt: 102, replayed: false });
    await operation;
  }
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0, "a late ACK cannot bring the consumed row back");
  runtime.dispose();
});

test("deleting a failed local follow-up removes it without a Host queue request", async () => {
  const key = createConversationKey("local", "thread-one");
  let hostDeletes = 0;
  const runtime = createReplicaConversationRuntime({
    key,
    replica: new FakeReplica(threadView()),
    commands: commands({
      async submit() { throw new Error("Model unavailable"); },
      async deleteQueuedSubmission() { hostDeletes += 1; return true; },
    }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "failed-follow-up" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Next" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(intent), /Model unavailable/);
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.state, "failed");
  await runtime.deleteQueuedSubmission(intent.commandId);
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
  assert.equal(hostDeletes, 0);
  runtime.dispose();
});

test("an unconfirmed follow-up cannot be dismissed or deleted before Host reconciliation", async () => {
  const key = createConversationKey("local", "thread-one");
  let submits = 0;
  let hostDeletes = 0;
  const runtime = createReplicaConversationRuntime({
    key,
    replica: new FakeReplica(threadView()),
    commands: commands({
      async submit() { submits += 1; throw new SubmissionOutcomeUnknownError(); },
      async deleteQueuedSubmission() { hostDeletes += 1; return true; },
    }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "unknown-follow-up" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Next" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(intent), SubmissionOutcomeUnknownError);
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.state, "unknown");
  runtime.dismissFailedSubmission(intent.commandId);
  await assert.rejects(runtime.deleteQueuedSubmission(intent.commandId), /not deletable/);
  await assert.rejects(runtime.submit(intent), SubmissionOutcomeUnknownError);
  assert.equal(submits, 1);
  assert.equal(hostDeletes, 0);
  runtime.replaceQueuedSubmissions([{
    id: "server-follow-up",
    clientUserMessageId: intent.clientMessageId,
    input: [{ type: "text", text: "Next", text_elements: [] }],
    createdAt: 101,
    pausedReason: null,
  }]);
  assert.deepEqual(runtime.getSnapshot().queuedSubmissions.map((item) => [item.serverSubmissionId, item.state]),
    [["server-follow-up", "queued"]]);
  runtime.replaceQueuedSubmissions([]);
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
  runtime.dispose();
});

test("an unconfirmed follow-up retires when its client message appears in authoritative history", async () => {
  const key = createConversationKey("local", "thread-one");
  const replica = new FakeReplica(threadView());
  const runtime = createReplicaConversationRuntime({
    key, replica,
    commands: commands({ async submit() { throw new SubmissionOutcomeUnknownError(); } }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "unknown-follow-up" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Next" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  await assert.rejects(runtime.submit(intent), SubmissionOutcomeUnknownError);
  replica.setEntity(threadView({ turns: [{ id: "confirmed", status: "inProgress", items: [
    { id: "confirmed-user", type: "userMessage", clientId: intent.clientMessageId, content: [{ type: "text", text: "Next" }] },
  ] }] }));
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
  runtime.dispose();
});

test("Host queue acknowledgement arriving before a lost receipt does not leave a local unknown claim", async () => {
  const key = createConversationKey("local", "thread-one");
  let rejectReceipt!: (error: Error) => void;
  const runtime = createReplicaConversationRuntime({
    key,
    replica: new FakeReplica(threadView()),
    commands: commands({ submit: () => new Promise((_resolve, reject) => { rejectReceipt = reject; }) }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "racing-follow-up" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [
    { type: "paragraph", children: [{ type: "text", text: "Next" }] },
  ] } });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  runtime.replaceQueuedSubmissions([{
    id: "server-follow-up", clientUserMessageId: intent.clientMessageId,
    input: [{ type: "text", text: "Next", text_elements: [] }], createdAt: 101, pausedReason: null,
  }]);
  rejectReceipt(new SubmissionOutcomeUnknownError());
  await assert.rejects(operation, SubmissionOutcomeUnknownError);
  runtime.replaceQueuedSubmissions([]);
  assert.equal(runtime.getSnapshot().queuedSubmissions.length, 0);
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

test("unconfirmed steer can only be explicitly discarded with its claimed turn", async () => {
  const calls: string[] = [];
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands({
      async discardUnconfirmedSteer(_key, id, turnId) {
        calls.push(`${id}:${turnId}`);
        return true;
      },
    }),
    history: { async loadOlder() {} },
  });
  runtime.replaceQueuedSubmissions([], [{
    id: "claim-one",
    clientUserMessageId: "client-claim",
    input: [{ type: "text", text: "Maybe delivered", text_elements: [] }],
    createdAt: 1,
    pausedReason: "steer-delivery-unconfirmed",
    targetTurnId: "turn-one",
  }]);
  assert.deepEqual(runtime.getSnapshot().unconfirmedSteers.map((item) => item.id), ["claim-one"]);
  await assert.rejects(runtime.discardUnconfirmedSteer("claim-one", asTurnId("wrong-turn")));
  assert.deepEqual(calls, []);
  await runtime.discardUnconfirmedSteer("claim-one", asTurnId("turn-one"));
  assert.deepEqual(calls, ["claim-one:turn-one"]);
  assert.deepEqual(runtime.getSnapshot().unconfirmedSteers, []);
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
  const provenances: unknown[] = [];
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
      interrupt: async (_key, _turnId, provenance) => {
        provenances.push(provenance);
        return command;
      },
    }),
    history: { async loadOlder() {} },
  });
  const provenance = {
    source: "composer-stop" as const,
    trigger: "keyboard" as const,
    isTrusted: true,
    occurredAt: 1_234,
  };
  const operation = runtime.interrupt(asTurnId("turn-one"), provenance);
  assert.equal(runtime.getSnapshot().activeTurn?.status, "interrupting");
  release();
  await operation;
  assert.deepEqual(responses, [
    { type: "command-approval", requestId: "request-one", decision: "decline" },
  ]);
  assert.deepEqual(provenances, [provenance]);
  assert.equal(runtime.getSnapshot().activeTurn?.status, "streaming");
  runtime.dispose();
});


test("repeated stop shares acknowledgement and a rejection permits retry", async () => {
  let reject!: (error: Error) => void;
  let calls = 0;
  let command = new Promise<void>((_resolve, fail) => { reject = fail; });
  const runtime = createReplicaConversationRuntime({
    key: createConversationKey("local", "thread-one"),
    replica: new FakeReplica(threadView()),
    commands: commands({ interrupt: async () => { calls++; await command; } }),
    history: { async loadOlder() {} },
  });
  const first = runtime.interrupt(asTurnId("turn-one"));
  const second = runtime.interrupt(asTurnId("turn-one"));
  assert.equal(first, second);
  assert.equal(runtime.getSnapshot().activeTurn?.status, "interrupting");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  reject(new Error("synthetic rejection"));
  await assert.rejects(first, /synthetic rejection/);
  assert.equal(runtime.getSnapshot().activeTurn?.status, "streaming");
  command = Promise.resolve();
  await runtime.interrupt(asTurnId("turn-one"));
  assert.equal(calls, 2);
  runtime.dispose();
});


test("local sender paints immediately, survives acknowledgement and never attributes unrelated history", async () => {
  const key = createConversationKey("local", "thread-one");
  const replica = new FakeReplica(threadView({ turns: [], pendingInteractions: [] }));
  let name: string | null = "alice";
  let release!: (value: SubmissionReceipt) => void;
  let sentIntent: unknown;
  const runtime = createReplicaConversationRuntime({ key, replica,
    getSubmissionSender: () => name ? { kind: "employee", loginName: name } : null,
    commands: commands({ submit: intent => { sentIntent = intent; return new Promise(resolve => { release = resolve; }); } }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "existing-thread", key }, { now: () => 100, createId: () => "sender-submit" });
  composer.dispatch({ type: "set-document", document: {version: 1, blocks: [{ type: "paragraph", children: [{type: "text", text: "Hello"}] }] } });
  const intent = composer.createSubmitIntent();
  const operation = runtime.submit(intent);
  const messages = () => runtime.getSnapshot().timeline.frames.flatMap(f => f.blocks).filter(b => b.type === "user-message");
  assert.deepEqual(messages()[0]?.sender, {kind: "employee", loginName: "alice"}, "no RPC must finish before sender paints");
  assert.equal(sentIntent, intent, "display identity never enters the command payload");
  name = "bob";
  const item = {id: "user-two", type: "userMessage", clientId: intent.clientMessageId, content: [{type: "text", text: "Hello"}]};
  const history = {id: "old", type: "userMessage", clientId: "not-local", content: [{type: "text", text: "Old"}]};
  const update = (patch = {}, paramsPatch = {}) => replica.setEntity(threadView({pendingInteractions: [], turns: [{id: "turn-two", status: "inProgress", params: {clientUserMessageId: intent.clientMessageId, input: [{type: "text", text: "Hello"}], ...paramsPatch}, items: [{...item, ...patch}, history]}]}));
  update();
  assert.deepEqual(messages()[0]?.sender, {kind: "employee", loginName: "alice"}, "account change cannot rewrite the submitting identity");
  assert.equal(messages()[1]?.sender ?? null, null, "no account fallback on other messages");
  release({ ...receipt(intent.commandId, intent.clientMessageId), turnId: "turn-two" });
  await operation;
  assert.equal(runtime.getSnapshot().pendingSubmissions.length, 0);
  assert.deepEqual(messages()[0]?.sender, {kind: "employee", loginName: "alice"}, "acknowledgement does not remove the sender row");
  update({sender: {kind: "employee", loginName: "server"}});
  assert.deepEqual(messages()[0]?.sender, {kind: "employee", loginName: "server"}, "server attribution wins");
  update({sender: null});
  assert.equal(messages()[0]?.sender ?? null, null, "explicit server absence wins too");
  update({}, {sender: {kind: "employee", loginName: "params-server"}});
  assert.deepEqual(messages()[0]?.sender, {kind: "employee", loginName: "params-server"});
  update({}, {sender: null});
  assert.equal(messages()[0]?.sender ?? null, null, "explicit Turn sender absence wins over a local Item hint");
  runtime.dispose();
  const fresh = createReplicaConversationRuntime({key, replica, getSubmissionSender: () => ({kind: "employee", loginName: "bob"}), commands: commands(), history: {async loadOlder(){}}});
  assert.ok(fresh.getSnapshot().timeline.frames.flatMap(f => f.blocks).filter(b => b.type === "user-message").every(b => !b.sender), "reopen never labels historical messages with the current account");
  fresh.dispose();
});

test("queued authors retain submission-time hints until explicit server identity, including null, takes precedence", async () => {
  const key = createConversationKey("local", "thread-one");
  const replica = new FakeReplica(threadView({ turns: [], pendingInteractions: [] }));
  let name = "alice", release!: (value: SubmissionReceipt) => void;
  const runtime = createReplicaConversationRuntime({ key, replica,
    getSubmissionSender: () => ({ kind: "employee", loginName: name }),
    commands: commands({ submit: () => new Promise(resolve => { release = resolve; }) }),
    history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "enqueue-follow-up", key }, { now: () => 100, createId: () => "author-queue" });
  composer.dispatch({ type: "set-document", document: {version: 1, blocks: [{type: "paragraph", children: [{type: "text", text: "Queued by Alice"}]}]} });
  const intent = composer.createSubmitIntent(), pending = runtime.submit(intent);
  const authors = () => runtime.getSnapshot().queuedSubmissions.map(row => row.sender ?? null);
  assert.deepEqual(authors(), [{kind: "employee", loginName: "alice"}], "held queue admission paints the submitting employee immediately");
  name = "bob";
  release(receipt(intent.commandId, intent.clientMessageId)); await pending;
  assert.deepEqual(authors(), [{kind: "employee", loginName: "alice"}], "switching account does not relabel a pending queue");
  const row = {id: "server-queue", clientUserMessageId: intent.clientMessageId, input: [{type: "text" as const, text: "Queued by Alice", text_elements: []}], createdAt: 100, pausedReason: null};
  runtime.replaceQueuedSubmissions([row]);
  assert.deepEqual(authors(), [{kind: "employee", loginName: "alice"}], "matching acknowledgement preserves the exact-client hint");
  runtime.replaceQueuedSubmissions([{...row, sender: {kind: "employee", loginName: "verified"}}, {...row, id: "other", clientUserMessageId: "another-client"}]);
  assert.deepEqual(authors(), [{kind: "employee", loginName: "verified"}, null]);
  runtime.replaceQueuedSubmissions([{...row, sender: null}]); assert.deepEqual(authors(), [null]);
  runtime.dispose();
  const fresh = createReplicaConversationRuntime({ key, replica, getSubmissionSender: () => ({kind: "employee", loginName: "bob"}), commands: commands(), history: {async loadOlder(){}} });
  fresh.replaceQueuedSubmissions([row]); assert.equal(fresh.getSnapshot().queuedSubmissions[0]?.sender ?? null, null, "restored unknown queue never uses the current account");
  fresh.dispose();
});


test("tail updates reuse all completed historical frames and metadata-only updates reuse the timeline", () => {
  const turns = Array.from({ length: 500 }, (_, index) => ({
    id: `history-${index}`, status: "completed",
    items: [{ id: `answer-${index}`, type: "agentMessage", text: `answer ${index}` }],
  }));
  const entity = { turns, thread: { id: "thread-one", status: { type: "idle" } } };
  const replica = new FakeReplica(entity);
  const projectors = createDefaultTimelineProjectorRegistry();
  const project = projectors.project.bind(projectors);
  let projectedItems = 0;
  projectors.project = (...args) => { projectedItems++; return project(...args); };
  const runtime = createReplicaConversationRuntime({ key: createConversationKey("local", "thread-one"), replica, projectors, commands: commands(), history: { async loadOlder() {} } });
  assert.equal(projectedItems, 500);
  const before = runtime.getSnapshot().timeline;
  const tail = turns.at(-1)!;
  const next = { ...entity, turns: [...turns.slice(0, -1), { ...tail, items: [{ ...tail.items[0]!, text: "tail change" }] }] };
  projectedItems = 0;
  replica.setEntity(next);
  assert.equal(projectedItems, 1);
  assert.equal(runtime.getSnapshot().timeline.frames[0], before.frames[0]);
  const after = runtime.getSnapshot().timeline;
  projectedItems = 0;
  replica.setEntity({ ...next, notificationRevision: 42 });
  assert.equal(projectedItems, 0);
  assert.equal(runtime.getSnapshot().timeline.frames, after.frames);
  assert.equal(runtime.getSnapshot().timeline.anchorFrameIds, after.anchorFrameIds);
  const remove = projectors.register({ name: "changed-projection", priority: 999, itemTypes: ["agentMessage"], project: () => null });
  replica.setEntity({ ...next, notificationRevision: 43 });
  assert.equal(projectedItems, 500, "registry changes invalidate historical projections");
  remove(); runtime.dispose();
});


test("optional local outbox accepts disconnected input and drains only after Replica authority", async () => {
  const replica = new FakeReplica(threadView(), false);
  const key = createConversationKey("local", "thread-one");
  let rows: readonly import("@opencraft/chat-runtime").ConversationOutboxEntry[] = [];
  const calls: string[] = [];
  const runtime = createReplicaConversationRuntime({ key, replica,
    outbox: { read: () => rows, write: (_, next) => { rows = next; }, subscribe: () => () => {} },
    commands: commands({ async submit(intent) {
      calls.push(intent.clientMessageId);
      assert.equal(intent.target.type, "enqueue-follow-up");
      return { ...receipt(intent.commandId, intent.clientMessageId), turnId: null };
    } }), history: { async loadOlder() {} },
  });
  const composer = createComposerController({ type: "existing-thread", key }, { now: () => 1, createId: () => "offline" });
  composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "offline input" }] }] } });
  const accepted = await runtime.submit(composer.createSubmitIntent());
  assert.equal(accepted.disposition, "local-queue"); assert.equal(calls.length, 0);
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.local, true);
  replica.setAuthority(true); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [accepted.clientMessageId]); assert.equal(rows.length, 0);
  assert.equal(runtime.getSnapshot().queuedSubmissions.some(row => row.local), false);
  runtime.dispose();
});

test("queue-only confirmation of an outbox timeout automatically releases the next message", async () => {
  const replica = new FakeReplica(threadView(), false);
  const key = createConversationKey("local", "thread-one");
  let rows: readonly import("@opencraft/chat-runtime").ConversationOutboxEntry[] = [];
  const calls: string[] = [];
  const runtime = createReplicaConversationRuntime({ key, replica,
    outbox: { read: () => rows, write: (_, next) => { rows = next; }, subscribe: () => () => {} },
    commands: commands({ async submit(intent) {
      calls.push(intent.clientMessageId);
      if (calls.length === 1) throw new SubmissionOutcomeUnknownError();
      return { ...receipt(intent.commandId, intent.clientMessageId), turnId: null };
    } }), history: { async loadOlder() {} },
  });
  const make = (id: string) => {
    const composer = createComposerController({ type: "existing-thread", key }, { now: () => 1, createId: () => id });
    composer.dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: id }] }] } });
    return composer.createSubmitIntent();
  };
  const first = make("first"); const next = make("next");
  await runtime.submit(first); await runtime.submit(next);
  replica.setAuthority(true); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.getSnapshot().queuedSubmissions[0]?.state, "unknown");
  runtime.replaceQueuedSubmissions([{ id: "server-first", clientUserMessageId: first.clientMessageId,
    input: [{ type: "text", text: "first" }], createdAt: 1, pausedReason: null }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, [first.clientMessageId, next.clientMessageId]);
  assert.equal(rows.length, 0);
  assert.equal(runtime.getSnapshot().queuedSubmissions.some(row => row.local), false);
  runtime.dispose();
});
