import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTencentOaModelDefaults } from '../../plugins/tencentoa/src/model-defaults-composition.mjs';

const selection = { model: 'gpt-6.1-sol', effort: 'high', serviceTier: 'fast' };
test('product composition serves account defaults, scopes by employee/Host, persists and preserves base lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'join-model-defaults-'));
  let closed = 0, delegated = 0;
  const base = { createIdentity: async () => ({
    sshAccess: { preserved: true },
    getStorageOutcomes: () => [{ name: 'fixture', status: 'ready' }],
    service: { handle: () => { delegated++; return false; }, connectionContext: () => 'preserved' },
    close: async () => { closed++; },
  }) };
  const context = { dataDirectory: directory,
    resolveIdentity: (request: any) => request.headers['x-test-user'] ? {
      provider: 'tencentoa', subject: request.headers['x-test-user'], displayName: 'fixture',
      attributes: { loginName: 'fixture' }, expiresAt: Date.now() + 60_000,
    } : null,
    getInstanceAccess: () => ({ admissionStatus: (request: any) => !request.headers['x-test-user'] ? 401 : request.headers['x-test-denied'] ? 403 : 204 }),
  };
  let identity: any, server: ReturnType<typeof createServer> | undefined;
  const start = async () => {
    identity = await withTencentOaModelDefaults(base).createIdentity(context);
    server = createServer((request, response) => {
      if (!identity.service.handle(request, response)) { response.writeHead(404); response.end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (server.address() as any).port;
  };
  const stop = async () => {
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await identity.close(); await identity.close(); server = undefined;
  };
  try {
    let origin = await start();
    const request = async (user = '100', host = 'host-a', write?: any, extra: Record<string, string> = {}) => {
      const response = await fetch(origin + '/__opencraft_enterprise_identity/model-defaults?hostId=' + host, {
        method: write ? 'POST' : 'GET', headers: {
          'x-test-user': user, 'x-opencraft-account-scope': 'tencentoa:' + user,
          ...(write ? { 'content-type': 'application/json', origin } : {}), ...extra,
        }, ...(write ? { body: JSON.stringify(write) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal(identity.sshAccess.preserved, true);
    assert.equal(identity.service.connectionContext(), 'preserved');
    assert.equal(identity.getStorageOutcomes().at(-1).name, 'account-model-defaults');
    assert.deepEqual((await request()).body.record, { revision: 0, selection: null });
    assert.equal((await request('', 'host-a')).status, 401);
    assert.equal((await request('100', 'host-a', undefined, { 'x-test-denied': '1' })).status, 403);
    assert.equal((await request('100', 'host-a', undefined, { 'x-opencraft-account-scope': 'tencentoa:200' })).status, 409);
    assert.equal((await request('100', '', undefined)).status, 400);
    assert.equal((await request('100', 'host-a', { revision: 0, selection })).status, 200);
    assert.equal((await request('100', 'host-a', { revision: 0, selection })).status, 409);
    assert.deepEqual((await request('200')).body.record, { revision: 0, selection: null });
    assert.deepEqual((await request('100', 'host-b')).body.record, { revision: 0, selection: null });
    assert.equal((await fetch(origin + '/not-account-defaults')).status, 404);
    assert.equal(delegated, 1);
    await stop(); assert.equal(closed, 1);
    origin = await start();
    assert.deepEqual((await request()).body.record, { revision: 1, selection });
    await stop(); assert.equal(closed, 2);
  } finally {
    if (server) await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
