import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshCheckpointStore } from "../apps/local-agent-host/src/dsh-checkpoint-store.mjs";
import { recoverDshGeneration } from "../apps/local-agent-host/src/dsh-generation-recovery.mjs";
import { createSurfaceCheckpoint } from "../apps/local-agent-host/src/hypernode/surface-checkpoint.mjs";
import { isSurfaceEvent } from "../runtime/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";
const projection = createSurfaceCheckpoint(isSurfaceEvent);
const source = { id: "s", header: { id: "s" }, events: [{ type: "user/message", seq: 0, time: 1, surfaceOp: "append",
  data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "fixture" }] } }], surface: { nodes: [0] } };
test("after native persistence but before checkpoint commit, restart resumes the exact prepared seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-orphan-recovery-"));
  try {
    const store = new DshCheckpointStore(root, projection);
    await store.capture("s", source, 0, async () => {});
    const input = { logicalSessionId: "s", sourceSessionId: "s", cwd: "/", provider: "p", model: "m" };
    let persisted, creates = 0, resumes = 0, fail = true;
    const handle = () => ({ agent: { session: persisted }, dispose: async () => {} });
    const ports = {
      readTail: async () => [],
      readExisting: async () => persisted ? { events: structuredClone(persisted.events) } : null,
      create: async prepared => {
        creates++;
        persisted = { id: prepared.sessionId, header: { id: prepared.sessionId }, events: prepared.seed,
          surface: { nodes: prepared.seed.filter(isSurfaceEvent).map(event => event.seq) } };
        return handle();
      },
      resume: async () => { resumes++; return handle(); },
      flush: async () => { if (fail) { fail = false; throw new Error("process lost before checkpoint"); } },
      publish: async () => {},
    };
    await assert.rejects(recoverDshGeneration(store, input, ports), /process lost/);
    assert.ok(await store.readIntent("s"));
    const afterRestart = new DshCheckpointStore(root, projection);
    const recovered = await recoverDshGeneration(afterRestart, input, ports);
    assert.equal(recovered.sessionId, "s.g1");
    assert.equal(creates, 1);
    assert.equal(resumes, 1);
    assert.equal(await afterRestart.readIntent("s"), null);
    assert.equal((await afterRestart.read("s")).sourceSessionId, "s.g1");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("an orphan with a different seed cannot be adopted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-orphan-mismatch-"));
  try {
    const store = new DshCheckpointStore(root, projection);
    await store.capture("s", source, 0, async () => {});
    let creates = 0;
    await assert.rejects(recoverDshGeneration(store, { logicalSessionId: "s", sourceSessionId: "s" }, {
      readTail: async () => [], readExisting: async () => ({ events: [] }),
      create: async () => { creates++; }, resume: async () => { throw new Error("must not resume"); },
    }), /differs/);
    assert.equal(creates, 0);
    assert.equal((await store.read("s")).sourceSessionId, "s");
  } finally { await rm(root, { recursive: true, force: true }); }
});
