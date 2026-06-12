import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/domain/types";
import { AccountPage } from "@/pages/marketing/account-page";

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();
const refreshProfile = vi.fn();
const retryRealnameSync = vi.fn();

let currentUser: User;
const ACCOUNT_REALNAME_VISIBILITY_STORAGE_KEY = "lw-account-realname-visible";

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => entries.delete(key),
    setItem: (key: string, value: string) => entries.set(key, value),
  };
};

const revealAccountRealnameSection = () => {
  const host = window as Window & { show?: unknown };
  expect(host.show).toEqual(expect.any(Function));

  act(() => {
    (host.show as () => boolean)();
  });
};

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/lib/region", () => ({
  isCN: true,
  isGlobal: false,
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

vi.mock("@/contexts/openclaw-context", () => ({
  useOpenClaw: () => ({
    user: {
      plan: {
        name: "启航套餐",
        trialDays: 7,
      },
    },
    activePass: null,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      verifyRealname: vi.fn(),
      retryRealnameSync,
    },
    plans: {
      listMyPasses: vi.fn().mockResolvedValue([]),
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

const renderAccountPage = () => {
  render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  );
};

describe("AccountPage nickname audit state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = {
      id: "usr_profile_audit",
      name: "旧昵称",
      inviteRequired: false,
      realnameVerified: true,
      createdAt: "2026-06-01T00:00:00Z",
    };
    vi.stubGlobal("localStorage", createMemoryStorage());
  });

  it("keeps the domestic realname and safety phone rows hidden until show() is called", () => {
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "phone_3fa",
    };

    renderAccountPage();

    expect(screen.queryByText("安全手机")).not.toBeInTheDocument();
    expect(screen.queryByText("实名认证")).not.toBeInTheDocument();

    revealAccountRealnameSection();

    expect(screen.getByText("安全手机")).toBeInTheDocument();
    expect(screen.getByText("实名认证")).toBeInTheDocument();
    expect(window.localStorage.getItem(ACCOUNT_REALNAME_VISIBILITY_STORAGE_KEY)).toBe("1");
  });

  it("keeps the realname rows visible after show() has been persisted", () => {
    window.localStorage.setItem(ACCOUNT_REALNAME_VISIBILITY_STORAGE_KEY, "1");
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "phone_3fa",
    };

    renderAccountPage();

    expect(screen.getByText("安全手机")).toBeInTheDocument();
    expect(screen.getByText("实名认证")).toBeInTheDocument();
  });

  it("shows the pending nickname privately while keeping the active nickname explicit", async () => {
    currentUser = {
      ...currentUser,
      pendingName: "待审核昵称",
      nameAuditStatus: "pending",
    };

    renderAccountPage();

    expect(screen.getByText("待审核昵称")).toHaveClass("blur-sm");
    expect(screen.getByText("审核中")).toBeInTheDocument();
    expect(screen.getByText("旧昵称")).toBeInTheDocument();
    expect(screen.getByText(/当前对外显示：/)).toHaveTextContent("当前对外显示：旧昵称，审核通过后将自动生效。");

    await userEvent.click(screen.getByRole("button", { name: "修改待审核昵称" }));

    const nicknameInput = screen
      .getAllByRole("textbox")
      .find((input) => input.getAttribute("value") === "待审核昵称");
    expect(nicknameInput).toBeDefined();
    expect(nicknameInput!).toHaveValue("待审核昵称");
  });

  it("explains a failed nickname audit without replacing the active nickname", () => {
    currentUser = {
      ...currentUser,
      nameAuditStatus: "failed",
    };

    renderAccountPage();

    expect(screen.getByText("旧昵称")).toBeInTheDocument();
    expect(screen.getByText("上次昵称修改未通过审核，当前仍使用原昵称。")).toBeInTheDocument();
    expect(screen.queryByText("审核中")).not.toBeInTheDocument();
  });

  it("shows pending avatar audit state without claiming the public avatar changed", () => {
    currentUser = {
      ...currentUser,
      avatarUrl: "/users/usr_profile_audit/avatar",
      pendingAvatarUrl: "https://example.com/pending-avatar.jpg",
      avatarAuditStatus: "pending",
    };

    renderAccountPage();

    expect(screen.getAllByText("审核中").length).toBeGreaterThan(0);
    expect(screen.getByText("新头像已提交审核，审核通过后将对外生效。")).toBeInTheDocument();
    const pendingAvatar = screen
      .getAllByAltText("avatar")
      .find((avatar) => avatar.getAttribute("src") === "https://example.com/pending-avatar.jpg");

    expect(pendingAvatar).toBeDefined();
    expect(pendingAvatar!).toHaveClass("blur-sm");
  });

  it("explains a failed avatar audit", () => {
    currentUser = {
      ...currentUser,
      avatarAuditStatus: "failed",
    };

    renderAccountPage();

    expect(screen.getByText("上次头像修改未通过审核，当前仍使用原头像。")).toBeInTheDocument();
  });

  it("does not treat the legacy realname boolean as ID-card verification", async () => {
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: undefined,
    };

    renderAccountPage();
    revealAccountRealnameSection();

    const verifyButtons = screen.getAllByRole("button", { name: /去认证/ });
    expect(verifyButtons.length).toBeGreaterThan(0);
    await userEvent.click(verifyButtons[0]!);

    expect(screen.getByText("第一步：提交真实姓名和身份证号。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入真实姓名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入身份证号码")).toBeInTheDocument();
    expect(screen.queryByText("第二步：输入当前手机号收到的短信验证码。")).not.toBeInTheDocument();
  });

  it("requires a safety phone before starting ID-card realname verification", async () => {
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameVerified: false,
      realnameLevel: undefined,
    };

    renderAccountPage();
    revealAccountRealnameSection();

    await userEvent.click(screen.getByRole("button", { name: /绑定安全手机/ }));

    expect(screen.getByRole("heading", { name: "绑定安全手机" })).toBeInTheDocument();
    expect(screen.getByText("当前账号尚未绑定安全手机。")).toBeInTheDocument();
    expect(screen.queryByText("第一步：提交真实姓名和身份证号。")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("请输入真实姓名")).not.toBeInTheDocument();
  });

  it("shows retry action when ID-card realname passed but LightVela sync failed", async () => {
    retryRealnameSync.mockResolvedValue({
      ok: true,
      user: {
        ...currentUser,
        phone: "15625128341",
        realnameVerified: true,
        realnameLevel: "phone_3fa",
        realnameSyncStatus: "succeeded",
      },
      realnameSyncStatus: "succeeded",
      shadowBindingStatus: "active",
    });
    refreshProfile.mockResolvedValue(undefined);
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameSyncStatus: "failed",
    };

    renderAccountPage();
    revealAccountRealnameSection();

    expect(screen.getByText("实名信息同步失败")).toBeInTheDocument();
    expect(screen.queryByText("待完成手机号认证")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /重新同步/ }));

    expect(retryRealnameSync).toHaveBeenCalledTimes(1);
    expect(refreshProfile).toHaveBeenCalledTimes(1);
  });

  it("shows pending sync instead of asking for another phone verification", () => {
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameSyncStatus: "pending",
    };

    renderAccountPage();
    revealAccountRealnameSection();

    expect(screen.getByText("实名信息同步中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新同步/ })).toBeInTheDocument();
    expect(screen.queryByText("待完成手机号认证")).not.toBeInTheDocument();
  });
});
