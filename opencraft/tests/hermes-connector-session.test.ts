import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorSession, type ConnectorSessionClient } from '../plugins/lightvela-hermes/src/connectors/connector-session';
import { SidecarNotInstalled } from '../plugins/lightvela-hermes/src/connectors/connector-client';

const release = { url: 'https://example.com/release', sha256: 'a'.repeat(64) };
function fake(connect = async () => {}) {
  let disposed = false;
  const client: ConnectorSessionClient = {
    connect, install: async () => {}, dispose: () => { disposed = true; },
    request: async <T>(path: string) => (path === '/v1/instances' ? { instances: [] } : { connectors: [] }) as T,
  };
  return { client, get disposed() { return disposed; } };
}
test('install supersedes a stuck probe; its late completion cannot replace current state', async () => {
  let finish!: () => void;
  const old = fake(() => new Promise<void>(resolve => { finish = resolve; }));
  const current = fake(); let calls = 0;
  const owner = new ConnectorSession(() => (++calls === 1 ? old.client : current.client));
  try {
    const probe = owner.probe();
    assert.equal(owner.getSnapshot().phase, 'probing');
    await owner.install(release);
    assert.equal(old.disposed, true);
    assert.equal(owner.getSnapshot().phase, 'ready');
    finish(); await probe;
    assert.equal(owner.getSnapshot().phase, 'ready');
    assert.equal(current.disposed, false);
  } finally { owner.dispose(); }
});
test('missing is distinct from a network timeout, and neither blocks a fresh install', async () => {
  for (const missing of [true, false]) {
    const first = fake(() => missing ? Promise.reject(new SidecarNotInstalled()) : new Promise(() => {}));
    let count = 0;
    const owner = new ConnectorSession(() => ++count === 1 ? first.client : fake().client,
      { probe: 5, install: 100, update: 100 });
    try {
      await owner.probe();
      assert.equal(owner.getSnapshot().phase, missing ? 'missing' : 'error');
      assert.equal(first.disposed, true);
      await owner.install(release);
      assert.equal(owner.getSnapshot().phase, 'ready');
    } finally { owner.dispose(); }
  }
});
test('cancelled mutation reports uncertain remote outcome and fences late results', async () => {
  const owner = new ConnectorSession(() => fake().client);
  await owner.probe();
  let finish!: () => void;
  const pending = owner.update(() => new Promise<void>(resolve => { finish = resolve; }));
  let duplicate = false;
  await owner.update(async () => { duplicate = true; });
  assert.equal(duplicate, false);
  owner.cancel();
  assert.match(owner.getSnapshot().message!, /远端操作可能已生效/);
  finish(); await pending;
  assert.equal(owner.getSnapshot().phase, 'idle');
  owner.dispose();
});
