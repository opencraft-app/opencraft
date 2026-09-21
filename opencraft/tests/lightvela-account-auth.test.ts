import assert from "node:assert/strict";
import test from "node:test";
import { LightVelaHermesTransport } from "../plugins/lightvela-hermes/src/transport/lightvela-hermes-transport";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbHermesSessionTokenCache } from "../plugins/lightvela-hermes/src/lib/hermes-session-token-cache";
import {
  bootstrapLightVelaOAuthCallback,
  bootstrapLightVelaWebLoginCallback,
  LightVelaApiError,
  LightVelaAccountService,
  LightVelaRegionSwitchRequiresSignOutError,
  LIGHTVELA_REGION_KEY,
  LIGHTVELA_TOKEN_KEY,
} from "../plugins/lightvela-hermes/src/account/lightvela-account-service";
import { selectLightVelaLoginRegion } from "../plugins/lightvela-hermes/src/settings/lightvela-region-selection";
import { WEB_LOGIN_PENDING_KEY } from "../plugins/lightvela-hermes/src/account/lightvela-web-login";
import { desktopAccountStorage, type LightVelaDesktopAccountPort } from "../plugins/lightvela-hermes/src/account/lightvela-desktop-login";
import { findHostConnectionInterventionError } from "@opencraft/workbench-runtime";

function fixture(fetchImpl: typeof fetch, desktopAccount?: LightVelaDesktopAccountPort) {
  const values = new Map<string, string>();
  const transactions = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const transactionStorage = { getItem: (key: string) => transactions.get(key) ?? null,
    setItem: (key: string, value: string) => { transactions.set(key, value); },
    removeItem: (key: string) => { transactions.delete(key); } };
  const redirects: string[] = [];
  const location = { origin: "https://chat.lightvela.com", pathname: "/", search: "", hash: "",
    assign: (url: string) => { redirects.push(url); } };
  const replacements: string[] = [];
  const history = { state: {}, replaceState: (_state: unknown, _unused: string, url?: string | URL | null) => { replacements.push(String(url)); } };
  const service = new LightVelaAccountService({ storage, transactionStorage, location, history, fetchImpl, desktopAccount });
  return { service, storage, transactionStorage, location, redirects, replacements };
}

test("desktop sign-in completes independently of failing profile and instance services", async () => {
  const desktop: LightVelaDesktopAccountPort = {
    signIn: async region => ({ region, token: "test-session" }),
    cancel: async () => {}, readSession: async () => null, clearSession: async () => {},
  };
  const f = fixture(async () => Response.json({ message: "unavailable" }, { status: 503 }), desktop);
  const result = await f.service.signIn();
  assert.equal(result.status, "authenticated");
  await assert.rejects(f.service.refreshBots());
  await assert.rejects(f.service.refreshAccountDetails());
  assert.equal(f.service.getSnapshot().session.status, "authenticated");
  assert.equal(f.service.getSnapshot().phase, "error", "legacy catalog error stays separate");
  assert.equal(f.service.getSnapshot().details.phase, "error");
  f.service.dispose();
});

test("cancellation fences a native result even if its provider returns it late", async () => {
  let resolve!: (value: { region: "intl"; token: string }) => void;
  const f = fixture(async () => { throw new Error("must not load resources"); }, {
    signIn: () => new Promise(yes => { resolve = yes; }),
    cancel: async () => {}, readSession: async () => null, clearSession: async () => {},
  });
  const pending = f.service.signIn(); await f.service.cancelSignIn();
  resolve({ region: "intl", token: "late-test-session" });
  assert.equal((await pending).status, "cancelled");
  assert.equal(f.service.hasStoredSession(), false);
  f.service.dispose();
});

test("a late 401 cannot clear the replacement session", async () => {
  let resolve!: (value: Response) => void;
  const f = fixture(async url => String(url).includes("late-request")
    ? new Promise(yes => { resolve = yes; })
    : Response.json({ data: { items: [] } }), {
    signIn: async region => ({ region, token: "test-session" }),
    cancel: async () => {}, readSession: async () => null, clearSession: async () => {},
  });
  await f.service.signIn();
  const stale = f.service.request("/late-request");
  await f.service.signIn();
  resolve(Response.json({ message: "expired" }, { status: 401 }));
  await assert.rejects(stale);
  assert.equal(f.service.getSnapshot().session.status, "authenticated");
  assert.equal(f.service.hasStoredSession(), true); f.service.dispose();
});

