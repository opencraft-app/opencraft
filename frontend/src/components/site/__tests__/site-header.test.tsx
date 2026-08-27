import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicSiteHeader } from "@/components/site/public-site-header";

const translationMock = vi.hoisted(() => ({ language: "en-US" }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: translationMock.language } }),
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
  translationMock.language = "en-US";
});

describe("PublicSiteHeader", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows unified navigation and anonymous actions", () => {
    const onLoginClick = vi.fn();

    render(<PublicSiteHeader locale="zh-CN" onLoginClick={onLoginClick} onCreateClick={onLoginClick} />);

    expect(screen.getByRole("link", { name: "LightVela" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "更新日志" })).toHaveAttribute("href", "/changelog");
    expect(screen.getByRole("link", { name: "产品文档" })).toHaveAttribute("href", "/docs/overview");
    expect(screen.getByRole("link", { name: "关于我们" })).toHaveAttribute("href", "/about");

    fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    fireEvent.click(screen.getAllByRole("button", { name: "登录" })[0]!);

    expect(onLoginClick).toHaveBeenCalledTimes(2);
  });

  it("uses the injected public link renderer for logo and navigation links", () => {
    render(
      <PublicSiteHeader
        locale="zh-CN"
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

  it("keeps the brand, navigation, and actions in independent desktop grid columns", () => {
    render(
      <PublicSiteHeader
        authControls={<div data-testid="custom-header-actions">actions</div>}
        locale="zh-CN"
      />,
    );

    expect(screen.getByTestId("site-header-layout")).toHaveClass(
      "lg:grid",
      "lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
    );
    expect(screen.getByTestId("site-header-brand")).toHaveClass(
      "lg:col-start-1",
      "lg:justify-self-start",
    );
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toHaveClass(
      "lg:col-start-2",
      "lg:justify-self-center",
    );
    expect(screen.getByTestId("site-header-actions")).toHaveClass(
      "lg:col-start-3",
      "lg:justify-self-end",
    );
    expect(screen.getByTestId("site-header-brand")).toContainElement(
      screen.getByRole("link", { name: "LightVela" }),
    );
    expect(screen.getByTestId("site-header-actions")).toContainElement(
      screen.getByTestId("custom-header-actions"),
    );
  });

  it("uses Home wording for international homepage navigation", () => {
    const { rerender } = render(<PublicSiteHeader locale="zh-SG" />);

    expect(screen.getByRole("link", { name: "首页" })).toHaveAttribute("href", "/");

    rerender(<PublicSiteHeader locale="zh-Hant" />);
    expect(screen.getByRole("link", { name: "首頁" })).toHaveAttribute("href", "/");

    rerender(<PublicSiteHeader locale="en-US" />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");

    rerender(<PublicSiteHeader locale="id-ID" />);
    expect(screen.getByRole("link", { name: "Beranda" })).toHaveAttribute("href", "/");
  });

  it("infers Spanish header navigation and auth copy from the runtime language", async () => {
    translationMock.language = "es";

    render(<PublicSiteHeader onLoginClick={vi.fn()} />);

    expect(await screen.findByRole("link", { name: "Inicio" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Documentación" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear ahora" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Iniciar sesión" }).length).toBeGreaterThan(0);
  });


  it("links anonymous login actions to the sign-in page by default", () => {
    render(<PublicSiteHeader locale="zh-CN" />);

    expect(screen.getAllByRole("link", { name: "登录" })[0]).toHaveAttribute("href", "/auth/sign-in");
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

    render(<PublicSiteHeader locale="zh-CN" currentPath="/about" onLoginClick={onLoginClick} />);

    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));

    expect(screen.getAllByRole("link", { name: "首页" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole("link", { name: "关于我们" }).length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getByTestId("site-header-mobile-create"));

    expect(onLoginClick).toHaveBeenCalledTimes(1);
  });
});
