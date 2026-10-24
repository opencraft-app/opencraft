import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { websiteDeploymentConfig, injectWebsiteDeploymentConfig, createWorkbenchWebServer } from '../../scripts/workbench-web-server.mjs';

const local = { hostId: 'local', label: 'Server', kind: 'remote-control', url: '/appserver' };
const codex = { hostId: 'local-codex', label: 'Server', kind: 'remote-control', url: '/codex-appserver' };
test('worker readiness and metadata stay available while the configured Headless backend is down', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-headless-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'version.json'), JSON.stringify({ buildId: 'candidate' }));
  const backend = createServer();
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${backend.address().port}`;
  await new Promise(resolve => backend.close(resolve));
  const worker = await createWorkbenchWebServer({ root, appServerTarget: null, headlessBackendTarget: target });
  t.after(() => worker.close());
  const base = `http://127.0.0.1:${(await worker.listen({ host: '127.0.0.1', port: 0 })).port}`;
  assert.equal((await fetch(base + '/__opencraft_health')).status, 200);
  assert.equal((await (await fetch(base + '/version.json')).json()).buildId, 'candidate');
  assert.equal((await fetch(base + '/__opencraft_actors/me')).status, 502);
  await assert.rejects(createWorkbenchWebServer({ root, headlessBackendTarget: 'http://external.invalid/' }), /loopback/);
});
test('website derives stable Host identities and activation from configured proxies', () => {
  assert.deepEqual(websiteDeploymentConfig({ appServerTarget: 'ws://private/rpc', codexServerTarget: 'ws://private/codex' }), {
    hosts: [local, codex], builtinAgents: true, hypernode: false,
  });
  assert.deepEqual(websiteDeploymentConfig({}), { hosts: [], builtinAgents: false, hypernode: false });
  assert.deepEqual(websiteDeploymentConfig({ appServerTarget: 'ws://private/rpc' }), { hosts: [local], builtinAgents: true, hypernode: false });
  assert.deepEqual(websiteDeploymentConfig({ codexServerTarget: 'ws://private/codex' }), { hosts: [codex], builtinAgents: true, hypernode: false });
  assert.deepEqual(websiteDeploymentConfig({ appServerTarget: 'ws://private/rpc', hyperNodeUser: 'user' }), {
    hosts: [local], builtinAgents: true, hypernode: false,
  });
});
test('inert config precedes module execution and escapes script terminators', () => {
  const html = injectWebsiteDeploymentConfig('<html><head><script type="module"></script></head></html>', { value: '</script><script>bad</script>' });
  assert.ok(html.indexOf('application/json') < html.indexOf('type="module"'));
  assert.equal((html.match(/<script/g) || []).length, 2);
  assert.ok(html.includes('\\u003c/script>'));
});
test('direct and SPA HTML requests receive uncached config with accurate GET/HEAD lengths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-config-'));
  let server;
  try {
    await writeFile(join(root, 'index.html'), '<html><head></head><body>中文</body></html>');
    await writeFile(join(root, 'app.webmanifest'), JSON.stringify({ name: 'Fixture', icons: [] }));
    await writeFile(join(root, 'embedded.html'), '<p>Standalone document</p>');
    server = await createWorkbenchWebServer({ root, appServerTarget: 'ws://127.0.0.1:9989/rpc', codexServerTarget: 'ws://127.0.0.1:9988/rpc/codex', machineDisplayNames: {'ssh:test':'Server'} });
    const base = `http://127.0.0.1:${(await server.listen({ port: 0 })).port}`;
    for (const path of ['/', '/index.html', '/settings/updates']) {
      const response = await fetch(base + path, { headers: { accept: 'text/html' } });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(response.headers.get('etag'), null);
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(html));
      assert.match(html, /local-codex/);
      assert.match(html, /"machineDisplayNames":\{"ssh:test":"Server"\}/);
      assert.doesNotMatch(html, /9989|9988/);
      const head = await fetch(base + path, { method: 'HEAD', headers: { accept: 'text/html' } });
      assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
      assert.equal(await head.text(), '');
    }
    const manifest = await fetch(base + '/app.webmanifest');
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');
    assert.equal((await manifest.json()).name, 'Fixture');
    assert.equal(await (await fetch(base + '/embedded.html')).text(), '<p>Standalone document</p>');
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});


