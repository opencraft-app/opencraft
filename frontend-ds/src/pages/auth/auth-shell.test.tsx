import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthShell } from "@/pages/auth/auth-shell";

describe("AuthShell", () => {
  it("keeps the showcase layout editorial while reserving a fixed auth panel on large screens", () => {
    render(
      <MemoryRouter>
        <AuthShell title="手机号登录" subtitle="输入手机号和验证码，登录后可直接进入 Lightclaw 控制台。" showShowcase>
          <form>
            <button type="submit">登录</button>
          </form>
        </AuthShell>
      </MemoryRouter>,
    );

    const title = screen.getByText("手机号登录");
    const card = title.closest("div[class*='rounded']");
    const shellRoot = card?.parentElement;
    const heroCopy = screen.getByText("从首页的气质进入控制台，而不是换一套产品。");

    expect(card).not.toBeNull();
    expect(card).toHaveClass("lg:min-h-[34rem]");
    expect(card).toHaveClass("rounded-[2rem]");
    expect(shellRoot).toHaveClass("lg:grid-cols-[minmax(0,1fr)_420px]");
    expect(heroCopy).toBeInTheDocument();
  });
});
