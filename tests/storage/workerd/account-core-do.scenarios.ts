// The production AccountCore Durable Object (apps/headless-server/src/cloudflare/)
// against the Node Headless server and the Node account assembly: the same
// model policy HTTP sequence (through the entry Worker, gated and authorized by
// the InstallationCore object) and the same model configuration, credential and
// credential lease operations run on both and must give the same results after
// normalizing random IDs, tokens and times. Further scenarios cover sealed
// storage (no plaintext credential in the object), eviction of either object,
// a refused open without a sealing key, and the internal authority path never
// being reachable through the entry. Shared by the Miniflare test
// (tests/storage/account-core-do-workerd.test.ts) and the real-Cloudflare
// rehearsal (`npm run cf:rehearsal`).
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assembleAccount } from "../../../apps/headless-server/src/assembly/account.mjs";
import { nodeAccountInputs } from "../../../apps/headless-server/src/assembly/account-node.mjs";
import {
  sleep,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerScenario,
  type WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";
import {
  Browser,
  LOCAL_ORIGIN,
  MEMBER_PASSWORD,
  OWNER_PASSWORD,
  PROOF,
  login,
  nodeBackend,
  normalizer,
  type Backend,
} from "./installation-core-do.scenarios.ts";
import { runAccountOperation, type AccountOperation, type AccountOperationResult } from "./account-core-operations.ts";

export const ACCOUNT_CORE_DO_SPEC: WorkerSpec = {
  id: "account-core-do",
  entry: resolve(import.meta.dirname, "account-core-do-worker.ts"),
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: { INSTALLATION_CORE: "TestInstallationCore", ACCOUNT_CORE: "TestAccountCore" },
  externalNode: true,
};

/** A fixed test key (`<id>.<base64url 32 bytes>`); never a deployment's. */
const SEALING_KEY = `k1.${"A".repeat(43)}`;
const POLICY = "/__opencraft_model_policy";
const PROVIDER_KEY = "synthetic-provider-key-1";
const ROTATED_KEY = "synthetic-provider-key-2";

function deploymentVars(sealingKey: string | null) {
  return (origin: string) => ({
    OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin, local: true, oidc: [] }),
    OPENCRAFT_SETUP_TOKEN: PROOF,
    ...(sealingKey === null ? {} : { OPENCRAFT_ACCOUNT_SEALING_KEY: sealingKey }),
  });
}

/** Both objects behind the production entry, over persisted storage so a restart keeps them. */
async function deploymentBackend(
  runtime: WorkerRuntime,
  sealingKey: string | null = SEALING_KEY,
): Promise<Backend & { instance(): WorkerInstance }> {
  const persist = `account-core-do-${crypto.randomUUID()}`;
  const start = () =>
    runtime.start(ACCOUNT_CORE_DO_SPEC, { persist, vars: deploymentVars(sealingKey), localOrigin: LOCAL_ORIGIN });
  let instance = await start();
  return {
    get origin() {
      return instance.origin;
    },
    instance: () => instance,
    fetch: (path, init) => instance.fetch(instance.origin + path, init),
    async restart() {
      await runtime.stop(instance);
      instance = await start();
    },
    close: () => runtime.stop(instance),
  };
}

/** The model policy over HTTP: admission, authority, writes, conflicts, revocation and restart. */
async function policySequence(backend: Backend) {
  const observe = normalizer(backend.origin);
  const seen: Awaited<ReturnType<typeof observe>>[] = [];
  const record = async (label: string, response: Promise<Response>) => {
    seen.push(await observe(label, await response));
  };
  const anonymous = new Browser(backend);
  await record("anonymous policy", anonymous.call(POLICY));
  await record("anonymous policy page", anonymous.call(POLICY, undefined, { accept: "text/html" }));
  await record(
    "session bearer policy",
    anonymous.call(POLICY, undefined, { authorization: "Bearer oc_actor_fixture" }),
  );
  const { owner, member, memberId } = await login(backend);
  await record("owner reads", owner.call(POLICY));
  const rules = [{ engine: "codex", model: "fixture-blocked-model" }];
  await record("owner writes", owner.call(POLICY, { revision: 0, rules }));
  await record("stale revision", owner.call(POLICY, { revision: 0, rules: [] }));
  await record("invalid rules", owner.call(POLICY, { revision: 1, rules: [{ engine: "unknown", model: "m" }] }));
  await record("extra field", owner.call(POLICY, { revision: 1, rules: [], extra: true }));
  await record(
    "cross-origin write",
    owner.call(POLICY, { revision: 1, rules: [] }, { origin: "https://elsewhere.example" }),
  );
  const cookie = [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  await record("unsupported method", backend.fetch(POLICY, { method: "PUT", headers: { cookie } }));
  await record("member reads", member.call(POLICY));
  await record("member writes", member.call(POLICY, { revision: 1, rules: [] }));
  await record(
    "revoke member",
    owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false }),
  );
  await record("revoked member reads", member.call(POLICY));
  await backend.restart();
  await record("owner reads after restart", owner.call(POLICY));
  await record("owner writes after restart", owner.call(POLICY, { revision: 1, rules: [] }));
  return seen;
}

