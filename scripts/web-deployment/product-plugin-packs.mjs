import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat, readdir, mkdir, copyFile, rename, rm, chmod, open } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pathAllowed = path => typeof path === 'string' && /^(?:assets|__opencraft_product_plugins)\/[A-Za-z0-9._/-]+$/.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..');
async function optional(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Product plugin inventory too large or invalid');
    return await readFile(path);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function parseProductPluginInventory(bytes) {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Product plugin inventory too large');
  const inventory = JSON.parse(bytes.toString('utf8')), ids = new Set();
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.packages) || inventory.packages.length > 64) throw new Error('Invalid product plugin inventory');
  for (const pack of inventory.packages) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pack.id ?? '') || ids.has(pack.id) || !pathAllowed(pack.manifest)
      || !pack.manifest.startsWith('__opencraft_product_plugins/') || !Array.isArray(pack.files) || !pack.files.length || pack.files.length > 10000
      || !Array.isArray(pack.external) || !pack.external.includes(pack.manifest)) throw new Error('Invalid product plugin package');
    ids.add(pack.id);
    const paths = new Set(); let size = 0;
    for (const file of pack.files) {
      if (!pathAllowed(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 16 * 1024 * 1024 || (size += file.bytes) > 128 * 1024 * 1024) throw new Error('Invalid product plugin file');
      paths.add(file.path);
    }
    if (!paths.has(pack.manifest) || pack.external.some(path => !paths.has(path))) throw new Error('Invalid product plugin ownership');
  }
  return inventory;
}
async function contained(root, path) {
  const base = await realpath(root), file = await realpath(resolve(base, path));
  if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) throw new Error('Product plugin path escaped its root');
  return file;
}
async function checked(root, record) {
  const file = await contained(root, record.path), info = await stat(file);
  if (info.size !== record.bytes || sha(await readFile(file)) !== record.sha256) throw new Error('Product plugin integrity mismatch');
  return file;
}
async function durable(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }

/** Build-time split. Shared module identities remain in Web and are also
 * retained with the plugin so old browser tabs can finish loading their graph. */
