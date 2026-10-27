import { mkdir, readdir, readFile, realpath, stat, copyFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
async function sourcePackageRoot() {
  // import.meta.url becomes the entry URL after bundling. The nearest package
  // owns that entry; a fixed number of parent traversals can escape its release.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try { if ((await stat(join(directory, 'package.json'))).isFile()) return directory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Runtime source package boundary is missing');
    directory = parent;
  }
}

// Copy code, not shared inode identities. Package-local links become ordinary
// files/directories; external targets and directory cycles are rejected.
export async function copyCodeTree(source, destination, { boundary = source, excludeModules = false } = {}, ancestors = new Set()) {
  const allowed = await realpath(boundary), actual = await realpath(source);
  if (actual !== allowed && !actual.startsWith(allowed + sep)) throw new Error('Runtime link escapes its package');
  const info = await stat(actual);
  if (info.isDirectory()) {
    if (ancestors.has(actual)) throw new Error('Runtime directory link cycle');
    const next = new Set(ancestors).add(actual);
    await mkdir(destination, { recursive: true }); await chmod(destination, 0o755);
    for (const name of await readdir(actual)) {
      if (excludeModules && name === 'node_modules') continue;
      await copyCodeTree(join(actual, name), join(destination, name), { boundary: allowed, excludeModules: false }, next);
    }
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true }); await copyFile(actual, destination);
    await chmod(destination, info.mode & 0o111 ? 0o755 : 0o644);
  } else throw new Error('Unsupported runtime entry');
}

async function locate(name, resolver, allowed) {
  // Reading package roots also handles export-restricted ESM and npm aliases.
  for (const parent of resolver.resolve.paths(name) || []) {
    const candidate = join(parent, name);
    if (!candidate.startsWith(allowed + sep)) continue;
    try { const root = await realpath(candidate); if (!root.startsWith(allowed + sep)) throw new Error('Runtime package escapes its locked installation'); const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); return { root, manifest }; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw Object.assign(new Error('Missing runtime dependency: ' + name), { code: 'MODULE_NOT_FOUND' });
}

export async function copyDependencyClosure(destination, roots, resolver = createRequire(import.meta.url), installationRoot = null) {
  const allowed = await realpath(installationRoot ?? await sourcePackageRoot());
  destination = resolve(destination); await mkdir(destination, { recursive: true });
  const placed = new Map(), versions = {}, rootSources = new Map();
  for (const name of roots) rootSources.set(name, await locate(name, resolver, allowed));
  async function accessible(parent, name) {
    let directory = parent;
    while (directory === dirname(destination) || directory.startsWith(dirname(destination) + sep)) {
      const candidate = join(directory, 'node_modules', name);
      if (placed.has(candidate)) return placed.get(candidate);
      try { return { target: candidate, manifest: JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')) }; }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      directory = dirname(directory);
    }
    return null;
  }
  async function copy(name, from, parent = null, optional = false) {
    let found;
    try { found = (!parent && rootSources.get(name)) || await locate(name, from, allowed); }
    catch (error) { if (optional && error.code === 'MODULE_NOT_FOUND') return; throw error; }
    const { root, manifest } = found;
    const prior = parent ? await accessible(parent, name) : null;
    if (prior?.root === root) return;
    // A nearer mismatched package shadows even a correct shared package.
    // Existing files from a separate copy call have no proven source identity;
    // preserve resolution by making a local copy rather than guessing by version.
    const shared = join(destination, name);
    const reservedRoot = rootSources.get(name);
    const target = parent && (prior || (reservedRoot && reservedRoot.root !== root)) ? join(parent, 'node_modules', name) : shared;
    if (placed.has(target)) {
      if (placed.get(target).root !== root) throw new Error('Runtime resolution collision');
      return;
    }
    placed.set(target, { root, manifest, target });
    await copyCodeTree(root, target, { excludeModules: true });
    const next = createRequire(join(root, 'package.json'));
    const optionalNames = new Set(Object.keys(manifest.optionalDependencies || {}));
    const peers = manifest.peerDependencies || {};
    for (const dependency of new Set([...Object.keys(manifest.dependencies || {}), ...optionalNames, ...Object.keys(peers)])) {
      await copy(dependency, next, target, optionalNames.has(dependency) || manifest.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  }
  for (const name of roots) { await copy(name, resolver); versions[name] = rootSources.get(name).manifest.version; }
  return versions;
}
