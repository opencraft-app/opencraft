import assert from "node:assert/strict";
import test from "node:test";

import { DshAppServerProjectionService } from "../src/services/dsh-appserver-projection.ts";
import { ShellCommandClassifierService } from "../src/services/shell-command-classifier.js";
import { TurnManagerService } from "../src/services/turn-manager.ts";

function fixture() {
  const canonicalFacts = [];
  const notifications = [];
  const service = Object.create(DshAppServerProjectionService.prototype);
  const shellCommandClassifier = Object.create(ShellCommandClassifierService.prototype);
  service.ctx = {
    appServerProjection: {
      broadcast(method, params, source) {
        canonicalFacts.push({ method, params, source });
        notifications.push({ method, params });
      },
    },
    turnManager: {
      appendItem(record, item) {
        record.itemLedger ??= [];
        if (!record.itemLedger.some((candidate) => candidate.id === item.id)) {
          record.itemLedger.push(item);
        }
        return item;
      },
    },
    shellCommandClassifier,
  };
  const record = {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", items: [] },
    itemLedger: [],
  };
  const active = { record };
  const worker = { threadId: "thread-1" };
  service.begin(active, { cwd: "/workspace/projects/demo" });
  return { active, canonicalFacts, notifications, record, service, worker };
}

test("DSH bash lifecycle projects a native command item with a protocol-safe id", () => {
  const { active, canonicalFacts, notifications, record, service, worker } = fixture();

  service.handle(worker, active, {
    type: "tool/call",
    seq: 7,
    time: 1_000,
    data: {
      callId: "exec_command:0",
      name: "bash",
      arguments: JSON.stringify({ command: "printf hello" }),
    },
  });
  service.handle(worker, active, {
    type: "tool/result",
    seq: 8,
    time: 1_025,
    data: {
      message: {
        source: { callId: "exec_command:0" },
        content: [{ content: [{ type: "text", text: "hello" }], isError: false }],
      },
    },
  });

  assert.deepEqual(notifications.map((entry) => entry.method), [
    "item/started",
    "item/commandExecution/outputDelta",
    "item/completed",
  ]);
  assert.deepEqual(
    canonicalFacts.map(({ method, source }) => ({ method, source })),
    notifications.map(({ method }) => ({ method, source: { engine: "dsh", kind: "execution" } })),
  );
  const started = notifications[0].params.item;
  assert.equal(started.type, "commandExecution");
  assert.match(started.id, /^[A-Za-z0-9_-]+$/);
  assert.equal(started.command, "printf hello");
  assert.equal(started.cwd, "/workspace/projects/demo");
  assert.deepEqual(started.commandActions, [{
    type: "unknown",
    command: "printf hello",
  }]);
  const completed = notifications[2].params.item;
  assert.equal(completed.status, "completed");
  assert.equal(completed.aggregatedOutput, "hello");
  assert.equal(completed.exitCode, 0);
  assert.equal(completed.durationMs, 25);
  assert.deepEqual(record.itemLedger, [completed]);
});

test("DSH command execution projects Codex-native search/read/list semantics", () => {
  for (const [command, expected] of [
    ["rg -n TODO src", [{
      type: "search", command: "rg -n TODO src", query: "TODO", path: "src",
    }]],
    ["cat README.md", [{
      type: "read", command: "cat README.md", name: "README.md",
      path: "/workspace/projects/demo/README.md",
    }]],
    ["rg --files src", [{
      type: "listFiles", command: "rg --files src", path: "src",
    }]],
  ]) {
    const { active, notifications, service, worker } = fixture();
    service.handle(worker, active, {
      type: "tool/call", seq: 1, time: 1_000,
      data: { callId: `call-${command}`, name: "bash", arguments: { command } },
    });
    assert.deepEqual(notifications[0].params.item.commandActions, expected);
  }
});

