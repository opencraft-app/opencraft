// AccountCore ports on Node (cloudflare-deployment §5, storage-ports §7): the
// sealed secret store, the credential lease contract and its provider source,
// and the model policy's slim SQL lifecycle against the Node owner's chain.
// The same ports run inside the AccountCore Durable Object in
// tests/storage/account-core-do-workerd.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { SecretStoreCorruptError, memoryKeyMaterial } from "@opencraft/secret-storage";
import { documentSecretStore } from "@opencraft/secret-storage/documents";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import { SECRET_CONFORMANCE_CASES } from "@opencraft/secret-storage/conformance";
import {
  SecretSealingKeyError,
  importSecretSealingKey,
  sealedSecretStore,
} from "@opencraft/secret-storage/sealed";
import {
  CredentialLeaseError,
  documentCredentialLeases,
  type ProviderCredentialSource,
} from "@opencraft/account-pool-host/credential-leases";
import { MODEL_GATEWAY_PATH } from "../../packages/account-pool-host/src/model-gateway-http.ts";
import { nodeSqlDatabase, resolveStoreMigrations } from "@opencraft/sqlite-node";
import { modelPolicyMigrations, ModelPolicyStore as SqlModelPolicyStore } from "@opencraft/model-usage-policy/store";
import { migrateModelPolicySqlDatabase } from "@opencraft/model-usage-policy/sql-owner";
import { ModelPolicyStore, POLICY_PATH } from "@opencraft/model-usage-policy";
import {
  ModelConfigurationRepository,
  ModelCredentialRepository,
} from "../../apps/local-agent-host/src/model-config/repository.ts";
import { modelProviderCredentials } from "../../apps/local-agent-host/src/model-config/provider-credentials.ts";
import { MODEL_GATEWAY_ROUTE, MODEL_POLICY_ROUTE, accountRoute } from "../../apps/headless-server/src/account-routes.ts";

const KEY = (id: string, fill: number) => `${id}.${Buffer.alloc(32, fill).toString("base64url")}`;

for (const conformance of SECRET_CONFORMANCE_CASES)
  test(`sealed secrets pass the secret store conformance: ${conformance.name}`, async () => {
    const secrets = sealedSecretStore(documentSecretStore(memoryStateDocumentStore()), await importSecretSealingKey(KEY("k1", 7)));
    await conformance.run({ secrets, keys: memoryKeyMaterial() });
  });

