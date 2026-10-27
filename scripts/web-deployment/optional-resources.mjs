import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import semver from 'semver';
import { createNpmReleaseSource, unpackPackage } from './releases.mjs';
import { RESOURCE_PACKAGE, PUBLIC_RESOURCE_PACKAGE } from './package-identity.mjs';
export { RESOURCE_PACKAGE } from './package-identity.mjs';

const safeFile = file => typeof file === 'string' && /^assets\/(?:[A-Za-z0-9_.~-]+|excalidraw-fonts\/fonts\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.woff2)$/.test(file) && !file.endsWith('.map');
export function parseResources(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.packs) || value.packs.length > 1000) throw new Error('Invalid resource manifest');
  for (const pack of value.packs) {
    if (![RESOURCE_PACKAGE, PUBLIC_RESOURCE_PACKAGE].includes(pack.packageName) || !semver.valid(pack.version) || !/^[A-Za-z0-9._-]{1,128}$/.test(pack.buildId)
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pack.integrity) || !Array.isArray(pack.files) || pack.files.length > 20_000
      || pack.files.some(file => !safeFile(file))) throw new Error('Invalid resource package');
  }
  return value;
}
export async function readResources(root) {
  try { return parseResources(JSON.parse(await readFile(join(root, 'web/optional-resources.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, packs: [] }; throw error; }
}
export async function createOptionalResources({ releaseRoot, cacheDirectory, registry, userconfig, source } = {}) {
  const own = await readResources(releaseRoot);
  const directory = resolve(cacheDirectory);
  const catalog = join(directory, 'catalog');
  const packs = new Map(); const files = new Map(); const pending = new Map();
  const register = pack => { packs.set(pack.buildId, pack); for (const file of pack.files) files.set(`/${file}`, pack); };
  async function saveCatalog(pack) {
    await mkdir(catalog, { recursive: true, mode: 0o700 });
    const path = join(catalog, `${pack.buildId}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ schemaVersion: 1, packs: [pack] }), { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  // Each release has an immutable catalog. A full/unwritable optional cache
  // must not prevent the core worker from becoming ready.
  try {
    for (const pack of own.packs) await saveCatalog(pack);
    for (const entry of await readdir(catalog)) {
      if (!/^[A-Za-z0-9._-]{1,128}\.json$/.test(entry)) continue;
      try {
        const data = parseResources(JSON.parse(await readFile(join(catalog, entry), 'utf8')));
        for (const pack of data.packs) register(pack);
      } catch { /* An invalid historical index cannot disable the core release. */ }
    }
  } catch { /* Resource requests retry cache creation and report unavailability. */ }
  for (const pack of own.packs) register(pack);
  const key = pack => createHash('sha256').update(pack.integrity).digest('hex');
  async function cached(pack) {
    const root = join(directory, 'packages', key(pack), 'package');
    try {
      if ((await readFile(join(root, '.integrity'), 'utf8')) === pack.integrity) return root;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  async function ensure(pack, archive) {
    const existing = await cached(pack); if (existing) return existing;
    const id = key(pack);
    if (pending.has(id)) return pending.get(id);
    const operation = (async () => {
      const staging = join(directory, 'staging', randomUUID());
      try {
        await saveCatalog(pack);
        await mkdir(staging, { recursive: true, mode: 0o700 });
        const downloadSource = source || createNpmReleaseSource({ registry, userconfig, packageName: pack.packageName });
        const downloaded = archive || await downloadSource.download(pack, staging);
        // Also verify preinstalled archives; local files have no registry metadata.
        const actual = 'sha512-' + createHash('sha512').update(await readFile(downloaded)).digest('base64');
        if (actual !== pack.integrity) throw new Error('Resource archive integrity mismatch');
        const root = await unpackPackage(downloaded, join(staging, 'unpacked'));
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        if (manifest.name !== pack.packageName || manifest.version !== pack.version || manifest.opencraftAssets?.buildId !== pack.buildId)
          throw new Error('Resource archive identity mismatch');
        for (const file of pack.files) if (!(await stat(join(root, 'web', file))).isFile()) throw new Error('Resource archive file missing');
        await writeFile(join(root, '.integrity'), pack.integrity, { mode: 0o600 });
        await mkdir(join(directory, 'packages'), { recursive: true, mode: 0o700 });
        try { await rename(join(staging, 'unpacked'), join(directory, 'packages', id)); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await cached(pack)) throw error;
        }
        return await cached(pack);
      } finally { await rm(staging, { recursive: true, force: true }); }
    })();
    pending.set(id, operation);
    try { return await operation; } finally { pending.delete(id); }
  }
  return {
    async resolveFile(pathname) {
      const pack = files.get(pathname); if (!pack) return null;
      return join(await ensure(pack), 'web', pathname.slice(1));
    },
    async prepare(buildId) {
      const pack = packs.get(buildId); if (!pack) return false;
      await ensure(pack); return true;
    },
    async prefetch(archive) { for (const pack of own.packs) await ensure(pack, archive); },
  };
}
