import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountOrdersPage } from "../account-orders-page";

const shellProps = vi.hoisted(() => ({ footer: undefined as ReactNode }));

vi.mock("@/components/site/product-chrome", () => ({
  ProductPageShell: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => {
    shellProps.footer = footer;
    return <div data-testid="product-page-shell">{children}</div>;
  },
}));
vi.mock("@/lib/region", () => ({ isGlobal: false }));

afterEach(cleanup);

describe("AccountOrdersPage", () => {
  it("uses the private product shell, Agents visual scope, display title, and the unchanged order sequence", () => {
    render(<AccountOrdersPage />);

    expect(shellProps.footer).toBeNull();
    expect(screen.getByTestId("product-page-shell").firstElementChild).toHaveClass("agents-ui");
    expect(screen.getByRole("heading", { name: "订单历史", level: 1 })).toHaveClass("font-display-zh");
    expect(screen.getByRole("link", { name: "返回账号信息" })).toHaveAttribute("href", "/account");
    const desktopRows = screen.getByRole("table", { name: "订单历史" }).querySelectorAll("tbody tr");
    expect(Array.from(desktopRows, (row) => row.getAttribute("data-order-id"))).toEqual([
      "202604167832",
      "202604021456",
      "202603261893",
      "202603262047",
      "202602231100",
    ]);
    expect(screen.getByText("共 5 条数据")).toBeVisible();
  });

  it("opens the accessible invoice dialog from the shared button", async () => {
    render(<AccountOrdersPage />);
    await userEvent.click(screen.getByRole("button", { name: "申请发票" }));
    expect(screen.getByRole("dialog", { name: "申请发票" })).toBeVisible();
  });
});
