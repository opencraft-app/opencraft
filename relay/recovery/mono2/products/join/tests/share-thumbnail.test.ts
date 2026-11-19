import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { installJoinShareThumbnail } from '../share-thumbnail';
import { installJoinCanonicalRedirect } from '../relay-canonical-redirect';
import branding from '../plugins/join/branding.json';

test('Join share JPEG is anonymously readable while adjacent resources remain protected', async t => {
  const server = createServer((_req, res) => { res.writeHead(401); res.end('employee authentication required'); });
  const upgrade = () => {}; server.on('upgrade', upgrade);
  installJoinShareThumbnail(server); installJoinCanonicalRedirect(server);
  assert.deepEqual(server.listeners('upgrade'), [upgrade]);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const query = (path: string, method = 'GET', extra = {}) => new Promise<{ status: number; headers: any; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers: { host: 'join.woa.com', ...extra } }, res => {
      const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  assert.equal(branding.share.publicOrigin, 'https://join.woa.com');
  const path = branding.share.imageUrl;
  const image = await query(path);
  assert.equal(image.status, 200); assert.equal(image.headers['content-type'], 'image/jpeg');
  assert.equal(image.headers['set-cookie'], undefined); assert.equal(image.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(image.body, readFileSync(new URL('../plugins/join/public/joinvela-mascot-share-512.jpg', import.meta.url)));
  assert.equal(Number(image.headers['content-length']), image.body.length);
  const head = await query(path, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], image.headers['content-length']);
  const cached = await query(path, 'GET', { 'if-none-match': image.headers.etag }); assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  assert.equal((await query(path + '?v=2')).status, 200);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await query(path, method)).status, 405);
  for (const route of ['/', '/local/thread', '/apphost', '/__opencraft_enterprise_identity/session', '/plugin-assets/join/manifest.webmanifest', path + '/extra', path.replace('join-share', '%6aoin-share'), '/plugin-assets/join/../secret']) assert.equal((await query(route)).status, 401, route);
  const legacy = await query(path, 'GET', { host: 'join.devcloud.woa.com' }); assert.equal(legacy.status, 308); assert.equal(legacy.headers.location, 'https://join.woa.com' + path);
});
