import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SiteHeader } from "@/components/site/site-header";

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
  LanguageSwitcher: ({ variant }: { variant?: string }) => (
    <div>{variant === "inline" ? "language switcher inline" : "language switcher"}</div>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("SiteHeader", () => {
  beforeEach(() => {
    sessionState = {
      authReady: true,
      isAuthenticated: false,
    };
  });

  it("shows unified navigation and anonymous actions", () => {
    const onLoginClick = vi.fn();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <SiteHeader onLoginClick={onLoginClick} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "概览" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "产品文档" })).toHaveAttribute("href", "/docs");
    expect(screen.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/about");

    fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    fireEvent.click(screen.getAllByRole("button", { name: "登录" })[0]!);

    expect(onLoginClick).toHaveBeenCalledTimes(2);
  });

  it("keeps auth actions hidden while the session is hydrating", () => {
    sessionState = {
      authReady: false,
      isAuthenticated: false,
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <SiteHeader onLoginClick={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "立即创建" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.getByTestId("site-header-auth-loading")).toBeInTheDocument();
  });

  it("shows the avatar menu for signed-in users instead of legacy marketing actions", () => {
    sessionState = {
      authReady: true,
      isAuthenticated: true,
    };

    render(
      <MemoryRouter initialEntries={["/dashboard/settings"]}>
        <SiteHeader onLoginClick={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "avatar menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出" })).not.toBeInTheDocument();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
  });

  it("keeps mobile menu navigation and creation action together", () => {
    const onLoginClick = vi.fn();

    render(
      <MemoryRouter initialEntries={["/about"]}>
        <SiteHeader onLoginClick={onLoginClick} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));

    expect(screen.getAllByRole("link", { name: "概览" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("link", { name: "关于我们" }).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId("site-header-mobile-create"));

    expect(onLoginClick).toHaveBeenCalledTimes(1);
  });
});
