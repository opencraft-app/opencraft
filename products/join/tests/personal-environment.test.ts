import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { joinIdentityComposition } from '../identity.mjs';
import { TENCENTOA_ENVIRONMENT_PATH } from '../plugins/tencentoa/src/contract';
import { ExecutionEnvironmentRuntime } from '../../../scripts/execution-environment';

test('formal Join composition exposes personal ENV only to admitted identity and shares it with execution owners', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'join-personal-env-'));
  // Boot an independent execution owner before the gateway creates its identity
  // service. Saving ENV later must work without restarting that owner.
  const owner = ExecutionEnvironmentRuntime.open(directory, { create: true })!;
  let admitted = true;
  const resolveIdentity = (request: any) => request.headers['x-fixture-user'] ? ({ provider: 'tencentoa',
    subject: request.headers['x-fixture-user'], displayName: 'Fixture', attributes: { loginName: 'fixture' }, expiresAt: Date.now() + 60_000 }) : null;
  const identity = await joinIdentityComposition().createIdentity({ dataDirectory: directory,
    hubAuthority: { providers: ['tencentoa'] }, resolveIdentity, getInstanceAccess: () => ({ role: () => admitted ? 'member' : null }) });
  const server = createServer((request, response) => { if (!identity.service.handle(request, response)) { response.statusCode = 404; response.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); identity.close(); owner.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as any).port}${TENCENTOA_ENVIRONMENT_PATH}`;
  const request = (user: string, body?: unknown) => fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-fixture-user': user, 'x-opencraft-account-scope': 'tencentoa:' + user, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(url)).status, 401);
  const saved = await request('101', { projectId: null, revision: 0, variables: [{ name: 'SERVICE_KEY', secret: true, value: 'synthetic-join-secret' }] });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).variables[0].value, null);
  assert.deepEqual((await (await request('102')).json()).variables, []);
  const scope = owner.scope({ sender: null, executionPrincipal: { provider: 'tencentoa', subject: '101' }, validUntil: Date.now() + 60_000 }, 'local-codex', {});
  assert.equal(owner.snapshot(scope).overlay().SERVICE_KEY, 'synthetic-join-secret');
  admitted = false;
  assert.equal((await request('101')).status, 401);
});
