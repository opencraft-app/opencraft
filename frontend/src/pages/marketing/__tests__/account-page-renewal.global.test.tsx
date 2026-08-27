import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pass, User } from "@/domain/types";
import { AccountPage } from "@/pages/marketing/account-page";

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();
const refreshProfile = vi.fn();
const refreshPasses = vi.fn();
const listMyPasses = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();

let currentUser: User;
let activePass: Pass | null = null;
let paidBillingEnabled = true;

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
    listMyPasses.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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
