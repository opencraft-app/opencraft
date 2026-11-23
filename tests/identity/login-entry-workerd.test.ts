// Login entry prototype for the Cloudflare InstallationCore, in workerd
// (Miniflare, nodejs_compat, no Cloudflare account). Proves that
//  - local-account Argon2id PHC records made by Node (native node:crypto)
//    verify in workerd (portable pure-JS @noble/hashes) and the other way
//    round, and reports the per-verify time and the hasher's bundle size;
//  - a fetch-based login entry over a Durable Object SQL Server core runs the
//    real HumanAuth routes, LocalAccountServerPlugin verification,
//    HumanAccounts token issue and InstanceAccess authenticate path, and
//    answers the same statuses, error codes and cookie shape as the Node
//    node:http entry for the same request sequence.
// See docs/architecture/platform/gateway-split.md ("登录入口原型结果").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { InstanceAccess, MembershipStore, type MemberRole } from "@opencraft/access-control";
import type { LocalAccountRecord } from "@opencraft/identity-core/local-account";
import { LocalAccountServerPlugin } from "@opencraft/plugin-local-account/server";
import { createNodePasswordHasher } from "@opencraft/plugin-local-account/password-hash-node";
import { parseArgon2id } from "@opencraft/plugin-local-account/password-hash";

