import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { startHeadlessServer } from '../../scripts/headless-server.mjs';
import { createWorkbenchWebServer } from '../../scripts/serve-workbench-web.mjs';
import { createWorkbenchWebServer as createWebWorkerServer } from '../../scripts/workbench-web-server.mjs';
import { assertInstalledPlugins } from '../support/assert-user-plugins.ts';
import { injectUserPluginBootstrap } from '../../scripts/web-deployment/user-plugins.mjs';

test('user plugin discovery leaves Host bootstrap intact and escapes script data before module execution', () => {
  const existing = '<script id="opencraft-deployment-config" type="application/json">{"hosts":["retained"]}</script>';
  const source = '<html><head>' + existing + '<script type="module" src="/core.js"></script></head></html>';
  const plugins = [{ name: '</script><script>bad()</script>\u2028' }];
  const html = injectUserPluginBootstrap(source, plugins);
  assert.ok(html.includes(existing)); assert.ok(!html.includes('<script>bad()'));
  const bootstrap = html.match(/<script id="opencraft-user-plugins" type="application\/json">(.*?)<\/script>/s);
  assert.deepEqual(JSON.parse(bootstrap[1]), plugins);
  assert.ok(html.indexOf(bootstrap[0]) < html.indexOf('type="module"'));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'headless-user-plugins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data'), directory = join(data, 'user-plugins');
  await mkdir(join(directory, 'public/user.example'), { recursive: true });
  await chmod(data, 0o700);
  const manifest = { manifestVersion: 1, id: 'user.example', name: 'User example', version: '1.0.0', apiVersion: 1,
    trust: 'trusted', platforms: ['web'], activationEvents: ['onStartupFinished'] };
  const code = `export default {manifest:${JSON.stringify(manifest)},activate(api){api.internal.register('applicationBranding',{id:'user.example',name:'User brand'})}};`;
  await writeFile(join(directory, 'public/user.example/plugin.mjs'), code);
  await writeFile(join(directory, 'public/user.example/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // An orphan on disk is not an installation or a public asset grant.
  await mkdir(join(directory, 'public/orphan'), { recursive: true });
  await writeFile(join(directory, 'public/orphan/private.txt'), 'not-published');
  const plugin = { manifest, entry: 'user.example/plugin.mjs', sha256: createHash('sha256').update(code).digest('hex'), replaces: ['fixture.default'] };
  const index = JSON.stringify({ schemaVersion: 1, plugins: [plugin] });
  await writeFile(join(directory, 'plugins.json'), index);
  const web = async name => {
    const release = join(root, name), path = join(release, 'web'); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'index.html'), '<!doctype html><html><head><title>Core</title></head><body>Core</body></html>');
    await writeFile(join(path, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: name, headlessServer: true, headlessHostId: 'opencraft-server' }));
    return { root: release, webRoot: path };
  };
  return { root, data, directory, code, index, web };
}

test('Headless/Compose discovers persistent user code without relocating first-party plugins', async t => {
  const f = await fixture(t);
  for (const release of ['one', 'two', 'one']) {
    const paths = await f.web(release + '-' + Math.random());
    const app = await startHeadlessServer({ ...paths, dataDirectory: f.data, port: 0,
      startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:1/rpc', async close() {} }) });
    try {
      const indexResponse = await fetch(app.url + '/');
      const html = await indexResponse.text();
      assert.ok(html.includes('opencraft-user-plugins')); assert.equal(indexResponse.headers.get('etag'), null);
      const head = await fetch(app.url + '/', { method: 'HEAD' });
      assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));
      assert.equal(await head.text(), '');
      assert.equal(await (await fetch(app.url + '/__opencraft_plugins/user.example/plugin.mjs')).text(), f.code);
      assert.equal((await fetch(app.url + '/__opencraft_plugins/user.example/icon.svg')).status, 200);
      assert.equal((await fetch(app.url + '/__opencraft_plugins/orphan/private.txt')).status, 404);
      assert.equal((await fetch(app.url + '/__opencraft_plugins/user.example/plugin.mjs', { method: 'POST' })).status, 405);
      await assertInstalledPlugins(app.url);
    } finally { await app.close(); }
    assert.equal(await readFile(join(f.directory, 'plugins.json'), 'utf8'), f.index);
    assert.equal(await readFile(join(f.directory, 'public/user.example/plugin.mjs'), 'utf8'), f.code);
  }
});

