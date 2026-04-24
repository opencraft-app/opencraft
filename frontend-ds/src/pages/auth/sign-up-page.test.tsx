import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignUpPage } from "@/pages/auth/sign-up-page";

const mockNavigate = vi.fn();
const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn(),
  },
};

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {},
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

vi.mock("@/pages/auth/use-generated-nickname", () => ({
  useGeneratedNickname: () => ({
    name: "海盐小猫",
    setName: vi.fn(),
    refreshName: vi.fn(),
  }),
}));

describe("SignUpPage", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    repositories.auth.getOAuthStartUrl.mockReset();
    repositories.auth.getOAuthStartUrl.mockReturnValue("https://lightclaw.tech/auth/oauth/qq/start");
  });

  it("redirects legacy sign-up traffic to the unified sign-in entry", () => {
    render(
      <MemoryRouter initialEntries={["/auth/sign-up"]}>
        <Routes>
          <Route path="/auth/sign-up" element={<SignUpPage />} />
          <Route path="/auth/sign-in" element={<div>统一登录入口</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("统一登录入口")).toBeInTheDocument();
  });
});
