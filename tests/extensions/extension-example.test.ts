import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import {
  ExtensionManager, ExtensionSupervisor, MemoryExtensionInstallationPersistence,
  provideExtensionInstallationRepository,
} from '@opencraft/extension-runtime';
import { BrowserModuleUrlExtensionLoader } from '../../apps/workbench-web/src/runtime/module-url-extension-loader.ts';
import { createExtensionExampleServer } from '../../examples/extensions/serve.mjs';

test('documented module URL installs, executes, retires, reloads and restores offline', { timeout: 15_000 }, async () => {
  const server = createExtensionExampleServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hello.mjs`;
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));
  await fiber;
  let downloads = 0, offline = false;
  const loader = new BrowserModuleUrlExtensionLoader('http://127.0.0.1:5173', Date.now, {
    fetch: async (...args: Parameters<typeof fetch>) => {
      assert.equal(offline, false, 'offline restore must use persisted module bytes');
      downloads++;
      const response = await fetch(...args);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.match(response.headers.get('content-type')!, /javascript/);
      return response;
    },
    // Node has no browser blob: importer; download, parser, integrity and public API projection are real.
    importArtifact: async code => import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`),
  });
  let supervisor = new ExtensionSupervisor({ platform: 'web' });
  let manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, loader });
  try {
    for (const path of ['/package.json', '/../../package.json', '/']) {
      assert.equal((await fetch(new URL(path, source))).status, 404);
    }
    assert.equal((await fetch(source, { method: 'OPTIONS' })).status, 204);
    assert.equal((await fetch(source, { method: 'POST' })).status, 405);
    const saved = await manager.installModuleUrl(source);
    assert.equal(saved.extensionId, 'example.hello');
    assert.match(saved.artifact!.sha256, /^[a-f0-9]{64}$/);
    assert.equal(supervisor.contributions.getSnapshot().navigation.length, 1);
    const announcement = supervisor.contributions.executeCommand('example.hello.open');
    assert.equal(supervisor.announcements.getSnapshot().announcements[0]!.contribution.title, 'Hello from a public extension');
    await manager.setEnabled('example.hello', false);
    assert.deepEqual(await announcement, { kind: 'dismissed', reason: 'owner-disposed' });
    assert.equal(supervisor.contributions.getSnapshot().navigation.length, 0);
    assert.equal(supervisor.announcements.getSnapshot().announcements.length, 0);
    await manager.setEnabled('example.hello', true);
    await manager.reload('example.hello');
    assert.equal(downloads, 2, 're-enable reuses stored bytes; explicit reload downloads');
    await manager.dispose();
    await supervisor.dispose();
    offline = true;
    supervisor = new ExtensionSupervisor({ platform: 'web' });
    manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, loader });
    await manager.restore();
    assert.equal(downloads, 2);
    assert.equal(supervisor.contributions.getSnapshot().navigation[0]!.contribution.id, 'example.hello.entry');
  } finally {
    await manager.dispose();
    await supervisor.dispose();
    await fiber.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
