import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAssetConfigurations, type AssetAdmission } from "@opencraft/plugin-assets/server";
import { createAssetsStorage } from "@opencraft/plugin-assets/server/storage";
import { InstalledWorkspaceCatalog } from "@opencraft/plugin-assets/server/workspace-catalog";
import { ManagedNfsLibraries } from "@opencraft/plugin-assets/server/libraries";
import { createHash } from "node:crypto";
const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const key = "synthetic-workspace-bootstrap-key";
function access(admin = false): AssetAdmission {
  const permit = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(permit, 0, 1);
  return {
    scope: "actor:human://fixture/workspace-owner",
    permit,
    allowCustomEndpoints: admin,
    canManagePlatform: admin,
    expiresAt: Date.now() + 60000,
  };
}
async function delivery(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "assets-workspace-delivery-")),
    keyPath = join(root, "key"),
    configPath = join(root, "installation.json");
  await writeFile(keyPath, key, { mode: 0o600 });
  const config = {
    schemaVersion: 1,
    backend: "e2b",
    apiUrl: "https://api.e2b.dev",
    sandboxUrl: "https://e2b.dev",
    apiKeyFile: keyPath,
    capacity: resources,
    persistentWorkspaces: true,
    lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
    templates: [{ id: "synthetic-template", name: "Synthetic workspace", workspaceRoot: "/workspace", resources }],
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, configPath, keyPath, config, directory: join(root, "data") };
}

test("the sole Worker adopts private delivery and resolves a secret-free version-pinned workspace catalog", async (t) => {
  const f = await delivery(t),
    owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
  try {
    const admitted = access(),
      catalog = await owner.store.workspaceCatalog(admitted);
    assert.equal(catalog.version, 1);
    assert.equal(catalog.environments.length, 1);
    const environment = catalog.environments[0]!;
    assert.equal(environment.name, "Synthetic workspace");
    assert.deepEqual(environment.resources, resources);
    const resolved = await owner.store.workspaceResolveEnvironment(admitted, environment.target);
    assert.equal(resolved.configurationId, environment.target.configurationId);
    assert.equal(resolved.templateId, "synthetic-template");
    assert.match(resolved.configurationRevision, /^[a-f0-9]{64}$/u);
    assert.equal(await owner.store.workspaceValidateEnvironment(admitted, resolved), true);
    assert.doesNotMatch(
      JSON.stringify({ catalog, resolved }),
      /synthetic-workspace-bootstrap-key|api\.e2b\.dev|apiKey|apiKeyFile|\/workspace/,
    );
    const snapshot = await owner.store.snapshot(admitted);
    assert.equal(snapshot.environments.length, 1);
    assert.equal(snapshot.environments[0]!.source, "platform");
    // This private bootstrap did not provision a provider environment. Budget
    // admission is now usable through the same existing encrypted vault owner.
    const receipt = await owner.store.workspaceBudgetReserve(
      "ordinary",
      { id: "synthetic", owner: "synthetic-owner", backend: "e2b" },
      resources,
    );
    await owner.store.workspaceBudgetSettle(receipt, "not-created");
  } finally {
    await owner.close();
  }
});

test("credential replacement and revocation invalidate an exact catalog selection rather than selecting latest", async (t) => {
  const f = await delivery(t),
    owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
  try {
    const admitted = access(),
      admin = access(true),
      target = (await owner.store.workspaceCatalog(admitted)).environments[0]!.target;
    const original = await owner.store.workspaceResolveEnvironment(admitted, target);
    const snapshot = await owner.store.snapshot(admin),
      credential = snapshot.credentials.find((c) => c.source === "platform")!;
    assert.ok(credential);
    await owner.store.update(admin, {
      action: "save-credential",
      source: "platform",
      revision: snapshot.platformRevision,
      id: credential.id,
      name: credential.name,
      apiUrl: credential.apiUrl,
      sandboxUrl: credential.sandboxUrl,
      apiKey: "synthetic-rotated-key",
    });
    await assert.rejects(owner.store.workspaceValidateEnvironment(admitted, original));
    const replacement = await owner.store.workspaceResolveEnvironment(admitted, target);
    assert.notEqual(replacement.configurationRevision, original.configurationRevision);
    await assert.rejects(
      owner.store.workspaceResolveEnvironment(admitted, { ...target, templateId: "forged-template" }),
    );
    await assert.rejects(
      owner.store.workspaceValidateEnvironment(admitted, { ...replacement, memoryBytes: resources.memoryBytes * 2 }),
    );
    Atomics.store(admitted.permit, 0, 0);
    await assert.rejects(owner.store.workspaceCatalog(admitted));
    await assert.rejects(owner.store.workspaceValidateEnvironment(admitted, replacement));
    await assert.rejects(owner.store.update(admin, { action: "adoptWorkspaceInstallation", path: f.configPath }));
  } finally {
    await owner.close();
  }
});

