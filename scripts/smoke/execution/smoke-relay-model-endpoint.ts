import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { chromium } from '@playwright/test';
import { selectorFixture } from "../../../tests/fixtures/server-selector";

// The real built client and relay run unmodified. Only the upstream model
// service and employee identity are isolated, key-free fixtures.
const output = resolve(process.env.OPENCRAFT_SELECTOR_SMOKE_DIRECTORY ?? '.local/relay-model-endpoint');
await mkdir(output, { recursive: true });
const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(upstream, 'listening');
const methods: string[] = [];
upstream.on('connection', socket => socket.on('message', data => {
  const rpc = JSON.parse(String(data));
  if (rpc.id === undefined) return;
  methods.push(rpc.method);
  const result = rpc.method === 'initialize' ? { codexHome: '/tmp/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'relay-model-fixture/1' }
    : rpc.method === 'runtime/status/read' ? { engineId: 'fixture', displayName: 'Fixture', version: '1', cwd: '/tmp', provider: null, model: null }
    : rpc.method === 'runtime/settings/describe' ? { writable: false, hasDocument: true, namespaces: [] }
    : rpc.method === 'runtime/providers/list' ? { providers: [{ provider: 'fixture-cloud', displayName: 'Relay Fixture Cloud', settingsNs: 'fixture', settingsPath: [], active: true, configured: true, enabled: true }] }
    : rpc.method === 'runtime/models/list' ? { groups: [], failures: [] }
    : ['thread/list', 'model/list', 'project/list', 'permissionProfile/list'].includes(rpc.method) ? { data: [], nextCursor: null }
    : rpc.method === 'runtime/machine/read' ? { machine: { machineId: '00000000-0000-4000-8000-000000000001', name: 'Fixture', platform: 'linux' }, agent: 'OpenCraft' }
    : rpc.method === 'project/create' ? { project: { id: 'fixture-project', name: 'Fixture workspace', roots: [{ path: '/tmp/fixture' }], metadata: {} } }
    : rpc.method === 'config/read' ? { config: {}, origins: {} }
    : {};
  socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
}));
const fixture = await selectorFixture({
  appServerTarget: `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  serverPaths: { aliases: { join: 'main', lighthouse: 'lighthouse' }, defaultServer: 'join' },
  webRoot: resolve(process.env.OPENCRAFT_SELECTOR_WEB_ROOT ?? 'apps/workbench-web/dist'),
});
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP *.selection.test 127.0.0.1'] });
try {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-fixture-user': 'alice' }, locale: 'zh-CN' });
  const page = await context.newPage(), errors: string[] = [], sockets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
  for (const [id, prefix] of [['lighthouse', '/servers/lighthouse'], ['join', '']] as const) {
    await page.goto(fixture.origin + prefix + '/settings/opencraft.headless-model-services');
    await page.waitForFunction(async id => (await indexedDB.databases()).some(d => d.name?.includes('server:' + id + ':') && d.name.includes('host-connections')), id);
    await page.locator('[data-action-id]').first().waitFor();
    // Change the existing durable recipe exactly as a browser that used the
    // former route would have retained it; preserve the rest of the database.
    await page.evaluate(async id => {
      const info = (await indexedDB.databases()).find(d => d.name?.includes('server:' + id + ':') && d.name.includes('host-connections'))!;
      await new Promise<void>((done, reject) => {
        const request = indexedDB.open(info.name!);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('profiles', 'readwrite'), store = tx.objectStore('profiles');
          const read = store.get('opencraft-server');
          read.onsuccess = () => store.put({ ...read.result, displayName: 'Retained server label', workspaceBrowseRoots: ['/fixture/retained'],
            revision: 40, providerConfig: { ...read.result.providerConfig, url: location.origin.replace(/^http/, 'ws') + '/__opencraft_servers/' + id + '/appserver' } });
          tx.oncomplete = () => { db.close(); done(); };
          tx.onerror = () => reject(tx.error);
        };
      });
    }, id);
    const start = sockets.length;
    await page.reload();
    await page.getByText('Relay Fixture Cloud', { exact: true }).first().waitFor();
    assert.ok(sockets.slice(start).includes(prefix + '/appserver'));
    assert.ok(!sockets.slice(start).some(path => path.includes('__opencraft_servers')));
    const retained = await page.evaluate(async id => {
      const info = (await indexedDB.databases()).find(d => d.name?.includes('server:' + id + ':') && d.name.includes('host-connections'))!;
      return new Promise<any>((done, reject) => {
        const request = indexedDB.open(info.name!);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('profiles'), read = tx.objectStore('profiles').get('opencraft-server');
          read.onsuccess = () => done(read.result); tx.oncomplete = () => db.close();
        };
      });
    }, id);
    assert.equal(retained.displayName, 'Retained server label');
    assert.deepEqual(retained.workspaceBrowseRoots, ['/fixture/retained']);
    assert.equal(retained.revision, 41);
    assert.equal(new URL(retained.providerConfig.url).pathname, prefix + '/appserver');
    await page.screenshot({ path: join(output, id + '-models.png') });
  }
  assert.deepEqual(errors, []);
  assert.ok(methods.includes('runtime/providers/list'));
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ success: true, errors, sockets, methods,
    checks: ['persisted recipe restored before connection', 'named and default server model page', 'preferences retained', 'no old public route'],
    boundary: 'Real built Workbench, relay HTTP/WS and target ACL; synthetic identity and read-only model responses, no live inference or employee session.' }, null, 2));
  console.log(JSON.stringify({ success: true, output }));
} finally {
  console.log(JSON.stringify({ methods }));
  await browser.close(); await fixture.close(); for (const socket of upstream.clients) socket.terminate();
  await new Promise<void>(done => upstream.close(() => done()));
}
