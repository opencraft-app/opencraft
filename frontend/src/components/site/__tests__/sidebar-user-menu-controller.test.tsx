import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { UserAvatarMenu } from "../user-avatar-menu";
import { isGlobal } from "@/lib/region";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";
import { createFakeRepositories } from "@/repositories/fake-repositories";
import { CONSOLE_SHOW_EVENT } from "@/lib/console-show-event";

const mocks = vi.hoisted(() => ({ listMyPasses: vi.fn(), listModifyBundles: vi.fn(), repositories: vi.fn(), paidBilling: vi.fn(), navigate: vi.fn(), signOut: vi.fn() }));
const pass = (overrides: Partial<Pass> = {}): Pass => ({ pass_id: "p/a", user_id: "a", status: "active", bundle_id: "source", bundle_name: "Pro A", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 1000, credit_available: 750, ...overrides });
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
const host = () => window as Window & { show?: (...args: unknown[]) => unknown; hide?: () => void };
function AccountUpgradeConsumer() {
  const upgrade = usePassUpgrade({ userId, passId: currentPass?.pass_id, currentPass, enabled: true });
  return <output data-testid="account-upgrade">{upgrade.options.length}</output>;
}

beforeEach(() => {
  vi.clearAllMocks(); currentPass = pass(); modifyingPass = null; userId = "a"; paidBilling = true; currentSubscription = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.listMyPasses.mockResolvedValue([pass()]);
  mocks.listModifyBundles.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [target] });
});

