import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Include the entire transformation, not only the dependency version. A DSH
// patch or closure-policy change must never reuse an older generated payload.
const scripts = ['full-release/runtime-cache.mjs', 'full-release/package-runtime.mjs',
  'full-release/closure.mjs', 'prepare-dsh-runtime.mjs', 'patch-dsh-thread-environment.mjs',
  'patch-dsh-provider-lifecycle.mjs', 'patch-dsh-owner-admission.mjs'];
export async function runtimeCacheKey(repositoryRoot, name) {
  if (!['codex', 'dsh'].includes(name)) throw new Error('Unknown cached runtime');
  const inputs = [`runtime/${name}/package.json`, `runtime/${name}/package-lock.json`, ...scripts.map(p => `scripts/${p}`)];
  const { stdout: npmVersion } = await exec('npm', ['--version']);
  const hashes = await Promise.all(inputs.map(async path => [path, hash(await readFile(join(repositoryRoot, path)))]));
  return hash(JSON.stringify({ schema: 1, name, npm: npmVersion.trim(), node: process.version, abi: process.versions.modules,
    platform: process.platform, arch: process.arch, libc: process.report?.getReport().header.glibcVersionRuntime || null, inputs: hashes }));
}
async function inventory(root) {
  const paths = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Runtime cache requires regular files without links');
    }
  }
  await walk();
  const records = new Array(paths.length);
  let next = 0;
  // Bound descriptor and read pressure even for a runtime with 30,000 files.
  await Promise.all(Array.from({ length: Math.min(16, paths.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= paths.length) return;
      const path = paths[index], info = await lstat(join(root, path));
      if (!info.isFile() || info.nlink !== 1) throw new Error('Runtime cache requires independent regular files');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(join(root, path))) digest.update(chunk);
      records[index] = [path, info.size, info.mode & 0o777, digest.digest('hex')];
    }
  }));
  return records.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
}
async function copyPayload(from, to) {
  // Full runtimes currently target Linux x64. GNU cp provides a fast reflink
  // tree copy with independent inodes; unsupported filesystems copy the bytes.
  await mkdir(to, { recursive: true });
  await exec('cp', ['-R', '--reflink=auto', '--', `${from}/.`, to]);
}
export async function cachedRuntime({ repositoryRoot, name, destination, build,
  cacheRoot = process.env.OPENCRAFT_PACKAGE_CACHE_DIR, log = line => console.error(line) }) {
  const started = performance.now();
  // This component exclusively owns its staging directory. Stale files from a
  // retry must neither contaminate a new cache entry nor cause false misses.
  await rm(destination, { recursive: true, force: true });
  if (!cacheRoot) return build(destination);
  const key = await runtimeCacheKey(repositoryRoot, name);
  const parent = join(cacheRoot, name), entry = join(parent, key);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(entry, 'manifest.json'), 'utf8'));
    if (metadata.key !== key || metadata.schema !== 1 || !metadata.versions || !Array.isArray(metadata.files)) throw new Error('Cache inventory differs');
  } catch { metadata = null; }
  if (metadata) {
    let valid = false;
    try {
      await copyPayload(join(entry, 'payload'), destination);
      valid = JSON.stringify(await inventory(destination)) === JSON.stringify(metadata.files);
      const roots = name === 'codex' ? ['@openai/codex'] : ['@deepseek-ai/dsh', 'ajv'];
      if (Object.keys(metadata.versions).sort().join() !== roots.sort().join()) valid = false;
      for (const dependency of roots) {
        const manifest = JSON.parse(await readFile(join(destination, 'node_modules', dependency, 'package.json')));
        if (metadata.versions[dependency] !== manifest.version) valid = false;
      }
    } catch { /* Missing, linked or unreadable payload: build afresh. */ }
    if (valid) {
      log(`[package-cache] ${name} hit ${(performance.now() - started).toFixed(0)}ms`);
      return metadata.versions;
    }
    await rm(destination, { recursive: true, force: true });
  }
  const versions = await build(destination);
  // Cache publication is atomic and optional; a cache failure must not discard
  // a successfully built payload. Signing and full-archive verification remain
  // mandatory at the caller and never consume a cached manifest or signature.
  let temporary;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    temporary = await mkdtemp(join(parent, '.building-'));
    await copyPayload(destination, join(temporary, 'payload'));
    const files = await inventory(join(temporary, 'payload'));
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ schema: 1, key, versions, files }));
    // Another producer may have won, or an old entry may be corrupt. Rename
    // the old directory aside before replacing it, never write inside it.
    let old;
    try { old = await mkdtemp(join(parent, '.obsolete-')); await rename(entry, join(old, 'entry')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(temporary, entry); temporary = null; }
    finally { if (old) await rm(old, { recursive: true, force: true }); }
  } catch { log(`[package-cache] ${name} cache write unavailable; fresh payload retained`); }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  log(`[package-cache] ${name} miss ${(performance.now() - started).toFixed(0)}ms`);
  return versions;
}