export async function splitProductPluginPacks(webRoot, destination) {
  let bytes = await optional(join(webRoot, 'product-plugins.json')); if (!bytes) return null;
  const inventory = parseProductPluginInventory(bytes);
  const retainedOriginals = new Set(inventory.packages.flatMap(pack => pack.files.filter(file => !pack.external.includes(file.path)).map(file => file.path)));
  // Exclusive files leave Web, so their prebuilt representations must leave
  // with them. Shared Web assets already retain their sidecars. No request-time
  // compression, schema change or mutable URL is needed by existing readers.
  for (const pack of inventory.packages) {
    const known = new Set(pack.files.map(file => file.path));
    for (const record of [...pack.files]) {
      if (!pack.external.includes(record.path) || retainedOriginals.has(record.path) || !/\.(?:js|css|svg|json)$/.test(record.path)) continue;
      for (const [suffix, decode] of [['.gz', gunzipSync], ['.br', brotliDecompressSync]]) {
        const path = record.path + suffix;
        let source;
        try { source = await contained(webRoot, path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const info = await stat(source);
        if (info.size >= record.bytes) continue;
        const compressed = await readFile(source);
        // A valid compressed file must represent the exact immutable original.
        // Bound decoding to the declared original size, including corrupt bombs.
        const decoded = decode(compressed, { maxOutputLength: Math.max(1, record.bytes) });
        if (decoded.length !== record.bytes || sha(decoded) !== record.sha256)
          throw new Error('Product plugin compression integrity mismatch');
        if (!known.has(path)) {
          pack.files.push({ path, bytes: compressed.length, sha256: sha(compressed) });
          pack.external.push(path); known.add(path);
        }
      }
    }
  }
  bytes = Buffer.from(JSON.stringify(inventory));
  parseProductPluginInventory(bytes); // Keep the same inventory/file/size limits.
  for (const pack of inventory.packages) for (const record of pack.files) {
    const source = await checked(webRoot, record), target = join(destination, 'public', record.path);
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
  }
  await writeInventory(destination, bytes);
  const retained = new Set(inventory.packages.flatMap(pack => pack.files.filter(file => !pack.external.includes(file.path)).map(file => file.path)));
  for (const path of new Set(inventory.packages.flatMap(pack => pack.external))) if (!retained.has(path)) {
    for (const suffix of ['', '.gz', '.br', '.map']) await rm(join(webRoot, path + suffix), { force: true });
  }
  await rm(join(webRoot, 'product-plugins.json'));
  return { schemaVersion: 1, inventorySha256: sha(bytes) };
}
async function writeInventory(root, bytes) {
  await mkdir(root, { recursive: true }); const fd = await open(join(root, 'inventory.json'), 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}

/** Deployment owner prepares immutable snapshots before starting a reader.
 * This is derived code, not plugin data or a second activation-state authority. */
export async function prepareProductPluginPacks({ sourceDirectory, cacheDirectory, webRoot, expectedInventory = null }) {
  const bytes = await optional(join(sourceDirectory, 'inventory.json'));
  if (expectedInventory !== null && (!/^[a-f0-9]{64}$/.test(expectedInventory) || !bytes || sha(bytes) !== expectedInventory))
    throw new Error('Selected product plugin inventory unavailable or changed');
  if (!bytes) return;
  const inventory = parseProductPluginInventory(bytes), key = sha(bytes), destination = join(cacheDirectory, key);
  const retained = await openProductPluginAssets(cacheDirectory);
  for (const pack of inventory.packages) for (const file of pack.files) {
    const previous = retained?.identity(file.path);
    if (previous && previous !== file.sha256) throw new Error('Product plugin URL identity collision');
  }
  // A tightly coupled plugin must use the exact shared modules from this release.
  for (const pack of inventory.packages) for (const file of pack.files) if (!pack.external.includes(file.path)) await checked(webRoot, file);
  const verify = async root => {
    if (sha(await readFile(join(root, 'inventory.json'))) !== key) throw new Error('Product plugin snapshot identity changed');
    for (const pack of inventory.packages) for (const file of pack.files) await checked(join(root, 'public'), file);
  };
  try { await verify(destination); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(cacheDirectory, '.prepare-' + randomUUID());
  try {
    const directories = new Set([temporary]);
    for (const pack of inventory.packages) for (const record of pack.files) {
      const source = await checked(join(sourceDirectory, 'public'), record), target = join(temporary, 'public', record.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(source, target); await chmod(target, 0o444); await durable(target);
      for (let path = dirname(target); path.startsWith(temporary + sep); path = dirname(path)) directories.add(path);
    }
    await writeInventory(temporary, bytes); await chmod(join(temporary, 'inventory.json'), 0o444);
    for (const path of [...directories].sort((a, b) => b.length - a.length)) await durable(path);
    try { await rename(temporary, destination); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; await verify(destination); }
    await durable(cacheDirectory);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** A Web reader serves only files in retained, verified inventories. No code
 * execution, directory discovery activation, or mutable latest pointer here. */
export async function openProductPluginAssets(cacheDirectory) {
  const files = new Map();
  let snapshots; try { snapshots = await readdir(cacheDirectory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const key of snapshots.filter(name => /^[a-f0-9]{64}$/.test(name))) {
    const directory = join(cacheDirectory, key), bytes = await optional(join(directory, 'inventory.json'));
    if (!bytes || sha(bytes) !== key) throw new Error('Product plugin snapshot identity changed');
    for (const pack of parseProductPluginInventory(bytes).packages) for (const record of pack.files) {
      const previous = files.get(record.path);
      if (previous && previous.record.sha256 !== record.sha256) throw new Error('Product plugin URL identity collision');
      files.set(record.path, { directory: join(directory, 'public'), record });
    }
  }
  return {
    identity(path) { return files.get(path)?.record.sha256; },
    has(path) { return files.has(path); },
    async resolve(path) { const file = files.get(path); return file ? checked(file.directory, file.record) : null; },
  };
}

/** Both managed Web workers and Headless/Compose use the selected release's
 * metadata. The persistent directory stores code; it never selects a release. */
export async function prepareProductPluginRelease({ releaseRoot, cacheDirectory, webRoot = join(releaseRoot, 'web'), metadata = null }) {
  if (metadata !== null && (metadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(metadata.inventorySha256 ?? '')))
    throw new Error('Unsupported product plugin package');
  await prepareProductPluginPacks({ sourceDirectory: join(releaseRoot, 'runtime/product-plugins'), cacheDirectory, webRoot,
    expectedInventory: metadata?.inventorySha256 ?? null });
  return openProductPluginAssets(cacheDirectory);
}