const COMPATIBILITY_DATE = "2026-07-30";
const WORKER_ORIGIN = "http://login.test";
const PASSWORD = "fixture-passphrase-only";
let directory: string;
let script: string;
let hasherBytes = 0;
let sequence = 0;
const closers: (() => Promise<void> | void)[] = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "login-entry-workerd-"));
  const outfile = join(directory, "worker.mjs");
  await build({
    entryPoints: [resolve(import.meta.dirname, "workerd/login-entry-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    mainFields: ["module", "main"],
    conditions: ["workerd", "worker", "import"],
    // node:crypto (randomUUID, randomBytes, createHash) and the node:fs imports of
    // identity-core/node come from nodejs_compat; Argon2id is bundled pure JS.
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
    metafile: true,
  }).then((result) => {
    for (const [path, output] of Object.entries(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]!]!.inputs))
      if (/@noble[/\\]hashes|password-hash/u.test(path)) hasherBytes += output.bytesInOutput;
  });
  script = await readFile(outfile, "utf8");
});
after(async () => {
  for (const close of closers.reverse()) await close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

interface Exchange {
  readonly status: number;
  readonly body: unknown;
  readonly cookies: string[];
}
interface Controls {
  createAccount(username: string, password: string): Promise<{ subject: string; ms: number }>;
  insertAccount(record: LocalAccountRecord): Promise<void>;
  account(username: string): Promise<LocalAccountRecord | null>;
  verify(username: string, password: string): Promise<{ subject: string | null; ms: number }>;
  hashOnly?(password: string): Promise<{ record: string; ms: number }>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
  grant(subject: string, role: MemberRole): Promise<void>;
  advance(milliseconds: number): Promise<void>;
}
interface Entry {
  readonly origin: string;
  request(path: string, init?: { body?: unknown; cookie?: string; headers?: Record<string, string> }): Promise<Exchange>;
  readonly controls: Controls;
}

async function exchange(response: Response): Promise<Exchange> {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookies: response.headers.getSetCookie() };
}
function init(origin: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): RequestInit {
  return {
    redirect: "manual",
    headers: {
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.body === undefined ? {} : { origin, "content-type": "application/json" }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { method: "POST", body: JSON.stringify(options.body) }),
  };
}

function workerdEntry(): Entry {
  const miniflare = new Miniflare({
    modules: [{ type: "ESModule", path: "worker.mjs", contents: script }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CORE: { className: "LoginCore", useSQLite: true } },
    bindings: { ORIGIN: WORKER_ORIGIN },
  });
  closers.push(() => miniflare.dispose());
  const object = `login-${++sequence}`;
  const call = async (method: string, ...args: unknown[]) => {
    const response = await miniflare.dispatchFetch(`${WORKER_ORIGIN}/__test`, {
      method: "POST",
      headers: { "x-test-object": object },
      body: JSON.stringify({ method, args }),
    });
    const outcome = (await response.json()) as { ok: boolean; value?: unknown; error?: string };
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value as never;
  };
  return {
    origin: WORKER_ORIGIN,
    async request(path, options = {}) {
      const request = init(WORKER_ORIGIN, options);
      const response = await miniflare.dispatchFetch(WORKER_ORIGIN + path, {
        ...request,
        headers: { ...(request.headers as Record<string, string>), "x-test-object": object },
      } as never);
      return exchange(response as unknown as Response);
    },
    controls: {
      createAccount: (username, password) => call("createAccount", username, password),
      insertAccount: (record) => call("insertAccount", record),
      account: (username) => call("account", username),
      verify: (username, password) => call("verify", username, password),
      hashOnly: (password) => call("hashOnly", password),
      setEnabled: (username, enabled) => call("setEnabled", username, enabled),
      grant: (subject, role) => call("grant", subject, role),
      advance: (milliseconds) => call("advance", milliseconds),
    },
  };
}

/** The same graph and the same two routes on node:sqlite and a real node:http server. */
async function nodeEntry(): Promise<Entry> {
  const handle = await openServerDatabase(await mkdtemp(join(directory, "node-")));
  let skew = 0;
  const now = () => Date.now() + skew;
  const actors = new ActorStore(handle, now);
  const accounts = new HumanAccounts(handle, actors, now);
  const local = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher(), now);
  accounts.registerLocalAccounts(local);
  const members = new MembershipStore(handle);
  const configuration = { origin: "http://127.0.0.1", local: true, oidc: [] };
  const auth = new HumanAuth(accounts, actors, configuration, () => "<!doctype html>", () => null, now);
  const access = new InstanceAccess(members, [auth], actors);
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    if (request.url === "/api/me") {
      const status = access.admissionStatus(request);
      const principal = access.authenticate(request);
      const actor = principal ? actors.findHuman(principal) : null;
      response.writeHead(status === 204 ? 200 : status, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          status === 204 ? { actorId: actor?.id ?? null, provider: principal!.provider, subject: principal!.subject } : { error: status },
        ),
      );
      return;
    }
    if (!(await auth.handle(request, response))) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  (configuration as { origin: string }).origin = origin;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    auth.close();
    members.close();
    accounts.close();
    actors.close();
    await handle.close();
  });
  return {
    origin,
    request: async (path, options) => exchange(await fetch(origin + path, init(origin, options))),
    controls: {
      async createAccount(username, password) {
        const started = performance.now();
        const principal = await local.create(username, username, password);
        return { subject: principal.subject, ms: performance.now() - started };
      },
      async insertAccount(record) {
        accounts.localAccountRepository.insert(record);
      },
      async account(username) {
        return accounts.localAccountRepository.byUsername(username);
      },
      async verify(username, password) {
        const started = performance.now();
        const principal = await local.verify(username, password);
        return { subject: principal?.subject ?? null, ms: performance.now() - started };
      },
      async setEnabled(username, enabled) {
        local.setEnabled(username, enabled);
      },
      async grant(subject, role) {
        members.setActor(actors.findHuman({ provider: "local", subject })!.id, role, true, "local-operator");
      },
      async advance(milliseconds) {
        skew += milliseconds;
      },
    },
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test("Argon2id records made by Node verify in workerd and the other way round", async (t) => {
  const worker = workerdEntry();
  const node = await nodeEntry();

  const fromNode = await node.controls.createAccount("node-made", PASSWORD);
  const nodeRecord = (await node.controls.account("node-made"))!;
  await worker.controls.insertAccount(nodeRecord);
  assert.equal((await worker.controls.verify("node-made", PASSWORD)).subject, fromNode.subject);
  assert.equal((await worker.controls.verify("node-made", PASSWORD + "x")).subject, null);

  const fromWorker = await worker.controls.createAccount("workerd-made", PASSWORD);
  const workerRecord = (await worker.controls.account("workerd-made"))!;
  // PHC string in password_digest, empty salt column; parameters travel with the record.
  assert.equal(workerRecord.salt, "");
  assert.match(workerRecord.passwordDigest, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/u);
  assert.equal(parseArgon2id(workerRecord.passwordDigest)?.salt.length, 16);
  await node.controls.insertAccount(workerRecord);
  assert.equal((await node.controls.verify("workerd-made", PASSWORD)).subject, fromWorker.subject);
  assert.equal((await node.controls.verify("workerd-made", "wrong-passphrase-value")).subject, null);
  assert.equal((await worker.controls.account("workerd-made"))!.passwordDigest, workerRecord.passwordDigest, "current parameters are never rehashed");

  // Cloudflare installations are fresh: the portable hasher refuses a pre-Argon2id scrypt record.
  await worker.controls.insertAccount({ ...nodeRecord, id: "00000000-0000-4000-8000-000000000001", username: "scrypt-made",
    salt: "a".repeat(64), passwordDigest: "b".repeat(64) });
  await assert.rejects(worker.controls.verify("scrypt-made", PASSWORD), /Legacy password record unsupported/u);

  const timings = { workerd: [] as number[], workerdUnknown: [] as number[], workerdOuter: [] as number[], workerdHash: [] as number[], node: [] as number[] };
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    timings.workerd.push((await worker.controls.verify("node-made", PASSWORD)).ms);
    timings.workerdOuter.push(performance.now() - started);
    timings.workerdUnknown.push((await worker.controls.verify("nobody-here", PASSWORD)).ms);
    timings.workerdHash.push((await worker.controls.hashOnly!(PASSWORD)).ms);
    timings.node.push((await node.controls.verify("node-made", PASSWORD)).ms);
  }
  t.diagnostic(
    `Argon2id m=19456,t=2,p=1 per-verify median ms: workerd ${median(timings.workerd).toFixed(0)} (outer ${median(timings.workerdOuter).toFixed(0)}, ` +
      `unknown user ${median(timings.workerdUnknown).toFixed(0)}, hash ${median(timings.workerdHash).toFixed(0)}), node ${median(timings.node).toFixed(0)}; ` +
      `portable hasher bundle ${hasherBytes} bytes`,
  );
  // Selection rule: the pure-JS hasher must stay within 1 s per verify (coarse local guard, not a benchmark).
  assert.ok(median(timings.workerd) < 1_000);
});

