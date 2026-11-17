import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../../apps/workbench-web/offline-shell-worker.js', import.meta.url), 'utf8');
const scope = 'https://example.test/servers/fixture/';
const prefix = `opencraft-shell-v1:${scope}:`;
const marker = scope + 'opencraft-offline-installation';
const html = 'opencraft-offline.html';
const hashed = 'assets/main-ABC12345.js';
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ files = [hashed, html], build = 'new', stores = new Map(), fetcher, put } = {}) {
  const handlers = new Map(), timers = new Map(), fetched = [];
  let serial = 0, claims = 0;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const rows = stores.get(name);
      return {
        async match(key) { return rows.get(String(key))?.clone(); },
        async put(key, response) {
          await put?.(name, String(key), response);
          // A real Cache.put consumes the body, unlike a Map of response clones.
          const body = await response.arrayBuffer();
          rows.set(String(key), new Response(body, {status: response.status, headers: response.headers}));
        },
      };
    },
  };
  const self = {registration: {scope}, addEventListener: (name, fn) => handlers.set(name, fn),
    clients: {claim: async () => { claims++; }}, skipWaiting: () => assert.fail('existing documents must keep their worker')};
  runInNewContext(template.replace('"__OPENCRAFT_BUILD__"', JSON.stringify(build)).replace('"__OPENCRAFT_FILES__"', JSON.stringify(files)), {
    self, caches, URL, Response, AbortController, Set, Promise, Error,
    fetch: async (url, options) => {
      fetched.push({url, options});
      return await fetcher?.(url, options) ?? new Response('artifact', {headers: {'content-type': url.endsWith('.html') ? 'text/html' : 'application/javascript'}});
    },
    setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, {fn, ms}); if (ms < 30000) queueMicrotask(() => { if (timers.delete(id)) fn(); }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return {stores, caches, fetched, timers, claims: () => claims,
    async emit(name) { let pending; handlers.get(name)({waitUntil: p => {pending = p;}}); await pending; },
    expire() { for (const [id, timer] of [...timers]) { if (timer.ms === 30000) { timers.delete(id); timer.fn(); } } },
  };
}
async function seed(f, build, state) {
  const cache = await f.caches.open(prefix + build);
  if (state !== undefined) await cache.put(marker, Response.json(state));
  return cache;
}
async function state(f, build = 'new') { return await (await (await f.caches.open(prefix + build)).match(marker)).json(); }

test('failed staged build cannot activate; next install reuses immutable successes, not mutable HTML', async () => {
  let denied = true;
  const f = fixture({files: [hashed, html, 'assets/missing.js'], fetcher: async url => {
    if (url.endsWith('missing.js') && denied) return new Response('denied', {status: 404});
  }});
  const old = await seed(f, 'active', {complete: true, active: true});
  await old.put(scope + hashed, new Response('old immutable'));
  await assert.rejects(f.emit('install'), /denied/);
  assert.equal((await state(f)).complete, false);
  await assert.rejects(f.emit('activate'), /incomplete/);
  assert.equal(f.claims(), 0); assert.ok(f.stores.has(prefix + 'active'));
  denied = false; const first = f.fetched.length; await f.emit('install');
  assert.equal(f.fetched.slice(first).filter(x => x.url.endsWith(hashed)).length, 0);
  assert.ok(f.fetched.slice(first).some(x => x.url.endsWith(html)));
  assert.equal((await state(f)).complete, true);
  assert.equal((await state(f)).active, false);
  await f.emit('activate'); assert.equal(f.claims(), 1); assert.equal((await state(f)).active, true);
});

test('only one older partial is retained; active and legacy builds and other deployments survive failure', async () => {
  const f = fixture({fetcher: async () => new Response('denied', {status: 403})});
  await seed(f, 'active', {complete: true, active: true}); await seed(f, 'legacy');
  await seed(f, 'partial-old', {complete: false, active: false, createdAt: 1});
  await seed(f, 'partial-recent', {complete: false, active: false, createdAt: 2});
  await seed(f, 'waiting', {complete: true, active: false, createdAt: 3});
  f.stores.set('opencraft-shell-v1:https://example.test/servers/other/:old', new Map());
  f.stores.set('opencraft-push', new Map());
  await assert.rejects(f.emit('install'), /denied/);
  assert.equal(f.stores.has(prefix + 'partial-old'), false); assert.equal(f.stores.has(prefix + 'partial-recent'), false);
  for (const name of ['active', 'legacy', 'waiting', 'new']) assert.ok(f.stores.has(prefix + name), name);
  assert.ok(f.stores.has('opencraft-push')); assert.ok(f.stores.has('opencraft-shell-v1:https://example.test/servers/other/:old'));
});

test('cached immutable reuse is scope-local and rejects HTML or unsuccessful responses', async () => {
  for (const response of [new Response('login', {headers: {'content-type': 'text/html'}}), new Response('missing', {status: 404})]) {
    const f = fixture(); const cache = await seed(f, 'active', {complete: true, active: true});
    await cache.put(scope + hashed, response);
    const other = await f.caches.open('opencraft-shell-v1:https://example.test/servers/other/:old');
    await other.put(scope + hashed, new Response('foreign'));
    await f.emit('install'); assert.ok(f.fetched.some(x => x.url.endsWith(hashed)));
    for (const row of f.fetched) {
      assert.equal(row.options.credentials, 'omit'); assert.equal(row.options.redirect, 'error'); assert.equal(row.options.priority, 'low');
    }
  }
});

test('transient responses retry at most three times; denied responses and quota errors never retry', async () => {
  for (const status of [401, 403, 404, 408, 429, 503]) {
    const f = fixture({files: [hashed], fetcher: async () => new Response('no', {status})});
    await assert.rejects(f.emit('install'));
    assert.equal(f.fetched.length, [408, 429, 503].includes(status) ? 3 : 1, String(status));
    assert.equal(f.timers.size, 0);
  }
  let attempts = 0;
  const f = fixture({files: [hashed], put: async (_cache, key) => {
    if (key.endsWith(hashed)) { attempts++; throw Object.assign(new Error('quota'), {name: 'QuotaExceededError'}); }
  }});
  await assert.rejects(f.emit('install'), /quota/); assert.equal(attempts, 1); assert.equal(f.timers.size, 0);
});

test('first terminal failure stops sibling download and never admits more than two concurrent resources', async () => {
  let started = 0, aborted = 0;
  const f = fixture({files: [hashed, 'assets/second.js', 'assets/third.js', html], fetcher: async (url, options) => {
    started++;
    if (url.endsWith(hashed)) { await turn(); return new Response('denied', {status: 403}); }
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {aborted++; reject(new Error('aborted'));}, {once: true}));
  }});
  await assert.rejects(f.emit('install'), /denied/); assert.equal(started, 2); assert.equal(aborted, 1); assert.equal(f.timers.size, 0);
});

test('deadline includes a stalled response body, and no partial build can claim clients', async () => {
  const f = fixture({files: [hashed], fetcher: async (_url, {signal}) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(new Error('body deadline')), {once: true}); },
  }))});
  const pending = assert.rejects(f.emit('install'), /deadline/);
  for (let i = 0; i < 3; i++) { await turn(); f.expire(); await turn(); }
  await pending; await assert.rejects(f.emit('activate'), /incomplete/); assert.equal(f.claims(), 0); assert.equal(f.timers.size, 0);
});

test('deadline also bounds a cache write that ignores fetch abortion', async () => {
  const f = fixture({files: [hashed], put: async (_cache, key) => { if (key.endsWith(hashed)) await new Promise(() => {}); }});
  const pending = assert.rejects(f.emit('install'), /deadline/);
  for (let i = 0; i < 3; i++) { await turn(); f.expire(); await turn(); }
  await pending; assert.equal((await state(f)).complete, false); assert.equal(f.claims(), 0);
});
