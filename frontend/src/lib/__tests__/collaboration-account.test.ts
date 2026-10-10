import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCollaborationAccount } from "@/lib/collaboration-account";

const authority = vi.hoisted(() => ({ token: "test-session", base: "https://lightclaw.tech" as string | null }));
vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => authority.base }));
vi.mock("@/repositories/http-repositories", () => ({ readStoredAuthToken: () => authority.token }));

beforeEach(() => { authority.token = "test-session"; authority.base = "https://lightclaw.tech"; });
afterEach(() => vi.unstubAllGlobals());

describe("collaboration account authority", () => {
  it("uses the selected Beijing session without a second credential store", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ready: true })));
    vi.stubGlobal("fetch", fetch);
    await createCollaborationAccount(new AbortController().signal).requestRaw("/v1/collaboration/me/im/session", { method: "POST" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://lightclaw.tech/v1/collaboration/me/im/session");
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-session");
    expect(init.credentials).toBe("include");
  });
  it("rejects Shanghai even when the feature has been shown", async () => {
    authority.base = "https://api.lightvela.com";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createCollaborationAccount(new AbortController().signal).requestRaw("/v1/collaboration/me/im/session", { method: "POST" })).rejects.toThrow("仅在北京测试环境");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects arbitrary paths and a replaced account without sending credentials", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const account = createCollaborationAccount(new AbortController().signal);
    await expect(account.requestRaw("https://elsewhere.example/collect")).rejects.toThrow("路径无效");
    authority.token = "different-session";
    await expect(account.requestRaw("/v1/collaboration/me")).rejects.toThrow("账户已切换");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows a useful unavailable state when the deployment lacks its route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(createCollaborationAccount(new AbortController().signal).requestRaw("/v1/collaboration/me")).rejects.toThrow("尚未开放协作聊天");
  });
});
