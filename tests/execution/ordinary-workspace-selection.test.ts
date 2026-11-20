import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { OrdinaryWorkspaceStore } from '../../apps/local-agent-host/src/ordinary-workspace-store';
import { encodeWorkspaceSelection, type ResolvedWorkspaceSelection } from '../../apps/local-agent-host/src/ordinary-workspace-selection';
const scope = { principalId: 'alice', hostId: 'host' };
const selection: ResolvedWorkspaceSelection = { version: 1, environment: {
  configurationId: 'e2b', configurationRevision: 'a'.repeat(64), templateId: 'devtools', cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 },
  source: { kind: 'git', repositoryId: 'repo', commit: 'b'.repeat(40), libraryId: 'shared', authorizationDomain: 'team', generation: 'immutable-1', relativePath: 'src' } };
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'selection-')), store = new OrdinaryWorkspaceStore(root, 'deployment');
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}
test('canonical snapshot is independent of property order and detached from caller mutations', t => {
  const { store } = fixture(t), input = structuredClone(selection);
  const row = store.admitResolved(scope, 'intent', input);
  assert.deepEqual(store.admitResolved(scope, 'intent', { source: input.source, environment: input.environment, version: 1 }), row);
  input.environment.templateId = 'other';
  const saved = store.resolvedSelection(scope, row.workspaceId);
  assert.deepEqual(saved, selection); saved.environment.templateId = 'mutated';
  assert.deepEqual(store.resolvedSelection(scope, row.workspaceId), selection);
  assert.throws(() => store.admitResolved(scope, 'intent', input), /conflict/);
  assert.throws(() => store.resolvedSelection({ ...scope, principalId: 'bob' }, row.workspaceId), /not found/);
});
test('rejects credentials, URLs, mutable Git refs, arbitrary paths and unknown fields', () => {
  for (const mutate of [
    (v: any) => v.environment.apiKey = 'DO_NOT_PERSIST',
    (v: any) => v.environment.apiUrl = 'https://example.test',
    (v: any) => v.source.commit = 'main',
    (v: any) => v.source.relativePath = '../escape',
    (v: any) => v.source.relativePath = '/shared/raw',
    (v: any) => v.source.relativePath = '%2e%2e',
    (v: any) => v.source.generation = '../../escape',
    (v: any) => v.source.origin = 'https://token@example.test/repo',
    (v: any) => v.environment.memoryBytes = Infinity,
  ]) { const input = structuredClone(selection); mutate(input); assert.throws(() => encodeWorkspaceSelection(input), /Invalid resolved/); }
  for (const source of [{ kind: 'empty' }, { kind: 'library-reference', libraryId: 'shared', authorizationDomain: 'team', generation: 'v1', relativePath: '' }])
    assert.deepEqual(encodeWorkspaceSelection({ ...selection, source }).value.source, source);
});
test('snapshot insertion failure rolls back the identity admission too', t => {
  const { root, store } = fixture(t), db = new DatabaseSync(join(root, 'ordinary-workspaces.sqlite'));
  try {
    db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON ordinary_workspace_selections BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => store.admitResolved(scope, 'intent', selection), /test failure/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM ordinary_workspaces').get() as any).n, 0);
  } finally { db.close(); }
});
test('persisted selection corruption fails rather than selecting another template', t => {
  const { root, store } = fixture(t), row = store.admitResolved(scope, 'intent', selection);
  const changed = structuredClone(selection); changed.environment.templateId = 'other';
  const db = new DatabaseSync(join(root, 'ordinary-workspaces.sqlite'));
  try { db.prepare('UPDATE ordinary_workspace_selections SET selection_json=?').run(JSON.stringify(changed)); }
  finally { db.close(); }
  assert.throws(() => store.resolvedSelection(scope, row.workspaceId), /integrity/);
});
test('new process reconstructs exact template and immutable Git generation', t => {
  const { root, store } = fixture(t), row = store.admitResolved(scope, 'intent', selection);
  const module = new URL('../../apps/local-agent-host/src/ordinary-workspace-store.ts', import.meta.url).href;
  const code = `import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)}; const s=new OrdinaryWorkspaceStore(${JSON.stringify(root)},'deployment'); console.log(JSON.stringify(s.resolvedSelection(${JSON.stringify(scope)},${JSON.stringify(row.workspaceId)}))); s.close();`;
  const out = execFileSync(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.deepEqual(JSON.parse(out), selection);
});
test('schema1 upgrade preserves legacy identity and does not invent missing selection', t => {
  const { root, store } = fixture(t), row = store.admit(scope, 'legacy', 'c'.repeat(64));
  const db = new DatabaseSync(join(root, 'ordinary-workspaces.sqlite'));
  try { db.exec("DROP TABLE ordinary_workspace_selections; UPDATE workspace_journal_meta SET value='1' WHERE key='schema'"); }
  finally { db.close(); }
  const reopened = new OrdinaryWorkspaceStore(root, 'deployment');
  try {
    assert.deepEqual(reopened.read(scope, row.workspaceId), row);
    assert.throws(() => reopened.resolvedSelection(scope, row.workspaceId), /unavailable/);
    const next = reopened.admitResolved(scope, 'new', selection);
    assert.deepEqual(reopened.resolvedSelection(scope, next.workspaceId), selection);
  } finally { reopened.close(); }
});
