import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountOrdersTable,
  type OrderItem,
} from "../account-orders-table";

const orders: readonly OrderItem[] = [
  {
    id: "202604167832",
    description: "活动赠送包",
    type: "购买",
    duration: "–",
    quantity: 1,
    amount: "0.00 CNY",
    date: "2026-04-16 21:52:02",
    status: "已完成",
  },
];

afterEach(cleanup);

describe("AccountOrdersTable", () => {
  it("keeps the desktop field order, status, currency formatter, and disabled single-page navigation", () => {
    const { rerender } = render(
      <AccountOrdersTable
        orders={orders}
        currencyFormatter={(amount) => amount}
        pagination={{ currentPage: 1, pageSize: 10, totalCount: orders.length }}
      />,
    );

    const table = screen.getByRole("table", { name: "订单历史" });
    expect(table.parentElement).toHaveClass("hidden", "lg:block");
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "订单号",
      "描述",
      "类型",
      "时长",
      "数量",
      "金额",
      "日期",
      "状态",
    ]);
    expect(within(table).getByText("0.00 CNY")).toBeVisible();
    expect(within(table).getByText("已完成")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("共 1 条数据")).toBeVisible();
    expect(screen.getByText("10 条/页")).toBeVisible();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();

    rerender(
      <AccountOrdersTable
        orders={orders}
        currencyFormatter={() => "$0.00"}
        pagination={{ currentPage: 1, pageSize: 10, totalCount: orders.length }}
      />,
    );
    expect(within(screen.getByRole("table", { name: "订单历史" })).getByText("$0.00")).toBeVisible();
  });

  it("keeps every order field readable in the narrow-screen stacked list without a horizontal scroller", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    render(
      <AccountOrdersTable
        orders={orders}
        currencyFormatter={() => "$0.00"}
        pagination={{ currentPage: 1, pageSize: 10, totalCount: orders.length }}
      />,
    );

    const mobileList = screen.getByTestId("account-orders-mobile-list");
    expect(mobileList).toHaveClass("lg:hidden");
    expect(within(mobileList).getByText("202604167832")).toBeVisible();
    expect(within(mobileList).getByText("活动赠送包")).toBeVisible();
    expect(within(mobileList).getByText("购买")).toBeVisible();
    expect(within(mobileList).getByText("时长").nextElementSibling).toHaveTextContent("–");
    expect(within(mobileList).getByText("数量").nextElementSibling).toHaveTextContent("1");
    expect(within(mobileList).getByText("$0.00")).toBeVisible();
    expect(within(mobileList).getByText("2026-04-16 21:52:02")).toBeVisible();
    expect(within(mobileList).getByText("已完成")).toBeVisible();
  });
});
