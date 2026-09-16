import assert from "node:assert/strict";
import test from "node:test";

import { TransparentBackendPumpService } from "../src/services/transparent-backend-pump.ts";

function harness(drained) {
  const messages = [];
  const failures = [];
  let ticks = 0;
  const service = Object.create(TransparentBackendPumpService.prototype);
  service.ctx = { codexRuntimeAdapter: { tick: () => { ticks += 1; } } };
  const state = {
    processId: "runtime",
    stderr: [],
    filesystem: { drain: () => drained },
  };
  service.poll(state, {
    message: (message) => messages.push(message),
    failed: (reason) => failures.push(reason),
  });
  return { state, messages, failures, ticks };
}

test("backend pump parses JSONL frames and ignores process diagnostics", () => {
  const result = harness({
    stdoutLines: [
      "Codex diagnostic",
      JSON.stringify({ method: "thread/started", params: { thread: { id: "inner" } } }),
    ],
    stderrLines: ["warning"],
    exited: false,
  });
  assert.equal(result.ticks, 1);
  assert.deepEqual(result.messages, [{
    method: "thread/started",
    params: { thread: { id: "inner" } },
  }]);
  assert.deepEqual(result.state.stderr, ["warning"]);
  assert.deepEqual(result.failures, []);
});

test("backend pump reports drain failures and process exit exactly once", () => {
  const exited = harness({ exited: true, exitCode: 7, stderrLines: [] });
  assert.deepEqual(exited.failures, ["local Codex exited with 7"]);

  const service = Object.create(TransparentBackendPumpService.prototype);
  service.ctx = { codexRuntimeAdapter: { tick() {} } };
  const failures = [];
  service.poll({
    processId: "runtime",
    stderr: [],
    filesystem: { drain: () => { throw new Error("transport closed"); } },
  }, {
    message: assert.fail,
    failed: (reason) => failures.push(reason),
  });
  assert.deepEqual(failures, ["transport closed"]);
});
