import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicSiteHeader } from "@/components/site/public-site-header";

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

describe("PublicSiteHeader", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows unified navigation and anonymous actions", () => {
    const onLoginClick = vi.fn();

    render(<PublicSiteHeader onLoginClick={onLoginClick} onCreateClick={onLoginClick} />);

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "概览" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "产品文档" })).toHaveAttribute("href", "/docs/overview");
    expect(screen.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/about");

    fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    fireEvent.click(screen.getAllByRole("button", { name: "登录" })[0]!);

    expect(onLoginClick).toHaveBeenCalledTimes(2);
  });

  it("uses the injected public link renderer for logo and navigation links", () => {
    render(
      <PublicSiteHeader
        renderLink={({ ariaLabel, children, ...props }) => (
          <a {...props} aria-label={ariaLabel} data-next-link="true">
            {children}
          </a>
        )}
      />,
    );

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("data-next-link", "true");
    expect(screen.getByRole("link", { name: "产品文档" })).toHaveAttribute("data-next-link", "true");
  });

  it("keeps auth actions hidden while the session is hydrating", () => {
    render(<PublicSiteHeader authSnapshot={{ authReady: false, isAuthenticated: false }} onLoginClick={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "立即创建" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.getByTestId("site-header-auth-loading")).toBeInTheDocument();
  });

  it("shows the avatar menu for signed-in users instead of legacy marketing actions", () => {
    render(<PublicSiteHeader authSnapshot={{ authReady: true, isAuthenticated: true }} currentPath="/dashboard/settings" onLoginClick={vi.fn()} />);

    expect(screen.getByRole("button", { name: "avatar menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "退出" })).not.toBeInTheDocument();
    expect(screen.queryByText("已登录")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "进入控制台" })).not.toBeInTheDocument();
  });

  it("keeps mobile menu navigation and creation action together", () => {
    const onLoginClick = vi.fn();

    render(<PublicSiteHeader currentPath="/about" onLoginClick={onLoginClick} />);

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));

    expect(screen.getAllByRole("link", { name: "概览" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("link", { name: "关于我们" }).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId("site-header-mobile-create"));

    expect(onLoginClick).toHaveBeenCalledTimes(1);
  });
});
