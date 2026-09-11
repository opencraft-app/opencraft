import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
function Probe() {
  const state = useOpenClaw();
  return <>
    <button onClick={() => state.beginPassUpgrade({ ...modifyingPass, status: "active" }, { dealName: "paid-order", targetBundleId: "cruise" })}>支付成功</button>
    <p role="status">{state.passUpgradeFailed ? "升级失败" : state.modifyingPass ? "升级中" : "已就绪"}</p>
    <p>{state.activePass?.bundle_name}</p>
    <p>{state.bots[0]?.name}</p>
  </>;
}
const mount = async () => { await act(async () => { render(<OpenClawProvider><Probe /></OpenClawProvider>); }); };

describe("Pass modification refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T00:00:00Z"));
    vi.resetAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    window.history.replaceState({}, "", "/agents/");
    listMyPasses.mockResolvedValue([modifyingPass]);
    getOrderStatus.mockResolvedValue({ deal_name: "paid-order", order_type: "modify", status: "paid", local_status: "paid_pending_provision", source: "local" });
    getDashboardSnapshot.mockResolvedValue(snapshot("升级前 Agent"));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });

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
