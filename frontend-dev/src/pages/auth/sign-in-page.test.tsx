import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "@/pages/auth/sign-in-page";

const mockGetOAuthStartUrl = vi.fn();
const mockPrepareInviteCode = vi.fn();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      getOAuthStartUrl: mockGetOAuthStartUrl,
      prepareInviteCode: mockPrepareInviteCode,
    },
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      verificationCooldownUntil: null,
    },
    sendVerificationCode: vi.fn(),
    signInWithCode: vi.fn(),
  }),
}));

describe("SignInPage", () => {
  beforeEach(() => {
    mockGetOAuthStartUrl.mockReset();
    mockGetOAuthStartUrl.mockReturnValue("https://lightclaw.tech/auth/oauth/qq/start");
    mockPrepareInviteCode.mockReset();
  });

  it("renders invite, phone login fields and the qq login entry", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "进入 Lightclaw" })).toBeInTheDocument();
    expect(screen.getByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.getByLabelText("手机号")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Verification code input" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 QQ 登录" })).toBeInTheDocument();
  });
});
