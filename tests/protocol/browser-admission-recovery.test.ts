import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBrowserAdmissionRecovery } from '../../apps/workbench-web/src/runtime/browser-admission-recovery';

function fixture() {
  const values = new Map<string, string>();
  let reloads = 0;
  const port = { key: 'selected-server', storage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  }, flush: async () => {}, reload: () => { reloads++; } };
  return { port, values, reloads: () => reloads };
}

test('confirmed 401 flushes before reload and coalesces concurrent probes', async () => {
  const f = fixture(); let finish!: () => void;
  f.port.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const recovery = createBrowserAdmissionRecovery(f.port);
  recovery.observe(401); recovery.observe(401);
  assert.equal(f.reloads(), 0);
  assert.equal(f.values.get(f.port.key), '1');
  finish(); await tick(); assert.equal(f.reloads(), 1);
});

test('reload fence survives new page instances; only confirmed admission rearms it', async () => {
  const f = fixture();
  createBrowserAdmissionRecovery(f.port).observe(401); await tick();
  const next = createBrowserAdmissionRecovery(f.port);
  for (const status of [401, 403, 404, 200, 500]) next.observe(status);
  await tick(); assert.equal(f.reloads(), 1);
  next.observe(204); next.observe(401); await tick(); assert.equal(f.reloads(), 2);
});

test('permission denial, legacy admission and unavailable endpoints never navigate', async () => {
  const f = fixture(), recovery = createBrowserAdmissionRecovery(f.port);
  for (const status of [403, 404, 200, 500]) recovery.observe(status);
  await tick(); assert.equal(f.reloads(), 0); assert.equal(f.values.size, 0);
});

test('blocked session storage keeps manual recovery', async () => {
  const f = fixture(); f.port.storage.setItem = () => { throw Error('blocked'); };
  createBrowserAdmissionRecovery(f.port).observe(401);
  await tick(); assert.equal(f.reloads(), 0);
});

test('failed flush keeps current input mounted', async () => {
  const f = fixture(); f.port.flush = async () => { throw Error('save failed'); };
  createBrowserAdmissionRecovery(f.port).observe(401);
  await tick(); assert.equal(f.reloads(), 0);
});

test('disposal fences navigation after a slow local save', async () => {
  const f = fixture(); let finish!: () => void;
  f.port.flush = () => new Promise<void>(resolve => { finish = resolve; });
  const recovery = createBrowserAdmissionRecovery(f.port);
  recovery.observe(401); recovery.dispose(); finish();
  await tick(); assert.equal(f.reloads(), 0);
});

test('selected server scopes its fence independently', async () => {
  const f = fixture(); createBrowserAdmissionRecovery(f.port).observe(401); await tick();
  createBrowserAdmissionRecovery({ ...f.port, key: 'other-server' }).observe(401);
  await tick(); assert.equal(f.reloads(), 2);
});
