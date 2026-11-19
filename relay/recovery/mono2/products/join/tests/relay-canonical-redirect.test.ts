import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { installJoinCanonicalRedirect } from '../relay-canonical-redirect.ts';

test('legacy Join HTTP requests permanently move to the approved origin without rewriting paths', async () => {
  let delegated = 0;
  const server = createServer((_request, response) => { delegated++; response.writeHead(401); response.end(); });
  const upgrades = () => {};
  server.on('upgrade', upgrades);
  installJoinCanonicalRedirect(server);
  assert.deepEqual(server.listeners('upgrade'), [upgrades]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const query = (host: string, path = '/', method = 'GET', headers = {}) => new Promise<{ status: number | undefined; location: string | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: address.port, path, method, headers: { host, ...headers } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value; });
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }));
    });
    request.on('error', reject); request.end(method === 'POST' ? 'example' : undefined);
  });
  try {
    for (const host of ['join.devcloud.woa.com', 'JOIN.DEVCLOUD.WOA.COM', 'join.devcloud.woa.com:80', 'join.devcloud.woa.com:443']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const path = '/servers/lighthouse/chat/%E4%B8%AD?thread=a%2Fb&x=1&x=2';
        assert.deepEqual(await query(host, path, method), { status: 308, location: `https://join.woa.com${path}`, body: '' });
      }
    }
    assert.equal((await query('join.devcloud.woa.com')).location, 'https://join.woa.com/');
    assert.equal((await query('join.devcloud.woa.com', '//evil.test/path')).location, 'https://join.woa.com//evil.test/path');
    for (const host of ['join.woa.com', 'lighthouse.join.woa.com', 'join.devcloud.woa.com.evil.test', 'eviljoin.devcloud.woa.com', 'join.devcloud.woa.com:8080', '127.0.0.1']) {
      assert.deepEqual(await query(host, '/', 'GET', { 'x-forwarded-host': 'join.devcloud.woa.com' }), { status: 401, location: undefined, body: '' });
    }
    assert.equal(delegated, 6);
  } finally { server.close(); await once(server, 'close'); }
});
