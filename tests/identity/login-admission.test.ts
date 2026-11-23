import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InstanceAccess, MembershipStore } from "../../packages/access-control/src/index";
import { parsePrincipal, type Principal } from "../../packages/identity-core/src/index";
import type { HttpExchangeRequest } from "../../packages/identity-core/src/http-exchange";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index";
import {
  LOGIN_ADMISSION_PATH,
  parseLoginAdmissionRules,
  type LoginAdmissionRules,
} from "../../plugins/login-admission/src/contract";
import { globMatches } from "../../plugins/login-admission/src/rules";
import { RulesEvaluator, runAdmitFunction } from "../../plugins/login-admission/src/evaluate";
import { LoginAdmissionPolicy } from "../../plugins/login-admission/src/server";
import { LoginAdmissionStore } from "../../plugins/login-admission/src/store";
import { LOGIN_ADMISSION_MIGRATIONS } from "../../plugins/login-admission/src/migrations";
import { identitiesFromLogins, rulesFromModeDocument } from "../../plugins/login-admission/src/adoption";

const PROVIDER = "corp";
const rules = (patch: Partial<LoginAdmissionRules> = {}): LoginAdmissionRules => ({
  enabled: true,
  allowlist: [],
  patterns: [],
  conditions: [],
  admitFunction: null,
  ...patch,
});
const principal = (provider: string, subject: string, attributes: Record<string, string> = {}): Principal =>
  parsePrincipal({ provider, subject, displayName: subject, expiresAt: Date.now() + 600_000, attributes });

async function fixture(
  t: test.TestContext,
  options: { workerEntry?: URL; functionInput?: (identity: never) => unknown } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "login-admission-"));
  const path = join(root, "login-admission.sqlite");
  const membership = new MembershipStore(":memory:");
  const opened: LoginAdmissionPolicy[] = [];
  const open = async () => {
    const policy = await LoginAdmissionPolicy.open({
      provider: PROVIDER,
      attribute: "login",
      path,
      ...(options as object),
    });
    opened.push(policy);
    return policy;
  };
  const policy = await open();
  // Every principal is in one request; tests swap `current` to act as someone else.
  let current: Principal | null = null;
  const access = new InstanceAccess(membership, [{ authenticate: () => current }], undefined, [PROVIDER], policy);
  const admin = principal("local", "root");
  membership.set(admin, "admin", true, "fixture");
  t.after(async () => {
    for (const item of opened) await item.close();
    membership.close();
    await rm(root, { recursive: true, force: true });
  });
  const exchange = (
    as: Principal | null,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    current = as;
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const request: HttpExchangeRequest = {
      method,
      path: LOGIN_ADMISSION_PATH,
      rawHeaders: [],
      clientAddress: null,
      signal: new AbortController().signal,
      identity: { headers: {} },
      headers: {
        host: "hub.test",
        ...(body === undefined ? {} : { origin: "https://hub.test", "content-type": "application/json" }),
        ...headers,
      },
      readBody: async () => bytes,
    };
    return access.handle(request).then((response) => {
      assert.ok(response);
      return { status: response.status, body: JSON.parse(String(response.body)) };
    });
  };
  const login = async (who: Principal) => {
    current = who;
    await access.prepare({ headers: {} });
    return access.role(who);
  };
  return { path, root, policy, access, admin, membership, exchange, login, open };
}

test("rules are validated, normalized and matched without backtracking blowup", () => {
  const parsed = parseLoginAdmissionRules({
    enabled: true,
    allowlist: [" Alice ", "alice", "BOB"],
    patterns: ["*.research"],
    conditions: [{ attribute: "department", equals: "Lab" }],
    admitFunction: null,
  });
  assert.deepEqual(parsed.allowlist, ["Alice", "BOB"]);
  for (const invalid of [
    {},
    { ...parsed, extra: 1 },
    { ...parsed, enabled: "yes" },
    { ...parsed, allowlist: ["a\u0000"] },
    { ...parsed, conditions: [{ attribute: "1x", equals: "v" }] },
    { ...parsed, allowlist: Array.from({ length: 10_001 }, (_, index) => "user" + index) },
    { ...parsed, admitFunction: "x".repeat(15_001) },
  ]) {
    assert.throws(() => parseLoginAdmissionRules(invalid), /invalid_policy/);
  }
  assert.equal(globMatches([..."a?c*"], [..."abcdef"]), true);
  assert.equal(globMatches([..."a?c"], [..."abcd"]), false);
  const started = performance.now();
  assert.equal(globMatches([...("*a".repeat(120) + "b")], [..."a".repeat(256)]), false);
  assert.ok(performance.now() - started < 200, "pathological globs stay linear-time bounded");
});

