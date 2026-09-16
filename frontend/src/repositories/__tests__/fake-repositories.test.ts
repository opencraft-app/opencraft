import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessCommandClient } from "@/lib/deepseek-harness-command";
import { createFakeRepositories } from "@/repositories/fake-repositories";

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  };
};

describe("fake repositories FaceID flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createMemoryStorage());
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("completes the fake FaceID attempt during phone verification", async () => {
    const repositories = createFakeRepositories();
    await repositories.auth.signInWithCode({ phone: "15625128341" });

    const started = await repositories.auth.startRealnameFaceIdAttempt({
      name: "张三",
      idCard: "110101199001011234",
      consent: true,
    });
    expect(started.state).toBe("pending");

    await expect(repositories.auth.verifyRealnameFaceIdPhone(started.attemptId, { code: "123456" })).rejects.toThrow();

    expect((await repositories.auth.getRealnameFaceIdAttempt(started.attemptId)).state).toBe("pending");
    expect((await repositories.auth.getRealnameFaceIdAttempt(started.attemptId)).state).toBe("face_succeeded");
    expect((await repositories.auth.getRealnameFaceIdAttempt(started.attemptId)).state).toBe("phone_pending");

    const phoneResult = await repositories.auth.verifyRealnameFaceIdPhone(started.attemptId, { code: "123456" });
    expect(phoneResult.state).toBe("succeeded");

    const profile = await repositories.auth.getProfile();
    expect(profile.realnameVerified).toBe(true);
    expect(profile.realnameLevel).toBe("phone_3fa");
    expect(profile.realnameSyncStatus).toBe("succeeded");
  });

  it("provides an expiring pass for local renewal previews", async () => {
    window.history.replaceState({}, "", "/account?passState=expiring");

    const repositories = createFakeRepositories();
    const passes = await repositories.plans.listMyPasses();

    expect(passes).toHaveLength(1);
    expect(passes[0]?.pass_id).toBe("pass-preview-expiring");
    expect(passes[0]?.bundle_name).toBe("启航 Launch");
    expect(new Date(passes[0]?.expired_time ?? "").getTime() - Date.now()).toBeGreaterThan(5 * 24 * 60 * 60 * 1000);
  });

  it("creates a non-default profile on the shared preview instance", async () => {
    const repositories = createFakeRepositories();
    const bot = await repositories.bots.createBot({
      name: "运营 Bot",
      description: "社群运营",
      createMode: "clone",
      sourceBotId: "bot_local_preview",
    });

    expect(bot).toMatchObject({
      instanceId: "bot_local_preview",
      isDefault: false,
      description: "社群运营",
      createdFrom: "clone",
      sourceBotId: "bot_local_preview",
    });
    expect(bot.profileId).toMatch(/^profile_[a-z0-9]+$/);
  });

  it("keeps Slack connected after the local preview config command succeeds", async () => {
    const repositories = createFakeRepositories();

    await repositories.bots.execDebugCommand("bot_local_preview", "SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test");

    const status = await repositories.bots.execDebugCommand(
      "bot_local_preview",
      "python3 - <<'PY'\nacli channel status\nslack_status = \"connected\"\nPY",
    );

    expect(JSON.parse(status.output)).toEqual({
      success: true,
      data: {
        platforms: [
          {
            name: "slack",
            status: "connected",
          },
        ],
      },
      error: null,
    });
  });

  it("previews the DeepSeek Harness lifecycle through debug exec commands", async () => {
    const repositories = createFakeRepositories();
    const client = new DeepSeekHarnessCommandClient(
      "bot_local_preview",
      repositories.bots.execDebugCommand,
      { createTaskId: () => "dshi-0123456789abcdef0123456789abcdef" },
    );

    await expect(client.getStatus()).resolves.toMatchObject({ installed: false, status: "not-installed" });
    await expect(client.listProviders("cn")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", configured: false, active: true }),
      expect.objectContaining({ id: "qwen-token-plan-cn" }),
    ]));

    await client.saveProvider("deepseek", "sk-preview");
    await expect(client.listProviders("cn")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", configured: true, active: true }),
    ]));

    await client.removeProvider("deepseek");
    await expect(client.listProviders("cn")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek", configured: false, active: true }),
    ]));

    const task = await client.startInstall();
    const observedProgress: number[] = [];
    let installation = await client.getInstallation(task.task_id);
    while (installation.status === "running") {
      observedProgress.push(installation.progress);
      installation = await client.getInstallation(task.task_id);
    }
    observedProgress.push(installation.progress);
    expect(observedProgress).toEqual([
      10, 10, 20, 20, 28, 28, 35, 35, 48, 48, 56, 56,
      68, 68, 75, 75, 85, 85, 95, 95, 99, 99, 100,
    ]);
    expect(installation).toMatchObject({ status: "succeeded", progress: 100 });
    await expect(client.getStatus()).resolves.toMatchObject({ installed: true, status: "running", healthy: true });
    await expect(client.restart()).resolves.toMatchObject({ installed: true, status: "running", healthy: true });
  });
});

