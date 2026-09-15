import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pass, User } from "@/domain/types";
import { AccountPage } from "@/pages/marketing/account-page";
import { saveUpgradeCheckout } from "@/lib/upgrade-checkout";
vi.mock("@/pages/marketing/upgrade-pass-modal", () => ({ UpgradePassModal: ({ targetBundleId }: { targetBundleId: string }) => <div role="dialog">Upgrade {targetBundleId}</div> }));

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();
const refreshProfile = vi.fn();
const refreshPasses = vi.fn();
const listMyPasses = vi.fn();
const listModifyBundles = vi.fn();
const getModifyCheckout = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();

let currentUser: User;
let activePass: Pass | null = null;
let paidBillingEnabled = true;
let language = "en-US";
const upgradeConsole = window as Window & { show?: () => unknown; hide?: () => unknown };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language } }),
}));

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, value),
  };
};

vi.mock("@tencent/universal-report", () => ({
  default: class MockUniversalReport {
    reportEvent = vi.fn();
    setPublicParams = vi.fn();
    setAccountInfo = vi.fn();
    startReport = vi.fn();
  },
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => {
    const translations: Record<string, string> = {
      "敬请期待": "Coming Soon",
      "续费功能敬请期待。套餐已过期，暂时无法发起续费。": "Renewals are coming soon. This plan has expired and cannot be renewed yet.",
      "续费功能敬请期待。你仍可销毁当前套餐后重新购买。": "Renewals are coming soon. You can still destroy this plan and subscribe again.",
    };

    return translations[text] ?? text;
  },
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => paidBillingEnabled,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  isCN: false,
  isGlobal: true,
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer>legal footer</footer>,
}));

vi.mock("@/components/site/brand-mark", () => ({
  BrandMark: () => <a href="/">LightVela</a>,
}));

vi.mock("@/components/site/language-switcher", () => ({
  LanguageSwitcher: () => null,
}));

vi.mock("@/components/site/login-modal", () => ({
  LoginModal: () => null,
}));

vi.mock("@/components/site/user-avatar-menu", () => ({
  UserAvatarMenu: () => <div>avatar menu</div>,
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    user: {
      plan: {
        name: "Launch",
        trialDays: 7,
      },
    },
    activePass,
    refreshPasses,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      verifyRealname: vi.fn(),
      retryRealnameSync: vi.fn(),
    },
    plans: {
      listMyPasses,
      listModifyBundles,
      getModifyCheckout,
      getRenewPrice,
      createRenewOrder,
    },
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: currentUser,
      currentSubscription: null,
    },
    isAuthenticated: true,
    authReady: true,
    signInAsGuest,
    updateProfile,
    uploadAvatar,
    refreshProfile,
    signOut,
    deleteAccount,
  }),
}));

const buildActivePass = (): Pass => ({
  status: "active",
  pass_id: "pass_global_renew",
  user_id: "usr_global_renew",
  bundle_id: "bundle_launch",
  bundle_name: "Launch",
  created_time: "2026-06-01T00:00:00Z",
  expired_time: "2099-06-01T00:00:00Z",
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 900,
});

const buildExpiredPass = (): Pass => ({
  ...buildActivePass(),
  expired_time: "2026-06-10T00:00:00Z",
});

const buildIsolatedPass = (): Pass => ({
  ...buildExpiredPass(),
  isolated_time: "2026-06-17T00:00:00Z",
});

const renderAccountPage = () => {
  render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  );
};

