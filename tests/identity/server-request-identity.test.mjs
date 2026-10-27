import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { build } from 'esbuild';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { createHeadlessBackendProxy } from '../../scripts/web-deployment/headless-backend.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'request-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Generic workbench</title>');
  const web = await createWorkbenchWebServer({ root, appServerTarget: null, ...options });
  t.after(() => web.close());
  const address = await web.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  return { root, web, origin };
}

test('generic identity owns its routes; document admission needs no private identity plugin', async t => {
  const provider = {
    admissionStatus: request => request.headers['x-test-proof'] === 'verified' ? 204 : 401,
    connectionContext: () => ({ sender: null }),
    handle(request, response) {
      if (request.url !== '/__opencraft_example/session') return false;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"verified":true}'); return true;
    },
  };
  const { origin } = await fixture(t, { identityService: provider });
  assert.equal((await fetch(origin + '/__opencraft_example/session')).status, 401);
  const headers = { 'x-test-proof': 'verified' };
  assert.deepEqual(await (await fetch(origin + '/__opencraft_example/session', { headers })).json(), { verified: true });
  assert.equal((await fetch(origin + '/__opencraft_access/admission', { headers })).status, 204);
  assert.equal((await fetch(origin + '/__opencraft_example/missing', { headers: { ...headers, accept: 'text/html' } })).status, 404);
  assert.equal((await fetch(origin + '/__opencraft_health')).status, 200);

  const anonymous = await fixture(t);
  const proxy = createHeadlessBackendProxy(anonymous.origin);
  const front = createServer(async (request, response) => {
    if (await proxy.admitDocument(request, response)) response.end('Anonymous document admitted');
  });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(() => new Promise(resolve => front.close(resolve)));
  assert.equal(await (await fetch(`http://127.0.0.1:${front.address().port}`)).text(), 'Anonymous document admitted');
});

test('generic connection proof expires even when instance membership has a later deadline', { timeout: 10_000 }, async t => {
  const deadline = Date.now() + 1200;
  const principal = { provider: 'example', subject: 'human', expiresAt: Date.now() + 60_000 };
  const accessService = {
    admissionStatus: () => 204, authenticate: () => principal,
    role: () => 'member', trustedOrigin: () => null, watch: () => () => {},
    handle: async () => false,
  };
  const { origin } = await fixture(t, {
    identityService: { admissionStatus: () => 204, connectionContext: () => ({ sender: null, validUntil: deadline }), handle: () => false },
    accessService,
    desktopService: { accept: () => {}, close: () => {} },
    desktopAccess: 'trusted-internal',
  });
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/desktop/connect', { origin });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const [code] = await once(socket, 'close');
  assert.equal(code, 1008);
  assert.ok(Date.now() >= deadline);
});

test('missing, expired, invalid or throwing connection proof rejects upgrade without crashing the gateway', async t => {
  let proof = null;
  const { origin } = await fixture(t, { identityService: {
    admissionStatus: () => 204,
    connectionContext: () => { if (proof === 'throw') throw new Error('Synthetic provider failure'); return proof; },
    handle: () => false,
  } });
  for (const [value, status] of [[null, 401], [{ sender: null, validUntil: Date.now() - 1 }, 401], [{ sender: null, validUntil: NaN }, 503], ['throw', 503]]) {
    proof = value;
    for (const path of ['/apphost', '/ssh-apphost', '/appserver', '/desktop/connect']) {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + path);
      await assert.rejects(once(socket, 'open'), new RegExp(String(status)));
      socket.terminate();
    }
    assert.equal((await fetch(origin + '/__opencraft_health')).status, 200);
  }
});

test('obsolete or incomplete server identity configuration cannot silently enable anonymous access', async t => {
  const { root, origin } = await fixture(t);
  await assert.rejects(createWorkbenchWebServer({ root, tencentOaService: {} }), /Unknown workbench gateway option/);
  await assert.rejects(createWorkbenchWebServer({ root, identityService: {} }), /Invalid request identity service/);
  const response = await fetch(origin + '/__opencraft_enterprise_identity/session', { headers: { accept: 'text/html' } });
  assert.equal(response.status, 404);
});

test('standalone generic gateway bundles without any product identity module or private endpoint', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['scripts/serve-workbench-web.mjs'],
    bundle: true, platform: 'node', format: 'esm', write: false, metafile: true,
    external: ['ws'],
  });
  assert.ok(Object.keys(result.metafile.inputs).length > 1);
  for (const input of Object.keys(result.metafile.inputs)) assert.doesNotMatch(input, /plugins\//u);
  assert.doesNotMatch(result.outputFiles[0].text, /plugin-enterprise-identity|__opencraft_enterprise_identity|identityValidUntil/u);
});
