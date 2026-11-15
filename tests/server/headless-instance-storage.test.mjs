import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

test('Headless HTML scopes the browser to its data-root identity, including route and HEAD responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'headless-instance-html-'));
  let web;
  try {
    await writeFile(join(root, 'index.html'), '<html><head></head><body>fixture</body></html>');
    web = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: true, instanceId: 'machine-new-root' });
    const address = await web.listen({ host: '127.0.0.1', port: 0 });
    const origin = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
    for (const path of ['/', '/settings/agents']) {
      const response = await fetch(origin + path, { headers: { accept: 'text/html' } });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /<script id="opencraft-instance-id" type="application\/json">"machine-new-root"<\/script>/);
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
      const head = await fetch(origin + path, { method: 'HEAD', headers: { accept: 'text/html' } });
      assert.equal(head.headers.get('content-length'), response.headers.get('content-length'));
      assert.equal(await head.text(), '');
    }
  } finally { await web?.close(); await rm(root, { recursive: true, force: true }); }
});

// The default keeps existing client storage when an operator has not reset an instance.
test('browser isolation is an explicit Headless deployment choice', async () => {
  const { parseHeadlessArguments } = await import('../../scripts/headless-server.mjs');
  assert.equal(parseHeadlessArguments([]).isolateBrowserStorage, undefined);
  assert.equal(parseHeadlessArguments(['--isolate-browser-storage']).isolateBrowserStorage, true);
});
