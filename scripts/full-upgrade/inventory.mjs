import { readFile, readlink, readdir, stat, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collectCgroupPids } from '../server-deployment/owner-cgroup.mjs';
import { parseReplayState } from '../full-release/contract.mjs';

const exec = promisify(execFile);
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
}
export const fingerprint = value => digest(canonical(value));
export function inventoryIdentity(inventory) {
  const { schemaVersion, kind, mode, consistency, samples, startedAt, completedAt, fingerprint: saved, resources, guarantees, ...identity } = inventory;
  return identity;
}
const unknown = reason => ({ status: 'unknown', reason });
const text = async path => readFile(path, 'utf8');
const json = async path => JSON.parse(await text(path));
const safe = async fn => { try { return await fn(); } catch { return null; } };
async function webStatus(port) {
  if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535) return unknown('no-web-listener-port');
  return await safe(async () => {
    const get = async path => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      let bytes = 0, chunks = [];
      if (!r.ok) throw new Error('Web probe failed');
      for await (const c of r.body) { bytes += c.length; if (bytes > 65536) throw new Error('Web probe too large'); chunks.push(c); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const version = await get('/version.json'), health = await get('/__opencraft_health');
    return { status: 'observed', healthy: health.ok === true,
      version: typeof version.version === 'string' ? version.version : null,
      buildId: typeof version.buildId === 'string' ? version.buildId : null,
      sourceRevision: /^[a-f0-9]{40}$/.test(version.sourceRevision ?? '') ? version.sourceRevision : null };
  }) ?? unknown('public-web-probe-failed');
}
export async function fileIdentity(path) {
  return await safe(async () => {
    const s = await stat(path), hash = createHash('sha256');
    if (!s.isFile()) return null;
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return { path, sha256: hash.digest('hex'), bytes: s.size, uid: s.uid, mode: s.mode & 0o7777 };
  });
}

