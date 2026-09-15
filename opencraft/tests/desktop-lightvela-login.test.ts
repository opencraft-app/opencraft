import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopLightVelaLogin, forwardLoginCallback, NATIVE_CALLBACK, parseLoginCallback, type DesktopLoginSession } from "../apps/workbench-electron/src/lightvela-login";
import { createDesktopSessionStore } from "../apps/workbench-electron/src/lightvela-session-store";
import { createFilePrivateStorage } from "../apps/workbench-electron/src/private-storage";
import { requestDesktopAccount, validateDesktopAccountRequest } from "../apps/workbench-electron/src/lightvela-account-http";

async function fixture(overrides: Partial<ConstructorParameters<typeof DesktopLightVelaLogin>[0]> = {}) {
  const opened: URL[] = [];
  const saved: DesktopLoginSession[] = [];
  let exchanges = 0;
  const login = new DesktopLightVelaLogin({
    openExternal: async raw => { opened.push(new URL(raw)); },
    saveSession: session => { saved.push(session); }, onSuccess: () => {},
    fetchImpl: async (url, init) => {
      exchanges++;
      const body = JSON.parse(init!.body as string);
      const authorize = opened.at(-1)!;
      assert.equal(new URL(String(url)).origin, authorize.origin);
      assert.equal(body.client_id, "opencraft-native-v1");
      assert.equal(body.redirect_uri, NATIVE_CALLBACK);
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), authorize.searchParams.get("code_challenge"));
      return Response.json({ session_token: "test-desktop-session" });
    }, ...overrides,
  });
  const ready = async () => {
    for (let i = 0; i < 100 && !opened.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(opened.length);
  };
  const callback = () => `${NATIVE_CALLBACK}?state=${opened.at(-1)!.searchParams.get("state")}&code=${"a".repeat(43)}`;
  return { login, opened, saved, ready, callback, exchanges: () => exchanges };
}

test("both regions open a system-browser native PKCE request and exchange only once", async () => {
  for (const region of ["cn", "intl"] as const) {
    const f = await fixture();
    const pending = f.login.start(region);
    assert.equal(f.login.start(region), pending);
    await f.ready();
    assert.equal(f.opened[0].origin, region === "cn" ? "https://api.lightvela.com" : "https://api.lightvela.ai");
    assert.equal(f.opened[0].searchParams.get("redirect_uri"), NATIVE_CALLBACK);
    assert.equal(f.login.receive(f.callback()), true);
    assert.equal(f.login.receive(f.callback()), false);
    const result = await pending;
    assert.equal(result?.region, region);
    assert.equal(f.saved.length, 1);
    assert.equal(f.exchanges(), 1);
    assert.equal(f.login.receive(f.callback()), false);
  }
});

test("callback received by another profile is forwarded to the owning transaction", async () => {
  const f = await fixture();
  const result = f.login.start("intl"); await f.ready();
  assert.equal(await forwardLoginCallback(f.callback()), true);
  assert.ok(await result);
  assert.equal(await forwardLoginCallback(f.callback()), false);
  assert.equal(f.exchanges(), 1);
});

test("malformed and uncorrelated callbacks do not consume a pending login", async () => {
  const f = await fixture();
  const pending = f.login.start("cn"); await f.ready();
  for (const raw of [
    f.callback().replace("opencraft:", "https:"), f.callback() + "#fragment",
    f.callback() + "&state=" + "b".repeat(43), f.callback() + "&token=bad",
    f.callback().replace("auth/lightvela", "evil/lightvela"), f.callback().replace("code=", "code=x"),
    `${NATIVE_CALLBACK}?state=${"z".repeat(43)}&code=${"a".repeat(43)}`,
  ]) assert.equal(f.login.receive(raw), false);
  assert.equal(f.exchanges(), 0);
  f.login.cancel(); assert.equal(await pending, null);
});

test("cancel retires the broker and permits a fresh request", async () => {
  const f = await fixture();
  const pending = f.login.start("intl"); await f.ready();
  const old = f.callback(); f.login.cancel();
  assert.equal(await pending, null);
  const next = f.login.start("cn");
  assert.equal(f.login.receive(old), false);
  f.login.cancel(); assert.equal(await next, null);
  assert.equal(f.saved.length, 0);
});

test("browser-open errors and timeout are retryable", async () => {
  const failed = await fixture({ openExternal: async () => { throw new Error("cannot launch"); } });
  await assert.rejects(failed.login.start("intl"), /Could not open your system browser/);
  await assert.rejects(failed.login.start("cn"), /Could not open your system browser/);
  const expired = await fixture({ timeoutMs: 10 });
  await assert.rejects(expired.login.start("cn"), /timed out/);
});

