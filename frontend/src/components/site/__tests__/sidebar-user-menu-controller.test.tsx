import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { UserAvatarMenu } from "../user-avatar-menu";
import { isGlobal } from "@/lib/region";
import { CONSOLE_SHOW_EVENT, setConsoleShowEnabled } from "@/lib/console-show-event";

const mocks = vi.hoisted(() => ({ listCreditPackages: vi.fn(), listMyPasses: vi.fn(), listModifyBundles: vi.fn(), repositories: vi.fn(), paidBilling: vi.fn(), navigate: vi.fn(), signOut: vi.fn() }));
const pass = (overrides: Partial<Pass> & { bundle_type?: string } = {}): Pass & { bundle_type?: string } => ({ pass_id: "p/a", user_id: "a", status: "active", bundle_id: "source", bundle_name: "Pro A", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 1000, credit_available: 750, ...overrides });
let currentPass: Pass | null = pass();
let modifyingPass: Pass | null = null;
let userId: string | undefined = "a";
let paidBilling = true;
let currentSubscription: { code: string } | null = null;
const plans = { listMyPasses: mocks.listMyPasses, listModifyBundles: mocks.listModifyBundles };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => { mocks.repositories(); return { plans, auth: { getReferralStats: vi.fn() }, credit: { listCreditPackages: mocks.listCreditPackages } }; } }));
vi.mock("@/contexts/runtime-config-context", () => ({ usePaidBillingEnabled: () => { mocks.paidBilling(); return paidBilling; }, useReferralEnabled: () => false }));
vi.mock("@/contexts/session-context", () => ({ useSession: () => ({ session: { user: userId ? { id: userId, name: `Owner ${userId}`, email: `${userId}@example.com` } : null, currentSubscription }, signOut: mocks.signOut }) }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ activePass: currentPass, modifyingPass, passUpgradeFailed: false, hasResolvedPasses: true, isSubscribed: Boolean(currentPass), passesLoading: false, passesError: false, bots: [], botsLoading: false, botsError: false, user: { plan: { name: "STALE PLAN SHOULD NOT LEAK" } } }) }));
vi.mock("@/components/domain/tat-file-manager-panel", () => ({
  TatFileManagerPanel: ({ botId, showHeader }: { botId: string; showHeader?: boolean }) => <div data-testid="file-manager" data-bot-id={botId} data-show-header={String(showHeader)} />,
}));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => mocks.navigate,
  useAppSearchParams: () => [new URLSearchParams()],
}));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text, useCurrentLocale: () => "zh-CN" }));
const target = { target_bundle_id: "target", bundle: { bundle_id: "target" } };
const host = () => window as Window & { show?: (...args: unknown[]) => unknown };
beforeEach(() => {
  setConsoleShowEnabled(false);
  vi.clearAllMocks(); currentPass = pass(); modifyingPass = null; userId = "a"; paidBilling = true; currentSubscription = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.listMyPasses.mockResolvedValue([pass()]);
  mocks.listCreditPackages.mockResolvedValue([]);
  mocks.listModifyBundles.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [target] });
});

afterEach(() => { cleanup(); setConsoleShowEnabled(false); delete host().show; vi.unstubAllGlobals(); });
async function openSidebar() {
  await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));
  act(() => host().show?.());
}

