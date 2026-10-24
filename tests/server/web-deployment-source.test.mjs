import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNpmReleaseSource, PACKAGE_NAME } from '../../scripts/web-deployment/releases.mjs';

test('npm lookup distinguishes missing packages from access and registry failures without leaking details', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-npm-errors-'));
  let status = 404; let message = `npm包[${PACKAGE_NAME}]不存在\nnpm FAQ：https://example.test/faq`;
  const registry = createServer((request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: message }));
  });
  await new Promise(done => registry.listen(0, '127.0.0.1', done));
  const userconfig = join(directory, 'npmrc');
  await writeFile(userconfig, `cache=${join(directory, 'cache')}\nfetch-retries=0\nfetch-timeout=1000\n`);
  const source = createNpmReleaseSource({ registry: `http://127.0.0.1:${registry.address().port}/`, userconfig });
  try {
    await t.test('npm E404 for this missing package is an empty release feed', async () => {
      assert.equal(await source.latest(), null);
    });
    await t.test('standard npm E404 is an empty release feed', async () => {
      status = 404; message = 'package not found'; assert.equal(await source.latest(), null);
    });
    await t.test('other E400 is still a registry error', async () => {
      status = 400; message = 'Bad request containing private-server-detail';
      await assert.rejects(source.latest(), e => e.code === 'registry' && !e.message.includes('private-server-detail'));
    });
    await t.test('unauthorized is a credential error', async () => {
      status = 401; message = 'private credential detail';
      await assert.rejects(source.latest(), e => e.code === 'authentication' && !e.message.includes('private credential detail'));
    });
    await t.test('server outage stays visible', async () => {
      status = 503; message = 'private-server-detail';
      await assert.rejects(source.latest(), e => e.code === 'network' && !e.message.includes('private-server-detail'));
    });
  } finally { registry.closeAllConnections(); await new Promise(done => registry.close(done)); await rm(directory, { recursive: true, force: true }); }
});
