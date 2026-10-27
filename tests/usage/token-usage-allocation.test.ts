import assert from "node:assert/strict";
import test from "node:test";
import { allocateTurnTokens, tokenInteger } from "../../apps/opencraft-daemon/src/token-usage-allocation.ts";

const bucket = (totalTokens: string, model = "model", provider: string | null = "provider") => ({ provider, model, totalTokens });

test("F-02/F-03: whole-turn equality deduplicates stable Actors regardless of input ordering", () => {
  const a = allocateTurnTokens([bucket("120000")], ["B", "A", "B", "B"]);
  assert.deepEqual(a.actors, [{ actorId: "A", totalTokens: "60000" }, { actorId: "B", totalTokens: "60000" }]);
  assert.equal(a.totalTokens, "120000");
});

test("F-07: remainders continue across model buckets and sum to the whole-turn allocation", () => {
  const result = allocateTurnTokens([bucket("5", "b"), bucket("5", "a")], ["C", "B", "A"]);
  assert.deepEqual(result.actors.map(a => a.totalTokens), ["4", "3", "3"]);
  assert.deepEqual(result.models.map(m => m.actors.map(a => a.totalTokens)), [["2", "2", "1"], ["2", "1", "2"]]);
  assert.equal(result.models[0]?.model, "a");
  assert.equal(result.policy, "equal-turn-v1");
});

test("F-11: duplicate model buckets merge, providers stay distinct, and missing models retain a bucket", () => {
  const result = allocateTurnTokens([
    bucket("4"), bucket("6"), bucket("10", "model", "other"), { provider: null, model: null, totalTokens: "3" },
  ], ["A", "B"]);
  assert.equal(result.totalTokens, "23");
  assert.equal(result.models.length, 3);
  assert.deepEqual(result.models.filter(m => m.model === "model").map(m => m.totalTokens), ["10", "10"]);
  for (const actor of result.actors) {
    assert.equal(result.models.reduce((n, m) => n + BigInt(m.actors.find(a => a.actorId === actor.actorId)!.totalTokens), 0n).toString(), actor.totalTokens);
  }
});

test("NF-01: huge integers survive allocation and JSON round trips without Number coercion", () => {
  const value = "9007199254740993123456789";
  const result = JSON.parse(JSON.stringify(allocateTurnTokens([bucket(value)], ["A", "B", "C"])));
  assert.equal(result.totalTokens, value);
  assert.equal(result.actors.reduce((n: bigint, a: {totalTokens: string}) => n + BigInt(a.totalTokens), 0n), BigInt(value));
  assert.equal(tokenInteger(value), BigInt(value));
  assert.throws(() => tokenInteger(Number.MAX_SAFE_INTEGER + 1));
});

test("integer boundary rejects missing, negative, fractional and noncanonical counts instead of treating them as zero", () => {
  for (const value of [undefined, null, -1, -1n, 0.5, NaN, Infinity, "-1", "1.5", "01", "", " 1", "1e6"]) {
    assert.throws(() => tokenInteger(value), TypeError);
  }
  assert.equal(tokenInteger(0), 0n);
  assert.throws(() => allocateTurnTokens([bucket("1")], []));
  assert.throws(() => allocateTurnTokens([bucket("1")], [""]));
});

test("conservation and fairness hold across participant/model combinations, including empty and zero buckets", () => {
  for (let people = 1; people <= 17; people++) {
    const ids = Array.from({ length: people }, (_, i) => `actor:${i}`);
    for (let models = 0; models < 13; models++) {
      const buckets = Array.from({ length: models }, (_, i) => bucket(String((i * 37 + people) % 101), `m:${i}`));
      const result = allocateTurnTokens(buckets, ids);
      const shares = result.actors.map(a => BigInt(a.totalTokens));
      const total = buckets.reduce((n, b) => n + BigInt(b.totalTokens), 0n);
      assert.equal(shares.reduce((n, s) => n + s, 0n), total);
      assert.ok(shares.every(a => shares.every(b => a - b <= 1n)));
      for (const model of result.models) assert.equal(model.actors.reduce((n, a) => n + BigInt(a.totalTokens), 0n), BigInt(model.totalTokens));
    }
  }
});
