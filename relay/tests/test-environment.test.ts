import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { createTestEnvironmentIngress } from '../test-environment.js';

test('test environment ingress retains session scoping, route allowlist and JSON validation', async t => {
  const requests: { path: string; cookie?: string }[] = [];
  const upstream = createServer((req, res) => {
    requests.push({ path: req.url!, cookie: req.headers.cookie });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private=1' });
    res.end('{}');
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const origin = 'http://127.0.0.1:' + (upstream.address() as { port: number }).port;
  const ingress = createTestEnvironmentIngress(origin, async req => req.headers.cookie ? {
    principal: { provider: 'tencentoa', subject: 'fixture', displayName: 'Fixture', expiresAt: Date.now() + 60_000 }, origin: 'https://join.woa.com',
  } : null);
  const server = createServer((req, res) => { if (!ingress(req, res)) { res.writeHead(418); res.end(); } }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); });
  const port = (server.address() as { port: number }).port;
  const prefix = '/__join_lightvela_test_environments/';
  const cookie = '__Host-opencraft-relay-session=' + 'a'.repeat(43) + '; unrelated=private';
  const query = (path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: 'join.woa.com', ...headers } }, res => {
      assert.equal(res.headers['set-cookie'], undefined);
      res.resume(); res.once('end', () => resolve(res.statusCode!));
    });
    req.once('error', reject); req.end(body);
  });
  assert.equal(await query('/unrelated'), 418);
  assert.equal(await query(prefix + 'capabilities'), 401);
  assert.equal(await query(prefix + 'capabilities', { cookie, host: 'evil.test' }), 403);
  assert.equal(await query(prefix + 'capabilities', { cookie, origin: 'https://evil.test' }), 403);
  assert.equal(await query(prefix + 'capabilities?extra=1', { cookie }), 404);
  assert.equal(await query(prefix + 'enter', { cookie }), 405);
  assert.equal(await query(prefix + 'capabilities', { cookie }), 200);
  assert.equal(requests[0]!.cookie, undefined);
  assert.equal(await query(prefix + 'environments', { cookie }), 200);
  assert.equal(requests[1]!.cookie, cookie.split(';')[0]);
  assert.equal(await query(prefix + 'enter', { cookie }, 'POST'), 403);
  const body = '{"environmentId":"fixture"}';
  assert.equal(await query(prefix + 'enter', { cookie, origin: 'https://join.woa.com', 'x-lightvela-test-entry': '1', 'content-type': 'application/json', 'content-length': String(body.length) }, 'POST', body), 200);
});
