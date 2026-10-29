import { readdir, readFile, readlink, realpath, mkdir, writeFile, rename, rm, mkdtemp } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policyNames = new Set(['package.json', '.npmignore', '.gitignore', 'package-lock.json', '.package-lock.json', 'npm-shrinkwrap.json']);
const inside = path => { const normal = path.replace(/\\/g, '/'); return normal === '' || (!isAbsolute(path) && normal !== '..' && !normal.startsWith('../')); };
const safeName = name => typeof name === 'string' && !name.includes('\\') && !name.startsWith('/') && name.split('/').every(p => p && p !== '.' && p !== '..');

// Only release identity fields unused by npm's file selection are normalized.
// All dependency manifests and ignore bytes remain part of the policy key.
function policyBytes(name, bytes) {
  if (name !== 'package.json') return bytes.toString('base64');
  const manifest = JSON.parse(bytes);
  delete manifest.version;
  delete manifest.opencraftFullRelease;
  if (manifest.opencraftWeb) delete manifest.opencraftWeb.buildId;
  return JSON.stringify(manifest);
}

async function snapshot(root, toolchain) {
  const groups = new Map(), policies = [], directories = new Set();
  let eligible = true;
  async function visit(path = '') {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      const top = name.split('/')[0];
      const group = groups.get(top) ?? []; groups.set(top, group);
      const type = entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : entry.isSymbolicLink() ? 'l' : 'other';
      let target = '';
      if (!safeName(name) || type === 'other') eligible = false;
      if (type === 'l') {
        target = await readlink(join(root, name));
        try {
          const destination = relative(root, await realpath(join(root, name))).replace(/\\/g, '/');
          // Policy symlinks hide policy bytes; cross-directory links can make
          // one top-level selection depend on another directory's topology.
          if (!inside(destination) || destination.split('/')[0] !== top || policyNames.has(entry.name)) eligible = false;
        }
        catch { eligible = false; }
      }
      group.push([name, type, target]);
      if (type === 'd') {
        // npm spells root-level @ entries with a ./ prefix. Leave that rare
        // shape to the original walker rather than normalizing its output.
        if (!path && !name.startsWith('@')) directories.add(name);
        await visit(name);
      } else if (type === 'f' && policyNames.has(entry.name)) {
        const bytes = await readFile(join(root, name));
        policies.push([name, policyBytes(name, bytes)]);
        // A files declaration can lstat outside its package. Do not cache that
        // unsupported shape: its rules might depend on an unscanned tree.
        if (entry.name === 'package.json') {
          const pkg = JSON.parse(bytes);
          if (pkg.files?.some(f => typeof f !== 'string' || f.replace(/^!+/, '').split(/[\\/]/).includes('..'))) eligible = false;
        }
      }
    }
  }
  await visit();
  const policy = digest([1, toolchain, policies]);
  return { eligible, directories, keys: Object.fromEntries([...groups].map(([top, entries]) => [top, digest([policy, entries])])) };
}

export async function selectWithCache({ root, tree, packlist, toolchain, cacheDirectory }) {
  if (!cacheDirectory || !packlist.Walker?.prototype.onReaddir || !packlist.Walker?.prototype.gatherBundles) return packlist(tree, { path: root });
  root = await realpath(root);
  if (inside(relative(root, cacheDirectory))) throw new Error('Selection cache must be outside the staging tree');
  const started = performance.now();
  let state;
  try { state = await snapshot(root, toolchain); }
  catch {
    // npm may legitimately ignore unreadable or malformed policy fixtures.
    // An optional optimization must never add validation to npm's selection.
    console.error('[package-selection] fingerprint unavailable; using npm scan');
    return packlist(tree, { path: root });
  }
  if (!state.eligible) return packlist(tree, { path: root });
  const location = join(cacheDirectory, 'npm-selection-v1.json');
  let previous;
  try {
    previous = JSON.parse(await readFile(location, 'utf8'));
    if (!Array.isArray(previous.entries) || previous.digest !== digest(previous.entries)
      || !previous.entries.every(entry => Array.isArray(entry) && entry.length === 3 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && Array.isArray(entry[2]))) previous = null;
  } catch { /* Missing or damaged cache is a cold scan. */ }
  const reused = new Map();
  for (const [top, key, names] of previous?.entries ?? []) {
    if (state.directories.has(top) && key === state.keys[top] && Array.isArray(names)
      && names.every(name => safeName(name) && name.startsWith(`${top}/`)) && new Set(names).size === names.length) reused.set(top, names);
  }
  // Only the root's entry enumeration and bundle dispatch are pruned. Child
  // walkers and every npm rule/mandatory-file decision retain npm's behavior.
  // package.json and root ignore files are always enumerated and processed.
  class SelectionWalker extends packlist.Walker {
    onReaddir(entries) { return super.onReaddir(entries.filter(name => !reused.has(name))); }
    async gatherBundles() { if (!reused.has('node_modules')) await super.gatherBundles(); }
  }
  const names = await new Promise((resolve, reject) => new SelectionWalker(tree, { path: root, isPackage: true })
    .on('done', resolve).on('error', reject).start());
  for (const cached of reused.values()) names.push(...cached);
  names.sort(packlist.Walker.prototype.sort);
  const entries = [...state.directories].sort().map(top => [top, state.keys[top], names.filter(name => name.startsWith(`${top}/`))]);
  let scratch;
  try {
    await mkdir(cacheDirectory, { recursive: true });
    scratch = await mkdtemp(join(cacheDirectory, '.npm-selection-'));
    const temporary = join(scratch, 'entry.json');
    await writeFile(temporary, JSON.stringify({ entries, digest: digest(entries) }), { mode: 0o600 });
    await rename(temporary, location);
  } catch (error) {
    console.error(`[package-selection] cache write skipped: ${error.code ?? 'error'}`);
  } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  console.error(`[package-selection] reused ${reused.size}/${state.directories.size} directories ${(performance.now() - started).toFixed(0)}ms`);
  return names;
}
