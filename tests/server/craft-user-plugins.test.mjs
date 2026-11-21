import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sealCraftPlugin } from '../../scripts/packaging/craft-plugin.mjs';
import { createUserPluginCatalog, discoverCraftPlugins } from '../../apps/headless-server/src/web-deployment/craft-plugins.mjs';
import { loadUserPlugins, userPluginAsset } from '../../apps/headless-server/src/web-deployment/user-plugins.mjs';
import { createWorkbenchWebServer as gateway } from '../../apps/headless-server/src/serve-workbench-web.mjs';
import { createWorkbenchWebServer as worker } from '../../apps/headless-server/src/workbench-web-server.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hands-craft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'user-plugins');
  const manifest = { manifestVersion: 1, id: 'user.crafted', name: 'Crafted plugin', version: '1.0.0',
    apiVersion: 1, trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'] };
  async function publish(version = '1.0.0') {
    const folder = join(directory, 'crafts', manifest.id);
    await mkdir(folder, { recursive: true });
    const m = { ...manifest, version };
    const code = `export default {manifest:${JSON.stringify(m)},activate(api){api.commands.register({id:'user.crafted.hello',title:'Hello'},()=> '${version}')}};`;
    await writeFile(join(folder, 'plugin.mjs'), code);
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(m));
    await sealCraftPlugin(folder);
    return code;
  }
  return { root, directory, manifest, publish };
}

test('Hands craft files produce versioned immutable snapshots without executing server code', async t => {
  const f = await fixture(t);
  const code = await f.publish();
  const first = await discoverCraftPlugins(f.directory);
  assert.deepEqual(first.errors, []);
  assert.equal(first.plugins.length, 1);
  const one = first.plugins[0];
  assert.match(one.entry, /^user\.crafted\/[a-f0-9]{64}\/plugin\.mjs$/);
  assert.equal(one.access, 'public');
  assert.deepEqual(one.replaces, []);
  const oldFile = await userPluginAsset(f.directory, one.entry);
  assert.equal(await readFile(oldFile, 'utf8'), code);
  await f.publish('2.0.0');
  const two = (await discoverCraftPlugins(f.directory)).plugins[0];
  assert.notEqual(two.entry, one.entry);
  assert.equal(await readFile(oldFile, 'utf8'), code);
});

test('an invalid update retains the previous good craft; deleting the folder withdraws discovery', async t => {
  const f = await fixture(t); await f.publish();
  const catalog = await createUserPluginCatalog(f.directory, loadUserPlugins, { intervalMs: 0 });
  const initial = catalog.getSnapshot().plugins;
  await writeFile(join(f.directory, 'crafts/user.crafted/plugin.mjs'), 'export default {};');
  const unsealed = await catalog.refresh();
  assert.deepEqual(unsealed.plugins, initial, 'an unsealed code edit must not replace the active snapshot');
  assert.match(unsealed.errors[0].message, /sealed|changed/);
  await writeFile(join(f.directory, 'crafts/user.crafted/manifest.json'), '{');
  const failed = await catalog.refresh();
  assert.deepEqual(failed.plugins, initial);
  assert.equal(failed.errors[0].extensionId, 'user.crafted');
  await f.publish('2.0.0');
  assert.equal((await catalog.refresh()).plugins[0].manifest.version, '2.0.0');
  await rm(join(f.directory, 'crafts/user.crafted'), { recursive: true });
  assert.deepEqual((await catalog.refresh()).plugins, []);
});

