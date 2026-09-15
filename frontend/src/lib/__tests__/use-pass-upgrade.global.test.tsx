import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";
import { installOpenClawConsoleHelpers } from "@/pages/marketing/agent-console-helpers";

vi.mock("@/lib/region", () => ({ isGlobal: true }));
const listMyPasses = vi.fn();
const listModifyBundles = vi.fn();
const plans = { listMyPasses, listModifyBundles };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans }) }));

const host = window as Window & { console: Console; show?: () => unknown; hide?: () => unknown };
const pass: Pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "Launch", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 100, credit_available: 50 };
const option = { target_bundle_id: "target", bundle: { bundle_id: "target", bundle_name: "Cruise", cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { real_total_cost: 100, total_cost: 100, currency: "USD" } };
const quote = { source_bundle_id: "source", modify_bundle_set: [option] };
const input = { userId: "u1", passId: "p1", enabled: true };

beforeEach(() => {
  host.hide?.();
  vi.clearAllMocks();
  listMyPasses.mockResolvedValue([pass]);
  listModifyBundles.mockResolvedValue(quote);
});
afterEach(() => { act(() => host.hide?.()); cleanup(); });

describe("international upgrade console opt-in", () => {
  it("hides eligibility by default, including an explicit pass ID", async () => {
    const { result } = renderHook(() => usePassUpgrade(input));
    await act(async () => {});
    expect(result.current.pass).toBeNull();
    expect(result.current.options).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(listMyPasses).not.toHaveBeenCalled();
    expect(listModifyBundles).not.toHaveBeenCalled();
  });

  it("reveals eligible targets with show and clears them immediately with hide", async () => {
    const { result } = renderHook(() => usePassUpgrade(input));
    act(() => host.show?.());
    await waitFor(() => expect(result.current.options).toEqual([option]));
    const visibleKey = result.current.revisionKey;
    act(() => host.hide?.());
    expect(result.current.pass).toBeNull();
    expect(result.current.options).toEqual([]);
    expect(result.current.revisionKey).not.toBe(visibleKey);
    listModifyBundles.mockClear();
    act(() => result.current.retry());
    expect(listModifyBundles).not.toHaveBeenCalled();
    act(() => host.show?.());
    await waitFor(() => expect(result.current.options).toEqual([option]));
  });

  it("shares opt-in across mounted consumers and SPA remounts", async () => {
    const first = renderHook(() => usePassUpgrade(input));
    const second = renderHook(() => usePassUpgrade(input));
    act(() => host.show?.());
    await waitFor(() => expect(first.result.current.options).toEqual([option]));
    await waitFor(() => expect(second.result.current.options).toEqual([option]));
    first.unmount();
    second.unmount();
    const next = renderHook(() => usePassUpgrade(input));
    await waitFor(() => expect(next.result.current.options).toEqual([option]));
  });

  it("does not restore targets from a response arriving after hide", async () => {
    let resolve!: (value: typeof quote) => void;
    listModifyBundles.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => usePassUpgrade(input));
    act(() => host.show?.());
    await waitFor(() => expect(listModifyBundles).toHaveBeenCalled());
    act(() => host.hide?.());
    await act(async () => resolve(quote));
    expect(result.current.options).toEqual([]);
    expect(result.current.pass).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it.each([{ userId: undefined, enabled: true }, { userId: "u1", enabled: false }])("keeps existing eligibility prerequisites after show: %j", async (prerequisites) => {
    const { result } = renderHook(() => usePassUpgrade(prerequisites));
    act(() => host.show?.());
    await act(async () => {});
    expect(result.current.options).toEqual([]);
    expect(listMyPasses).not.toHaveBeenCalled();
  });

  it("preserves the existing Agent console show callback", async () => {
    const onShowHiddenTools = vi.fn();
    const restore = installOpenClawConsoleHelpers({ host, getTerminalPath: () => null, onShowHiddenTools });
    try {
      const { result } = renderHook(() => usePassUpgrade(input));
      act(() => host.show?.());
      await waitFor(() => expect(result.current.options).toEqual([option]));
      expect(onShowHiddenTools).toHaveBeenCalledOnce();
      act(() => host.hide?.());
      expect(result.current.options).toEqual([]);
    } finally { restore(); }
  });

  it("attaches to the current console command when a page mounts and restores it on unmount", async () => {
    const previousShow = host.show;
    const currentShow = vi.fn(() => true);
    host.show = currentShow;
    try {
      const { result, unmount } = renderHook(() => usePassUpgrade(input));
      act(() => host.show?.());
      await waitFor(() => expect(result.current.options).toEqual([option]));
      expect(currentShow).toHaveBeenCalledOnce();
      act(() => host.hide?.());
      unmount();
      expect(host.show).toBe(currentShow);
    } finally { host.show = previousShow; }
  });
});
