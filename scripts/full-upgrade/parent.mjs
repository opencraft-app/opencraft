#!/usr/bin/env node
import { readFile, realpath, mkdir, rename, readdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { Journal } from './journal.mjs';
import { rootOwned, readConfig, readAuthority } from './service-config.mjs';
import { atomicBytes, atomicJson, privateDirectory, readPrivateJson, bootIdentity, identifier, invariant, sha256 } from './durable.mjs';
import { acceptManifest, parseStrictJson } from '../full-release/contract.mjs';
import { verifyRetainedRelease } from '../full-release/retained.mjs';

/** The recipe is installed by the local root administrator, never supplied by
 * an IPC caller or an unsigned package. Controllers receive one exact signed
 * release and the actual inherited kernel lock. They own intrinsic fences,
 * consumer intents and compatibility recovery; they never replay user work. */
export const parentRecoverySocket = (config, operationId) => join(config.runtimeRoot + '-parent', sha256(Buffer.from(operationId)).slice(0, 24) + '.sock');

export async function parentRecipe(config) {
  invariant(isAbsolute(config.fullRecipePath ?? ''), 'full-recipe-required');
  await rootOwned(config.fullRecipePath);
  const bytes = await readFile(config.fullRecipePath), recipe = parseStrictJson(bytes);
  invariant(recipe.schemaVersion === 1 && recipe.kind === 'opencraft.full-parent'
    && Array.isArray(recipe.steps) && recipe.steps.length > 0 && recipe.steps.length <= 64
    && Array.isArray(recipe.requiredOwners), 'invalid-full-recipe');
  const seen = new Set();
  for (const step of recipe.steps) {
    invariant(identifier(step.id) && !seen.has(step.id) && identifier(step.ownerId)
      && Array.isArray(step.after) && step.after.every(id => seen.has(id)), 'invalid-parent-order');
    invariant(isAbsolute(step.controller) && /^[a-f0-9]{64}$/.test(step.sha256)
      && ['node', 'python3'].includes(step.interpreter), 'invalid-parent-controller');
    await rootOwned(step.controller);
    invariant(sha256(await readFile(step.controller)) === step.sha256, 'parent-controller-drift');
    if (step.policyPath) { await rootOwned(step.policyPath); invariant(sha256(await readFile(step.policyPath)) === step.policySha256, 'parent-policy-drift'); }
    for (const file of step.closure ?? []) { await rootOwned(file.path); invariant(sha256(await readFile(file.path)) === file.sha256, 'parent-closure-drift'); }
    seen.add(step.id);
  }
  invariant(new Set(recipe.requiredOwners).size === recipe.requiredOwners.length
    && recipe.requiredOwners.every(id => recipe.steps.some(s => s.ownerId === id)), 'incomplete-parent-graph');
  return { recipe, recipeBytes: bytes, recipeSha256: sha256(bytes) };
}

export async function parentTarget(config, retainedRoot = null) {
  const deployment = parseStrictJson(await readFile(join(config.webState, 'deployment.json')));
  let root = await realpath(retainedRoot ?? deployment.current.releaseRoot); await rootOwned(root);
  const { trust, state } = await readAuthority(config);
  const bytes = await readFile(join(root, 'release/full-release.json'));
  const accepted = retainedRoot ? { record: parseStrictJson(bytes) } : acceptManifest(bytes, parseStrictJson(await readFile(join(root, 'release/full-release.sig'))), trust, state);
  const manifestSha256 = sha256(bytes);
  invariant(retainedRoot || deployment.current.fullRelease?.manifestSha256 === manifestSha256, 'unaccepted-parent-target');
  await verifyRetainedRelease(root, trust, state);
  if (!retainedRoot) {
    const directory = '/opt/opencraft-full-targets', pin = join(directory, manifestSha256);
    await mkdir(directory, { recursive: true, mode: 0o755 }); await rootOwned(directory);
    try { await rootOwned(pin); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const { command } = await import('./durable.mjs');
      const temporary = pin + '.preparing-' + process.pid;
      await command('/usr/bin/cp', ['-a', '--reflink=auto', root, temporary], { timeout: 180000 });
      await rename(temporary, pin);
    }
    invariant(sha256(await readFile(join(pin, 'release/full-release.json'))) === manifestSha256, 'retained-target-conflict');
    root = pin;
  }
  return { root, manifestSha256, releaseId: accepted.record.release.releaseId,
    sourceRevision: accepted.record.release.source.revision, manifest: accepted.record };
}

export async function controllerCall(config, step, input, lockFd) {
  // Only fixed controller files and interpreters from protected configuration.
  await rootOwned(step.controller);
  invariant(sha256(await readFile(step.controller)) === step.sha256, 'parent-controller-drift');
  return new Promise((resolve, reject) => {
    const child = spawn(step.interpreter === 'node' ? config.node : '/usr/bin/python3', [step.controller], {
      stdio: ['pipe', 'pipe', 'ignore', lockFd], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
    });
    let output = '';
    child.stdin.end(JSON.stringify({ ...input, policyPath: step.policyPath, stepId: step.id, ownerId: step.ownerId, lockFd: 3, deployLock: config.deployLock }));
    child.stdout.on('data', b => { output += b; if (output.length > 1024 * 1024) child.stdout.destroy(); });
    child.once('error', reject);
    // No timeout kills a controller holding a live maintenance transaction.
    // Its bounded forward/recovery policy is part of the installed recipe.
    child.once('exit', code => {
      try {
        invariant(output.length <= 1024 * 1024, 'controller-output-limit');
        const value = JSON.parse(output);
        invariant(code === 0 && value.operationId === input.operationId && value.stepId === step.id
          && value.ownerId === step.ownerId && value.manifestSha256 === input.manifestSha256
          && ['applied', 'not-applied', 'draining', 'recovered', 'blocked'].includes(value.outcome), 'parent-controller-unconfirmed');
        invariant(value.identity === undefined || /^[a-f0-9]{64}$/.test(value.identity), 'invalid-parent-identity');
        resolve(value);
      } catch (e) { reject(e); }
    });
  });
}

export async function ensureParentDelivery(config, directory, dependencies = {}) {
  if (!config.fullCiBeforeParent) return;
  const { command } = await import('./durable.mjs');
  const run = dependencies.command ?? command;
  const pause = dependencies.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  invariant(config.mode === 'ci' && Array.isArray(config.ciRequest) && Array.isArray(config.ciObserve), 'fixed-ci-required');
  const path = join(directory, 'delivery.json');
  let prior; try { prior = await readPrivateJson(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!prior) {
    // Intent precedes the submission. A lost acknowledgement is observed,
    // never submitted a second time after a controller restart.
    await atomicJson(path, { state: 'requested', requestedAt: new Date().toISOString() });
    await run(config.ciRequest[0], config.ciRequest.slice(1));
  }
  const end = Date.now() + 45 * 60 * 1000;
  while (Date.now() < end) {
    const value = JSON.parse(await run(config.ciObserve[0], config.ciObserve.slice(1)));
    invariant(value.admission?.status !== 'failed', 'official-delivery-failed');
    if (!value.manualPending && ['current', 'deployed', 'docs-only'].includes(value.admission?.status)) {
      await atomicJson(path, { state: 'completed', observedAt: new Date().toISOString(), deployedRevision: value.admission.deployedRevision ?? null }); return;
    }
    await pause(2000);
  }
  throw Error('official-delivery-not-terminal');
}

export async function runParent(config, options = {}, dependencies = {}) {
  invariant(identifier(options.operationId), 'invalid-parent-operation');
  const stateDirectory = join(config.controlStateRoot ?? config.stateRoot, 'parents', options.operationId);
  await privateDirectory(stateDirectory);
  const journal = await new Journal(join(stateDirectory, 'journal')).open();
  try { return await runParentJournal(config, options, dependencies, journal, stateDirectory); }
  finally { await journal.close(); }
}
async function runParentJournal(config, { operationId, inspect = false, recover = false, planDigest } = {}, dependencies, journal, stateDirectory) {
  let existing, retained;
  try { existing = await journal.load(operationId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { retained = await readPrivateJson(join(stateDirectory, 'context.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (recover && retained?.configSnapshot) config = { ...retained.configSnapshot, fullRecipePath: join(stateDirectory, 'recipe.json') };
  const { recipe, recipeBytes, recipeSha256 } = await (dependencies.recipe ?? parentRecipe)(config);
  const getTarget = dependencies.target ?? parentTarget;
  let target = await getTarget(config, recover ? retained?.targetRoot : null);
  if (!inspect && config.fullCiBeforeParent && !retained?.targetRoot) {
    const initialDigest = sha256(Buffer.from(JSON.stringify([recipeSha256, target.manifestSha256])));
    invariant(!planDigest || planDigest === initialDigest, 'parent-plan-changed');
    if (!retained) {
      await atomicBytes(join(stateDirectory, 'recipe.json'), recipeBytes);
      await atomicJson(join(stateDirectory, 'context.json'), { configSnapshot: config, targetRoot: null });
    }
    existing ??= await journal.create({ operationId, planDigest: initialDigest, manifestSha256: target.manifestSha256,
      inventoryFingerprint: recipeSha256, bootId: await bootIdentity(),
      steps: recipe.steps.map(s => ({ stepId: s.id, ownerId: s.ownerId, action: 'owner-handoff', epoch: 0, fence: operationId })) });
    existing.state = 'downloading'; existing.releaseId = target.releaseId; existing.startedAt ??= new Date().toISOString(); existing.revision++; await journal.save(existing);
    await ensureParentDelivery(config, stateDirectory, dependencies);
    target = await getTarget(config); planDigest = undefined;
  }
  const digest = sha256(Buffer.from(JSON.stringify([recipeSha256, target.manifestSha256])));
  invariant(!planDigest || planDigest === digest, 'parent-plan-changed');
  const call = dependencies.call ?? ((step, input, fd) => controllerCall(config, step, input, fd));
  // Keep the open file in this parent process, including while a controller
  // recovers. Inherited FD 3 refers to this same locked open-file-description.
  const { open } = await import('node:fs/promises');
  const file = await open(config.deployLock, 'a+', 0o600);
  const { command } = await import('./durable.mjs');
  try { await command('/usr/bin/flock', ['3'], { fd: file.fd, timeout: 3600000 }); }
  catch (e) { await file.close(); throw e; }
  let safe = true, job;
  const context = { operationId, targetRoot: target.root, manifestSha256: target.manifestSha256, releaseId: target.releaseId };
  try {
    // Recheck official pointers after waiting for an in-flight CI transaction.
    invariant((await getTarget(config, recover ? retained?.targetRoot : null)).manifestSha256 === target.manifestSha256, 'parent-target-changed-under-lock');
    const observations = [];
    for (const step of recipe.steps) observations.push(await call(step, { ...context, action: 'inspect' }, file.fd));
    const executable = observations.every(v => v.outcome !== 'blocked');
    const plan = { planId: 'plan-' + digest, planDigest: digest, status: executable ? 'prepared' : 'blocked', executable,
      releaseId: target.releaseId, manifestSha256: target.manifestSha256, sourceRevision: target.sourceRevision ?? null, channel: target.manifest?.release?.channel ?? null, downloadBytes: null,
      components: observations.map((v, i) => ({ componentId: recipe.steps[i].ownerId, role: recipe.steps[i].ownerId, targetVersion: target.releaseId, runningVersion: null, installedVersion: null, nextStartVersion: null, state: v.outcome === 'blocked' ? 'blocked' : v.currentMatched ? 'completed' : 'prepared', impact: 'owner-handoff', blockedReasons: v.outcome === 'blocked' ? ['owner-preflight-rejected'] : [] })),
      executionOrder: recipe.steps.map(s => s.id), blockedReasons: executable ? [] : ['owner-preflight-rejected'] };
    if (inspect) return { plan, fullStackExecutable: executable };
    invariant(executable || recover && existing?.steps.some(s => s.intent && !s.receipt), 'parent-preflight-rejected');
    job = existing ?? await journal.create({ operationId, planDigest: digest, manifestSha256: target.manifestSha256,
      inventoryFingerprint: recipeSha256, bootId: await bootIdentity(),
      steps: recipe.steps.map(s => ({ stepId: s.id, ownerId: s.ownerId, action: 'owner-handoff', epoch: 0, fence: operationId })) });
    if (job.state === 'downloading' && job.steps.every(s => !s.intent)) { job.planDigest = digest; job.manifestSha256 = target.manifestSha256; }
    invariant(job.planDigest === digest, 'parent-idempotency-conflict');
    if (!retained) await atomicBytes(join(stateDirectory, 'recipe.json'), recipeBytes ?? Buffer.from(JSON.stringify(recipe)));
    await atomicJson(join(stateDirectory, 'context.json'), { targetRoot: target.root, configSnapshot: config });
    job.releaseId = target.releaseId; job.startedAt ??= new Date().toISOString();
    if (job.state === 'completed') return { job, fullStackExecutable: true };
    job.state = 'switching'; job.revision++; await journal.save(job);
    for (const [i, step] of recipe.steps.entries()) {
      const row = job.steps[i];
      if (row.receipt?.outcome === 'applied' || row.receipt?.outcome === 'draining') continue;
      if ((await journal.load(operationId)).stopRequested && !row.intent) { job.state = 'deferred'; break; }
      const hadIntent = !!row.intent;
      row.intent ??= { stepId: step.id, action: 'owner-handoff', epoch: 0, fence: operationId };
      job.revision++; await journal.save(job); safe = false;
      let result;
      try { result = await call(step, { ...context, action: hadIntent || recover ? 'recover' : 'apply' }, file.fd); }
      catch {
        // Never rerun apply after an ambiguous response. The same controller
        // recovers current data under the same still-held deployment lock.
        result = await call(step, { ...context, action: 'recover' }, file.fd);
      }
      invariant(['applied', 'draining', 'recovered'].includes(result.outcome) && result.healthy === true, 'parent-step-not-healthy');
      safe = true;
      if (result.outcome === 'recovered' && result.targetMatched !== true) {
        await atomicJson(join(stateDirectory, step.id + '.result.json'), result); job.state = 'rolled-back'; break;
      }
      row.receipt = { outcome: result.outcome === 'draining' ? 'draining' : 'applied', operationId,
        epoch: 0, fence: operationId, healthy: true, evidenceId: result.identity ?? step.sha256 };
      await atomicJson(join(stateDirectory, step.id + '.result.json'), result); job.revision++; await journal.save(job);
    }
    if (job.state === 'switching') job.state = job.steps.some(s => s.receipt?.outcome === 'draining') ? 'active-draining' : 'completed';
    job.finishedAt = new Date().toISOString(); job.revision++; await journal.save(job);
    return { job, fullStackExecutable: true };
  } catch (e) {
    if (job) { job.state = 'recovery-required'; job.revision++; try { await journal.save(job); } catch {} }
    if (!safe) {
      // Both automatic and explicit recovery use this parent with its original
      // kernel lock. An operator can request another recovery attempt by IPC.
      const { serve } = await import('./ipc.mjs');
      await privateDirectory(config.runtimeRoot + '-parent');
      const socket = parentRecoverySocket(config, operationId);
      let finishRecovery; const repaired = new Promise(resolve => { finishRecovery = resolve; });
      const recoveryServer = await serve(socket, async input => {
        invariant(input.action === 'recover' && input.operationId === operationId, 'invalid-parent-recovery');
        const index = job.steps.findIndex(s => s.intent && !s.receipt), step = recipe.steps[index];
        const result = await call(step, { ...context, action: 'recover' }, file.fd);
        invariant(result.healthy === true && ['recovered', 'applied', 'draining'].includes(result.outcome), 'parent-recovery-unconfirmed');
        job.steps[index].receipt = { outcome: result.outcome === 'recovered' && !result.targetMatched ? 'not-applied' : 'applied', operationId, epoch: 0, fence: operationId, healthy: true };
        await atomicJson(join(stateDirectory, step.id + '.result.json'), result); job.state = 'deferred'; job.revision++; await journal.save(job);
        safe = true; finishRecovery({ job, fullStackExecutable: true }); setTimeout(() => recoveryServer.close(), 20); return { recovered: true };
      });
      // Stay alive to preserve the kernel lock and explicit recovery endpoint.
      return await repaired;
    }
    throw e;
  } finally { if (safe) { await file.close(); await journal.close(); } }
}


export async function listParentJobs(config) {
  const directory = join(config.controlStateRoot, 'parents');
  try { return await Promise.all((await readdir(directory)).filter(identifier).slice(-100).map(id => readPrivateJson(join(directory, id, 'journal', id + '.json')).catch(() => null))).then(rows => rows.filter(Boolean)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function stopParent(config, operationId) {
  invariant(identifier(operationId), 'invalid-parent-operation');
  const directory = join(config.controlStateRoot, 'parents', operationId, 'journal');
  const job = await readPrivateJson(join(directory, operationId + '.json'));
  await atomicJson(join(directory, 'stop-requests', operationId + '.json'), { operationId });
  return { ...job, stopRequested: true };
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [flag, configPath, action, operationId, digest] = process.argv.slice(2);
  invariant(flag === '--config' && ['inspect', 'apply', 'recover'].includes(action), 'expected-fixed-parent-config');
  runParent(await readConfig(configPath), { operationId, inspect: action === 'inspect', recover: action === 'recover', planDigest: digest })
    .then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(() => { process.stderr.write('Full parent requires recovery or a fresh plan\n'); process.exitCode = 1; });
}
