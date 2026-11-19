import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateCatalogConsistency,
  generateCatalogConsistencyChaos,
  parseCatalogConsistencyTrace,
} from "../protocol/fixtures/catalog-consistency-chaos";

// Preservation checks execute the production projection and acknowledgement owners.
for (const event of [
  { type: "rename", id: "A", name: "renamed" },
  { type: "rename", id: "B", name: "renamed" },
  { type: "status", id: "B", status: "idle" },
  { type: "remove", id: "B" },
] as const) {
  test(`${JSON.stringify(event)} preserves other owners during materialization`, async () => {
    await simulateCatalogConsistency([{ type: "tail" }, event, { type: "materialize" }]);
  });
}
for (const partial of [false, true])
  test(`local read start alone cannot acknowledge an owner fact (partial=${partial})`, async () => {
    await simulateCatalogConsistency([
      { type: "rename", id: "A", name: "committed" },
      { type: "lagging-read", partial },
    ]);
  });
test("non-overlapping pages, duplicate events and retired journal stay scoped", async () => {
  const result = await simulateCatalogConsistency([
    { type: "rename", id: "A", name: "renamed" },
    { type: "duplicate" },
    { type: "materialize" },
    { type: "switch-scope" },
    { type: "late-old-scope" },
    { type: "duplicate" },
  ]);
  assert.equal(result.events, 6);
});
test("seeded schedules and serialized old counterexamples preserve production owner fields", async () => {
  assert.deepEqual(generateCatalogConsistencyChaos(123, 40), generateCatalogConsistencyChaos(123, 40));
  const trace = parseCatalogConsistencyTrace([
    { type: "duplicate" },
    { type: "tail" },
    { type: "rename", id: "B", name: "renamed" },
    { type: "duplicate" },
    { type: "materialize" },
  ]);
  await simulateCatalogConsistency(parseCatalogConsistencyTrace(JSON.parse(JSON.stringify(trace))));
  for (let seed = 0; seed < 100; seed++) await simulateCatalogConsistency(generateCatalogConsistencyChaos(seed, 60));
});
test("trace parser rejects malformed or ambiguous schedules before replay", () => {
  for (const invalid of [
    null,
    [{ type: "rename", id: "C", name: "x" }],
    [{ type: "rename", id: "A" }],
    [{ type: "lagging-read", partial: "yes" }],
    [{ type: "tail", inventedAuthority: true }],
    [{ type: "__proto__" }],
  ]) {
    assert.throws(() => parseCatalogConsistencyTrace(invalid), /TRACE_SCHEMA/);
  }
});