test("adopted documents survive absent source files and never resurrect a deleted environment", async (t) => {
  const f = await delivery(t);
  let owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
  try {
    const admin = access(true),
      snapshot = await owner.store.snapshot(admin),
      environment = snapshot.environments[0]!;
    await owner.store.update(admin, {
      action: "delete-environment",
      source: "platform",
      revision: snapshot.platformRevision,
      id: environment.id,
    });
    await owner.close();
    await rm(f.keyPath);
    await rm(f.configPath);
    owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
    assert.equal((await owner.store.workspaceCatalog(access())).environments.length, 0);
    assert.equal(await owner.store.adoptWorkspaceInstallation(f.configPath), false);
  } finally {
    await owner.close();
  }
});

test(
  "invalid private delivery closes its owner, does not expose input, and leaves no partial installation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await delivery(t);
    await chmod(f.keyPath, 0o644);
    await assert.rejects(openAssetConfigurations(f.directory, { installationFile: f.configPath }), (error) => {
      assert.doesNotMatch(String(error), /synthetic-workspace-bootstrap-key|installation\.json/);
      return true;
    });
    await chmod(f.keyPath, 0o600);
    const linked = join(f.root, "linked.json");
    await symlink(f.configPath, linked);
    await assert.rejects(openAssetConfigurations(f.directory, { installationFile: linked }));
    const owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
    try {
      assert.equal((await owner.store.workspaceCatalog(access())).environments.length, 1);
    } finally {
      await owner.close();
    }
  },
);

test("requesting native workspace execution from a configuration-only owner fails closed", async (t) => {
  const f = await delivery(t);
  await assert.rejects(openAssetConfigurations(f.directory, { workspaceMachineId: "synthetic-not-a-native-owner" }));
  // Failed composition released its sole writer; ordinary Assets still opens.
  const owner = await openAssetConfigurations(f.directory);
  try {
    assert.equal(owner.workspaceExecution, false);
  } finally {
    await owner.close();
  }
});

test("legacy installation IDs outside the logical workspace contract remain editable but are never offered for Native execution", async (t) => {
  const f = await delivery(t);
  const config = { ...f.config, templates: [{ ...f.config.templates[0]!, id: "_legacy-template" }] };
  await writeFile(f.configPath, JSON.stringify(config), { mode: 0o600 });
  const owner = await openAssetConfigurations(f.directory, { installationFile: f.configPath });
  try {
    assert.equal((await owner.store.snapshot(access())).environments.length, 1);
    assert.deepEqual((await owner.store.workspaceCatalog(access())).environments, []);
    await assert.rejects(
      owner.store.workspaceResolveEnvironment(access(), {
        version: 1,
        configurationId: "legacy",
        templateId: "_legacy-template",
      }),
    );
  } finally {
    await owner.close();
  }
});

test("a compiled Human identity adapter preserves a legacy library domain without weakening the default catalog or platform boundary", async (t) => {
  const f = await delivery(t);
  let adapter: InstalledWorkspaceCatalog | undefined,
    expectedDomain="",
    active = true;
  const scope = "legacy-human:original-user";
  const owner = await createAssetsStorage(f.directory, [], undefined, (context) => {
    context.configurations.adoptInstallation(f.config, key);
    const record = context.configurations.installedRuntime()!.records[0]!;
    expectedDomain="scope-"+createHash("sha256").update(JSON.stringify([scope,"shared",record.credential.id,record.credential.generation])).digest("hex");
    new ManagedNfsLibraries(context.vault).register(
      {
        id: "shared",
        name: "Shared",
        kind: "nfs",
        managedBy: "e2b",
        mountPath: "/shared",
        credentialId: record.credential.id,
        credentialGeneration: record.credential.generation,
        volumeId: "fixture-volume",
        environmentIds: [record.environment.id],
        templateIds: [record.environment.templateId],
        verifiedAt: "2026-11-22T00:00:00Z",
      },
      0,
    );
    adapter = new InstalledWorkspaceCatalog(context.configurations, {
      isHumanScope: (value) => value === scope || value.startsWith("platform:"),
    });
    assert.throws(() => context.catalog.snapshot({ scope, current: () => true }));
    return { methods: {}, async close() {} };
  });
  try {
    assert.ok(adapter);
    const context = { scope, current: () => active },
      target = adapter.snapshot(context).environments[0]!.target;
    const environment = adapter.resolveEnvironment(context, target),
      source = adapter.resolveLibrary(context, environment, {
        version: 1,
        kind: "library-reference",
        libraryId: "shared",
        relativePath: "docs",
      });
    assert.equal(source.authorizationDomain,expectedDomain);
    assert.throws(() => adapter!.snapshot({ scope: "platform:assistant-environments", current: () => true }));
    assert.throws(() => adapter!.snapshot({ scope: "legacy-human:someone-else", current: () => true }));
    const raw = { ...access(), scope };
    await assert.rejects(owner.methods.workspaceCatalog(raw));
    const runtime = adapter.runtime(context, environment);
    assert.equal(await runtime.readSecret(), key);
    const secret = owner.methods.snapshot({ ...access(true), scope });
    assert.ok(!JSON.stringify(await secret).includes(key));
    // The domain retains the exact selected legacy scope; it is not rebound to
    // a new Actor partition merely because a compiled adapter was installed.
    assert.equal(adapter.resolveLibrary(context,environment,{version:1,kind:"library-reference",libraryId:"shared",relativePath:"other"}).authorizationDomain,expectedDomain);
    active = false;
    await assert.rejects(runtime.readSecret());
  } finally {
    await owner.close();
  }
});