const TOKEN = /oc_lease_[A-Za-z0-9_-]{43}/gu;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
/** IDs and tokens become first-seen markers, times a marker; equal runs stay equal. */
function operationNormalizer() {
  const seen = new Map<string, string>();
  const mark = (prefix: string) => (value: string) => {
    if (!seen.has(value)) seen.set(value, `<${prefix}${seen.size}>`);
    return seen.get(value)!;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(TOKEN, mark("token")).replace(UUID, mark("id"));
    if (typeof value === "number" && value > 1e12) return "<time>";
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk;
}

type Call = (operation: AccountOperation) => Promise<AccountOperationResult>;
const holder = (incarnation: string) => ({ workspace: "default", engine: "pi", incarnation });
const provider = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  enabled: true,
  protocol: "openai-responses",
  baseUrl: "https://api.example/v1",
  credentialRef: "P1_KEY",
  models: [{ id: "m", enabled: true }],
  ...extra,
});
const value = <T>(result: AccountOperationResult) => {
  assert.ok("ok" in result, JSON.stringify(result));
  return result.ok as T;
};

/**
 * Model configuration, credentials and credential leases. `restart` is the
 * side's own restart (Node: a new assembly over the same files; the object: a
 * new runtime instance over the same storage).
 */
async function operationSequence(call: Call, restart: () => Promise<void>) {
  const seen: [string, AccountOperationResult][] = [];
  const run = async (label: string, operation: AccountOperation) => {
    const result = await call(operation);
    seen.push([label, result]);
    return result;
  };
  await run("empty configuration", { op: "config.read" });
  await run("configure providers", {
    op: "config.update",
    revision: 0,
    providers: [
      provider("p1"),
      provider("keyless", { credentialRef: null }),
      provider("plain", { baseUrl: "http://api.example/v1" }),
    ],
  });
  await run("stale configuration", { op: "config.update", revision: 0, providers: [] });
  await run("credential absent", { op: "credentials.configured", ref: "P1_KEY" });
  await run("set credential", { op: "credentials.set", ref: "P1_KEY", value: PROVIDER_KEY });
  await run("invalid credential name", { op: "credentials.set", ref: "not a name", value: "x" });
  await run("credential configured", { op: "credentials.configured", ref: "P1_KEY" });
  const first = value<{ id: string; token: string }>(
    await run("grant", { op: "leases.grant", holder: holder("i1"), ttlMs: 60_000 }),
  );
  await run("redeem", { op: "leases.redeem", token: first.token, providerId: "p1" });
  await run("redeem keyless provider", { op: "leases.redeem", token: first.token, providerId: "keyless" });
  await run("redeem plain-HTTP provider", { op: "leases.redeem", token: first.token, providerId: "plain" });
  await run("redeem unknown token", { op: "leases.redeem", token: `oc_lease_${"B".repeat(43)}`, providerId: "p1" });
  await run("invalid ttl", { op: "leases.grant", holder: holder("i1"), ttlMs: 10 });
  await run("renew", { op: "leases.renew", id: first.id, ttlMs: 60_000 });
  const short = value<{ id: string; token: string }>(
    await run("grant short", { op: "leases.grant", holder: holder("i2"), ttlMs: 1_000 }),
  );
  await sleep(1_300);
  await run("redeem expired", { op: "leases.redeem", token: short.token, providerId: "p1" });
  await run("renew expired", { op: "leases.renew", id: short.id, ttlMs: 60_000 });
  await run("new incarnation revokes the old", {
    op: "leases.revokeHolder",
    match: { workspace: "default", keepIncarnation: "i3" },
  });
  await run("redeem revoked by incarnation", { op: "leases.redeem", token: first.token, providerId: "p1" });
  const third = value<{ id: string; token: string }>(
    await run("grant third", { op: "leases.grant", holder: holder("i3"), ttlMs: 60_000 }),
  );
  await run("revoke", { op: "leases.revoke", id: third.id });
  await run("revoke again", { op: "leases.revoke", id: third.id });
  await run("redeem revoked", { op: "leases.redeem", token: third.token, providerId: "p1" });
  const durable = value<{ id: string; token: string }>(
    await run("grant durable", { op: "leases.grant", holder: holder("i3"), ttlMs: 60_000 }),
  );
  await run("rotate credential", { op: "credentials.set", ref: "P1_KEY", value: ROTATED_KEY });
  await run("redeem rotated", { op: "leases.redeem", token: durable.token, providerId: "p1" });
  await restart();
  await run("configuration after restart", { op: "config.read" });
  await run("credential after restart", { op: "credentials.configured", ref: "P1_KEY" });
  await run("redeem after restart", { op: "leases.redeem", token: durable.token, providerId: "p1" });
  await run("remove credential", { op: "credentials.remove", ref: "P1_KEY" });
  await run("redeem without credential", { op: "leases.redeem", token: durable.token, providerId: "p1" });
  const walk = operationNormalizer();
  return seen.map(([label, result]) => ({ label, result: walk(result) }));
}