// This list admits paths only. Never return raw argv, EnvironmentFile contents,
// descriptor URLs, secrets, config digests, or arbitrary exception messages.
const pathFlags = new Set(['--config', '--data-directory', '--runtime-data-directory', '--runtime-directory', '--codex-executable', '--endpoint', '--core-endpoint', '--registry-directory', '--directory']);
const configKeys = ['OPENCRAFT_DSH_HOST_CONFIG', 'OPENCRAFT_ENGINE_HOST_CONFIG', 'OPENCRAFT_ACP_HOST_CONFIG'];
const pathKeys = ['PATH', 'HOME', 'OPENCRAFT_WEB_STATE', 'OPENCRAFT_WEB_RELEASE', 'OPENCRAFT_RELEASE_ROOT', 'OPENCRAFT_EXECUTION_LINK', 'OPENCRAFT_MODEL_STORAGE_DIRECTORY', 'OPENCRAFT_GIT_BIN', 'OPENCRAFT_GIT_BROKER_SOCKET', ...configKeys];
async function processInfo(pid, bootId) {
  return safe(async () => {
    const before = await text(`/proc/${pid}/stat`), fields = before.slice(before.lastIndexOf(')') + 2).split(' ');
    const argv = (await text(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean);
    const environment = Object.fromEntries((await text(`/proc/${pid}/environ`)).split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
    const status = await text(`/proc/${pid}/status`);
    const entry = argv.slice(1).find(x => isAbsolute(x) && /\.(?:[cm]?js)$/.test(x)) ?? null;
    const paths = Object.fromEntries(argv.flatMap((a, i) => pathFlags.has(a) && isAbsolute(argv[i + 1] ?? '') ? [[a.slice(2), argv[i + 1]]] : []));
    const managedPaths = Object.fromEntries(pathKeys.filter(k => environment[k] && (k === 'PATH' || isAbsolute(environment[k]))).map(k => [k, environment[k]]));
    const configs = [];
    for (const [key, path] of [...configKeys.filter(k => managedPaths[k]).map(k => [k, managedPaths[k]]), ...(paths.config ? [['--config', paths.config]] : [])]) {
      const c = await safe(() => json(path));
      const d = c?.descriptorPath ? await safe(() => json(c.descriptorPath)) : null;
      const acp = c?.dataDirectory && key === 'OPENCRAFT_ACP_HOST_CONFIG' ? await safe(() => json(join(c.dataDirectory, 'generations.json'))) : null;
      configs.push({ selector: key, path, status: c ? 'observed' : 'unknown', keys: c ? Object.keys(c).sort() : [],
        descriptor: d ? { schemaVersion: d.schemaVersion ?? null, pid: d.pid ?? null, machineId: d.machineId ?? null, pidMatches: d.pid === pid,
          engines: d.engines ?? null, defaultEngine: d.defaultEngine ?? null } : unknown('no-readable-owner-descriptor'),
        acpGenerations: acp ? { schemaVersion: acp.schemaVersion, current: acp.current,
          entries: acp.generations.map(g => ({ id: g.id, state: g.state, configPath: g.configPath ?? null })), occupancy: unknown('no-complete-ephemeral-lease-observation') } : null,
        paths: c ? Object.fromEntries(['descriptorPath', 'dataDirectory', 'runtimeDirectory', 'modelStorageDirectory', 'projectStorageDirectory', 'sessionCapabilitiesDirectory', 'machineIdentityDirectory', 'dshExecutable', 'dshCapabilityPlugin', 'codexExecutable', 'registryDatabase', 'vaultDirectory', 'socketPath'].filter(k => typeof c[k] === 'string' && isAbsolute(c[k])).map(k => [k, c[k]])) : {} });
    }
    const executable = await readlink(`/proc/${pid}/exe`);
    // Never execute an observed binary: a process named node may be supplied
    // by a different user. Only the kernel identity of this trusted probe's
    // interpreter can establish its version/ABI without running owner code.
    const ownerBinary = await safe(() => stat(`/proc/${pid}/exe`, { bigint: true }));
    const probeBinary = await safe(() => stat('/proc/self/exe', { bigint: true }));
    const node = ownerBinary && probeBinary && ownerBinary.dev === probeBinary.dev && ownerBinary.ino === probeBinary.ino
      ? { version: process.version, abi: Number(process.versions.modules), evidence: 'same-probe-node-inode' } : null;
    const result = { pid, bootId, startTicks: fields[19], parentPid: Number(fields[1]), uid: Number(/Uid:\s+(\d+)/.exec(status)?.[1]), gid: Number(/Gid:\s+(\d+)/.exec(status)?.[1]),
      executable, node, cwd: await readlink(`/proc/${pid}/cwd`), entry,
      installedEntry: entry ? await fileIdentity(entry) : null, provenance: { evidenceKind: 'path-only', runningContent: 'unknown' }, paths, environmentKeys: Object.keys(environment).sort(), managedPaths,
      managedEnvironmentSha256: fingerprint(managedPaths), configs, runningSource: unknown('no-process-attested-source'), readiness: unknown('unit-active-is-not-ready'),
      currentWeb: entry?.endsWith('/runtime/cli.mjs') ? await webStatus(environment.OPENCRAFT_WEB_PORT || '10000') : null };
    const after = await text(`/proc/${pid}/stat`);
    if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== fields[19]) return null;
    return result;
  });
}
async function properties(unit) {
  const result = await safe(() => exec('systemctl', ['show', unit, '--no-pager', '--property=LoadState,ActiveState,SubState,MainPID,FragmentPath,DropInPaths,ControlGroup,User'], { maxBuffer: 256 * 1024, timeout: 5000 }));
  return result ? Object.fromEntries(result.stdout.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })) : null;
}
async function unitInfo(unit, bootId) {
  const p = await properties(unit);
  if (!p) return { unit, status: 'unknown', reason: 'unit-unreadable', processes: [] };
  if (p.LoadState === 'not-found') return { unit, status: 'not-installed', processes: [] };
  let pids = p.MainPID && p.MainPID !== '0' ? [Number(p.MainPID)] : [];
  const members = p.ControlGroup ? await safe(() => collectCgroupPids(join('/sys/fs/cgroup', p.ControlGroup))) : null;
  if (members) pids.push(...members);
  pids = [...new Set(pids)].sort((a, b) => a - b);
  const processes = (await Promise.all(pids.map(pid => processInfo(pid, bootId)))).filter(Boolean);
  const after = await properties(unit);
  return { unit, status: p.ActiveState === 'active' ? 'observed' : 'inactive', activeState: p.ActiveState, subState: p.SubState,
    mainPid: Number(p.MainPID), user: p.User, controlGroup: p.ControlGroup,
    stable: after?.MainPID === p.MainPID && processes.length === pids.length && (!p.ControlGroup || members !== null),
    nextStart: unknown('unit-files-observed-but-next-launch-not-attested'),
    unitFile: p.FragmentPath ? await fileIdentity(p.FragmentPath) : null,
    dropIns: await Promise.all((p.DropInPaths?.split(' ').filter(Boolean) ?? []).map(fileIdentity)), processes };
}

