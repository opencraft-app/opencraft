import assert from "node:assert/strict";
import test from "node:test";
import { projectBotTimeline } from "@opencraft/bot-conversation";
import { createHermesBotHistoryHarness, toolHistory } from "./fixtures/hermes-bot-history-harness";

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out at the Bot history integration boundary");
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test("real Hermes → Bot pipeline keeps the source-row window despite limit=1 and resync", async t => {
  const rows = Array.from({ length: 260 }, (_, index) => ({
    id: index + 1, role: index % 2 === 0 ? "user" : "assistant", content: `history ${index + 1}`,
  }));
  const h = await createHermesBotHistoryHarness(rows); t.after(() => h.dispose());
  await h.source.load(h.key);
  assert.equal(h.source.getSnapshot(h.key).transcript.length, 120);
  await Promise.all([h.source.loadOlder(h.key), h.source.loadOlder(h.key)]);
  assert.equal(h.source.getSnapshot(h.key).transcript.length, 240);
  await h.source.loadOlder(h.key);
  const before = h.source.getSnapshot(h.key).transcript.map(item => item.id);
  assert.equal(before.length, 260);
  assert.equal(new Set(before).size, 260);
  assert.equal(h.source.getSnapshot(h.key).history.hasOlder, false);
  assert.deepEqual(h.requests, [0, 120, 240]);
  await h.resync();
  await until(() => h.requests.length === 5 && h.source.getSnapshot(h.key).phase === "ready");
  assert.deepEqual(h.source.getSnapshot(h.key).transcript.map(item => item.id), before);
  assert.equal(h.source.getSnapshot(h.key).history.hasOlder, false);
});

test("tool-only tail is empty display, not empty history; backfill reaches its user input", async t => {
  const h = await createHermesBotHistoryHarness(toolHistory(130)); t.after(() => h.dispose());
  await h.source.load(h.key);
  assert.equal(projectBotTimeline(h.source.getSnapshot(h.key)).units.length, 0);
  assert.equal(h.source.getSnapshot(h.key).history.hasOlder, true);
  await h.source.loadOlder(h.key);
  assert.equal(projectBotTimeline(h.source.getSnapshot(h.key)).units.length, 0);
  await h.source.loadOlder(h.key);
  assert.equal(projectBotTimeline(h.source.getSnapshot(h.key)).units.length, 1);
  assert.equal(h.source.getSnapshot(h.key).history.hasOlder, false);
  assert.deepEqual(h.requests, [0, 120, 240]);
});

test("older full window reprojects causal ownership without replacing an assistant identity", async t => {
  const h = await createHermesBotHistoryHarness(toolHistory(130, "Historical final answer"));
  t.after(() => h.dispose());
  await h.source.load(h.key);
  const original = h.source.getSnapshot(h.key).transcript[0];
  assert.ok(original);
  await h.source.loadOlder(h.key);
  await h.source.loadOlder(h.key);
  const transcript = h.source.getSnapshot(h.key).transcript;
  const restored = transcript.find(item => item.id === original.id)!;
  const user = transcript.find(item => item.author.kind === "human")!;
  assert.equal(restored.id, original.id);
  assert.equal(restored.causalMessageKey, user.id);
  assert.notEqual(restored.executionId, original.executionId);
  assert.equal(new Set(transcript.map(item => item.id)).size, transcript.length);
});