test("admits by allowlist, pattern and condition and refuses everyone else of the provider", async (t) => {
  const { policy, exchange, admin, login } = await fixture(t);
  assert.equal(policy.rules.enabled, false, "a fresh scope admits as before");
  assert.equal(await login(principal(PROVIDER, "1", { login: "anyone" })), "member");
  const published = await exchange(admin, "POST", {
    action: "publish",
    revision: 0,
    rules: rules({
      allowlist: ["Alice"],
      patterns: ["*.research"],
      conditions: [{ attribute: "department", equals: "lab" }],
    }),
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.revision, 1);
  assert.equal(await login(principal(PROVIDER, "2", { login: "alice" })), "member");
  assert.equal(await login(principal(PROVIDER, "3", { login: "carol.research" })), "member");
  assert.equal(await login(principal(PROVIDER, "4", { login: "dave", department: "LAB" })), "member");
  assert.equal(await login(principal(PROVIDER, "5", { login: "mallory" })), null);
  assert.equal(
    await login(principal(PROVIDER, "6", { department: "lab" })),
    null,
    "a login without the scope attribute is refused",
  );
  assert.equal(
    await login(principal(PROVIDER, "1", { login: "anyone" })),
    null,
    "the new policy applies to earlier logins",
  );
  assert.equal(policy.allowsBinding({ provider: PROVIDER, subject: "2" }), true);
  assert.equal(policy.allowsBinding({ provider: PROVIDER, subject: "5" }), false);
  assert.equal(
    policy.allowsBinding({ provider: "other", subject: "5" }),
    true,
    "other providers are outside the policy",
  );
  assert.equal(policy.allows(principal("other", "x")), true);
});

test("the admission function decides only in the sandbox and failures refuse", async (t) => {
  const { exchange, admin, login } = await fixture(t);
  const source = `function admit(input) { if (input.identity.value === "boom") throw Error("x"); return { allow: input.identity.attributes.level === "7" }; }`;
  assert.equal(
    (await exchange(admin, "POST", { action: "publish", revision: 0, rules: rules({ admitFunction: source }) })).status,
    200,
  );
  assert.equal(await login(principal(PROVIDER, "7", { login: "seven", level: "7" })), "member");
  assert.equal(await login(principal(PROVIDER, "8", { login: "eight", level: "8" })), null);
  assert.equal(
    await login(principal(PROVIDER, "9", { login: "boom", level: "7" })),
    null,
    "a throwing function refuses (fails closed)",
  );
  const preview = await exchange(admin, "POST", {
    action: "preview",
    rules: rules({ admitFunction: source }),
    identity: { value: "boom" },
  });
  assert.deepEqual(preview.body, { allow: false, match: null, failed: true });
  assert.equal(
    (
      await exchange(admin, "POST", {
        action: "publish",
        revision: 1,
        rules: rules({ admitFunction: "function admit( {" }),
      })
    ).body.error,
    "invalid_policy",
  );
});

test("sandbox limits: no require, no host objects, bounded time and memory, strict result", async () => {
  const input = { identity: { provider: PROVIDER, subject: "s", value: "v", attributes: {} } };
  for (const source of [
    "function admit() { return { allow: typeof require === 'function' && !!require('node:fs') }; }",
    "function admit() { return { allow: typeof process !== 'undefined' || typeof globalThis.fetch !== 'undefined' || typeof setTimeout !== 'undefined' }; }",
  ])
    assert.equal(await runAdmitFunction(source, input), false, source);
  await assert.rejects(runAdmitFunction("function admit() { return { allow: require('node:fs') !== null }; }", input));
  const started = Date.now();
  await assert.rejects(runAdmitFunction("function admit() { for (;;) {} }", input));
  assert.ok(Date.now() - started < 3500, "an endless loop is interrupted");
  await assert.rejects(
    runAdmitFunction("function admit() { const a = []; for (;;) a.push('x'.repeat(1 << 20)); }", input),
  );
  for (const result of ["true", "{ allow: 'yes' }", "{ allow: true, extra: 1 }", "Promise.resolve({ allow: true })"]) {
    await assert.rejects(runAdmitFunction(`function admit() { return ${result}; }`, input), result);
  }
  await assert.rejects(
    runAdmitFunction("function admit(input) { input.identity.value = 'x'; return { allow: true }; }", input),
    "input is frozen in strict mode",
  );
  const evaluator = new RulesEvaluator(
    rules({
      allowlist: ["a"],
      admitFunction:
        "function admit(input) { if (input.identity.value === 'c') for (;;) {} return { allow: input.identity.value === 'b' }; }",
    }),
    "login",
    (identity) => ({ identity: { value: identity.attributes.login } }),
  );
  const results = await evaluator.evaluateAll(
    ["a", "b", "x"].map((login) => ({ provider: PROVIDER, subject: login, attributes: { login } })),
  );
  assert.deepEqual(
    results.map((result) => [result.allow, result.match]),
    [
      [true, "allowlist"],
      [true, "function"],
      [false, null],
    ],
  );
  const stuck = await evaluator.evaluateAll(
    ["b", "c"].map((login) => ({ provider: PROVIDER, subject: login, attributes: { login } })),
  );
  assert.deepEqual(
    stuck.map((result) => [result.allow, result.failed]),
    [
      [false, true],
      [false, true],
    ],
    "an interrupted batch refuses only its own entries",
  );
});

test("writes are compare-and-set, administrator-only, same-origin and audited", async (t) => {
  const { exchange, admin, login, membership } = await fixture(t);
  const member = principal(PROVIDER, "m", { login: "member" });
  await login(member);
  assert.equal((await exchange(member, "GET")).status, 403);
  assert.equal(
    (await exchange(member, "POST", { action: "publish", revision: 0, rules: rules() })).body.error,
    "administrator_required",
  );
  assert.equal((await exchange(null, "GET")).status, 403);
  assert.equal(
    (await exchange(admin, "POST", { action: "publish", revision: 0, rules: rules() }, { origin: "https://evil.test" }))
      .body.error,
    "same_origin_json_required",
  );
  const first = await exchange(admin, "POST", {
    action: "publish",
    revision: 0,
    rules: rules({ allowlist: ["member"] }),
  });
  assert.equal(first.status, 200);
  const stale = await exchange(admin, "POST", {
    action: "publish",
    revision: 0,
    rules: rules({ allowlist: ["someone"] }),
  });
  assert.deepEqual([stale.status, stale.body.error], [409, "revision_conflict"]);
  assert.equal(
    (await exchange(admin, "POST", { action: "publish", revision: 1, rules: rules({ enabled: false }) })).body.revision,
    2,
  );
  const document = (await exchange(admin, "GET")).body;
  assert.equal(document.revision, 2);
  assert.deepEqual(
    document.versions.map((version: { revision: number }) => version.revision),
    [2, 1],
  );
  assert.deepEqual(
    document.audit.map((entry: { revision: number; action: string; operator: string }) => [
      entry.revision,
      entry.action,
      entry.operator,
    ]),
    [
      [2, "publish", '["local","root"]'],
      [1, "publish", '["local","root"]'],
    ],
  );
  // A revoked administrator is refused even with a request in flight.
  membership.set(admin, "admin", false, "fixture");
  assert.equal((await exchange(admin, "POST", { action: "publish", revision: 2, rules: rules() })).status, 403);
});

test("publishing cannot refuse the publishing administrator's own sign-in", async (t) => {
  const { exchange, membership, login } = await fixture(t);
  const corpAdmin = principal(PROVIDER, "a", { login: "boss" });
  membership.set(corpAdmin, "admin", true, "fixture");
  assert.equal(await login(corpAdmin), "admin");
  const locked = await exchange(corpAdmin, "POST", {
    action: "publish",
    revision: 0,
    rules: rules({ allowlist: ["someone"] }),
  });
  assert.deepEqual([locked.status, locked.body.error], [409, "cannot_remove_own_administration"]);
  assert.equal(
    (await exchange(corpAdmin, "POST", { action: "publish", revision: 0, rules: rules({ allowlist: ["boss"] }) }))
      .status,
    200,
  );
  assert.equal(await login(corpAdmin), "admin");
});

test("decisions survive a restart for durable work without a live login", async (t) => {
  const { exchange, admin, login, open, policy } = await fixture(t);
  await login(principal(PROVIDER, "k", { login: "kept" }));
  await login(principal(PROVIDER, "g", { login: "gone" }));
  await exchange(admin, "POST", { action: "publish", revision: 0, rules: rules({ allowlist: ["kept"] }) });
  await policy.close();
  const reopened = await open();
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.allowsBinding({ provider: PROVIDER, subject: "k" }), true);
  assert.equal(reopened.allowsBinding({ provider: PROVIDER, subject: "g" }), false);
  assert.equal(
    reopened.allowsBinding({ provider: PROVIDER, subject: "never-seen" }),
    false,
    "unknown identities wait for a verified login",
  );
});

