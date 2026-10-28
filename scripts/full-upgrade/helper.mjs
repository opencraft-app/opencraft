#!/usr/bin/env node
import { existsSync as existsSyncEntry, realpathSync as realpathSyncEntry } from 'node:fs';
import { resolve, join } from 'node:path';
import { Journal } from './journal.mjs';
import { serve, request } from './ipc.mjs';
import { PROTOCOL, readConfig, socketPath, entryIdentity } from './service-config.mjs';
import { invariant, identifier, command, bootIdentity, sha256 } from './durable.mjs';

export async function startHelper(config, entry = process.argv[1]) {
  const journal = await new Journal(join(config.controlStateRoot, 'helper')).open();
  const identity = await entryIdentity(entry), bootId = await bootIdentity();
  async function ciEvidence() {
    try {
      invariant(Array.isArray(config.ciObserve) && config.ciObserve.length > 0, 'ci-observation-unavailable');
      const value = JSON.parse(await command(config.ciObserve[0], config.ciObserve.slice(1)));
      const projection = { manualPending: value.manualPending === true,
        candidate: /^[a-f0-9]{40}$/.test(value.admission?.candidate ?? '') ? value.admission.candidate : null,
        deployedRevision: /^[a-f0-9]{40}$/.test(value.admission?.deployedRevision ?? '') ? value.admission.deployedRevision : null,
        status: ['waiting', 'ready', 'current', 'building', 'deployed', 'failed', 'locked', 'docs-only'].includes(value.admission?.status) ? value.admission.status : 'unknown' };
      return sha256(Buffer.from(JSON.stringify(projection)));
    } catch { return null; }
  }

  for (const job of await journal.list()) {
    if (!['completed', 'recovery-required'].includes(job.state)) {
      // Lost CI request acknowledgement is uncertain. CI's own candidate and
      // delivery receipts remain authority; never invoke --now a second time.
      const evidenceId = await ciEvidence();
      job.steps[0].receipt = { outcome: 'unknown', epoch: 0, fence: job.operationId,
        ...(evidenceId ? { evidenceId } : {}) };
      job.state = 'recovery-required'; job.revision++; await journal.save(job);
    }
  }
  const server = await serve(socketPath(config, 'helper'), async input => {
    invariant(input && Object.keys(input).every(k => ['action', 'operationId', 'role', 'artifactId'].includes(k)), 'invalid-helper-request');
    if (input.action === 'status') return { ...PROTOCOL, role: 'helper', identity, pid: process.pid, bootId, jobs: await journal.list() };
    invariant(identifier(input.operationId), 'invalid-operation');
    if (input.action === 'handoff') {
      invariant(['agent', 'helper'].includes(input.role) && /^[a-f0-9]{64}$/.test(input.artifactId), 'invalid-handoff');
      return request(socketPath(config, 'watchdog'), input, 120000);
    }
    invariant(input.action === 'request-ci' && config.mode === 'ci', 'operation-not-allowlisted');
    const fingerprint = sha256(Buffer.from('request-existing-ci'));
    const job = await journal.create({ operationId: input.operationId, planDigest: fingerprint, manifestSha256: fingerprint,
      inventoryFingerprint: fingerprint, bootId, steps: [{ stepId: 'request-ci', ownerId: 'ci', action: 'wake', epoch: 0, fence: input.operationId }] });
    const step = job.steps[0];
    if (step.intent) return job;
    step.intent = { epoch: 0, fence: input.operationId };
    job.state = 'switching'; job.revision++; await journal.save(job);
    // Fixed command, config, unit and source selection. deploy.py --now only
    // submits to the existing service, which acquires the deployment lock.
    invariant(Array.isArray(config.ciRequest) && config.ciRequest.length > 0 && config.ciRequest.every(v => typeof v === 'string'), 'ci-command-not-configured');
    await command(config.ciRequest[0], config.ciRequest.slice(1));
    step.receipt = { outcome: 'applied', evidenceId: input.operationId, epoch: 0, fence: input.operationId };
    job.state = 'completed'; job.revision++; await journal.save(job);
    return job;
  }, 0o660);
  return { server, journal, identity };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--protocol') { process.stdout.write(JSON.stringify(PROTOCOL) + '\n'); return; }
  invariant(args.length === 2 && args[0] === '--config', 'expected-fixed-config');
  await startHelper(await readConfig(resolve(args[1])));
}
if (process.argv[1] && existsSyncEntry(process.argv[1]) && realpathSyncEntry(process.argv[1]) === realpathSyncEntry(new URL(import.meta.url))) {
  main().catch(() => { process.stderr.write('upgrade-helper startup failed\n'); process.exitCode = 1; });
}
