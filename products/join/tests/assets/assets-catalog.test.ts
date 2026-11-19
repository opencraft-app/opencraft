import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetCatalog } from "../../assets/catalog";
import { assetProviders, providersFor } from "../../assets/providers";
const scope = "tencentoa:100";
const sample = () => ({
  scope,
  revision: 1,
  allowCustomEndpoints: false,
  credentials: [
    {
      id: "c",
      name: "Account",
      apiUrl: "https://api.e2b.dev",
      sandboxUrl: "https://e2b.dev",
      generation: "generation",
    },
  ],
  environments: [
    { id: "e", name: "Dev", credentialId: "c", templateId: "template" },
  ],
});
test("provider catalog selects capabilities without treating all connections as egress", () => {
  assert.equal(
    new Set(assetProviders.map((p) => p.id)).size,
    assetProviders.length,
  );
  assert.deepEqual(
    providersFor("environments").map((p) => p.id),
    ["e2b"],
  );
  assert.deepEqual(
    providersFor("git").map((p) => p.id),
    ["gongfeng", "github"],
  );
  assert.deepEqual(
    providersFor("tools").map((p) => p.id),
    ["gongfeng"],
  );
  for (const p of assetProviders) if (p.editor === "git") assert.ok(p.host);
});
test("public catalog is account-scoped, bounded and contains metadata only", () => {
  const body = sample();
  const next = parseAssetCatalog(
    { ...body, privateMaterial: "must-not-project" },
    scope,
  );
  assert.deepEqual(next, body);
  assert.ok(!JSON.stringify(next).includes("privateMaterial"));
  assert.throws(() => parseAssetCatalog(body, "tencentoa:200"), /invalid/);
  assert.throws(
    () =>
      parseAssetCatalog(
        {
          ...body,
          credentials: [{ ...body.credentials[0], apiKey: "secret" }],
        },
        scope,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseAssetCatalog(
        { ...body, credentials: [...body.credentials, ...body.credentials] },
        scope,
      ),
    /invalid/,
  );
  assert.throws(
    () => parseAssetCatalog({ ...body, environments: [{ id: "bad" }] }, scope),
    /invalid/,
  );
  assert.throws(
    () =>
      parseAssetCatalog(
        {
          ...body,
          credentials: Array.from({ length: 33 }, (_, i) => ({
            ...body.credentials[0],
            id: String(i),
          })),
        },
        scope,
      ),
    /invalid/,
  );
  assert.throws(
    () => parseAssetCatalog({ ...body, revision: -1 }, scope),
    /invalid/,
  );
});
test("duplicate connection names stay selectable without technical identifiers", async () => {
  const { connectionLabel } = await import("../../assets/catalog");
  const first = sample().credentials[0]!,
    second = { ...first, id: "another-unique-id" };
  assert.equal(connectionLabel(first, [first]), "Account");
  assert.notEqual(
    connectionLabel(first, [first, second]),
    connectionLabel(second, [first, second]),
  );
  assert.equal(connectionLabel(first, [first, second]), "Account (1)");
  assert.equal(connectionLabel(second, [first, second]), "Account (2)");
  assert.ok(!connectionLabel(first, [first, second]).includes(first.apiUrl));
  assert.ok(!connectionLabel(second, [first, second]).includes(second.id));
});
test("sources share one catalog but retain separate identity, permissions and CAS clocks", async () => {
  const { connectionLabel, catalogRevision, mergeAssetCatalog } = await import(
    "../../assets/catalog"
  );
  const own = sample(),
    shared = { ...own.environments[0]!, source: "platform" as const };
  const platformCredential = {
    ...own.credentials[0]!,
    source: "platform" as const,
  };
  const admin = {
    ...own,
    canManagePlatform: true,
    platformRevision: 4,
    credentials: [...own.credentials, platformCredential],
    environments: [...own.environments, shared],
  };
  assert.deepEqual(parseAssetCatalog(admin, scope), admin);
  assert.notEqual(
    connectionLabel(admin.credentials[0]!, admin.credentials),
    connectionLabel(platformCredential, admin.credentials),
  );
  assert.equal(catalogRevision(admin, "personal"), 1);
  assert.equal(catalogRevision(admin, "platform"), 4);
  const member = {
    ...admin,
    canManagePlatform: false,
    credentials: own.credentials,
    environments: [
      ...own.environments,
      {
        id: shared.id,
        name: shared.name,
        templateId: shared.templateId,
        source: "platform" as const,
      },
    ],
  };
  assert.deepEqual(parseAssetCatalog(member, scope), member);
  assert.throws(
    () => parseAssetCatalog({ ...admin, canManagePlatform: false }, scope),
    /invalid/,
  );
  assert.throws(
    () => parseAssetCatalog({ ...admin, platformRevision: undefined }, scope),
    /invalid/,
  );
  assert.throws(
    () =>
      parseAssetCatalog(
        { ...own, environments: [{ ...shared, source: "team" }] },
        scope,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseAssetCatalog({ ...admin, environments: [shared, shared] }, scope),
    /invalid/,
  );
  const next = {
    ...member,
    revision: 0,
    platformRevision: 5,
    environments: [
      {
        id: shared.id,
        templateId: shared.templateId,
        source: "platform" as const,
        name: "New public name",
      },
    ],
  };
  const merged = mergeAssetCatalog(admin, next);
  assert.equal(merged.revision, 1);
  assert.equal(merged.platformRevision, 5);
  assert.equal(
    merged.credentials.length,
    1,
    "permission loss drops platform metadata even with an older private revision",
  );
  assert.equal(merged.environments[0]!.name, "Dev");
  assert.equal(merged.environments[1]!.name, "New public name");
});