test("fails closed when the storage Worker is lost", async (t) => {
  const { policy, exchange, admin, login } = await fixture(t, {
    workerEntry: new URL("../fixtures/login-admission/crashing.worker.ts", import.meta.url),
  });
  assert.equal(
    await login(principal(PROVIDER, "c", { login: "crash" })),
    null,
    "recording an identity crashes the fixture Worker",
  );
  for (let attempt = 0; attempt < 50 && !policy.unavailable; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(policy.unavailable);
  assert.equal(policy.allows(principal(PROVIDER, "c", { login: "crash" })), false);
  assert.equal(policy.allowsBinding({ provider: PROVIDER, subject: "c" }), false);
  assert.equal(policy.allows(principal("other", "o")), true);
  assert.equal((await exchange(admin, "GET")).status, 503);
});

test("adoption imports an earlier policy store once and never overrides a published document", async (t) => {
  const { policy, exchange, admin, login } = await fixture(t);
  assert.deepEqual(rulesFromModeDocument({ mode: "inherit" }, "names").enabled, false);
  assert.deepEqual(rulesFromModeDocument({ mode: "allowlist", names: ["A", "b"] }, "names").allowlist, ["A", "b"]);
  assert.equal(
    rulesFromModeDocument({ mode: "javascript", source: "function admit(){return {allow:true}}" }, "names")
      .admitFunction,
    "function admit(){return {allow:true}}",
  );
  assert.throws(() => rulesFromModeDocument({ mode: "other" }, "names"));
  const identities = identitiesFromLogins(PROVIDER, "login", [
    { subject: "old", value: "veteran" },
    { subject: "out", value: "outsider" },
  ]);
  assert.deepEqual(
    await policy.adopt({
      source: "earlier-store",
      rules: rulesFromModeDocument({ mode: "allowlist", names: ["veteran"] }, "names"),
      identities,
    }),
    { imported: true, applied: true },
  );
  assert.equal(policy.revision, 1);
  assert.equal(
    policy.allowsBinding({ provider: PROVIDER, subject: "old" }),
    true,
    "adopted identities keep durable decisions",
  );
  assert.equal(policy.allowsBinding({ provider: PROVIDER, subject: "out" }), false);
  assert.equal(await login(principal(PROVIDER, "old", { login: "veteran", extra: "x" })), "member");
  assert.deepEqual(await policy.adopt({ source: "earlier-store", rules: rules({ enabled: false }) }), {
    imported: false,
    applied: false,
  });
  assert.equal(
    (await exchange(admin, "POST", { action: "publish", revision: 1, rules: rules({ allowlist: ["veteran", "new"] }) }))
      .status,
    200,
  );
  assert.deepEqual(await policy.adopt({ source: "second-store", rules: rules({ enabled: false }) }), {
    imported: true,
    applied: false,
  });
  assert.equal(policy.rules.enabled, true);
  const audit = (await exchange(admin, "GET")).body.audit;
  assert.deepEqual(
    audit.map((entry: { action: string; operator: string }) => [entry.action, entry.operator]),
    [
      ["publish", '["local","root"]'],
      ["import", "adoption:earlier-store"],
    ],
  );
});

test("the store reopens with its data, upgrades through appended migrations and refuses a changed ledger", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "login-admission-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "login-admission.sqlite");
  const first = new LoginAdmissionStore(path);
  assert.equal(first.outcome.status, "fresh");
  assert.equal(first.publish("scope", 0, JSON.stringify(rules()), "op", 1, "{}"), 1);
  first.recordIdentity("scope", "subject", '{"login":"x"}', 2);
  first.close();
  const again = new LoginAdmissionStore(path);
  assert.equal(again.outcome.status, "up-to-date");
  assert.equal(again.load("scope").revision, 1);
  assert.deepEqual(again.load("scope").identities, [{ subject: "subject", attributes: '{"login":"x"}' }]);
  again.close();
  // The next published version appends N+1 to this owner's list and keeps every row.
  const next = [
    ...LOGIN_ADMISSION_MIGRATIONS,
    { version: 2, name: "synthetic-next", sql: "ALTER TABLE login_admission_identities ADD COLUMN note TEXT;" },
  ];
  const upgraded = openManagedDatabase({ path, migrations: next });
  assert.equal(upgraded.outcome.status, "migrated");
  assert.equal(
    upgraded.database.prepare("SELECT attributes FROM login_admission_identities").get()?.attributes,
    '{"login":"x"}',
  );
  assert.equal(upgraded.database.prepare("SELECT revision FROM login_admission_policies").get()?.revision, 1);
  upgraded.database.close();
  const tampered = join(root, "tampered.sqlite");
  new LoginAdmissionStore(tampered).close();
  const raw = new DatabaseSync(tampered);
  raw.prepare("UPDATE schema_migrations SET checksum='0000' WHERE version=1").run();
  raw.close();
  assert.throws(() => new LoginAdmissionStore(tampered));
});