test("sealed secrets never reach the inner store in plaintext, are bound to their name and key, and refuse plaintext", async () => {
  const documents = memoryStateDocumentStore();
  const inner = documentSecretStore(documents);
  const sealing = await importSecretSealingKey(KEY("k1", 7));
  const secrets = sealedSecretStore(inner, sealing);
  await secrets.set("PROVIDER_KEY", "synthetic-provider-credential");
  const stored = JSON.stringify(await documents.read("credentials.json"));
  assert.doesNotMatch(stored, /synthetic-provider-credential/u);
  assert.match((await inner.get("PROVIDER_KEY"))!, /^ocs1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
  assert.equal(await secrets.get("PROVIDER_KEY"), "synthetic-provider-credential");
  // Rewriting the same value keeps the ciphertext, so the stamp changes only with a value.
  const stamp = await secrets.stamp();
  await secrets.set("PROVIDER_KEY", "synthetic-provider-credential");
  assert.equal(await secrets.stamp(), stamp);
  // A sealed value moved to another name does not open.
  await inner.set("OTHER_KEY", (await inner.get("PROVIDER_KEY"))!);
  await assert.rejects(secrets.get("OTHER_KEY"), SecretStoreCorruptError);
  // Another key, or a key with another id, never opens it.
  await assert.rejects(
    sealedSecretStore(inner, await importSecretSealingKey(KEY("k1", 8))).get("PROVIDER_KEY"),
    SecretStoreCorruptError,
  );
  await assert.rejects(
    sealedSecretStore(inner, await importSecretSealingKey(KEY("k2", 7))).get("PROVIDER_KEY"),
    SecretSealingKeyError,
  );
  // A plaintext value written beneath the sealing layer is refused, not returned.
  await inner.set("PLAIN_KEY", "synthetic-plaintext");
  await assert.rejects(secrets.get("PLAIN_KEY"), SecretStoreCorruptError);
  for (const configured of [undefined, "", "k1", "k1.short", "bad id.x", `k1.${Buffer.alloc(16).toString("base64url")}`])
    await assert.rejects(importSecretSealingKey(configured), SecretSealingKeyError, String(configured));
});

function leaseFixture() {
  let now = 1_000_000;
  const source: ProviderCredentialSource = {
    async resolve(providerId) {
      return providerId === "p1"
        ? { providerId, protocol: "openai-responses", baseUrl: "https://api.example/v1", credential: "synthetic-credential" }
        : null;
    },
  };
  const documents = memoryStateDocumentStore();
  const leases = documentCredentialLeases(documents, source, { now: () => now, capacity: 3 });
  return { leases, documents, advance: (ms: number) => (now += ms), now: () => now };
}
const holder = (incarnation = "i1", engine = "pi") => ({ workspace: "default", engine, incarnation });
const code = (code: string) => (error: unknown) => error instanceof CredentialLeaseError && error.code === code;

test("a credential lease is granted, redeemed for one provider's credential, renewed, and expires", async () => {
  const f = leaseFixture();
  const grant = await f.leases.grant(holder(), 60_000);
  assert.match(grant.token, /^oc_lease_[A-Za-z0-9_-]{43}$/u);
  assert.equal(grant.expiresAt, f.now() + 60_000);
  const ledger = JSON.stringify(await f.documents.read("credential-leases.json"));
  assert.doesNotMatch(ledger, new RegExp(grant.token.slice("oc_lease_".length), "u"), "the ledger holds no token");
  assert.doesNotMatch(ledger, /synthetic-credential/u, "the ledger holds no credential");
  assert.deepEqual(await f.leases.redeem(grant.token, "p1"), {
    providerId: "p1",
    protocol: "openai-responses",
    baseUrl: "https://api.example/v1",
    credential: "synthetic-credential",
    leaseId: grant.id,
    holder: holder(),
    expiresAt: grant.expiresAt,
  });
  await assert.rejects(f.leases.redeem(grant.token, "p2"), code("provider_unavailable"));
  await assert.rejects(f.leases.redeem("oc_lease_" + "A".repeat(43), "p1"), code("lease_invalid"));
  await assert.rejects(f.leases.redeem("not-a-lease", "p1"), code("lease_invalid"));
  f.advance(59_000);
  assert.equal((await f.leases.renew(grant.id, 60_000)).expiresAt, f.now() + 60_000);
  f.advance(59_000);
  assert.equal((await f.leases.redeem(grant.token, "p1")).credential, "synthetic-credential");
  f.advance(1_001);
  await assert.rejects(f.leases.redeem(grant.token, "p1"), code("lease_invalid"));
  await assert.rejects(f.leases.renew(grant.id, 60_000), code("lease_invalid"), "an expired lease cannot be renewed");
  for (const ttl of [0, 999, 3_600_001, 1.5])
    await assert.rejects(f.leases.grant(holder(), ttl), code("invalid_lease_request"), String(ttl));
  for (const bad of [{ ...holder(), extra: "x" }, { ...holder(), workspace: "" }, { ...holder(), engine: "a b" }])
    await assert.rejects(f.leases.grant(bad as never, 60_000), code("invalid_lease_request"));
});

test("credential leases are revoked one by one, by workspace and engine, or when the incarnation changes; capacity counts current leases", async () => {
  const f = leaseFixture();
  const first = await f.leases.grant(holder("i1"), 60_000);
  const other = await f.leases.grant(holder("i1", "dsh"), 60_000);
  const next = await f.leases.grant(holder("i2"), 60_000);
  await assert.rejects(f.leases.grant(holder("i3"), 60_000), code("lease_capacity"));
  // The container was replaced: every lease of an older incarnation goes.
  assert.equal(await f.leases.revokeHolder({ workspace: "default", keepIncarnation: "i2" }), 2);
  await assert.rejects(f.leases.redeem(first.token, "p1"), code("lease_invalid"));
  await assert.rejects(f.leases.redeem(other.token, "p1"), code("lease_invalid"));
  assert.equal((await f.leases.redeem(next.token, "p1")).leaseId, next.id);
  assert.equal(await f.leases.revoke(next.id), true);
  assert.equal(await f.leases.revoke(next.id), false);
  await assert.rejects(f.leases.redeem(next.token, "p1"), code("lease_invalid"));
  const engine = await f.leases.grant(holder("i2", "pi"), 1_000);
  await f.leases.grant(holder("i2", "dsh"), 60_000);
  assert.equal(await f.leases.revokeHolder({ workspace: "default", engine: "pi" }), 1);
  await assert.rejects(f.leases.redeem(engine.token, "p1"), code("lease_invalid"));
  assert.equal(await f.leases.revokeHolder({ workspace: "elsewhere" }), 0);
  // Expired leases do not count toward capacity.
  await f.leases.grant(holder("i2", "a"), 1_000);
  await f.leases.grant(holder("i2", "b"), 1_000);
  f.advance(1_001);
  await f.leases.grant(holder("i2", "c"), 60_000);
});

test("the provider credential source leases only an enabled provider the account forwards to, with its credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "account-core-ports-"));
  try {
    const configuration = new ModelConfigurationRepository(fileStateDocumentStore(directory));
    const credentials = new ModelCredentialRepository(fileSecretStore(directory));
    const source = modelProviderCredentials(configuration, credentials);
    await credentials.set("P1_KEY", "synthetic-provider-key");
    await configuration.update(0, (doc) => {
      const provider = (id: string, extra: Record<string, unknown>) =>
        ({ id, name: id, enabled: true, protocol: "openai-responses", baseUrl: "https://api.example/v1", credentialRef: "P1_KEY", models: [{ id: "m", enabled: true }], ...extra }) as never;
      doc.providers.push(
        provider("p1", {}),
        provider("disabled", { enabled: false }),
        provider("plain-http", { baseUrl: "http://api.example/v1" }),
        provider("unsupported", { protocol: "google-generative-ai" }),
        provider("keyless", { credentialRef: null }),
        provider("missing-key", { credentialRef: "ABSENT_KEY" }),
      );
    });
    assert.deepEqual(await source.resolve("p1"), {
      providerId: "p1",
      protocol: "openai-responses",
      baseUrl: "https://api.example/v1",
      credential: "synthetic-provider-key",
    });
    for (const id of ["disabled", "plain-http", "unsupported", "keyless", "missing-key", "absent"])
      assert.equal(await source.resolve(id), null, id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model policy's slim SQL lifecycle applies the Node owner's chain, refuses foreign or changed histories and serves the same store", async () => {
  // The Durable Object applies the published chain without the generated registry; the registry adds nothing yet.
  assert.deepEqual(resolveStoreMigrations("model-usage-policy", [...modelPolicyMigrations]), modelPolicyMigrations);
  const directory = await mkdtemp(join(tmpdir(), "account-core-policy-"));
  try {
    // The Node owner's file and the slim lifecycle's database end with the same ledger and schema.
    const path = join(directory, "model-usage-policy.sqlite");
    new ModelPolicyStore(path).close();
    const nodeFile = new DatabaseSync(path, { readOnly: true });
    const memory = new DatabaseSync(":memory:");
    const migrated = migrateModelPolicySqlDatabase(nodeSqlDatabase(memory));
    assert.equal(migrated.outcome?.status, "fresh");
    const dump = (database: DatabaseSync) => ({
      ledger: database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all(),
      schema: database
        .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
        .all(),
    });
    assert.deepEqual(dump(memory), dump(nodeFile));
    nodeFile.close();
    const store = new SqlModelPolicyStore(migrated);
    assert.deepEqual(store.write(0, [{ engine: "codex", model: "blocked" }], "actor"), {
      revision: 1,
      rules: [{ engine: "codex", model: "blocked" }],
    });
    assert.throws(() => store.write(0, [], "actor"), /revision_conflict/u);
    assert.equal(migrateModelPolicySqlDatabase(nodeSqlDatabase(memory)).outcome?.status, "up-to-date");
    memory.exec("UPDATE schema_migrations SET checksum='0' WHERE version=1");
    assert.throws(() => migrateModelPolicySqlDatabase(nodeSqlDatabase(memory)), /history/u);
    const foreign = new DatabaseSync(":memory:");
    foreign.exec("CREATE TABLE unrelated(x)");
    assert.throws(() => migrateModelPolicySqlDatabase(nodeSqlDatabase(foreign)), /refusing to adopt/u);
    assert.doesNotThrow(() =>
      migrateModelPolicySqlDatabase(nodeSqlDatabase(foreign), { ownedByRuntime: (name) => name === "unrelated" }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shared account route table names the routes the account services own", () => {
  assert.equal(MODEL_POLICY_ROUTE, POLICY_PATH);
  assert.equal(MODEL_GATEWAY_ROUTE, MODEL_GATEWAY_PATH);
  assert.equal(accountRoute(POLICY_PATH), "policy");
  assert.equal(accountRoute(MODEL_GATEWAY_PATH), "gateway");
  for (const path of ["/__opencraft_model_policy/", "/__opencraft_model_policyx", "/__opencraft_account", "/"])
    assert.equal(accountRoute(path), null, path);
});