test("desktop native login updates the account without navigating and permits cancellation/retry", async () => {
  let attempt = 0;
  const desktop: LightVelaDesktopAccountPort = {
    signIn: async region => ++attempt === 1 ? null : { region, token: "desktop-test-session" },
    cancel: async () => {}, readSession: async () => null, clearSession: async () => {},
  };
  const f = fixture(async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer desktop-test-session");
    return Response.json({ data: { items: [] } });
  }, desktop);
  f.service.selectRegion("cn");
  await f.service.signIn();
  assert.equal(f.service.getSnapshot().phase, "anonymous");
  assert.equal((await f.service.signIn()).status, "authenticated");
  assert.equal(f.service.getSnapshot().session.status, "authenticated");
  assert.equal(f.service.getSnapshot().region, "cn");
  assert.deepEqual(f.redirects, []);
  assert.equal(f.transactionStorage.getItem(WEB_LOGIN_PENDING_KEY), null);
  f.service.dispose();
});

test("desktop bootstrap restores the private session into memory and logout clears its owner", async () => {
  let cleared = 0;
  const desktop: LightVelaDesktopAccountPort = {
    signIn: async () => null, cancel: async () => {},
    readSession: async () => ({ region: "intl", token: "restored-test-session" }),
    clearSession: async () => { cleared++; },
  };
  const f = fixture(async () => new Response(null, { status: 204 }), desktop);
  assert.equal(await bootstrapLightVelaWebLoginCallback({ desktopAccount: desktop, storage: f.storage }), true);
  assert.equal(f.storage.getItem(LIGHTVELA_TOKEN_KEY), "restored-test-session");
  await f.service.signOut();
  assert.equal(cleared, 1);
  assert.equal(f.storage.getItem(LIGHTVELA_TOKEN_KEY), null);
  const memory = desktopAccountStorage(f.storage);
  memory.setItem(LIGHTVELA_TOKEN_KEY, "memory-test-session");
  assert.equal(f.storage.getItem(LIGHTVELA_TOKEN_KEY), null);
  assert.equal(memory.getItem(LIGHTVELA_TOKEN_KEY), "memory-test-session");
  memory.removeItem(LIGHTVELA_TOKEN_KEY);
  f.service.dispose();
});

test("desktop account refresh uses the native request port rather than browser CORS", async () => {
  const nativeRequests: string[] = [];
  const desktop: LightVelaDesktopAccountPort = {
    signIn: async region => ({ region, token: "desktop-request-test" }), cancel: async () => {},
    readSession: async () => null, clearSession: async () => {},
    request: async input => {
      nativeRequests.push(input.url);
      assert.ok(input.url.startsWith("https://api.lightvela.ai/"));
      assert.equal(input.method, "GET");
      assert.equal("Authorization" in input, false);
      const body = input.url.endsWith("/auth/profile") ? { user: { id: "test", name: "Test" } } : { data: { items: [] } };
      return { status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(body)) };
    },
  };
  const f = fixture(async () => { throw new Error("browser fetch must not be used"); }, desktop);
  await f.service.signIn();
  await Promise.all([f.service.refreshBots(), f.service.refreshAccountDetails()]);
  assert.ok(nativeRequests.includes("https://api.lightvela.ai/v1/instances?page=1&page_size=100"));
  assert.ok(nativeRequests.includes("https://api.lightvela.ai/auth/profile"));
  assert.equal(f.service.getSnapshot().phase, "authenticated");
  f.service.dispose();
});

