import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HeaderSection from "../HeaderSection";

let sessionState = {
  authReady: true,
  isAuthenticated: false,
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionState,
}));

vi.mock("@/components/site/user-avatar-menu", () => ({
  UserAvatarMenu: () => <button type="button">avatar menu</button>,
}));

vi.mock("@/components/site/language-switcher", () => ({
  LanguageSwitcher: () => <div>language switcher</div>,
}));

describe("HeaderSection", () => {
  beforeEach(() => {
    sessionState = {
      authReady: true,
      isAuthenticated: false,
    };
  });

  afterEach(() => {
    cleanup();
  });

  it("shows login actions for anonymous visitors", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <HeaderSection />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "立即创建" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "avatar menu" })).not.toBeInTheDocument();
  });

  it("shows the avatar menu instead of login actions for signed-in visitors", () => {
    sessionState = {
      authReady: true,
      isAuthenticated: true,
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <HeaderSection />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "avatar menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即创建" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });
});