/** One browser's request sequence; returns every response for comparison. */
async function scenario(entry: Entry) {
  const steps: Record<string, Exchange> = {};
  const step = async (label: string, path: string, options?: Parameters<Entry["request"]>[1]) =>
    (steps[label] = await entry.request(path, options));
  const login = (password = PASSWORD, extra: Record<string, unknown> = {}) => ({
    body: { mode: "login", username: "Alice", password, ...extra },
  });
  const session = (exchange: Exchange) => exchange.cookies.find((cookie) => cookie.startsWith("oc_human="))!.split(";")[0]!;

  const { subject } = await entry.controls.createAccount("alice", PASSWORD);
  await step("anonymous", "/api/me");
  await step("wrong password", "/__opencraft_auth/local", login("wrong-passphrase-value"));
  await step("unknown user", "/__opencraft_auth/local", { body: { mode: "login", username: "mallory", password: PASSWORD } });
  await step("cross origin", "/__opencraft_auth/local", { ...login(), headers: { origin: "https://evil.example" } });
  await step("form post", "/__opencraft_auth/local", { ...login(), headers: { "content-type": "text/plain" } });
  await step("bearer header", "/__opencraft_auth/local", { ...login(), headers: { authorization: "Bearer x" } });
  await step("extra field", "/__opencraft_auth/local", login(PASSWORD, { remember: true }));
  const first = session(await step("login", "/__opencraft_auth/local", login()));
  await step("authenticated, not a member", "/api/me", { cookie: first });
  await entry.controls.grant(subject, "member");
  await step("member", "/api/me", { cookie: first });
  await step("session view", "/__opencraft_auth/session", { cookie: first });
  await step("tampered token", "/api/me", { cookie: first.slice(0, -1) + (first.endsWith("A") ? "B" : "A") });
  await step("logout", "/__opencraft_auth/logout", { body: {}, cookie: first });
  await step("revoked session", "/api/me", { cookie: first });

  const second = session(await step("login again", "/__opencraft_auth/local", login()));
  await entry.controls.setEnabled("alice", false);
  await step("disabled account session", "/api/me", { cookie: second });
  await step("disabled account login", "/__opencraft_auth/local", login());
  await entry.controls.setEnabled("alice", true);
  await step("session from before disable stays revoked", "/api/me", { cookie: second });

  const third = session(await step("login after enable", "/__opencraft_auth/local", login()));
  await step("fresh session", "/api/me", { cookie: third });
  await entry.controls.advance(8 * 3600_000 + 1_000);
  await step("expired session", "/api/me", { cookie: third });
  return steps;
}

/** Stable placeholders for random ids/tokens and the issue-time Max-Age. */
function normalize(steps: Record<string, Exchange>) {
  const ids = new Map<string, string>();
  return JSON.parse(
    JSON.stringify(steps)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
        if (!ids.has(uuid)) ids.set(uuid, `<uuid-${ids.size}>`);
        return ids.get(uuid)!;
      })
      .replace(/oc_human=[A-Za-z0-9_-]{43};/g, "oc_human=<token>;")
      .replace(/Max-Age=(28[0-9]{3})/g, "Max-Age=<8h>"),
  );
}

test("fetch login entry on Durable Object SQL answers like the Node HTTP entry", async () => {
  const workerd = normalize(await scenario(workerdEntry()));
  const node = normalize(await scenario(await nodeEntry()));
  assert.deepEqual(workerd, node);

  const expect = (label: string, status: number, body?: unknown) => {
    assert.equal(workerd[label].status, status, label);
    if (body !== undefined) assert.deepEqual(workerd[label].body, body, label);
  };
  expect("anonymous", 401, { error: 401 });
  expect("wrong password", 401, { error: "invalid_credentials" });
  expect("unknown user", 401, { error: "invalid_credentials" });
  expect("cross origin", 403, { error: "same_origin_json_required" });
  expect("form post", 403, { error: "same_origin_json_required" });
  expect("bearer header", 403, { error: "origin_required" });
  expect("extra field", 400, { error: "login_failed" });
  expect("login", 200, { ok: true });
  assert.deepEqual(workerd.login.cookies, [
    "oc_human=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<8h>",
    "oc_human_flow=; Path=/__opencraft_auth; HttpOnly; SameSite=Lax; Max-Age=0",
  ]);
  expect("authenticated, not a member", 403, { error: 403 });
  expect("member", 200);
  assert.match((workerd.member.body as { actorId: string }).actorId, /^human:\/\/<uuid-\d+>\/<uuid-\d+>$/u);
  assert.equal((workerd.member.body as { provider: string }).provider, "local");
  expect("tampered token", 401);
  expect("logout", 200, { ok: true });
  expect("revoked session", 401);
  expect("disabled account session", 401);
  expect("disabled account login", 401, { error: "invalid_credentials" });
  expect("session from before disable stays revoked", 401);
  expect("fresh session", 200);
  expect("expired session", 401);
});