test('crafts reject symlinks, reserved namespaces, internal overrides and oversized modules', async t => {
  const f = await fixture(t); await f.publish();
  const folder = join(f.directory, 'crafts/user.crafted');
  await rm(join(folder, 'plugin.mjs'));
  await writeFile(join(f.root, 'secret'), 'not a plugin');
  await symlink(join(f.root, 'secret'), join(folder, 'plugin.mjs'));
  assert.equal((await discoverCraftPlugins(f.directory)).plugins.length, 0);
  await rm(join(folder, 'plugin.mjs'));
  await f.publish();
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ ...f.manifest, replaces: ['opencraft.account'] }));
  assert.equal((await discoverCraftPlugins(f.directory)).plugins.length, 0);
  await f.publish();
  await writeFile(join(folder, 'plugin.mjs'), Buffer.alloc(512 * 1024 + 1));
  assert.equal((await discoverCraftPlugins(f.directory)).plugins.length, 0);
  await f.publish();
  assert.equal((await discoverCraftPlugins(f.directory, new Set(['user.crafted']))).plugins.length, 0);
  await mkdir(join(f.directory, 'crafts/opencraft.account'));
  assert.ok((await discoverCraftPlugins(f.directory)).errors.some(e => e.extensionId === 'opencraft.account'));
});

test('catalog refresh is single-flight and preserves a good catalog if the explicit index breaks', async t => {
  const f = await fixture(t); await f.publish();
  let reads = 0;
  const catalog = await createUserPluginCatalog(f.directory, async () => { reads++; await new Promise(r => setTimeout(r, 10)); return loadUserPlugins(f.directory); }, { intervalMs: 0 });
  await Promise.all(Array.from({ length: 20 }, () => catalog.refresh()));
  assert.equal(reads, 2);
  const parent = join(f.directory, 'public/user.crafted');
  const before = await stat(parent);
  await catalog.refresh();
  assert.equal((await stat(parent)).mtimeMs, before.mtimeMs, 'unchanged discovery must not rewrite snapshots');
  await writeFile(join(f.directory, 'plugins.json'), '{bad');
  const failed = await catalog.refresh();
  assert.equal(failed.plugins.length, 1);
  assert.equal(failed.errors[0].extensionId, '*');
});

test('a sealed syntax/import failure is isolated and preserves the previous valid snapshot', async t => {
  const f = await fixture(t); await f.publish();
  const catalog = await createUserPluginCatalog(f.directory, loadUserPlugins, { intervalMs: 0 });
  const good = catalog.getSnapshot().plugins;
  const folder = join(f.directory, 'crafts/user.crafted');
  for (const code of ['export default {', "import x from './not-bundled.mjs'; export default x;"]) {
    await writeFile(join(folder, 'plugin.mjs'), code); await sealCraftPlugin(folder);
    const invalid = await catalog.refresh();
    assert.deepEqual(invalid.plugins, good);
    assert.equal(invalid.errors.length, 1);
  }
});

for (const [name, create] of [['Gateway', gateway], ['Web worker', worker]]) {
  test(`${name}: discover after startup without restart, preserve old code URLs and existing Host config`, async t => {
    const f = await fixture(t);
    const web = join(f.root, 'web'); await mkdir(web);
    await writeFile(join(web, 'index.html'), '<!doctype html><html><head><title>Core</title></head><body>Core</body></html>');
    const app = await create({ root: web, userPluginDirectory: f.directory, appServerTarget: null });
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), base = `http://127.0.0.1:${address.port}`;
    try {
      assert.deepEqual((await (await fetch(base + '/__opencraft_plugin_catalog')).json()).plugins, []);
      const one = await f.publish();
      await new Promise(r => setTimeout(r, 1050));
      const html = await (await fetch(base + '/')).text();
      const plugin = (await (await fetch(base + '/__opencraft_plugin_catalog')).json()).plugins[0];
      assert.ok(html.includes('user.crafted'));
      const oldUrl = base + '/__opencraft_plugins/' + plugin.entry;
      assert.equal(await (await fetch(oldUrl)).text(), one);
      await f.publish('2.0.0'); await new Promise(r => setTimeout(r, 1050));
      const updated = (await (await fetch(base + '/__opencraft_plugin_catalog')).json()).plugins[0];
      assert.equal(updated.manifest.version, '2.0.0');
      assert.equal(await (await fetch(oldUrl)).text(), one);
      assert.equal((await fetch(base + '/__opencraft_plugin_catalog', { method: 'POST' })).status, 405);
      assert.equal((await fetch(base + '/__opencraft_plugins/user.crafted/manifest.json')).status, 404);
    } finally { await app.close(); }
  });
}

