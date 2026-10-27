import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexGenerationDirectory } from "@opencraft/account-pool-host";
import { CodexNativeStorage } from "../../apps/opencraft-daemon/src/codex-native-storage.js";
import { readRolloutIncrement } from "../../packages/native-history-node/src/codex-rollout-reader.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "oc-storage-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldHome = join(root, "old"), newHome = join(root, "new");
  await mkdir(oldHome); await mkdir(newHome);
  const oldPath = join(oldHome, "rollout.jsonl"), newPath = join(newHome, "rollout.jsonl");
  for (const path of [oldPath, newPath]) await writeFile(path, '{"type":"session_meta"}\n');
  let directory: CodexGenerationDirectory | null = { protocolVersion: 1, routingEpoch: "owner-1", admissionEpoch: 2,
    homes: [{ generationId: "old", codexHome: oldHome, incarnation: 1 }, { generationId: "new", codexHome: newHome, incarnation: 1 }], route: null };
  let offline = false;
  const storage = new CodexNativeStorage({ async generationDirectory(threadId?: string) {
    if (offline) throw new Error("Core offline");
    return directory && { ...structuredClone(directory), route: threadId === "old-thread" ? { threadId, generationId: "old" }
      : threadId === "new-thread" ? { threadId, generationId: "new" } : null };
  } }, () => oldHome);
  return { storage, oldHome, newHome, oldPath, newPath, get directory() { return directory; },
    set directory(value: CodexGenerationDirectory | null) { directory = value; }, setOffline() { offline = true; } };
}

test("Thread HOME stays with its generation across default changes, including file reads", async t => {
  const f = await fixture(t);
  const old = await f.storage.resolve("old-thread", f.oldPath), fresh = await f.storage.resolve("new-thread", f.newPath);
  assert.equal(old.nativeHome, f.oldHome); assert.equal(fresh.nativeHome, f.newHome);
  f.directory = { ...f.directory!, admissionEpoch: 3 };
  await old.validate(); await fresh.validate();
  const read = await readRolloutIncrement({ path: f.newPath, nativeHome: f.oldHome, source: fresh,
    cursor: 0, identity: null, select: () => true, retain: () => true });
  assert.equal(read.events.length, 1);
  await assert.rejects(f.storage.resolve("new-thread", f.oldPath), /outside native home/);
});

test("Core absence keeps single HOME compatibility, while offline and unknown routes do not become empty data", async t => {
  const f = await fixture(t);
  await assert.rejects(f.storage.resolve("unknown", f.oldPath), /no registered generation/);
  const discovered = await f.storage.resolve("unknown", f.oldPath, true); await discovered.validate();
  const homes = await f.storage.homes(); assert.equal(homes.length, 2);
  f.directory = null;
  const legacy = await f.storage.resolve("old-thread", f.oldPath); await legacy.validate();
  await assert.rejects(f.storage.resolve("new-thread", f.newPath), /outside native home/);
  f.setOffline(); await assert.rejects(f.storage.homes(), /Core offline/);
});

test("owner and incarnation changes reject late source reads, including a formerly single HOME", async t => {
  const f = await fixture(t);
  const first = await f.storage.resolve("new-thread", f.newPath);
  f.directory = { ...f.directory!, routingEpoch: "owner-2" };
  await assert.rejects(readRolloutIncrement({ path: f.newPath, nativeHome: f.newHome, source: first,
    cursor: 0, identity: null, select: () => true, retain: () => true }), /owner changed/);
  const next = await f.storage.resolve("new-thread", f.newPath);
  f.directory = { ...f.directory!, homes: f.directory!.homes.map(h => ({ ...h, incarnation: h.incarnation + 1 })) };
  await assert.rejects(next.validate(), /owner changed/);
  f.directory = null; const legacy = await f.storage.resolve("old-thread", f.oldPath);
  f.directory = { protocolVersion: 1, routingEpoch: "owner-3", admissionEpoch: 4,
    homes: [{ generationId: "old", codexHome: f.oldHome, incarnation: 1 }], route: null };
  await assert.rejects(legacy.validate(), /owner changed/);
});

test("registered HOME lists never authorize sibling directories or symlink escapes", async t => {
  const f = await fixture(t), escape = join(f.newHome, "escape.jsonl");
  await symlink(f.oldPath, escape);
  await assert.rejects(f.storage.resolve("new-thread", escape), /outside native home/);
  await rm(f.oldHome, { recursive: true });
  await assert.rejects(f.storage.homes(), { code: "ENOENT" });
});
