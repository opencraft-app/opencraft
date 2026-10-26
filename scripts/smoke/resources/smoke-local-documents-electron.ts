import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launchIsolatedElectron } from '../../support/isolated-electron';
const root = await mkdtemp(join(tmpdir(), 'oc-offline-electron-'));
const output = resolve(process.env.OPENCRAFT_OFFLINE_EVIDENCE ?? '.local/offline-electron');
await mkdir(output, { recursive: true });
let app: Awaited<ReturnType<typeof launchIsolatedElectron>> | undefined;
const origins: string[] = [];
try {
  app = await launchIsolatedElectron(root); origins.push(new URL(app.page.url()).origin);
  const first = await app.page.evaluate(async () => {
    const port = (window as any).opencraftDesktop.clientResources;
    const rows = ['conversation-draft', 'composer-draft', 'conversation-outbox'];
    const result = [];
    for (const name of rows) {
      const key = { namespace: 'fixture-account', name, id: 'original', authority: 'local' };
      result.push(await port.compareAndSet(key, 0, { version: 1, savedAt: 1, value: JSON.stringify({ fixture: name, input: 'retained' }) }));
      result.push(await port.compareAndSet(key, 0, { version: 1, savedAt: 2, value: 'must reject stale peer' }));
    }
    await port.clearRemoteNamespace('fixture-account');
    return result;
  });
  assert.deepEqual(first, [true, false, true, false, true, false]);
  await app.stop(); app = undefined;
  app = await launchIsolatedElectron(root); origins.push(new URL(app.page.url()).origin);
  assert.notEqual(origins[0], origins[1]);
  const restored = await app.page.evaluate(async () => {
    const port = (window as any).opencraftDesktop.clientResources;
    const values = [];
    for (const name of ['conversation-draft', 'composer-draft', 'conversation-outbox']) {
      const key = { namespace: 'fixture-account', name, id: 'original', authority: 'local' };
      values.push((await port.read(key))?.value);
      if (await port.read({ ...key, namespace: 'another-account' }) !== null) throw new Error('Cross-account leak');
    }
    await port.clearLocalResource('fixture-account', 'conversation-outbox');
    if ((await port.listLocalKeys('fixture-account', 'conversation-outbox')).length) throw new Error('Local cleanup failed');
    if ((await port.listLocalKeys('fixture-account', 'conversation-draft')).length !== 1) throw new Error('Cleanup deleted draft');
    let rejected = false;
    try { await port.clearLocalResource('fixture-account', 'arbitrary-domain'); } catch { rejected = true; }
    if (!rejected) throw new Error('Arbitrary domain admitted');
    return values;
  });
  assert.deepEqual(restored, ['conversation-draft', 'composer-draft', 'conversation-outbox'].map(fixture => JSON.stringify({ fixture, input: 'retained' })));
  const proof = { root, origins, checks: ['actual Main/Preload named originals', 'stale CAS rejected', 'native process/loopback origin restart', 'remote cleanup retains originals', 'local cleanup isolated by owner', 'other account empty', 'unknown domain rejected'] };
  await writeFile(join(output, 'proof.json'), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally { await app?.stop(); }
