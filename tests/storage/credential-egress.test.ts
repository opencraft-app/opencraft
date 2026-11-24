// The credential lease exchange and the lease egress on Node (runtime-neutral
// Fetch modules; cloudflare-deployment §5.6 "租约的对外接口"). The workerd test
// (tests/storage/account-core-do-workerd.test.ts) runs the same modules
// between the AccountCore object, a WorkspaceHost stand-in and the egress.
import assert from "node:assert/strict";
import test from "node:test";
import { memoryStateDocumentStore } from "@opencraft/document-storage/state";
import {
  CredentialLeaseError,
  documentCredentialLeases,
  type ProviderCredential,
} from "../../packages/account-pool-host/src/credential-leases.ts";
import {
  CREDENTIAL_LEASE_HOLDER_PATH,
  credentialLeaseExchangeClient,
  serveCredentialLeaseExchange,
} from "../../packages/account-pool-host/src/credential-lease-exchange.ts";
import { credentialEgress } from "../../packages/account-pool-host/src/credential-egress.ts";

const holder = { workspace: "w", engine: "pi", incarnation: "i1" };
const PROVIDERS: Record<string, ProviderCredential> = {
  openai: {
    providerId: "openai",
    protocol: "openai-responses",
    baseUrl: "https://api.example/v1",
    credential: "provider-key",
  },
  claude: {
    providerId: "claude",
    protocol: "anthropic-messages",
    baseUrl: "https://claude.example/base/",
    credential: "claude-key",
  },
};

function fixture() {
  let now = 1_000_000;
  const ledger = documentCredentialLeases(
    memoryStateDocumentStore(),
    { resolve: async (id) => PROVIDERS[id] ?? null },
    { now: () => now },
  );
  const serve = serveCredentialLeaseExchange(ledger);
  const calls: Request[] = [];
  const leases = credentialLeaseExchangeClient(() => ({
    async fetch(request) {
      calls.push(request.clone());
      return (await serve(request)) ?? new Response(null, { status: 404 });
    },
  }));
  const upstream: Request[] = [];
  const egress = credentialEgress({
    leases,
    fetch: async (request) => {
      upstream.push(request);
      return new Response("answer", { status: 201, headers: { "x-provider": "1", "set-cookie": "a=b" } });
    },
  });
  return { leases, egress, upstream, calls, advance: (ms: number) => void (now += ms), serve };
}

test("the exchange client is the lease interface: grant, renew, redeem, revoke and the same refusal codes", async () => {
  const { leases, serve } = fixture();
  const lease = await leases.grant(holder, 60_000);
  assert.equal((await leases.renew(lease.id, 60_000)).id, lease.id);
  const redeemed = await leases.redeem(lease.token, "openai");
  assert.deepEqual([redeemed.credential, redeemed.leaseId, redeemed.holder], ["provider-key", lease.id, holder]);
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "resolved",
      (error) => (error instanceof CredentialLeaseError ? error.code : String(error)),
    );
  assert.equal(await code(leases.redeem(lease.token, "missing")), "provider_unavailable");
  assert.equal(await code(leases.grant(holder, 1)), "invalid_lease_request");
  assert.equal(await code(leases.grant({ ...holder, extra: 1 } as never, 60_000)), "invalid_lease_request");
  assert.equal(await leases.revokeHolder({ workspace: "w", keepIncarnation: "i2" }), 1);
  assert.equal(await code(leases.redeem(lease.token, "openai")), "lease_invalid");
  assert.equal(await leases.revoke(lease.id), false);
  // The server refuses other shapes before the ledger sees them.
  const post = (body: string, type = "application/json") =>
    serve(
      new Request(`https://a${CREDENTIAL_LEASE_HOLDER_PATH}`, {
        method: "POST",
        headers: { "content-type": type },
        body,
      }),
    );
  assert.equal((await post("{", "application/json"))!.status, 400);
  assert.equal((await post("{}", "text/plain"))!.status, 400);
  assert.equal((await post(JSON.stringify({ action: "drop" })))!.status, 400);
  assert.equal((await post(JSON.stringify({ action: "revoke", id: "x", extra: 1 })))!.status, 400);
  assert.equal((await serve(new Request(`https://a${CREDENTIAL_LEASE_HOLDER_PATH}`)))!.status, 405);
  assert.equal(await serve(new Request("https://a/elsewhere", { method: "POST" })), null);
});

test("the egress forwards with the provider credential in place of the lease and refuses invalid leases before any provider request", async () => {
  const { leases, egress, upstream, advance } = fixture();
  const lease = await leases.grant(holder, 60_000);
  const response = (await egress(
    new Request("https://egress/__opencraft_egress/openai/responses?x=1", {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, cookie: "c=1", "content-type": "application/json" },
      body: "{}",
    }),
  ))!;
  assert.deepEqual(
    [response.status, await response.text(), response.headers.get("x-provider"), response.headers.get("set-cookie")],
    [201, "answer", "1", null],
  );
  const sent = upstream.at(-1)!;
  assert.deepEqual(
    [sent.url, sent.headers.get("authorization"), sent.headers.get("cookie"), await sent.text()],
    ["https://api.example/v1/responses?x=1", "Bearer provider-key", null, "{}"],
  );
  await egress(
    new Request("https://egress/__opencraft_egress/claude/messages", { headers: { "x-api-key": lease.token } }),
  );
  assert.deepEqual(
    [upstream.at(-1)!.url, upstream.at(-1)!.headers.get("x-api-key"), upstream.at(-1)!.headers.get("authorization")],
    ["https://claude.example/base/messages", "claude-key", null],
  );
  const count = upstream.length;
  const status = async (path: string, headers: Record<string, string> = { authorization: `Bearer ${lease.token}` }) => {
    const reply = (await egress(new Request(`https://egress${path}`, { headers })))!;
    return [reply.status, ((await reply.json()) as { error: string }).error];
  };
  assert.deepEqual(await status("/__opencraft_egress/openai/x", {}), [401, "lease_required"]);
  assert.deepEqual(await status("/__opencraft_egress/nobody/x"), [404, "provider_unavailable"]);
  advance(60_001);
  assert.deepEqual(await status("/__opencraft_egress/openai/x"), [401, "lease_invalid"]);
  assert.equal(upstream.length, count);
  assert.equal(await egress(new Request("https://egress/other")), null);
});
