import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountPoolStore, CodexAccountPoolProxy, accountFailure } from "../../packages/account-pool-host/src/index.js";

for (const mode of ["expired", "unauthorized", "all-failed"] as const) {
  test(`retryable renewal fails over without disabling accounts: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "renewal-failover-"));
    const store = new AccountPoolStore({ databasePath: join(root, "pool.sqlite"), secretsDirectory: join(root, "secrets") });
    try {
      for (const id of ["a", "b"]) store.addAccount({ id, provider: "codex", label: id,
        upstreamAccountId: id, priority: id === "a" ? 0 : 1, enabled: true },
        { accessToken: id, refreshToken: "synthetic", expiresAt: mode === "unauthorized" ? Date.now()+3600000 : Date.now()-1000 });
      let renewals = 0; const dispatched: string[] = [];
      const proxy = new CodexAccountPoolProxy({ store, upstreamBaseUrl: "https://example.invalid",
        resolveCredential: async (account, secret) => {
          renewals++;
          if (account.id === "a" || mode === "all-failed") throw accountFailure("renewal-incomplete", "renewal", true);
          return { ...secret, expiresAt: Date.now()+3600000 };
        },
        fetch: async (_url, init) => {
          const token = new Headers(init?.headers).get("authorization")!; dispatched.push(token);
          return token === "Bearer a" ? new Response(null, { status: 401 }) : Response.json({ models: [] });
        } });
      const token = store.issueHostToken("local");
      const response = await proxy.handle(new Request("http://localhost/v1/models?client_version=0.162.1",
        { headers: { "x-opencraft-account-pool-token": token } }));
      assert.equal(response.status, mode === "all-failed" ? 503 : 200);
      assert.equal(renewals, mode === "unauthorized" ? 1 : 2);
      assert.deepEqual(dispatched, mode === "unauthorized" ? ["Bearer a", "Bearer b"] : mode === "expired" ? ["Bearer b"] : []);
      assert.ok(store.listAccounts().every(a => a.enabled));
      assert.ok(store.listAccountStates().every(a => a.error === null));
      if (mode === "all-failed") assert.match(await response.text(), /renewal-incomplete/);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}
