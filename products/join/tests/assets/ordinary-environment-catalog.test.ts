import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxConfigurations } from '../../assets/sandbox-configurations';
import { ManagedNfsLibraries } from '../../assets/libraries';
import { PLATFORM_ASSET_SCOPE } from '../../assets/contract';
import { InstalledOrdinaryEnvironmentCatalog } from '../../assets/ordinary-environment-catalog';

function fixture() {
  const documents = new Map<string, { revision: number; document: unknown }>();
  const vault = {
    readDocument(scope: string, namespace: string) { return structuredClone(documents.get(scope + '/' + namespace) ?? { revision: 0, document: null }); },
    writeDocument(scope: string, namespace: string, revision: number, document: unknown) {
      assert.equal(vault.readDocument(scope, namespace).revision, revision);
      documents.set(scope + '/' + namespace, { revision: revision + 1, document: structuredClone(document) });
    },
  };
  const configurations = new SandboxConfigurations(vault);
  configurations.adoptInstallation({ apiUrl: 'https://api.example.test', sandboxUrl: 'https://sandbox.example.test',
    capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 },
    lease: { timeoutMs: 300000, renewEveryMs: 60000, maxLifetimeMs: 3600000 }, persistentWorkspaces: true,
    templates: ['base', 'devtools'].map(id => ({ id, name: id, workspaceRoot: '/workspace', resources: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 } })),
  }, 'synthetic-e2b-key');
  const records = configurations.installedRuntime()!.records;
  const libraries = new ManagedNfsLibraries(vault);
  libraries.register({ id: 'shared', name: 'Team files', kind: 'nfs', managedBy: 'e2b', mountPath: '/shared',
    credentialId: records[0]!.credential.id, credentialGeneration: records[0]!.credential.generation, volumeId: 'test-shared-volume',
    environmentIds: records.map(r => r.environment.id), templateIds: records.map(r => r.environment.templateId), verifiedAt: '2026-11-18T00:00:00Z' }, 0);
  let active = true;
  const context = { scope: 'tencentoa:alice', current: () => active };
  const catalog = new InstalledOrdinaryEnvironmentCatalog(configurations);
  const target = { version: 1, configurationId: records[0]!.environment.id, templateId: records[0]!.environment.templateId };
  const source = { version: 1, kind: 'library-reference', libraryId: 'shared', relativePath: 'docs/design' };
  return { catalog, context, target, source, configurations, vault, libraries, revoke() { active = false; },
    edit(namespace: string, fn: (value: any) => void) {
      const { revision, document } = vault.readDocument(PLATFORM_ASSET_SCOPE, namespace); fn(document);
      vault.writeDocument(PLATFORM_ASSET_SCOPE, namespace, revision, document);
    },
  };
}

test('installed two-template catalog is secret-free and exposes compatible shared library separately', () => {
  const f = fixture(), snapshot = f.catalog.snapshot(f.context);
  assert.deepEqual(snapshot.environments.map(e => e.target.templateId), ['base', 'devtools']);
  assert.equal(snapshot.libraries.length, 1); assert.equal(snapshot.libraries[0]!.environmentIds.length, 2);
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ['synthetic-e2b-key', 'api.example.test', 'test-shared-volume', 'credentialId', 'credentialGeneration'])
    assert.equal(serialized.includes(privateValue), false);
  for (const choice of snapshot.environments) assert.equal(f.catalog.resolveEnvironment(f.context, choice.target).templateId, choice.target.templateId);
});

test('environment admission pins execution settings, not mutable display names or unrelated templates', async () => {
  const f = fixture(), selected = f.catalog.resolveEnvironment(f.context, f.target), runtime = f.catalog.runtime(f.context, selected);
  f.edit('document-sandbox-configurations', d => { d.environments[0].name = 'Renamed'; d.environments[1].name = 'Other label'; });
  assert.deepEqual(f.catalog.resolveEnvironment(f.context, f.target), selected);
  assert.equal(await runtime.readApiKey(), 'synthetic-e2b-key');
  f.edit('document-sandbox-configurations', d => { d.installation.templates[0].resources.cpuMillis = 4000; });
  await assert.rejects(runtime.authorize(), /unavailable/);
  await assert.rejects(runtime.readApiKey(), /unavailable/);
  assert.throws(() => f.catalog.runtime(f.context, selected), /unavailable/);
});

