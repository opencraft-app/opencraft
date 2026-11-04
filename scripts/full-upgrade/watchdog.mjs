#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { resolve, join } from 'node:path';
import { readlink, symlink, rename, open, lstat } from 'node:fs/promises';
import { Journal } from './journal.mjs';
import { readPrivateJson } from './durable.mjs';
import { serve, request } from './ipc.mjs';
import { PROTOCOL, readConfig, socketPath, entryIdentity, artifactEntry } from './service-config.mjs';
import { acquireLock, invariant, identifier, command, bootIdentity, sha256 } from './durable.mjs';

async function pointer(config, role) {
  const value = await readlink(join(config.artifactRoot, 'current-' + role));
  invariant(/^[a-f0-9]{64}$/.test(value), 'invalid-current-pointer');
  return value;
}
async function switchPointer(config, role, artifactId) {
  const path = join(config.artifactRoot, 'current-' + role), temporary = path + '.next';
  // Only watchdog writes these fixed names while holding the host lock.
  try { const s = await lstat(temporary); invariant(s.isSymbolicLink(), 'unsafe-next-pointer'); await rename(temporary, path + '.interrupted'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await symlink(artifactId, temporary); await rename(temporary, path);
  const directory = await open(config.artifactRoot, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function healthy(config, role, identity) {
  try { const result = await request(socketPath(config, role), { action: 'status' }, 2000);
    return result.protocol === 1 && result.identity === identity && result.bootId === await bootIdentity(); }
  catch { return false; }
}
async function waitHealthy(config, role, identity, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do {
    if (await healthy(config, role, identity)) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return false;
}

// Independent systemd process, not a child of agent/helper. It alone writes
// handoff intent/receipts and supervises helper replacement and rollback.
export async function startWatchdog(config, entry = process.argv[1], operations = {}) {
  const journal = await new Journal(join(config.controlStateRoot, 'watchdog')).open();
  const identity = await entryIdentity(entry), bootId = await bootIdentity();
  const ops = { artifact: (id, role) => artifactEntry(config, id, role),
    probe: path => command(process.execPath, [path, '--protocol']).then(JSON.parse),
    pointer: role => pointer(config, role),
    switch: (role, id) => switchPointer(config, role, id),
    restart: role => command('/usr/bin/systemctl', ['restart', 'opencraft-upgrade-' + role + '.service']),
    ready: (role, expected) => healthy(config, role, expected),
    wait: (role, expected) => waitHealthy(config, role, expected), ...operations };
  async function recover(job) {
    const step = job.steps[0], role = step.ownerId, initial = !step.intent;
    if (!job.oldArtifactId || !job.newArtifactId) { job.state = 'recovery-required'; job.revision++; return journal.save(job); }
    if (['completed', 'recovery-required'].includes(job.state)) return job;
    const unlock = await acquireLock(config.deployLock);
    try {
      const oldId = job.oldArtifactId, newId = job.newArtifactId;
      const oldEntry = await ops.artifact(oldId, role), next = await ops.artifact(newId, role);
      const oldSha = oldEntry.proof[role + 'Sha256'], newSha = next.proof[role + 'Sha256'];
      if (initial) {
        step.intent = { epoch: step.epoch, fence: step.fence, action: 'handoff', stepId: step.stepId };
        job.state = 'switching'; job.revision++; await journal.save(job);
      }
      const current = await ops.pointer(role);
      invariant(current === oldId || current === newId, 'handoff-pointer-conflict');
      if (current === newId && await ops.ready(role, newSha)) {
        step.receipt = { outcome: 'applied', identity: newSha, epoch: step.epoch, fence: step.fence, healthy: true };
        job.state = 'completed'; job.revision++; return await journal.save(job);
      }
      if (initial) {
        await ops.switch(role, newId); await ops.restart(role);
        if (await ops.wait(role, newSha)) {
          step.receipt = { outcome: 'applied', identity: newSha, epoch: step.epoch, fence: step.fence, healthy: true };
          job.state = 'completed'; job.revision++; return await journal.save(job);
        }
      }
      // Recovery never blindly retries a candidate. A known compatible old
      // artifact is restored by this supervisor, including after helper death.
      job.rollbackIntent = { artifactId: oldId, epoch: step.epoch, fence: step.fence };
      job.revision++; await journal.save(job);
      if (await ops.pointer(role) !== oldId) await ops.switch(role, oldId);
      if (!await ops.ready(role, oldSha)) await ops.restart(role);
      const ready = await ops.wait(role, oldSha);
      job.rollbackReceipt = { outcome: ready ? 'applied' : 'unknown', identity: oldSha, healthy: ready, epoch: step.epoch, fence: step.fence };
      step.receipt = { outcome: 'failed', epoch: step.epoch, fence: step.fence };
      job.state = 'recovery-required'; job.revision++; return await journal.save(job);
    } finally { await unlock(); }
  }
  // A busy CI lock is not failure and never permits a second writer. Startup
  // recovery retries on the next service restart without dropping the intent.
  for (const job of await journal.list()) {
    try { await recover(job); } catch { /* Keep intent; retry under the same lock later. */ }
  }
  async function handle(input) {
    invariant(input && Object.keys(input).every(k => ['action', 'operationId', 'role', 'artifactId'].includes(k)), 'invalid-watchdog-request');
    if (input.action === 'status') return { ...PROTOCOL, role: 'watchdog', identity, pid: process.pid, bootId, jobs: await journal.list() };
    invariant(input.action === 'handoff' && identifier(input.operationId) && ['agent', 'helper'].includes(input.role), 'invalid-handoff');
    const next = await ops.artifact(input.artifactId, input.role);
    const protocol = await ops.probe(next.path);
    invariant(protocol.protocol === 1 && protocol.accepts?.includes(1), 'incompatible-handoff');
    let existing;
    try { existing = await journal.load(input.operationId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing) {
      invariant(existing.newArtifactId === input.artifactId && existing.steps[0].ownerId === input.role, 'handoff-idempotency-conflict');
      return recover(existing);
    }
    const oldId = await ops.pointer(input.role);
    const oldEntry = await ops.artifact(oldId, input.role);
    const oldProtocol = await ops.probe(oldEntry.path);
    invariant(oldProtocol.protocol === 1 && oldProtocol.accepts?.includes(1), 'old-protocol-incompatible');
    const digest = sha256(Buffer.from(input.role + ':' + oldId + ':' + input.artifactId));
    const job = await journal.create({ operationId: input.operationId, planDigest: digest, manifestSha256: next.proof.manifestSha256,
      inventoryFingerprint: digest, bootId,
      steps: [{ stepId: 'handoff', ownerId: input.role, action: 'handoff', epoch: 0, fence: input.operationId }] });
    job.oldArtifactId = oldId; job.newArtifactId = input.artifactId;
    // This receipt fixes both old and new ExecStart artifact references before
    // modifying any pointer, even if the caller disappears immediately.
    job.revision++; await journal.save(job);
    return recover(job);
  }
  let queue = Promise.resolve();
  const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const server = await serve(socketPath(config, 'watchdog'), input => serialize(() => handle(input)), 0o660);
  const timer = setInterval(() => serialize(async () => {
    for (const job of await journal.list()) await recover(job);
    let desired;
    try { desired = await readPrivateJson(join(config.controlStateRoot, 'provisioned.json')); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    invariant(/^[a-f0-9]{64}$/.test(desired.artifactId), 'invalid-provisioned-artifact');
    for (const role of ['helper', 'agent']) {
      if (await ops.pointer(role) !== desired.artifactId) await handle({ action: 'handoff', role,
        artifactId: desired.artifactId, operationId: 'provision-' + desired.artifactId + '-' + role });
    }
  }).catch(() => {}), 5000);
  server.once('close', () => clearInterval(timer));
  return { server, journal, identity, recover };

}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--protocol') { process.stdout.write(JSON.stringify(PROTOCOL) + '\n'); return; }
  invariant(args.length === 2 && args[0] === '--config', 'expected-fixed-config');
  await startWatchdog(await readConfig(resolve(args[1])));
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  main().catch(() => { process.stderr.write('upgrade-watchdog startup failed\n'); process.exitCode = 1; });
}
