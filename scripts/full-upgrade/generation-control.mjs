import { readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute, sep } from 'node:path';
import { acceptManifest, parseStrictJson, sha256 } from '../full-release/contract.mjs';
import { verifyRetainedRelease } from '../full-release/retained.mjs';
import { createHash } from 'node:crypto';
import { collectInventory, fingerprint, inventoryIdentity } from './inventory.mjs';
import { rootOwned, readAuthority } from './service-config.mjs';
import { generationOwner } from './generation-owner.mjs';
import { acceptGenerationPlan, switchGeneration } from './generation-upgrade.mjs';
import { invariant, identifier } from './durable.mjs';

// Initial ACP support is deliberately narrow: a signed native entry, or a
// signed interpreter plus absolute signed script arguments. No external entry,
// relative script, loader injection or product-specific launch rewrite.
export async function acpExecutionIdentity(configuration, releaseRoot) {
  invariant(!configuration.dshEntry, 'acp-launch-rewrite-unverified');
  invariant(Object.keys(configuration.env ?? {}).every(key => !/^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|PYTHONPATH$|PYTHONSTARTUP$|BASH_ENV$|ENV$)/.test(key)), 'acp-loader-environment-unverified');
  const root = await realpath(releaseRoot), paths = [configuration.command];
  for (const arg of configuration.args ?? []) {
    if (arg === '--expose-internals') continue;
    invariant(typeof arg === 'string' && isAbsolute(arg), 'acp-argument-closure-unverified');
    paths.push(arg);
  }
  const entries = [];
  for (const path of paths) {
    invariant(typeof path === 'string' && isAbsolute(path), 'acp-command-closure-unverified');
    const resolved = await realpath(path);
    invariant(resolved.startsWith(root + sep), 'acp-execution-outside-signed-closure');
    await rootOwned(resolved);
    entries.push({ path: resolved, sha256: sha256(await readFile(resolved)) });
  }
  return fingerprint(entries);
}