export async function inspectStore(path, owner = 'unknown') {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 1000 });
    db.exec('BEGIN');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const tables = schema.filter(x => x.type === 'table').map(x => x.name);
    const ledger = tables.includes('schema_migrations') ? db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version LIMIT 1024').all() : null;
    let generations = null;
    if (['generations', 'admission', 'thread_routes', 'creation_claims'].every(t => tables.includes(t))) {
      generations = { admission: db.prepare('SELECT generation_id,epoch FROM admission').all(),
        entries: db.prepare('SELECT id,state,incarnation,definition FROM generations LIMIT 1024').all().map(row => {
          const d = JSON.parse(row.definition);
          return { id: row.id, state: row.state, incarnation: row.incarnation,
            paths: Object.fromEntries(['bundle','executable','runtimeDataDirectory','endpoint','node','cwd'].filter(k => typeof d[k] === 'string' && isAbsolute(d[k])).map(k => [k,d[k]])),
            threadBindings: db.prepare('SELECT count(*) AS count FROM thread_routes WHERE generation_id=?').get(row.id).count,
            creationClaims: db.prepare('SELECT state,count(*) AS count FROM creation_claims WHERE generation_id=? GROUP BY state').all(row.id) };
        }), occupancy: unknown('durable-bindings-do-not-cover-ephemeral-leases') };
    }
    return { path, owner, status: 'observed', userVersion: db.prepare('PRAGMA user_version').get().user_version,
      schemaVersion: db.prepare('PRAGMA schema_version').get().schema_version, schemaSha256: fingerprint(schema),
      tables, migrationLedger: ledger ? { status: 'observed', rows: ledger, ownerValidation: 'unknown' } : unknown('no-schema-migrations-ledger'), generations,
      backup: unknown('no-isolated-restore-proof'), compatibility: unknown('no-current-target-schema-proof') };
  } catch { return { path, owner, ...unknown('store-unreadable') }; }
  finally { db?.close(); }
}
async function discoverStores(root, output, depth = 0) {
  if (depth > 5 || output.length >= 256) return;
  const entries = await safe(() => readdir(root, { withFileTypes: true }));
  for (const e of entries ?? []) {
    if (output.length >= 256) break;
    const path = join(root, e.name);
    if (e.isFile() && /\.(?:sqlite3?|db)$/.test(e.name)) output.push(path);
    else if (e.isDirectory() && !['node_modules', '.git', 'rollouts', 'sessions', 'logs'].includes(e.name)) await discoverStores(path, output, depth + 1);
  }
}
async function deployment(stateDirectory) {
  const state = await safe(() => json(join(stateDirectory, 'deployment.json')));
  const pickIdentity = r => r ? Object.fromEntries(['manifestSha256', 'releaseId', 'releaseSequence', 'authorization'].filter(k => r[k] !== undefined).map(k => [k, r[k]])) : null;
  const pick = r => r ? { version: r.version ?? null, buildId: r.buildId ?? null, releaseRoot: r.releaseRoot ?? null,
    fullRelease: pickIdentity(r.fullRelease) } : null;
  let replay = null, replayObservation;
  try { replay = parseReplayState(await readFile(join(stateDirectory, 'full-release-state.json'))); replayObservation = { status: 'observed' }; }
  catch (e) { replayObservation = unknown(e.code === 'ENOENT' ? 'replay-state-missing' : 'replay-state-unreadable-or-invalid'); }
  return { stateDirectory, current: pick(state?.current), previous: pick(state?.previous),
    pointerSha256: fingerprint({ current: pick(state?.current), previous: pick(state?.previous) }),
    replayObservation, replay: replay ? Object.fromEntries(['highestSequence', 'manifestSha256', 'releaseId', 'revocationSequence', 'revokedKeyIds', 'revokedReleaseIds'].filter(k => replay[k] !== undefined).map(k => [k, replay[k]])) : null };
}
export async function collectInventory(profile) {
  if (process.platform !== 'linux') throw new Error('Linux inventory adapter required');
  if (!profile || profile.schemaVersion !== 1 || !Array.isArray(profile.owners)) throw new Error('Invalid inventory profile');
  const startedAt = new Date().toISOString(), bootId = (await text('/proc/sys/kernel/random/boot_id')).trim();
  const listed = await safe(() => exec('systemctl', ['list-units', '--all', '--output=json', '--no-pager'], { timeout: 5000, maxBuffer: 4 * 1024 ** 2 }));
  const names = listed ? JSON.parse(listed.stdout).map(u => u.unit).sort() : [];
  const owners = [], samples = [];
  const unitCache = new Map();
  for (const owner of profile.owners) {
    const units = [...new Set([...(owner.units ?? []), ...names.filter(n => (owner.patterns ?? []).some(p => new RegExp(p).test(n)))])].sort();
    const observations = await Promise.all(units.map(u => { if (!unitCache.has(u)) unitCache.set(u, unitInfo(u, bootId)); return unitCache.get(u); }));
    samples.push({ ownerId: owner.ownerId, sampledAt: new Date().toISOString() });
    owners.push({ ownerId: owner.ownerId, role: owner.role, roles: owner.roles ?? [], management: owner.management ?? 'managed',
      presenceScope: 'profile-standalone-units-only', embeddedPresence: unknown('no-runtime-engine-catalog-attestation'),
      status: owner.management === 'external' && !units.length ? 'external' : !listed ? 'unknown' : !observations.length ? 'unknown' : observations.every(x => x.status === 'not-installed') ? 'not-installed' : 'observed',
      units: observations, capabilities: unknown('no-owner-fence-occupancy-cold-ready-attestation'), retained: unknown('no-complete-thread-tool-lease-inventory') });
  }
  const processes = owners.flatMap(o => o.units.flatMap(u => u.processes));
  const statePaths = [...new Set(processes.map(p => p.managedPaths.OPENCRAFT_WEB_STATE).filter(Boolean))];
  const deployments = await Promise.all(statePaths.map(deployment));
  const roots = [...new Set([...processes.flatMap(p => [p.paths['data-directory'], p.paths['runtime-data-directory'], p.paths['registry-directory'], p.managedPaths.OPENCRAFT_MODEL_STORAGE_DIRECTORY, ...p.configs.map(c => c.paths.dataDirectory)]), ...(profile.storeRoots ?? [])].filter(Boolean))].sort();
  const storePaths = [];
  for (const root of roots) await discoverStores(root, storePaths);
  const stores = await Promise.all([...new Set(storePaths)].sort().map(path => inspectStore(path)));
  const storage = [];
  for (const path of [...new Set([...statePaths, ...roots])]) {
    const s = await safe(() => statfs(path));
    storage.push({ path, availableBytes: s ? s.bavail * s.bsize : null, status: s ? 'observed' : 'unknown' });
  }
  const unmanagedUnits = names.filter(n => (profile.discoveryPatterns ?? []).some(p => new RegExp(p).test(n)) && !owners.some(o => o.units.some(u => u.unit === n)));
  const osRelease = await safe(() => text('/etc/os-release'));
  const machineId = await safe(() => text('/etc/machine-id'));
  const identity = { product: profile.product, channel: profile.channel, profile: profile.profile, bootId,
    adapterProfileSha256: fingerprint(profile), platform: process.platform, arch: process.arch,
    machineIdentitySha256: machineId ? digest(machineId.trim()) : null,
    system: { provider: listed ? 'systemd' : 'unknown', kernel: (await safe(() => text('/proc/sys/kernel/osrelease')))?.trim() ?? null,
      os: osRelease ? Object.fromEntries(osRelease.split('\n').filter(line => /^(?:ID|VERSION_ID)=/.test(line)).map(line => {
        const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')];
      })) : null, management: 'external', nativeClosure: unknown('no-full-running-native-browser-closure-attestation') },
    owners, deployments, stores, storeDiscovery: { roots, maxDepth: 5, maxStores: 256, completeness: 'unknown' }, unmanagedUnits,
    unsupportedComponents: unmanagedUnits.map(unit => ({ unit, status: 'unsupported', impact: 'unknown', reason: 'outside-explicit-profile-owner-map' })) };
  const inventoryFingerprint = fingerprint(identity);
  return { schemaVersion: 1, kind: 'opencraft.upgrade-inventory', mode: 'read-only', consistency: 'component-snapshot', samples, startedAt, completedAt: new Date().toISOString(),
    ...identity, fingerprint: inventoryFingerprint, resources: { storage, availableMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
      probeNode: { version: process.version, abi: Number(process.versions.modules), executable: process.execPath },
      ports: unknown('no-target-port-reservation-proof'), processHeadroom: unknown('no-owner-process-budget'),
      updatePermissions: unknown('read-access-does-not-prove-update-authority'), dependencyReachability: unknown('no-target-closure-probe') },
    guarantees: { executesUpgrade: false, changesServices: false, opensStoresReadOnly: true, occupancyComplete: false } };
}
