import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handOffLegacyQueue } from "../../apps/opencraft-daemon/src/codex-legacy-handoff.js";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";

test("inputs queued in the local Host move to the Host queue in order, once, even if a handoff is interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-handoff-"));
  try {
    assert.deepEqual(await handOffLegacyQueue(directory, { request: async () => ({}) }), { moved: 0, uncertain: 0 });
    const legacy = new OpenCraftHostQueue(directory);
    legacy.add("thread-a", "first", [{ type: "text", text: "one" }]);
    legacy.add("thread-a", "second", [{ type: "text", text: "two" }]);
    legacy.add("thread-b", "third", [{ type: "text", text: "three" }]);
    legacy.close();

    const added: unknown[] = [];
    let failOn: string | undefined = "second";
    const clients = {
      request: async (method: string, params: Record<string, unknown>) => {
        assert.equal(method, "thread/queue/add");
        if (params.clientUserMessageId === failOn) throw new Error("Host unavailable");
        added.push([params.threadId, params.clientUserMessageId, params.input]);
        return {};
      },
    };
    await assert.rejects(handOffLegacyQueue(directory, clients), /Host unavailable/);
    failOn = undefined;
    assert.deepEqual(await handOffLegacyQueue(directory, clients), { moved: 2, uncertain: 0 });
    assert.deepEqual(added, [
      ["thread-a", "first", [{ type: "text", text: "one" }]],
      ["thread-a", "second", [{ type: "text", text: "two" }]],
      ["thread-b", "third", [{ type: "text", text: "three" }]],
    ]);
    assert.deepEqual(await handOffLegacyQueue(directory, clients), { moved: 0, uncertain: 0 }, "nothing is sent twice");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
