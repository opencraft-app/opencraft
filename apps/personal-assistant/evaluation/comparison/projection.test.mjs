import test from "node:test";
import assert from "node:assert/strict";
import { presentMemory } from "./foreign-session.mjs";
import { readMemoryQuestion } from "../memory-system-session.mjs";
test("Hindsight exposes twelve native ordered facts, with dates but no raw chunks or diagnostics", () => {
  const results = Array.from({ length: 14 }, (_, i) => ({
    id: String(i),
    text: `fact ${i}`,
    fact_type: "world",
    context: "source",
    mentioned_at: "2026-11-09",
    scores: { final: 100 - i },
  }));
  const input = {
    results,
    chunks: { secret: "raw history" },
    trace: { query: "private diagnostic" },
  };
  const view = presentMemory("hindsight", input);
  assert.equal(view.memories.length, 12);
  assert.deepEqual(
    view.memories.map((x) => x.id),
    results.slice(0, 12).map((x) => x.id),
  );
  assert.equal(view.memories[0].mentioned_at, "2026-11-09");
  assert.equal(view.truncated, true);
  assert.equal(JSON.stringify(view).includes("raw history"), false);
  assert.equal(JSON.stringify(view).includes("scores"), false);
  assert.throws(() => presentMemory("hindsight", {}), /Invalid/);
});
test("TDB injects only original prompt contexts, not duplicated metrics", () => {
  const input = {
    prependContext: "fact",
    appendSystemContext: "profile",
    recalledL1Memories: [{ content: "fact" }],
    recalledL3Persona: "profile",
    recallStrategy: "hybrid",
  };
  assert.deepEqual(presentMemory("tdb", input), {
    prependContext: "fact",
    appendSystemContext: "profile",
  });
  assert.deepEqual(presentMemory("tdb", { error: { code: 123 }, partial: true }), {
    prependContext: "",
    appendSystemContext: "",
    error: { code: 123 },
    partial: true,
  });
});
test("HY preserves original facts, profile and evolution chains, excludes diagnostics", () => {
  const fact = { content: "current", evolution_chain: [{ content: "past" }] },
    input = {
      profile: { content: "identity" },
      retrieval: {
        memories: { normal: [fact] },
        elapsed_ms: 123,
        request_id: "not-evidence",
      },
    };
  assert.deepEqual(presentMemory("hy", input), {
    profile: { content: "identity" },
    memories: { normal: [fact] },
  });
});
test("common reader awaits asynchronous foreign queries without adding learning turns", async () => {
  const trace = [],
    input = { availableQueries: ["memory.search"] };
  let calls = 0;
  const result = await readMemoryQuestion(input, {
    signal: new AbortController().signal,
    session: {
      trace,
      execute: async (p) => {
        await Promise.resolve();
        trace.push(p);
        return { result: "evidence" };
      },
    },
    decide: async (v) => {
      calls++;
      return v.observations.length
        ? (assert.equal(v.observations[0].result, "evidence"), { kind: "reply", text: "(a)" })
        : { kind: "query", name: "memory.search", params: { query: "x" } };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.hypothesis, "(a)");
  assert.equal(trace.length, 1);
});
