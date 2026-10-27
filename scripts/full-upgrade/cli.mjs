#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectInventory } from './inventory.mjs';
import { createPlan } from './plan.mjs';
import { parseStrictJson, HARD_LIMITS } from '../full-release/contract.mjs';
import { fullReleaseTrust } from '../full-release/trust.mjs';

export async function inspect({ profile, targetRoot = null, trust = fullReleaseTrust }) {
  const inventory = await collectInventory(profile);
  if (!targetRoot) return { inventory, plan: null };
  if (!trust) throw new Error('Fixed trusted release keys required');
  const manifestBytes = await readFile(join(targetRoot, 'release/full-release.json'));
  const signature = parseStrictJson(await readFile(join(targetRoot, 'release/full-release.sig')), HARD_LIMITS.metadataBytes);
  return { inventory, plan: createPlan({ inventory, manifestBytes, signature, trust }) };
}
export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--profile', '--target'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Expected --profile FILE [--target FIXED_PACKAGE_ROOT]');
    options[args[i]] = args[i + 1];
  }
  const embedded = JSON.parse(process.env.OPENCRAFT_FULL_UPGRADE_PROFILE_JSON || 'null');
  const profile = options['--profile'] ? parseStrictJson(await readFile(resolve(options['--profile'])), HARD_LIMITS.metadataBytes) : embedded;
  const report = await inspect({ profile, targetRoot: options['--target'] ? resolve(options['--target']) : null });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('Upgrade inspection failed; no upgrade was executed\n'); process.exitCode = 1; });
}
