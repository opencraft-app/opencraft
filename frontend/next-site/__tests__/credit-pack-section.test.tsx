import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditPackSection } from "../credit-pack-section";

const inquireCreditPrice = vi.fn();
const createCreditOrder = vi.fn();
const createCreditOrderUrl = vi.fn();
const listCreditProducts = vi.fn();

/* 稳定引用：真实的 RepositoryContext 通过 useContext 返回同一对象，
   mock 也必须保持引用稳定，否则会掩盖/放大组件对引用稳定性的依赖问题。 */
const repositoriesStub = { credit: { inquireCreditPrice, createCreditOrder, createCreditOrderUrl, listCreditProducts } };

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositoriesStub,
}));

const renderSection = (overrides: Partial<Parameters<typeof CreditPackSection>[0]> = {}) =>
  render(
    <CreditPackSection
      isLoggedIn
      hasActivePlan
      onRequireLogin={() => undefined}
      onRequirePlan={() => undefined}
      {...overrides}
    />,
  );

/* 全部 5 个商品在线（联调文档 §4 的当前商品清单） */
const ALL_PRODUCTS_ONLINE = [
  "credit_1000",
  "credit_2000",
  "credit_4000",
  "credit_8000",
  "credit_12000",
].map((product_id) => ({
  product_id,
  product_name: `${product_id.replace("credit_", "")}积分`,
  llm_gateway_plan_id: `plan-${product_id}`,
  state: "ONLINE" as const,
}));

/* 询价金额：单位为分（联调文档 §5「最小货币单位」）。
   credit_8000 → 8000 分 = ¥80.00，用于验证分转元。 */
const quoteFor = (productId: string) => ({
  product_id: productId,
  real_total_cost: "8000",
  total_cost: "8000",
  currency: "CNY" as const,
});

beforeEach(() => {
  inquireCreditPrice.mockReset();
  inquireCreditPrice.mockImplementation(async (productId: string) => quoteFor(productId));
  createCreditOrder.mockReset();
  createCreditOrder.mockResolvedValue({ dealName: "deal-1", bigOrderId: "big-1" });
  createCreditOrderUrl.mockReset();
  createCreditOrderUrl.mockResolvedValue({
    deal_name: "deal-1",
    pay_url: "",
    need_charge: 0,
  });
  listCreditProducts.mockReset();
  listCreditProducts.mockResolvedValue(ALL_PRODUCTS_ONLINE);
});

afterEach(() => {
  cleanup();
});

