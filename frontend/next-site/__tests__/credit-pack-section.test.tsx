import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditPackSection } from "../credit-pack-section";

const inquireCreditPrice = vi.fn();

/* 稳定引用：真实的 RepositoryContext 通过 useContext 返回同一对象，
   mock 也必须保持引用稳定，否则会掩盖/放大组件对引用稳定性的依赖问题。 */
const repositoriesStub = { credit: { inquireCreditPrice } };

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

const quoteFor = (productId: string) => ({
  product_id: productId,
  real_total_cost: "12.00",
  total_cost: "12.00",
  currency: "CNY" as const,
});

beforeEach(() => {
  inquireCreditPrice.mockReset();
  inquireCreditPrice.mockImplementation(async (productId: string) => quoteFor(productId));
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
      expect(screen.getAllByText("¥12.00")).toHaveLength(5);
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
      expect(screen.getAllByText("¥12.00")).toHaveLength(4);
    });
  });

  it("购买时因支付通道未接入而提示，且不发起下单请求", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_8000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));

    expect(await screen.findByRole("status")).toHaveTextContent("支付通道正在接入中，敬请期待。");
    /* 只应调用询价，不应有任何下单调用（仓储里也没暴露下单方法） */
    expect(inquireCreditPrice).toHaveBeenCalled();
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
