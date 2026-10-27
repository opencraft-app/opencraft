import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectInventory } from './inventory.mjs';
import { readReleasePolicy } from './release-policy.mjs';
import { acceptManifest } from '../full-release/contract.mjs';
import { createPlan } from './plan.mjs';
import { parseStrictJson, HARD_LIMITS } from '../full-release/contract.mjs';
import { fullReleaseTrust } from '../full-release/trust.mjs';

export async function inspect({ profile, targetRoot = null, trust = fullReleaseTrust }) {
  const inventory = await collectInventory(profile);
  if (!targetRoot) return { inventory, plan: null };
  if (!trust) throw new Error('Fixed trusted release keys required');
  const manifestBytes = await readFile(join(targetRoot, 'release/full-release.json'));
  const signature = parseStrictJson(await readFile(join(targetRoot, 'release/full-release.sig')), HARD_LIMITS.metadataBytes);
  const { record } = acceptManifest(manifestBytes, signature, trust);
  let releasePolicy = null;
  try { releasePolicy = await readReleasePolicy(targetRoot, record); } catch { /* missing/invalid remains blocked */ }
  return { inventory, plan: createPlan({ inventory, manifestBytes, signature, trust, releasePolicy }) };
}