describe("AccountPage global renewal action", () => {
  beforeEach(() => {
    upgradeConsole.hide?.();
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", createMemoryStorage());
    currentUser = {
      id: "usr_global_renew",
      name: "Global User",
      inviteRequired: false,
      realnameVerified: false,
      createdAt: "2026-06-01T00:00:00Z",
    };
    activePass = buildActivePass();
    paidBillingEnabled = true;
    language = "en-US";
    listMyPasses.mockResolvedValue([]);
    listModifyBundles.mockResolvedValue({ source_bundle_id: "bundle_launch", modify_bundle_set: [] });
    getModifyCheckout.mockResolvedValue({ checkout: null });
  });

  afterEach(() => {
    act(() => upgradeConsole.hide?.());
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["zh-CN", "/zh-sg/subscribe"],
    ["zh-SG", "/zh-sg/subscribe"],
    ["zh-Hant", "/zh-hant/subscribe"],
    ["en-US", "/subscribe"],
    ["es", "/es/subscribe"],
    ["id-ID", "/id-id/subscribe"],
  ])("preserves %s when creating a subscription", async (locale, href) => {
    language = locale;
    activePass = null;
    renderAccountPage();
    expect(await screen.findByRole("link", { name: "立即创建" })).toHaveAttribute("href", href);
  });

  it("preserves simplified Chinese and the pass ID when upgrading", async () => {
    language = "zh-CN";
    activePass = { ...buildActivePass(), pass_id: "pass/a&b" };
    listMyPasses.mockResolvedValue([activePass]);
    listModifyBundles.mockResolvedValue({ source_bundle_id: "bundle_launch", modify_bundle_set: [{ target_bundle_id: "target", bundle: { bundle_id: "target" }, modify_price: { real_total_cost: 100 } }] });
    renderAccountPage();
    act(() => upgradeConsole.show?.());
    expect(await screen.findByRole("link", { name: "升级套餐" })).toHaveAttribute("href", "/zh-sg/subscribe/?upgrade_pass_id=pass%2Fa%26b");
  });

  it("greys out the global renew action and explains that it is coming soon", async () => {
    paidBillingEnabled = false;
    renderAccountPage();

    const renewButton = screen.getByRole("button", { name: "立即续费" });
    expect(renewButton).toHaveAttribute("aria-disabled", "true");
    expect(renewButton).toHaveClass("cursor-not-allowed");
    expect(renewButton).not.toHaveAttribute("title");

    fireEvent.focus(renewButton);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Coming Soon");
    expect(renewButton).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass(
      "fixed",
      "rounded-md",
      "border",
      "border-[var(--border-subtle)]",
      "bg-white",
      "px-3",
      "py-1.5",
      "text-[11px]",
      "font-medium",
      "shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
      "select-text",
    );

    await userEvent.click(renewButton);

    expect(screen.queryByRole("heading", { name: "续费套餐" })).not.toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(createRenewOrder).not.toHaveBeenCalled();
  });

  it("hides the upgrade link until show and leaves renewal available", async () => {
    listMyPasses.mockResolvedValue([activePass]);
    listModifyBundles.mockResolvedValue({ source_bundle_id: "bundle_launch", modify_bundle_set: [{ target_bundle_id: "target", bundle: { bundle_id: "target" }, modify_price: { real_total_cost: 100 } }] });
    renderAccountPage();
    await act(async () => {});
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(listModifyBundles).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "立即续费" })).toBeEnabled();
    act(() => upgradeConsole.show?.());
    expect(await screen.findByRole("link", { name: "升级套餐" })).toHaveAttribute("href", "/subscribe/?upgrade_pass_id=pass_global_renew");
    act(() => upgradeConsole.hide?.());
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "立即续费" })).toBeEnabled();
  });
  it("does not expose a progress button or reopen payment automatically", async () => {
    activePass = { ...buildActivePass(), status: "modifying" };
    listMyPasses.mockResolvedValue([activePass]);
    saveUpgradeCheckout(window.localStorage, currentUser.id, activePass.pass_id, { phase: "ordered", targetBundleId: "target", dealName: "deal" });
    renderAccountPage();
    act(() => upgradeConsole.show?.());
    await waitFor(() => expect(listMyPasses).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "查看升级进度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "升级套餐" })).not.toBeInTheDocument();
  });

  it("preserves the plan details with an upgrading status and pauses renewal", () => {
    activePass = { ...buildActivePass(), status: "modifying" };
    renderAccountPage();

    expect(screen.getByRole("status")).toHaveTextContent("套餐升级中");
    expect(screen.getByText(activePass.bundle_name)).toBeInTheDocument();
    expect(screen.getByText("订阅有效期")).toBeInTheDocument();
    expect(screen.queryByText("当前生效")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即续费" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "立即创建" })).not.toBeInTheDocument();
  });

  it("opens the global renewal flow when paid billing is enabled", async () => {
    paidBillingEnabled = true;
    renderAccountPage();

    const renewButton = screen.getByRole("button", { name: "立即续费" });
    expect(renewButton).not.toHaveAttribute("aria-disabled", "true");

    await userEvent.click(renewButton);

    expect(await screen.findByRole("heading", { name: "续费套餐" })).toBeInTheDocument();
    expect(getRenewPrice).toHaveBeenCalledWith("pass_global_renew", { period: 1, time_unit: "m" });
  });

  it("shows global unavailable wording for expired and isolated passes", () => {
    paidBillingEnabled = false;
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    activePass = buildExpiredPass();
    renderAccountPage();

    expect(screen.getByText("Renewals are coming soon. This plan has expired and cannot be renewed yet.")).toBeInTheDocument();
    expect(screen.queryByText("套餐已过期，请及时续费以免进入隔离期。")).not.toBeInTheDocument();

    cleanup();
    vi.setSystemTime(new Date("2026-06-18T00:00:00.000Z"));
    activePass = buildIsolatedPass();
    renderAccountPage();

    expect(screen.getByText("Renewals are coming soon. You can still destroy this plan and subscribe again.")).toBeInTheDocument();
    expect(screen.queryByText("套餐已进入隔离期，可选择续费恢复使用或销毁当前套餐。销毁后可重新购买。")).not.toBeInTheDocument();
  });
});
