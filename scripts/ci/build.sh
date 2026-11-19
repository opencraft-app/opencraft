#!/usr/bin/env bash
set -Eeuo pipefail
ci_repository_root="$(git rev-parse --show-toplevel)"
cd "$ci_repository_root"
node scripts/ci/source-identity.mjs >/dev/null
mkdir -p .local/ci
ci_receipt="$(mktemp -d .local/ci/build.XXXXXXXX)"
node scripts/ci/source-identity.mjs > "$ci_receipt/source.json"
ci_revision="$(git rev-parse HEAD)"
export OPENCRAFT_SOURCE_REVISION="$ci_revision"
export OPENCRAFT_BUILD_ID="git-${ci_revision}-join-ci"
npm run join:build:web
npm run join:build:gateway
node --input-type=module - "$ci_receipt" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifySnapshot } from './scripts/ci/source-identity.mjs';
const receipt = process.argv[2];
const identity = JSON.parse(readFileSync(resolve(receipt, 'source.json'), 'utf8'));
verifySnapshot(identity);
const version = JSON.parse(readFileSync('apps/workbench-web/dist/version.json', 'utf8'));
assert.equal(version.sourceRevision, identity.sourceRevision, 'Web source identity mismatch');
assert.equal(version.buildId, identity.buildId, 'Web build identity mismatch');
execFileSync(process.execPath, ['--check', 'products/join/dist/runtime/container-gateway.mjs']);
writeFileSync(resolve(receipt, 'build.json'), JSON.stringify({ ...identity,
  web: resolve('apps/workbench-web/dist'), gateway: resolve('products/join/dist/runtime/container-gateway.mjs'),
  validation: 'web-version-and-gateway-syntax', completedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
JS
printf 'Build receipt: %s/build.json\n' "$ci_receipt"
