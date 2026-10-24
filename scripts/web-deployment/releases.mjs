import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { x } from 'tar';
import semver from 'semver';
import { MAX_ARCHIVE_BYTES, MAX_UNPACKED_BYTES, verifyArchiveIntegrity } from './archive-limits.mjs';
import { parseNpmPackResult } from './npm-pack-result.mjs';
import { parseWebReleaseMetadata } from '../../packages/web-update-protocol/src/index.mjs';
import { PACKAGE_NAME, PUBLIC_PACKAGE_NAME, RESOURCE_PACKAGE, PUBLIC_RESOURCE_PACKAGE } from './package-identity.mjs';
export { PACKAGE_NAME } from './package-identity.mjs';

const exec = promisify(execFile);
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
// Only fixed codes/messages cross into the public update API. npm output can
// contain credentials and private URLs, so it is used for classification only.
const npmMessages = {
  authentication: 'npm authentication failed; configure the deployment user npm credentials',
  network: 'npm registry is unreachable; retry after checking server network access',
  unavailable: 'npm is unavailable in the website service PATH',
  registry: 'npm rejected the request; check the server registry configuration',
};
function npmFailure(error) {
  let detail;
  try { detail = JSON.parse(error.stdout).error; } catch {}
  const code = detail?.code || error.code;
  const missing = code === 'E404';
  const kind = missing ? 'not-published'
    : ['E401', 'E403', 'ENEEDAUTH', 'EAUTH'].includes(code) ? 'authentication'
    : ['E500', 'E502', 'E503', 'E504', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'FETCH_ERROR'].includes(code)
      || error.killed ? 'network' : code === 'ENOENT' ? 'unavailable' : 'registry';
  return Object.assign(new Error(npmMessages[kind] || 'No Web release has been published to the npm registry'), { code: kind });
}
export async function inspectRelease(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (![PACKAGE_NAME, PUBLIC_PACKAGE_NAME].includes(manifest.name) || !semver.valid(manifest.version)) throw new Error('Unexpected Web package identity');
  const metadata = parseWebReleaseMetadata(manifest.opencraftWeb);
  const web = JSON.parse(await readFile(join(root, 'web/version.json'), 'utf8'));
  const html = await readFile(join(root, 'web/index.html'), 'utf8');
  if (web.buildId !== metadata.buildId || !html.includes(`content="${metadata.buildId}"`)) throw new Error('Web build identity mismatch');
  if (!(await stat(join(root, 'runtime/worker.mjs'))).isFile()) throw new Error('Web worker missing');
  return { releaseRoot: resolve(root), version: manifest.version, buildId: metadata.buildId };
}
export function createNpmReleaseSource({ registry = DEFAULT_REGISTRY, channel = 'latest', userconfig, packageName = PACKAGE_NAME } = {}) {
  if (![PACKAGE_NAME, PUBLIC_PACKAGE_NAME, RESOURCE_PACKAGE, PUBLIC_RESOURCE_PACKAGE].includes(packageName)) throw new Error('Unexpected npm package name');
  const registryUrl = new URL(registry);
  if (!['https:', 'http:'].includes(registryUrl.protocol) || registryUrl.username || registryUrl.password) throw new Error('Invalid npm registry');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(channel)) throw new Error('Invalid update channel');
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : null;
  const flags = ['--registry', registry, ...(scope ? [`--${scope}:registry=${registry}`] : []), '--ignore-scripts', '--no-audit', '--no-fund', ...(userconfig ? ['--userconfig', resolve(userconfig)] : [])];
  async function npm(args, cwd) {
    // npm stderr may contain credential-bearing registry URLs: never expose it to the browser/logs.
    try {
      const result = await exec(process.env.OPENCRAFT_NPM_EXECUTABLE || 'npm', [...args, ...flags], {
        cwd, timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      });
      return JSON.parse(result.stdout);
    } catch (error) { throw npmFailure(error); }
  }
  return {
    channel,
    async latest() {
      let manifest;
      try { manifest = await npm(['view', `${packageName}@${channel}`, '--json']); }
      catch (error) { if (error.code === 'not-published') return null; throw error; }
      if (Array.isArray(manifest)) {
        if (manifest.length !== 1) throw new Error('Unexpected npm release');
        manifest = manifest[0];
      }
      if (manifest.name !== packageName || !semver.valid(manifest.version)) throw new Error('Unexpected npm release');
      const metadata = parseWebReleaseMetadata(manifest.opencraftWeb);
      const integrity = manifest.dist?.integrity;
      if (typeof integrity !== 'string' || !/^(sha512|sha256)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('Release integrity missing or unsupported');
      return { version: manifest.version, buildId: metadata.buildId, integrity };
    },
    async download(release, directory) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const packed = await npm(['pack', `${packageName}@${release.version}`, '--pack-destination', directory, '--json'], directory);
      const path = join(directory, parseNpmPackResult(packed).filename);
      const archiveStat = await stat(path);
      if (archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('Web archive too large');
      await verifyArchiveIntegrity(path, release.integrity);
      return path;
    },
  };
}
export async function unpackPackage(archive, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let bytes = 0; let count = 0; let invalid = false;
  await x({ file: archive, cwd: directory, strict: true, preservePaths: false,
    filter(path, entry) {
      const parts = path.split('/');
      if (!path.startsWith('package/') || parts.includes('..') || path.includes('\\')
        || !['File', 'Directory'].includes(entry.type) || ++count > 20_000
        || (bytes += entry.size || 0) > MAX_UNPACKED_BYTES) { invalid = true; return false; }
      return true;
    },
  });
  if (invalid) throw new Error('Unsafe Web archive contents');
  const entries = await readdir(directory);
  if (entries.length !== 1 || entries[0] !== 'package') throw new Error('Invalid Web archive layout');
  return join(directory, 'package');
}
export async function unpackRelease(archive, directory) {
  return inspectRelease(await unpackPackage(archive, directory));
}
export const isNewerVersion = (next, current) => semver.gt(next, current);
