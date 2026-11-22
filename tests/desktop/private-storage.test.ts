import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFilePrivateStorage } from "../../apps/desktop/src/private-storage.js";

const fresh = async (t: { after(fn: () => Promise<void>): void }) => {
  const root = await mkdtemp(join(tmpdir(), "desktop-private-storage-"));
  t.after(() => chmod(root, 0o700).then(() => rm(root, { recursive: true, force: true })));
  return root;
};

// Main never blocks on these files: reads come from memory, writes persist in order.
test("writes are visible at once and on disk, owner-only, after flush", async (t) => {
  const directory = join(await fresh(t), "store");
  const storage = await openFilePrivateStorage(directory);
  assert.equal(storage.read("state"), null);
  storage.write("state", "one");
  storage.write("state", "two");
  assert.equal(storage.read("state"), "two", "memory is current before the disk write finishes");
  await storage.flush();
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), "two");
  assert.equal((await stat(join(directory, "state.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  storage.remove("state");
  await storage.flush();
  await assert.rejects(stat(join(directory, "state.json")), { code: "ENOENT" });
  assert.equal(await openFilePrivateStorage(directory), storage, "one owner per directory");
});

test("existing entries load at open; an unreadable entry fails only its own reads", async (t) => {
  const directory = await fresh(t);
  await writeFile(join(directory, "good.json"), "kept", { mode: 0o600 });
  await writeFile(join(directory, "loose.json"), "exposed", { mode: 0o644 });
  const storage = await openFilePrivateStorage(directory);
  assert.equal(storage.read("good"), "kept");
  assert.throws(() => storage.read("loose"), /Invalid private storage file/);
  storage.write("loose", "replaced");
  await storage.flush();
  assert.equal(storage.read("loose"), "replaced");
  assert.throws(() => storage.read("../escape"), /Invalid private storage key/);
});

test("a write that cannot be saved surfaces at flush and refuses later changes", async (t) => {
  const root = await fresh(t),
    directory = join(root, "store");
  await mkdir(directory, { mode: 0o700 });
  const storage = await openFilePrivateStorage(directory);
  // The storage directory is replaced by a file, so the next write cannot be saved.
  await rm(directory, { recursive: true });
  await writeFile(directory, "");
  storage.write("state", "lost");
  await assert.rejects(storage.flush());
  assert.throws(() => storage.write("state", "again"), /Private storage is unavailable/);
});
