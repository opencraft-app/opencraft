import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { setCreditPackVisible } from "../credit-pack-visibility";
import { useAccountSubscriptionModel } from "../use-account-subscription-model";

const mocks = vi.hoisted(() => ({ packages: vi.fn(), passes: vi.fn(), refresh: vi.fn() }));
vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ credit: { listCreditPackages: mocks.packages } }),
}));
vi.mock("@/lib/use-pass-upgrade", () => ({
  usePassUpgrade: () => ({ pass: null, options: [], error: false, retry: vi.fn() }),
}));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));

const pass: Pass = {
  pass_id: "p-a", user_id: "a", bundle_id: "pro", bundle_name: "Pro",
  status: "active", created_time: "2026-01-01", expired_time: "2099-01-01",
  credit_total: 1000, credit_available: 750,
};
const options = {
  userId: "a", activePass: pass, modifyingPass: null, subscription: null,
  planName: "Pro", trialDays: 7, paidBillingActive: true, global: false,
  subscribeHref: "/subscribe", listMyPasses: mocks.passes, refreshPasses: mocks.refresh,
};

beforeEach(() => {
  vi.clearAllMocks();
  setCreditPackVisible(false);
  mocks.packages.mockResolvedValue([
    { credit_type: "paid", credit_total: 1000, credit_available: 750, expired_time: "2099-01-01" },
  ]);
});
afterEach(() => { cleanup(); setCreditPackVisible(false); });

describe("account subscription credit-pack integration", () => {
  it("retains plan-only credits while hidden and combines sources only when enabled", async () => {
    const { result } = renderHook(() => useAccountSubscriptionModel(options));
    await waitFor(() => expect(mocks.packages).toHaveBeenCalledOnce());
    expect(result.current.creditPacks).toBeUndefined();
    expect(result.current.credits).toEqual({ total: 1000, used: 250, usedPercent: 25 });

    act(() => setCreditPackVisible(true));
    await waitFor(() => expect(result.current.creditPacks?.sourceCount).toBe(2));
    expect(result.current.credits).toEqual({ total: 2000, used: 500, usedPercent: 25 });
    expect(result.current.creditPacks?.purchaseHref).toBe("/subscribe?section=credits");

    act(() => setCreditPackVisible(false));
    expect(result.current.creditPacks).toBeUndefined();
    expect(result.current.credits).toEqual({ total: 1000, used: 250, usedPercent: 25 });
  });

  it("retains plan credits after package failure and recovers through the exposed retry", async () => {
    setCreditPackVisible(true);
    mocks.packages.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAccountSubscriptionModel(options));
    await waitFor(() => expect(result.current.creditPacks?.failed).toBe(true));
    expect(result.current.credits).toEqual({ total: 1000, used: 250, usedPercent: 25 });
    act(() => result.current.creditPacks?.onRetry());
    await waitFor(() => expect(result.current.creditPacks?.sourceCount).toBe(2));
    expect(result.current.creditPacks?.failed).toBe(false);
    expect(mocks.packages).toHaveBeenCalledTimes(2);
  });
});
