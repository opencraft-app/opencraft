import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import type { DashboardSnapshot } from "@/repositories/types";
import { OpenClawProvider, useOpenClaw } from "../agent-context";

const { listMyPasses, getOrderStatus, getDashboardSnapshot, session } = vi.hoisted(() => ({
  listMyPasses: vi.fn(),
  getOrderStatus: vi.fn(),
  getDashboardSnapshot: vi.fn(),
  session: { authReady: true, user: { id: "u1", name: "User" }, currentSubscription: null },
}));
vi.mock("@/lib/region", () => ({ isGlobal: true }));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ isAuthenticated: true, session, signOut: vi.fn() }),
}));
vi.mock("@/contexts/repository-context", () => {
  const repositories = { plans: { listMyPasses, getOrderStatus }, bots: { getDashboardSnapshot } };
  return { useRepositories: () => repositories };
});

const modifyingPass: Pass = {
  pass_id: "p1", user_id: "u1", bundle_id: "launch", bundle_name: "启航套餐",
  status: "modifying", created_time: "2026-09-01T00:00:00Z", expired_time: "2026-10-01T00:00:00Z",
  credit_total: 100, credit_available: 80,
};
const snapshot = (name: string): DashboardSnapshot => ({
  bots: [{ id: "b1", name, type: "ops", template: "", status: "active", createdAt: "2026-09-01T00:00:00Z" }],
  runtime: null, alerts: [], deployments: [], releases: [],
  billing: { tier: "free", monthCost: 0, budgetLimit: 0, estimatedMonthEnd: 0, tokenSpend: 0, runMinutes: 0 },
});
let currentState: ReturnType<typeof useOpenClaw>;
function Probe() {
  const state = useOpenClaw();
  currentState = state;
  return <>
    <button onClick={() => state.beginPassUpgrade({ ...modifyingPass, status: "active" }, { dealName: "paid-order", targetBundleId: "cruise" })}>支付成功</button>
    <p role="status">{state.passUpgradeFailed ? "升级失败" : state.modifyingPass ? "升级中" : "已就绪"}</p>
    <p>{state.activePass?.bundle_name}</p>
    <p>{state.bots[0]?.name}</p>
  </>;
}
const mount = async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<OpenClawProvider><Probe /></OpenClawProvider>); });
  return view;
};

