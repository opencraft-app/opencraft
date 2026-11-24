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
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { assembleAccount } from "../../../apps/headless-server/src/assembly/account.mjs";
import { ModelConfigurationRepository } from "../../../apps/local-agent-host/src/model-config/repository.ts";
import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
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
import {
  fixtureRenewalExecutor,
  runAccountPoolOperation,
  type AccountPoolOperation,
  type AccountPoolOperationResult,
} from "./account-pool-operations.ts";
import { AccountPoolStore } from "../../../packages/account-pool-host/src/store.ts";
import { assembleAccountPoolCore } from "../../../packages/account-pool-host/src/account-pool-core.ts";
import { fetchAccountRenewal } from "../../../packages/account-pool-host/src/account-renewal.ts";
import { ACCOUNT_REFRESH_LEAD_MS } from "../../../packages/account-pool-host/src/account-refresh-schedule.ts";
import { boundedWakeTimer, timeoutWakeClock, type OwnerWake } from "@opencraft/owner-wake";

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

function deploymentVars(sealingKey: string | null, extra: Record<string, string> = {}) {
  return (origin: string) => ({
    OPENCRAFT_HUMAN_AUTH: JSON.stringify({ origin, local: true, oidc: [] }),
    OPENCRAFT_SETUP_TOKEN: PROOF,
    ...(sealingKey === null ? {} : { OPENCRAFT_ACCOUNT_SEALING_KEY: sealingKey }),
    ...extra,
  });
}