test('user assets keep gateway admission and filesystem containment; invalid code fails without losing data', async t => {
  const f = await fixture(t), paths = await f.web('protected');
  const server = await createWorkbenchWebServer({ root: paths.webRoot, userPluginDirectory: f.directory, appServerTarget: null,
    identityService: { admissionStatus: () => 403, connectionContext: () => null, handle: async () => false } });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  try { assert.equal((await fetch(`http://127.0.0.1:${address.port}/__opencraft_plugins/user.example/plugin.mjs`)).status, 403); }
  finally { await server.close(); }
  await symlink(join(f.directory, 'plugins.json'), join(f.directory, 'public/user.example/escape.json'));
  for (const createServer of [createWorkbenchWebServer, createWebWorkerServer]) {
    const open = await createServer({ root: paths.webRoot, userPluginDirectory: f.directory, appServerTarget: null });
    const listen = await open.listen({ host: '127.0.0.1', port: 0 }), base = `http://127.0.0.1:${listen.port}`;
    try {
      assert.equal((await fetch(base + '/__opencraft_plugins/user.example/escape.json')).status, 404);
      assert.equal((await fetch(base + '/__opencraft_plugins/orphan/private.txt', { headers: { accept: 'text/html' } })).status, 404);
      assert.equal((await fetch(base + '/__opencraft_plugins/user.example/plugin.mjs', { method: 'POST' })).status, 405);
    } finally { await open.close(); }
    const empty = await createServer({ root: paths.webRoot, appServerTarget: null });
    const address = await empty.listen({ host: '127.0.0.1', port: 0 });
    try { assert.equal((await fetch(`http://127.0.0.1:${address.port}/__opencraft_plugins/unknown/plugin.mjs`, { headers: { accept: 'text/html' } })).status, 404); }
    finally { await empty.close(); }
  }
  await writeFile(join(f.directory, 'public/user.example/plugin.mjs'), f.code + '\n//changed');
  const degraded = await startHeadlessServer({ ...paths, dataDirectory: f.data, port: 0,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:1/rpc', async close() {} }) });
  try {
    assert.equal((await fetch(degraded.url)).status, 200);
    const catalog = await (await fetch(degraded.url + '/__opencraft_plugin_catalog')).json();
    assert.deepEqual(catalog.plugins, []);
    assert.equal(catalog.errors[0].message, 'plugin_package_invalid');
  } finally { await degraded.close(); }
  assert.equal(await readFile(join(f.directory, 'plugins.json'), 'utf8'), f.index);
});

test('real browser imports local user code through the existing manager and can disable and enable it',
  { skip: process.env.OPENCRAFT_TEST_USER_PLUGIN_BROWSER !== '1' }, async t => {
  const f = await fixture(t), paths = await f.web('browser');
  const runtime = fileURLToPath(new URL('../../.runtime/', import.meta.url)); await mkdir(runtime, { recursive: true });
  const source = await mkdtemp(join(runtime, 'user-plugin-browser-')); t.after(() => rm(source, { recursive: true, force: true }));
  const fromRoot = path => fileURLToPath(new URL('../../' + path, import.meta.url));
  await writeFile(join(source, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/entry.js"></script></body></html>');
  await writeFile(join(source, 'entry.js'), `
    import{Context}from'@deepseek-ai/cordis';
    import{ExtensionSupervisor,ExtensionManager,MemoryExtensionInstallationPersistence,provideExtensionInstallationRepository,projectExtensionCatalog}from'@opencraft/extension-runtime';
    import{serverInstalledBuiltins,parseServerInstalledExtensions}from ${JSON.stringify(fromRoot('apps/workbench-web/src/runtime/server-installed-extensions.ts'))};
    import{ApplicationBrandingRegistry}from ${JSON.stringify(fromRoot('apps/workbench-web/src/runtime/application-branding.ts'))};
    const plugins=parseServerInstalledExtensions(JSON.parse(document.querySelector('#opencraft-user-plugins').textContent));
    const branding=new ApplicationBrandingRegistry();const supervisor=new ExtensionSupervisor({platform:'web',internalContributions:{applicationBranding:branding.createAdapter()}});
    const context=new Context();await context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));
    const manager=new ExtensionManager({installations:context.extensionInstallations,supervisor,builtins:serverInstalledBuiltins(plugins),loader:{load(){throw Error('Unexpected URL installation')}}});
    await manager.restore();
    window.userPluginProbe={state:()=>({rows:projectExtensionCatalog(supervisor.getSnapshot(),manager.getSnapshot(),supervisor.contributions.getSnapshot()),brand:branding.getSnapshot().contribution?.name??null}),enable:value=>manager.setEnabled('user.example',value)};
    document.body.dataset.ready='true';`);
  await build({ configFile: false, root: source, logLevel: 'silent', build: { target: 'esnext', outDir: paths.webRoot, emptyOutDir: true } });
  await writeFile(join(paths.webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'browser', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const app = await startHeadlessServer({ ...paths, dataDirectory: f.data, port: 0,
    startAgentHost: async () => ({ websocketUrl: 'ws://127.0.0.1:1/rpc', async close() {} }) });
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width === 390 });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(app.url); await page.waitForFunction("document.body.dataset.ready==='true'");
      let state = await page.evaluate('window.userPluginProbe.state()');
      assert.equal(state.brand, 'User brand', JSON.stringify(state.rows)); assert.equal(state.rows[0].source, 'installed');
      assert.equal(state.rows[0].status, 'active'); assert.equal(state.rows[0].canRemove, false);
      await page.evaluate('window.userPluginProbe.enable(false)');
      state = await page.evaluate('window.userPluginProbe.state()');
      assert.equal(state.brand, null); assert.equal(state.rows[0].status, 'disabled');
      await page.evaluate('window.userPluginProbe.enable(true)');
      assert.equal((await page.evaluate('window.userPluginProbe.state()')).brand, 'User brand');
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser.close(); await app.close(); }
});
