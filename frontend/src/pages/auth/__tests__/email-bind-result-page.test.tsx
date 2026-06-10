import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBindResultPage } from "@/pages/auth/email-bind-result-page";

const renderPage = (route: string) => render(
  <MemoryRouter initialEntries={[route]}>
    <EmailBindResultPage />
  </MemoryRouter>,
);

describe("EmailBindResultPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("展示邮箱绑定成功结果并允许关闭页面", () => {
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => undefined);

    renderPage("/auth/email-bind-result?status=success");

    expect(screen.getByRole("heading", { name: "邮箱绑定成功" })).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    screen.getByRole("button", { name: /关闭此页面/ }).click();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("展示邮箱已被占用结果", () => {
    renderPage("/auth/email-bind-result?status=in_use");

    expect(screen.getByRole("heading", { name: "该邮箱已被其他账号使用" })).toBeInTheDocument();
    expect(screen.getByText("无法绑定")).toBeInTheDocument();
  });

  it("未知状态回落为失败结果", () => {
    renderPage("/auth/email-bind-result?status=unknown");

    expect(screen.getByRole("heading", { name: "邮箱绑定失败" })).toBeInTheDocument();
    expect(screen.getByText("未完成")).toBeInTheDocument();
  });
});