describe("CreditPackSection", () => {
  it("渲染 5 张面额卡片并展示询价金额", async () => {
    renderSection();

    expect(await screen.findByText("1,000 模型积分")).toBeInTheDocument();
    expect(screen.getByText("12,000 模型积分")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("¥80.00")).toHaveLength(5);
    });
  });

  it("统一展示 1 个月有效期说明", async () => {
    renderSection();

    expect(
      await screen.findByText("积分包有效期为 1 个月，自支付成功并到账时起算；到期后未使用积分失效。"),
    ).toBeInTheDocument();
  });

  it("未选择商品时主按钮禁用", async () => {
    renderSection();

    const action = await screen.findByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("请选择积分包");
    expect(action).toBeDisabled();
  });

  it("已登录且有套餐时选中商品后可购买", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));

    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("购买所选积分包");
    expect(action).toBeEnabled();
  });

  it("未登录时提示登录并触发登录回调", async () => {
    const onRequireLogin = vi.fn();
    renderSection({ isLoggedIn: false, hasActivePlan: false, onRequireLogin });

    /* 用完整文本精确匹配：/2,000 模型积分/ 会同时命中 12,000 模型积分 */
    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_2000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("登录后购买");

    await userEvent.click(action);
    expect(onRequireLogin).toHaveBeenCalledTimes(1);
  });

  it("已登录但无有效套餐时引导先开通套餐", async () => {
    const onRequirePlan = vi.fn();
    renderSection({ hasActivePlan: false, onRequirePlan });

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_4000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("先开通套餐");

    await userEvent.click(action);
    expect(onRequirePlan).toHaveBeenCalledTimes(1);
  });

  it("单个商品询价失败只禁用该卡片，其他卡片仍可选", async () => {
    inquireCreditPrice.mockImplementation(async (productId: string) => {
      if (productId === "credit_1000") throw new Error("quote failed");
      return quoteFor(productId);
    });

    renderSection();

    const failedCard = await screen.findByTestId("credit-pack-card-credit_1000");
    await waitFor(() => {
      expect(failedCard).toBeDisabled();
    });

    const healthyCard = screen.getByTestId("credit-pack-card-credit_2000");
    expect(healthyCard).toBeEnabled();
    await waitFor(() => {
      expect(screen.getAllByText("¥80.00")).toHaveLength(4);
    });
  });

  it("购买流程：选中商品 → 打开弹窗 → 未勾选条款时支付禁用", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_8000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));

    const modal = await screen.findByTestId("credit-pack-confirm-modal");
    expect(modal).toBeInTheDocument();
    /* 弹窗展示商品与金额（卡片上也有同样文本，用 getAllByText 断言至少两处） */
    expect(screen.getAllByText("8,000 模型积分").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("¥80.00").length).toBeGreaterThanOrEqual(2);

    const payButton = screen.getByTestId("credit-pack-confirm-pay");
    expect(payButton).toBeDisabled();

    /* 勾选条款后可支付 */
    await userEvent.click(screen.getByTestId("credit-pack-terms-checkbox"));
    expect(payButton).toBeEnabled();
  });

  it("勾选条款后确认支付会创建订单并请求支付链接", async () => {
    createCreditOrderUrl.mockResolvedValue({ deal_name: "deal-1", pay_url: "", need_charge: 0 });

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_8000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(createCreditOrder).toHaveBeenCalledWith("credit_8000");
    });
    await waitFor(() => {
      expect(createCreditOrderUrl).toHaveBeenCalledWith(
        expect.objectContaining({ deal_name: "deal-1", platform: "pc" }),
      );
    });
  });

  it("need_charge=1 时跳转支付页并展示跳转提示", async () => {
    createCreditOrderUrl.mockResolvedValue({
      deal_name: "deal-1",
      pay_url: "https://pay.example/checkout",
      need_charge: 1,
    });
    const assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignMock, href: "https://app.example/subscribe" },
      writable: true,
    });

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://pay.example/checkout");
    });
    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-checkout-status")).toHaveTextContent("已跳转支付页面");
    });
  });

  it("下单失败时展示失败原因", async () => {
    createCreditOrder.mockRejectedValue(new Error("余额渠道不可用"));

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-checkout-status")).toHaveTextContent("下单失败");
    });
  });

  it("金额按分转元展示（联调文档 §5 最小货币单位）", async () => {
    /* quoteFor 返回 8000 分；直接拼字符串会错误显示 ¥8000 */
    renderSection();

    await waitFor(() => {
      expect(screen.getAllByText("¥80.00")).toHaveLength(5);
    });
    expect(screen.queryByText("¥8000")).not.toBeInTheDocument();
  });

  it("商品列表以接口为准：OFFLINE 商品不渲染", async () => {
    listCreditProducts.mockResolvedValue(
      ALL_PRODUCTS_ONLINE.filter((p) => p.product_id !== "credit_12000"),
    );

    renderSection();

    await screen.findByTestId("credit-pack-card-credit_1000");
    expect(screen.queryByTestId("credit-pack-card-credit_12000")).not.toBeInTheDocument();
  });

  it("询价返回 409（商品下线）时取消选中并刷新商品列表", async () => {
    const { RepositoryError } = await import("@/repositories/http-repositories");
    inquireCreditPrice.mockImplementation(async (productId: string) => {
      if (productId === "credit_4000") throw new RepositoryError("商品已下线", 409);
      return quoteFor(productId);
    });

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_4000"));
    expect(screen.getByTestId("credit-pack-primary-action")).toHaveTextContent("请选择积分包");

    await waitFor(() => {
      expect(listCreditProducts).toHaveBeenCalledTimes(2);
    });
  });

  it("按 product_id 逐个询价，覆盖全部 5 个商品", async () => {
    renderSection();

    await waitFor(() => {
      expect(inquireCreditPrice).toHaveBeenCalledTimes(5);
    });
    expect(inquireCreditPrice.mock.calls.map(([id]) => id)).toEqual([
      "credit_1000",
      "credit_2000",
      "credit_4000",
      "credit_8000",
      "credit_12000",
    ]);
  });
});
