import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageWebServer } from '../../scripts/package-web-server.mjs';
import { PACKAGE_NAME, createNpmReleaseSource } from '../../scripts/web-deployment/releases.mjs';
export async function releaseFixture(directory, { realWebRoot, realWebRoots, execution = false, executionProfile = 'daemon' } = {}) {
  const releases = new Map(); let selected = '1.1.0'; let failDownload = false; let holdDownload = null;
  let lookupError = null; let holdLookup = null;
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path.startsWith('/archives/')) {
      const release = releases.get(path.split('/').pop().replace('.tgz', ''));
      if (!release) { response.writeHead(404); response.end(); return; }
      if (holdDownload) await holdDownload;
      if (failDownload) { response.writeHead(503); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(await readFile(release.archive)); return;
    }
    if (path === `/${PACKAGE_NAME}`) {
      if (holdLookup) await holdLookup;
      if (lookupError) {
        response.writeHead(lookupError.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: lookupError.message })); return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ name: PACKAGE_NAME, 'dist-tags': { latest: selected }, versions: Object.fromEntries([...releases].map(([version, release]) => [version, release.manifest])) })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  try {
    for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0', ...(executionProfile === 'headless' ? ['1.4.0'] : [])]) {
      const webRoot = realWebRoots?.[version] || realWebRoot || join(directory, `web-${version}`);
      if (!realWebRoot && !realWebRoots) {
        await mkdir(join(webRoot, 'assets'), { recursive: true });
        await writeFile(join(webRoot, 'index.html'), `<html><head><meta name="opencraft-build-id" content="build-${version}"></head><body>${version}</body></html>`);
        await writeFile(join(webRoot, 'version.json'), JSON.stringify({ buildId: `build-${version}`, ...(executionProfile === 'headless' ? { schemaVersion: 1, headlessServer: true, headlessHostId: 'opencraft-server' } : {}) }));
        await writeFile(join(webRoot, `assets/lazy-${version.replaceAll('.', '')}abcdef.js`), `export const version = '${version}';`);
      }
      const output = join(directory, version);
      let packed = await packageWebServer({ version, webRoot, output, execution, executionProfile });
      if (version === '1.0.0' || version === '1.2.0' || version === '1.3.0') {
        const workerPath = join(packed.packageRoot, 'runtime/worker.mjs');
        await writeFile(workerPath, version === '1.2.0' ? 'process.exit(1);\n' : (await readFile(workerPath, 'utf8')) + (version === '1.3.0' ? '\nsetTimeout(() => process.exit(1), 200);\n' : `
await (await import("node:fs/promises")).writeFile(process.env.OPENCRAFT_RELEASE_ROOT+"/worker-pid",String(process.pid));
const handlers = server.server.listeners('request'); server.server.removeAllListeners('request');
server.server.on('request',(request,response)=>{
  if(request.url==='/crash-during-response') { response.writeHead(200, {'content-length':'100000'}); response.write('partial'); setTimeout(()=>process.exit(1),50); }
  else for(const handler of handlers) handler(request,response);
});
`));
        const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: packed.packageRoot });
        const value = JSON.parse(stdout);
        const result = Array.isArray(value) ? value[0] : Object.values(value)[0];
        packed = { ...packed, integrity: result.integrity, sha: result.shasum };
      }
      if (executionProfile === 'headless' && version === '1.4.0') {
        await writeFile(join(packed.packageRoot, 'execution/gateway.mjs'), 'throw new Error("Synthetic isolated Headless execution startup failure");\n');
        const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: packed.packageRoot });
        const value = JSON.parse(stdout); const result = Array.isArray(value) ? value[0] : Object.values(value)[0];
        packed = { ...packed, integrity: result.integrity, sha: result.shasum };
      }
      const manifest = JSON.parse(await readFile(join(packed.packageRoot, 'package.json'), 'utf8'));
      manifest.dist = { tarball: `${registry}archives/${version}.tgz`, integrity: packed.integrity, shasum: packed.sha };
      releases.set(version, { ...packed, manifest });
    }
    const userconfig = join(directory, 'fixture.npmrc');
    await writeFile(userconfig, `cache=${join(directory, 'npm-cache')}\nfetch-retries=0\nfetch-timeout=5000\n`);
    return { registry, userconfig, releases, source: createNpmReleaseSource({ registry, userconfig }),
      select: version => { selected = version; }, failDownload: value => { failDownload = value; }, holdDownload: promise => { holdDownload = promise; },
      lookupError: value => { lookupError = value; }, holdLookup: promise => { holdLookup = promise; },
      async close() { server.closeAllConnections(); await new Promise(accept => server.close(accept)); } };
  } catch (error) { server.closeAllConnections(); server.close(); throw error; }
}
