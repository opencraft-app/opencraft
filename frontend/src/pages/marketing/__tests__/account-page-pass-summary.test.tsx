import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import { AccountPage } from "../account-page";
import { SidebarUserMenuController } from "@/components/site/sidebar-user-menu-controller";

const mocks = vi.hoisted(() => ({ list: vi.fn(), options: vi.fn(), refresh: vi.fn(), signOut: vi.fn(), deletePass: vi.fn() }));
const buildPass = (overrides: Partial<Pass> = {}): Pass => ({ pass_id: "p-a", user_id: "a", bundle_id: "pro", bundle_name: "Owned A", status: "active", created_time: "2026-01-01", expired_time: "2099-01-01", credit_total: 1000, credit_available: 750, ...overrides });
let activePass: Pass | null;
let modifyingPass: Pass | null;
let userId: string;
const plans = { listMyPasses: mocks.list, listModifyBundles: mocks.options, deletePass: mocks.deletePass };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => ({ plans, auth: {} }) }));
vi.mock("@/contexts/runtime-config-context", () => ({ usePaidBillingEnabled: () => true, useRealnamePhoneVerificationEnabled: () => false, useReferralEnabled: () => false }));
vi.mock("@/contexts/agent-context", () => ({ useOpenClaw: () => ({ activePass, modifyingPass, refreshPasses: mocks.refresh, user: { plan: { name: "Legacy plan", trialDays: 7 } } }) }));
vi.mock("@/contexts/session-context", () => ({ useSession: () => ({ session: { user: { id: userId, name: `Owner ${userId}`, createdAt: "2026-01-01" }, currentSubscription: null }, authReady: true, isAuthenticated: true, signOut: mocks.signOut }) }));
vi.mock("@/components/site/product-chrome", () => ({ ProductPageShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/pages/marketing/saved-cards-section", () => ({ SavedCardsSection: () => null }));
vi.mock("@/components/dev/account-preview-state-switcher", () => ({ AccountPreviewStateSwitcher: () => null }));
vi.mock("@/pages/marketing/renew-pass-modal", () => ({ RenewPassModal: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>Complete synthetic renewal</button> }));
vi.mock("@/i18n/t", () => ({ useT: () => (text: string) => text }));
// Isolate fallback/refresh reads; the sidebar controller suite exercises real upgrade reads separately.
vi.mock("@/lib/use-pass-upgrade", () => ({ usePassUpgrade: () => ({ pass: null, options: [] }) }));
vi.mock("@tencent/universal-report", () => ({ default: class { reportEvent = vi.fn(); setPublicParams = vi.fn(); setAccountInfo = vi.fn(); startReport = vi.fn(); } }));
const commandHost = () => window as Window & { hide?: () => void };
const both = () => <MemoryRouter><section aria-label="account"><AccountPage /></section><SidebarUserMenuController /></MemoryRouter>;
const accountOnly = () => <MemoryRouter><AccountPage /></MemoryRouter>;

beforeEach(() => {
  vi.clearAllMocks(); userId = "a"; activePass = buildPass(); modifyingPass = null;
  mocks.list.mockResolvedValue([buildPass()]); mocks.options.mockResolvedValue({ modify_bundle_set: [] }); mocks.refresh.mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { act(() => commandHost().hide?.()); cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("account and sidebar shared pass selection", () => {
  it("keeps modifying precedence and the same quota in both consumers without moving account refresh", async () => {
    modifyingPass = buildPass({ pass_id: "modifying", status: "modifying", bundle_name: "Upgrading A", credit_total: 2000, credit_available: 400 });
    render(both());
    await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));
    const account = screen.getByRole("region", { name: "account" });
    const menu = screen.getByRole("dialog", { name: "账号管理" });
    await waitFor(() => expect(within(account).getByText("Upgrading A")).toBeVisible());
    expect(account).toHaveTextContent("1,600 / 2,000");
    expect(menu).toHaveTextContent("1,600 / 2,000");
    expect(within(menu).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
    expect(within(account).getByText("80%")).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("invalidates stale context ownership synchronously on account change in both consumers", async () => {
    const view = render(both());
    await userEvent.click(screen.getByRole("button", { name: "打开用户菜单" }));
    expect(screen.getByRole("region", { name: "account" })).toHaveTextContent("Owned A");
    userId = "b";
    mocks.list.mockReturnValue(new Promise<Pass[]>(() => {}));
    view.rerender(both());
    expect(screen.queryAllByText(/Owned A/)).toHaveLength(0);
    expect(screen.getByRole("region", { name: "account" })).not.toHaveTextContent("250 / 1,000");
    expect(screen.getByRole("dialog", { name: "账号管理" })).not.toHaveTextContent("250 / 1,000");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not accept another owner's first fallback or a late A response after switching to B", async () => {
    activePass = null;
    let resolveA!: (value: Pass[]) => void;
    mocks.list.mockImplementation(() => userId === "a" ? new Promise<Pass[]>((resolve) => { resolveA = resolve; }) : Promise.resolve([buildPass(), buildPass({ user_id: "b", pass_id: "p-b", bundle_name: "Owned B", credit_total: 800, credit_available: 700 })]));
    const view = render(accountOnly());
    await waitFor(() => expect(mocks.list).toHaveBeenCalled());
    userId = "b"; view.rerender(accountOnly());
    await act(async () => resolveA([buildPass()]));
    await waitFor(() => expect(screen.getByText("Owned B")).toBeVisible());
    expect(screen.queryByText("Owned A")).not.toBeInTheDocument();
    expect(screen.getByText("/ 800").parentElement).toHaveTextContent("100 / 800");
  });

  it("closes renewal then awaits account refresh before clearing fallback without refetch", async () => {
    activePass = null;
    const expired = buildPass({ expired_time: "2020-01-01" });
    mocks.list.mockResolvedValue([expired]);
    render(accountOnly());
    await waitFor(() => expect(screen.getByText("Owned A")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "立即续费" }));
    let finishRefresh!: () => void;
    mocks.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "Complete synthetic renewal" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Complete synthetic renewal" })).not.toBeInTheDocument());
    expect(screen.getByText("Owned A")).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    const reads = mocks.list.mock.calls.length;
    await act(async () => finishRefresh());
    expect(screen.queryByText("Owned A")).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(reads);
  });

  it("keeps delete polling owned by account and clears fallback only after the post-delete refresh", async () => {
    activePass = null;
    const isolated = buildPass({ expired_time: "2020-01-01", isolated_time: "2020-01-02" });
    mocks.list.mockResolvedValue([isolated]); mocks.deletePass.mockResolvedValue({ deleted: true });
    render(accountOnly());
    await waitFor(() => expect(screen.getByText("Owned A")).toBeVisible());
    await userEvent.click(screen.getByRole("button", { name: "销毁套餐" }));
    let finishRefresh!: () => void;
    mocks.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认销毁" })));
    expect(mocks.deletePass).toHaveBeenCalledExactlyOnceWith("p-a");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    mocks.list.mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Owned A")).toBeInTheDocument();
    const reads = mocks.list.mock.calls.length;
    await act(async () => finishRefresh());
    expect(screen.queryByText("Owned A")).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(reads);
    expect(mocks.deletePass).toHaveBeenCalledTimes(1);
  });
});
