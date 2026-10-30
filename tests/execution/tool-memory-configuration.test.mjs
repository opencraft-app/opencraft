import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderToolMemoryGuard, validateToolMemoryPolicy } from '../../scripts/server-deployment/prepare-tool-memory-guard.mjs';
const policy = JSON.parse(await readFile(new URL('../../config/tool-memory-guard.json', import.meta.url), 'utf8'));

test('configured large tools may oversell a small owner without budget rejection', () => {
  assert.equal(policy.toolMemoryHighMiB, 12 * 1024);
  assert.equal(policy.toolMemoryMaxMiB, 16 * 1024);
  const plan = renderToolMemoryGuard({ unit: 'opencraft-codex-test.service', highMiB: 4096, maxMiB: 8192, payload: Buffer.from('synthetic'), policy });
  assert.match(plan.files.at(-1).content, /MemoryMax=8192M/u);
  assert.match(plan.files.at(-1).content, /DelegateSubgroup=app/u);
  assert.match(plan.files.at(-1).content, /OOMScoreAdjust=-1000/u);
  assert.equal(JSON.parse(plan.files[1].content).toolMemoryMaxMiB, 16384);
  assert.match(plan.files[2].content, /Restart=always/u);
  assert.ok(plan.files[0].target.endsWith(`guard-${plan.payloadSha256}.py`));
});

test('invalid policy, unit/path injection and impossible High/Max are rejected before staging', () => {
  assert.throws(() => validateToolMemoryPolicy({ ...policy, toolMemoryHighMiB: 20000 }));
  assert.throws(() => validateToolMemoryPolicy({ ...policy, nativeExecutableNames: ['../codex'] }));
  assert.throws(() => renderToolMemoryGuard({ unit: '../other.service', highMiB: 1, maxMiB: 2, payload: Buffer.from('x'), policy }));
  assert.throws(() => renderToolMemoryGuard({ unit: 'new.service', highMiB: 1, maxMiB: 2, payload: Buffer.from('x'), policy, stateDirectory: '/tmp/\nUser=other' }));
});