async function opCall(backend: Backend, operation: AccountOperation): Promise<AccountOperationResult> {
  const response = await backend.fetch("/__test/account/op", { method: "POST", body: JSON.stringify(operation) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as AccountOperationResult;
}

export const ACCOUNT_CORE_DO_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "the AccountCore object, behind the entry and the InstallationCore gate, answers the model policy sequence as the Node Headless server does",
    async run({ runtime, scratch, diagnostic }) {
      const node = await nodeBackend(scratch);
      let nodeRun: Awaited<ReturnType<typeof policySequence>>;
      try {
        nodeRun = await policySequence(node);
      } finally {
        await node.close();
      }
      const object = await deploymentBackend(runtime);
      try {
        const objectRun = await policySequence(object);
        diagnostic(objectRun.map((step) => `${step.label}: ${step.status}`).join("; "));
        assert.deepEqual(objectRun, nodeRun);
      } finally {
        await object.close();
      }
      // The comparison exercised what it claims: gate, authority, conflicts, revocation and persistence.
      const status = (label: string) => nodeRun!.find((step) => step.label === label)?.status;
      assert.deepEqual(
        [
          "anonymous policy",
          "session bearer policy",
          "owner writes",
          "stale revision",
          "cross-origin write",
          "member reads",
          "member writes",
          "revoked member reads",
          "owner writes after restart",
        ].map(status),
        [401, 403, 200, 409, 403, 200, 403, 403, 200],
      );
      const reread = nodeRun!.find((step) => step.label === "owner reads after restart")!.body as { revision: number };
      assert.equal(reread.revision, 1);
    },
  },
  {
    name: "model configuration, sealed credentials and credential leases give the same results in the AccountCore object and the Node account assembly",
    async run({ runtime, scratch, diagnostic }) {
      const dataDirectory = join(scratch, `account-${crypto.randomUUID()}`);
      await mkdir(dataDirectory, { recursive: true });
      let account = assembleAccount(nodeAccountInputs({ dataDirectory }));
      let nodeRun: Awaited<ReturnType<typeof operationSequence>>;
      try {
        nodeRun = await operationSequence(
          (operation) => runAccountOperation(account, operation),
          async () => {
            account.close();
            account = assembleAccount(nodeAccountInputs({ dataDirectory }));
          },
        );
      } finally {
        account.close();
      }
      const object = await deploymentBackend(runtime);
      try {
        const objectRun = await operationSequence(
          (operation) => opCall(object, operation),
          () => object.restart(),
        );
        diagnostic(
          objectRun
            .map((step) => `${step.label}: ${"ok" in (step.result as object) ? "ok" : JSON.stringify(step.result)}`)
            .join("; "),
        );
        assert.deepEqual(objectRun, nodeRun);
        // The object's storage holds no credential in plaintext, before or after a rotation.
        const stored = JSON.stringify(await (await object.fetch("/__test/account/storage")).json());
        assert.doesNotMatch(stored, new RegExp(`${PROVIDER_KEY}|${ROTATED_KEY}`, "u"));
        assert.match(stored, /"secret\/credentials\.json"/u);
      } finally {
        await object.close();
      }
      // The sequence exercised what it claims.
      const result = (label: string) => nodeRun!.find((step) => step.label === label)?.result;
      assert.deepEqual(
        [
          "redeem keyless provider",
          "redeem unknown token",
          "redeem expired",
          "redeem revoked by incarnation",
          "redeem revoked",
          "redeem without credential",
        ].map(result),
        [
          { error: "provider_unavailable" },
          { error: "lease_invalid" },
          { error: "lease_invalid" },
          { error: "lease_invalid" },
          { error: "lease_invalid" },
          { error: "provider_unavailable" },
        ],
      );
      assert.equal((result("redeem") as { ok: { credential: string } }).ok.credential, PROVIDER_KEY);
      assert.equal((result("redeem after restart") as { ok: { credential: string } }).ok.credential, ROTATED_KEY);
    },
  },
  {
    name: "an evicted AccountCore or InstallationCore object is rebuilt from its storage: policy, credentials and leases survive",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime);
      try {
        const { owner } = await login(object);
        const rules = [{ engine: "pi", effort: "high" }];
        assert.equal((await owner.call(POLICY, { revision: 0, rules })).status, 200);
        value(await opCall(object, { op: "config.update", revision: 0, providers: [provider("p1")] }));
        value(await opCall(object, { op: "credentials.set", ref: "P1_KEY", value: PROVIDER_KEY }));
        const lease = value<{ token: string }>(
          await opCall(object, { op: "leases.grant", holder: holder("i1"), ttlMs: 60_000 }),
        );
        await object.fetch("/__test/account/evict").catch(() => undefined);
        const read = (await (await owner.call(POLICY)).json()) as { revision: number; rules: unknown };
        assert.deepEqual({ revision: read.revision, rules: read.rules }, { revision: 1, rules });
        assert.equal(
          value<{ credential: string }>(
            await opCall(object, { op: "leases.redeem", token: lease.token, providerId: "p1" }),
          ).credential,
          PROVIDER_KEY,
        );
        // The installation's object evicted: the account's authority questions reach the rebuilt one.
        await object.fetch("/__test/evict").catch(() => undefined);
        assert.equal((await owner.call(POLICY, { revision: 1, rules: [] })).status, 200);
        assert.equal((await new Browser(object).call(POLICY)).status, 401);
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "an AccountCore object without a valid sealing key stays closed and stores nothing, while the installation still serves",
    async run({ runtime }) {
      for (const key of [null, "k1.too-short"]) {
        const object = await deploymentBackend(runtime, key);
        try {
          const owner = new Browser(object);
          const setup = await owner.call("/__opencraft_account/setup", {
            proof: PROOF,
            mode: "web",
            username: "owner",
            password: OWNER_PASSWORD,
          });
          assert.equal(setup.status, 200, await setup.clone().text());
          const refused = await owner.call(POLICY);
          assert.equal(refused.status, 503, String(key));
          assert.deepEqual(await refused.json(), { error: "account_unavailable" });
          await object.restart();
          assert.equal((await owner.call(POLICY)).status, 503);
          assert.equal((await owner.call("/__opencraft_access/session")).status, 200);
        } finally {
          await object.close();
        }
      }
      assert.ok(MEMBER_PASSWORD);
    },
  },
  {
    name: "the entry Worker never forwards the internal account authority path, and an account route it does not serve answers missing",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime);
      try {
        for (const method of ["GET", "POST"]) {
          const response = await object.fetch("/__opencraft_internal/account-authority", {
            method,
            ...(method === "POST"
              ? { body: JSON.stringify({ scope: "policy", method: "GET", path: "/", headers: {} }) }
              : {}),
          });
          assert.equal(response.status, 404, method);
          assert.deepEqual(await response.json(), { error: "missing" });
        }
        const { owner } = await login(object);
        // The model gateway is owned by the account but not assembled in the object.
        const gateway = await owner.call("/__opencraft_model_gateway");
        assert.equal(gateway.status, 404);
        assert.deepEqual(await gateway.json(), { error: "missing" });
      } finally {
        await object.close();
      }
    },
  },
];
