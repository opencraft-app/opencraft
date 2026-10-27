import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture({ scope = 'https://example.test/', failAsset = false } = {}) {
  const cachesByName = new Map(), handlers = new Map(), fetched = [];
  let network = true, responseStatus = 200;
  const cacheApi = { async open(name) {
    if (!cachesByName.has(name)) cachesByName.set(name, new Map());
    const rows = cachesByName.get(name);
    return { async put(key, response) { rows.set(String(key), response.clone()); }, async match(key) { return rows.get(String(key))?.clone(); } };
  }, async keys() { return [...cachesByName.keys()]; }, async delete(name) { return cachesByName.delete(name); } };
  const fetcher = async (request, options) => {
    const url = typeof request === 'string' ? request : request.url;
    fetched.push({ url, options });
    if (!network || (failAsset && url.endsWith('a.js'))) throw new Error('offline');
    return new Response(url.endsWith('.html') ? '<html><head></head><body>Application shell</body></html>' : 'static', { status: responseStatus,
      headers: { 'content-type': url.endsWith('.html') ? 'text/html' : 'text/javascript' } });
  };
  const self = { registration: { scope }, addEventListener: (type, handler) => handlers.set(type, handler),
    clients: { get: async id => ({ id, url: scope }), claim: async () => {} }, skipWaiting: () => assert.fail('must preserve the old document build') };
  const source = readFileSync(new URL('../../apps/workbench-web/offline-shell-worker.js', import.meta.url), 'utf8')
    .replace('"__OPENCRAFT_BUILD__"', '"new"').replace('"__OPENCRAFT_FILES__"', JSON.stringify(['assets/a.js', 'opencraft-icon.svg', 'opencraft-offline.html']));
  runInNewContext(source, { self, caches: cacheApi, fetch: fetcher, URL, Response, Set, Promise, Error });
  const emit = async (type, event = {}) => {
    let pending; handlers.get(type)({ ...event, waitUntil: value => { pending = value; } }); await pending;
  };
  const request = async (path, mode = 'navigate', method = 'GET') => {
    let result; handlers.get('fetch')({ request: { url: new URL(path, scope).href, method, mode }, respondWith: value => { result = value; } });
    return result ? await result : null;
  };
  const configure = async (data = {}) => {
    let ack;
    await emit('message', { source: { id: 'document' }, data: { type: 'opencraft-offline-configure', buildId: 'new', ...data }, ports: [{ postMessage: value => { ack = value; } }] });
    return ack;
  };
  return { cacheApi, cachesByName, fetched, emit, request, configure, offline: () => { network = false; }, status: value => { responseStatus = value; } };
}

test('offline shell caches public build files and sanitized configuration; API/auth never receive navigation fallback', async () => {
  const f = fixture(); await f.emit('install');
  assert.ok(f.fetched.every(row => row.options.credentials === 'omit' && row.options.redirect === 'error'));
  const ack = await f.configure({ deployment: { hosts: [{ hostId: 'host', label: 'Host', kind: 'durable', url: '/appserver', token: 'must-not-cache' }], builtinAgents: true, hypernode: false, credential: 'must-not-cache' } });
  assert.equal(ack.ok, true); f.offline();
  const response = await f.request('local/thread?hostId=host');
  const html = await response.text();
  assert.match(html, /Application shell/); assert.match(html, /opencraft-deployment-config/); assert.doesNotMatch(html, /must-not-cache|credential|token/);
  assert.equal(response.headers.get('x-opencraft-offline-build'), 'new');
  assert.equal(await f.request('__opencraft_account/status', 'cors'), null);
  assert.equal(await f.request('login'), null);
  assert.equal(await f.request('assets/a.js', 'cors', 'POST'), null);
  assert.equal(await (await f.request('assets/a.js', 'cors')).text(), 'static');
});

test('explicit online account denial is never replaced with cached HTML; configuration rejects private endpoint URLs and scope mismatch', async () => {
  const f = fixture(); await f.emit('install'); await f.configure();
  f.status(401); assert.equal((await f.request(''))?.status, 401);
  assert.equal((await f.configure({ deployment: { hosts: [{ hostId: 'host', label: 'Host', kind: 'durable', url: '/appserver?token=private' }] } })).ok, false);
  assert.equal((await f.configure({ server: { id: 'other', name: 'Other', selectorPath: '/servers', basePath: '/servers/other' } })).ok, false);
  assert.equal(await f.configure({ buildId: 'old' }), undefined);
});

test('activation cleans only this deployment old shell caches; failed installation preserves the old build', async () => {
  const f = fixture();
  const prefix = 'opencraft-shell-v1:https://example.test/:';
  await f.cacheApi.open(prefix + 'old'); await f.cacheApi.open('opencraft-push'); await f.cacheApi.open('opencraft-shell-v1:https://example.test/servers/other/:old');
  await f.emit('install'); await f.emit('activate');
  assert.equal(f.cachesByName.has(prefix + 'old'), false); assert.equal(f.cachesByName.has(prefix + 'new'), true);
  assert.equal(f.cachesByName.has('opencraft-push'), true); assert.equal(f.cachesByName.has('opencraft-shell-v1:https://example.test/servers/other/:old'), true);
  const failed = fixture({ failAsset: true }); await failed.cacheApi.open(prefix + 'old');
  await assert.rejects(failed.emit('install'), /offline/);
  assert.equal(failed.cachesByName.has(prefix + 'old'), true); assert.equal(failed.cachesByName.has(prefix + 'new'), false);
});


test('a waiting upgrade retains sanitized deployment bootstrap for its first offline navigation', async () => {
  const f = fixture({ scope: 'https://example.test/servers/fixture/' });
  const old = await f.cacheApi.open('opencraft-shell-v1:https://example.test/servers/fixture/:old');
  await old.put('https://example.test/servers/fixture/opencraft-offline-configuration', Response.json({
    deployment: { hosts: [{ hostId: 'remote', label: 'Remote', kind: 'durable', url: '/appserver', token: 'private' }], credential: 'private' },
    server: { id: 'fixture', name: 'Fixture', selectorPath: '/servers', basePath: '/servers/fixture' },
  }));
  await f.emit('install'); await f.emit('activate'); f.offline();
  const response = await f.request('local/thread');
  assert.equal(response.headers.get('x-opencraft-offline-build'), 'new');
  const html = await response.text();
  assert.match(html, /opencraft-server-context/); assert.doesNotMatch(html, /private|credential|token/);
  assert.equal(await f.request('/servers/other/local/thread'), null);
  assert.equal((await f.request('/opencraft-icon.svg', 'cors')).status, 200, 'declared branding aliases remain available in a subdeployment');
});
