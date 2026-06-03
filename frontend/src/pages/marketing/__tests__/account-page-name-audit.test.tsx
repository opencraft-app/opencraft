import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/domain/types";
import { AccountPage } from "@/pages/marketing/account-page";

const updateProfile = vi.fn();
const uploadAvatar = vi.fn();
const signOut = vi.fn();
const deleteAccount = vi.fn();
const signInAsGuest = vi.fn();

let currentUser: User;

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/lib/region", () => ({
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

describe("AccountPage nickname audit state", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    currentUser = {
      id: "usr_profile_audit",
      name: "旧昵称",
      inviteRequired: false,
      realnameVerified: true,
      createdAt: "2026-06-01T00:00:00Z",
    };
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

    expect(screen.getByRole("textbox")).toHaveValue("待审核昵称");
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

  it("blocks nickname updates while the UGC system is under maintenance", async () => {
    renderAccountPage();

    await userEvent.click(screen.getByRole("button", { name: "修改昵称" }));
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "新昵称");
    await userEvent.click(screen.getByRole("button", { name: "保存昵称" }));

    expect(screen.getByText("UGC 系统维护中，暂时无法提交昵称或头像修改。")).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("blocks avatar uploads while the UGC system is under maintenance", async () => {
    const { container } = renderAccountPage();
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');

    expect(fileInput).not.toBeNull();

    await userEvent.upload(
      fileInput!,
      new File(["avatar"], "avatar.png", { type: "image/png" }),
    );

    expect(screen.getByText("UGC 系统维护中，暂时无法提交昵称或头像修改。")).toBeInTheDocument();
    expect(uploadAvatar).not.toHaveBeenCalled();
  });
});
