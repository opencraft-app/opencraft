import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxConfigurations } from "@opencraft/plugin-assets/server/configurations";
import { InstalledWorkspaceCatalog } from "@opencraft/plugin-assets/server/workspace-catalog";
import { adoptInstalledWorkspaceConfiguration } from "../../plugins/assets/src/server/installed-delivery";
import { PLATFORM_ASSET_SCOPE } from "@opencraft/plugin-assets/contract";

const namespace = "document-sandbox-configurations";
const resources = { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 };
const scope = "actor:human://fixture/compat-owner";
const context = { scope, current: () => true };

/** In-memory stand-in for the encrypted vault's document CAS. */
function memoryVault(initial?: unknown) {
  const documents = new Map<string, { revision: number; document: unknown }>();
  const key = (account: string, ns: string) => JSON.stringify([account, ns]);
  if (initial !== undefined)
    documents.set(key(PLATFORM_ASSET_SCOPE, namespace), { revision: 1, document: structuredClone(initial) });
  const writes: unknown[] = [];
  return {
    writes,
    readDocument(account: string, ns: string) {
      return structuredClone(documents.get(key(account, ns)) ?? { revision: 0, document: null });
    },
    writeDocument(account: string, ns: string, revision: number, document: unknown) {
      const current = documents.get(key(account, ns))?.revision ?? 0;
      if (current !== revision) throw Error("conflict");
      if (ns === namespace) writes.push(structuredClone(document));
      documents.set(key(account, ns), { revision: revision + 1, document: structuredClone(document) });
    },
  };
}

/** A platform document exactly as the pre-provider version stored it. */
const legacyCredential = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "E2B",
  apiUrl: "https://api.e2b.dev",
  sandboxUrl: "https://e2b.dev",
  apiKey: "synthetic-legacy-key",
  generation: "66666666-7777-4888-9999-aaaaaaaaaaaa",
};
const legacyDocument = {
  version: 1,
  credentials: [legacyCredential],
  environments: [{ id: "installed-legacy", name: "Legacy", credentialId: legacyCredential.id, templateId: "legacy-template" }],
  installation: {
    backendId: "e2b",
    capacity: resources,
    lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
    maxCommandMs: 60000,
    persistentWorkspaces: true,
    templates: [{ environmentId: "installed-legacy", workspaceRoot: "/workspace", resources }],
  },
};

test("a version-1 vault document without backend loads as E2B with an unchanged configuration revision", async () => {
  const vault = memoryVault(legacyDocument);
  const configurations = new SandboxConfigurations(vault);
  const installed = configurations.installedRuntime();
  assert.ok(installed);
  assert.equal(installed.policy.backendId, "e2b");
  assert.equal(installed.records.length, 1);
  assert.equal(installed.records[0]!.credential.backend, "e2b");

  const catalog = new InstalledWorkspaceCatalog(configurations);
  const environment = catalog.resolveEnvironment(context, {
    version: 1,
    configurationId: "installed-legacy",
    templateId: "legacy-template",
  });
  // The exact digest input of the pre-provider catalog. Persisted selections carry it.
  const policy = legacyDocument.installation;
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        "installed-legacy",
        "legacy-template",
        legacyCredential.id,
        legacyCredential.generation,
        legacyCredential.apiUrl,
        legacyCredential.sandboxUrl,
        "/workspace",
        resources.cpuMillis,
        resources.memoryBytes,
        null,
        policy.capacity.cpuMillis,
        policy.capacity.memoryBytes,
        policy.lease.timeoutMs,
        policy.lease.renewEveryMs,
        policy.lease.maxLifetimeMs,
        policy.maxCommandMs,
        policy.persistentWorkspaces,
      ]),
    )
    .digest("hex");
  assert.equal(environment.configurationRevision, expected);

  const runtime = catalog.runtime(context, environment);
  assert.deepEqual(runtime.installation, {
    backend: "e2b",
    apiUrl: legacyCredential.apiUrl,
    sandboxUrl: legacyCredential.sandboxUrl,
  });
  assert.equal(await runtime.readSecret(), legacyCredential.apiKey);
  assert.equal(JSON.stringify(runtime.installation).includes(legacyCredential.apiKey), false);

  // An existing write path rewrites the document; E2B credentials keep their stored shape.
  configurations.update(
    scope,
    { revision: 1, source: "platform", action: "save-environment", id: "installed-legacy", name: "Renamed", credentialId: legacyCredential.id, templateId: "legacy-template" },
    true,
    true,
  );
  assert.equal(vault.writes.length, 1);
  const written = vault.writes[0] as typeof legacyDocument;
  assert.deepEqual(written.credentials, [legacyCredential]);
  assert.deepEqual(written.installation, legacyDocument.installation);
});

test("an explicit E2B backend is accepted; an unknown backend makes the document unavailable", () => {
  const explicit = structuredClone(legacyDocument);
  (explicit.credentials[0] as Record<string, unknown>).backend = "e2b";
  assert.equal(new SandboxConfigurations(memoryVault(explicit)).installedRuntime()!.records[0]!.credential.backend, "e2b");
  for (const backend of ["cloudflare", "", null, 1]) {
    const unknown = structuredClone(legacyDocument);
    (unknown.credentials[0] as Record<string, unknown>).backend = backend;
    assert.throws(() => new SandboxConfigurations(memoryVault(unknown)).installedRuntime(), /unavailable/);
  }
  const installation = structuredClone(legacyDocument);
  (installation.installation as Record<string, unknown>).backendId = "cloudflare";
  assert.throws(() => new SandboxConfigurations(memoryVault(installation)).installedRuntime(), /unavailable/);
});

test("a schemaVersion 1 installation file without backend is adopted as E2B in the version-1 shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "sandbox-installation-compat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = join(root, "key"),
    file = join(root, "installation.json");
  await writeFile(keyFile, "synthetic-installed-key", { mode: 0o600 });
  const config = {
    schemaVersion: 1,
    apiUrl: "https://api.e2b.dev",
    sandboxUrl: "https://e2b.dev",
    apiKeyFile: keyFile,
    capacity: resources,
    lease: { timeoutMs: 60000, renewEveryMs: 10000, maxLifetimeMs: 3600000 },
    templates: [{ id: "synthetic-template", name: "Synthetic", workspaceRoot: "/workspace", resources }],
  };
  for (const backend of ["cloudflare", "local"]) {
    await writeFile(file, JSON.stringify({ ...config, backend }), { mode: 0o600 });
    const vault = memoryVault();
    await assert.rejects(adoptInstalledWorkspaceConfiguration(new SandboxConfigurations(vault), file), /unavailable/);
    assert.equal(vault.writes.length, 0);
  }
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const vault = memoryVault();
  assert.equal(await adoptInstalledWorkspaceConfiguration(new SandboxConfigurations(vault), file), true);
  const stored = vault.writes[0] as typeof legacyDocument;
  assert.equal(stored.installation.backendId, "e2b");
  assert.deepEqual(Object.keys(stored.credentials[0]!).sort(), ["apiKey", "apiUrl", "generation", "id", "name", "sandboxUrl"]);
  assert.equal(stored.credentials[0]!.name, "E2B");
  assert.equal(stored.credentials[0]!.apiKey, "synthetic-installed-key");
});