// Explicitly provisioned, root-owned local recipe; packages and IPC cannot
// select endpoints, definitions, matrices, credentials or arbitrary commands.
export async function generationControl(config, input, journal, bootId) {
  if (input.action === 'generation-apply') {
    let prior;
    try { prior = await journal.load(input.operationId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (prior) {
      invariant(prior.planDigest === input.planDigest, 'idempotency-conflict');
      if (!['completed', 'rolled-back', 'active-draining', 'blocked', 'recovery-required'].includes(prior.state)) {
        prior.state = 'recovery-required'; prior.revision++; await journal.save(prior);
      }
      return { job: prior, scope: 'generation-only', fullStackExecutable: false };
    }
  }
  invariant(config.generationRecipePath && isAbsolute(config.generationRecipePath), 'generation-recipe-unavailable');
  await rootOwned(config.generationRecipePath);
  const recipe = parseStrictJson(await readFile(config.generationRecipePath));
  invariant(recipe.schemaVersion === 1 && ['codex', 'acp'].includes(recipe.kind) && identifier(recipe.targetId), 'invalid-generation-recipe');
  for (const key of ['matrixPath', 'signaturePath']) { invariant(isAbsolute(recipe[key]), 'invalid-matrix-path'); await rootOwned(recipe[key]); }
  const matrixBytes = await readFile(recipe.matrixPath), signature = parseStrictJson(await readFile(recipe.signaturePath));
  const { trust, state } = await readAuthority(config);
  const manifestBytes = await readFile(join(config.targetRoot, 'release/full-release.json'));
  const manifestSignature = parseStrictJson(await readFile(join(config.targetRoot, 'release/full-release.sig')));
  acceptManifest(manifestBytes, manifestSignature, trust, state);
  // Verify the full signed closure before starting a CLI. Private ACP config
  // remains owner-pinned and is explicitly included in the signed recipe hash.
  const deployment = parseStrictJson(await readFile(join(config.webState, 'deployment.json')));
  const releaseRoot = recipe.releaseRoot ?? deployment.current?.releaseRoot;
  invariant(isAbsolute(releaseRoot), 'generation-release-unavailable'); await rootOwned(releaseRoot);
  invariant(sha256(await readFile(join(releaseRoot, 'release/full-release.json'))) === sha256(manifestBytes), 'generation-release-drift');
  await verifyRetainedRelease(releaseRoot, trust, state);
  const root = await realpath(releaseRoot);
  invariant(!recipe.definition.externalUnit, 'candidate-adoption-unavailable');
  if (recipe.kind === 'codex') for (const key of ['executable', 'bundle', 'node']) {
    invariant((await realpath(recipe.definition[key])).startsWith(root + sep), 'target-outside-signed-closure');
  }
  let endpoint, token, ownerDataDirectory;
  if (recipe.kind === 'codex') {
    invariant(isAbsolute(recipe.registryDirectory), 'invalid-registry-directory');
    await rootOwned(recipe.tokenFile); endpoint = recipe.endpoint; token = (await readFile(recipe.tokenFile, 'utf8')).trim();
    invariant(isAbsolute(endpoint), 'invalid-owner-endpoint');
  } else {
    await rootOwned(recipe.descriptorPath); await rootOwned(recipe.definition.configPath);
    const descriptor = parseStrictJson(await readFile(recipe.descriptorPath));
    endpoint = descriptor.controlUrl; token = descriptor.token; ownerDataDirectory = descriptor.dataDirectory;
  }
  const owner = generationOwner({ kind: recipe.kind, endpoint, token, definition: recipe.definition });
  const executionSha256 = recipe.kind === 'acp' ? await acpExecutionIdentity(parseStrictJson(await readFile(recipe.definition.configPath)), root) : null;
  const profile = parseStrictJson(await readFile(config.profilePath));
  const inventory = await collectInventory(profile), before = await owner.snapshot();
  const candidateUnit = recipe.kind === 'codex' ? `opencraft-codex-${createHash('sha256').update(recipe.registryDirectory).digest('hex').slice(0, 12)}-${recipe.targetId}.service` : null;
  const candidateRoot = recipe.kind === 'codex' ? recipe.definition.runtimeDataDirectory : null;
  const basis = inventory => {
    const result = structuredClone(inventoryIdentity(inventory));
    if (candidateRoot) {
      result.stores = result.stores.filter(store => store.path !== candidateRoot && !store.path.startsWith(candidateRoot + sep));
      result.storeDiscovery.roots = result.storeDiscovery.roots.filter(path => path !== candidateRoot);
    }
    for (const store of result.stores) if (recipe.kind === 'codex' && store.path === join(recipe.registryDirectory, 'codex-generations.sqlite') && store.generations) store.generations.entries = store.generations.entries.filter(g => g.id !== recipe.targetId);
    for (const entry of result.owners) {
      entry.units = entry.units.filter(unit => unit.unit !== candidateUnit);
      for (const unit of entry.units) for (const process of unit.processes) for (const config of process.configs) {
        if (recipe.kind === 'acp' && ownerDataDirectory && config.paths.dataDirectory === ownerDataDirectory && config.acpGenerations) config.acpGenerations.entries = config.acpGenerations.entries.filter(g => g.id !== recipe.targetId);
      }
    }
    result.unmanagedUnits = result.unmanagedUnits.filter(unit => unit !== candidateUnit);
    result.unsupportedComponents = result.unsupportedComponents.filter(component => component.unit !== candidateUnit);
    return fingerprint(result);
  };
  const expectedBasis = basis(inventory);
  const policy = { mode: config.mode, recipeSha256: sha256(await readFile(config.generationRecipePath)),
    executionSha256, privateConfigSha256: recipe.kind === 'acp' ? sha256(await readFile(recipe.definition.configPath)) : null };
  const combination = { ownerId: owner.id, targetId: recipe.targetId, from: fingerprint(before),
    to: fingerprint({ definition: recipe.definition, configurationSha256: policy.privateConfigSha256, executionSha256 }), profile: inventory.profile, platform: inventory.platform, arch: inventory.arch };
  const plan = acceptGenerationPlan({ manifestSha256: sha256(manifestBytes), inventoryFingerprint: inventory.fingerprint,
    policy, matrixBytes, signature, trust: { ...trust, revokedKeyIds: [...(trust.revokedKeyIds ?? []), ...(state.revokedKeyIds ?? [])] }, combination });
  if (input.action === 'generation-inspect') return { plan, scope: 'generation-only', fullStackExecutable: false };
  invariant(input.action === 'generation-apply' && input.planDigest === plan.planDigest, 'plan-drift');
  // Re-read fixed authorities under the host deployment lock. Only this
  // operation's exact candidate delta is excluded from the second comparison.
  const validate = async (_plan, stage) => {
    const live = await readAuthority(config);
    acceptManifest(manifestBytes, manifestSignature, live.trust, live.state);
    acceptGenerationPlan({ manifestSha256: sha256(manifestBytes), inventoryFingerprint: inventory.fingerprint,
      policy, matrixBytes, signature, trust: { ...live.trust, revokedKeyIds: [...(live.trust.revokedKeyIds ?? []), ...(live.state.revokedKeyIds ?? [])] }, combination });
    return sha256(await readFile(config.generationRecipePath)) === policy.recipeSha256
      && (recipe.kind !== 'acp' || sha256(await readFile(recipe.definition.configPath)) === policy.privateConfigSha256)
      && (recipe.kind !== 'acp' || await acpExecutionIdentity(parseStrictJson(await readFile(recipe.definition.configPath)), root) === executionSha256)
      && sha256(await readFile(recipe.matrixPath)) === sha256(matrixBytes)
      && sha256(await readFile(join(config.targetRoot, 'release/full-release.json'))) === plan.manifestSha256
      && sha256(await readFile(join(releaseRoot, 'release/full-release.json'))) === plan.manifestSha256
      && (stage === 'before-prepare' ? fingerprint(inventoryIdentity(await collectInventory(profile))) === plan.inventoryFingerprint
        : basis(await collectInventory(profile)) === expectedBasis);
  };
  return { job: await switchGeneration({ plan, operationId: input.operationId, bootId, journal, lockPath: config.deployLock,
    owner, targetId: recipe.targetId, validate }), scope: 'generation-only', fullStackExecutable: false };
}
