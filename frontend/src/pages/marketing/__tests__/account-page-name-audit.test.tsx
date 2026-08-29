import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pass, User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";

vi.mock("@tencent/universal-report", () => ({
  default: class MockUniversalReport {
    reportEvent = vi.fn();
    setPublicParams = vi.fn();
    setAccountInfo = vi.fn();
    startReport = vi.fn();
  },
}));

import { AccountPage } from "@/pages/marketing/account-page";

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();
const refreshProfile = vi.fn();
const retryRealnameSync = vi.fn();
const refreshPasses = vi.fn();
const listMyPasses = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();

let currentUser: User;
let realnamePhoneVerificationEnabled = false;
let paidBillingEnabled = false;
let activePass: Pass | null = null;
let sessionAuthReady = true;
let sessionIsAuthenticated = true;

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

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => paidBillingEnabled,
  useRealnamePhoneVerificationEnabled: () => realnamePhoneVerificationEnabled,
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "zh-CN",
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

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    user: {
      plan: {
        name: "启航套餐",
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
      retryRealnameSync,
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
      user: sessionIsAuthenticated ? currentUser : null,
      currentSubscription: null,
    },
    isAuthenticated: sessionIsAuthenticated,
    authReady: sessionAuthReady,
    signInAsGuest,
    updateProfile,
    uploadAvatar,
    refreshProfile,
    signOut,
    deleteAccount,
  }),
}));

const renderAccountPage = () => {
  return render(
    <MemoryRouter>
      <AccountPage />
    </MemoryRouter>,
  );
};

const renderAccountPageWithNavigation = (navigation: AppNavigationValue) => {
  render(
    <MemoryRouter>
      <AppNavigationProvider value={navigation}>
        <AccountPage />
      </AppNavigationProvider>
    </MemoryRouter>,
  );
};

const createNavigationValue = (navigate = vi.fn()): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate,
  pathname: "/account",
  search: "",
  setSearchParams: vi.fn(),
});

