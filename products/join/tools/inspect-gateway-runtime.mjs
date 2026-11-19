import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read-only software inventory, not a code loader or a deployment authorization.
 * Confirm the caller's image, mounts, NODE_OPTIONS and process separately. */
export async function inspectGatewayRuntime(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) === '/')
    throw Error('An absolute runtime directory is required');
  const read = async (name, maxBytes, optional = false) => {
    let file;
    try { file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > maxBytes) throw Error('Invalid runtime artifact');
      const bytes = await file.readFile(), after = await file.stat();
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw Error('Runtime artifact changed during inspection');
      return { bytes, record: { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        uid: before.uid, gid: before.gid, mode: (before.mode & 0o777).toString(8) } };
    } finally { await file.close(); }
  };
  const launcher = await read('container-service.mjs', 1024 * 1024);
  // Only the known literal launcher shape is supported. Never guess a fallback,
  // execute source, resolve arbitrary imports or follow a selected-file symlink.
  const source = launcher.bytes.toString('utf8');
  const entries = [...source.matchAll(/\bconst entries\s*=\s*\{([^{}]*)\}/g)];
  if (entries.length !== 1) throw Error('Unsupported service launcher');
  const definitions = entries[0][1].split(',').map(value => value.trim()).filter(Boolean);
  const roles = new Map();
  for (const definition of definitions) {
    const match = /^(brain|hands|gateway|proxy)\s*:\s*(['"])([a-z0-9][a-z0-9.-]*\.mjs)\2$/.exec(definition);
    if (!match || roles.has(match[1])) throw Error('Unsupported service entry');
    roles.set(match[1], match[3]);
  }
  const name = roles.get('gateway');
  if (!roles.has('brain') || !roles.has('hands') || !/^container-gateway(?:\.[a-z0-9-]+)?\.mjs$/.test(name ?? '')) throw Error('Unsupported Gateway entry');
  const selected = await read(name, 32 * 1024 * 1024);
  const retained = name === 'container-gateway.mjs' ? selected : await read('container-gateway.mjs', 32 * 1024 * 1024, true);
  const loader = await read('join-credential-loader.mjs', 1024 * 1024, true);
  return { schemaVersion: 1, readOnly: true, launcher: launcher.record, selectedGateway: selected.record,
    retainedGateway: retained?.record ?? null, retainedGatewayIsSelected: name === 'container-gateway.mjs',
    compatibilityLoaderPresent: loader?.record ?? null,
    authority: 'inventory-only; correlate image, mounts, process and NODE_OPTIONS before cutover' };
}

const invokedPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('One runtime directory is required');
    console.log(JSON.stringify(await inspectGatewayRuntime(process.argv[2]), null, 2));
  } catch {
    console.error('Gateway runtime inventory unavailable; no files were modified');
    process.exitCode = 1;
  }
}
