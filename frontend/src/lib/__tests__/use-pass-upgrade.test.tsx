import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";
import { readUpgradeCheckout, saveUpgradeCheckout } from "@/lib/upgrade-checkout";
import { setConsoleShowEnabled } from "@/lib/console-show-event";

const listMyPasses = vi.fn();
const listModifyBundles = vi.fn();
const getModifyCheckout = vi.fn();
const plans = { listMyPasses, listModifyBundles, getModifyCheckout };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans }) }));
const pass: Pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "Source", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 1, credit_available: 1 };
const target = { target_bundle_id: "other-sp", bundle: { bundle_id: "other-sp", bundle_name: "Target", cpu: 4, memory: 4, system_disk_size: 40, credit: 100 }, modify_price: { real_total_cost: 100, total_cost: 100, currency: "CNY" } };
beforeEach(() => { vi.resetAllMocks(); const entries = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) }); setConsoleShowEnabled(false); listMyPasses.mockResolvedValue([pass]); listModifyBundles.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [target] }); getModifyCheckout.mockResolvedValue({ checkout: null }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("upgrade eligibility", () => {
  it.each(["lightvela.com", "www.lightvela.com", "lightvela.ai", "www.lightvela.ai"])("keeps upgrade hidden on %s until show() without recovering an order", async (hostname) => {
    vi.stubGlobal("location", { hostname });
    saveUpgradeCheckout(window.localStorage, "u1", "p1", { targetBundleId: "other-sp", phase: "ordered", dealName: "old-order" });
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p1", enabled: true }));
    expect(result.current.options).toEqual([]);
    expect(listModifyBundles).not.toHaveBeenCalled();
    act(() => { (window as Window & { show: () => boolean }).show(); });
    await waitFor(() => expect(result.current.options).toEqual([target]));
    expect(result.current.pass?.pass_id).toBe("p1");
    expect(listModifyBundles).toHaveBeenCalledWith("p1");
    expect(getModifyCheckout).not.toHaveBeenCalled();
  });
  it.each([
    { userId: undefined, enabled: true },
    { userId: "u1", enabled: false },
  ])("does not query eligibility without a signed-in user or enabled billing: %j", (input) => {
    const { result } = renderHook(() => usePassUpgrade(input));
    expect(result.current.pass).toBeNull();
    expect(result.current.options).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(listMyPasses).not.toHaveBeenCalled();
    expect(listModifyBundles).not.toHaveBeenCalled();
  });
  it("automatically loads backend targets without assuming an SP relationship", async () => {
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true }));
    await waitFor(() => expect(result.current.options).toEqual([target]));
    expect(result.current.pass?.pass_id).toBe("p1");
  });
  it("does not choose an arbitrary pass when several are active", async () => {
    listMyPasses.mockResolvedValue([pass, { ...pass, pass_id: "p2" }]);
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pass).toBeNull();
    expect(listModifyBundles).not.toHaveBeenCalled();
  });
  it("matches explicit ID and never queries another user's pass", async () => {
    listMyPasses.mockResolvedValue([pass, { ...pass, pass_id: "p2", user_id: "u2" }]);
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p2", enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.options).toEqual([]);
    expect(listModifyBundles).not.toHaveBeenCalled();
  });
  it("exposes a query error and retries", async () => {
    listModifyBundles.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true }));
    await waitFor(() => expect(result.current.error).toBe(true));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.options).toEqual([target]));
  });
  it("clears old targets immediately when account changes", async () => {
    const { result, rerender } = renderHook(({ userId }) => usePassUpgrade({ userId, enabled: true }), { initialProps: { userId: "u1" } });
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    rerender({ userId: "u2" });
    expect(result.current.options).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
  it("invalidates on source pass isolation and rejects mismatched source data", async () => {
    const { result, rerender } = renderHook(({ currentPass }) => usePassUpgrade({ userId: "u1", enabled: true, currentPass }), { initialProps: { currentPass: pass } });
    await waitFor(() => expect(result.current.options).toHaveLength(1));
    rerender({ currentPass: { ...pass, isolated_time: "2026-09-09" } });
    expect(result.current.options).toEqual([]);
  });
  it("selects the requested pass among multiple own active passes", async () => {
    listMyPasses.mockResolvedValue([pass, { ...pass, pass_id: "p2" }]);
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p2", enabled: true }));
    await waitFor(() => expect(result.current.pass?.pass_id).toBe("p2"));
  });
  it("reports mismatched source data rather than enabling a stale target", async () => {
    listModifyBundles.mockResolvedValue({ source_bundle_id: "stale", modify_bundle_set: [target] });
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true }));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.options).toEqual([]);
  });
  it("ignores an in-flight eligibility result after sign out", async () => {
    let resolve!: (value: unknown) => void;
    listModifyBundles.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result, rerender } = renderHook(({ enabled }) => usePassUpgrade({ userId: "u1", enabled }), { initialProps: { enabled: true } });
    await waitFor(() => expect(listModifyBundles).toHaveBeenCalled());
    rerender({ enabled: false });
    await act(async () => { resolve({ source_bundle_id: "source", modify_bundle_set: [target] }); });
    expect(result.current.options).toEqual([]);
    expect(result.current.pass).toBeNull();
  });
  it("clears eligibility when its source expires while the page stays open", async () => {
    vi.useFakeTimers();
    const expiring = { ...pass, expired_time: new Date(Date.now() + 1000).toISOString() };
    listMyPasses.mockResolvedValue([expiring]);
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true, currentPass: expiring }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.options).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(result.current.options).toEqual([]);
  });
  it("does not restore a pending checkout or offer another upgrade while modifying", async () => {
    const modifying = { ...pass, status: "modifying" };
    listMyPasses.mockResolvedValue([modifying]);
    saveUpgradeCheckout(window.localStorage, "u1", "p1", { targetBundleId: "target", dealName: "deal", phase: "ordered" });
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p1", enabled: true, currentPass: modifying }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pass).toBeNull();
    expect(result.current.options).toEqual([]);
    expect(listModifyBundles).not.toHaveBeenCalled();
  });
  it("does not query server checkout or overwrite a local unknown submission", async () => {
    listMyPasses.mockResolvedValue([{ ...pass, status: "modifying" }]);
    getModifyCheckout.mockResolvedValue({ checkout: { deal_name: "server-deal", target_bundle_id: "server-target", big_order_id: "big", local_status: "pending" } });
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p1", enabled: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.pass).toBeNull();
    expect(getModifyCheckout).not.toHaveBeenCalled();
    saveUpgradeCheckout(window.localStorage, "u1", "p1", { targetBundleId: "stale-target", phase: "creating" });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(readUpgradeCheckout(window.localStorage, "u1", "p1")?.targetBundleId).toBe("stale-target");
  });
  it("preserves an unknown local creating record when the server has no recoverable order", async () => {
    saveUpgradeCheckout(window.localStorage, "u1", "p1", { targetBundleId: "target", phase: "creating" });
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", passId: "p1", enabled: true }));
    await waitFor(() => expect(result.current.options).toEqual([target]));
    expect(readUpgradeCheckout(window.localStorage, "u1", "p1")?.phase).toBe("creating");
  });
  it("does not let historical order recovery block eligibility", async () => {
    getModifyCheckout.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => usePassUpgrade({ userId: "u1", enabled: true }));
    await waitFor(() => expect(result.current.options).toEqual([target]));
    expect(getModifyCheckout).not.toHaveBeenCalled();
  });
});
