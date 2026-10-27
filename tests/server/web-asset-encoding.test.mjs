import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync } from 'node:zlib';
import { request } from 'node:http';
import { createWorkbenchWebServer } from '../../scripts/workbench-web-server.mjs';
const get = (url, encoding, method = 'GET') => new Promise((resolve, reject) => {
  const req = request(url, { method, headers: { 'accept-encoding': encoding } }, res => {
    const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }); req.on('error', reject); req.end();
});
test('immutable sidecars negotiate gzip/br/q-values, preserve MIME/cache and support HEAD without runtime compression', async t => {
  const root = await mkdtemp(join(tmpdir(), 'opencraft-encoding-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  const source = Buffer.from('export const example = "hello";\n'.repeat(200));
  await Promise.all([writeFile(join(root, 'index.html'), '<head></head>'), writeFile(join(root, 'version.json'), '{}'), ...[['', source], ['.gz', gzipSync(source)], ['.br', brotliCompressSync(source)]].map(([suffix, body]) => writeFile(join(root, `assets/main-ABC12345.js${suffix}`), body))]);
  const server = await createWorkbenchWebServer({ root, appServerTarget: null }); t.after(() => server.close());
  const address = await server.listen({ host: '127.0.0.1', port: 0 }); const url = `http://127.0.0.1:${address.port}`;
  for (const [accept, expected] of [['br, gzip', 'br'], ['br;q=0, gzip;q=0.5', 'gzip'], ['gzip;q=0, br;q=0', undefined], ['gzip;q=0.4, identity;q=0.9', undefined], ['*;q=0, gzip;q=1', 'gzip'], ['gzip;q=2', undefined]]) {
    const response = await get(url + '/assets/main-ABC12345.js', accept);
    assert.equal(response.status, 200); assert.equal(response.headers['content-encoding'], expected);
    assert.equal(response.headers.vary, 'Accept-Encoding'); assert.match(response.headers['content-type'], /javascript/); assert.match(response.headers['cache-control'], /immutable/);
    assert.equal(Number(response.headers['content-length']), response.body.length);
    assert.deepEqual(expected === 'br' ? brotliDecompressSync(response.body) : expected === 'gzip' ? gunzipSync(response.body) : response.body, source);
  }
  const head = await get(url + '/assets/main-ABC12345.js', 'br', 'HEAD'); assert.equal(head.body.length, 0); assert.equal(head.headers['content-encoding'], 'br');
  const rejected = await get(url + '/assets/main-ABC12345.js', '*;q=0'); assert.equal(rejected.status, 406);
  for (const path of ['/', '/version.json', '/threads/example']) { const result = await get(url + path, 'br,gzip'); assert.equal(result.headers['content-encoding'], undefined); assert.match(result.headers['cache-control'], /no-store/); }
  for (const path of ['/assets/missing-ABC12345.js', '/assets/main-ABC12345.js.map', '/assets/main-ABC12345.js.map.gz']) { assert.equal((await get(url + path, 'br')).status, 404); }
});
