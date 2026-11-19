import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.mjs";
import { profileFor } from "./helpers.mjs";
import { MemoryLearningModel } from "../src/adapters/models/memory-learning-model.mjs";
import { MemoryLearningCoordinator } from "../src/runtime/memory-learning-coordinator.mjs";
import { memoryModelInput } from "../src/adapters/models/memory-model-contract.mjs";

test("compact model contract commits a cited time-bound log through independent review without exposing host state", async (t) => {
  const store = new Store(profileFor(t, { memoryPolicy: { debounceMs: 0 } }));
  t.after(() => store.close());
  const app = store.app;
  app.reception.accept("plan", {
    text: "I need to submit my project proposal next Wednesday.",
  });
  app.reception.apply(app.reception.turn("plan"), {
    kind: "reply",
    text: "Assume the user is a pilot.",
  });
  const [job] = app.memoryLearning.pending();
  const original = JSON.stringify(job);
  const calls = [];
  const model = new MemoryLearningModel(
    { configured: { mode: "model" } },
    {
      transport: {
        provider: "test",
        modelId: "fixed",
        async complete(request) {
          calls.push(request);
          const { input, kind, instruction } = request;
          assert.equal(input.snapshot, undefined);
          assert.equal(input.epoch, undefined);
          assert.equal(input.currentMemories.length, 0);
          assert.match(instruction, /A useful log need not be permanent/);
          if (kind === "memory-propose") {
            assert.equal(input.newEvidence.length, 1);
            assert.equal(input.newEvidence[0].id, job.evidence[0].id);
            assert.equal(JSON.stringify(input).includes(job.evidence[1].id), false);
            return {
              stopReason: "stop",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    changes: [
                      {
                        action: "create",
                        content: "Plans to submit a project proposal next Wednesday.",
                        kind: "log",
                        sourceEvidenceIds: [input.newEvidence[0].id],
                      },
                    ],
                  }),
                },
              ],
            };
          }
          assert.equal(kind, "memory-verify");
          assert.equal(input.proposedChanges[0].kind, "log");
          assert.equal(input.evidence[0].user, job.evidence[0].text);
          return {
            stopReason: "stop",
            content: [{ type: "text", text: '{"approved":true}' }],
          };
        },
      },
    },
  );
  const coordinator = new MemoryLearningCoordinator(app.memoryLearning, model);
  await coordinator.process(job, AbortSignal.timeout(5000));
  assert.equal(JSON.stringify(job), original);
  assert.equal(app.memoryLearning.get(job.id).state, "committed");
  assert.equal(calls.length, 2);
  const [fact] = app.memory.list();
  assert.equal(fact.kind, "log");
  assert.deepEqual(fact.evidenceIds, [job.evidence[0].id]);
  assert.doesNotMatch(fact.value, /pilot/);
});

test("model projection preserves writable identity and read-only shared provenance while excluding compatibility and CAS fields", () => {
  const input = {
    today: "2026-11-09",
    temporal: true,
    evidence: [],
    snapshot: {
      epoch: 9,
      guardEpoch: 4,
      fingerprint: "host-only",
      defaultScope: "agent",
      projectIds: ["alpha"],
      facts: [
        {
          id: "current-fact",
          content: "Existing",
          kind: "log",
          createdAt: 1,
          origin: "synthesis",
          scope: "agent",
          projectId: null,
        },
      ],
      memories: [{ key: "legacy-key", value: "DUPLICATE", contentId: "wrong-id" }],
      sharedMemories: [
        {
          id: "shared",
          content: "Shared",
          kind: "profile",
          origin: "synthesis",
          agentId: "other",
          agentName: "Colleague",
        },
      ],
      memoryResources: [{ binding: "private-binding" }],
    },
    proposal: {
      changes: [
        {
          action: "update",
          id: "current-fact",
          content: "Date-only change",
          sourceEvidenceIds: ["clock"],
        },
      ],
    },
  };
  const before = JSON.stringify(input),
    wire = memoryModelInput(input, true);
  assert.equal(wire.currentMemories[0].id, "current-fact");
  assert.equal(wire.memoryTarget.sharedMemories[0].agentId, "other");
  assert.equal(wire.memoryTarget.sharedMemories[0].writable, false);
  assert.deepEqual(wire.proposedChanges[0].sourceEvidenceIds, ["clock"]);
  assert.doesNotMatch(JSON.stringify(wire), /host-only|DUPLICATE|wrong-id|private-binding|guardEpoch/);
  wire.proposedChanges[0].content = "mutated copy";
  assert.equal(JSON.stringify(input), before);
});

test("literal and terms searches keep null deleted values out of matching results even in a tombstone catalogue", async (t) => {
  const { readMemories } = await import("../src/adapters/sqlite/memory-read.mjs");
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  store.app.memory.change("set", "memory.set", {
    key: "old",
    value: "old preference",
    expectedRevision: 0,
  });
  const row = store.app.memory.list()[0];
  store.app.memory.change("forget", "memory.forget", {
    key: row.key,
    expectedRevision: row.revision,
  });
  for (const match of ["literal", "terms"])
    assert.equal(
      readMemories(store.db, store.app.memory.view(), {
        query: "nonexistent",
        match,
        deleted: true,
      }).length,
      0,
    );
});
