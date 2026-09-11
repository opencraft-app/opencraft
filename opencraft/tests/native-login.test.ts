import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRequire } from "node:module";
import type { NativeLoginPorts } from "../apps/workbench-expo/src/runtime/native-login";
const { createNativeLogin, NATIVE_LOGIN_REDIRECT } = createRequire(import.meta.url)("../apps/workbench-expo/src/runtime/native-login.ts") as typeof import("../apps/workbench-expo/src/runtime/native-login");

function fixture() {
  let saved: string | null = null;
  let now = 1_000;
  let calls = 0;
  let callback = "";
  const ports: NativeLoginPorts = {
    random: () => "s".repeat(43), now: () => now,
    challenge: async v => createHash("sha256").update(v).digest("base64url"),
    read: async () => saved, write: async v => { saved = v; }, remove: async expected => { if (saved === expected) saved = null; },
    open: async (raw, redirect) => {
      const u = new URL(raw);
      assert.equal(u.pathname, "/oauth2/authorize");
      assert.equal(u.searchParams.get("client_id"), "opencraft-native-v1");
      assert.equal(u.searchParams.get("response_type"), "code");
      assert.equal(u.searchParams.get("scope"), "openid profile");
      assert.ok(u.searchParams.get("nonce"));
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.equal(u.searchParams.get("code_challenge"), createHash("sha256").update("s".repeat(43)).digest("base64url"));
      assert.equal(u.searchParams.has("code_verifier"), false);
      assert.equal(redirect, NATIVE_LOGIN_REDIRECT);
      callback = `${redirect}?state=${u.searchParams.get("state")}&code=${"a".repeat(43)}`;
      return { type: "success", url: callback };
    },
    exchange: async input => { calls++; assert.equal(input.code_verifier, "s".repeat(43)); return "test-session"; },
  };
  return { ports, get saved() { return saved; }, get calls() { return calls; }, get callback() { return callback; },
    seed: () => { saved = JSON.stringify({ state: "s".repeat(43), verifier: "s".repeat(43), createdAt: now }); },
    advance: () => { now += 600_000; },
  };
}

test("native login exchanges PKCE once and clears pending material", async () => {
  const f = fixture(); const flow = createNativeLogin(f.ports, "https://api.lightvela.ai");
  assert.equal(await flow.signIn(), "test-session");
  assert.equal(f.calls, 1); assert.equal(f.saved, null);
  await assert.rejects(flow.consume(f.callback), /expired/);
  assert.equal(f.calls, 1);
});

test("retiring login cannot erase the next owner's transaction", async () => {
  const f = fixture();
  let next = 0;
  f.ports.random = () => String(++next).padStart(43, "s");
  const callbacks: ((value: { type: string; url?: string }) => void)[] = [];
  const urls: string[] = [];
  f.ports.open = async raw => { urls.push(raw); return new Promise(resolve => callbacks.push(resolve)); };
  const old = createNativeLogin(f.ports, "https://api.lightvela.ai");
  const oldResult = old.signIn();
  while (callbacks.length < 1) await new Promise(resolve => setImmediate(resolve));
  old.dispose();
  const current = createNativeLogin(f.ports, "https://api.lightvela.ai");
  const currentResult = current.signIn();
  while (callbacks.length < 2) await new Promise(resolve => setImmediate(resolve));
  const saved = f.saved;
  callbacks[0]({ type: "cancel" });
  await assert.rejects(oldResult, /cancelled/);
  assert.equal(f.saved, saved);
  f.ports.exchange = async () => "new-session";
  const state = new URL(urls[1]).searchParams.get("state");
  callbacks[1]({ type: "success", url: `${NATIVE_LOGIN_REDIRECT}?state=${state}&code=${"a".repeat(43)}` });
  assert.equal(await currentResult, "new-session");
  assert.equal(f.saved, null);
});

test("cold callback restores a pending transaction; concurrent delivery exchanges once", async () => {
  const f = fixture(); f.seed();
  const flow = createNativeLogin(f.ports, "https://api.lightvela.ai");
  const url = `${NATIVE_LOGIN_REDIRECT}?state=${"s".repeat(43)}&code=${"a".repeat(43)}`;
  assert.deepEqual(await Promise.all([flow.consume(url), flow.consume(url)]), ["test-session", "test-session"]);
  assert.equal(f.calls, 1); assert.equal(f.saved, null);
});

test("wrong address/state, duplicate parameters and token callbacks never exchange", async () => {
  for (const url of [
    `evil://auth/lightvela?state=${"s".repeat(43)}`, `opencraft://user@auth/lightvela?state=${"s".repeat(43)}`,
    `opencraft://auth/other/../lightvela?state=${"s".repeat(43)}`,
    `${NATIVE_LOGIN_REDIRECT}?state=wrong`, `${NATIVE_LOGIN_REDIRECT}?state=${"s".repeat(43)}&state=other`,
    `${NATIVE_LOGIN_REDIRECT}?state=${"s".repeat(43)}&session_token=unsafe`, `${NATIVE_LOGIN_REDIRECT}?state=${"s".repeat(43)}#session_token=unsafe`,
  ]) {
    const f = fixture(); f.seed(); const flow = createNativeLogin(f.ports, "https://api.lightvela.ai");
    await assert.rejects(flow.consume(url)); assert.equal(f.calls, 0);
  }
});

test("expired login and browser cancellation clear pending credentials", async () => {
  const f = fixture(); f.seed(); f.advance(); const flow = createNativeLogin(f.ports, "https://api.lightvela.ai");
  await assert.rejects(flow.consume(`${NATIVE_LOGIN_REDIRECT}?state=${"s".repeat(43)}`), /expired/);
  assert.equal(f.saved, null);
  f.ports.open = async () => ({ type: "cancel" });
  assert.equal(await flow.signIn(), null); assert.equal(f.saved, null); assert.equal(f.calls, 0);
});

test("disposal aborts exchange and rejects late completion", async () => {
  const f = fixture(); let finish!: (token: string) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  f.ports.exchange = async (_, s) => { signal = s; entered(); return new Promise(resolve => { finish = resolve; }); };
  const flow = createNativeLogin(f.ports, "https://api.lightvela.ai");
  const login = flow.signIn(); await started; flow.dispose(); assert.equal(signal?.aborted, true);
  finish("late-token"); await assert.rejects(login, /cancelled/); assert.equal(f.saved, null);
});