describe("Pass modification refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    vi.resetAllMocks();
    session.user = { id: "u1", name: "User" };
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    window.history.replaceState({}, "", "/agents/");
    listMyPasses.mockResolvedValue([modifyingPass]);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "paid", local_status: "paid_pending_provision", source: "local" });
    getDashboardSnapshot.mockResolvedValue(snapshot("升级前 Agent"));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

  it("ignores user A's late payment callback after the session changes to user B", async () => {
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    const view = await mount();
    const lateCallback = currentState.beginPassUpgrade;
    session.user = { id: "u2", name: "User B" };
    listMyPasses.mockResolvedValue([{ ...modifyingPass, pass_id: "p2", user_id: "u2", status: "active", bundle_name: "B 套餐" }]);
    await act(async () => { view.rerender(<OpenClawProvider><Probe /></OpenClawProvider>); await currentState.refreshPasses(); });
    const before = { active: currentState.activePass, subscribed: currentState.isSubscribed, bots: currentState.bots };
    await act(async () => { lateCallback(modifyingPass, { dealName: "paid-order", targetBundleId: "cruise" }); });
    expect(currentState.modifyingPass).toBeNull();
    expect(currentState.activePass).toEqual(before.active);
    expect(currentState.isSubscribed).toBe(before.subscribed);
    expect(currentState.bots).toEqual(before.bots);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(getOrderStatus).not.toHaveBeenCalled();
  });

  it("retains an expired modifying pass for the waiting UI", async () => {
    listMyPasses.mockResolvedValue([{ ...modifyingPass, expired_time: "2026-09-10T00:00:00Z" }]);
    await mount();
    expect(currentState.modifyingPass?.pass_id).toBe("p1");
    expect(currentState.activePass?.status).toBe("modifying");
    expect(currentState.isSubscribed).toBe(true);
  });

  it("pauses a missing return pass after 60 seconds and retries the same order to delivery", async () => {
    const key = "lightvela-upgrade-return-v1:u1:paid-order";
    localStorage.setItem(key, JSON.stringify({ passId: "p1", targetBundleId: "cruise", dealName: "paid-order", createdAt: Date.now() }));
    window.history.replaceState({}, "", "/agents/?upgrade_return=paid-order");
    listMyPasses.mockResolvedValue([]);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(currentState.passUpgradePaused).toBe(true);
    expect(currentState.passesLoading).toBe(true);
    expect(currentState.passUpgradeFailed).toBe(false);
    expect(localStorage.getItem(key)).not.toBeNull();
    const reads = listMyPasses.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
    expect(listMyPasses).toHaveBeenCalledTimes(reads);
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_id: "cruise" }]);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "success", local_status: "provisioned", source: "local" });
    await act(async () => { await currentState.retryPassUpgrade(); });
    expect(currentState.passUpgradePaused).toBe(false);
    expect(currentState.modifyingPass).toBeNull();
    expect(currentState.passesLoading).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("pauses continuous query failures without marking payment failed, then recovers", async () => {
    await mount();
    listMyPasses.mockRejectedValue(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(63000); });
    expect(currentState.passUpgradePaused).toBe(true);
    expect(currentState.modifyingPass?.pass_id).toBe("p1");
    expect(currentState.passUpgradeFailed).toBe(false);
    const reads = listMyPasses.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(listMyPasses).toHaveBeenCalledTimes(reads);
    listMyPasses.mockResolvedValue([modifyingPass]);
    await act(async () => { await currentState.retryPassUpgrade(); });
    expect(currentState.passUpgradePaused).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(listMyPasses.mock.calls.length).toBeGreaterThan(reads + 1);
  });

  it("does not pause a healthy modifying pass after 60 seconds", async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
    expect(currentState.passUpgradePaused).toBe(false);
    expect(currentState.modifyingPass?.pass_id).toBe("p1");
    expect(listMyPasses.mock.calls.length).toBeGreaterThan(20);
  });

  it("leaves retry available after a stuck request and ignores its eventual stale response", async () => {
    await mount();
    let resolveStuck!: (passes: Pass[]) => void;
    listMyPasses.mockImplementationOnce(() => new Promise<Pass[]>(resolve => { resolveStuck = resolve; }));
    let stuck!: Promise<void>;
    await act(async () => { stuck = currentState.retryPassUpgrade(); });
    expect(currentState.passUpgradeRefreshing).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(currentState.passUpgradePaused).toBe(true);
    expect(currentState.passUpgradeRefreshing).toBe(false);
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_name: "恢复后的套餐" }]);
    await act(async () => { await currentState.retryPassUpgrade(); });
    expect(currentState.activePass?.bundle_name).toBe("恢复后的套餐");
    await act(async () => { resolveStuck([modifyingPass]); await stuck; });
    expect(currentState.modifyingPass).toBeNull();
    expect(currentState.activePass?.bundle_name).toBe("恢复后的套餐");
  });

  it("clears the upgrade deadline on logout even before the session response arrives", async () => {
    await mount();
    listMyPasses.mockRejectedValue(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); currentState.logout(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(63000); });
    expect(currentState.passUpgradePaused).toBe(false);
    expect(currentState.modifyingPass).toBeNull();
  });

  it("coalesces manual refreshes into one trailing read and awaits its result", async () => {
    await mount();
    let resolvePoll!: (passes: Pass[]) => void;
    let resolveManual!: (passes: Pass[]) => void;
    listMyPasses.mockImplementationOnce(() => new Promise<Pass[]>(resolve => { resolvePoll = resolve; }))
      .mockImplementationOnce(() => new Promise<Pass[]>(resolve => { resolveManual = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    let completed = 0;
    let requests!: Promise<void>[];
    await act(async () => { requests = [currentState.refreshPasses(), currentState.refreshPasses()]; requests.forEach(p => { void p.then(() => { completed += 1; }); }); });
    expect(completed).toBe(0);
    await act(async () => { resolvePoll([modifyingPass]); });
    expect(completed).toBe(0);
    expect(listMyPasses).toHaveBeenCalledTimes(3);
    await act(async () => { resolveManual([{ ...modifyingPass, status: "active", bundle_name: "新套餐" }]); await Promise.all(requests); });
    expect(completed).toBe(2);
    expect(currentState.activePass?.bundle_name).toBe("新套餐");
  });

  it("does not let an old account's request block or overwrite the next account", async () => {
    let resolveOld!: (passes: Pass[]) => void;
    listMyPasses.mockImplementationOnce(() => new Promise<Pass[]>(resolve => { resolveOld = resolve; }));
    const view = await mount();
    session.user = { id: "u2", name: "User B" };
    listMyPasses.mockResolvedValue([{ ...modifyingPass, user_id: "u2", pass_id: "p2", status: "active", bundle_name: "B 套餐" }]);
    await act(async () => { view.rerender(<OpenClawProvider><Probe /></OpenClawProvider>); });
    expect(currentState.activePass?.user_id).toBe("u2");
    await act(async () => { resolveOld([modifyingPass]); });
    expect(currentState.activePass?.user_id).toBe("u2");
    expect(currentState.modifyingPass).toBeNull();
  });

  it("does not start a queued query after the Provider unmounts", async () => {
    const view = await mount();
    let resolvePoll!: (passes: Pass[]) => void;
    listMyPasses.mockImplementationOnce(() => new Promise<Pass[]>(resolve => { resolvePoll = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    let queued!: Promise<void>;
    await act(async () => { queued = currentState.refreshPasses(); });
    view.unmount();
    const reads = listMyPasses.mock.calls.length;
    await act(async () => { resolvePoll([modifyingPass]); await queued; });
    await act(async () => { await vi.advanceTimersByTimeAsync(63000); });
    expect(listMyPasses).toHaveBeenCalledTimes(reads);
  });

  it("still loads the current pass under StrictMode effect replay", async () => {
    await act(async () => { render(<StrictMode><OpenClawProvider><Probe /></OpenClawProvider></StrictMode>); });
    expect(currentState.modifyingPass?.pass_id).toBe("p1");
    expect(currentState.passesLoading).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(currentState.modifyingPass?.pass_id).toBe("p1");
  });

  it("restores upgrade loading in a fresh card-payment return page before old active can show Bots", async () => {
    localStorage.setItem("lightvela-upgrade-return-v1:u1:paid-order", JSON.stringify({ passId: "p1", targetBundleId: "cruise", dealName: "paid-order", createdAt: Date.now() }));
    window.history.replaceState({}, "", "/agents/?upgrade_return=paid-order");
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    getOrderStatus.mockRejectedValueOnce(new Error("payment callback not ready"));
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_id: "cruise" }]);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "success", local_status: "provisioned", source: "local" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
    expect(window.location.search).toBe("");
    expect(localStorage.getItem("lightvela-upgrade-return-v1:u1:paid-order")).toBeNull();
  });

  it("does not treat an unrecognized return marker as a paid upgrade", async () => {
    window.history.replaceState({}, "", "/agents/?upgrade_return=unknown-order");
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
    expect(getOrderStatus).not.toHaveBeenCalled();
  });

  it("does not let an old Bot request overwrite the delivered upgrade snapshot", async () => {
    let resolveOldBots!: (value: DashboardSnapshot) => void;
    getDashboardSnapshot.mockImplementationOnce(() => new Promise<DashboardSnapshot>(resolve => { resolveOldBots = resolve; }));
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "支付成功" })); });
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_id: "cruise" }]);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "success", local_status: "provisioned", source: "local" });
    getDashboardSnapshot.mockResolvedValue(snapshot("已升级 Agent"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText("已升级 Agent")).toBeInTheDocument();
    await act(async () => { resolveOldBots(snapshot("过期的 Agent 快照")); });
    expect(screen.queryByText("过期的 Agent 快照")).not.toBeInTheDocument();
    expect(screen.getByText("已升级 Agent")).toBeInTheDocument();
  });

  it("starts waiting at payment and rejects stale active passes until target delivery and Bots are ready", async () => {
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "支付成功" })); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_id: "cruise", bundle_name: "巡航套餐" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "success", local_status: "provisioned", source: "local" });
    let resolveBots!: (value: DashboardSnapshot) => void;
    getDashboardSnapshot.mockImplementation(() => new Promise<DashboardSnapshot>(resolve => { resolveBots = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    await act(async () => { resolveBots(snapshot("已升级 Agent")); });
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
    expect(screen.getByText("已升级 Agent")).toBeInTheDocument();
  });

  it("restores modifying from the server and waits for fresh Bots before completing", async () => {
    await mount();
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    expect(screen.getByText("启航套餐")).toBeInTheDocument();

    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_name: "巡航套餐" }]);
    let resolveBots!: (value: DashboardSnapshot) => void;
    getDashboardSnapshot.mockImplementation(() => new Promise<DashboardSnapshot>(resolve => { resolveBots = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    await act(async () => { resolveBots(snapshot("升级后 Agent")); });
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
    expect(screen.getByText("巡航套餐")).toBeInTheDocument();
    expect(screen.getByText("升级后 Agent")).toBeInTheDocument();
    const reads = listMyPasses.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(listMyPasses).toHaveBeenCalledTimes(reads);
  });

  it.each(["failed", "cancelled"])("shows %s delivery even while the original pass is still active", async (status) => {
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "支付成功" })); });
    const botReads = getDashboardSnapshot.mock.calls.length;
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status, source: "local" });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级失败");
    expect(getDashboardSnapshot).toHaveBeenCalledTimes(botReads);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "success", local_status: "provisioned", source: "local" });
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active", bundle_id: "cruise" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
  });

  it("retains upgrading across missing or failed responses and retries automatically", async () => {
    await mount();
    listMyPasses.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByRole("status")).toHaveTextContent("升级中");
    expect(screen.getByText("启航套餐")).toBeInTheDocument();
    listMyPasses.mockResolvedValue([{ ...modifyingPass, status: "active" }]);
    getDashboardSnapshot.mockResolvedValue(snapshot("已恢复 Agent"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status")).toHaveTextContent("已就绪");
  });
});
