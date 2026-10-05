import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { UserAvatarMenu } from "../user-avatar-menu";
import { isGlobal } from "@/lib/region";
import { CONSOLE_SHOW_EVENT, setConsoleShowEnabled } from "@/lib/console-show-event";

const mocks = vi.hoisted(() => ({ listMyPasses: vi.fn(), listModifyBundles: vi.fn(), repositories: vi.fn(), paidBilling: vi.fn(), navigate: vi.fn(), signOut: vi.fn() }));
const pass = (overrides: Partial<Pass> & { bundle_type?: string } = {}): Pass & { bundle_type?: string } => ({ pass_id: "p/a", user_id: "a", status: "active", bundle_id: "source", bundle_name: "Pro A", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 1000, credit_available: 750, ...overrides });
let currentPass: Pass | null = pass();
let modifyingPass: Pass | null = null;
let userId: string | undefined = "a";
let paidBilling = true;
let currentSubscription: { code: string } | null = null;
const plans = { listMyPasses: mocks.listMyPasses, listModifyBundles: mocks.listModifyBundles };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => { mocks.repositories(); return { plans }; } }));
vi.mock("@/contexts/runtime-config-context", () => ({ usePaidBillingEnabled: () => { mocks.paidBilling(); return paidBilling; } }));
vi.mock("@/contexts/session-context", () => ({ useSession: () => ({ session: { user: userId ? { id: userId, name: `Owner ${userId}`, email: `${userId}@example.com` } : null, currentSubscription }, signOut: mocks.signOut }) }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ activePass: currentPass, modifyingPass, passUpgradeFailed: false, passesLoading: false, passesError: false, user: { plan: { name: "STALE PLAN SHOULD NOT LEAK" } } }) }));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mocks.navigate,
  useAppSearchParams: () => [new URLSearchParams()],
}));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
const target = { target_bundle_id: "target", bundle: { bundle_id: "target" } };
const host = () => window as Window & { show?: (...args: unknown[]) => unknown };
beforeEach(() => {
  setConsoleShowEnabled(false);
  vi.clearAllMocks(); currentPass = pass(); modifyingPass = null; userId = "a"; paidBilling = true; currentSubscription = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.listMyPasses.mockResolvedValue([pass()]);
  mocks.listModifyBundles.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [target] });
});

afterEach(() => { cleanup(); setConsoleShowEnabled(false); delete host().show; vi.unstubAllGlobals(); });
async function openSidebar() {
  await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));
  act(() => host().show?.());
}

