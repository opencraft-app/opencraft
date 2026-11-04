import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadPinningResource } from '../../packages/workbench-runtime/src/thread-pinning-resource';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const reads: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  const writes: Array<() => void> = [];
  let current = true;
  const resource = new ThreadPinningResource({ current: () => current,
    read: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    write: (_id, pinned) => new Promise(resolve => writes.push(() => resolve({ pinned }))),
  });
  return { resource, reads, writes, retire() { current = false; } };
}
test('concurrent catalog consumers share only the in-flight pin discovery, with no settled cache', async () => {
  const f = fixture();
  const waiting = Array.from({ length: 20 }, () => f.resource.read());
  await tick(); assert.equal(f.reads.length, 1);
  f.reads[0]!.resolve({ supported: true, data: [] });
  assert.ok((await Promise.all(waiting)).every(value => value.supported));
  const fresh = f.resource.read(); await tick(); assert.equal(f.reads.length, 2);
  f.reads[1]!.resolve({ supported: false, data: [] });
  assert.equal((await fresh).supported, false);
});
test('a pin write racing shared discovery forces one fresh read after that write', async () => {
  const f = fixture();
  const initial = f.resource.read(); await tick(); f.reads[0]!.resolve({ supported: true, data: [] }); await initial;
  const first = f.resource.read(), second = f.resource.read(); await tick();
  const write = f.resource.set('thread', true); await tick();
  f.reads[1]!.resolve({ supported: true, data: [] }); await tick();
  assert.equal(f.reads.length, 2, 'fresh metadata waits for the admitted mutation');
  f.writes[0]!(); await write; await tick(); assert.equal(f.reads.length, 3);
  f.reads[2]!.resolve({ supported: true, data: [{ id: 'thread', cwd: '/fixture', preview: '', updatedAt: 1, turns: [] }] });
  assert.equal((await first).data[0]!.id, 'thread'); assert.equal((await second).data[0]!.id, 'thread');
});
test('failed and retired discoveries reject all waiters and leave later reads retryable', async () => {
  const f = fixture();
  const failure = assert.rejects(Promise.all([f.resource.read(), f.resource.read()]), /offline/);
  await tick(); assert.equal(f.reads.length, 1); f.reads[0]!.reject(new Error('offline')); await failure;
  const retired = assert.rejects(f.resource.read(), /连接已改变/); await tick();
  f.retire(); f.reads[1]!.resolve({ supported: true, data: [] }); await retired;
});
