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
  });

  it("walks the fake FaceID attempt through face, phone, shadow, and final activation", async () => {
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
		expect(phoneResult.state).toBe("shadow_pending");
		expect((await repositories.auth.getCurrentRealnameFaceIdAttempt()).attemptId).toBe(started.attemptId);
		expect((await repositories.auth.finalizeRealnameFaceIdAttempt(started.attemptId)).state).toBe("succeeded");

    const profile = await repositories.auth.getProfile();
    expect(profile.realnameVerified).toBe(true);
    expect(profile.realnameLevel).toBe("phone_3fa");
    expect(profile.realnameSyncStatus).toBe("succeeded");
  });
});