describe("sidebar account controller boundary", () => {
  it("emits the shared console-show event without requiring the header to be mounted", () => {
    const onShow = vi.fn();
    window.addEventListener(CONSOLE_SHOW_EVENT, onShow);
    try {
      render(<UserAvatarMenu variant="sidebar" />);
      act(() => host().show?.());
      expect(onShow).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(CONSOLE_SHOW_EVENT, onShow);
    }
  });

  it("reveals one domestic feedback entry only after show()", async () => {
    render(<UserAvatarMenu variant="sidebar" />);
    await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));
    expect(screen.queryAllByRole("link", { name: "产品反馈" })).toHaveLength(0);
    act(() => host().show?.());
    expect(screen.queryAllByRole("link", { name: "产品反馈" })).toHaveLength(isGlobal ? 0 : 1);
    if (!isGlobal) {
      expect(screen.getByRole("link", { name: "产品反馈" })).toHaveAttribute("href", "/support");
      expect(screen.getByRole("link", { name: "产品反馈" })).not.toHaveAttribute("target");
    }
    act(() => host().show?.());
    expect(screen.queryAllByRole("link", { name: "产品反馈" })).toHaveLength(0);
  });

  const menuOrderCases: Array<[string, string | undefined, string[]]> = [
    ["ordinary plans", undefined, ["云存储", "套餐与费用", "账号"]],
    ["AI plans", "ai", ["云存储", "套餐与费用", "账号"]],
  ];
  it.each(menuOrderCases)("keeps the sidebar account menu order for %s", async (_name, bundleType, expected) => {
    currentPass = pass(bundleType ? { bundle_type: bundleType } : {});
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const labels = within(screen.getByRole("dialog", { name: "账号管理" }))
      .getAllByRole("link")
      .map((link) => link.textContent?.trim())
      .filter((label): label is string => expected.includes(label));
    expect(labels).toEqual(expected);
    expect(within(screen.getByRole("dialog", { name: "账号管理" })).queryByRole("link", { name: /模型|诊断中心|高级设置/ })).not.toBeInTheDocument();
  });

  it("does not mount billing or upgrade hooks for the unchanged header", () => {
    render(<UserAvatarMenu />);
    expect(screen.getByRole("link", { name: "avatar" })).toHaveAttribute("href", "/account");
    expect(mocks.repositories).not.toHaveBeenCalled();
    expect(mocks.paidBilling).not.toHaveBeenCalled();
    expect(mocks.listMyPasses).not.toHaveBeenCalled();
  });

  it("preserves the current session subscription code without inventing credits or retaining another account's label", async () => {
    currentPass = null; currentSubscription = { code: "legacy-launch" }; paidBilling = false;
    mocks.listMyPasses.mockResolvedValue([]);
    const view = render(<UserAvatarMenu variant="sidebar" />);
    const trigger = screen.getByRole("button", { name: "打开用户菜单" });
    expect(trigger).toHaveTextContent("套餐：legacy-launch");
    await userEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    expect(menu).toHaveTextContent("套餐：legacy-launch");
    await waitFor(() => expect(within(menu).getByRole("status")).toHaveTextContent("已使用积分：暂无法确认"));
    expect(menu).not.toHaveTextContent("未订阅");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(menu).not.toHaveTextContent("0 / 0");
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    userId = "b"; currentSubscription = { code: "legacy-b" };
    view.rerender(<UserAvatarMenu variant="sidebar" />);
    expect(screen.queryAllByText(/legacy-launch|STALE PLAN/)).toHaveLength(0);
    expect(trigger).toHaveTextContent("套餐：legacy-b");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
  });

  it("keeps a closed sidebar request-free and reads displayed quota from currentPass, not the upgrade response", async () => {
    mocks.listMyPasses.mockResolvedValue([pass({ credit_total: 99999, credit_available: 0 })]);
    render(<UserAvatarMenu variant="sidebar" />);
    expect(mocks.listMyPasses).not.toHaveBeenCalled();
    await openSidebar();
    expect(await screen.findByText("250 / 1,000")).toBeVisible();
    expect(await screen.findByRole("link", { name: "升级套餐" })).toHaveAttribute("href", expect.stringContaining("/?upgrade_pass_id=p%2Fa"));
    expect(screen.queryByText(/99,999/)).not.toBeInTheDocument();
  });

  it("hides old quota and late upgrade href immediately when the account changes", async () => {
    let resolve!: (value: unknown) => void;
    mocks.listModifyBundles.mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    await waitFor(() => expect(mocks.listModifyBundles).toHaveBeenCalledTimes(1));
    userId = "b";
    mocks.listMyPasses.mockRejectedValue(new Error("B offline"));
    view.rerender(<UserAvatarMenu variant="sidebar" />);
    expect(screen.queryByText("250 / 1,000")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pro A|STALE PLAN/)).not.toBeInTheDocument();
    await act(async () => resolve({ source_bundle_id: "source", modify_bundle_set: [target] }));
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
  });

  it("retains the confirmed fallback label after close without refetching and invalidates it on a closed account switch", async () => {
    currentPass = null;
    mocks.listMyPasses.mockResolvedValue([pass({ expired_time: "2020-01-01" })]);
    const view = render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const trigger = screen.getByRole("button", { name: "打开用户菜单" });
    await waitFor(() => expect(trigger).toHaveTextContent("Pro A"));
    await userEvent.keyboard("{Escape}");
    expect(trigger).toHaveTextContent("Pro A");
    const reads = mocks.listMyPasses.mock.calls.length;
    await userEvent.click(trigger);
    expect(await screen.findByText("250 / 1,000")).toBeVisible();
    expect(mocks.listMyPasses).toHaveBeenCalledTimes(reads);
    await userEvent.keyboard("{Escape}");
    userId = "b"; view.rerender(<UserAvatarMenu variant="sidebar" />);
    expect(trigger).not.toHaveTextContent("Pro A");
    expect(mocks.listMyPasses).toHaveBeenCalledTimes(reads);
  });

  it("shares master's show toggle across header/sidebar and restores the original command", () => {
    const originalShow = vi.fn();
    host().show = originalShow;
    const header = render(<UserAvatarMenu />);
    const sidebar = render(<UserAvatarMenu variant="sidebar" />);
    let result: unknown;
    act(() => { result = host().show?.(); });
    expect(result).toBe(true);
    header.unmount();
    act(() => { result = host().show?.(); });
    expect(result).toBe(false);
    expect(originalShow).not.toHaveBeenCalled();
    sidebar.unmount();
    expect(host().show).toBe(originalShow);
  });

  it.each(["modifying", "expired", "isolated"])("retains %s display state without an upgrade shortcut", async (state) => {
    const changed = pass({ ...(state === "modifying" ? { status: state } : state === "expired" ? { expired_time: "2020-01-01" } : { isolated_time: "2026-01-01" }) });
    if (state === "modifying") modifyingPass = changed;
    else currentPass = changed;
    mocks.listMyPasses.mockResolvedValue([changed]);
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    expect(await screen.findByRole("progressbar", { name: "已使用积分" })).toHaveAttribute("aria-valuenow", "25");
    await waitFor(() => expect(mocks.listMyPasses).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(state === "modifying" ? "套餐升级中" : state === "expired" ? "已过期" : "隔离");
  });

  it("requires backend upgrade options and retains disabled billing", async () => {
    mocks.listModifyBundles.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [] });
    const view = render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    await waitFor(() => expect(mocks.listModifyBundles).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    paidBilling = false; view.rerender(<UserAvatarMenu variant="sidebar" />);
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
  });

  it("signs out once and keeps replace navigation", async () => {
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const dialog = await screen.findByRole("dialog", { name: "账号管理" });
    await userEvent.click(within(dialog).getByRole("button", { name: "退出登录" }));
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/", { replace: true });
  });
});
