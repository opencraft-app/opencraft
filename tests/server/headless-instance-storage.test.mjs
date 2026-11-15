import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';

test('Headless HTML scopes the browser to its data-root identity, including route and HEAD responses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'headless-instance-html-'));
  let web;
  try {
    await writeFile(join(root, 'index.html'), '<html><head><script type="module" src="/assets/module-alpha.js"></script></head><body>fixture</body></html>');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets/module-alpha.js'), 'export const value = 42;');
    web = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: true, instanceId: 'machine-new-root', assetVersion: 'new-build' });
    const address = await web.listen({ host: '127.0.0.1', port: 0 });
    const origin = typeof address === 'string' ? address : `http://127.0.0.1:${address.port}`;
    for (const path of ['/', '/settings/agents']) {
      const response = await fetch(origin + path, { headers: { accept: 'text/html' } });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /<script id="opencraft-instance-id" type="application\/json">"machine-new-root"<\/script>/);
      assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text));
      const asset = text.match(/src="(\/assets\/recovery-[a-z0-9-]+\/module-alpha.js)"/);
      assert.ok(asset, 'a new deployment must bypass previously cached module failures');
      const module = await fetch(origin + asset[1]);
      assert.equal(module.status, 200);
      assert.equal(await module.text(), 'export const value = 42;');
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
