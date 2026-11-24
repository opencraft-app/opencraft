import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_ATTEMPT_LIMITS,
  loginAccountKeys,
  loginRequestKeys,
  memoryLoginAttemptLimiter,
  normalizeLoginIdentifier,
  stateLoginAttemptLimiter,
  type LoginAttemptLimiter,
} from "@opencraft/identity-core/login-attempts";
import type { HttpExchangeRequest } from "@opencraft/identity-core/http-exchange";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import { ActorStore } from "../../packages/access-control/src/actors";
import { HumanAccounts } from "../../packages/access-control/src/human-accounts";
import { HumanAuth } from "../../packages/access-control/src/human-auth";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node";
import type { PasswordHasher } from "../../plugins/local-account/src/password-hash";

const PASSWORD = "attempt-fixture-passphrase";
const ORIGIN = "http://login.test";

const adapters: [string, () => LoginAttemptLimiter][] = [
  ["memory", () => memoryLoginAttemptLimiter()],
  ["state document", () => stateLoginAttemptLimiter(memoryStateDocumentStore())],
];

for (const [name, create] of adapters) {
  test(`${name} limiter: per-key budgets, ordered counting, window expiry and key ceiling`, async () => {
    const limiter = create();
    const a = loginRequestKeys("auth", "192.0.2.1"),
      b = loginRequestKeys("auth", "192.0.2.2");
    for (let n = 0; n < LOGIN_ATTEMPT_LIMITS.address; n++) assert.equal(await limiter.take(a, 0), true);
    assert.equal(await limiter.take(a, 1), false, "the address is over its budget");
    assert.equal(await limiter.take(b, 1), true, "another address keeps its own budget");
    assert.equal(await limiter.take(a, 60_000), true, "a new window admits again");

    const global = create();
    for (let n = 0; n < LOGIN_ATTEMPT_LIMITS.global; n++)
      assert.equal(await global.take(loginRequestKeys("auth", `198.51.100.${n}`), 0), true);
    assert.equal(
      await global.take(loginRequestKeys("auth", "203.0.113.9"), 0),
      false,
      "the global ceiling covers every address",
    );
    assert.equal(await global.take(loginRequestKeys("account", "203.0.113.9"), 0), true, "scopes count separately");

    const accounts = create();
    for (let n = 0; n < LOGIN_ATTEMPT_LIMITS.account; n++)
      assert.equal(await accounts.take(loginAccountKeys("auth", n % 2 ? "Alice" : " alice "), 0), true);
    assert.equal(await accounts.take(loginAccountKeys("auth", "ALICE"), 0), false, "one budget per normalized name");
    assert.equal(await accounts.take(loginAccountKeys("auth", "bob"), 0), true);

    const small =
      name === "memory"
        ? memoryLoginAttemptLimiter({ maxKeys: 2 })
        : stateLoginAttemptLimiter(memoryStateDocumentStore(), { maxKeys: 2 });
    assert.equal(
      await small.take(
        [
          { key: "x", limit: 5 },
          { key: "y", limit: 5 },
        ],
        0,
      ),
      true,
    );
    assert.equal(await small.take([{ key: "z", limit: 5 }], 0), false, "a new key is refused while the ledger is full");
    assert.equal(await small.take([{ key: "z", limit: 5 }], 60_000), true, "expired keys make room");
  });
}

test("normalized identifiers ignore case and surrounding space; oversized or non-string values share one bucket", () => {
  assert.equal(normalizeLoginIdentifier(" Alice "), "alice");
  assert.equal(normalizeLoginIdentifier("x".repeat(257)), "");
  assert.equal(normalizeLoginIdentifier(42), "");
});

test("the durable ledger stores digests only, is atomic per take and starts fresh from an unrecognized document", async () => {
  const store = memoryStateDocumentStore();
  const limiter = stateLoginAttemptLimiter(store);
  const keys = [...loginRequestKeys("auth", "192.0.2.77"), ...loginAccountKeys("auth", "alice")];
  await Promise.all(Array.from({ length: 20 }, () => limiter.take(keys, 0)));
  const document = (await store.read("login-attempts")) as { v: number; entries: [string, number, number][] };
  assert.equal(document.v, 1);
  assert.doesNotMatch(JSON.stringify(document), /192\.0\.2\.77|alice/u);
  assert.deepEqual(
    document.entries.map((entry) => entry[2]).sort((x, y) => x - y),
    [12, 20, 20],
    "concurrent takes are serialized; the account key is not counted once the address is refused",
  );
  await store.update("login-attempts", () => ({ result: null, next: { v: 9 } }));
  assert.equal(await limiter.take(keys, 0), true);
});