describe("real fake repository account preview consumption", () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { window.history.replaceState({}, "", "/"); window.localStorage.clear(); });

  it("displays the demo pass quota and original upgrade href through the real summary and upgrade hooks", async () => {
    window.history.replaceState({}, "", "/agents/automations?state=default&passState=sidebar-demo");
    const repositories = createFakeRepositories();
    const session = await repositories.auth.getSession();
    userId = session?.user.id;
    currentPass = (await repositories.plans.listMyPasses())[0] ?? null;
    mocks.listMyPasses.mockImplementation(repositories.plans.listMyPasses);
    mocks.listModifyBundles.mockImplementation(repositories.plans.listModifyBundles);
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    expect(await screen.findByText("250 / 1,000")).toBeVisible();
    expect(screen.getByRole("button", { name: "打开用户菜单" })).toHaveTextContent("演示");
    expect(screen.getByRole("progressbar", { name: "已使用积分" })).toHaveAttribute("aria-valuenow", "25");
    expect(await screen.findByRole("link", { name: "升级套餐" })).toHaveAttribute("href", expect.stringContaining(`/?upgrade_pass_id=${encodeURIComponent(currentPass!.pass_id)}`));
    expect(mocks.listModifyBundles).toHaveBeenCalledWith(currentPass!.pass_id);
    expect(window.localStorage.getItem("lightclaw-fake-passes-v1")).toBeNull();
  });

  it("keeps the same fake session unsubscribed without the explicit demo query", async () => {
    window.history.replaceState({}, "", "/agents/automations?state=default");
    const repositories = createFakeRepositories();
    const session = await repositories.auth.getSession();
    userId = session?.user.id;
    currentPass = (await repositories.plans.listMyPasses())[0] ?? null;
    mocks.listMyPasses.mockImplementation(repositories.plans.listMyPasses);
    mocks.listModifyBundles.mockImplementation(repositories.plans.listModifyBundles);
    render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("未订阅"));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(screen.queryByText("0 / 0")).not.toBeInTheDocument();
    expect(mocks.listModifyBundles).not.toHaveBeenCalled();
  });
});
afterEach(() => { act(() => host().hide?.()); cleanup(); delete host().show; delete host().hide; vi.unstubAllGlobals(); });
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

  it("shows domestic feedback without show(), preserves the external link, and closes back to the avatar", async () => {
    render(<UserAvatarMenu variant="sidebar" />);
    const trigger = screen.getByRole("button", { name: "打开用户菜单" });
    await userEvent.click(trigger);
    expect(screen.queryByRole("link", { name: "产品反馈" })).not.toBeInTheDocument();
    if (isGlobal) {
      expect(screen.queryByRole("link", { name: "建议反馈" })).not.toBeInTheDocument();
      act(() => host().show?.());
      expect(screen.queryByRole("link", { name: "建议反馈" })).not.toBeInTheDocument();
      act(() => host().hide?.());
      expect(screen.queryByRole("link", { name: "建议反馈" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
    } else {
      const feedback = screen.getByRole("link", { name: "建议反馈" });
      expect(feedback).toHaveAttribute("href", "https://wj.qq.com/s2/27184784/6d06/");
      expect(feedback).toHaveAttribute("target", "_blank");
      expect(feedback).toHaveAttribute("rel", "noopener noreferrer");
      act(() => { host().show?.(); host().show?.(); host().hide?.(); });
      expect(screen.getAllByRole("link", { name: "建议反馈" })).toHaveLength(1);
      await userEvent.click(feedback);
    }
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
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

  it("keeps the header/sidebar show chain receiver, arguments, defined result and region guards", async () => {
    const originalShow = vi.fn(function (this: Window, ...args: unknown[]) { expect(this).toBe(window); expect(args).toEqual(["reveal", 7]); return false; });
    host().show = originalShow;
    const header = render(<UserAvatarMenu />);
    const sidebar = render(<UserAvatarMenu variant="sidebar" />);
    const trigger = screen.getAllByRole("button", { name: "打开用户菜单" })[1]!;
    await userEvent.click(trigger);
    expect(await screen.findByRole("link", { name: "升级套餐" })).toBeVisible();
    let result: unknown;
    act(() => { result = host().show?.("reveal", 7); });
    expect(result).toBe(false);
    expect(originalShow).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("link", { name: "升级套餐" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "建议反馈" }) !== null).toBe(!isGlobal);
    act(() => host().hide?.());
    expect(screen.getByRole("link", { name: "升级套餐" })).toBeVisible();
    // Cleanup must not overwrite a newer command owner mounted after both menus.
    const laterOwner = vi.fn(); host().show = laterOwner;
    sidebar.unmount(); header.unmount();
    expect(host().show).toBe(laterOwner);
    expect(originalShow).toHaveBeenCalledTimes(1);
  });

  it("restores the original show and hide commands after the real sidebar upgrade hook unmounts", () => {
    const originalShow = vi.fn();
    const originalHide = vi.fn();
    host().show = originalShow; host().hide = originalHide;
    const view = render(<><UserAvatarMenu /><UserAvatarMenu variant="sidebar" /></>);
    view.unmount();
    expect(host().show).toBe(originalShow);
    expect(host().hide).toBe(originalHide);
  });

  it.each(["account-first", "sidebar-first"])("cleans two real upgrade consumers in %s order while preserving the remaining consumer", async (order) => {
    const originalShow = vi.fn(() => false); const originalHide = vi.fn(() => false);
    host().show = originalShow; host().hide = originalHide;
    const account = render(<AccountUpgradeConsumer />);
    const sidebar = render(<UserAvatarMenu variant="sidebar" />);
    await openSidebar();
    await waitFor(() => expect(screen.getByTestId("account-upgrade")).toHaveTextContent("1"));
    expect(await screen.findByRole("link", { name: "升级套餐" })).toBeVisible();
    if (order === "account-first") account.unmount(); else sidebar.unmount();
    act(() => host().hide?.());
    // Upgrade discovery is public in every region after the master rollout.
    if (order === "account-first") expect(screen.getByRole("link", { name: "升级套餐" })).toBeVisible();
    else expect(screen.getByTestId("account-upgrade")).toHaveTextContent("1");
    let result: unknown;
    act(() => { result = host().show?.(); });
    expect(result).toBe(false);
    if (order === "account-first") expect(await screen.findByRole("link", { name: "升级套餐" })).toBeVisible();
    else await waitFor(() => expect(screen.getByTestId("account-upgrade")).toHaveTextContent("1"));
    if (order === "account-first") sidebar.unmount(); else account.unmount();
    expect(host().show).toBe(originalShow); expect(host().hide).toBe(originalHide);
    expect(originalShow).toHaveBeenCalledTimes(2); expect(originalHide).toHaveBeenCalledTimes(1);
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
