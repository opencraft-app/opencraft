import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiEngine } from "../../plugins/pi-engine/src/index";

for (const initiallyPinned of [false, true]) {
  test(`Pi rejected ${initiallyPinned ? "unpin" : "pin"} keeps committed state and retries storage`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-pin-durability-"));
    const threadId = "pi_55555555-5555-4555-8555-555555555555";
    const file = join(directory, `${threadId}.json`), backup = `${file}.saved`;
    const record = { format: "pi-durable-1", id: threadId, cwd: directory, model: "pi:faux:one", name: null,
      preview: "Pin durability", createdAt: 1, updatedAt: 1, archived: false, tools: [],
      ...(initiallyPinned ? { pinned: true, pinnedAt: 100 } : {}) };
    await writeFile(file, JSON.stringify(record));
    const owner = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
    let engine = new PiEngine({ directory, cwd: directory, models: {} as any });
    const rows = async () => (await engine.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id);
    const expected = initiallyPinned ? [threadId] : [];
    const intent = { threadId, pinned: !initiallyPinned };
    try {
      assert.deepEqual(await rows(), expected);
      // A real rename failure, including when tests run as root. The previous
      // durable record remains intact in backup throughout the failed writes.
      await rename(file, backup);
      await mkdir(file);
      await assert.rejects(engine.request("opencraft/thread-pins/set", intent, owner));
      assert.deepEqual(await rows(), expected, "failed write must not publish the rejected pin state");
      await assert.rejects(engine.request("opencraft/thread-pins/set", intent, owner),
        "repeating an uncommitted intent must retry storage and reject again");
      assert.deepEqual(await rows(), expected);
      assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
      assert.deepEqual(JSON.parse(await readFile(backup, "utf8")), record);
      await rm(file, { recursive: true });
      await rename(backup, file);
      await engine.request("opencraft/thread-pins/set", intent, owner);
      assert.deepEqual(await rows(), initiallyPinned ? [] : [threadId]);
      assert.equal(JSON.parse(await readFile(file, "utf8")).pinned === true, !initiallyPinned);
      await engine.close();
      engine = new PiEngine({ directory, cwd: directory, models: {} as any });
      assert.deepEqual(await rows(), initiallyPinned ? [] : [threadId]);
    } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

for (const initiallyPinned of [false, true]) {
  test(`Pi pending ${initiallyPinned ? "unpin" : "pin"} does not publish before durable acknowledgement`, { timeout: 10_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-pin-pending-"));
    const threadId = "pi_66666666-6666-4666-8666-666666666666", file = join(directory, `${threadId}.json`);
    const record = { format: "pi-durable-1", id: threadId, cwd: directory, model: "pi:faux:one", name: null,
      preview: "Pending pin", createdAt: 1, updatedAt: 1, archived: false, tools: [],
      ...(initiallyPinned ? { pinned: true, pinnedAt: 100 } : {}) };
    await writeFile(file, JSON.stringify(record));
    const owner = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
    const engine = new PiEngine({ directory, cwd: directory, models: {} as any });
    const rows = async () => (await engine.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(done => { release = done; });
    const started = new Promise<void>(done => { entered = done; });
    const original = fs.rename;
    t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
      if (to === file) { entered(); await held; }
      return original(from, to);
    });
    syncBuiltinESMExports();
    let writing: Promise<any> | undefined;
    try {
      assert.deepEqual(await rows(), initiallyPinned ? [threadId] : []);
      writing = engine.request("opencraft/thread-pins/set", { threadId, pinned: !initiallyPinned }, owner);
      await started;
      assert.deepEqual(await rows(), initiallyPinned ? [threadId] : []);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), record);
      release(); await writing;
      assert.deepEqual(await rows(), initiallyPinned ? [] : [threadId]);
      assert.equal(JSON.parse(await readFile(file, "utf8")).pinned === true, !initiallyPinned);
    } finally {
      release(); await writing?.catch(() => {});
      t.mock.restoreAll(); syncBuiltinESMExports();
      await engine.close(); await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Pi concurrent pin acknowledgements preserve intent order", { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-pin-order-"));
  const first = "pi_99999999-9999-4999-8999-999999999999", second = "pi_11111111-1111-4111-8111-111111111111";
  for (const id of [first, second]) await writeFile(join(directory, `${id}.json`), JSON.stringify({ format: "pi-durable-1", id,
    cwd: directory, model: "pi:faux:one", name: null, preview: id, createdAt: 1, updatedAt: 1, archived: false, tools: [] }));
  const owner = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
  const engine = new PiEngine({ directory, cwd: directory, models: {} as any });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { entered = done; });
  const original = fs.rename;
  t.mock.method(Date, "now", () => 1000);
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (to === join(directory, `${first}.json`)) { entered(); await held; }
    return original(from, to);
  });
  syncBuiltinESMExports();
  let writing: Promise<any> | undefined;
  try {
    writing = engine.request("opencraft/thread-pins/set", { threadId: first, pinned: true }, owner);
    await started;
    await engine.request("opencraft/thread-pins/set", { threadId: second, pinned: true }, owner);
    const rows = async () => (await engine.request("opencraft/thread-pins/list", {}, owner)).data.map((row: any) => row.id);
    assert.deepEqual(await rows(), [second]);
    release(); await writing;
    assert.deepEqual(await rows(), [first, second]);
  } finally {
    release(); await writing?.catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports();
    await engine.close(); await rm(directory, { recursive: true, force: true });
  }
});
