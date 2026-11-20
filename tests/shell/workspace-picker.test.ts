import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { asHostId } from '@opencraft/chat-core';
import { createConversationScopeRegistry, type AppServerWorkbenchRuntime } from '@opencraft/workbench-runtime';
import { workspaceCatalogOptions } from '../../apps/workbench-web/src/runtime/workspace-catalog-query';
import { selectPlacementEnvironment, selectPlacementSource, placementProblem } from '../../apps/workbench-web/src/runtime/workspace-placement-model';
const target = { version: 1, configurationId: 'e2b', templateId: 'general' } as const;
const other = { ...target, configurationId: 'other' };
const catalog = { version: 1 as const, environments: [target, other].map(target => ({ target, name: target.configurationId, status: 'configured' as const, resources: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } })),
  libraries: [{ id: 'shared', name: 'Shared', status: 'configured' as const, environmentIds: ['e2b'] }] };
const initial = { hostId: asHostId('host'), workspace: { cwd: null, runtimeWorkspaceRoots: [] } };
test('environment and library selection retain scope; incompatible selection cannot discard source', () => {
  const scopes = createConversationScopeRegistry({ initialDraft: null });
  try {
    const draft = scopes.openDraft({ execution: initial });
    const placed = selectPlacementEnvironment(initial, target, catalog);
    const sourced = selectPlacementSource(placed, { version: 1, kind: 'library-reference', libraryId: 'shared', relativePath: '' }, catalog);
    const next = scopes.retargetDraft(draft.id, sourced);
    assert.equal(next.id, draft.id); assert.equal(next.scopeId, draft.scopeId);
    assert.equal(next.target.execution.workspace.cwd, null);
    assert.deepEqual(next.target.execution.workspace.runtimeWorkspaceRoots, []);
    assert.throws(() => selectPlacementEnvironment(sourced, other, catalog), /empty workspace/);
    assert.throws(() => selectPlacementEnvironment(sourced, undefined, catalog), /empty workspace/);
    assert.equal(scopes.getDraft(draft.id)?.target.execution.workspace.source?.kind, 'library-reference');
    const emptied = selectPlacementSource(sourced, undefined, catalog);
    assert.equal(selectPlacementEnvironment(emptied, other, catalog).environment?.configurationId, 'other');
    assert.match(placementProblem(sourced, { ...catalog, libraries: [] })!, /unavailable/);
    assert.throws(() => selectPlacementEnvironment({ ...initial, workspace: { cwd: '/home/work', runtimeWorkspaceRoots: ['/home/work'] } }, target, catalog), /empty workspace/);
  } finally { scopes.dispose(); }
});
function fixture() {
  let generation = 1, phase = 'ready', supported = true;
  let resolve!: (value: typeof catalog) => void;
  let signal: AbortSignal | undefined;
  const runtime = { getSnapshot: () => ({ hostId: 'host', connectionGeneration: generation, phase }), resources: {
    host: { getInitializeResult: () => ({ capabilities: { extensions: supported ? { 'opencraft/workspace-placement': { version: 1 } } : {} } }) },
    workspaceCatalog: { read: (s?: AbortSignal) => { signal = s; return new Promise<typeof catalog>(done => { resolve = done; }); } },
  } } as unknown as AppServerWorkbenchRuntime;
  return { runtime, finish: () => resolve(catalog), signal: () => signal,
    disconnect: () => { phase = 'reconnecting'; }, replace: () => { generation++; }, revoke: () => { supported = false; } };
}
for (const transition of ['disconnect', 'replace', 'revoke'] as const) test(`late catalog rejected after ${transition}`, async () => {
  const f = fixture(), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = workspaceCatalogOptions(f.runtime), result = client.fetchQuery(options);
    f[transition](); f.finish();
    await assert.rejects(result, /connection changed/);
    assert.equal(client.getQueryData(options.queryKey), undefined);
  } finally { client.clear(); }
});
test('Host switch cancellation aborts old request and cannot publish late data', async () => {
  const f = fixture(), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const options = workspaceCatalogOptions(f.runtime), result = client.fetchQuery(options);
    const rejection = assert.rejects(result);
    await client.cancelQueries({ queryKey: options.queryKey });
    assert.equal(f.signal()?.aborted, true); f.finish(); await rejection;
    assert.equal(client.getQueryData(options.queryKey), undefined);
    const oldKey = options.queryKey; f.replace();
    assert.notDeepEqual(workspaceCatalogOptions(f.runtime).queryKey, oldKey);
  } finally { client.clear(); }
});

test('replacement runtime cannot reuse a fresh catalog from the previous runtime', () => {
  const first = fixture(), second = fixture();
  assert.notDeepEqual(workspaceCatalogOptions(first.runtime).queryKey, workspaceCatalogOptions(second.runtime).queryKey);
  assert.deepEqual(workspaceCatalogOptions(first.runtime).queryKey, workspaceCatalogOptions(first.runtime).queryKey);
});
test('empty library bindings are unavailable, not a wildcard', () => {
  const placed = selectPlacementEnvironment(initial, target, catalog);
  assert.throws(() => selectPlacementSource(placed, {version:1,kind:'library-reference',libraryId:'shared',relativePath:''},
    {...catalog,libraries:[{...catalog.libraries[0],environmentIds:[]}]}), /unavailable/);
});
