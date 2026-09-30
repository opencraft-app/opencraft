import assert from "node:assert/strict";
import test from "node:test";
import { LIGHTVELA_TOKEN_KEY, LightVelaAccountService } from "@opencraft/plugin-lightvela-platform";
import { createEmbeddedAccountStorage } from "../apps/workbench-web/src/embedded-chat/embedded-account-storage";

test("embedded account authenticates using the host accessor without persistent token writes", async () => {
  let current: string | null = "synthetic-console-session";
  const storage = createEmbeddedAccountStorage(() => current);
  let requests = 0;
  const service = new LightVelaAccountService({
    storage, sessionManagedByHost: true, initialRegion: "cn", apiBase: "https://api.example.test",
    location: { origin: "https://console.example.test", pathname: "/agents/chat", search: "", hash: "#session_token=unrelated", assign() { throw new Error("Unexpected navigation"); } },
    fetchImpl: async (_url, init) => {
      requests++;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-console-session");
      return Response.json({ data: { ok: true } });
    },
  });
  try {
    assert.equal(service.getSnapshot().session.status, "authenticated");
    assert.equal(service.getSnapshot().region, "cn");
    assert.equal(service.bootstrapOAuthFragment(), false);
    assert.deepEqual(await service.request("/auth/profile"), { ok: true });
    assert.throws(() => storage.setItem(LIGHTVELA_TOKEN_KEY, "replacement"), /console owns/);
    await assert.rejects(service.signIn(), /embedding application/);
    await assert.rejects(service.signOut(), /embedding application/);
    current = null;
    await assert.rejects(service.request("/auth/profile"), /active console session/);
    assert.equal(requests, 1, "missing host session must not fall through to cookie authentication");
  } finally { service.dispose(); }
});

test("an embedded 401 revokes only the borrowed account, never its host credential", async () => {
  const token = "synthetic-host-session";
  const storage = createEmbeddedAccountStorage(() => token);
  let requests = 0;
  const service = new LightVelaAccountService({ storage, sessionManagedByHost: true,
    fetchImpl: async () => { requests++; return Response.json({ message: "expired" }, { status: 401 }); },
  });
  try {
    await assert.rejects(service.request("/auth/profile"), /expired/);
    assert.equal(service.getSnapshot().session.status, "anonymous");
    await assert.rejects(service.request("/auth/profile"), /sign in/);
    assert.equal(requests, 1);
    const replacement = createEmbeddedAccountStorage(() => token);
    assert.equal(replacement.getItem(LIGHTVELA_TOKEN_KEY), token);
    assert.equal(replacement.getItem("vela.lightvela.signed-out.v1"), null);
  } finally { service.dispose(); }
});