describe("explicit sidebar account demo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("localStorage", createMemoryStorage());
    window.history.replaceState({}, "", "/");
  });
  afterEach(() => { window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps default and unrecognized presets empty without upgrade targets", async () => {
    const { plans } = createFakeRepositories();
    expect(await plans.listMyPasses()).toEqual([]);
    window.history.replaceState({}, "", "/account?passState=unknown");
    expect(await plans.listMyPasses()).toEqual([]);
    expect(await plans.listModifyBundles("pass-preview-sidebar-demo")).toEqual({ source_bundle_id: "", modify_bundle_set: [] });
  });

  it("provides a stable active owned demo pass and a matching distinct upgrade target", async () => {
    window.history.replaceState({}, "", "/account?state=default&passState=sidebar-demo");
    const { auth, plans } = createFakeRepositories();
    const session = await auth.getSession();
    const write = vi.spyOn(window.localStorage, "setItem");
    const passes = await plans.listMyPasses();
    expect(passes).toHaveLength(1);
    const pass = passes[0]!;
    expect(pass).toMatchObject({ user_id: session?.user.id, status: "active", credit_total: 1000, credit_available: 750 });
    expect(pass.bundle_name).toContain("演示");
    expect(Date.parse(pass.expired_time)).toBeGreaterThan(Date.now());
    expect(await plans.listMyPasses()).toEqual(passes);
    const result = await plans.listModifyBundles(pass.pass_id);
    expect(result.source_bundle_id).toBe(pass.bundle_id);
    expect(result.modify_bundle_set).toHaveLength(1);
    const target = result.modify_bundle_set[0]!;
    expect(target.target_bundle_id).not.toBe(pass.bundle_id);
    expect(target.bundle.bundle_id).toBe(target.target_bundle_id);
    expect(target.bundle.bundle_name).toContain("演示");
    expect(await plans.listModifyBundles("unknown-pass")).toEqual({ source_bundle_id: "", modify_bundle_set: [] });
    expect(write).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("lightclaw-fake-passes-v1")).toBeNull();
  });

  it("uses the current stored fake session owner instead of a fixed preview owner", async () => {
    window.history.replaceState({}, "", "/account?state=default");
    const { auth, plans } = createFakeRepositories();
    const original = await auth.getSession();
    expect(original).not.toBeNull();
    window.localStorage.setItem("lightclaw-fake-auth-v1", JSON.stringify({ ...original, user: { ...original!.user, id: "demo-owner-b" } }));
    window.history.replaceState({}, "", "/account?passState=sidebar-demo");
    const session = await auth.getSession();
    expect((await plans.listMyPasses())[0]?.user_id).toBe(session?.user.id);
    expect(session?.user.id).toBe("demo-owner-b");
  });

  it("falls back to the existing preview owner without writing an auth or pass record", async () => {
    window.history.replaceState({}, "", "/account?passState=sidebar-demo");
    const { plans } = createFakeRepositories();
    const pass = (await plans.listMyPasses())[0];
    expect(pass?.user_id).toBe("usr_01hxa2f");
    expect(window.localStorage.length).toBe(0);
  });

  it("restores stored passes and empty upgrade options when the explicit query is removed", async () => {
    const stored = { pass_id: "stored-pass", user_id: "stored-owner", bundle_id: "stored-bundle", bundle_name: "Stored", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 50, credit_available: 20 };
    const raw = JSON.stringify([stored]);
    window.localStorage.setItem("lightclaw-fake-passes-v1", raw);
    const { plans } = createFakeRepositories();
    window.history.replaceState({}, "", "/account?passState=sidebar-demo");
    const demo = (await plans.listMyPasses())[0]!;
    expect(demo.pass_id).not.toBe(stored.pass_id);
    window.history.replaceState({}, "", "/account");
    expect(await plans.listMyPasses()).toEqual([stored]);
    expect(await plans.listModifyBundles(stored.pass_id)).toEqual({ source_bundle_id: stored.bundle_id, modify_bundle_set: [] });
    expect(await plans.listModifyBundles(demo.pass_id)).toEqual({ source_bundle_id: "", modify_bundle_set: [] });
    expect(window.localStorage.getItem("lightclaw-fake-passes-v1")).toBe(raw);
  });

  it("continues rejecting upgrade checkout and payment operations in the demo", async () => {
    window.history.replaceState({}, "", "/account?passState=sidebar-demo");
    const { plans } = createFakeRepositories();
    const pass = (await plans.listMyPasses())[0]!;
    expect(pass).toBeDefined();
    const target = (await plans.listModifyBundles(pass.pass_id)).modify_bundle_set[0]!;
    await expect(plans.createModifyOrder(pass.pass_id, { target_bundle_id: target.target_bundle_id })).rejects.toThrow("connected billing service");
    await expect(plans.getModifyOrderUrl(pass.pass_id, { deal_names: ["demo-order"], platform: "pc" })).rejects.toThrow("connected billing service");
    await expect(plans.refreshModifyPaymentAuthorization(pass.pass_id, { deal_names: ["demo-order"] })).rejects.toThrow("connected billing service");
    expect(await plans.getModifyCheckout(pass.pass_id)).toEqual({ checkout: null });
    expect(window.localStorage.length).toBe(0);
  });
});
