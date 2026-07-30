import { beforeEach, describe, expect, it, vi } from "vitest";
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
});