test('resource recovery gives entry and relative imports fresh URLs without moving the app', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-resource-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), `<html><head><base href="/"><script type="module" src="./assets/entry-AAAA1111.js"></script><link rel="modulepreload" href="/assets/child-BBBB2222.js"></head></html>`);
  await writeFile(join(root, 'assets/entry-AAAA1111.js'), `import './child-BBBB2222.js';`);
  await writeFile(join(root, 'assets/child-BBBB2222.js'), 'export const healthy = true;');
  await writeFile(join(root, 'assets/style-CCCC3333.css'), '.fixture { color: red; }');
  const worker = await createWorkbenchWebServer({ root, appServerTarget: null });
  t.after(() => worker.close());
  const base = `http://127.0.0.1:${(await worker.listen({ host: '127.0.0.1', port: 0 })).port}`;
  const response = await fetch(base + '/local/original-thread?opencraft-resource-recovery=retry-1', { headers: { accept: 'text/html' } });
  const html = await response.text();
  assert.match(html, /<base href="\/">/);
  assert.match(html, /src="\/assets\/recovery-retry-1\/entry-AAAA1111.js"/);
  assert.match(html, /href="\/assets\/recovery-retry-1\/child-BBBB2222.js"/);
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(html));
  const entryUrl = new URL('/assets/recovery-retry-1/entry-AAAA1111.js', base);
  const entry = await fetch(entryUrl);
  assert.equal(await entry.text(), `import './child-BBBB2222.js';`);
  assert.match(entry.headers.get('content-type'), /javascript/);
  const child = await fetch(new URL('./child-BBBB2222.js', entryUrl));
  assert.equal(await child.text(), 'export const healthy = true;');
  const style = await fetch(new URL('./style-CCCC3333.css', entryUrl));
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /^text\/css/);
  assert.equal(await style.text(), '.fixture { color: red; }');
  assert.equal((await fetch(base + '/assets/recovery-retry-1/child-BBBB2222.js.map')).status, 404);
  assert.equal((await fetch(base + '/assets/recovery-retry-1/missing-CCCC3333.js')).status, 404);
  const invalid = await (await fetch(base + '/?opencraft-resource-recovery=%3Cscript%3E')).text();
  assert.doesNotMatch(invalid, /assets\/recovery-/);
});


test('managed Web forwards push enrollment to Headless with authentication and body intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-push-forward-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const backend = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, method: request.method, cookie: request.headers.cookie,
      origin: request.headers.origin, body: Buffer.concat(chunks).toString() });
    response.writeHead(request.headers.cookie ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ enabled: !!request.headers.cookie }));
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => backend.close(resolve)));
  const worker = await createWorkbenchWebServer({ root, appServerTarget: null,
    headlessBackendTarget: `http://127.0.0.1:${backend.address().port}` });
  t.after(() => worker.close());
  const base = `http://127.0.0.1:${(await worker.listen({ host: '127.0.0.1', port: 0 })).port}`;
  assert.equal((await fetch(base + '/__opencraft_push')).status, 401);
  const body = JSON.stringify({ operation: 'subscribe', expectedActorId: 'fixture-human' });
  const response = await fetch(base + '/__opencraft_push', { method: 'POST',
    headers: { cookie: 'fixture-session=synthetic', origin: 'https://workbench.test', 'content-type': 'application/json' }, body });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(requests[1], { path: '/__opencraft_push', method: 'POST', cookie: 'fixture-session=synthetic', origin: 'https://workbench.test', body });
  assert.equal((await fetch(base + '/__opencraft_push-extra')).status, 404);
  assert.equal(requests.length, 2, 'similarly named static paths never reach Headless');
});
