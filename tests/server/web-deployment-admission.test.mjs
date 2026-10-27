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
