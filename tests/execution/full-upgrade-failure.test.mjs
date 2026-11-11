import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureSummary, structuredFailure } from '../../scripts/full-upgrade/failure.mjs';
import { command } from '../../scripts/full-upgrade/durable.mjs';
import { runParent } from '../../scripts/full-upgrade/parent.mjs';

test('diagnostics preserve fixed failure codes while excluding raw stderr and error text', () => {
  const raw = 'Bearer private-token, /private/credentials and upstream body';
  assert.deepEqual(failureSummary(new Error(raw)), { stage: 'parent-prepare', code: 'operation-failed' });
  assert.equal(structuredFailure(raw), undefined);
  assert.equal(structuredFailure(JSON.stringify({ opencraftFailure: { stage: raw, code: raw } })), undefined);
  assert.deepEqual(structuredFailure(raw + '\n' + JSON.stringify({ opencraftFailure: {
    stage: 'sandbox-policy', code: 'operator-sandbox-policy-changed', secret: raw, ownerId: raw } })),
  { stage: 'sandbox-policy', code: 'operator-sandbox-policy-changed' });
});

test('a failing subprocess exposes the structured stage instead of losing it as command-failed', async () => {
  const script = "process.stderr.write('private raw token\\n'); process.stderr.write(JSON.stringify({opencraftFailure:{stage:'sandbox-policy',code:'operator-sandbox-policy-changed'}})+'\\n');process.exitCode=1";
  await assert.rejects(command(process.execPath, ['-e', script]), error => {
    assert.equal(error.message, 'command-failed');
    assert.deepEqual(error.failure, { stage: 'sandbox-policy', code: 'operator-sandbox-policy-changed' });
    assert.ok(!JSON.stringify(error).includes('private raw token')); return true;
  });
});

test('failure before a parent journal exists leaves a bounded diagnostic without starting owners', async t => {
  const root = await mkdtemp(join(tmpdir(), 'parent-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(runParent({ stateRoot: root }, { operationId: 'failed-preflight' }, {
    recipe: async () => { throw new Error('parent-controller-drift'); },
    call: async () => { calls++; },
  }), /parent-controller-drift/);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'parents/failed-preflight/failure.json'), 'utf8')),
    { stage: 'parent-prepare', code: 'parent-controller-drift' });
});
