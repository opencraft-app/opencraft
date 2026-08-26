import { beforeEach, describe, expect, it, vi } from "vitest";
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
