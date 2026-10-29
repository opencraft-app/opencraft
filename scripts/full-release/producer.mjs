import { readFile, writeFile, mkdir, rm, stat, mkdtemp, open, rename, copyFile, readdir, chmod, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { parseNpmPackResult } from '../web-deployment/npm-pack-result.mjs';
import { verifyFullArchive } from './archive.mjs';
import { fileListDigest, signPreflight, signBytes, parseManifest, parseStrictJson, preflightFor, sha256 } from './contract.mjs';
import { createPublicKey, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { fullComponents, prepareFullMetadata } from './components.mjs';
const exec = promisify(execFile);
function timing(name, started) {
  if (process.env.OPENCRAFT_PACKAGE_TIMINGS === '1') console.error(`[package-timing] ${name} ${(performance.now() - started).toFixed(0)}ms`);
}
async function canonicalizeStagedModes(root) {
  // The staging tree is public payload. npm preserves restrictive modes rather
  // than repairing them, including release files created under umask 0077.
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await canonicalizeStagedModes(path);
    else if (entry.isFile()) {
      const info = await stat(path);
      if (info.nlink > 1) throw new Error('Full release staging hard links are not supported');
      await chmod(path, info.mode & 0o111 ? 0o755 : 0o644);
    }
    // npm omits symbolic links. Never follow one into an unrelated tree.
  }
}
export async function npmPack(root, directory, dryRun = false) {
  const started = performance.now();
  await canonicalizeStagedModes(root);
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--workspaces=false', '--pack-destination', directory,
    ...(dryRun ? ['--dry-run'] : [])], { cwd: root, maxBuffer: 32 * 1024 ** 2 });
  timing(dryRun ? 'npm-pack-dry-run' : 'npm-pack', started);
  return parseNpmPackResult(JSON.parse(stdout));
}
// Use the same installed npm's inventory rules (files, bundled dependencies,
// ignores and mandatory files), without producing a preliminary gzip stream.
export async function stagedInventory(root) {
  const started = performance.now();
  await canonicalizeStagedModes(root);
  const { stdout } = await exec('which', ['npm']);
  const npmCli = await realpath(stdout.trim());
  const requireNpm = createRequire(npmCli);
  const Arborist = requireNpm('@npmcli/arborist');
  const packlist = requireNpm('npm-packlist');
  const tree = await new Arborist({ path: root }).loadActual();
  const names = await packlist(tree, { path: root });
  const tarOptions = requireNpm('pacote').DirFetcher.tarCreateOptions({ ...tree.package, _resolved: root });
  const files = [];
  for (const name of names) {
    if (name === 'release/full-release.json' || name === 'release/full-release.sig') continue;
    const path = join(root, name), info = await stat(path);
    // Honor this npm's tar filter, including any executable-bin mode policy.
    if (tarOptions.filter) tarOptions.filter(name, info);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== info.size) throw new Error('Full release staged file changed during inventory');
    files.push([name, hash.digest('hex'), bytes, info.mode & 0o111 ? '0755' : '0644']);
  }
  timing('staged-inventory', started);
  return files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
}
export async function sealPackage({ packageRoot, directory, template, keyPath, keyId, trustedKeys = null, identityDirectory = join(dirname(keyPath), 'full-release-identities') }) {
  const keyStat = await stat(keyPath);
  if (!keyStat.isFile() || (keyStat.mode & 0o777) !== 0o600) throw new Error('Full release signing key must have mode 0600');
  const privateKey = await readFile(keyPath);
  const trust = { product: template.release.product, channel: template.release.channel, registry: template.transport.registry,
    packageName: template.transport.packageName, keys: { [keyId]: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) } };
  if (trustedKeys && trust.keys[keyId] !== trustedKeys[keyId]) throw new Error('Full release signing key does not match fixed trust root');
  await rm(join(packageRoot, 'release/full-release.json'), { force: true });
  await rm(join(packageRoot, 'release/full-release.sig'), { force: true });
  // A release without owner attestations intentionally ships an empty,
  // signed policy. CI must explicitly supply verified recipes in a future P3.
  const policyPath = join(packageRoot, 'release/upgrade-policy.json');
  await mkdir(join(packageRoot, 'release'), { recursive: true });
  let policy;
  try { policy = parseStrictJson(await readFile(policyPath)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  policy ??= { schemaVersion: 1, kind: 'opencraft.upgrade-policy', compatibility: [], recipes: [] };
  if ((policy.releaseId && policy.releaseId !== template.release.releaseId)
    || (policy.releaseSequence && policy.releaseSequence !== template.release.releaseSequence)) throw new Error('Upgrade policy release identity mismatch');
  policy.releaseId = template.release.releaseId; policy.releaseSequence = template.release.releaseSequence;
  await writeFile(policyPath, JSON.stringify(policy) + '\n');
  const packagePath = join(packageRoot, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const web = JSON.parse(await readFile(join(packageRoot, 'web/version.json'), 'utf8'));
  if (web.sourceRevision !== template.release.source.revision || web.buildId !== pkg.opencraftWeb?.buildId
    || pkg.version !== template.transport.exactVersion || pkg.name !== template.transport.packageName) throw new Error('Full release staged source mismatch');
  pkg.files = [...new Set([...(pkg.files || []), 'release/'])];
  pkg.opencraftFullRelease = signPreflight(template, privateKey, keyId);
  await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  if (!template.updater.bridge) await prepareFullMetadata(packageRoot);
  // Preliminary/retry packs never overwrite the retained final archive.
  const scratch = await mkdtemp(join(directory, '.full-release-pack-'));
  try {
    const files = await stagedInventory(packageRoot);
    const licenseFiles = files.filter(([name]) => /(?:^|\/)(?:LICENSE(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?)$/i.test(name)).map(([name]) => name);
    if (!licenseFiles.length) throw new Error('Full release licenses are missing');
    const component = { componentId: 'bridge-distribution', role: 'web-bootstrap', version: pkg.version, buildId: pkg.opencraftWeb.buildId,
      sourceRevision: template.release.source.revision, required: true, enabledPolicy: 'preserve',
      content: { kind: 'tree', root: '.', fileListSha256: fileListDigest(files), unpackedBytes: files.reduce((sum, f) => sum + f[2], 0), entries: files.length },
      fileList: files, provides: [{ name: 'full-release-bootstrap', version: '1' }], requires: [],
      activation: { strategy: 'helper', unitRole: 'web-bootstrap', authority: 'unsupported', retainedHistory: true }, licenses: licenseFiles };
    const record = { ...template, components: template.updater.bridge ? [component] : fullComponents(files, pkg, template) };
    const bytes = Buffer.from(JSON.stringify(record)); parseManifest(bytes);
    await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
    const slot = sha256(Buffer.from(JSON.stringify([record.release.product, record.release.channel, pkg.name, pkg.version])));
    const identityPath = join(identityDirectory, slot + '.json');
    const identity = { releaseId: record.release.releaseId, releaseSequence: record.release.releaseSequence,
      manifestSha256: sha256(bytes), sourceRevision: record.release.source.revision, exactVersion: pkg.version };
    let binding;
    try { binding = JSON.parse(await readFile(identityPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (binding) {
      if (Object.keys(identity).some(key => binding[key] !== identity[key])) throw new Error('Full release content changed; allocate a new release identity');
    } else {
      // Exclusive durable reservation occurs BEFORE signing any manifest bytes.
      const handle = await open(identityPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(identity)); await handle.sync(); } finally { await handle.close(); }
      await syncParent(identityPath);
    }
    await mkdir(join(packageRoot, 'release'), { recursive: true });
    await writeFile(join(packageRoot, 'release/full-release.json'), bytes, { mode: 0o644 });
    await writeFile(join(packageRoot, 'release/full-release.sig'), JSON.stringify(signBytes(bytes, privateKey, keyId)), { mode: 0o644 });
    const packed = await npmPack(packageRoot, scratch);
    // The final archive is also the inspection artifact: no second compressor.
    const dryRun = packed;
    const verificationStarted = performance.now();
    const verified = await verifyFullArchive(join(scratch, packed.filename), trust, { preflight: preflightFor(template) });
    timing('verify-full-archive', verificationStarted);
    if (binding?.integrity && binding.integrity !== packed.integrity) throw new Error('Full release archive identity changed');
    const finalIdentity = { ...identity, integrity: packed.integrity, archive: join(directory, packed.filename), buildId: pkg.opencraftWeb.buildId };
    const handle = await open(identityPath + '.tmp', 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(finalIdentity)); await handle.sync(); } finally { await handle.close(); }
    await rename(identityPath + '.tmp', identityPath); await syncParent(identityPath);
    await copyFile(join(scratch, packed.filename), join(directory, packed.filename + '.tmp'));
    const archiveHandle = await open(join(directory, packed.filename + '.tmp'), 'r');
    try { await archiveHandle.sync(); } finally { await archiveHandle.close(); }
    await rename(join(directory, packed.filename + '.tmp'), join(directory, packed.filename));
    await syncParent(join(directory, packed.filename));
    return { ...packed, fullRelease: { releaseId: record.release.releaseId, releaseSequence: record.release.releaseSequence,
      manifestSha256: verified.state.manifestSha256, keyId, compressedBytes: verified.compressedBytes, unpackedBytes: verified.unpackedBytes, entries: verified.entries, dryRun: { integrity: dryRun.integrity, entries: dryRun.entryCount, unpackedBytes: dryRun.unpackedSize },
      components: record.components.map(c => ({ componentId: c.componentId, root: c.content.root, entries: c.content.entries, unpackedBytes: c.content.unpackedBytes })) } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function syncParent(path) {
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
