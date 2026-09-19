import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { useAccountPassSummary, type AccountPassSummaryOptions } from "../use-account-pass-summary";
import { accountPassCanRenew, accountPassCredits, accountPassDisplayName } from "../account-pass-summary";

afterEach(cleanup);
const pass = (overrides: Partial<Pass> = {}): Pass => ({
  pass_id: "p-a", user_id: "a", status: "active", bundle_id: "b-a", bundle_name: "Plan A",
  created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 100, credit_available: 61, ...overrides,
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe("shared account pass summary", () => {
  it.each([
    ["none", []],
    ["ready", [pass()]],
  ] as const)("retries a failed fallback and recovers to %s", async (expectedState, recoveredPasses) => {
    const listMyPasses = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(recoveredPasses);
    const { result } = renderHook(() => useAccountPassSummary({
      userId: "a",
      activePass: null,
      modifyingPass: null,
      paidBillingActive: true,
      global: false,
      listMyPasses,
    }));

    await waitFor(() => expect(result.current.state).toBe("error"));
    act(() => result.current.retry());
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe(expectedState));
    expect(result.current.pass).toBe(expectedState === "ready" ? recoveredPasses[0] : null);
    expect(listMyPasses).toHaveBeenCalledTimes(2);
  });

  it("uses modifying, active, then first owned nondeleted fallback without mixing credits", async () => {
    const activePass = pass();
    const modifyingPass = pass({ pass_id: "modifying", status: "modifying", credit_total: 250, credit_available: 45 });
    const first = pass({ pass_id: "expired", expired_time: "2020-01-01", credit_total: 70, credit_available: 5 });
    const listMyPasses = vi.fn().mockResolvedValue([pass({ user_id: "other" }), pass({ deleted_time: "2026-01-01" }), first, pass({ pass_id: "second" })]);
    const { result, rerender } = renderHook<ReturnType<typeof useAccountPassSummary>, Pick<AccountPassSummaryOptions, "activePass" | "modifyingPass">>(({ activePass, modifyingPass }) => useAccountPassSummary({ userId: "a", activePass, modifyingPass, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { activePass, modifyingPass } });
    expect(result.current.pass).toBe(modifyingPass);
    expect(result.current.credits).toEqual({ total: 250, available: 45, used: 205, usedPercent: 82 });
    rerender({ activePass, modifyingPass: null });
    expect(result.current.pass).toBe(activePass);
    expect(result.current.credits?.used).toBe(39);
    expect(listMyPasses).not.toHaveBeenCalled();
    rerender({ activePass: null, modifyingPass: null });
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.pass).toBe(first));
    expect(result.current.credits).toEqual({ total: 70, available: 5, used: 65, usedPercent: 93 });
  });

  it("synchronously hides stale context and ignores late fallback across account changes", async () => {
    const a = deferred<Pass[]>(); const b = deferred<Pass[]>();
    const listMyPasses = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result, rerender } = renderHook<ReturnType<typeof useAccountPassSummary>, Pick<AccountPassSummaryOptions, "userId" | "activePass" | "modifyingPass">>(({ userId, activePass, modifyingPass }) => useAccountPassSummary({ userId, activePass, modifyingPass, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { userId: "a", activePass: null, modifyingPass: null } });
    rerender({ userId: "b", activePass: pass(), modifyingPass: pass({ status: "modifying" }) });
    expect(result.current.pass).toBeNull();
    expect(result.current.credits).toBeNull();
    expect(listMyPasses).toHaveBeenCalledTimes(2);
    await act(async () => a.resolve([pass()]));
    expect(result.current.pass).toBeNull();
    await act(async () => b.reject(new Error("offline")));
    expect(result.current.state).toBe("error");
    expect(result.current.credits).toBeNull();
  });

  it("filters response owners while preserving list order", async () => {
    const own = pass({ user_id: "b", pass_id: "b-first", isolated_time: "2026-01-01" });
    const listMyPasses = vi.fn().mockResolvedValue([pass(), own, pass({ user_id: "b", pass_id: "b-second" })]);
    const { result } = renderHook(() => useAccountPassSummary({ userId: "b", activePass: null, modifyingPass: null, paidBillingActive: true, global: false, listMyPasses }));
    await waitFor(() => expect(result.current.pass).toBe(own));
  });

  it("rejects late fallback through modifying A to B to null without an active pass", async () => {
    const a = deferred<Pass[]>(); const b = deferred<Pass[]>(); const latest = deferred<Pass[]>();
    const listMyPasses = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook<ReturnType<typeof useAccountPassSummary>, Pick<AccountPassSummaryOptions, "modifyingPass">>(({ modifyingPass }) => useAccountPassSummary({ userId: "a", activePass: null, modifyingPass, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { modifyingPass: pass({ status: "modifying" }) } });
    rerender({ modifyingPass: pass({ pass_id: "p-b", status: "modifying", bundle_id: "b-b" }) });
    rerender({ modifyingPass: null });
    await act(async () => a.resolve([pass()]));
    expect(result.current.pass).toBeNull();
    expect(result.current.credits).toBeNull();
    expect(listMyPasses).toHaveBeenCalledTimes(3);
    const refreshed = pass({ pass_id: "p-b", bundle_id: "b-b" });
    await act(async () => latest.resolve([refreshed]));
    await act(async () => b.resolve([pass()]));
    expect(result.current.pass).toBe(refreshed);
  });

  it.each([
    { userId: undefined, global: false, paidBillingActive: true, enabled: true },
    { userId: "a", global: false, paidBillingActive: false, enabled: true },
    { userId: "a", global: true, paidBillingActive: true, enabled: false },
  ])("does not fetch or invent zero credit without an enabled authenticated fallback: %j", (input) => {
    const listMyPasses = vi.fn();
    const { result } = renderHook(() => useAccountPassSummary({ ...input, activePass: null, modifyingPass: null, listMyPasses }));
    expect(listMyPasses).not.toHaveBeenCalled();
    expect(result.current.credits).toBeNull();
    expect(result.current.state).toBe("idle");
  });

  it("still loads global fallback while paid billing is disabled, distinguishing none from a real zero", async () => {
    const listMyPasses = vi.fn().mockResolvedValue([]);
    const { result, rerender } = renderHook<ReturnType<typeof useAccountPassSummary>, Pick<AccountPassSummaryOptions, "activePass">>(({ activePass }) => useAccountPassSummary({ userId: "a", activePass, modifyingPass: null, paidBillingActive: false, global: true, listMyPasses }), { initialProps: { activePass: null } });
    await waitFor(() => expect(result.current.state).toBe("none"));
    expect(result.current.credits).toBeNull();
    rerender({ activePass: pass({ credit_total: 0, credit_available: 0 }) });
    expect(result.current.state).toBe("ready");
    expect(result.current.credits).toEqual({ total: 0, available: 0, used: 0, usedPercent: 0 });
  });

  it("clear after success rejects pending fallback without starting another request", async () => {
    const pending = deferred<Pass[]>(); const listMyPasses = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useAccountPassSummary({ userId: "a", activePass: null, modifyingPass: null, paidBillingActive: true, global: false, listMyPasses }));
    act(() => result.current.clearFallback());
    await act(async () => pending.resolve([pass()]));
    expect(result.current.pass).toBeNull();
    expect(result.current.state).toBe("none");
    expect(listMyPasses).toHaveBeenCalledTimes(1);
  });

  it("does not expose cached credits immediately after signing out", async () => {
    const listMyPasses = vi.fn().mockResolvedValue([pass()]);
    const { result, rerender } = renderHook<ReturnType<typeof useAccountPassSummary>, Pick<AccountPassSummaryOptions, "userId">>(({ userId }) => useAccountPassSummary({ userId, activePass: null, modifyingPass: null, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { userId: "a" } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    rerender({ userId: undefined });
    expect(result.current.pass).toBeNull();
    expect(result.current.credits).toBeNull();
    expect(listMyPasses).toHaveBeenCalledTimes(1);
  });

  it("does not let an old A clear remove the fresh A result after A to B to A", async () => {
    const freshA = pass({ pass_id: "p-a-new", credit_available: 22 });
    const listMyPasses = vi.fn().mockResolvedValueOnce([pass()]).mockResolvedValueOnce([pass({ user_id: "b", pass_id: "p-b" })]).mockResolvedValueOnce([freshA]);
    const { result, rerender } = renderHook(({ userId }) => useAccountPassSummary({ userId, activePass: null, modifyingPass: null, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { userId: "a" } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const oldClear = result.current.clearFallback;
    rerender({ userId: "b" });
    await waitFor(() => expect(result.current.pass?.pass_id).toBe("p-b"));
    rerender({ userId: "a" });
    await waitFor(() => expect(result.current.pass).toBe(freshA));
    act(oldClear);
    expect(result.current.pass).toBe(freshA);
    expect(result.current.credits?.available).toBe(22);
  });

  it("does not let an old A clear cancel the new A pending request after A to B to A", async () => {
    const latest = deferred<Pass[]>();
    const listMyPasses = vi.fn().mockResolvedValueOnce([pass()]).mockResolvedValueOnce([pass({ user_id: "b", pass_id: "p-b" })]).mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(({ userId }) => useAccountPassSummary({ userId, activePass: null, modifyingPass: null, paidBillingActive: true, global: false, listMyPasses }), { initialProps: { userId: "a" } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const oldClear = result.current.clearFallback;
    rerender({ userId: "b" });
    await waitFor(() => expect(result.current.pass?.pass_id).toBe("p-b"));
    rerender({ userId: "a" });
    act(oldClear);
    expect(result.current.state).toBe("loading");
    const freshA = pass({ pass_id: "p-a-new", credit_available: 22 });
    await act(async () => latest.resolve([freshA]));
    expect(result.current.pass).toBe(freshA);
    expect(listMyPasses).toHaveBeenCalledTimes(3);
  });

  it("shares account credit rounding and name precedence", () => {
    expect(accountPassCredits(pass({ credit_available: -25 }))).toEqual({ total: 100, available: -25, used: 125, usedPercent: 100 });
    expect(accountPassCredits(pass({ credit_available: 120 }))?.used).toBe(0);
    expect(accountPassCredits(null)).toBeNull();
    expect(accountPassDisplayName(pass(), "sub", "legacy")).toBe("Plan A");
    expect(accountPassDisplayName(null, "sub", "legacy")).toBe("sub");
    expect(accountPassDisplayName(null, null, "legacy")).toBe("legacy");
  });

  it("retains the account outer renewal gate used by upgrade shortcuts", () => {
    expect(accountPassCanRenew(pass(), false, true)).toBe(true);
    expect(accountPassCanRenew(pass({ status: "modifying" }), true, true)).toBe(false);
    expect(accountPassCanRenew(pass(), false, false)).toBe(false);
    expect(accountPassCanRenew(pass({ isolated_time: "2026-01-01" }), true, false)).toBe(true);
    expect(accountPassCanRenew(pass({ deleted_time: "2026-01-01" }), true, true)).toBe(false);
  });
});
