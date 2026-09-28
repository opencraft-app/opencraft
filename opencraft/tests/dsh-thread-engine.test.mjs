import assert from "node:assert/strict";
import test from "node:test";
import { forkSeed, requireThreadWorkspaceCwd } from "../apps/local-agent-host/src/dsh-thread-engine.mjs";

test("native Thread creation requires an explicit workspace cwd", () => {
  assert.equal(requireThreadWorkspaceCwd("/workspace/project"), "/workspace/project");
  assert.throws(() => requireThreadWorkspaceCwd(undefined), /explicit workspace cwd/);
  assert.throws(() => requireThreadWorkspaceCwd("  "), /explicit workspace cwd/);
});
test("fork history keeps exact provider state, cuts at complete turns and balances only the child tail", () => {
  const events = [
    { type: "turn/start", seq: 0, data: { turn: 1 } },
    { type: "assistant/message", seq: 1, data: { replayState: { exact: "opaque" } } },
    { type: "turn/end", seq: 2, data: { turn: 1 } },
    { type: "turn/start", seq: 3, data: { turn: 2 } },
  ];
  const seed = forkSeed(events, { lastTurn: 1 }, () => []);
  assert.equal(seed.length, 3); assert.deepEqual(seed[1], events[1]);
  assert.throws(() => forkSeed(events, { lastTurn: 2 }, () => []), /in progress/);
  const full = forkSeed(events, {}, () => [{ type: "turn/end", seq: 4, data: { interrupted: true } }]);
  assert.equal(full.length, 5); assert.equal(events.length, 4);
  assert.equal(forkSeed(events, { beforeTurn: 2 }, () => []).length, 3);
});
