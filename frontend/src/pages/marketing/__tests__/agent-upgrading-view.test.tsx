import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bundle, Pass, PassModifyCheckout } from "@/domain/types";
import { AgentUpgradingView } from "../agent-upgrading-view";

const { getModifyCheckout, listBundles } = vi.hoisted(() => ({ getModifyCheckout: vi.fn(), listBundles: vi.fn() }));
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans: { getModifyCheckout, listBundles } }) }));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));

const pass: Pass = {
  pass_id: "pass-launch", user_id: "u1", bundle_id: "launch", bundle_name: "启航 Launch AI",
  status: "modifying", credit_total: 5000, credit_available: 2000,
  created_time: "2026-09-01T00:00:00Z", expired_time: "2026-10-01T00:00:00Z",
};
const checkout = (target = "cruise"): PassModifyCheckout => ({ checkout: {
  target_bundle_id: target, deal_name: "modify-order", big_order_id: "modify-big", local_status: "paid_pending_provision",
} });
const bundle = (id: string, name: string): Bundle => ({
  bundle_id: id, bundle_name: name, description: [], bundle_state: "ONLINE", agent_quota: 1,
  credit: 10000, time_span: 1, time_unit: "m",
  bundle_sales_available_count: 1, bundle_sales_total_count: 1, bundle_sales_state: "AVAILABLE",
});
const mount = async (selected = pass) => {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<AgentUpgradingView pass={selected} />); });
  return view;
};

describe("Agent upgrade target summary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
    getModifyCheckout.mockResolvedValue(checkout());
    listBundles.mockResolvedValue([bundle("launch", "启航 Launch AI"), bundle("cruise", "巡游 Cruise AI")]);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("restores the order's target on a fresh page and omits model credits", async () => {
    await mount();
    expect(screen.getByText("目标套餐")).toBeInTheDocument();
    expect(screen.getByText("巡游 Cruise AI")).toBeInTheDocument();
    expect(screen.queryByText("启航 Launch AI")).not.toBeInTheDocument();
    expect(screen.queryByText("当前套餐")).not.toBeInTheDocument();
    expect(screen.queryByText("模型积分")).not.toBeInTheDocument();
    expect(screen.getByText("到期时间")).toBeInTheDocument();
    expect(getModifyCheckout).toHaveBeenCalledWith(pass.pass_id);
    expect(listBundles).toHaveBeenCalledWith();
  });

  it.each(["missing-checkout", "missing-bundle", "offline"])("never labels the old plan as the target when %s, and retries", async (mode) => {
    if (mode === "missing-checkout") getModifyCheckout.mockResolvedValueOnce({ checkout: null });
    if (mode === "missing-bundle") listBundles.mockResolvedValueOnce([bundle("launch", "启航 Launch AI")]);
    if (mode === "offline") getModifyCheckout.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(screen.queryByText("启航 Launch AI")).not.toBeInTheDocument();
    expect(screen.queryByText("巡游 Cruise AI")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("巡游 Cruise AI")).toBeInTheDocument();
    const reads = getModifyCheckout.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(getModifyCheckout).toHaveBeenCalledTimes(reads);
  });

  it("discards late metadata after switching passes", async () => {
    let resolveOld!: (value: PassModifyCheckout) => void;
    getModifyCheckout.mockImplementationOnce(() => new Promise<PassModifyCheckout>(resolve => { resolveOld = resolve; }));
    const view = await mount();
    getModifyCheckout.mockResolvedValue(checkout("voyage"));
    listBundles.mockResolvedValue([bundle("voyage", "远航 Voyage AI")]);
    await act(async () => { view.rerender(<AgentUpgradingView pass={{ ...pass, pass_id: "pass-other" }} />); });
    expect(screen.getByText("远航 Voyage AI")).toBeInTheDocument();
    await act(async () => { resolveOld(checkout()); });
    expect(screen.getByText("远航 Voyage AI")).toBeInTheDocument();
    expect(screen.queryByText("巡游 Cruise AI")).not.toBeInTheDocument();
  });
});
