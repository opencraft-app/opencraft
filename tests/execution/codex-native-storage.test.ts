import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexNativeStorage } from "../../apps/opencraft-daemon/src/codex-native-storage.js";
import { readRolloutIncrement } from "../../packages/native-history-node/src/codex-rollout-reader.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "oc-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), other = join(root, "other");
  await mkdir(home); await mkdir(other);
  const path = join(home, "rollout.jsonl"), outside = join(other, "rollout.jsonl");
  for (const file of [path, outside]) await writeFile(file, '{"type":"session_meta"}\n');
  let current = home;
  const storage = new CodexNativeStorage(() => current);
  return { storage, home, other, path, outside, setHome(value: string) { current = value; } };
}

test("the single native HOME supplies Thread rollouts and file reads", async t => {
  const f = await fixture(t);
  const source = await f.storage.resolve("thread", f.path);
  assert.equal(source.nativeHome, f.home);
  await source.validate();
  const read = await readRolloutIncrement({ path: f.path, nativeHome: f.home, source,
    cursor: 0, identity: null, select: () => true, retain: () => true });
  assert.equal(read.events.length, 1);
  assert.deepEqual((await f.storage.homes()).map(home => home.nativeHome), [f.home]);
  await assert.rejects(f.storage.resolve("thread", f.outside), /outside native home/);
});

test("a changed native HOME rejects late source reads", async t => {
  const f = await fixture(t);
  const source = await f.storage.resolve("thread", f.path);
  f.setHome(f.other);
  await assert.rejects(source.validate(), /owner changed/);
  await assert.rejects(readRolloutIncrement({ path: f.path, nativeHome: f.home, source,
    cursor: 0, identity: null, select: () => true, retain: () => true }), /owner changed/);
  f.setHome("");
  await assert.rejects(f.storage.homes(), /Native HOME is unavailable/);
});

test("the native HOME never authorizes sibling directories or symlink escapes", async t => {
  const f = await fixture(t), escape = join(f.home, "escape.jsonl");
  await symlink(f.outside, escape);
  await assert.rejects(f.storage.resolve("thread", escape), /outside native home/);
});