async function loginFixture(t: test.TestContext, limiter?: LoginAttemptLimiter) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-login-attempts-"));
  const actors = new ActorStore(join(directory, "actors.sqlite"));
  const accounts = new HumanAccounts(join(directory, "human-logins.sqlite"), actors);
  const native = createNodePasswordHasher();
  let derivations = 0;
  const hasher: PasswordHasher = {
    hash: (password) => (derivations++, native.hash(password)),
    verify: (password, record) => (derivations++, native.verify(password, record)),
  };
  const local = new LocalAccountServerPlugin(accounts.localAccountRepository, hasher);
  accounts.registerLocalAccounts(local);
  const auth = new HumanAuth(accounts, actors, { origin: ORIGIN, local: true, oidc: [] }, () => "");
  if (limiter) auth.useAttemptLimiter(limiter);
  t.after(async () => {
    auth.close();
    accounts.close();
    actors.close();
    await rm(directory, { recursive: true, force: true });
  });
  await local.create("alice", "alice", PASSWORD);
  derivations = 0;
  const login = async (
    username: string,
    address: string | null = "192.0.2.10",
    password = "wrong-passphrase-value",
  ) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ mode: "login", username, password }));
    const request: HttpExchangeRequest = {
      method: "POST",
      path: "/__opencraft_auth/local",
      rawHeaders: [],
      clientAddress: address,
      signal: new AbortController().signal,
      identity: { headers: {} },
      headers: { host: "login.test", origin: ORIGIN, "content-type": "application/json" },
      readBody: async () => bytes,
    };
    const response = (await auth.handle(request))!;
    return {
      status: response.status,
      body: JSON.parse(String(response.body)),
      retryAfter: response.headers.find(([key]) => key === "retry-after")?.[1],
    };
  };
  return { login, derivations: () => derivations };
}

test("no Argon2id derivation runs once a budget is spent; known and unknown names are refused alike", async (t) => {
  const f = await loginFixture(t);
  for (let n = 0; n < LOGIN_ATTEMPT_LIMITS.address; n++)
    assert.equal((await f.login(n % 2 ? "alice" : "nobody")).status, 401);
  assert.equal(f.derivations(), 12, "unknown names pay one derivation like known ones");
  const known = await f.login("alice"),
    unknown = await f.login("nobody");
  assert.deepEqual(known, { status: 429, body: { error: "try_later" }, retryAfter: "60" });
  assert.deepEqual(unknown, known, "a refusal does not reveal whether the account exists");
  assert.equal(f.derivations(), 12);

  // The per-name budget holds across addresses: alice took 6 above.
  for (let n = 0; n < 6; n++) assert.equal((await f.login("Alice", `198.51.100.${n}`)).status, 401);
  assert.deepEqual(await f.login("alice", "198.51.100.99"), known);
  for (let n = 0; n < 6; n++) assert.equal((await f.login("nobody", `198.51.100.${n}`)).status, 401);
  assert.deepEqual(await f.login("nobody", "198.51.100.98"), known);
  assert.equal(f.derivations(), 24);
});

test("the global ceiling bounds derivations across many addresses and names", async (t) => {
  const f = await loginFixture(t);
  for (let n = 0; n < LOGIN_ATTEMPT_LIMITS.global; n++)
    assert.equal((await f.login(`user-${n}`, `198.51.100.${n}`)).status, 401);
  assert.equal((await f.login("alice", "203.0.113.1", PASSWORD)).status, 429);
  assert.equal(f.derivations(), LOGIN_ATTEMPT_LIMITS.global);
});

test("a ledger that cannot count refuses before deriving", async (t) => {
  const f = await loginFixture(t, {
    take: async () => {
      throw new Error("storage unavailable");
    },
  });
  assert.equal((await f.login("alice", null, PASSWORD)).status, 429);
  assert.equal(f.derivations(), 0);
});

test("a shared durable ledger bounds two login entries (isolates) together", async (t) => {
  const store = memoryStateDocumentStore();
  const first = await loginFixture(t, stateLoginAttemptLimiter(store));
  const second = await loginFixture(t, stateLoginAttemptLimiter(store));
  for (let n = 0; n < 6; n++) {
    assert.equal((await first.login("nobody")).status, 401);
    assert.equal((await second.login("nobody")).status, 401);
  }
  assert.equal((await second.login("alice")).status, 429);
  assert.equal((await first.login("alice")).status, 429);
  assert.equal(first.derivations() + second.derivations(), 12);
});
