#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Android installs an update only when its versionCode is not lower than the
// installed one, so every published APK derives it from its release tag:
// X*1_000_000 + Y*10_000 + Z*100 + slot, where beta N takes slot N (1-98) and
// the stable release takes 99 so it always supersedes its own betas.
const tagPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?$/u;
const maximumVersionCode = 2_100_000_000;

export function androidVersionCode(tag) {
  const match = tagPattern.exec(tag ?? '');
  if (!match) throw new Error(`Android releases need a vX.Y.Z or vX.Y.Z-beta.N tag: ${tag}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? undefined : Number(match[4]);
  if (minor > 99 || patch > 99) throw new Error(`Android versionCode supports minor and patch up to 99: ${tag}`);
  if (beta !== undefined && beta > 98) throw new Error(`Android versionCode supports beta numbers up to 98: ${tag}`);
  const code = major * 1_000_000 + minor * 10_000 + patch * 100 + (beta ?? 99);
  if (code > maximumVersionCode) throw new Error(`Android versionCode exceeds ${maximumVersionCode}: ${tag}`);
  return code;
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${androidVersionCode(process.argv[2])}\n`);
}