test("DSH jobs, goals, and skills project as durable dynamic tool items", () => {
  for (const [index, name] of ["job_list", "goal_create", "skill"].entries()) {
    const { active, notifications, record, service, worker } = fixture();
    const callId = `${name}:${index}`;
    service.handle(worker, active, {
      type: "tool/call",
      seq: index + 1,
      time: 2_000,
      data: { callId, name, arguments: JSON.stringify({ query: "demo" }) },
    });
    service.handle(worker, active, {
      type: "tool/result",
      seq: index + 2,
      time: 2_010,
      data: {
        message: {
          source: { callId },
          content: [{ content: [{ type: "text", text: `${name} ok` }], isError: false }],
        },
      },
    });

    const [started, completed] = notifications.map((entry) => entry.params.item);
    assert.equal(started.type, "dynamicToolCall");
    assert.equal(started.namespace, "deepseek-harness");
    assert.equal(started.tool, name);
    assert.deepEqual(started.arguments, { query: "demo" });
    assert.equal(completed.status, "completed");
    assert.equal(completed.success, true);
    assert.deepEqual(completed.contentItems, [{ type: "inputText", text: `${name} ok` }]);
    assert.deepEqual(record.itemLedger, [completed]);
  }
});

test("DSH todo and goal snapshots project onto the native turn plan", () => {
  const { active, notifications, record, service, worker } = fixture();

  service.handle(worker, active, {
    type: "todo/write",
    data: { todos: [
      { content: "Inspect", status: "completed" },
      { content: "Fix", status: "in_progress" },
      { content: "Verify", status: "pending" },
    ] },
  });
  service.handle(worker, active, {
    type: "goal/change",
    data: { goal: { objective: "Ship projection", phase: "active" } },
  });

  assert.deepEqual(notifications[0], {
    method: "turn/plan/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: null,
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Fix", status: "inProgress" },
        { step: "Verify", status: "pending" },
      ],
    },
  });
  assert.deepEqual(notifications[1].params.plan, [
    { step: "Ship projection", status: "inProgress" },
  ]);
  assert.deepEqual(record.plan, notifications[1].params.plan);
});

test("DSH dangling calls are failed deterministically before a turn closes", () => {
  const { active, notifications, service, worker } = fixture();
  service.handle(worker, active, {
    type: "tool/call",
    seq: 1,
    time: Date.now(),
    data: { callId: "job_output:1", name: "job_output", arguments: "{}" },
  });

  service.settle(worker, active);

  assert.equal(notifications.at(-1).method, "item/completed");
  assert.equal(notifications.at(-1).params.item.status, "failed");
  assert.equal(notifications.at(-1).params.item.success, false);
});

test("TurnManager persists projected DSH items in native order", () => {
  const changed = [];
  const thread = { status: { type: "active" }, updatedAt: 0, recencyAt: 0 };
  const service = Object.create(TurnManagerService.prototype);
  service.ctx = {
    threadManager: {
      get: () => thread,
      changed: (threadId) => changed.push(threadId),
    },
  };
  const record = {
    threadId: "thread-1",
    startedAtMs: Date.now(),
    turn: { id: "turn-1", status: "inProgress", items: [] },
    userItem: { id: "user-1", type: "userMessage", content: [] },
    itemLedger: [],
    agentItem: { id: "agent-1", type: "agentMessage", text: "done", phase: "final_answer" },
  };
  record.itemLedger = [
    record.userItem,
    { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
    {
      id: "dsh-1", type: "dynamicToolCall", tool: "skill", arguments: {},
      status: "completed", success: true,
    },
    record.agentItem,
  ];

  service.complete(record);

  assert.deepEqual(record.turn.items.map((item) => item.id), [
    "user-1", "reasoning-1", "dsh-1", "agent-1",
  ]);
  assert.deepEqual(changed, ["thread-1"]);
});

test("TurnManager exposes the live ordered ledger while a Turn is in progress", () => {
  const service = Object.create(TurnManagerService.prototype);
  const record = {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", items: [] },
    userItem: { id: "user-1", type: "userMessage", content: [] },
    itemLedger: [],
  };

  service.appendItem(record, record.userItem);
  const reasoning = {
    id: "reasoning-1", type: "reasoning", summary: [], content: [],
  };
  service.appendItem(record, reasoning);
  reasoning.content.push("still thinking");

  assert.strictEqual(record.turn.items, record.itemLedger);
  assert.deepEqual(record.turn.items.map((item) => item.id), [
    "user-1", reasoning.id,
  ]);
  assert.deepEqual(record.turn.items[1].content, ["still thinking"]);
});
