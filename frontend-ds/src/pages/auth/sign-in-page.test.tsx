import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "@/pages/auth/sign-in-page";

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn(),
    prepareInviteCode: vi.fn(),
  },
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {},
    signInAsGuest: vi.fn(),
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

describe("SignInPage", () => {
  beforeEach(() => {
    repositories.auth.getOAuthStartUrl.mockReset();
    repositories.auth.getOAuthStartUrl.mockReturnValue("https://lightclaw.tech/auth/oauth/qq/start");
    repositories.auth.prepareInviteCode.mockReset();
    repositories.auth.prepareInviteCode.mockResolvedValue(undefined);
  });

  it("renders invite code input, QQ login, and guest button", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 QQ 登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "游客体验" })).toBeInTheDocument();
    expect(screen.getByText("选择一种方式开始体验。")).toBeInTheDocument();
  });
});
