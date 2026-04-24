import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppAccessGuard, AuthRouteGuard } from "@/router/guards";

const mockUseSession = vi.fn();

vi.mock("@/contexts/session-context", () => ({
  useSession: () => mockUseSession(),
}));

describe("router guards", () => {
  beforeEach(() => {
    mockUseSession.mockReset();
  });

  it("redirects anonymous users from protected routes to sign-in", async () => {
    mockUseSession.mockReturnValue({
      authReady: true,
      isAuthenticated: false,
      planConfirmed: false,
    });

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route element={<AppAccessGuard />}>
            <Route path="/dashboard" element={<div>dashboard</div>} />
          </Route>
          <Route path="/auth/sign-in" element={<div>sign-in page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("sign-in page")).toBeInTheDocument();
  });

  it("redirects authenticated users away from the sign-in page", async () => {
    mockUseSession.mockReturnValue({
      authReady: true,
      isAuthenticated: true,
      planConfirmed: true,
    });

    render(
      <MemoryRouter initialEntries={["/auth/sign-in"]}>
        <Routes>
          <Route element={<AuthRouteGuard />}>
            <Route path="/auth/sign-in" element={<div>sign-in page</div>} />
          </Route>
          <Route path="/dashboard" element={<div>dashboard page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
  });
});