test("deferred desktop account restoration does not block local setup and cannot undo sign-out", async () => {
  let release!: (value: { region: "intl"; token: string }) => void;
  const desktop: LightVelaDesktopAccountPort = {
    signIn: async () => null, cancel: async () => {}, clearSession: async () => {}, signOut: async () => {},
    readSession: () => new Promise(resolve => { release = resolve; }),
  };
  const f = fixture(async () => { throw new Error("No browser request expected"); }, desktop);
  const restoring = f.service.restoreDesktopSession();
  assert.equal(f.service.getSnapshot().phase, "anonymous");
  await f.service.signOut();
  release({ region: "intl", token: "late-restore-fixture" });
  assert.equal(await restoring, false);
  assert.equal(f.service.hasStoredSession(), false);
  const next = f.service.restoreDesktopSession();
  release({ region: "intl", token: "valid-restore-fixture" });
  assert.equal(await next, true);
  assert.equal(f.service.hasStoredSession(), true);
  f.service.dispose();
});

test("OAuth callback is consumed independently of extension and View startup", () => {
  const values = new Map<string, string>([["vela.lightvela.signed-out.v1", "true"]]);
  const replacements: string[] = [];
  const accepted = bootstrapLightVelaOAuthCallback({
    storage: {
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    },
    location: {
      pathname: "/local/thread-1",
      search: "?hostId=velahermes0",
      hash: "#panel=account&session_token=oauth-token",
    },
    history: {
      state: { route: "thread-1" },
      replaceState: (_state, _unused, url) => { replacements.push(String(url)); },
    },
  });

  assert.equal(accepted, true);
  assert.equal(values.get(LIGHTVELA_TOKEN_KEY), "oauth-token");
  assert.equal(values.has("vela.lightvela.signed-out.v1"), false);
  assert.deepEqual(replacements, ["/local/thread-1?hostId=velahermes0#panel=account"]);
});

test("region delegates authentication to the shared OIDC authorization page", async () => {
  const f = fixture(async () => { throw new Error("unexpected fetch"); });
  f.service.selectRegion("cn");
  await f.service.signIn();
  const url = new URL(f.redirects[0]!);
  assert.equal(url.origin, "https://api.lightvela.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "opencraft-web-v1");
  assert.equal(url.searchParams.get("redirect_uri"), "https://chat.lightvela.com/auth/lightvela/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state")?.length, 43);
  assert.equal(JSON.parse(f.transactionStorage.getItem(WEB_LOGIN_PENDING_KEY)!).returnPath, "/");
  assert.equal(new LightVelaAccountService({ storage: f.storage }).getSnapshot().region, "cn");
  await f.service.signIn();
  assert.equal(f.redirects.length, 1, "concurrent/repeated sign-in must reuse one transaction");
  const intl = fixture(async () => { throw new Error("unexpected fetch"); });
  await intl.service.signIn();
  assert.equal(new URL(intl.redirects[0]!).origin, "https://api.lightvela.ai");
  intl.storage.setItem(LIGHTVELA_TOKEN_KEY, "test-token");
  assert.throws(() => intl.service.selectRegion("cn"), LightVelaRegionSwitchRequiresSignOutError);
  assert.equal(selectLightVelaLoginRegion(intl.service, "cn"), "请先退出登录，再切换登录站点。");
  assert.equal(intl.service.getSnapshot().region, "intl");
});

test("web OIDC callback atomically exchanges the grant and restores the initiating route", async () => {
  const values = new Map<string, string>();
  const verifier = "v".repeat(43);
  const state = "s".repeat(43);
  const transactionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  transactionStorage.setItem(WEB_LOGIN_PENDING_KEY, JSON.stringify({
    state, verifier, createdAt: Date.now(), region: "cn",
    returnPath: "/local/thread-1?hostId=velahermes0#panel=account",
  }));
  const credentials = new Map<string, string>([["vela.lightvela.signed-out.v1", "true"]]);
  let exchanged: Record<string, unknown> | null = null;
  const replacements: string[] = [];
  const accepted = await bootstrapLightVelaWebLoginCallback({
    storage: {
      getItem: key => credentials.get(key) ?? null,
      setItem: (key, value) => { credentials.set(key, value); },
      removeItem: key => { credentials.delete(key); },
    },
    transactionStorage,
    location: {
      origin: "https://chat.lightvela.com",
      pathname: "/auth/lightvela/callback",
      search: `?code=${"c".repeat(43)}&state=${state}`,
      hash: "",
      assign: () => undefined,
    },
    history: {
      state: {},
      replaceState: (_state, _unused, url) => { replacements.push(String(url)); },
    },
    fetchImpl: async (_input, init) => {
      exchanged = JSON.parse(String(init?.body));
      return Response.json({ session_token: "web-session" });
    },
  });
  assert.equal(accepted, true);
  assert.deepEqual(exchanged, {
    client_id: "opencraft-web-v1",
    code: "c".repeat(43),
    code_verifier: verifier,
    redirect_uri: "https://chat.lightvela.com/auth/lightvela/callback",
  });
  assert.equal(credentials.get(LIGHTVELA_TOKEN_KEY), "web-session");
  assert.equal(credentials.get(LIGHTVELA_REGION_KEY), "cn");
  assert.equal(credentials.has("vela.lightvela.signed-out.v1"), false);
  assert.equal(transactionStorage.getItem(WEB_LOGIN_PENDING_KEY), null);
  assert.deepEqual(replacements, ["/local/thread-1?hostId=velahermes0#panel=account"]);
});

