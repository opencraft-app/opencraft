import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { packageWebServer } from '../../scripts/package-web-server.mjs';
import { unpackPackage } from '../../scripts/web-deployment/releases.mjs';
import { verifyWebPackage } from '../../scripts/verify-web-package.mjs';
import { parseNpmPackResult } from '../../scripts/web-deployment/npm-pack-result.mjs';

test('default website archive includes lazy PDF assets and licenses and starts without execution or a resource registry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-single-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, 'web'); await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<html><head><meta content="single-package"></head><body>core</body></html>');
  await writeFile(join(web, 'version.json'), JSON.stringify({ buildId: 'single-package', sourceRevision: 'fixture' }));
  await writeFile(join(web, 'assets/pdf-12345678.js'), 'lazy PDF asset');
  await writeFile(join(web, 'optional-assets.json'), JSON.stringify({ schemaVersion: 1, files: ['assets/pdf-12345678.js'] }));
  const packed = await packageWebServer({ version: '1.0.0', webRoot: web, output: join(root, 'packed'), packageName: '@company/workbench' });
  assert.equal(packed.resources, undefined);
  const unpacked = await unpackPackage(packed.archive, join(root, 'unpacked'));
  assert.equal(await readFile(join(unpacked, 'web/assets/pdf-12345678.js'), 'utf8'), 'lazy PDF asset');
  assert.ok((await readFile(join(unpacked, 'web/licenses/pdfjs/LICENSE'), 'utf8')).includes('Apache'));
  const manifest = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8'));
  assert.equal(manifest.opencraftWeb.resources, undefined);
  assert.deepEqual(await verifyWebPackage(unpacked), { version: '1.0.0', buildId: 'single-package', sourceRevision: 'fixture', profile: 'web', ready: true });
});

