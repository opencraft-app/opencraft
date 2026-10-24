import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachDshHost, readDshHostIdentity } from '../../scripts/server-deployment/dsh-host-client.mjs';

test('independent DSH identity is observable before any lazy engine attachment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'independent-dsh-health-'));
  const path = join(directory, 'descriptor.json');
  let health = { ok: true, engine: 'dsh', pid: 21, enginePid: 22, storage: [] };
  let requests = 0;
  const server = createServer((_, response) => { requests++; response.end(JSON.stringify(health)); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const descriptor = { schemaVersion: 1, pid: 21, machineId: 'fixture', dataDirectory: directory,
    websocketUrl: `ws://127.0.0.1:${server.address().port}/rpc?token=synthetic` };
  try {
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    assert.deepEqual(await readDshHostIdentity(path), { pid: 21, enginePid: 22 });
    assert.equal(requests, 1, 'health must not depend on an attached engine client');
    const attachment = await attachDshHost(path, directory, 'fixture');
    assert.deepEqual(await attachment.getIdentity(), await readDshHostIdentity(path));
    health = { ...health, enginePid: 23 };
    assert.deepEqual(await readDshHostIdentity(path), { pid: 21, enginePid: 23 }, 'observations remain fresh for installer continuity checks');
    for (const invalid of [{ ...health, ok: false }, { ...health, pid: 24 }, { ...health, enginePid: 0 }]) {
      health = invalid;
      await assert.rejects(readDshHostIdentity(path), /unavailable/);
    }
  } finally {
    server.closeAllConnections(); await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});
