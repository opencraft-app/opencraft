import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { codexContinuationService } from "../../apps/opencraft-daemon/src/codex-continuation-service.js";

/** A routing stand-in: one idle Thread whose latest turn is whatever the test says. */
function routing(latest: () => Record<string, unknown>) {
  const sent: [string, Record<string, unknown>][] = [];
  const broadcasts: [string, Record<string, unknown>][] = [];
  let goal: Record<string, unknown> | null = null;
  return {
    sent,
    broadcasts,
    setGoal: (value: Record<string, unknown> | null) => (goal = value),
    clients: {
      broadcast: (method: string, params: Record<string, unknown>) => void broadcasts.push([method, params]),
      request: async (method: string, params: Record<string, unknown>) => {
        sent.push([method, params]);
        switch (method) {
          case "thread/read":
            return { thread: { id: params.threadId, status: { type: "idle" } } };
          case "thread/queue/list":
            return { data: [], steering: [] };
          case "thread/goal/get":
            return { goal };
          case "thread/turns/list":
            return { data: [latest()], nextCursor: null };
          case "turn/start":
            return { turn: { id: "continued" } };
          default:
            return {};
        }
      },
    },
  };
}
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

test("a turn lost to a restart is continued once with an empty start; a stop someone asked for is not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-continuation-"));
  const route = routing(() => ({ id: "t1", status: "interrupted" }));
  const service = codexContinuationService({ directory, clients: route.clients, admissionOpen: () => true });
  try {
    service.notification!("turn/started", { threadId: "th", turn: { id: "t1" } });
    service.notification!("turn/completed", { threadId: "th", turn: { id: "t1", status: "interrupted" } });
    await until(() => route.sent.some(([method]) => method === "turn/start"), "continuation");
    const starts = route.sent.filter(([method]) => method === "turn/start");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]![1].input, []);
    assert.match(String(starts[0]![1].clientUserMessageId), /^restart-recovery:/);
    assert.ok(route.broadcasts.some(([method]) => method === "opencraft/turn-recovery/updated"));

    // A stop asked for by a client is the user's decision, not a lost execution.
    service.notification!("turn/started", { threadId: "other", turn: { id: "o1" } });
    service.beforeRoute!("turn/interrupt", { threadId: "other" });
    service.notification!("turn/completed", { threadId: "other", turn: { id: "o1", status: "interrupted" } });
    await delay(800);
    assert.equal(
      route.sent.filter(([method, params]) => method === "turn/start" && params.threadId === "other").length,
      0,
    );
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a provider-capacity failure is scheduled for retry and an active goal resumes after a clean turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-continuation-"));
  const route = routing(() => ({ id: "f1", status: "failed" }));
  const service = codexContinuationService({ directory, clients: route.clients, admissionOpen: () => true });
  try {
    service.notification!("turn/started", { threadId: "th", turn: { id: "f1" } });
    service.notification!("turn/completed", {
      threadId: "th",
      turn: { id: "f1", status: "failed", error: { message: "busy", codexErrorInfo: "serverOverloaded" } },
    });
    await until(
      () => (service.request("opencraft/turn-recovery/read", { threadId: "th" }, {} as never) as any).recovery !== null,
      "retry",
    );
    const notice = (service.request("opencraft/turn-recovery/read", { threadId: "th" }, {} as never) as any).recovery;
    assert.equal(notice.state, "scheduled");
    assert.equal(notice.reason, "provider-failure");
    assert.ok(notice.retryAt > Date.now(), "a retry waits for capacity");
    assert.equal(service.counts().capacityRetries, 1);

    route.setGoal({ status: "active" });
    service.notification!("thread/goal/updated", { threadId: "goal", goal: { status: "active" } });
    service.notification!("turn/completed", { threadId: "goal", turn: { id: "g1", status: "completed" } });
    await until(
      () => route.sent.some(([method, params]) => method === "thread/goal/set" && params.threadId === "goal"),
      "goal",
    );
    assert.deepEqual(route.sent.find(([method]) => method === "thread/goal/set")![1], {
      threadId: "goal",
      status: "active",
    });
    assert.equal(service.counts().activeGoals, 1);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
