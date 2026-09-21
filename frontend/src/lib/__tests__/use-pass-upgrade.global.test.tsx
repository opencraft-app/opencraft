import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";

vi.mock("@/lib/region", () => ({ isGlobal: true }));
const listMyPasses = vi.fn();
const listModifyBundles = vi.fn();
const plans = { listMyPasses, listModifyBundles };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans }) }));

const host = window as Window & { show?: () => unknown };
const pass: Pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "Launch", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 100, credit_available: 50 };
const option = { target_bundle_id: "target", bundle: { bundle_id: "target", bundle_name: "Cruise", cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { real_total_cost: 100, total_cost: 100, currency: "USD" } };
const quote = { source_bundle_id: "source", modify_bundle_set: [option] };
const input = { userId: "u1", passId: "p1", enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  listMyPasses.mockResolvedValue([pass]);
  listModifyBundles.mockResolvedValue(quote);
});
afterEach(cleanup);

describe("international upgrade availability", () => {
  it("loads eligible targets by default, including an explicit pass ID", async () => {
    const { result } = renderHook(() => usePassUpgrade(input));
    await waitFor(() => expect(result.current.options).toEqual([option]));
    expect(result.current.pass).toEqual(pass);
    expect(result.current.loading).toBe(false);
    expect(listMyPasses).toHaveBeenCalledOnce();
    expect(listModifyBundles).toHaveBeenCalledWith("p1");
  });

  it("retries eligibility without a console gate", async () => {
    const { result } = renderHook(() => usePassUpgrade(input));
    await waitFor(() => expect(result.current.options).toEqual([option]));
    listModifyBundles.mockClear();
    act(() => result.current.retry());
    await waitFor(() => expect(listModifyBundles).toHaveBeenCalledWith("p1"));
  });

  it("loads independently for mounted consumers and SPA remounts", async () => {
    const first = renderHook(() => usePassUpgrade(input));
    const second = renderHook(() => usePassUpgrade(input));
    await waitFor(() => expect(first.result.current.options).toEqual([option]));
    await waitFor(() => expect(second.result.current.options).toEqual([option]));
    first.unmount();
    second.unmount();
    const next = renderHook(() => usePassUpgrade(input));
    await waitFor(() => expect(next.result.current.options).toEqual([option]));
  });

  it("does not expose a response arriving after eligibility is disabled", async () => {
    let resolve!: (value: typeof quote) => void;
    listModifyBundles.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook(
      ({ enabled }) => usePassUpgrade({ ...input, enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(listModifyBundles).toHaveBeenCalled());
    rerender({ enabled: false });
    await act(async () => resolve(quote));
    expect(result.current.options).toEqual([]);
    expect(result.current.pass).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it.each([{ userId: undefined, enabled: true }, { userId: "u1", enabled: false }])("keeps existing eligibility prerequisites: %j", async (prerequisites) => {
    const { result } = renderHook(() => usePassUpgrade(prerequisites));
    await act(async () => {});
    expect(result.current.options).toEqual([]);
    expect(listMyPasses).not.toHaveBeenCalled();
  });

  it("does not replace or depend on the page console show command", async () => {
    const previousShow = host.show;
    const currentShow = vi.fn(() => true);
    host.show = currentShow;
    try {
      const { result } = renderHook(() => usePassUpgrade(input));
      await waitFor(() => expect(result.current.options).toEqual([option]));
      act(() => host.show?.());
      expect(currentShow).toHaveBeenCalledOnce();
      expect(host.show).toBe(currentShow);
      expect(result.current.options).toEqual([option]);
    } finally { host.show = previousShow; }
  });
});
