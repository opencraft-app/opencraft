import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { boundedFile, checkedDirectory } from '@opencraft/runtime-plugin-host/store';
import { assertHeadlessWebRelease } from '../../apps/headless-server/src/headless-web-release.mjs';

const digestPattern = /^[a-f0-9]{64}$/u;
const maxManifestBytes = 8 * 1024 ** 2;

export async function webReleaseFiles(root) {
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (!/^[A-Za-z0-9_./-]+$/u.test(path) || (entry.name.startsWith('.') && path !== 'web/.vite'))
        throw Error('Invalid Gateway Web release path: ' + path);
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, path + '/');
      else {
        if (!entry.isFile()) throw Error('Invalid Gateway Web release file: ' + path);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(target)) hash.update(chunk);
        files.push({ path, sha256: hash.digest('hex') });
      }
    }
  }
  await visit(join(root, 'web'), 'web/');
  const runtime = join(root, 'runtime/product-plugins');
  try {
    await checkedDirectory(runtime);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return files.sort((a, b) => a.path < b.path ? -1 : 1);
  }
  if (await realpath(runtime) !== runtime) throw Error('Gateway Web plugin directory must be canonical');
  await visit(runtime, 'runtime/product-plugins/');
  return files.sort((a, b) => a.path < b.path ? -1 : 1);
}

export async function loadGatewayWebRelease(env = process.env) {
  const root = env.OPENCRAFT_GATEWAY_WEB_RELEASE_DIRECTORY;
  const digest = env.OPENCRAFT_GATEWAY_WEB_RELEASE_SHA256;
  if (root === undefined && digest === undefined) return undefined;
  if (!root || !isAbsolute(root) || resolve(root) !== root || root === '/' || !digestPattern.test(digest ?? ''))
    throw Error('Configure a Gateway Web release directory and its manifest SHA-256');
  await checkedDirectory(root);
  await checkedDirectory(join(root, 'web'));
  if (await realpath(root) !== root) throw Error('Gateway Web release directory must be canonical');
  const bytes = await boundedFile(join(root, 'manifest.json'), maxManifestBytes);
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Gateway Web release manifest SHA-256 mismatch');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || (manifest.productPlugins !== undefined &&
    (manifest.productPlugins?.schemaVersion !== 1 || !digestPattern.test(manifest.productPlugins.inventorySha256 ?? ''))))
    throw Error('Invalid Gateway Web release manifest');
  const actual = await webReleaseFiles(root);
  if (actual.length !== manifest.files.length || actual.some((entry, index) => {
    const expected = manifest.files[index];
    return entry.path !== expected?.path || entry.sha256 !== expected.sha256;
  })) throw Error('Gateway Web release files differ from the manifest');
  if (manifest.productPlugins && !actual.some(entry =>
    entry.path === 'runtime/product-plugins/inventory.json' && entry.sha256 === manifest.productPlugins.inventorySha256))
    throw Error('Gateway Web product plugin inventory SHA-256 mismatch');
  const webRoot = join(root, 'web');
  await access(join(webRoot, 'index.html'));
  const { buildId } = await assertHeadlessWebRelease(webRoot);
  return { root, webRoot, buildId, sha256: digest, productPlugins: manifest.productPlugins ?? null };
}