test('craft catalog and snapshot endpoints preserve Gateway admission', async t => {
  const f = await fixture(t); await f.publish();
  const web = join(f.root, 'web'); await mkdir(web);
  const app = await gateway({ root: web, userPluginDirectory: f.directory, appServerTarget: null,
    identityService: { admissionStatus: () => 403, connectionContext: () => null, handle: async () => false } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  try { assert.equal((await fetch(`http://127.0.0.1:${address.port}/__opencraft_plugin_catalog`)).status, 403); }
  finally { await app.close(); }
});

test('real browser loads versioned craft snapshots, requires opt-in and restores intent on refresh',
  { skip: process.env.OPENCRAFT_TEST_USER_PLUGIN_BROWSER !== '1' }, async t => {
  const f = await fixture(t); await f.publish();
  const runtime = fileURLToPath(new URL('../../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const source = await mkdtemp(join(runtime, 'craft-browser-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  const web = join(f.root, 'web');
  const modulePath = path => fileURLToPath(new URL('../../' + path, import.meta.url));
  await writeFile(join(source, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/entry.js"></script></body></html>');
  await writeFile(join(source, 'entry.js'), `
    import{Context}from'@deepseek-ai/cordis';
    import{ExtensionSupervisor,ExtensionManager,createPersistentExtensionInstallations,provideExtensionInstallationRepository}from'@opencraft/extension-runtime';
    import{serverInstalledBuiltins,parseServerInstalledExtensions}from ${JSON.stringify(modulePath('apps/workbench-web/src/runtime/server-installed-extensions.ts'))};
    import{openIndexedDbExtensionPersistence}from ${JSON.stringify(modulePath('apps/workbench-web/src/runtime/indexeddb-extension-persistence.ts'))};
    const backend=await openIndexedDbExtensionPersistence('hands-craft-browser');
    const context=new Context();await context.plugin(provideExtensionInstallationRepository(await createPersistentExtensionInstallations(backend)));
    const supervisor=new ExtensionSupervisor({platform:'web'});
    const installed=parseServerInstalledExtensions(JSON.parse(document.querySelector('#opencraft-user-plugins').textContent));
    const manager=new ExtensionManager({installations:context.extensionInstallations,supervisor,builtins:serverInstalledBuiltins(installed),loader:{load(){throw Error('Unexpected URL install')}}});
    await manager.restore();
    window.craftProbe={state:()=>manager.getSnapshot().extensions[0].status,enable:value=>manager.setEnabled('user.crafted',value),run:()=>supervisor.contributions.executeCommand('user.crafted.hello')};
    document.body.dataset.ready='true';`);
  const { build } = await import('vite');
  await build({ configFile: false, root: source, logLevel: 'silent', build: { target: 'esnext', outDir: web, emptyOutDir: true } });
  const app = await gateway({ root: web, userPluginDirectory: f.directory, appServerTarget: null });
  const address = await app.listen({ host: '127.0.0.1', port: 0 }), base = `http://127.0.0.1:${address.port}`;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [390, 1440]) {
      await f.publish(); await new Promise(r => setTimeout(r, 1050));
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width === 390 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.waitForFunction("document.body.dataset.ready==='true'");
      assert.equal(await page.evaluate('window.craftProbe.state()'), 'disabled');
      await page.evaluate('window.craftProbe.enable(true)');
      assert.equal(await page.evaluate('window.craftProbe.run()'), '1.0.0');
      await f.publish('2.0.0'); await new Promise(r => setTimeout(r, 1050));
      // The old document stays active until the user explicitly refreshes.
      assert.equal(await page.evaluate('window.craftProbe.run()'), '1.0.0');
      await page.reload(); await page.waitForFunction("document.body.dataset.ready==='true'");
      assert.equal(await page.evaluate('window.craftProbe.state()'), 'active');
      assert.equal(await page.evaluate('window.craftProbe.run()'), '2.0.0');
      await page.evaluate('window.craftProbe.enable(false)');
      await page.reload(); await page.waitForFunction("document.body.dataset.ready==='true'");
      assert.equal(await page.evaluate('window.craftProbe.state()'), 'disabled');
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await app.close(); }
});
