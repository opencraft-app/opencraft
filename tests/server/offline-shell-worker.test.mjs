import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture({ scope = 'https://example.test/', failAsset = false, files = ['assets/a.js', 'opencraft-icon.svg', 'opencraft-offline.html'] } = {}) {
  const cachesByName = new Map(), handlers = new Map(), fetched = [];
  const timers = new Map();
  let timerId = 0, delayed = null;
  let network = true, responseStatus = 200;
  let failure = failAsset;
  const cacheApi = { async open(name) {
    if (!cachesByName.has(name)) cachesByName.set(name, new Map());
    const rows = cachesByName.get(name);
    return { async put(key, response) { rows.set(String(key), response.clone()); }, async match(key) { return rows.get(String(key))?.clone(); } };
  }, async keys() { return [...cachesByName.keys()]; }, async delete(name) { return cachesByName.delete(name); } };
  const fetcher = async (request, options) => {
    const url = typeof request === 'string' ? request : request.url;
    fetched.push({ url, options });
    if (delayed && !options?.credentials) return delayed;
    if (!network || (failure && url.endsWith('a.js'))) throw new Error('offline');
    return new Response(url.endsWith('.html') ? '<html><head></head><body>Application shell</body></html>' : 'static', { status: responseStatus,
      headers: { 'content-type': url.endsWith('.html') ? 'text/html' : 'text/javascript' } });
  };
  const self = { registration: { scope }, addEventListener: (type, handler) => handlers.set(type, handler),
    clients: { get: async id => ({ id, url: scope }), claim: async () => {} }, skipWaiting: () => assert.fail('must preserve the old document build') };
  const source = readFileSync(new URL('../../apps/workbench-web/offline-shell-worker.js', import.meta.url), 'utf8')
    .replace('"__OPENCRAFT_BUILD__"', '"new"').replace('"__OPENCRAFT_FILES__"', JSON.stringify(files));
  runInNewContext(source, { self, caches: cacheApi, fetch: fetcher, URL, Response, Headers, Set, Promise, Error, AbortController,
    setTimeout: (callback, ms) => { const id = ++timerId; if (ms === 500 || ms === 1000) { setTimeout(callback, 10); return id; } timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id) });
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
  return { cacheApi, cachesByName, fetched, emit, request, configure, timers,
    delay: promise => { delayed = promise; },
    timeout: async () => { for (const { callback, ms } of timers.values()) { assert.equal(ms, 8000); await callback(); } },
    fail: value => { failure = value; }, offline: () => { network = false; }, status: value => { responseStatus = value; } };
}

test('slow navigation returns the complete cached shell after eight seconds and clears fast-network timers', async () => {
  const f = fixture(); await f.emit('install'); await f.configure();
  assert.equal((await f.request('')).status, 200);
  assert.equal(f.timers.size, 0);
  let finish;
  f.delay(new Promise(resolve => { finish = resolve; }));
  const pending = f.request('threads/example');
  await f.timeout();
  assert.equal((await pending).headers.get('x-opencraft-offline-build'), 'new');
  assert.equal(f.timers.size, 0);
  finish(new Response('late network'));
});

test('a navigation without configured cached shell still waits for the network after the deadline', async () => {
  const f = fixture(); await f.emit('install');
  let finish, settled = false;
  f.delay(new Promise(resolve => { finish = resolve; }));
  const pending = f.request('').then(response => { settled = true; return response; });
  await f.timeout(); assert.equal(settled, false);
  finish(new Response('online')); assert.equal(await (await pending).text(), 'online');
});

test('installation reuses only exact hashed assets from the same deployment and refreshes mutable artifacts', async () => {
  const f = fixture({ files: ['assets/main-ABC12345.js', 'assets/a.js', 'opencraft-offline.html'] });
  const old = await f.cacheApi.open('opencraft-shell-v1:https://example.test/:old');
  await old.put('https://example.test/assets/main-ABC12345.js', new Response('immutable'));
  await old.put('https://example.test/assets/a.js', new Response('old mutable'));
  await f.emit('install');
  assert.equal(f.fetched.some(row => row.url.endsWith('main-ABC12345.js')), false);
  assert.equal(f.fetched.some(row => row.url.endsWith('a.js')), true);
  assert.equal(await (await f.request('assets/main-ABC12345.js', 'cors')).text(), 'immutable');
  assert.equal(f.cachesByName.has('opencraft-shell-v1:https://example.test/:old'), true);
});

