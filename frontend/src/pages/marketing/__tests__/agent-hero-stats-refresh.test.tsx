import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHeroStats } from "../agent-hero-stats";
import { listCronJobs } from "@/lib/hermes-cron-client";

vi.mock("@/lib/hermes-cron-client", () => ({ listCronJobs: vi.fn() }));
vi.mock("@/pages/marketing/agent-automations-panel", () => ({ isCronJobExpired: () => false }));
vi.mock("@/lib/auth-api-base", () => ({ resolveConfiguredAuthApiBaseUrl: () => "" }));
vi.mock("@/repositories/http-repositories", () => ({ readStoredAuthToken: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const jobs = [{ id: "first" }, { id: "second" }] as Awaited<ReturnType<typeof listCronJobs>>;

describe("overview cron refresh", () => {
  it("reloads after setup on the same Bot and rejects stale responses", async () => {
    const list = vi.mocked(listCronJobs).mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(({ revision }) => useHeroStats({
      activePass: null, botId: "bot-new", profileId: "research", refreshKey: revision,
    }), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.automations).toBe(0));
    let resolveOld!: (value: typeof jobs) => void;
    list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    rerender({ revision: 1 });
    list.mockResolvedValueOnce(jobs);
    rerender({ revision: 2 });
    await waitFor(() => expect(result.current.automations).toBe(2));
    await act(async () => resolveOld([]));
    expect(result.current.automations).toBe(2);
    expect(list).toHaveBeenLastCalledWith({ instanceId: "bot-new", profileId: "research" }, { hydrateContextFrom: false });
  });
});
