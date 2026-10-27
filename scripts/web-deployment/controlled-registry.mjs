import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { PACKAGE_NAME } from './releases.mjs';

/** Operator-curated exact archives. No public latest fallback or external metadata. */
export async function createControlledReleaseRegistry({ catalogPath }) {
  if (typeof catalogPath !== 'string' || !isAbsolute(catalogPath)) throw new Error('Controlled release catalog must be absolute');
  async function catalog() {
    const info = await stat(catalogPath);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Error('Release catalog must be an owned private file');
    const value = JSON.parse(await readFile(catalogPath, 'utf8'));
    if (value?.schemaVersion !== 1 || value.channel !== 'managed-headless' || !semver.valid(value.selected)
      || !Array.isArray(value.releases) || value.releases.length < 1 || value.releases.length > 128) throw new Error('Invalid controlled catalog');
    const releases = new Map();
    for (const item of value.releases) {
      if (!semver.valid(item?.version) || releases.has(item.version) || !isAbsolute(item.archive || '')
        || !/^[A-Za-z0-9._-]{1,128}$/.test(item.buildId || '') || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(item.integrity || '')) throw new Error('Invalid controlled release');
      releases.set(item.version, item);
    }
    if (!releases.has(value.selected)) throw new Error('Selected controlled release is absent');
    return { ...value, releases };
  }
  await catalog();
  const sockets = new Set(); let closed = false;
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    try {
      if (closed || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
      const current = await catalog();
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === `/${PACKAGE_NAME}`) {
        // Use the bound loopback port; never trust the incoming Host header.
        const versions = Object.fromEntries([...current.releases].map(([version, item]) => [version, {
          name: PACKAGE_NAME, version, opencraftWeb: { schemaVersion: 1, workerProtocol: 1, buildId: item.buildId },
          dist: { tarball: `http://127.0.0.1:${server.address().port}/archives/${encodeURIComponent(version)}.tgz`, integrity: item.integrity },
        }]));
        response.setHeader('content-type', 'application/json');
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ name: PACKAGE_NAME, 'dist-tags': { [current.channel]: current.selected }, versions }));
        return;
      }
      const match = /^\/archives\/([^/]+)\.tgz$/.exec(path);
      const release = match && current.releases.get(match[1]);
      if (!release) { response.writeHead(404); response.end(); return; }
      const info = await stat(release.archive);
      if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error('Invalid controlled archive');
      const bytes = await readFile(release.archive);
      if ('sha512-' + createHash('sha512').update(bytes).digest('base64') !== release.integrity) throw new Error('Controlled archive integrity changed');
      response.setHeader('content-type', 'application/octet-stream'); response.setHeader('content-length', bytes.length);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { if (!response.headersSent) response.writeHead(503); response.end(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  return {
    listen({ port = 18882 } = {}) {
      return new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => {
        server.off('error', reject); accept(server.address());
      }); });
    },
    async close() { closed = true; for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const registry = await createControlledReleaseRegistry({ catalogPath: process.env.OPENCRAFT_RELEASE_CATALOG });
  const port = Number(process.env.OPENCRAFT_REGISTRY_PORT || 18882);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid registry port');
  const address = await registry.listen({ port });
  console.log(`[opencraft controlled registry] loopback:${address.port}, channel=managed-headless`);
  const stop = () => void registry.close().then(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