test('reuse cannot cross deployment boundaries or turn an incomplete update into an installed build', async () => {
  const prefix = 'opencraft-shell-v1:https://example.test/:';
  const f = fixture({ failAsset: true, files: ['assets/main-ABC12345.js', 'assets/a.js', 'opencraft-offline.html'] });
  const old = await f.cacheApi.open(prefix + 'old');
  await old.put('https://example.test/assets/main-ABC12345.js', new Response('immutable'));
  await assert.rejects(f.emit('install'), /offline/);
  assert.equal(f.cachesByName.has(prefix + 'new'), true, 'partial immutable downloads remain staged');
  await assert.rejects(f.emit('activate'), /incomplete/);
  assert.equal(await (await old.match('https://example.test/assets/main-ABC12345.js')).text(), 'immutable');
  const other = fixture({ files: ['assets/main-ABC12345.js', 'opencraft-offline.html'] });
  const foreign = await other.cacheApi.open('opencraft-shell-v1:https://example.test/servers/other/:old');
  await foreign.put('https://example.test/assets/main-ABC12345.js', new Response('foreign'));
  await other.emit('install');
  assert.ok(other.fetched.some(row => row.url.endsWith('main-ABC12345.js')));
});

test('offline shell caches public build files and sanitized configuration; API/auth never receive navigation fallback', async () => {
  const f = fixture(); await f.emit('install');
  assert.ok(f.fetched.every(row => row.options.credentials === 'same-origin' && row.options.redirect === 'error'));
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
  assert.equal(failed.cachesByName.has(prefix + 'old'), true); assert.equal(failed.cachesByName.has(prefix + 'new'), true);
  await assert.rejects(failed.emit('activate'), /incomplete/);
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


test('a failed installation resumes immutable downloads and keeps partial cache storage bounded', async () => {
  const prefix = 'opencraft-shell-v1:https://example.test/:';
  const f = fixture({ failAsset: true, files: ['assets/main-ABC12345.js', 'assets/a.js', 'opencraft-offline.html'] });
  const old = await f.cacheApi.open(prefix + 'old');
  await old.put('https://example.test/opencraft-offline-configuration', Response.json({}));
  for (const [name, createdAt] of [['partial-one', 1], ['partial-two', 2]]) {
    const partial = await f.cacheApi.open(prefix + name);
    await partial.put('https://example.test/opencraft-offline-installation', Response.json({ complete: false, createdAt }));
  }
  await assert.rejects(f.emit('install'), /offline/);
  assert.equal(f.cachesByName.has(prefix + 'partial-one'), false);
  assert.equal(f.cachesByName.has(prefix + 'partial-two'), true);
  assert.equal(f.cachesByName.has(prefix + 'old'), true);
  assert.equal(f.fetched.filter(row => row.url.endsWith('a.js')).length, 3, 'finite per-resource retries');
  assert.equal(f.timers.size, 0, 'failed attempts retire their download timers');
  const downloaded = f.fetched.filter(row => row.url.endsWith('main-ABC12345.js')).length;
  assert.equal(downloaded, 1);
  f.fail(false);
  await f.emit('install');
  assert.equal(f.fetched.filter(row => row.url.endsWith('main-ABC12345.js')).length, downloaded);
  await f.emit('activate');
  assert.equal(f.cachesByName.has(prefix + 'old'), false);
  assert.equal(f.cachesByName.has(prefix + 'partial-two'), false);
});

test('headers with stalled HTML body still fall back to the installed shell', async () => {
 const f=fixture(); await f.emit('install'); await f.configure(); let stream;
 f.delay(Promise.resolve(new Response(new ReadableStream({start(value){stream=value;value.enqueue(new TextEncoder().encode('<html>'));}}),{headers:{'content-type':'text/html'}})));
 const navigation=f.request('threads/example');for(let i=0;i<20;i++)await Promise.resolve();
 await f.timeout();const response=await navigation;assert.equal(response.headers.get('x-opencraft-offline-build'),'new');stream.close();
});


test('background preparation uses authenticated low-priority HTTP-cache-aware requests', async () => {
  const f = fixture(); await f.emit('install');
  assert.ok(f.fetched.every(row => row.options.credentials === 'same-origin' && row.options.cache === 'default' && row.options.priority === 'low'));
});
for (const status of [401, 403, 404]) test('permanent denial stops the entire install without per-file retry: ' + status, async () => {
  const f = fixture({ files: Array.from({ length: 50 }, (_, i) => 'assets/chunk-' + i + '.js') });
  f.status(status);
  await assert.rejects(f.emit('install'), new RegExp(String(status)));
  assert.ok(f.fetched.length <= 2, 'no remaining queued downloads');
  assert.ok(f.fetched.every(row => row.options.signal.aborted), 'sibling downloads are cancelled');
  assert.equal(f.timers.size, 0);
  await assert.rejects(f.emit('activate'), /incomplete/);
});




function navigationClock() {
  const pending = new Map();
  return {
    set(callback) { const id = {}; pending.set(id, callback); return id; },
    delete(id) { return pending.delete(id); },
    async expire() { for (const [id, callback] of [...pending]) { pending.delete(id); await callback(); } },
    get size() { return pending.size; },
  };
}


async function turns() { for (let i = 0; i < 30; i++) await Promise.resolve(); }


test('navigation deadline covers a stalled HTML body and keeps browser backend sanitized', async () => {
  const timers = navigationClock(); let stream, signal;
  const f = fixture({ timers, navigation: (_request, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(value) { stream = value; value.enqueue(new TextEncoder().encode('<html>')); } }), { headers: { 'content-type': 'text/html' } });
  } });
  await f.emit('install'); await f.configure({ browserBackend: 'remote' });
  const pending = f.request('threads/example'); await turns(); await timers.expire();
  const response = await pending;
  assert.equal(response.headers.get('x-opencraft-offline-build'), 'new');
  assert.match(await response.text(), /name="opencraft-browser-backend" content="remote"/);
  assert.equal(signal.aborted, true); assert.equal(timers.size, 0);
  stream.close();
});