test('credential rotation and endpoint replacement cannot silently revive an old binding', async () => {
  for (const change of ['key', 'endpoint']) {
    const f = fixture(), selected = f.catalog.resolveEnvironment(f.context, f.target), runtime = f.catalog.runtime(f.context, selected);
    f.edit('document-sandbox-configurations', d => {
      if (change === 'key') { d.credentials[0].generation = 'rotated-generation'; d.credentials[0].apiKey = 'new-synthetic-key'; }
      else d.credentials[0].apiUrl = 'https://other.example.test';
    });
    await assert.rejects(runtime.readApiKey(), /unavailable/);
    assert.notEqual(f.catalog.resolveEnvironment(f.context, f.target).configurationRevision, selected.configurationRevision);
  }
});

test('library binding pins volume and principal, and is not a mutable-files snapshot', () => {
  const f = fixture(), environment = f.catalog.resolveEnvironment(f.context, f.target);
  const source = f.catalog.resolveLibrary(f.context, environment, f.source);
  assert.deepEqual(f.catalog.libraryBinding(f.context, environment, source), { mountPath: '/shared', volumeId: 'test-shared-volume', relativePath: 'docs/design' });
  assert.throws(() => f.catalog.libraryBinding({ scope: 'tencentoa:bob', current: () => true }, environment, source), /unavailable/);
  f.edit('document-managed-nfs-libraries', d => { d.libraries[0].name = 'Renamed'; d.libraries[0].verifiedAt = '2026-11-19T00:00:00Z'; });
  assert.deepEqual(f.catalog.resolveLibrary(f.context, environment, f.source), source);
  f.edit('document-managed-nfs-libraries', d => { d.libraries[0].volumeId = 'replacement-volume'; });
  assert.throws(() => f.catalog.libraryBinding(f.context, environment, source), /unavailable/);
});

test('mismatched template/library association and caller-selected paths or endpoints are rejected', () => {
  const f = fixture(), environment = f.catalog.resolveEnvironment(f.context, f.target);
  assert.throws(() => f.catalog.resolveEnvironment(f.context, { ...f.target, templateId: 'devtools' }), /unavailable/);
  assert.throws(() => f.catalog.resolveEnvironment(f.context, { ...f.target, apiUrl: 'https://evil.test' }), /unavailable/);
  for (const relativePath of ['/shared', '../private', 'a/../b', '%2e%2e', 'a\\b'])
    assert.throws(() => f.catalog.resolveLibrary(f.context, environment, { ...f.source, relativePath }), /unavailable/);
  f.edit('document-managed-nfs-libraries', d => { d.libraries[0].templateIds.reverse(); });
  assert.throws(() => f.catalog.resolveLibrary(f.context, environment, f.source), /unavailable/);
});

test('revoked identity, nonpersistent installation and arbitrary saved environments do not grant execution', async () => {
  const f = fixture(), environment = f.catalog.resolveEnvironment(f.context, f.target), runtime = f.catalog.runtime(f.context, environment);
  f.revoke(); assert.throws(() => f.catalog.snapshot(f.context), /unavailable/);
  await assert.rejects(runtime.readApiKey(), /unavailable/);
  const fresh = fixture(); fresh.edit('document-sandbox-configurations', d => { d.installation.persistentWorkspaces = false; });
  assert.throws(() => fresh.catalog.resolveEnvironment(fresh.context, fresh.target), /unavailable/);
  const saved = fixture(); saved.edit('document-sandbox-configurations', d => {
    d.environments.push({ id: 'saved-only', name: 'Not installed', credentialId: d.credentials[0].id, templateId: 'uninstalled' });
  });
  assert.equal(saved.catalog.snapshot(saved.context).environments.length, 2);
  assert.throws(() => saved.catalog.resolveEnvironment(saved.context, { version: 1, configurationId: 'saved-only', templateId: 'uninstalled' }), /unavailable/);
});


test('a provider credential reader stays bound to the original authenticated account scope', async () => {
  const f = fixture(), environment = f.catalog.resolveEnvironment(f.context, f.target), runtime = f.catalog.runtime(f.context, environment);
  f.context.scope = 'tencentoa:bob';
  await assert.rejects(runtime.readApiKey(), /unavailable/);
  await assert.rejects(runtime.authorize(), /unavailable/);
});
