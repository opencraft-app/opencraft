#!/usr/bin/env node
import { realpath as realEntryPath } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Journal } from './journal.mjs';
import { generationControl } from './generation-control.mjs';
import { inspect } from './inspect.mjs';
import { serve, request } from './ipc.mjs';
import { PROTOCOL, readConfig, socketPath, entryIdentity } from './service-config.mjs';
import { invariant, identifier, bootIdentity, sha256, privateDirectory } from './durable.mjs';

export async function startAgent(config, entry = process.argv[1]) {
  await privateDirectory(config.stateRoot);
  const journal = await new Journal(join(config.stateRoot, 'agent')).open();
  const identity = await entryIdentity(entry), bootId = await bootIdentity();
  // P3 adapters intentionally absent. Persisted uncertain work cannot acquire
  // permission from a fresh process, a new boot, or a healthy website.
  for (const job of await journal.list()) {
    if (!['blocked', 'completed', 'rolled-back', 'active-draining', 'recovery-required'].includes(job.state)) {
      job.state = 'recovery-required'; job.revision++; await journal.save(job);
    }
  }
  const server = await serve(socketPath(config, 'agent'), async input => {
    invariant(input && Object.keys(input).every(k => ['action', 'operationId', 'planId', 'planDigest'].includes(k)), 'invalid-request');
    if (input.action === 'status') return { ...PROTOCOL, role: 'agent', identity, pid: process.pid, bootId,
      mode: config.mode, ownerAdapters: config.generationRecipePath ? ['codex-generation', 'acp-generation'] : [], jobs: await journal.list() };
    if (input.action === 'request-ci') {
      invariant(config.mode === 'ci' && identifier(input.operationId), 'ci-only');
      // This is a CI wake-up request, not acceptance of a full-upgrade plan.
      return request(socketPath(config, 'helper'), { action: 'request-ci', operationId: input.operationId });
    }
    if (['generation-inspect', 'generation-apply'].includes(input.action)) {
      invariant(identifier(input.operationId), 'invalid-operation');
      return generationControl(config, input, journal, bootId);
    }
    invariant(input.action === 'inspect' && identifier(input.operationId), 'unsupported-action');
    let prior;
    try { prior = await journal.load(input.operationId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (prior) {
      invariant((!input.planDigest || input.planDigest === prior.planDigest) && (!input.planId || input.planId === 'plan-' + prior.planDigest), 'idempotency-conflict');
      return { job: prior, planId: 'plan-' + prior.planDigest, executable: false, blockedReasons: ['real-owner-adapters-unavailable'] };
    }
    const profile = JSON.parse(await readFile(config.profilePath, 'utf8'));
    const { inventory, plan } = await inspect({ profile, targetRoot: config.targetRoot });
    invariant(plan && (!input.planId || input.planId === plan.planId) && (!input.planDigest || input.planDigest === plan.planDigest), 'plan-drift');
    const job = await journal.create({ operationId: input.operationId, planDigest: plan.planDigest,
      manifestSha256: plan.target.manifestSha256, inventoryFingerprint: inventory.fingerprint, bootId, steps: [] });
    job.state = 'blocked'; job.revision++; await journal.save(job);
    return { job, planId: plan.planId, executable: false, blockedReasons: plan.blockedReasons };
  });
  return { server, journal, identity };
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--protocol') { process.stdout.write(JSON.stringify(PROTOCOL) + '\n'); return; }
  invariant(args.length === 2 && args[0] === '--config', 'expected-fixed-config');
  await startAgent(await readConfig(resolve(args[1])));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realEntryPath(resolve(process.argv[1]))).href) {
  main().catch(() => { process.stderr.write('upgrade-agent startup failed\n'); process.exitCode = 1; });
}