describe("sidebar account controller boundary", () => {
  it("opens cloud storage for the active Bot in a dialog without leaving the page", async () => {
    const user = userEvent.setup();
    render(<UserAvatarMenu variant="sidebar" cloudStorageBotId="active-bot" />);
    await user.click(screen.getByRole("button", { name: "打开用户菜单" }));
    await user.click(screen.getByRole("button", { name: "云存储" }));

    const dialog = await screen.findByRole("dialog", { name: "云存储" });
    expect(dialog).toBeVisible();
    expect(await within(dialog).findByTestId("file-manager")).toHaveAttribute("data-bot-id", "active-bot");
    expect(within(dialog).getByTestId("file-manager")).toHaveAttribute("data-show-header", "false");
    expect(mocks.navigate).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "云存储" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "打开用户菜单" })).toHaveFocus();
  });

  it("counts paid credit packs with the plan, matching the billing page", async () => {
    currentPass = pass({ credit_total: 100, credit_available: 83 });
    mocks.listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 1000, credit_available: 1000, expired_time: "2099-01-01T00:00:00Z" },
    ]);
    render(<UserAvatarMenu variant="sidebar" />);
    expect(mocks.listCreditPackages).not.toHaveBeenCalled();
    await openSidebar();
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    await waitFor(() => expect(menu).toHaveTextContent("17 / 1,100"));
    expect(menu).toHaveTextContent("1,083");
  });

  it("does not carry account A's credit packs into account B while the menu stays open", async () => {
    const packOf = (owner: string) => [{ credit_type: "paid", credit_total: owner === "a" ? 1000 : 10, credit_available: owner === "a" ? 1000 : 10, expired_time: "2099-01-01T00:00:00Z" }];
    mocks.listCreditPackages.mockImplementation(async () => packOf(userId!));
    currentPass = pass({ credit_total: 100, credit_available: 83 });
    const view = render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    await waitFor(() => expect(screen.getByRole("dialog", { name: "账号管理" })).toHaveTextContent("17 / 1,100"));

    userId = "b";
    currentPass = pass({ pass_id: "p/b", user_id: "b", credit_total: 100, credit_available: 50 });
    view.rerender(<UserAvatarMenu variant="sidebar" />);
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    expect(menu).not.toHaveTextContent("1,100");
    await waitFor(() => expect(menu).toHaveTextContent("50 / 110"));
    expect(mocks.listCreditPackages).toHaveBeenCalledTimes(2);
  });

  it("shows paid credit packs for an account without a pass", async () => {
    currentPass = null;
    mocks.listMyPasses.mockResolvedValue([]);
    mocks.listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 1000, credit_available: 900, expired_time: "2099-01-01T00:00:00Z" },
    ]);
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    await waitFor(() => expect(menu).toHaveTextContent("100 / 1,000"));
    expect(menu).toHaveTextContent("900");
  });

  it("does not present plan-only credit as the full balance when credit packs fail, and can retry", async () => {
    currentPass = pass({ credit_total: 100, credit_available: 83 });
    mocks.listCreditPackages.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([
      { credit_type: "paid", credit_total: 1000, credit_available: 1000, expired_time: "2099-01-01T00:00:00Z" },
    ]);
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    const retry = await within(menu).findByRole("button", { name: "积分包额度加载失败，点击重试" });
    expect(menu).not.toHaveTextContent("17 / 100");
    expect(menu).not.toHaveTextContent("83");
    await userEvent.click(retry);
    await waitFor(() => expect(menu).toHaveTextContent("17 / 1,100"));
  });

  it("shows the former overview account metrics in the sidebar menu", async () => {
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    expect(menu).not.toHaveTextContent("已服务");
    expect(menu).toHaveTextContent("有效期至");
    expect(menu).toHaveTextContent("2099年1月1日");
    expect(menu).toHaveTextContent("剩余 AI 积分");
    expect(menu).toHaveTextContent("750");
    expect(menu).toHaveTextContent("Bot 数量");
    expect(menu).not.toHaveTextContent("已邀请好友");
  });

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

  it("does not mount billing or upgrade hooks for the eligible header", () => {
    render(<UserAvatarMenu />);
    expect(screen.getByRole("link", { name: "avatar" })).toHaveAttribute("href", "/agents");
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
    const upgrade = await screen.findByRole("link", { name: "升级套餐" });
    expect(upgrade).toHaveAttribute("href", expect.stringContaining("/?upgrade_pass_id=p%2Fa"));
    expect(upgrade.parentElement).toHaveTextContent("套餐：Pro A");
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