test("server errors do not save sessions, and cancellation fences an in-flight exchange", async () => {
  const failed = await fixture({ fetchImpl: async () => new Response("", { status: 400 }) });
  const pending = failed.login.start("intl"); await failed.ready();
  failed.login.receive(failed.callback());
  await assert.rejects(pending, /exchange failed/);
  assert.equal(failed.saved.length, 0);
  let release!: (response: Response) => void;
  const f = await fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const result = f.login.start("cn"); await f.ready(); f.login.receive(f.callback());
  f.login.cancel(); release(Response.json({ session_token: "late-test-session" }));
  assert.equal(await result, null);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(f.saved.length, 0);
});

test("application-owned private files restore sessions with restrictive permissions", async () => {
  const path = mkdtempSync(join(tmpdir(), "oc-session-test-"));
  try {
    const store = createDesktopSessionStore(path);
    const value: DesktopLoginSession = { region: "cn", token: "test-private-file-session" };
    await store.save(value);
    assert.deepEqual(await createDesktopSessionStore(path).read(), value);
    const directory = join(path, "private-storage"), file = join(directory, "lightvela-account.json");
    // This product choice is permission-protected plaintext, not pretend encryption.
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, session: value });
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    await store.save({ region: "intl", token: "replacement-test-session" });
    assert.equal((await createDesktopSessionStore(path).read())?.region, "intl");
    assert.deepEqual(readdirSync(directory), ["lightvela-account.json"]);
    store.clear(); assert.equal(await store.read(), null);
    assert.equal(await createDesktopSessionStore(path).read(), null);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("native callback persists both regions, restores through a fresh store and clears on logout", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-login-persistence-"));
  try {
    for (const region of ["cn", "intl"] as const) {
      const directory = join(root, region);
      const store = createDesktopSessionStore(directory);
      let successes = 0;
      const f = await fixture({ saveSession: (value, signal) => store.save(value, signal), onSuccess: () => { successes++; } });
      try {
        const pending = f.login.start(region); await f.ready();
        assert.equal(f.login.receive(f.callback()), true);
        const accepted = await pending;
        const restarted = createDesktopSessionStore(directory);
        const restored = await restarted.read();
        assert.deepEqual(restored, accepted); assert.equal(restored?.region, region); assert.equal(successes, 1);
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
          import { createDesktopSessionStore } from ${JSON.stringify(new URL("../apps/workbench-electron/src/lightvela-session-store.ts", import.meta.url).href)};
          const session = await createDesktopSessionStore(process.argv[1]).read();
          console.log(JSON.stringify({ hasSession: !!session, region: session?.region }));
        `, directory], { encoding: "utf8" });
        assert.equal(child.status, 0, "Fresh process must restore the private session");
        assert.deepEqual(JSON.parse(child.stdout.trim()), { hasSession: true, region });
        assert.equal(await createDesktopSessionStore(join(root, `${region}-other-profile`)).read(), null);
        const response = await requestDesktopAccount({ url: `https://api.lightvela.${region === "cn" ? "com" : "ai"}/auth/profile`, method: "GET" }, restored!, async (_url, init) => {
          assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${restored!.token}`);
          return Response.json({ user: { id: "synthetic-user" } });
        });
        assert.equal(response.status, 200);
        restarted.clear(); assert.equal(await createDesktopSessionStore(directory).read(), null);
      } finally { f.login.cancel(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a storage failure does not announce successful login or disclose the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-login-storage-failure-"));
  let successes = 0;
  const store = createDesktopSessionStore(root, { read: () => null, remove: () => {}, write: (_key, value) => { throw new Error(value); } });
  const f = await fixture({ saveSession: (value, signal) => store.save(value, signal), onSuccess: () => { successes++; } });
  try {
    const pending = f.login.start("intl"); await f.ready(); f.login.receive(f.callback());
    await assert.rejects(pending, (error: Error) => {
      assert.equal(error.message, "Could not complete login. Please try again.");
      assert.doesNotMatch(error.message, /test-desktop-session/); return true;
    });
    assert.equal(successes, 0); assert.equal(await store.read(), null); assert.equal(f.login.receive(f.callback()), false);
  } finally { f.login.cancel(); rmSync(root, { recursive: true, force: true }); }
});

test("only exact code-or-error native callbacks are accepted", () => {
  const base = `${NATIVE_CALLBACK}?state=${"s".repeat(43)}`;
  assert.ok(parseLoginCallback(`${base}&error=access_denied`));
  assert.equal(parseLoginCallback(`${base}&error=denied&code=${"c".repeat(43)}`), null);
  assert.equal(parseLoginCallback(base), null);
});

test("logout or cancellation before private persistence cannot resurrect a session", async () => {
  const path = mkdtempSync(join(tmpdir(), "oc-session-race-"));
  const store = createDesktopSessionStore(path);
  try {
    const saving = store.save({ region: "intl", token: "cancelled-storage-test" });
    store.clear();
    await assert.rejects(saving, /cancelled/);
    assert.equal(await store.read(), null);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(store.save({ region: "cn", token: "never-persisted-test" }, abort.signal));
    assert.deepEqual(readdirSync(path), []);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("legacy Keychain ciphertext is ignored and malformed new records require fresh login", async () => {
  const path = mkdtempSync(join(tmpdir(), "oc-session-legacy-"));
  try {
    const legacy = join(path, "lightvela-account.encrypted"); writeFileSync(legacy, "synthetic legacy ciphertext");
    assert.equal(await createDesktopSessionStore(path).read(), null); assert.equal(existsSync(legacy), true);
    const storage = createFilePrivateStorage(join(path, "private-storage"));
    for (const payload of ['invalid json', '{"version":2}', '{"version":1,"session":{"region":"other","token":"test"}}']) {
      storage.write("lightvela-account", payload); assert.equal(await createDesktopSessionStore(path).read(), null);
    }
    const store = createDesktopSessionStore(path); await store.save({ region: "cn", token: "fresh-test-session" }); store.clear();
    assert.equal(existsSync(legacy), false);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test("private storage rejects paths and symlink reads without touching targets", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-private-store-"));
  try {
    const storage = createFilePrivateStorage(join(root, "store"));
    for (const key of ["../escape", "/tmp/escape", "", "a/b"]) assert.throws(() => storage.write(key, "test"));
    storage.write("first", "test"); storage.write("second", "other"); storage.remove("first"); assert.equal(storage.read("second"), "other");
    if (process.platform !== "win32") {
      const target = join(root, "target.json"); writeFileSync(target, "target", { mode: 0o600 });
      symlinkSync(target, join(root, "store", "linked.json")); assert.throws(() => storage.read("linked"));
      assert.equal(readFileSync(target, "utf8"), "target");
      symlinkSync(join(root, "store"), join(root, "alias")); assert.throws(() => createFilePrivateStorage(join(root, "alias")).read("second"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("desktop authentication has no operating-system credential API dependency", () => {
  const main = readFileSync(new URL("../apps/workbench-electron/src/main.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../apps/workbench-electron/src/lightvela-session-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(main, /safeStorage|keytar|isAsyncEncryptionAvailable/);
  assert.doesNotMatch(store, /decryptString|encryptString|from ["']electron/);
});

test("desktop account HTTP is restricted to its authenticated region and known operations", async () => {
  const session: DesktopLoginSession = { region: "intl", token: "native-api-test-session" };
  for (const url of ["http://127.0.0.1/auth/profile", "https://api.lightvela.com/auth/profile", "https://api.lightvela.ai.evil.test/auth/profile", "https://api.lightvela.ai/admin/users", "https://user@api.lightvela.ai/auth/profile", "https://api.lightvela.ai/auth/profile#fragment"]) {
    assert.throws(() => validateDesktopAccountRequest({ url, method: "GET" }, session));
  }
  assert.throws(() => validateDesktopAccountRequest({ url: "https://api.lightvela.ai/v1/instances", method: "DELETE" }, session));
  const response = await requestDesktopAccount({ url: "https://api.lightvela.ai/auth/profile", method: "GET" }, session, async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer native-api-test-session");
    assert.equal(init?.redirect, "error");
    return Response.json({ user: { id: "test-user" } });
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(new TextDecoder().decode(response.body)).user.id, "test-user");
});

test("desktop instance creation permits only the explicit name and timeout contract", () => {
  const session: DesktopLoginSession = { region: "cn", token: "test-only" };
  const request = (body: unknown) => ({ url: "https://api.lightvela.com/v1/instances", method: "POST", contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(body)) });
  assert.equal(validateDesktopAccountRequest(request({ name: "云端环境", timeout: 3600 }), session).pathname, "/v1/instances");
  for (const body of [{ name: "", timeout: 3600 }, { name: "env", timeout: 1 }, { name: "env", timeout: 3600, user_id: "other" }, { name: "x".repeat(65), timeout: 3600 }, null]) {
    assert.throws(() => validateDesktopAccountRequest(request(body), session));
  }
  assert.throws(() => validateDesktopAccountRequest({ ...request({ name: "env", timeout: 3600 }), url: "https://api.lightvela.ai/v1/instances" }, session));
  assert.throws(() => validateDesktopAccountRequest({ ...request({ name: "env", timeout: 3600 }), url: "https://api.lightvela.com/v1/passes" }, session));
  for (const path of ["/v1/instances/create-prerequisites", "/v1/instances/instance-test"]) assert.equal(validateDesktopAccountRequest({ url: `https://api.lightvela.com${path}`, method: "GET" }, session).pathname, path);
});
