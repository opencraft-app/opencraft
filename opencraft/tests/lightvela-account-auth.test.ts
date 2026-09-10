import assert from "node:assert/strict";
import test from "node:test";
import { LightVelaHermesTransport } from "../plugins/lightvela-hermes/src/transport/lightvela-hermes-transport";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbHermesSessionTokenCache } from "../plugins/lightvela-hermes/src/lib/hermes-session-token-cache";
import {
  bootstrapLightVelaOAuthCallback,
  LightVelaAccountService,
  LIGHTVELA_TOKEN_KEY,
} from "../plugins/lightvela-hermes/src/account/lightvela-account-service";
import { findHostConnectionInterventionError } from "@opencraft/workbench-runtime";

function fixture(fetchImpl: typeof fetch) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const redirects: string[] = [];
  const location = { origin: "https://chat.lightvela.com", pathname: "/", search: "", hash: "",
    assign: (url: string) => { redirects.push(url); } };
  const service = new LightVelaAccountService({ storage, location, fetchImpl });
  return { service, storage, location, redirects };
}

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

test("region delegates provider selection to the shared LightVela sign-in page", () => {
  const f = fixture(async () => { throw new Error("unexpected fetch"); });
  f.service.selectRegion("cn");
  f.service.signIn();
  const url = new URL(f.redirects[0]!);
  assert.equal(url.origin, "https://lightvela.com");
  assert.equal(url.pathname, "/auth/sign-in");
  assert.equal(url.searchParams.get("return_to"), "https://chat.lightvela.com/");
  assert.equal(url.searchParams.has("provider"), false);
  assert.equal(new LightVelaAccountService({ storage: f.storage }).getSnapshot().region, "cn");
  f.service.selectRegion("intl");
  f.service.signIn();
  assert.equal(new URL(f.redirects[1]!).origin, "https://lightvela.ai");
  f.storage.setItem(LIGHTVELA_TOKEN_KEY, "test-token");
  assert.throws(() => f.service.selectRegion("cn"), /sign out/);
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