test("anonymous Bot resolution is an authentication intervention, not a transport failure", async () => {
  const f = fixture(async () => new Response(JSON.stringify({ message: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  }));
  await assert.rejects(f.service.resolveActiveBot(), (error) => {
    const intervention = findHostConnectionInterventionError(error);
    assert.equal(intervention?.code, "authentication-required");
    assert.equal(intervention?.providerId, "lightvela.hermes");
    return true;
  });
  assert.equal(f.service.getSnapshot().phase, "anonymous");
});

test("logout revokes server session, cancels stale refresh and prevents cookie resurrection", async () => {
  let finish!: (response: Response) => void;
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = fixture(async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  f.storage.setItem(LIGHTVELA_TOKEN_KEY, "test-token");
  const scope = f.service.getSnapshot().credentialScope;
  const refresh = f.service.refreshBots();
  const rejected = assert.rejects(refresh, /abort/i);
  await f.service.signOut();
  assert.equal(calls[1]!.url, "https://api.lightvela.ai/auth/session");
  assert.equal(new Headers(calls[1]!.init?.headers).get("Authorization"), "Bearer test-token");
  assert.equal(calls[0]!.init?.signal?.aborted, true);
  assert.notEqual(f.service.getSnapshot().credentialScope, scope);
  finish(new Response(JSON.stringify({ data: { items: [] } })));
  await rejected;
  assert.equal(f.service.getSnapshot().phase, "anonymous");
  await assert.rejects(f.service.request("/v1/instances"), /sign in/);
  assert.equal(calls.length, 2);
  const reloaded = new LightVelaAccountService({ storage: f.storage });
  await assert.rejects(reloaded.request("/v1/instances"), /sign in/);
});

test("failed remote logout still retires local authority and reports failure", async () => {
  const f = fixture(async () => new Response("failure", { status: 503 }));
  f.storage.setItem(LIGHTVELA_TOKEN_KEY, "test-token");
  await assert.rejects(f.service.signOut(), /503/);
  assert.equal(f.storage.getItem(LIGHTVELA_TOKEN_KEY), null);
  assert.equal(f.service.getSnapshot().phase, "anonymous");
  await assert.rejects(f.service.request("/v1/instances"), /sign in/);
});

test("logout while resolving the Bot prevents a late TAT connection", async () => {
  let notify!: () => void;
  let finish!: (value: { instanceId: string; name: string; status: string; createdAt: string }) => void;
  let snapshot = { phase: "loading", activeBotId: null as string | null, authGeneration: 0 };
  let requests = 0;
  const transport = new LightVelaHermesTransport({ account: {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { notify = listener; return () => undefined; },
    resolveActiveBot: () => new Promise((resolve) => { finish = resolve; }),
    request: async () => { requests++; throw new Error("unexpected TAT request"); },
  } });
  const connect = transport.connect();
  const rejected = assert.rejects(connect, /aborted/);
  snapshot = { phase: "anonymous", activeBotId: null, authGeneration: 1 };
  notify();
  finish({ instanceId: "old-bot", name: "Old", status: "RUNNING", createdAt: "" });
  await rejected;
  assert.equal(requests, 0);
  assert.notEqual(transport.status.state, "open");
  await transport.close();
});

test("a deleted TAT resource requires manual recovery instead of automatic reconnect", async () => {
  const transport = new LightVelaHermesTransport({
    account: {
      getSnapshot: () => ({ phase: "authenticated", activeBotId: "deleted-bot" }),
      subscribe: () => () => undefined,
      resolveActiveBot: async () => ({
        instanceId: "deleted-bot",
        name: "Deleted",
        status: "running",
        createdAt: "",
      }),
      request: async () => {
        throw new LightVelaApiError("resource not found request_id=req-1", 404);
      },
    },
  });

  await assert.rejects(transport.connect(), /resource not found/u);
  assert.deepEqual(transport.status, {
    state: "failed",
    reason: "resource not found request_id=req-1",
    failure: {
      code: "remote-resource-not-found",
      recovery: "manual",
    },
  });
  await transport.close();
});

test("logout cache erasure deletes persisted backend credentials", async () => {
  const cache = new IndexedDbHermesSessionTokenCache({ factory: new IDBFactory() });
  await cache.put("old-scope:bot", "test-backend-token");
  await cache.clear();
  assert.equal(await cache.get("old-scope:bot"), null);
  cache.close();
});

test("account center reuses mono2 profile, subscription and pass authorities", async () => {
  const calls: Request[] = [];
  const f = fixture(async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    switch (new URL(request.url).pathname) {
      case "/v1/instances":
        return Response.json({ data: { items: [] } });
      case "/auth/profile":
        if (request.method === "PUT") {
          assert.deepEqual(await request.json(), { name: "New name" });
          return Response.json({ user: { id: "usr-1", name: "New name", avatarUrl: "/auth/profile/avatar" } });
        }
        return Response.json({ user: { id: "usr-1", name: "Jindong Zhang", avatarUrl: "/auth/profile/avatar" } });
      case "/subscriptions/current":
        return Response.json({
          hasSubscription: true,
          subscription: {
            code: "pro",
            status: "active",
            currentPeriodStart: "2026-05-16T00:00:00Z",
            currentPeriodEnd: "2026-09-27T00:00:00Z",
          },
        });
      case "/v1/passes":
        return Response.json({ data: { passes: [{
          pass_id: "pass-1",
          bundle_name: "Launch",
          created_time: "2026-05-16T00:00:00Z",
          expired_time: "2026-09-27T00:00:00Z",
          credit_total: 100,
          credit_available: 31,
        }] } });
      default:
        throw new Error(`Unexpected request ${request.url}`);
    }
  });
  f.storage.setItem(LIGHTVELA_TOKEN_KEY, "account-token");
  await f.service.refreshBots();
  const details = await f.service.refreshAccountDetails();
  assert.equal(details.profile?.name, "Jindong Zhang");
  assert.equal(details.profile?.avatarUrl, "https://api.lightvela.ai/auth/profile/avatar");
  assert.equal(details.subscription?.code, "pro");
  assert.deepEqual(details.pass, {
    passId: "pass-1",
    bundleName: "Launch",
    createdAt: "2026-05-16T00:00:00Z",
    expiresAt: "2026-09-27T00:00:00Z",
    isolatedAt: null,
    deletedAt: null,
    creditsTotal: 100,
    creditsAvailable: 31,
  });
  assert.ok(calls.every((request) => request.headers.get("authorization") === "Bearer account-token"));

  await f.service.updateProfileName(" New name ");
  assert.equal(f.service.getSnapshot().details.profile?.name, "New name");
  await f.service.signOut().catch(() => undefined);
  assert.equal(f.service.getSnapshot().details.phase, "idle");
});

test("account detail 401 retires the shared login authority", async () => {
  const f = fixture(async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
  f.storage.setItem(LIGHTVELA_TOKEN_KEY, "expired-token");

  await assert.rejects(f.service.refreshAccountDetails(), /Unauthorized/);

  assert.equal(f.storage.getItem(LIGHTVELA_TOKEN_KEY), null);
  assert.equal(f.service.getSnapshot().phase, "anonymous");
  assert.equal(f.service.getSnapshot().details.phase, "idle");
  await assert.rejects(f.service.request("/v1/instances"), /sign in/);
});