test('a deadline without a configured shell keeps waiting for the same network request', async () => {
  const timers = navigationClock(); let finish, signal, settled = false;
  const f = fixture({ timers, navigation: (_request, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await f.emit('install');
  const pending = f.request('').then(value => { settled = true; return value; });
  await turns(); await timers.expire(); await turns();
  assert.equal(settled, false); assert.equal(signal.aborted, false);
  finish(new Response('online', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await (await pending).text(), 'online'); assert.equal(timers.size, 0);
});


test('complete HTML is buffered within budget; oversized or broken bodies fall back', async () => {
  for (const kind of ['complete', 'oversized', 'broken']) {
    const timers = navigationClock();
    const f = fixture({ timers, navigation: () => {
      if (kind === 'broken') return new Response(new ReadableStream({ start(stream) { stream.error(new Error('broken')); } }), { headers: { 'content-type': 'text/html' } });
      return new Response(kind === 'complete' ? '<html>complete</html>' : 'x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '999' } });
    } });
    await f.emit('install'); await f.configure({ browserBackend: '<untrusted>' });
    const response = await f.request('');
    if (kind === 'complete') {
      assert.equal(await response.text(), '<html>complete</html>');
      assert.equal(response.headers.get('content-encoding'), null);
      assert.equal(response.headers.get('content-length'), null);
    } else {
      assert.equal(response.headers.get('x-opencraft-offline-build'), 'new');
      assert.doesNotMatch(await response.text(), /untrusted/);
    }
    assert.equal(timers.size, 0);
  }
});