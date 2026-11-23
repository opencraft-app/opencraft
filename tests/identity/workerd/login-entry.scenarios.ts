// Login entry scenarios for the Cloudflare InstallationCore (Miniflare via
// tests/identity/login-entry-workerd.test.ts and the real-Cloudflare rehearsal,
// scripts/cloudflare/rehearsal.ts). Proves that
//  - local-account Argon2id PHC records made by Node (native node:crypto)
//    verify in workerd (portable pure-JS @noble/hashes) and the other way
//    round, and reports the per-verify time and the hasher's bundle size;
//  - a fetch-based login entry over a Durable Object SQL Server core runs the
//    real HumanAuth routes, LocalAccountServerPlugin verification,
//    HumanAccounts token issue and InstanceAccess authenticate path, and
//    answers the same statuses, error codes and cookie shape as the Node
//    node:http entry for the same request sequence. Both entries run the same
//    HumanAuth.handle on the HTTP exchange port: Fetch adapter in workerd,
//    node:http adapter in Node.
// See docs/architecture/platform/gateway-split.md ("登录入口原型结果").
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAuth } from "@opencraft/access-control/human-auth";
import { InstanceAccess, MembershipStore, type MemberRole } from "@opencraft/access-control";
import type { LocalAccountRecord } from "@opencraft/identity-core/local-account";
import { LocalAccountServerPlugin } from "@opencraft/plugin-local-account/server";
import { serveNodeHttpExchange } from "@opencraft/identity-core/http-exchange-node";
import { createNodePasswordHasher } from "@opencraft/plugin-local-account/password-hash-node";
import { parseArgon2id } from "@opencraft/plugin-local-account/password-hash";
import type { WorkerRuntime, WorkerScenario, WorkerSpec } from "../../cloudflare/worker-runtime.ts";

export const LOGIN_ENTRY_WORKER: WorkerSpec = {
  id: "login",
  entry: resolve(import.meta.dirname, "login-entry-worker.ts"),
  // node:crypto (randomUUID, randomBytes, createHash) and the node:fs imports of
  // identity-core/node come from nodejs_compat; Argon2id is bundled pure JS.
  compatibilityFlags: ["nodejs_compat"],
  externalNode: true,
  durableObjects: { CORE: "LoginCore" },
};

const LOCAL_ORIGIN = "http://login.test";
const PASSWORD = "fixture-passphrase-only";
let sequence = 0;
type Closers = (() => Promise<void> | void)[];

/** Bytes of the portable Argon2id hasher (@noble/hashes and password-hash) in the bundle the runtime runs. */
async function hasherBytes(runtime: WorkerRuntime): Promise<number> {
  const { metafile } = await runtime.bundle(LOGIN_ENTRY_WORKER);
  let bytes = 0;
  for (const [path, output] of Object.entries(Object.values(metafile.outputs)[0]!.inputs))
    if (/@noble[/\\]hashes|password-hash/u.test(path)) bytes += output.bytesInOutput;
  return bytes;
}

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

async function workerdEntry(runtime: WorkerRuntime): Promise<Entry> {
  // One instance per entry, as before; each also uses its own object.
  const instance = await runtime.start(LOGIN_ENTRY_WORKER, { localOrigin: LOCAL_ORIGIN, vars: (origin) => ({ ORIGIN: origin }) });
  const ORIGIN = instance.origin;
  const object = `login-${++sequence}`;
  const call = async (method: string, ...args: unknown[]) => {
    const response = await instance.fetch(`${ORIGIN}/__test`, {
      method: "POST",
      headers: { "x-test-object": object },
      body: JSON.stringify({ method, args }),
    });
    const text = await response.text();
    let outcome: { ok: boolean; value?: unknown; error?: string };
    try { outcome = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`); }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value as never;
  };
  return {
    origin: ORIGIN,
    async request(path, options = {}) {
      const request = init(ORIGIN, options);
      const response = await instance.fetch(ORIGIN + path, {
        ...request,
        headers: { ...(request.headers as Record<string, string>), "x-test-object": object },
      });
      return exchange(response);
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
async function nodeEntry(scratch: string, closers: Closers): Promise<Entry> {
  const handle = await openServerDatabase(await mkdtemp(join(scratch, "node-")));
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
    if (!(await serveNodeHttpExchange(request, response, (exchange) => auth.handle(exchange)))) {
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

/**
 * HumanAuth marks its cookies Secure exactly when its origin is https: a
 * deployed worker is, the Node entry (and Miniflare) are not. Checks that rule
 * per cookie, then drops the attribute so both entries compare.
 */
function secureFollowsOrigin(steps: Record<string, Exchange>, origin: string): Record<string, Exchange> {
  const secure = origin.startsWith("https:");
  return Object.fromEntries(Object.entries(steps).map(([label, exchange]) => [label, {
    ...exchange,
    cookies: exchange.cookies.map((cookie) => {
      assert.equal(cookie.endsWith("; Secure"), secure, `${label}: ${cookie} on ${secure ? "an https" : "a plain http"} origin`);
      return secure ? cookie.slice(0, -"; Secure".length) : cookie;
    }),
  }]));
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

export const LOGIN_ENTRY_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "Argon2id records made by Node verify in workerd and the other way round",
    async run({ runtime, scratch, diagnostic }) {
      const closers: Closers = [];
      try {
        const worker = await workerdEntry(runtime);
        const node = await nodeEntry(scratch, closers);

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
        diagnostic(
          `${runtime.label}: Argon2id m=19456,t=2,p=1 per-verify median ms: workerd in-isolate clock ${median(timings.workerd).toFixed(0)} (outer ${median(timings.workerdOuter).toFixed(0)}, ` +
            `unknown user ${median(timings.workerdUnknown).toFixed(0)}, hash ${median(timings.workerdHash).toFixed(0)}), node ${median(timings.node).toFixed(0)}; ` +
            `portable hasher bundle ${await hasherBytes(runtime)} bytes. On Cloudflare the in-isolate clock does not advance during CPU work, so only the outer round trip (network included) is a wall-clock figure`,
        );
        // Selection rule: the pure-JS hasher must stay within 1 s per verify (coarse local guard, not a benchmark).
        assert.ok(median(timings.workerd) < 1_000);
      } finally {
        for (const close of closers.reverse()) await close();
      }
    },
  },
  {
    name: "fetch login entry on Durable Object SQL answers like the Node HTTP entry",
    async run({ runtime, scratch }) {
      const closers: Closers = [];
      let workerd: ReturnType<typeof normalize>, node: ReturnType<typeof normalize>;
      try {
        const worker = await workerdEntry(runtime);
        workerd = normalize(secureFollowsOrigin(await scenario(worker), worker.origin));
        const local = await nodeEntry(scratch, closers);
        node = normalize(secureFollowsOrigin(await scenario(local), local.origin));
      } finally {
        for (const close of closers.reverse()) await close();
      }
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
    },
  },
];
