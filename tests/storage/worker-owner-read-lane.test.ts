import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerOwner } from "@opencraft/worker-owner";
type Store = {
  write(v: number): Promise<number>;
  peek(): { value: number; writing: boolean };
  badRead(): Promise<number>;
};
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "owner-read-lane-")),
    file = join(root, "close.json");
  const { owner } = await WorkerOwner.open<Store>(
    new URL("../fixtures/worker-owner-read-lane.worker.ts", import.meta.url),
    { name: "read-lane test", workerData: { file }, maxPending: 16 },
  );
  t.after(async () => {
    await owner.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { owner, file };
}
test("explicit synchronous reads remain live during async writes; mutations stay FIFO and close drains both lanes", async (t) => {
  const f = await fixture(t),
    first = f.owner.call.write(1),
    second = f.owner.call.write(2);
  let before = await f.owner.call.peek();
  for (let i = 0; !before.writing && i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
    before = await f.owner.call.peek();
  }
  assert.deepEqual(before, { value: 0, writing: true });
  const closing = f.owner.close();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  await closing;
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { value: 2, writing: false });
  await assert.rejects(f.owner.call.peek(), /closed/);
});
test("an accidentally async read fences the owner instead of becoming an untracked concurrent operation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.owner.call.badRead(), /synchronous/);
  await assert.rejects(f.owner.call.peek());
});