const buildActivePass = (): Pass => ({
  pass_id: "pass_active_renew",
  user_id: "usr_profile_audit",
  bundle_id: "bundle_launch",
  bundle_name: "启航套餐",
  created_time: "2026-06-01T00:00:00Z",
  expired_time: "2099-06-01T00:00:00Z",
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 900,
});

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
    realnamePhoneVerificationEnabled = false;
    paidBillingEnabled = false;
    activePass = null;
    sessionAuthReady = true;
    sessionIsAuthenticated = true;
    refreshPasses.mockResolvedValue(undefined);
    listMyPasses.mockResolvedValue([]);
    getRenewPrice.mockResolvedValue({
      bundle_id: "bundle_launch",
      price: 4900,
      total_cost: 4900,
      real_total_cost: 4900,
      currency: "CNY",
      discount: 100,
    });
    createRenewOrder.mockResolvedValue({
      order_id: "order_renewal_audit",
      pass_id: "pass_active_renew",
      pay_url: "weixin://wxpay/bizpayurl?pr=renewal",
      auth_code: "weixin://wxpay/bizpayurl?pr=renewal",
      deal_names: ["启航套餐 续费"],
    });
  });

  it("keeps the account chrome singular across auth states", () => {
    sessionAuthReady = false;
    sessionIsAuthenticated = false;

    const { rerender } = render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(screen.getAllByText("legal footer")).toHaveLength(1);

    sessionAuthReady = true;
    rerender(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(screen.getAllByText("legal footer")).toHaveLength(1);

    sessionIsAuthenticated = true;
    rerender(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(screen.getAllByText("legal footer")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "退出登录" })).toHaveLength(1);
  });

  it("replaces to the homepage immediately while signing out", async () => {
    const navigate = vi.fn();
    let resolveSignOut: () => void = () => {};
    signOut.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveSignOut = resolve;
    }));

    renderAccountPageWithNavigation(createNavigationValue(navigate));

    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));

    expect(navigate).toHaveBeenCalledWith("/", { replace: true });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("登录以查看账号信息")).not.toBeInTheDocument();

    await act(async () => {
      resolveSignOut();
    });
  });

  it("uses pure realname by default without exposing any phone concept", async () => {
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: false,
      realnameLevel: undefined,
    };

    renderAccountPage();

    expect(screen.queryByText("安全手机")).not.toBeInTheDocument();
    expect(screen.getByText("实名认证")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /去认证/ }));

    expect(screen.getByText("填写与你身份证一致的信息，完成实名认证。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入真实姓名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入身份证号码")).toBeInTheDocument();
    expect(screen.queryByText(/手机/)).not.toBeInTheDocument();
    expect(screen.queryByText(/验证码/)).not.toBeInTheDocument();
  });

  it("shows the account id and lets users copy it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    currentUser = {
      ...currentUser,
      id: "usr_visible_account_id",
    };

    renderAccountPage();

    expect(screen.getByText("id: usr_visible_account_id")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(writeText).toHaveBeenCalledWith("usr_visible_account_id");
  });

  it("keeps verified email row compact without the explanatory helper text", () => {
    currentUser = {
      ...currentUser,
      email: "user@example.com",
      emailVerified: true,
    };

    renderAccountPage();

    expect(screen.getByText("邮箱")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByText("已验证")).toBeInTheDocument();
    expect(screen.queryByText("该邮箱已验证，可用于接收导出完成通知等重要消息。")).not.toBeInTheDocument();
  });

  it("does not mention shadow account internals in the pure realname modal", async () => {
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameVerified: false,
      realnameLevel: undefined,
    };

    renderAccountPage();

    await userEvent.click(screen.getByRole("button", { name: /去认证/ }));

    expect(screen.queryByText(/影子账号/)).not.toBeInTheDocument();
    expect(screen.queryByText(/SaaS/)).not.toBeInTheDocument();
  });

  it("shows the safety phone row after verification when phone proof is enabled", () => {
    realnamePhoneVerificationEnabled = true;
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "phone_3fa",
    };

    renderAccountPage();

    const safetyPhoneRow = screen.getByText("手机号").parentElement;
    expect(safetyPhoneRow).not.toBeNull();
    expect(within(safetyPhoneRow!).getByRole("button", { name: /修改/ })).toBeInTheDocument();
    expect(within(safetyPhoneRow!).queryByRole("button", { name: /绑定/ })).not.toBeInTheDocument();
    expect(screen.getByText("实名认证")).toBeInTheDocument();
  });

  it("shows the renew action by default for domestic active passes", () => {
    paidBillingEnabled = true;
    activePass = buildActivePass();

    renderAccountPage();

    expect(screen.getByText("启航套餐")).toBeInTheDocument();
    const subscriptionHeading = screen.getByRole("heading", { name: "订阅套餐" });
    const subscriptionHeader = subscriptionHeading.parentElement;

    expect(subscriptionHeader).not.toBeNull();
    expect(within(subscriptionHeader!).getByRole("button", { name: /立即续费/ })).toBeInTheDocument();
  });

  it.each([
    { usedPercent: 49, expectedColor: "var(--lw-accent)" },
    { usedPercent: 50, expectedColor: "#C67B1E" },
    { usedPercent: 79, expectedColor: "#C67B1E" },
    { usedPercent: 80, expectedColor: "#CF3D4C" },
    { usedPercent: 95, expectedColor: "#CF3D4C" },
    { usedPercent: 96, expectedColor: "#991B1B" },
  ])("uses $expectedColor for $usedPercent% credit usage", ({ usedPercent, expectedColor }) => {
    activePass = {
      ...buildActivePass(),
      credit_total: 100,
      credit_available: 100 - usedPercent,
    };

    const { container } = renderAccountPage();
    const percentage = screen.getByText(`${usedPercent}%`);
    const progressFill = container.querySelector<HTMLElement>(`[style*="width: ${usedPercent}%"]`);

    expect(percentage).toHaveStyle({ color: expectedColor });
    expect(progressFill).not.toBeNull();
    expect(progressFill).toHaveStyle({ background: expectedColor });
  });

  it("shows no model prompt at 95% credit usage", () => {
    activePass = {
      ...buildActivePass(),
      credit_total: 100,
      credit_available: 5,
    };

    renderAccountPage();

    expect(screen.queryByText(/模型积分即将用尽/)).not.toBeInTheDocument();
    expect(screen.queryByText(/模型积分已用尽/)).not.toBeInTheDocument();
  });

  it("links to model settings when credits are almost exhausted", () => {
    activePass = {
      ...buildActivePass(),
      credit_total: 100,
      credit_available: 4,
    };

    renderAccountPage();

    const modelLink = screen.getByRole("link", { name: "配置自有模型" });
    expect(modelLink.closest("p")).toHaveTextContent(
      "模型积分即将用尽，为避免智能体停止响应，请尽快配置自有模型",
    );
    expect(modelLink).toHaveAttribute("href", "/agents/models");
    expect(modelLink).toHaveClass("inline-flex", "items-center", "gap-0.5");
    expect(modelLink.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("links to model settings when credits are exhausted", () => {
    activePass = {
      ...buildActivePass(),
      credit_total: 100,
      credit_available: 0,
    };

    renderAccountPage();

    const modelLink = screen.getByRole("link", { name: "立即配置模型" });
    expect(modelLink.closest("p")).toHaveTextContent(
      "模型积分已用尽，如未配置自有模型，智能体将无法继续响应。立即配置模型",
    );
    expect(modelLink).toHaveAttribute("href", "/agents/models");
    expect(modelLink).toHaveClass("inline-flex", "items-center", "gap-0.5");
    expect(modelLink.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows no exhausted prompt when the plan has no model credits", () => {
    activePass = {
      ...buildActivePass(),
      credit_total: 0,
      credit_available: 0,
    };

    renderAccountPage();

    expect(screen.queryByText(/模型积分即将用尽/)).not.toBeInTheDocument();
    expect(screen.queryByText(/模型积分已用尽/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "立即配置模型" })).not.toBeInTheDocument();
  });

  it("keeps the safety phone hidden while showing the renew action by default", () => {
    realnamePhoneVerificationEnabled = true;
    paidBillingEnabled = true;
    activePass = buildActivePass();

    renderAccountPage();

    expect(screen.queryByText("安全手机")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /立即续费/ })).toBeInTheDocument();
  });

  it("opens the renewal modal with the new status wording and month or quarter choices only", async () => {
    paidBillingEnabled = true;
    activePass = buildActivePass();

    renderAccountPage();

    await userEvent.click(screen.getByRole("button", { name: /立即续费/ }));

    expect(await screen.findByText("续费套餐")).toBeInTheDocument();
    expect(screen.getByText("生效中")).toBeInTheDocument();
    expect(screen.queryByText("有效中")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /月付/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /季付/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /6个月/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1年|12个月/ })).not.toBeInTheDocument();
  });

  it("shows the realname guide in the renewal modal when an unverified user clicks renew", async () => {
    currentUser = {
      ...currentUser,
      realnameVerified: false,
      realnameLevel: "none",
    };
    paidBillingEnabled = true;
    activePass = buildActivePass();

    renderAccountPage();

    await userEvent.click(screen.getByRole("button", { name: /立即续费/ }));

    expect(await screen.findByText("续费套餐")).toBeInTheDocument();
    expect(await screen.findByText("续费前需先")).toBeInTheDocument();
    expect(screen.getByText("，完成后再确认续费。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "更新实名认证信息" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "确认续费" })).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(createRenewOrder).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "更新实名认证信息" }));

    expect(screen.queryByText("续费套餐")).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "实名认证" })).toBeInTheDocument();
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

  it("treats the legacy realname boolean as verified in pure realname mode", () => {
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: undefined,
    };

    renderAccountPage();

    expect(screen.getByText("已认证")).toBeInTheDocument();
    expect(screen.queryByText("待完成手机号认证")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /绑定安全手机/ })).not.toBeInTheDocument();
  });

  it("does not treat the legacy realname boolean as ID-card verification when the phone flag is enabled", async () => {
    realnamePhoneVerificationEnabled = true;
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: undefined,
    };

    renderAccountPage();

    const verifyButtons = screen.getAllByRole("button", { name: /去认证/ });
    expect(verifyButtons.length).toBeGreaterThan(0);
    await userEvent.click(verifyButtons[0]!);

    expect(screen.getByText("填写与你身份证一致的信息，完成实名认证。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入真实姓名")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("请输入身份证号码")).toBeInTheDocument();
    expect(screen.queryByText("第二步：输入当前手机号收到的短信验证码。")).not.toBeInTheDocument();
  });

  it("keeps safety-phone binding hidden but marks three-factor verification incomplete without a local phone", () => {
    currentUser = {
      ...currentUser,
      phone: undefined,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameAssuranceMode: "observe",
    };

    renderAccountPage();

    act(() => {
      ((window as Window & typeof globalThis & { show?: () => boolean }).show?.());
    });

    expect(screen.queryByText("安全手机")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /绑定安全手机/ })).not.toBeInTheDocument();
    expect(screen.queryByText("已认证")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "去认证" })).toBeInTheDocument();
  });

  it("shows retry action when ID-card realname passed but LightVela sync failed", async () => {
    realnamePhoneVerificationEnabled = true;
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

    expect(screen.getByText("实名信息同步失败")).toBeInTheDocument();
    expect(screen.queryByText("待完成手机号认证")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /重新同步/ }));

    expect(retryRealnameSync).toHaveBeenCalledTimes(1);
    expect(refreshProfile).toHaveBeenCalledTimes(1);
  });

  it("shows pending sync instead of asking for another phone verification", () => {
    realnamePhoneVerificationEnabled = true;
    currentUser = {
      ...currentUser,
      phone: "15625128341",
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      realnameSyncStatus: "pending",
    };

    renderAccountPage();

    expect(screen.getByText("实名信息同步中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新同步/ })).toBeInTheDocument();
    expect(screen.queryByText("待完成手机号认证")).not.toBeInTheDocument();
  });
});
