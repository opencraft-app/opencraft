import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createHeadlessBackendProxy, isHeadlessBackendPath, validHeadlessBackendRoutes, headlessBackendRoutes } from '../../scripts/web-deployment/headless-backend.mjs';

test('a bodyless admission probe strips POST framing and preserves a reused HTTP connection', async t => {
  const errors = [], calls = [], framing = [];
  const backend = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/__opencraft_access/admission') {
      framing.push({ contentLength: req.headers['content-length'] ?? null, transferEncoding: req.headers['transfer-encoding'] ?? null });
      res.writeHead(204); res.end();
    } else { req.resume(); res.writeHead(200); res.end('ok'); }
  });
  backend.on('clientError', (error, socket) => { errors.push(error.code); socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const proxy = createHeadlessBackendProxy(`http://127.0.0.1:${backend.address().port}`);
  const front = createServer(async (req, res) => {
    if (req.url === '/probe') { if (await proxy.admitDocument(req, res)) { res.writeHead(200); res.end('admitted'); } }
    else proxy.http(req, res, () => {});
  });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(async () => { for (const server of [front, backend]) { server.closeAllConnections(); await new Promise(r => server.close(r)); } });
  const call = (path, body = '') => new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${front.address().port}${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-length': Buffer.byteLength(body) } : {} }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end(body);
  });
  const cleanProbe = await call('/probe'), cleanRequest = await call('/actual', '{"synthetic":true}');
  const framedProbe = await call('/probe', '{"synthetic":true}'), nextRequest = await call('/actual', '{"synthetic":true}');
  console.log(JSON.stringify({ cleanProbe, cleanRequest, framedProbe, nextRequest, framing, parserErrors: errors, backendCalls: calls }));
  assert.equal(cleanRequest, 200); assert.equal(nextRequest, 200);
  assert.deepEqual(errors, []);
  assert.deepEqual(framing, Array(2).fill({ contentLength: null, transferEncoding: null }));
});


test('readiness route tables are bounded, scoped and keep legacy defaults', () => {
  assert.equal(validHeadlessBackendRoutes(headlessBackendRoutes), true);
  assert.equal(isHeadlessBackendPath('/__opencraft_connectors'), true);
  assert.equal(isHeadlessBackendPath('/__opencraft_connectors_extra'), false);
  assert.equal(isHeadlessBackendPath('/__opencraft_future'), false);
  const future = { ...headlessBackendRoutes, prefixes: ['/__opencraft_future'], upgrade: ['/future-stream'] };
  assert.equal(isHeadlessBackendPath('/__opencraft_future/sub', false, future), true);
  assert.equal(isHeadlessBackendPath('/future-stream', true, future), true);
  for (const bad of [null, {}, { ...future, prefixes: ['//elsewhere'] }, { ...future, http: ['/bad?query'] }, { ...future, upgrade: Array(65).fill('/too-many') }]) assert.ok(!validHeadlessBackendRoutes(bad));
});


async function previewProxy(t, handler) {
  const backend = createServer(handler); backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  let released = 0;
  const proxy = createHeadlessBackendProxy(`http://127.0.0.1:${backend.address().port}`);
  const front = createServer((req, res) => proxy.http(req, res, () => released++));
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(async () => { for (const s of [front, backend]) { s.closeAllConnections(); await new Promise(r => s.close(r)); } });
  return { url: `http://127.0.0.1:${front.address().port}`, released: () => released };
}

test('preview document reconnects after a backend reset without dropping credentials', async t => {
  let calls = 0; const cookies = [];
  const f = await previewProxy(t, (req, res) => {
    cookies.push(req.headers.cookie); if (++calls === 1) { req.socket.destroy(); return; }
    res.end('report recovered');
  });
  const result = await fetch(f.url + '/__opencraft_preview/s/' + 'a'.repeat(24) + '/document', { headers: {cookie:'preview=synthetic'} });
  assert.equal(result.status, 200); assert.equal(await result.text(), 'report recovered');
  assert.equal(calls, 2); assert.deepEqual(cookies, Array(2).fill('preview=synthetic'));
});

test('unavailable preview is a non-cacheable readable retry page; ticket POST is not replayed', async t => {
  let calls = 0;
  const f = await previewProxy(t, req => { calls++; req.socket.destroy(); });
  const preview = await fetch(f.url + '/__opencraft_preview/');
  assert.equal(preview.status, 503); assert.match(preview.headers.get('content-type'), /text\/html/u);
  assert.match(preview.headers.get('cache-control'), /no-store/u); assert.match(await preview.text(), /重试加载/u);
  assert.equal(calls, 4);
  for (const path of ['tickets', 'redeem']) {
    const before = calls;
    const result = await fetch(f.url + '/__opencraft_preview/' + path, {method:'POST', body:'{}'});
    assert.equal(result.status, 502); await result.text(); assert.equal(calls, before + 1);
  }
});

test('an authorization rejection is returned as-is without reconnecting', async t => {
  let calls = 0; const f = await previewProxy(t, (_req, res) => { calls++; res.writeHead(403); res.end('denied'); });
  const result = await fetch(f.url + '/__opencraft_preview/');
  assert.equal(result.status, 403); assert.equal(await result.text(), 'denied'); assert.equal(calls, 1);
});


test('closing a preview cancels pending reconnect and releases its lease once', async t => {
  let calls = 0; const controller = new AbortController();
  const f = await previewProxy(t, req => { calls++; req.socket.destroy(); controller.abort(); });
  await assert.rejects(fetch(f.url + '/__opencraft_preview/', {signal:controller.signal}));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, 1); assert.equal(f.released(), 1);
});
