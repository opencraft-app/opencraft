import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmployeeGitVaultStore } from "../../../../scripts/employee-git-vault-store";
import { ManagedNfsLibraries, validateLibrary } from "../../assets/libraries";
import { SandboxConfigurations } from "../../assets/sandbox-configurations";
import { parseAssetCatalog, mergeAssetCatalog } from "../../assets/catalog";
const library = {
  id: "beijing-shared",
  name: "Shared NFS",
  kind: "nfs" as const,
  managedBy: "e2b" as const,
  mountPath: "/shared" as const,
  credentialId: "credential",
  credentialGeneration: "generation",
  volumeId: "volume-private-metadata",
  environmentIds: ["installed-template"],
  templateIds: ["template"],
  verifiedAt: "2026-11-18T00:00:00.000Z",
};
test("managed NFS library validates mount boundary and untrusted fields", () => {
  validateLibrary(library);
  for (const extra of [
    { mountPath: "/" },
    { mountPath: "/shared/../../" },
    { environmentIds: [] },
    { environmentIds: ["x", "x"] },
    { verifiedAt: "now" },
    { apiKey: "secret" },
    { export: "server:/export" },
    { managedBy: "local" },
  ])
    assert.throws(() => validateLibrary({ ...library, ...extra }));
});
test("operator registration is persistent, CAS guarded, secret-free and invalidated on rotation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "managed-libraries-"));
  let vault = new EmployeeGitVaultStore(directory);
  t.after(async () => {
    vault.close();
    await rm(directory, { recursive: true, force: true });
  });
  let store = new ManagedNfsLibraries(vault);
  assert.deepEqual(store.read(), { revision: 0, libraries: [] });
  store.register(library, 0);
  assert.throws(() => store.register(library, 0));
  vault.close();
  vault = new EmployeeGitVaultStore(directory);
  store = new ManagedNfsLibraries(vault);
  const binding = {
    environmentId: "installed-template",
    templateId: "template",
    credentialId: "credential",
    credentialGeneration: "generation",
  };
  const view = store.snapshot([binding]);
  assert.equal(view.libraries[0].status, "configured");
  assert.equal(view.revision, 1);
  for (const field of ["credentialId", "credentialGeneration", "volumeId"])
    assert.ok(!JSON.stringify(view).includes(field));
  assert.equal(
    store.snapshot([{ ...binding, credentialGeneration: "rotated" }])
      .libraries[0].status,
    "unavailable",
  );
  assert.equal(
    store.snapshot([{ ...binding, templateId: "changed" }]).libraries[0].status,
    "unavailable",
  );
  assert.equal(store.snapshot([]).libraries[0].environmentIds.length, 0);
  const config = new SandboxConfigurations(vault);
  for (const admin of [true, false])
    assert.throws(() =>
      config.update(
        "user",
        { action: "save-library", source: "platform", revision: 0, ...library },
        true,
        admin,
      ),
    );
});
test("public catalogue reads libraries without credentials or fabricated compatible environments", () => {
  const record = {
    id: library.id,
    name: library.name,
    kind: "nfs",
    managedBy: "e2b",
    mountPath: "/shared",
    verifiedAt: library.verifiedAt,
    source: "platform",
    environmentIds: ["installed-template"],
    status: "configured",
  };
  const snapshot = {
    scope: "user",
    revision: 0,
    platformRevision: 1,
    canManagePlatform: false,
    allowCustomEndpoints: false,
    credentials: [],
    environments: [
      {
        id: "installed-template",
        name: "Template",
        templateId: "template",
        source: "platform",
      },
    ],
    libraryRevision: 1,
    libraries: [record],
  };
  const parsed = parseAssetCatalog(snapshot, "user");
  assert.equal(parsed.libraries?.length, 1);
  assert.throws(() =>
    parseAssetCatalog(
      {
        ...snapshot,
        libraries: [{ ...record, environmentIds: ["not-authorized"] }],
      },
      "user",
    ),
  );
  assert.throws(() =>
    parseAssetCatalog(
      { ...snapshot, libraries: [{ ...record, mountPath: "/" }] },
      "user",
    ),
  );
  assert.equal(
    parseAssetCatalog(
      { ...snapshot, libraries: undefined, libraryRevision: undefined },
      "user",
    ).libraries,
    undefined,
  );
});
