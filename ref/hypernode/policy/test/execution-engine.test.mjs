import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionEngineService } from "../src/services/execution-engine.ts";

test("execution engine port delegates the full DSH lifecycle without leaking its adapter", () => {
  const calls = [];
  const adapter = {
    supports: (profile) => profile.engineKind === "dsh",
    hasThread: (threadId) => threadId === "thread-1",
    retireThread: (threadId) => {
      calls.push(["retire", threadId]);
      return true;
    },
    prepareThread: (input) => {
      calls.push(["prepare", input]);
      return { workerId: "worker-1" };
    },
    startTurn: (input) => {
      calls.push(["start", input]);
      return { turnId: "turn-1" };
    },
    steer: (input) => calls.push(["steer", input]),
    interrupt: (input) => calls.push(["interrupt", input]),
  };
  const service = Object.create(ExecutionEngineService.prototype);
  service.ctx = { dshEngineAdapter: adapter };
  const profile = { engineKind: "dsh", fingerprint: "profile-1" };
  const preparation = {
    threadId: "thread-1",
    profile,
    credential: null,
    filesystem: {},
    viewId: "main",
    cwd: "/workspace/projects/repo",
  };
  const control = {
    connection: { id: "connection-1" },
    threadId: "thread-1",
    message: { id: 1, method: "turn/interrupt", params: {} },
  };

  assert.equal(service.supports(profile), true);
  assert.equal(service.hasThread("thread-1"), true);
  assert.deepEqual(service.prepareThread(preparation), { workerId: "worker-1" });
  assert.deepEqual(service.startTurn({ ...preparation, ...control }), { turnId: "turn-1" });
  service.steer(control);
  service.interrupt(control);
  assert.equal(service.retireThread("thread-1"), true);

  assert.deepEqual(calls.map(([kind]) => kind), [
    "prepare",
    "start",
    "steer",
    "interrupt",
    "retire",
  ]);
});