test('a packaged distribution updates a canonical installation and downloads resources using its own registry scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-distribution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageName = '@company/workbench'; const resourcePackageName = '@company/workbench-assets';
  const observed = []; const manifests = new Map(); const archives = new Map();
  const registry = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    observed.push(path);
    if (archives.has(path)) { response.end(await readFile(archives.get(path))); return; }
    const manifest = manifests.get(path.slice(1));
    response.setHeader('content-type', 'application/json');
    if (!manifest) { response.writeHead(413); response.end(JSON.stringify({ error: 'wrong registry namespace' })); return; }
    response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { 'join-candidate': manifest.version }, versions: { [manifest.version]: manifest } }));
  });
  await new Promise(done => registry.listen(0, '127.0.0.1', done));
  t.after(async () => { registry.closeAllConnections(); await new Promise(done => registry.close(done)); });
  const origin = `http://127.0.0.1:${registry.address().port}/`;
  async function web(version) {
    const path = join(root, `web-${version}`); await mkdir(join(path, 'assets'), { recursive: true });
    await writeFile(join(path, 'index.html'), `<html><head><meta content="build-${version}"></head><body>${version}</body></html>`);
    await writeFile(join(path, 'version.json'), JSON.stringify({ buildId: `build-${version}` }));
    return path;
  }
  const legacy = await packageWebServer({ version: '1.0.0', webRoot: await web('1.0.0'), output: join(root, 'legacy'), splitResources: false });
  const webRoot = await web('1.1.0'); const file = 'assets/optional-12345678.js';
  await writeFile(join(webRoot, file), 'optional distribution resource');
  await writeFile(join(webRoot, 'optional-assets.json'), JSON.stringify({ schemaVersion: 1, files: [file] }));
  const packed = await packageWebServer({ version: '1.1.0', webRoot, output: join(root, 'distribution'), packageName, resourcePackageName, registry: origin, splitResources: true });
  for (const item of [packed, packed.resources]) {
    const manifest = JSON.parse(await readFile(join(item.packageRoot, 'package.json'), 'utf8'));
    const path = `/archives/${manifest.name.split('/')[1]}.tgz`;
    manifest.dist = { tarball: origin.slice(0, -1) + path, integrity: item.integrity };
    manifests.set(manifest.name, manifest); archives.set(path, item.archive);
  }
  assert.equal(manifests.get(packageName).publishConfig.registry, origin);
  assert.equal(manifests.get(resourcePackageName).publishConfig.registry, origin);
  assert.ok((await readFile(join(packed.packageRoot, 'opencraft-web.service'), 'utf8')).includes(`node_modules/${packageName}/runtime/cli.mjs`));
  const userconfig = join(root, 'npmrc');
  // Explicit deployment registry must override a stale scope entry.
  await writeFile(userconfig, `@company:registry=http://127.0.0.1:9/\ncache=${join(root, 'npm-cache')}\nfetch-retries=0\nfetch-timeout=5000\n`);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCRAFT_')));
  const state = join(root, 'state');
  const child = spawn(process.execPath, [join(packed.packageRoot, 'runtime/cli.mjs')], {
    env: { ...environment, OPENCRAFT_WEB_PORT: '0', OPENCRAFT_WEB_RELEASE: legacy.packageRoot, OPENCRAFT_WEB_STATE: state,
      OPENCRAFT_NPM_REGISTRY: origin, OPENCRAFT_NPM_USERCONFIG: userconfig, OPENCRAFT_UPDATE_CHANNEL: 'join-candidate' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stderr.on('data', data => { output += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const base = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Distribution bootstrap timed out: ' + output)), 20_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Distribution bootstrap exited: ' + output)); });
    child.stdout.on('data', data => { const match = String(data).match(/\[opencraft web\] (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); accept(match[1]); } });
  });
  const endpoint = base + '/__opencraft_updates'; let cookie = '';
  const status = async () => (await fetch(endpoint)).json();
  const post = async (action, data) => {
    const response = await fetch(endpoint + '/' + action, { method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.ok(response.ok, await response.clone().text()); return response;
  };
  assert.equal((await status()).packageName, packageName);
  assert.match(await (await fetch(base)).text(), /1\.0\.0/);
  await post('check', {});
  let current; const deadline = Date.now() + 30_000;
  do { current = await status(); if (!current.checking) break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.checkError, null); assert.equal(current.latest.version, '1.1.0');
  const login = await post('login', { key: (await readFile(join(state, 'admin-key'), 'utf8')).trim() });
  cookie = login.headers.get('set-cookie').split(';')[0];
  await post('install', { version: '1.1.0' });
  do { current = await status(); if (current.job?.phase === 'failed' || current.job?.phase === 'completed') break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.job.phase, 'completed', current.job.error); assert.equal(current.current.version, '1.1.0');
  assert.match(await (await fetch(base)).text(), /1\.1\.0/);
  assert.equal((await fetch(base + '/__opencraft_resources/' + packed.buildId)).status, 200);
  assert.equal(await (await fetch(base + '/' + file)).text(), 'optional distribution resource');
  assert.ok(observed.includes('/' + packageName)); assert.ok(observed.includes('/' + resourcePackageName));
  assert.deepEqual(new Set(observed.filter(path => path.startsWith('/@'))), new Set(['/' + packageName, '/' + resourcePackageName]));
  // An HTTP-healthy worker must still be rejected if its execution/UI profile
  // belongs to a different deployment target.
  const wrong = await packageWebServer({ version: '1.2.0', webRoot: await web('1.2.0'), output: join(root, 'wrong-profile'), packageName });
  const wrongManifest = JSON.parse(await readFile(join(wrong.packageRoot, 'package.json'), 'utf8'));
  wrongManifest.opencraftExecution = { profile: 'headless' };
  await writeFile(join(wrong.packageRoot, 'package.json'), JSON.stringify(wrongManifest));
  const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(root, 'wrong-profile')], { cwd: wrong.packageRoot });
  const wrongPack = parseNpmPackResult(JSON.parse(stdout));
  wrongManifest.dist = { tarball: origin + 'archives/wrong.tgz', integrity: wrongPack.integrity };
  manifests.set(packageName, wrongManifest); archives.set('/archives/wrong.tgz', join(root, 'wrong-profile', wrongPack.filename));
  await post('check', {});
  do { current = await status(); if (!current.checking) break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.latest.version, '1.2.0');
  await post('install', { version: '1.2.0' });
  do { current = await status(); if (current.job?.phase === 'failed' || current.job?.phase === 'completed') break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.job.phase, 'failed'); assert.match(current.job.error, /execution profile differs/);
  assert.equal(current.current.version, '1.1.0');
  const persisted = JSON.parse(await readFile(join(state, 'deployment.json'), 'utf8'));
  const oldManifestPath = join(persisted.previous.releaseRoot, 'package.json');
  const oldManifest = await readFile(oldManifestPath, 'utf8');
  await writeFile(oldManifestPath, JSON.stringify({ ...JSON.parse(oldManifest), opencraftExecution: { profile: 'headless' } }));
  await post('rollback', {});
  do { current = await status(); if (current.job?.phase === 'failed' || current.job?.phase === 'completed') break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.job.phase, 'failed'); assert.match(current.job.error, /execution profile differs/);
  assert.equal(current.current.version, '1.1.0');
  await writeFile(oldManifestPath, oldManifest);
  await post('rollback', {});
  do { current = await status(); if (current.job?.phase === 'failed' || current.job?.phase === 'completed') break; await delay(50); } while (Date.now() < deadline);
  assert.equal(current.job.phase, 'completed', current.job.error); assert.equal(current.current.version, '1.0.0');
});
