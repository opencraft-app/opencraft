#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
// Explicit official-installation adapter. This is not an HTTP installation API.
import { readFile, mkdir, chmod, chown, cp, lstat, realpath, symlink, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { acceptManifest, parseStrictJson, sha256 } from '../full-release/contract.mjs';
import { verifyRetainedRelease } from '../full-release/retained.mjs';
import { rootOwned } from './service-config.mjs';
import { invariant, atomicJson, atomicBytes, command, acquireLock } from './durable.mjs';
import { request } from './ipc.mjs';

const names = ['agent', 'helper', 'watchdog', 'control'];
const safePath = path => typeof path === 'string' && /^\/[A-Za-z0-9/._-]+$/.test(path) && !path.split('/').includes('..');
export async function install(options) {
  invariant(process.getuid() === 0, 'root-installation-required');
  for (const key of ['releaseRoot', 'webState', 'trustFile', 'profilePath', 'deployLock', 'node']) invariant(safePath(options[key]), 'invalid-install-path');
  invariant(['ci', 'local'].includes(options.mode) && /^[a-z_][a-z0-9_-]*[$]?$/.test(options.user), 'invalid-install-options');
  const root = await realpath(options.releaseRoot), node = await realpath(options.node);
  await rootOwned(root); await rootOwned(node); await rootOwned(options.trustFile); await rootOwned(options.profilePath);
  // Caller may already hold the deployment lock (CI). This flag is not exposed
  // through IPC and requires root plus an inherited live kernel-locked fd.
  let unlock;
  if (options.lockFd !== undefined) {
    const fd = Number(options.lockFd);
    invariant(Number.isSafeInteger(fd) && fd >= 3 && (await realpath('/proc/self/fd/' + fd)) === await realpath(options.deployLock), 'invalid-lock-delegation');
    const info = await readFile('/proc/self/fdinfo/' + fd, 'utf8');
    invariant(/lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE/.test(info), 'unlocked-delegation');
  } else unlock = await acquireLock(options.deployLock);
  try {
    // The existing official updater owns acceptance and all pointers. Reverify
    // against an explicitly provisioned root trust file, never package keys.
    const deployment = JSON.parse(await readFile(join(options.webState, 'deployment.json'), 'utf8'));
    invariant(await realpath(deployment.current.releaseRoot) === root, 'only-official-current-can-provision');
    const replay = parseStrictJson(await readFile(join(options.webState, 'full-release-state.json')));
    const trust = parseStrictJson(await readFile(options.trustFile));
    const bytes = await readFile(join(root, 'release/full-release.json'));
    const envelope = parseStrictJson(await readFile(join(root, 'release/full-release.sig')));
    const accepted = acceptManifest(bytes, envelope, trust, replay);
    invariant(deployment.current.fullRelease?.manifestSha256 === sha256(bytes), 'official-activation-identity-required');
    await verifyRetainedRelease(root, trust, replay);
    invariant(accepted.record.targets.some(t => t.profile === 'headless'), 'headless-required');
    const uid = Number((await command('/usr/bin/id', ['-u', options.user])).trim());
    const gid = Number((await command('/usr/bin/id', ['-g', options.user])).trim());
    invariant(Number.isSafeInteger(uid) && Number.isSafeInteger(gid), 'invalid-deployment-user');
    const artifactRoot = '/opt/opencraft-upgrade';
    await mkdir(artifactRoot, { recursive: true, mode: 0o755 }); await chmod(artifactRoot, 0o755); await rootOwned(artifactRoot);
    const data = await Promise.all(names.map(n => readFile(join(root, 'runtime/upgrade-' + n + '.mjs'))));
    const artifactId = sha256(Buffer.concat([bytes, ...data]));
    const directory = join(artifactRoot, artifactId);
    await mkdir(directory, { mode: 0o755, recursive: true }); await chmod(directory, 0o755);
    for (const [i, name] of names.entries()) {
      const path = join(directory, 'upgrade-' + name + '.mjs');
      try { invariant(sha256(await readFile(path)) === sha256(data[i]), 'immutable-artifact-conflict'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; await atomicBytes(path, data[i], 0o644); }
    }
    // Pin inspection target independently of official Web GC, without copying
    // runtime/user data. Only signed metadata is needed by createPlan.
    await mkdir(join(directory, 'release'), { recursive: true }); await chmod(join(directory, 'release'), 0o755);
    await atomicBytes(join(directory, 'release/full-release.json'), bytes, 0o644);
    await atomicBytes(join(directory, 'release/full-release.sig'), await readFile(join(root, 'release/full-release.sig')), 0o644);
    try {
      const policyBytes = await readFile(join(root, 'release/upgrade-policy.json'));
      const policyEntry = accepted.record.components.flatMap(c => c.fileList).find(f => f[0] === 'release/upgrade-policy.json');
      invariant(policyEntry?.[1] === sha256(policyBytes) && policyEntry[2] === policyBytes.length, 'unsigned-upgrade-policy');
      await atomicBytes(join(directory, 'release/upgrade-policy.json'), policyBytes, 0o644);
    } catch (error) { if (error.code !== 'ENOENT') throw error; } // Older P2 archives remain blocked.
    const proof = { protocol: 1, artifactId, manifestSha256: sha256(bytes), releaseId: accepted.record.release.releaseId,
      releaseSequence: accepted.record.release.releaseSequence, keyId: envelope.keyId,
      ...Object.fromEntries(names.map((n, i) => [n + 'Sha256', sha256(data[i])])) };
    await atomicJson(join(directory, 'installation.json'), proof);
    const configDir = '/etc/opencraft-upgrade';
    await mkdir(configDir, { recursive: true, mode: 0o750 }); await chmod(configDir, 0o750); await chown(configDir, 0, gid);
    const trustPath = join(configDir, 'trust.json');
    await atomicJson(trustPath, trust); await chmod(trustPath, 0o640); await chown(trustPath, 0, gid);
    await atomicBytes(join(configDir, 'profile.json'), await readFile(options.profilePath), 0o640); await chown(join(configDir, 'profile.json'), 0, gid);
    const config = { protocol: 1, mode: options.mode, stateRoot: '/var/lib/opencraft-upgrade-agent',
      controlStateRoot: '/var/lib/opencraft-upgrade-control', runtimeRoot: '/run/opencraft-upgrade', artifactRoot,
      deployLock: options.deployLock, profilePath: join(configDir, 'profile.json'), targetRoot: directory,
      webState: options.webState, trustFile: trustPath, serviceUser: options.user, node,
 };
    // No arbitrary command arrives from IPC. CI command is product composition,
    // supplied only by the root installer and serialized in protected config.
    if (options.mode === 'ci') {
      invariant(Array.isArray(options.ciRequest) && options.ciRequest.length > 0 && safePath(options.ciRequest[0]), 'ci-request-required');
      invariant(Array.isArray(options.ciObserve) && options.ciObserve.length > 0 && safePath(options.ciObserve[0]), 'ci-observe-required');
      config.ciRequest = options.ciRequest; config.ciObserve = options.ciObserve;
    }
    const configPath = join(configDir, 'config.json');
    let previousConfig;
    try { previousConfig = JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (previousConfig) invariant(['mode', 'stateRoot', 'controlStateRoot', 'runtimeRoot', 'artifactRoot', 'deployLock', 'webState', 'serviceUser', 'node'].every(k => previousConfig[k] === config[k]), 'explicit-bootstrap-migration-required');
    if (previousConfig?.generationRecipePath) {
      invariant(safePath(previousConfig.generationRecipePath), 'invalid-generation-recipe-path');
      await rootOwned(previousConfig.generationRecipePath);
      config.generationRecipePath = previousConfig.generationRecipePath;
    }
    await atomicJson(configPath, config); await chmod(configPath, 0o640); await chown(configPath, 0, gid);
    for (const [path, owner] of [[config.stateRoot, uid], [config.controlStateRoot, 0]]) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); await chown(path, owner, owner === uid ? gid : 0);
    }
    let first = true;
    try { await lstat(join(artifactRoot, 'current-agent')); first = false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const role of ['agent', 'helper', 'watchdog']) {
      const current = join(artifactRoot, 'current-' + role);
      try { await lstat(current); } catch (e) { if (e.code !== 'ENOENT') throw e; await symlink(artifactId, current); }
      const unit = `[Unit]\nDescription=OpenCraft upgrade ${role}\nAfter=local-fs.target\n[Service]\nType=simple\nUser=${role === 'agent' ? options.user : 'root'}\nGroup=${gid}\nUMask=0077\nRuntimeDirectory=opencraft-upgrade-${role}\nRuntimeDirectoryMode=${role === 'agent' ? '0700' : '0750'}\nExecStart=${node} ${current}/upgrade-${role}.mjs --config ${configPath}\nRestart=always\nRestartSec=3\nTimeoutStopSec=15\nKillMode=control-group\nNoNewPrivileges=yes\n[Install]\nWantedBy=multi-user.target\n`;
      // Stable units use immutable artifact pointers; only watchdog changes
      // agent/helper pointers. Its own protocol-1 binary remains pinned.
      const path = '/etc/systemd/system/opencraft-upgrade-' + role + '.service';
      const { open } = await import('node:fs/promises');
      const tmp = path + '.tmp', file = await open(tmp, 'w', 0o644);
      try { await file.writeFile(unit); await file.chmod(0o644); await file.sync(); } finally { await file.close(); }
      await rename(tmp, path);
    }
    await atomicJson(join(config.controlStateRoot, 'provisioned.json'), { artifactId });
    const { open: openDirectory } = await import('node:fs/promises');
    for (const path of [artifactRoot, directory, configDir, '/etc/systemd/system', '/var/lib']) {
      const handle = await openDirectory(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    await command('/usr/bin/systemctl', ['daemon-reload']);
    await command('/usr/bin/systemctl', ['enable', '--now', ...['watchdog', 'helper', 'agent'].map(r => 'opencraft-upgrade-' + r + '.service')]);
    return { artifactId, firstInstallation: first, protocol: 1, manifestSha256: proof.manifestSha256, roles: names.slice(0, 3) };
  } finally { await unlock?.(); }
}
export async function main(args = process.argv.slice(2)) {
  invariant(args.length === 2 && args[0] === '--options', 'expected-root-options-file');
  await rootOwned(resolve(args[1]));
  const options = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
  process.stdout.write(JSON.stringify(await install(options)) + '\n');
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  main().catch(() => { process.stderr.write('upgrade provisioning failed\n'); process.exitCode = 1; });
}
