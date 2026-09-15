import assert from "node:assert/strict";
import test from "node:test";
import { LightVelaApiError, type LightVelaAccountService } from "../plugins/lightvela-hermes/src/account/lightvela-account-service";
import { creationBlock, LightVelaEnvironmentService } from "../plugins/lightvela-hermes/src/environments/lightvela-environment-service";
import { environmentAccountPort, createLightVelaHermesHostProvider } from "../plugins/lightvela-hermes/src/host/lightvela-hermes-host-provider";
import type { HostConnectionProfile, ProvisionHostInput } from "@opencraft/workbench-runtime";

const readyPass = { status: "active", expired_time: "2099-01-01T00:00:00Z", agent_quota_available: 1 };
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const requests: { path: string; method: string; body?: string }[] = [], profiles: HostConnectionProfile[] = [];
  const listeners = new Set<() => void>();
  let snapshot = { region: "intl", phase: "authenticated", activeBotId: "old-instance", authGeneration: 0, bots: [{ instanceId: "old-instance" }, { instanceId: "new-instance" }] };
  let passes = [readyPass], postError: Error | null = null, readStatus = "Creating", heldRead: Promise<void> | null = null;
  let provisionError = false;
  const account = {
    getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshAccountDetails: async () => ({ profile: { id: "test-user" } }),
    refreshBots: async () => snapshot.bots,
    resolveActiveBot: async (instanceId?: string) => {
      const bot = snapshot.bots.find(bot => bot.instanceId === (instanceId ?? snapshot.activeBotId));
      if (!bot) throw new Error("Not running"); return bot;
    },
    request: async (path: string, init?: RequestInit) => {
      requests.push({ path, method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (path === "/v1/passes") return { passes };
      if (path === "/v1/instances" && init?.method === "POST") { if (postError) throw postError; return { instance_id: "new-instance", status: "Creating" }; }
      if (path === "/v1/instances/new-instance") { await heldRead; return { instance_id: "new-instance", status: readStatus }; }
      throw new Error("Unexpected endpoint");
    },
  } as unknown as LightVelaAccountService;
  const host = { profiles, provisionHost: async (input: ProvisionHostInput) => {
    if (provisionError) throw new Error("disk full");
    const profile = { ...input, enabled: true, revision: 0 } as HostConnectionProfile; profiles.push(profile); return profile;
  } };
  const make = () => new LightVelaEnvironmentService(account, { storage, pollMs: 1, maxPolls: 3 });
  return { account, host, requests, data, make, storage,
    setPasses: (value: typeof passes) => { passes = value; }, setPostError: (error: Error | null) => { postError = error; },
    setStatus: (status: string) => { readStatus = status; }, setProvisionError: (value: boolean) => { provisionError = value; },
    holdRead: () => { let release!: () => void; heldRead = new Promise<void>(resolve => { release = resolve; }); return release; },
    changeAccount: () => { snapshot = { ...snapshot, authGeneration: snapshot.authGeneration + 1, phase: "anonymous" }; for (const listener of listeners) listener(); },
    selectLegacy: (id: string) => { snapshot = { ...snapshot, activeBotId: id }; for (const listener of listeners) listener(); },
    changeRegion: () => { snapshot = { ...snapshot, region: "cn" }; },
  };
}

test("creation prerequisites distinguish VM quota and active pass without using an unpublished endpoint", () => {
  assert.equal(creationBlock([readyPass]), null);
  assert.match(creationBlock([])!, /套餐/);
  for (const status of ["renewing", "isolating", "isolated", "deleting", "modifying"]) assert.match(creationBlock([{ ...readyPass, status }])!, /套餐/);
  assert.match(creationBlock([{ ...readyPass, agent_quota_available: 0 }])!, /额度/);
  assert.match(creationBlock([{ ...readyPass, expired_time: "2000-01-01" }])!, /套餐/);
});
test("explicit confirmation rechecks quota; blocked state never posts", async () => {
  const f = fixture(), service = f.make();
  try { await service.check(f.host); assert.equal(service.getSnapshot().phase, "ready");
    f.setPasses([]); await service.create("Cloud", f.host);
    assert.equal(service.getSnapshot().phase, "blocked"); assert.equal(f.requests.some(r => r.method === "POST"), false);
  } finally { service.dispose(); }
});
test("single-flight creation publishes progress and installs a distinct non-active Host", async () => {
  const f = fixture(), service = f.make();
  try {
    await service.check(f.host); const release = f.holdRead();
    assert.equal(f.requests.some(r => r.path.includes('create-prerequisites')), false);
    const first = service.create("  工作环境  ", f.host), second = service.create("Duplicate", f.host);
    await pause(); assert.equal(service.getSnapshot().phase, "creating");
    assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
    assert.deepEqual(JSON.parse(f.requests.find(r => r.method === "POST")!.body!), { name: "工作环境", timeout: 3600 });
    f.setStatus("Running"); release(); await Promise.all([first, second]);
    assert.equal(service.getSnapshot().phase, "complete"); assert.equal(f.host.profiles.length, 1);
    assert.deepEqual(f.host.profiles[0].providerConfig, { instanceId: "new-instance", region: "intl" });
    assert.equal(f.host.profiles[0].autoConnect, false); assert.equal(f.account.getSnapshot().activeBotId, "old-instance");
    assert.equal(f.data.size, 0);
  } finally { service.dispose(); }
});
test("unknown POST outcome survives reopening and is never automatically retried", async () => {
  const f = fixture(); let service = f.make();
  try { await service.check(f.host); f.setPostError(new TypeError("network lost")); await service.create("Cloud", f.host);
    assert.equal(service.getSnapshot().phase, "unknown"); service.dispose(); service = f.make();
    await service.check(f.host); await service.create("Again", f.host);
    assert.equal(service.getSnapshot().phase, "unknown"); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { service.dispose(); }
});
test("accepted request resumes polling after restart, without repeating POST", async () => {
  const f = fixture(); let service = f.make();
  try { await service.check(f.host); await service.create("Cloud", f.host); assert.equal(service.getSnapshot().phase, "waiting");
    service.dispose(); service = f.make(); f.setStatus("Running"); await service.check(f.host);
    assert.equal(service.getSnapshot().phase, "complete"); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { service.dispose(); }
});
test("local profile failure retries only registration, not cloud creation", async () => {
  const f = fixture(), service = f.make();
  try { await service.check(f.host); f.setStatus("Running"); f.setProvisionError(true); await service.create("Cloud", f.host);
    assert.equal(service.getSnapshot().phase, "waiting"); f.setProvisionError(false); await service.check(f.host);
    assert.equal(service.getSnapshot().phase, "complete"); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  } finally { service.dispose(); }
});
test("account switch fences late polling completion and profile writes", async () => {
  const f = fixture(), service = f.make();
  try { await service.check(f.host); const release = f.holdRead(); const operation = service.create("Cloud", f.host); await pause();
    f.changeAccount(); f.setStatus("Running"); release(); await operation;
    assert.equal(service.getSnapshot().phase, "idle"); assert.equal(f.host.profiles.length, 0); assert.equal(service.getSnapshot().request, null);
  } finally { service.dispose(); }
});
test("quota rejection is actionable, while infrastructure failure remains an uncertain outcome", async () => {
  for (const status of [403, 500]) {
    const f = fixture(), service = f.make();
    try { await service.check(f.host); f.setPostError(new LightVelaApiError("server rejected", status)); await service.create("Cloud", f.host);
      assert.equal(service.getSnapshot().phase, status === 403 ? "blocked" : "unknown");
      assert.equal(f.host.profiles.length, 0);
    } finally { service.dispose(); }
  }
});
test("bound environment remains on its instance when the legacy Host switches", async () => {
  const f = fixture(); const port = environmentAccountPort(f.account, { instanceId: "new-instance", region: "intl" });
  assert.equal((await port.resolveActiveBot()).instanceId, "new-instance");
  f.selectLegacy("different-instance"); assert.equal(port.getSnapshot().activeBotId, "new-instance");
  assert.equal(f.account.getSnapshot().activeBotId, "different-instance");
  f.changeRegion(); await assert.rejects(port.resolveActiveBot(), /站点/);
  assert.equal(port.getSnapshot().activeBotId, null);
  const provider = createLightVelaHermesHostProvider(f.account);
  assert.throws(() => provider.validate({ instanceId: "new-instance" }, {} as never), /region/);
});

test("server-side shadow binding rejection is shown without assuming verification succeeded", async () => {
  const f = fixture(), service = f.make();
  try { await service.check(f.host); f.setPostError(new LightVelaApiError("binding required", 403, "INSTANCE_SHADOW_BINDING_REQUIRED")); await service.create("Cloud", f.host);
    assert.equal(service.getSnapshot().phase, "blocked"); assert.match(service.getSnapshot().message!, /账号开通或验证/);
    assert.equal(f.host.profiles.length, 0); assert.equal(service.getSnapshot().websiteUrl, "https://lightvela.ai/agents");
  } finally { service.dispose(); }
});

test("sign-out during local registration removes only the newly registered profile", async () => {
  const f = fixture(), service = f.make(); const removed: string[] = [];
  const host = { provisionHost: async (input: ProvisionHostInput) => { f.changeAccount(); return { ...input } as HostConnectionProfile; },
    removeHost: async (id: string) => { removed.push(id); return true; } };
  try { await service.check(host); f.setStatus("Running"); await service.create("Cloud", host);
    assert.equal(service.getSnapshot().phase, "idle"); assert.equal(removed.length, 1); assert.match(removed[0], /^lightvela-env-/);
  } finally { service.dispose(); }
});

test("directory-owned creation return refreshes discovery without duplicating a saved Host", async () => {
  const f = fixture(); let refreshed = 0;
  const service = new LightVelaEnvironmentService(f.account, { storage: f.storage, onInstanceReady: async () => { refreshed++; } });
  try { await service.check(f.host); f.setStatus("Running"); await service.create("Cloud", f.host);
    assert.equal(service.getSnapshot().phase, "complete"); assert.equal(refreshed, 1); assert.equal(f.host.profiles.length, 0);
    assert.equal(f.account.getSnapshot().activeBotId, "old-instance");
  } finally { service.dispose(); }
});
