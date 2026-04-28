import { MemoryRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarketingHeaderActions } from "@/components/site/marketing-header-actions";

describe("MarketingHeaderActions", () => {
  it("shows a single primary action for anonymous visitors", () => {
    render(
      <MemoryRouter>
        <MarketingHeaderActions isAuthenticated={false} planConfirmed={false} onSignOut={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始使用" })).toHaveAttribute("href", "/auth/sign-in");
  });

  it("shows signed-in state and control-center action for confirmed users", () => {
    render(
      <MemoryRouter>
        <MarketingHeaderActions
          isAuthenticated
          planConfirmed
          displayName="海盐小猫"
          onSignOut={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("海盐小猫")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入控制台" })).toHaveAttribute("href", "/dashboard/settings");
    expect(screen.getByRole("button", { name: "退出" })).toBeInTheDocument();
  });

  it("guides signed-in users without a plan to continue setup", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <MarketingHeaderActions
          isAuthenticated
          planConfirmed={false}
          displayName="海盐小猫"
          onSignOut={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "继续设置" })).toHaveAttribute("href", "/plans/select");
  });

  it("removes the extra step action on the plan page", () => {
    const view = render(
      <MemoryRouter initialEntries={["/plans/select"]}>
        <MarketingHeaderActions
          isAuthenticated
          planConfirmed={false}
          displayName="海盐小猫"
          onSignOut={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(within(view.container).queryByRole("link", { name: "继续设置" })).not.toBeInTheDocument();
    expect(within(view.container).queryByText("正在选择档位")).not.toBeInTheDocument();
  });
});
