import test from "node:test";
import assert from "node:assert/strict";
import { privateWorkspaceExecutionPolicy } from "../../apps/codex-core/src/workspace-execution-policy";
test("private workspace routing preserves execution health fences on other native commands", async () => {
  let guards = 0;
  const policy = privateWorkspaceExecutionPolicy({
    socketPath: "/synthetic/not-connected.sock",
    token: "synthetic".repeat(8),
    readThread: async () => null,
    nativeRequest: async () => null,
    assertExecutable: async () => {
      guards++;
      throw Error("execution fenced");
    },
  });
  for (const method of ["turn/steer", "command/exec", "process/spawn", "fs/writeFile"])
    await assert.rejects(policy(method, {}), /execution fenced/);
  assert.equal(guards, 4);
  const read = { threadId: "retained" };
  assert.equal(await policy("thread/read", read), read);
  assert.equal(guards, 4);
});