/** Both objects behind the production entry, over persisted storage so a restart keeps them. */
async function deploymentBackend(
  runtime: WorkerRuntime,
  sealingKey: string | null = SEALING_KEY,
  /** Test-only variables for the test subclass (never read by the production object). */
  extra: Record<string, string> = {},
): Promise<Backend & { instance(): WorkerInstance }> {
  const persist = `account-core-do-${crypto.randomUUID()}`;
  const start = () =>
    runtime.start(ACCOUNT_CORE_DO_SPEC, { persist, vars: deploymentVars(sealingKey, extra), localOrigin: LOCAL_ORIGIN });
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

/** The Node composition of the account pool: the file owner, the same renewal manager and schedule on runtime timeouts. */
function nodePoolCore(dataDirectory: string, executor = fixtureRenewalExecutor()) {
  const wake: OwnerWake = {
    now: () => Date.now(),
    timer: (fire) => boundedWakeTimer(timeoutWakeClock(Date.now), fire),
  };
  const pool = new AccountPoolStore({
    databasePath: join(dataDirectory, "account-pool.sqlite"),
    secretsDirectory: join(dataDirectory, "secrets"),
    now: () => wake.now(),
  });
  return { core: assembleAccountPoolCore({ pool, renew: fetchAccountRenewal(executor), wake }), executor };
}

const HOST_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const FAR = () => Date.now() + 10 * 60 * 60_000;
/** Due for renewal about `ms` from now. */
const dueIn = (ms: number) => Date.now() + ACCOUNT_REFRESH_LEAD_MS + ms;
const poolSecret = (token: string, expiresAt: number | null, refreshToken = `ref-${token}`) => ({
  accessToken: token,
  refreshToken,
  idToken: null,
  expiresAt,
});

type PoolCall = (operation: AccountPoolOperation) => Promise<AccountPoolOperationResult>;

/**
 * The account pool: accounts, selection and affinity (bound, inherited,
 * metadata), quota rotation, authorization errors, ordering, Host tokens,
 * proactive renewal on the owner wake-up (one renewed, one rejected by the
 * executor), on-demand renewal, a restart, and removal.
 */
async function poolSequence(call: PoolCall, restart: () => Promise<void>) {
  const seen: [string, AccountPoolOperationResult][] = [];
  const run = async (label: string, operation: AccountPoolOperation) => {
    const result = await call(operation);
    seen.push([label, result]);
    return result;
  };
  const select = (affinityId: string, extra: Partial<Extract<AccountPoolOperation, { op: "pool.select" }>> = {}) =>
    ({ op: "pool.select", hostId: "host-1", affinityId, ...extra }) as const;
  await run("empty pool", { op: "pool.list" });
  await run("add a", { op: "pool.add", id: "a", priority: 1, secret: poolSecret("tok-a", FAR()) });
  await run("add b", { op: "pool.add", id: "b", priority: 2, secret: poolSecret("tok-b", FAR()) });
  await run("add a again", { op: "pool.add", id: "a", priority: 3, secret: poolSecret("tok-x", null) });
  await run("add invalid id", { op: "pool.add", id: "not an id", priority: 3, secret: poolSecret("tok-x", null) });
  await run("list", { op: "pool.list" });
  await run("first selection", select("t1", { accept: true }));
  await run("bound selection", select("t1"));
  await run("inherited selection", select("t2", { parentAffinityId: "t1", accept: true }));
  await run("metadata selection", select("meta", { purpose: "metadata" }));
  await run("affinity count", { op: "pool.affinityCount" });
  await run("exhaust a", { op: "pool.observeQuota", id: "a", utilization: 1, resetAt: FAR() });
  await run("bound moves off exhausted", select("t1", { accept: true }));
  await run("states", { op: "pool.states" });
  await run("excluded", select("t3", { exclude: ["b"] }));
  await run("reject b", { op: "pool.markRejected", id: "b" });
  await run("none eligible", select("t4"));
  await run("a recovers", { op: "pool.observeQuota", id: "a", utilization: 0.1, resetAt: null });
  await run("selection after recovery", select("t4", { accept: true }));
  await run("disable a", { op: "pool.setEnabled", id: "a", enabled: false });
  await run("nothing enabled and eligible", select("t5"));
  await run("enable a", { op: "pool.setEnabled", id: "a", enabled: true });
  await run("reorder", { op: "pool.reorder", ids: ["b", "a"] });
  await run("reorder incomplete", { op: "pool.reorder", ids: ["b"] });
  await run("list reordered", { op: "pool.list" });
  const issued = await run("host token", { op: "pool.hostToken", hostId: "local-codex" });
  const token = "ok" in issued ? (issued.ok as { token: string }).token : "";
  await run("authenticate host token", { op: "pool.authenticate", token });
  await run("authenticate unknown token", { op: "pool.authenticate", token: "x".repeat(43) });
  await run("add c due soon", { op: "pool.add", id: "c", priority: 3, secret: poolSecret("tok-c", dueIn(1_500)) });
  await run("add d due soon, executor rejects", {
    op: "pool.add",
    id: "d",
    priority: 4,
    secret: poolSecret("tok-d", dueIn(1_500), "revoked-d"),
  });
  await run("renewal due", { op: "pool.renewalDue" });
  // Proactive renewal: nobody asks; the owner wake-up fires and the schedule renews what is due.
  await sleep(4_000);
  await run("c renewed by the schedule", { op: "pool.credential", id: "c" });
  await run("c maintenance", { op: "pool.maintenance", id: "c" });
  await run("d kept after a rejected renewal", { op: "pool.credential", id: "d" });
  await run("d maintenance", { op: "pool.maintenance", id: "d" });
  await run("on-demand renewal of a", { op: "pool.resolve", id: "a", reason: "unauthorized" });
  await run("a renewed", { op: "pool.credential", id: "a" });
  await run("replace b", { op: "pool.replaceCredential", id: "b", secret: poolSecret("tok-b2", FAR()) });
  await run("states before restart", { op: "pool.states" });
  await restart();
  await run("list after restart", { op: "pool.list" });
  await run("c after restart", { op: "pool.credential", id: "c" });
  await run("b after restart", { op: "pool.credential", id: "b" });
  await run("bound after restart", select("t1"));
  await run("host token after restart", { op: "pool.hostToken", hostId: "local-codex" });
  await run("remove b", { op: "pool.remove", id: "b" });
  await run("removed b is gone", { op: "pool.credential", id: "b" });
  await run("t1 moves after removal", select("t1", { accept: true }));
  await run("affinity count after removal", { op: "pool.affinityCount" });
  await run("states after removal", { op: "pool.states" });
  const walk = operationNormalizer();
  const tokens = new Map<string, string>();
  const hostTokens = (value: unknown): unknown => {
    if (typeof value === "string" && HOST_TOKEN.test(value)) {
      if (!tokens.has(value)) tokens.set(value, `<host-token${tokens.size}>`);
      return tokens.get(value);
    }
    if (Array.isArray(value)) return value.map(hostTokens);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hostTokens(item)]));
    return value;
  };
  return seen.map(([label, result]) => ({ label, result: walk(hostTokens(result)) }));
}

