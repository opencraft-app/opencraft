import { lstat, realpath, open, mkdir, copyFile, chmod, writeFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { HARD_LIMITS, parseStrictJson, acceptManifest, verifyPreflight, preflightFor } from './contract.mjs';

// Source is a staging tree supplied by the authenticated local administrator.
// Never execute it in place, follow links, or trust its caller's verification.
async function regularFile(root, name) {
  let path = root;
  const parts = name.split('/');
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    if (!(await lstat(path)).isDirectory()) throw new Error('Prepared tree parent is not a directory');
  }
  path = join(root, name);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw new Error('Prepared tree links or special files are unsupported');
  return { path, info };
}
async function metadata(root, name, limit) {
  const { path, info } = await regularFile(root, name);
  if (info.size > limit) throw new Error('Prepared tree metadata budget exceeded');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count !== info.size) throw new Error('Prepared tree metadata changed');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}
export async function readPreparedTree(root, trust, { state = {}, expectedManifestSha256, now = Date.now() } = {}) {
  if (!isAbsolute(root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Prepared tree requires a real absolute directory');
  const bytes = await metadata(root, 'release/full-release.json', HARD_LIMITS.manifestBytes);
  const signature = await metadata(root, 'release/full-release.sig', HARD_LIMITS.metadataBytes);
  const envelope = parseStrictJson(signature, HARD_LIMITS.metadataBytes);
  const accepted = acceptManifest(bytes, envelope, trust, state, null, now);
  if (expectedManifestSha256 !== undefined && accepted.state.manifestSha256 !== expectedManifestSha256) throw new Error('Prepared tree manifest identity mismatch');
  return { ...accepted, bytes, signature, envelope };
}
async function parallel(items, operation) {
  let index = 0;
  // Wait for every worker before throwing: cleanup must not race active copies.
  const results = await Promise.allSettled(Array.from({ length: Math.min(16, items.length) }, async () => {
    while (index < items.length) await operation(items[index++]);
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
export async function copyPreparedTree(source, target, trust, options = {}) {
  const accepted = await readPreparedTree(source, trust, options);
  const files = accepted.record.components.flatMap(c => c.fileList);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o755 }); // Must be a new private installation tree.
  await chmod(target, 0o755);
  const directories = new Set(['release']);
  for (const [name] of files) {
    const parts = name.split('/');
    for (let n = 1; n < parts.length; n++) directories.add(parts.slice(0, n).join('/'));
  }
  for (const name of [...directories].sort((a,b) => a.split('/').length - b.split('/').length)) {
    await mkdir(join(target, name), { mode: 0o755 });
    await chmod(join(target, name), 0o755);
  }
  await parallel(files, async ([name, digest, size, mode]) => {
    const { path, info } = await regularFile(source, name);
    if (info.size !== size || (info.mode & 0o7777) !== parseInt(mode, 8)) throw new Error('Prepared source size or mode mismatch');
    const destination = join(target, name);
    await copyFile(path, destination, constants.COPYFILE_EXCL);
    await chmod(destination, parseInt(mode, 8));
    const copied = await lstat(destination);
    if (!copied.isFile() || copied.nlink !== 1 || copied.size !== size || (copied.mode & 0o7777) !== parseInt(mode, 8)) throw new Error('Prepared target size or mode mismatch');
    const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'); let actual = 0;
    try { for await (const chunk of handle.createReadStream()) { actual += chunk.length; hash.update(chunk); } }
    finally { await handle.close(); }
    if (actual !== size || hash.digest('hex') !== digest) throw new Error('Prepared target digest mismatch');
  });
  await writeFile(join(target, 'release/full-release.json'), accepted.bytes, { flag: 'wx', mode: 0o644 });
  await writeFile(join(target, 'release/full-release.sig'), accepted.signature, { flag: 'wx', mode: 0o644 });
  await chmod(join(target, 'release/full-release.json'), 0o644);
  await chmod(join(target, 'release/full-release.sig'), 0o644);
  const expected = new Set([...files.map(f => f[0]), 'release/full-release.json', 'release/full-release.sig']);
  let entries = 0, bytes = 0;
  async function inventory(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(directory, entry.name), info = await lstat(path);
      entries++;
      if (info.isDirectory() && directories.has(name) && (info.mode & 0o7777) === 0o755) await inventory(path, name + '/');
      else if (info.isFile() && expected.delete(name)) bytes += info.size;
      else throw new Error('Prepared target file set mismatch');
    }
  }
  await inventory(target);
  const budgets = accepted.record.budgets.outer;
  if (expected.size || entries > budgets.entries || bytes > budgets.unpackedBytes) throw new Error('Prepared target file set or budget mismatch');
  const pkg = parseStrictJson(await metadata(target, 'package.json', HARD_LIMITS.metadataBytes));
  const web = parseStrictJson(await metadata(target, 'web/version.json', HARD_LIMITS.metadataBytes));
  if (pkg.name !== accepted.record.transport.packageName || pkg.version !== accepted.record.transport.exactVersion
    || web.sourceRevision !== accepted.record.release.source.revision || web.buildId !== pkg.opencraftWeb?.buildId) throw new Error('Prepared tree package or build identity mismatch');
  if (JSON.stringify(verifyPreflight(pkg.opencraftFullRelease, trust, options.now)) !== JSON.stringify(preflightFor(accepted.record))) throw new Error('Prepared tree preflight mismatch');
  return accepted;
}
