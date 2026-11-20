import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { asHostId } from '@opencraft/chat-core';
import { createConversationScopeRegistry, type AppServerWorkbenchRuntime } from '@opencraft/workbench-runtime';
import { workspaceCatalogOptions } from '../../apps/workbench-web/src/runtime/workspace-catalog-query';
import { buildWorkspaceChoices, selectWorkspaceChoice, temporaryWorkspaceChoice, workspaceChoiceSelected, placementProblem } from '../../apps/workbench-web/src/runtime/workspace-placement-model';
const target = { version: 1, configurationId: 'e2b', templateId: 'general' } as const;
const other = { ...target, configurationId: 'other' };
const catalog = { version: 1 as const, environments: [target, other].map(target => ({ target, name: target.configurationId, status: 'configured' as const, resources: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } })),
  libraries: [{ id: 'shared', name: 'Shared', status: 'configured' as const, environmentIds: ['e2b'] }] };
const initial = { hostId: asHostId('host'), workspace: { cwd: null, runtimeWorkspaceRoots: [] } };
test('complete workspace choice retains the Draft and scope identities', () => {
  const scopes = createConversationScopeRegistry({ initialDraft: null });
  try {
    const draft = scopes.openDraft({ execution: initial });
    const choice = buildWorkspaceChoices([], catalog)[0];
    const next = scopes.retargetDraft(draft.id, selectWorkspaceChoice(initial, choice, catalog));
    assert.equal(next.id, draft.id); assert.equal(next.scopeId, draft.scopeId);
    assert.equal(next.target.execution.workspace.source?.libraryId, 'shared');
    assert.match(placementProblem(next.target.execution, { ...catalog, libraries: [] })!, /unavailable/);
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
  assert.deepEqual(buildWorkspaceChoices([], { ...catalog, libraries: [{ ...catalog.libraries[0], environmentIds: [] }] }), []);
});

test('complete workspace selection atomically replaces environment, source and optional project', () => {
  const choices = buildWorkspaceChoices([{ cwd: '/home/work', runtimeWorkspaceRoots: ['/home/work'], label: 'Work', rootLabel: 'work', projectId: 'project' }], catalog);
  const host = selectWorkspaceChoice(initial, choices[0], catalog);
  const library = selectWorkspaceChoice(host, choices[1], catalog);
  assert.equal(library.environment?.configurationId, 'e2b');
  assert.deepEqual(library.workspace, { cwd: null, runtimeWorkspaceRoots: [], source: { version: 1, kind: 'library-reference', libraryId: 'shared', relativePath: '' } });
  assert.deepEqual(selectWorkspaceChoice(library, choices[0], catalog), host);
  const temporary = selectWorkspaceChoice(library, temporaryWorkspaceChoice(other), catalog);
  assert.equal(temporary.environment?.configurationId, 'other');
  assert.deepEqual(temporary.workspace, { cwd: null, runtimeWorkspaceRoots: [] });
  assert.deepEqual(selectWorkspaceChoice(temporary, temporaryWorkspaceChoice(), catalog), initial);
  assert.equal(workspaceChoiceSelected(choices[1], library), true);
  assert.equal(workspaceChoiceSelected(choices[1], temporary), false);
});

test('environment is part of workspace identity; stale catalogs cannot redirect selection', () => {
  const bound = { ...catalog, libraries: [{ ...catalog.libraries[0], environmentIds: ['e2b', 'other'] }] };
  const choices = buildWorkspaceChoices([], bound);
  assert.equal(choices.length, 2);
  assert.notEqual(choices[0].id, choices[1].id);
  const selected = selectWorkspaceChoice(initial, choices[1], bound);
  assert.equal(workspaceChoiceSelected(choices[0], selected), false);
  assert.throws(() => selectWorkspaceChoice(initial, choices[1], catalog), /unavailable/);
  assert.throws(() => selectWorkspaceChoice(initial, choices[0], undefined), /unavailable/);
  assert.throws(() => selectWorkspaceChoice(initial, temporaryWorkspaceChoice(other), { ...catalog, environments: [] }), /unavailable/);
  const directory = buildWorkspaceChoices([{ cwd: '/folder', runtimeWorkspaceRoots: ['/folder'], label: 'Folder', rootLabel: 'folder' }])[0];
  assert.equal(directory.workspace.projectId, undefined);
  assert.equal(selectWorkspaceChoice(selected, directory).environment, undefined);
});

test('one host directory has one identity even if associated with more than one project', () => {
  const directory = { cwd: '/folder', runtimeWorkspaceRoots: ['/folder'], label: 'Folder', rootLabel: 'folder' };
  const choices = buildWorkspaceChoices([{ ...directory, projectId: 'one' }, { ...directory, projectId: 'two' }]);
  assert.equal(choices.length, 1);
});