async function poolCall(backend: Backend, operation: AccountPoolOperation): Promise<AccountPoolOperationResult> {
  const response = await backend.fetch("/__test/account/pool", { method: "POST", body: JSON.stringify(operation) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as AccountPoolOperationResult;
}

async function sqlCall(backend: Backend, statements: string[]): Promise<Record<string, unknown>[][]> {
  const response = await backend.fetch("/__test/account/sql", { method: "POST", body: JSON.stringify({ statements }) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Record<string, unknown>[][];
}

/** What the provider fixture received for one request. */
interface ProviderHit {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * A provider on this machine's loopback (a configured provider may be loopback HTTP): it records every request
 * and answers with two chunks, sending the second only once `release()` is called, so a reader that sees the
 * first chunk before the release proves the egress streams instead of buffering.
 */
async function providerFixture() {
  const hits: ProviderHit[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    hits.push({
      method: request.method!,
      path: request.url!,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "provider=1" });
    response.write("data: first\n\n");
    // Only a streamed request is held; others answer at once.
    if (request.url?.includes("stream=true")) await released;
    response.end("data: second\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hits,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    release() {
      release();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type WorkspaceHostLeaseOperation =
  | { op: "grant"; holder: { workspace: string; engine: string; incarnation: string }; ttlMs: number }
  | { op: "renew"; id: string; ttlMs: number }
  | { op: "revoke"; id: string }
  | { op: "revokeHolder"; match: { workspace: string; engine?: string; keepIncarnation?: string } };

async function workspaceHostCall(backend: Backend, operation: WorkspaceHostLeaseOperation) {
  const response = await backend.fetch("/__test/workspace-host/leases", {
    method: "POST",
    body: JSON.stringify(operation),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as AccountOperationResult;
}

const GATEWAY = "/__opencraft_model_gateway";
/** Every table of the model gateway's published chain (indexes go with them). */
const GATEWAY_TABLES = [
  "gateway_audit",
  "gateway_contributions",
  "gateway_execution_heads",
  "gateway_execution_turns",
  "gateway_executions",
  "gateway_limits",
  "gateway_personal_limits",
  "gateway_private_threads",
  "gateway_requests",
  "gateway_sponsors",
  "gateway_thread_humans",
  "gateway_thread_models",
];
/** The gateway chain's ledger rows: the Node owner's chain, by the same names. */
const GATEWAY_LEDGER = [
  { schema_id: "model-gateway", version: 1, name: "model-gateway" },
  { schema_id: "model-gateway", version: 2, name: "personal-keys" },
  { schema_id: "model-gateway", version: 3, name: "execution-authority" },
  { schema_id: "model-gateway", version: 4, name: "conversation-model-binding" },
];
/** An administrator-declared service Humans may contribute a key for (no credential of its own). */
const APPROVED = {
  id: "approved",
  name: "Approved service",
  enabled: false,
  protocol: "openai-responses",
  baseUrl: "https://provider.example/v1",
  credentialRef: null,
  models: [{ id: "model", enabled: false }],
};
const CONTRIBUTED_KEY = "sentinel-key";

/** The deployment's gateway file for the Node server; the route exists only when it is named. */
async function withGatewayEnvironment<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = path;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
    else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = previous;
  }
}

/**
 * The model gateway over HTTP: admission, Human identity, administration,
 * limits, conflicts, contributions (consent, approval, scope, withdrawal),
 * revocation and restart. Configuration is seeded beforehand on each side.
 */
async function gatewaySequence(backend: Backend) {
  const observe = normalizer(backend.origin);
  const seen: Awaited<ReturnType<typeof observe>>[] = [];
  const record = async (label: string, response: Promise<Response>) => {
    seen.push(await observe(label, await response));
  };
  const anonymous = new Browser(backend);
  await record("anonymous gateway", anonymous.call(GATEWAY));
  await record("anonymous gateway page", anonymous.call(GATEWAY, undefined, { accept: "text/html" }));
  await record("session bearer gateway", anonymous.call(GATEWAY, undefined, { authorization: "Bearer oc_actor_fixture" }));
  const { owner, member, memberId } = await login(backend);
  const ownerId = (
    (await (await owner.call("/__opencraft_actors/me")).json()) as { actor: { id: string } }
  ).actor.id;
  const limit = { monthlyTokens: 1000, requestTokens: 10, concurrency: 2 };
  await record("owner reads", owner.call(GATEWAY));
  await record("owner configures", owner.call(GATEWAY, { action: "configure", actor: memberId, ...limit, revision: 0 }));
  await record("stale revision", owner.call(GATEWAY, { action: "configure", actor: memberId, ...limit, revision: 0 }));
  await record(
    "invalid limit",
    owner.call(GATEWAY, { action: "configure", actor: memberId, ...limit, concurrency: 0, revision: 1 }),
  );
  await record("extra field", owner.call(GATEWAY, { action: "configure", actor: memberId, ...limit, revision: 1, x: 1 }));
  await record(
    "cross-origin write",
    owner.call(GATEWAY, { action: "configure", actor: ownerId, ...limit, revision: 0 }, { origin: "https://elsewhere.example" }),
  );
  await record("not json", owner.call(GATEWAY, { action: "configure" }, { "content-type": "text/plain" }));
  await record("owner reads member", owner.call(`${GATEWAY}?actor=${encodeURIComponent(memberId)}`));
  await record("member reads", member.call(GATEWAY));
  await record("member reads owner", member.call(`${GATEWAY}?actor=${encodeURIComponent(ownerId)}`));
  await record("member configures", member.call(GATEWAY, { action: "configure", actor: memberId, ...limit, revision: 1 }));
  await record("member personal limit", member.call(GATEWAY, { action: "personalLimit", monthlyTokens: 500, revision: 0 }));
  await record("member subscription", member.call(GATEWAY, { action: "subscription", operation: "start" }));
  const contribution = {
    action: "contribute",
    name: "My key",
    baseUrl: APPROVED.baseUrl,
    protocol: "openai-responses",
    model: "model",
    apiKey: CONTRIBUTED_KEY,
  };
  await record("team without consent", member.call(GATEWAY, { ...contribution, scope: "team" }));
  await record("unapproved endpoint", member.call(GATEWAY, { ...contribution, baseUrl: "https://elsewhere.example/v1" }));
  await record("invalid key", member.call(GATEWAY, { ...contribution, apiKey: "has space" }));
  const created = await member.call(GATEWAY, contribution);
  const { providerId } = (await created.clone().json()) as { providerId: string };
  await record("member contributes", Promise.resolve(created));
  await record("member reads contributions", member.call(GATEWAY));
  await record("owner directory", owner.call(GATEWAY));
  await record(
    "share without consent",
    member.call(GATEWAY, { action: "scope", provider: providerId, scope: "team", revision: 0 }),
  );
  await record(
    "share with team",
    member.call(GATEWAY, { action: "scope", provider: providerId, scope: "team", revision: 0, shareWithTeam: true }),
  );
  await record("owner sees the team key", owner.call(GATEWAY));
  await record("owner withdraws another's key", owner.call(GATEWAY, { action: "withdraw", provider: providerId }));
  await record("member withdraws", member.call(GATEWAY, { action: "withdraw", provider: providerId }));
  await record(
    "reconcile unknown request",
    owner.call(GATEWAY, { action: "reconcile", requestId: "missing", actualTokens: 1, reason: "fixture" }),
  );
  await record(
    "revoke member",
    owner.call("/__opencraft_access/members", { actorId: memberId, role: "member", enabled: false }),
  );
  await record("revoked member reads", member.call(GATEWAY));
  await backend.restart();
  await record("owner reads member after restart", owner.call(`${GATEWAY}?actor=${encodeURIComponent(memberId)}`));
  await record(
    "owner configures after restart",
    owner.call(GATEWAY, { action: "configure", actor: memberId, ...limit, revision: 1 }),
  );
  return seen;
}

/** The test route standing in for the Codex selection egress (not deployed); see account-core-do-worker.ts. */
const SUBSCRIPTION_ROUTE = "https://codex-egress.invalid";

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
    name: "the entry Worker never forwards the internal account authority path, and forwards the model gateway route to the object",
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
        // The model gateway is assembled in the object; without a subscription route it offers none.
        const gateway = await owner.call("/__opencraft_model_gateway");
        assert.equal(gateway.status, 200, await gateway.clone().text());
        assert.equal(((await gateway.json()) as { subscriptionAvailable: boolean }).subscriptionAvailable, false);
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "the account pool in the AccountCore object answers the same selection, affinity, Host token and renewal sequence as the Node file owner, with its credentials sealed",
    async run({ runtime, scratch, diagnostic }) {
      const dataDirectory = join(scratch, `pool-${crypto.randomUUID()}`);
      await mkdir(dataDirectory, { recursive: true });
      let node = nodePoolCore(dataDirectory);
      let nodeRun: Awaited<ReturnType<typeof poolSequence>>;
      try {
        nodeRun = await poolSequence(
          (operation) => runAccountPoolOperation(node.core, operation),
          async () => {
            await node.core.close();
            node = nodePoolCore(dataDirectory);
          },
        );
      } finally {
        await node.core.close();
      }
      const object = await deploymentBackend(runtime);
      try {
        const objectRun = await poolSequence(
          (operation) => poolCall(object, operation),
          () => object.restart(),
        );
        diagnostic(
          objectRun
            .map((step) => `${step.label}: ${"ok" in (step.result as object) ? "ok" : JSON.stringify(step.result)}`)
            .join("; "),
        );
        assert.deepEqual(objectRun, nodeRun);
        // Credentials and Host tokens are sealed in the object's SQL; none appears in plaintext.
        const stored = JSON.stringify(await (await object.fetch("/__test/account/storage")).json());
        assert.doesNotMatch(stored, /tok-[a-d]|ref-tok|revoked-d/u);
        assert.match(stored, /ocr1\.k1\./u);
      } finally {
        await object.close();
      }
      // The sequence exercised what it claims.
      const result = (label: string) => nodeRun!.find((step) => step.label === label)?.result;
      assert.deepEqual(
        [
          "first selection",
          "bound selection",
          "inherited selection",
          "bound moves off exhausted",
          "selection after recovery",
          "bound after restart",
          "t1 moves after removal",
        ].map((label) => (result(label) as { ok: { account: string; keepsAffinity: boolean } }).ok),
        [
          { account: "a", accessToken: "tok-a", keepsAffinity: false, held: false },
          { account: "a", accessToken: "tok-a", keepsAffinity: true, held: false },
          { account: "a", accessToken: "tok-a", keepsAffinity: true, held: false },
          { account: "b", accessToken: "tok-b", keepsAffinity: false, held: false },
          { account: "a", accessToken: "tok-a", keepsAffinity: false, held: false },
          { account: "b", accessToken: "tok-b2", keepsAffinity: true, held: false },
          // Rotation continues after the removed account's position.
          { account: "c", accessToken: "tok-c+r", keepsAffinity: false, held: false },
        ],
      );
      assert.deepEqual(result("none eligible"), { error: "No eligible account" });
      assert.equal((result("c renewed by the schedule") as { ok: { accessToken: string } }).ok.accessToken, "tok-c+r");
      assert.equal((result("c after restart") as { ok: { accessToken: string } }).ok.accessToken, "tok-c+r");
      assert.equal(
        (result("d kept after a rejected renewal") as { ok: { accessToken: string } }).ok.accessToken,
        "tok-d",
      );
      assert.deepEqual(result("d maintenance"), { ok: { state: "error", failure: "authorization-rejected" } });
      assert.equal((result("a renewed") as { ok: { accessToken: string } }).ok.accessToken, "tok-a+r");
      assert.deepEqual(result("authenticate host token"), { ok: "local-codex" });
      assert.deepEqual(result("host token after restart"), result("host token"));
    },
  },
  {
    name: "an evicted AccountCore object renews a due account from its alarm and keeps the pool's affinity",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime);
      try {
        value(await poolCall(object, { op: "pool.add", id: "a", priority: 1, secret: poolSecret("tok-a", FAR()) }));
        value(await poolCall(object, { op: "pool.select", hostId: "h", affinityId: "t", accept: true }));
        value(
          await poolCall(object, { op: "pool.add", id: "c", priority: 2, secret: poolSecret("tok-c", dueIn(2_000)) }),
        );
        // Memory dropped with no event; only the stored alarm can bring the object back before the next request.
        await object.fetch("/__test/account/evict").catch(() => undefined);
        await sleep(4_000);
        // The alarm rebuilt the object, whose schedule re-derived the due renewal from storage.
        assert.deepEqual(await (await object.fetch("/__test/account/renewals")).json(), ["upstream-c"]);
        assert.equal(
          value<{ accessToken: string }>(await poolCall(object, { op: "pool.credential", id: "c" })).accessToken,
          "tok-c+r",
        );
        assert.deepEqual(value(await poolCall(object, { op: "pool.select", hostId: "h", affinityId: "t" })), {
          account: "a",
          accessToken: "tok-a",
          keepsAffinity: true,
          held: false,
        });
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "an AccountCore object from before the account pool gains its chains beside the policy's, and refuses a changed or foreign pool history",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime);
      try {
        const { owner } = await login(object);
        assert.equal(
          (await owner.call(POLICY, { revision: 0, rules: [{ engine: "pi", effort: "high" }] })).status,
          200,
        );
        value(await opCall(object, { op: "config.update", revision: 0, providers: [provider("p1")] }));
        value(await opCall(object, { op: "credentials.set", ref: "P1_KEY", value: PROVIDER_KEY }));
        // The object's storage as the policy-only AccountCore left it: one chain, no pool objects, no schema ledger.
        await sqlCall(object, [
          "DROP TABLE pool_affinity",
          "DROP TABLE pool_active_account",
          "DROP TABLE pool_quota",
          "DROP TABLE pool_accounts",
          "DROP TABLE account_credential_records",
          ...GATEWAY_TABLES.map((table) => `DROP TABLE ${table}`),
          "DROP TABLE schema_ledgers",
        ]);
        const policyLedger = await sqlCall(object, [
          "SELECT version,name,checksum FROM schema_migrations ORDER BY version",
        ]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        // Upgrade: the policy and its ledger are kept; the pool's chains are applied fresh beside them.
        const read = (await (await owner.call(POLICY)).json()) as { revision: number };
        assert.equal(read.revision, 1);
        assert.deepEqual(
          await sqlCall(object, ["SELECT version,name,checksum FROM schema_migrations ORDER BY version"]),
          policyLedger,
        );
        const ledgers = await sqlCall(object, [
          "SELECT schema_id,version,name FROM schema_ledgers ORDER BY schema_id,version",
        ]);
        assert.deepEqual(ledgers[0], [
          { schema_id: "account-credential-records", version: 1, name: "account-credential-records" },
          { schema_id: "account-pool-host", version: 1, name: "account-pool" },
          { schema_id: "account-pool-host", version: 2, name: "codex-reset-credit-count" },
          { schema_id: "account-pool-host", version: 3, name: "codex-account-credit-policy" },
          { schema_id: "account-pool-host", version: 4, name: "codex-account-human-owner" },
          ...GATEWAY_LEDGER,
        ]);
        value(await poolCall(object, { op: "pool.add", id: "a", priority: 1, secret: poolSecret("tok-a", FAR()) }));
        const lease = value<{ token: string }>(
          await opCall(object, { op: "leases.grant", holder: holder("i1"), ttlMs: 60_000 }),
        );
        assert.equal(
          value<{ credential: string }>(
            await opCall(object, { op: "leases.redeem", token: lease.token, providerId: "p1" }),
          ).credential,
          PROVIDER_KEY,
        );
        // A changed checksum in the pool's chain refuses the open; the original history opens again.
        const [[original]] = await sqlCall(object, [
          "SELECT checksum FROM schema_ledgers WHERE schema_id='account-pool-host' AND version=1",
        ]);
        await sqlCall(object, [
          "UPDATE schema_ledgers SET checksum='0' WHERE schema_id='account-pool-host' AND version=1",
        ]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        assert.equal((await owner.call(POLICY)).status, 503);
        await sqlCall(object, [
          `UPDATE schema_ledgers SET checksum='${String(original!.checksum)}' WHERE schema_id='account-pool-host' AND version=1`,
        ]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        assert.equal((await owner.call(POLICY)).status, 200);
        // Pool objects without the pool's ledger are a foreign history: refused, never adopted.
        await sqlCall(object, ["DELETE FROM schema_ledgers WHERE schema_id='account-credential-records'"]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        assert.equal((await owner.call(POLICY)).status, 503);
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "a workspace's owner grants a lease over the exchange; the egress redeems it, streams the request to the provider with the credential and refuses once the lease is revoked or expired",
    async run({ runtime, diagnostic }) {
      // The provider is on this machine's loopback, which a deployed Worker cannot reach.
      if (runtime.kind !== "miniflare") return diagnostic("skipped: needs a loopback provider");
      const upstream = await providerFixture();
      const object = await deploymentBackend(runtime);
      try {
        value(
          await opCall(object, {
            op: "config.update",
            revision: 0,
            providers: [
              provider("openai", { baseUrl: upstream.baseUrl, credentialRef: "OPENAI_KEY" }),
              provider("anthropic", {
                protocol: "anthropic-messages",
                baseUrl: upstream.baseUrl,
                credentialRef: "ANTHROPIC_KEY",
              }),
            ],
          }),
        );
        value(await opCall(object, { op: "credentials.set", ref: "OPENAI_KEY", value: PROVIDER_KEY }));
        value(await opCall(object, { op: "credentials.set", ref: "ANTHROPIC_KEY", value: ROTATED_KEY }));
        // The workspace's owner, as a bound caller of the exchange.
        const lease = value<{ id: string; token: string }>(
          await workspaceHostCall(object, { op: "grant", holder: holder("i1"), ttlMs: 60_000 }),
        );
        assert.deepEqual(await workspaceHostCall(object, { op: "grant", holder: holder("i1"), ttlMs: 5 }), {
          error: "invalid_lease_request",
        });
        value(await workspaceHostCall(object, { op: "renew", id: lease.id, ttlMs: 60_000 }));
        const egress = (path: string, init: RequestInit = {}) => object.fetch(`/__opencraft_egress/${path}`, init);

        // OpenAI protocol: the lease token in Authorization; the provider sees only the credential.
        const response = await egress("openai/responses?stream=true", {
          method: "POST",
          headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json", cookie: "session=x" },
          body: JSON.stringify({ model: "m", input: "hello" }),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "text/event-stream");
        assert.equal(response.headers.get("set-cookie"), null);
        // Streaming: the first event arrives while the provider still holds the second.
        const reader = response.body!.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), "data: first\n\n");
        upstream.release();
        let rest = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
          rest += new TextDecoder().decode(chunk.value);
        assert.equal(rest, "data: second\n\n");
        const openaiHit = upstream.hits.at(-1)!;
        assert.deepEqual(
          [openaiHit.method, openaiHit.path, openaiHit.headers.authorization, openaiHit.headers.cookie, openaiHit.body],
          [
            "POST",
            "/v1/responses?stream=true",
            `Bearer ${PROVIDER_KEY}`,
            undefined,
            JSON.stringify({ model: "m", input: "hello" }),
          ],
        );
        assert.ok(!JSON.stringify(openaiHit.headers).includes(lease.token));

        // Anthropic protocol: the lease token where the SDK puts its key; the provider gets x-api-key.
        const anthropic = await egress("anthropic/messages", {
          method: "POST",
          headers: { "x-api-key": lease.token, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(anthropic.status, 200);
        await anthropic.text();
        const anthropicHit = upstream.hits.at(-1)!;
        assert.deepEqual(
          [
            anthropicHit.path,
            anthropicHit.headers["x-api-key"],
            anthropicHit.headers.authorization,
            anthropicHit.headers["anthropic-version"],
          ],
          ["/v1/messages", ROTATED_KEY, undefined, "2023-06-01"],
        );

        // Refusals reach no provider.
        const before = upstream.hits.length;
        const refused = async (path: string, init: RequestInit, status: number, error: string) => {
          const reply = await egress(path, init);
          assert.equal(reply.status, status, path);
          assert.deepEqual(await reply.json(), { error });
        };
        const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
        await refused("openai/responses", {}, 401, "lease_required");
        await refused("openai/responses", bearer(`oc_lease_${"C".repeat(43)}`), 401, "lease_invalid");
        await refused("unknown/responses", bearer(lease.token), 404, "provider_unavailable");
        await refused("openai/%2e%2e/admin", bearer(lease.token), 404, "provider_unavailable");
        // Revoked by the workspace's owner (a new incarnation replaced the container): refused at once.
        assert.deepEqual(
          await workspaceHostCall(object, {
            op: "revokeHolder",
            match: { workspace: "default", keepIncarnation: "i2" },
          }),
          { ok: 1 },
        );
        await refused("openai/responses", bearer(lease.token), 401, "lease_invalid");
        // Expired: a short lease is refused once its time has passed.
        const short = value<{ id: string; token: string }>(
          await workspaceHostCall(object, { op: "grant", holder: holder("i2"), ttlMs: 1_000 }),
        );
        await sleep(1_300);
        await refused("openai/responses", bearer(short.token), 401, "lease_invalid");
        // A single revocation.
        const third = value<{ id: string; token: string }>(
          await workspaceHostCall(object, { op: "grant", holder: holder("i2"), ttlMs: 60_000 }),
        );
        assert.deepEqual(await workspaceHostCall(object, { op: "revoke", id: third.id }), { ok: true });
        await refused("openai/responses", bearer(third.token), 401, "lease_invalid");
        assert.equal(upstream.hits.length, before);

        // Neither the exchange nor the egress is on the public entry.
        for (const path of [
          "/__opencraft_internal/credential-leases/redeem",
          "/__opencraft_internal/credential-leases/holder",
        ]) {
          const reply = await object.fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: lease.token, providerId: "openai" }),
          });
          assert.equal(reply.status, 404, path);
        }
        // The object stores no lease token or credential in plaintext; the egress has no storage at all.
        const stored = JSON.stringify(await (await object.fetch("/__test/account/storage")).json());
        for (const secret of [lease.token, short.token, third.token, PROVIDER_KEY, ROTATED_KEY])
          assert.ok(!stored.includes(secret));
      } finally {
        await object.close();
        upstream.release();
        await upstream.close();
      }
    },
  },
  {
    name: "the AccountCore object, behind the entry and the InstallationCore gate, answers the model gateway sequence as the Node Headless server does",
    async run({ runtime, scratch, diagnostic }) {
      const gatewayFile = join(scratch, `gateway-${crypto.randomUUID()}.sqlite`);
      const nodeRun = await withGatewayEnvironment(gatewayFile, async () => {
        const node = await nodeBackend(scratch, async (dataDirectory) => {
          const models = join(dataDirectory, "models");
          await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
          await mkdir(models, { recursive: true, mode: 0o700 });
          await new ModelConfigurationRepository(fileStateDocumentStore(models)).update(0, (draft) => {
            draft.providers = [APPROVED] as typeof draft.providers;
          });
        });
        try {
          return await gatewaySequence(node);
        } finally {
          await node.close();
        }
      });
      const object = await deploymentBackend(runtime);
      try {
        value(await opCall(object, { op: "config.update", revision: 0, providers: [APPROVED] }));
        const objectRun = await gatewaySequence(object);
        diagnostic(objectRun.map((step) => `${step.label}: ${step.status}`).join("; "));
        assert.deepEqual(objectRun, nodeRun);
        // The contributed key is a sealed credential: nowhere in the object's storage in plaintext.
        const stored = JSON.stringify(await (await object.fetch("/__test/account/storage")).json());
        assert.doesNotMatch(stored, new RegExp(CONTRIBUTED_KEY, "u"));
      } finally {
        await object.close();
      }
      // The comparison exercised what it claims.
      const status = (label: string) => nodeRun.find((step) => step.label === label)?.status;
      assert.deepEqual(
        [
          "anonymous gateway",
          "session bearer gateway",
          "owner reads",
          "owner configures",
          "stale revision",
          "cross-origin write",
          "member reads owner",
          "member configures",
          "member subscription",
          "unapproved endpoint",
          "member contributes",
          "share with team",
          "owner withdraws another's key",
          "member withdraws",
          "revoked member reads",
          "owner configures after restart",
        ].map(status),
        [401, 403, 200, 200, 409, 403, 403, 403, 403, 403, 200, 200, 403, 200, 403, 200],
      );
      const restarted = nodeRun.find((step) => step.label === "owner reads member after restart")!.body as {
        limit: { revision: number };
        contributions: { state: string; scope: string }[];
      };
      assert.equal(restarted.limit.revision, 1);
      assert.deepEqual(
        restarted.contributions.map(({ state, scope }) => ({ state, scope })),
        [{ state: "withdrawn", scope: "team" }],
      );
    },
  },
  {
    name: "a Human's personal subscription is served by the account pool in the same AccountCore object, and survives eviction",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime, SEALING_KEY, { OPENCRAFT_TEST_SUBSCRIPTION_ROUTE: SUBSCRIPTION_ROUTE });
      try {
        const { owner } = await login(object);
        const ownerId = ((await (await owner.call("/__opencraft_actors/me")).json()) as { actor: { id: string } }).actor
          .id;
        const namespace = createHash("sha256").update(ownerId).digest("hex");
        const personal = async (body: Record<string, unknown>) => {
          const response = await object.fetch("/__test/account/personal", {
            method: "POST",
            body: JSON.stringify({ actor: ownerId, ...body }),
          });
          assert.equal(response.status, 200, await response.clone().text());
          return response.json() as Promise<Record<string, unknown>>;
        };
        const read = async () => (await (await owner.call(GATEWAY)).json()) as {
          subscriptionAvailable: boolean;
          contributions: { provider: string; state: string; scope: string }[];
        };
        assert.equal((await read()).subscriptionAvailable, true);
        // No account of this Human in the pool: device login is not in this object, so starting is unavailable.
        const unavailable = await owner.call(GATEWAY, { action: "subscription", operation: "start" });
        assert.deepEqual({ status: unavailable.status, body: await unavailable.json() }, {
          status: 503,
          body: { error: "gateway_unavailable" },
        });
        assert.deepEqual(await personal({ op: "add" }), { personal: 1, installation: 0 });
        const started = await owner.call(GATEWAY, { action: "subscription", operation: "start" });
        assert.equal(started.status, 200, await started.clone().text());
        assert.deepEqual(await started.json(), {
          status: "complete",
          providerId: `subscription-${namespace}`,
          scope: "personal",
          kind: "subscription",
        });
        const recorded = (await read()).contributions.map(({ provider, state, scope }) => ({ provider, state, scope }));
        assert.deepEqual(recorded, [{ provider: `subscription-${namespace}`, state: "shared", scope: "personal" }]);
        const configuration = value<{ providers: { id: string; baseUrl: string; catalogId: string }[] }>(
          await opCall(object, { op: "config.read" }),
        );
        assert.deepEqual(
          configuration.providers.map(({ id, baseUrl, catalogId }) => ({ id, baseUrl, catalogId })),
          [
            {
              id: `subscription-${namespace}`,
              baseUrl: `${SUBSCRIPTION_ROUTE}/personal/${namespace}/v1`,
              catalogId: "opencraft-human-subscription",
            },
          ],
        );
        // The connection's credential (stored under the provider's reference) is a Host token of this Human's pool in
        // the same object. Human providers are never leased to engines, so the test reads it in the object.
        const ref = `GATEWAY_SUBSCRIPTION_${namespace.toUpperCase()}`;
        const { host, credential } = (await personal({ op: "authenticate", ref })) as { host: string; credential: string };
        assert.match(credential, HOST_TOKEN);
        assert.equal(host, `personal-subscription:${namespace}`);
        const stored = JSON.stringify(await (await object.fetch("/__test/account/storage")).json());
        assert.doesNotMatch(stored, new RegExp(credential, "u"));
        const cancelled = await owner.call(GATEWAY, { action: "subscription", operation: "cancel", sessionId: "none" });
        assert.deepEqual(await cancelled.json(), { cancelled: false });
        // Eviction: the contribution, the configuration and the pool come back from storage; polling completes again.
        await object.fetch("/__test/account/evict").catch(() => undefined);
        assert.deepEqual(
          (await read()).contributions.map(({ provider, state }) => ({ provider, state })),
          [{ provider: `subscription-${namespace}`, state: "shared" }],
        );
        const polled = await owner.call(GATEWAY, { action: "subscription", operation: "poll", sessionId: "none" });
        assert.equal(polled.status, 200, await polled.clone().text());
        assert.equal(((await polled.json()) as { status: string }).status, "complete");
        assert.deepEqual(await personal({ op: "authenticate", ref }), { host, credential });
      } finally {
        await object.close();
      }
    },
  },
  {
    name: "an AccountCore object from before the model gateway gains its chain, keeps the others, and refuses gateway objects without the chain's ledger",
    async run({ runtime }) {
      const object = await deploymentBackend(runtime);
      try {
        const { owner } = await login(object);
        assert.equal((await owner.call(POLICY, { revision: 0, rules: [{ engine: "pi", effort: "high" }] })).status, 200);
        value(await poolCall(object, { op: "pool.add", id: "a", priority: 1, secret: poolSecret("tok-a", FAR()) }));
        const others = "SELECT schema_id,version,name,checksum FROM schema_ledgers WHERE schema_id<>'model-gateway' ORDER BY schema_id,version";
        const [before] = await sqlCall(object, [others]);
        // The object's storage as the second part left it: no gateway objects and no gateway chain.
        await sqlCall(object, [
          ...GATEWAY_TABLES.map((table) => `DROP TABLE ${table}`),
          "DELETE FROM schema_ledgers WHERE schema_id='model-gateway'",
        ]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        const reread = (await (await owner.call(GATEWAY)).json()) as { canManage: boolean };
        assert.equal(reread.canManage, true);
        const [after, gatewayChain] = await sqlCall(object, [
          others,
          "SELECT schema_id,version,name FROM schema_ledgers WHERE schema_id='model-gateway' ORDER BY version",
        ]);
        assert.deepEqual(after, before);
        assert.deepEqual(gatewayChain, GATEWAY_LEDGER);
        assert.equal(((await (await owner.call(POLICY)).json()) as { revision: number }).revision, 1);
        // Gateway objects without the gateway chain's ledger are a foreign history: refused, never adopted.
        await sqlCall(object, ["DELETE FROM schema_ledgers WHERE schema_id='model-gateway'"]);
        await object.fetch("/__test/account/evict").catch(() => undefined);
        assert.equal((await owner.call(GATEWAY)).status, 503);
      } finally {
        await object.close();
      }
    },
  },
];
