import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditPackSection } from "../credit-pack-section";

/* 站点切换：getter 型 mock（默认国内站，国际站用例显式切换）。
   vi.hoisted 把 state 声明提升到 import 之前，避免 vi.mock 工厂（import 期执行）
   触发 'Cannot access before initialization' 的 TDZ 错误。 */
const regionState = vi.hoisted(() => ({ isGlobal: false }));
vi.mock("@/lib/region", async (importOriginal) => {
  /* 保留 region 的其他导出（readLocaleFromPath 等），只覆写站点判定两个 getter */
  const actual = await importOriginal<typeof import("@/lib/region")>();
  return {
    ...actual,
    get isGlobal() {
      return regionState.isGlobal;
    },
    get isCN() {
      return !regionState.isGlobal;
    },
  };
});

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
  price: "8000",
  real_total_cost: "8000",
  total_cost: "8000",
  currency: "CNY" as const,
  discount: 100,
});

beforeEach(() => {
  regionState.isGlobal = false;
  inquireCreditPrice.mockReset();
  inquireCreditPrice.mockImplementation(async (productId: string) => quoteFor(productId));
  createCreditOrder.mockReset();
  createCreditOrder.mockResolvedValue({ dealName: "deal-1", bigOrderId: "big-1", auth_code: "auth-1" });
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
  it("展示模型积分文案并使用黑色主操作样式", async () => {
    renderSection();

    expect(screen.getByRole("heading", { name: "模型积分" })).toBeInTheDocument();
    expect(screen.getByText("选购模型积分，畅享更多大模型调用")).toBeInTheDocument();
    expect(
      screen.getByText(
        "适用于已有有效套餐、需要增加模型调用额度的用户。实际抵扣优先使用到期时间更早的额度；到期时间相同时，优先使用创建时间更早的额度。",
      ),
    ).toBeInTheDocument();

    const action = await screen.findByTestId("credit-pack-primary-action");
    expect(action).toHaveClass("bg-[var(--text-primary)]");
    expect(action.className).not.toContain("#4f46e5");
    expect(action.getAttribute("style") ?? "").not.toContain("#4f46e5");
  });

  it("选中积分卡片后展示黑色边框和独立绿色勾选", async () => {
    renderSection();

    const card = await screen.findByTestId("credit-pack-card-credit_1000");
    const indicator = screen.getByTestId("credit-pack-selected-indicator-credit_1000");

    expect(card).toHaveClass("border-2", "bg-white");
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(indicator).toHaveClass("invisible", "text-[#07C160]");

    await userEvent.click(card);

    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveClass("border-2", "border-[var(--text-primary)]", "bg-white");
    expect(indicator).not.toHaveClass("invisible", "rounded-full", "bg-[#07C160]");
    expect(indicator).toHaveClass("text-[#07C160]");
  });

  it("渲染 5 张面额卡片并展示询价总价", async () => {
    renderSection();

    expect(await screen.findByText("1,000 模型积分")).toBeInTheDocument();
    expect(screen.getByText("12,000 模型积分")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("¥80.00")).toHaveLength(5);
    });
    expect(screen.queryByText("最终付款价格包含税费，请以付款页面显示为准。")).not.toBeInTheDocument();
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

  it("询价加载中时未登录用户仍提示登录", async () => {
    inquireCreditPrice.mockImplementation(() => new Promise(() => undefined));
    const onRequireLogin = vi.fn();
    renderSection({ isLoggedIn: false, hasActivePlan: false, onRequireLogin });

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_2000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("登录后购买");
    expect(action).toBeEnabled();

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

  it("询价加载中时无有效套餐用户仍提示先开通套餐", async () => {
    inquireCreditPrice.mockImplementation(() => new Promise(() => undefined));
    const onRequirePlan = vi.fn();
    renderSection({ hasActivePlan: false, onRequirePlan });

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_4000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("先开通套餐");
    expect(action).toBeEnabled();

    await userEvent.click(action);
    expect(onRequirePlan).toHaveBeenCalledTimes(1);
  });

  it("询价加载中时已登录且有套餐用户不能下单，直到询价完成", async () => {
    inquireCreditPrice.mockImplementation(() => new Promise(() => undefined));
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("加载中…");
    expect(action).toBeDisabled();
    expect(screen.queryByTestId("credit-pack-confirm-modal")).not.toBeInTheDocument();
  });

  it("已登录但未完成实名时展示询价价格并禁用购买，提供实名入口", async () => {
    const onRequireRealname = vi.fn();
    renderSection({ canPurchaseCreditPack: false, onRequireRealname });

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    const action = screen.getByTestId("credit-pack-primary-action");
    expect(action).toHaveTextContent("完成实名后购买");
    expect(action).toBeDisabled();
    expect(screen.getAllByText("¥80.00").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByTestId("credit-pack-realname-action"));
    expect(onRequireRealname).toHaveBeenCalledTimes(1);
  });

  it("单个商品询价失败时禁用该卡片，其他卡片仍可购买", async () => {
    inquireCreditPrice.mockImplementation(async (productId: string) => {
      if (productId === "credit_1000") throw new Error("quote failed");
      return quoteFor(productId);
    });

    renderSection();

    const failedCard = await screen.findByTestId("credit-pack-card-credit_1000");
    await waitFor(() => expect(failedCard).toBeDisabled());

    const healthyCard = screen.getByTestId("credit-pack-card-credit_2000");
    expect(healthyCard).toBeEnabled();
    expect(screen.getAllByText("¥80.00").length).toBeGreaterThan(0);
  });

  it("询价失败可单独重试该商品并恢复购买，不重新询价正常商品", async () => {
    inquireCreditPrice.mockImplementation(async (productId: string) => {
      if (productId === "credit_1000") throw new Error("temporary failure");
      return quoteFor(productId);
    });
    renderSection();

    const card = await screen.findByTestId("credit-pack-card-credit_1000");
    await waitFor(() => expect(card).toBeDisabled());
    inquireCreditPrice.mockImplementation(async (productId: string) => quoteFor(productId));
    await userEvent.click(screen.getByTestId("credit-pack-retry-credit_1000"));
    await waitFor(() => expect(card).toBeEnabled());
    expect(inquireCreditPrice).toHaveBeenCalledTimes(6);
    expect(inquireCreditPrice).toHaveBeenLastCalledWith("credit_1000");
    await userEvent.click(card);
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    expect(await screen.findByRole("heading", { name: "确认订单" })).toBeInTheDocument();
  });

  it("全部询价失败时仍有逐商品重试入口", async () => {
    inquireCreditPrice.mockRejectedValue(new Error("offline"));
    renderSection();
    const retries = await screen.findAllByRole("button", { name: "重试" });
    expect(retries).toHaveLength(5);
    inquireCreditPrice.mockImplementation(async (productId: string) => quoteFor(productId));
    await userEvent.click(retries[0]);
    await waitFor(() => expect(screen.getByTestId("credit-pack-card-credit_1000")).toBeEnabled());
    expect(inquireCreditPrice).toHaveBeenCalledTimes(6);
  });

  it.each(["", "   ", "80.00", "1e3", "0x10", "8000.5", "-1", "9007199254740992"])(
    "拒绝非法的分单位金额 %j，不能作为零元或有效询价购买",
    async (value) => {
      inquireCreditPrice.mockImplementation(async (productId: string) => ({
        ...quoteFor(productId),
        price: value,
        real_total_cost: value,
      }));
      renderSection();
      const card = await screen.findByTestId("credit-pack-card-credit_1000");
      await waitFor(() => expect(card).toBeDisabled());
      expect(within(card).getByText("价格暂不可用")).toBeInTheDocument();
      expect(screen.getByTestId("credit-pack-primary-action")).toBeDisabled();
      expect(createCreditOrder).not.toHaveBeenCalled();
    },
  );

  it("购买流程：选中商品 → 打开弹窗 → 未勾选条款时支付禁用", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_8000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));

    const modal = await screen.findByTestId("credit-pack-confirm-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确认订单" })).toBeInTheDocument();
    expect(screen.getByText("订单详情")).toBeInTheDocument();
    expect(screen.getByText("到账后 1 个月")).toBeInTheDocument();
    expect(screen.queryByTestId("credit-pack-price-breakdown")).not.toBeInTheDocument();
    expect(screen.getByText("微信支付")).toBeInTheDocument();
    /* 弹窗展示商品与金额（卡片上也有同样文本，用 getAllByText 断言至少两处） */
    expect(screen.getAllByText("8,000 模型积分").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("¥80.00").length).toBeGreaterThanOrEqual(2);
    expect(within(modal).queryByText("税费")).not.toBeInTheDocument();
    expect(within(modal).queryByText("最终付款价格包含税费，请以付款页面显示为准。")).not.toBeInTheDocument();
    expect(screen.getByTestId("credit-pack-terms-checkbox").parentElement?.textContent).toContain(
      "法律规定、重复扣款或平台交付异常等情况，由客服核验处理。",
    );

    const payButton = screen.getByTestId("credit-pack-confirm-pay");
    expect(payButton).toHaveTextContent("支付 ¥80.00");
    expect(payButton).toBeDisabled();

    /* 勾选条款后可支付 */
    await userEvent.click(screen.getByTestId("credit-pack-terms-checkbox"));
    expect(payButton).toBeEnabled();
  });

  it("勾选条款后确认支付会创建订单（国内站不请求支付链接）", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_8000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(createCreditOrder).toHaveBeenCalledWith("credit_8000");
    });
    /* 国内站走中转页二维码，PC 端不调 order-url（wx-pay 编排约束） */
    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-wx-qr")).toBeInTheDocument();
    });
    expect(createCreditOrderUrl).not.toHaveBeenCalled();
  });

  it("国内站确认支付后展示微信扫码二维码，不请求支付链接", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    /* 国内站：中转页 + wxSign 模式，PC 端不调 order-url */
    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-wx-qr")).toBeInTheDocument();
    });
    expect(createCreditOrderUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "请完成支付" })).toBeInTheDocument();
    expect(screen.getByText("请使用微信扫描下方二维码完成支付")).toBeInTheDocument();
    expect(screen.getByText("支付完成后，需等待约 15 秒完成下单")).toBeInTheDocument();
    expect(screen.getByTestId("credit-pack-qr-panel")).toHaveClass("bg-[var(--surface-muted)]");
    expect(screen.getByTestId("credit-pack-recheck")).toHaveClass("border", "bg-white");
  });

  it("切换卡片后恢复未完成订单时仍展示原订单商品", async () => {
    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));
    await screen.findByTestId("credit-pack-wx-qr");

    await userEvent.click(screen.getByRole("button", { name: "暂不处理" }));
    await userEvent.click(screen.getByTestId("credit-pack-card-credit_2000"));

    const primaryAction = screen.getByTestId("credit-pack-primary-action");
    expect(primaryAction).toHaveTextContent("订单详情");
    await userEvent.click(primaryAction);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("1,000 模型积分")).toBeInTheDocument();
    expect(within(dialog).queryByText("2,000 模型积分")).not.toBeInTheDocument();
    expect(createCreditOrder).toHaveBeenCalledTimes(1);
    expect(createCreditOrder).toHaveBeenCalledWith("credit_1000");
  });

  it("need_charge=1 时经占位窗口打开支付页（国际站，对齐 pass 的 startIntlCardPay）", async () => {
    regionState.isGlobal = true;
    createCreditOrderUrl.mockResolvedValue({
      deal_name: "deal-1",
      pay_url: "https://pay.example/checkout",
      need_charge: 1,
    });
    /* mock window.open：返回占位窗对象，断言 pay_url 赋给占位窗而非 location.assign */
    const payWindowStub = { location: { href: "" } };
    const openMock = vi.fn(() => payWindowStub);
    Object.defineProperty(window, "open", { value: openMock, writable: true });

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("about:blank", "_blank");
    });
    await waitFor(() => {
      expect(payWindowStub.location.href).toBe("https://pay.example/checkout");
    });
    /* 国际站固定文案（对齐套餐） */
    expect(screen.getByText("已在新窗口打开信用卡支付页")).toBeInTheDocument();
  });

  it("下单失败时弹窗内展示失败原因，弹窗外不挂警告行", async () => {
    createCreditOrder.mockRejectedValue(new Error("余额渠道不可用"));

    renderSection();

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "支付遇到问题" })).toBeInTheDocument();
    });
    /* 失败原因在弹窗内展示（failed 与用户「暂不处理」的搁置语义一致：不再往页面挂警告） */
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent("支付未完成");
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent("余额渠道不可用");
    expect(screen.getByRole("button", { name: "重新下单" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不处理" })).toBeInTheDocument();
    expect(screen.queryByTestId("credit-pack-checkout-status")).not.toBeInTheDocument();
  });

  it("下单时发现影子账号绑定缺失会引导实名认证且不允许重复下单", async () => {
    const { RepositoryError } = await import("@/repositories/http-repositories");
    const onRequireRealname = vi.fn();
    createCreditOrder.mockRejectedValue(new RepositoryError("shadow binding is required", 422, "BindingNotFound"));

    renderSection({ onRequireRealname });

    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    expect(await screen.findByRole("heading", { name: "请完成实名认证" })).toBeInTheDocument();
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent("请先完成实名认证");
    expect(screen.getByTestId("credit-pack-modal-realname-action")).toBeInTheDocument();
    expect(screen.queryByTestId("credit-pack-reorder")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("credit-pack-modal-realname-action"));
    expect(onRequireRealname).toHaveBeenCalledTimes(1);
  });

  it("国际站无折扣报价展示实测美元价格、税费差额和总价", async () => {
    inquireCreditPrice.mockImplementation(async (productId: string) => ({
      ...quoteFor(productId),
      currency: "USD" as const,
      price: "180",
      total_cost: "180",
      real_total_cost: "197",
    }));
    regionState.isGlobal = true;
    renderSection();

    await waitFor(() => {
      expect(screen.getAllByText("$1.97")).toHaveLength(5);
    });
    expect(screen.queryByText("¥8000")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    const breakdown = await screen.findByTestId("credit-pack-price-breakdown");
    expect(breakdown).toHaveTextContent("积分包价格$1.80");
    expect(breakdown).toHaveTextContent("税费$0.17");
    expect(breakdown).toHaveTextContent("最终付款价格包含税费，请以付款页面显示为准。");
    expect(screen.getByTestId("credit-pack-confirm-pay")).toHaveTextContent("支付 $1.97");
  });

  it.each([
    { label: "国内折扣", global: false, price: "8000", total: "7200", totalCost: "8000", discount: 90, amount: "¥72.00" },
    { label: "国际折扣低于原价", global: true, price: "1000", total: "880", totalCost: "1000", discount: 80, amount: "$8.80" },
    { label: "国际折扣含税后高于原价", global: true, price: "1000", total: "1046", totalCost: "1000", discount: 96, amount: "$10.46" },
    { label: "国际缺少折扣字段", global: true, price: "180", total: "197", totalCost: "180", discount: undefined, amount: "$1.97" },
    { label: "国际原价字段不一致", global: true, price: "180", total: "197", totalCost: "190", discount: 100, amount: "$1.97" },
    { label: "国际缺少原价总额", global: true, price: "180", total: "197", totalCost: undefined, discount: 100, amount: "$1.97" },
    { label: "国际总价低于原价但折扣字段未同步", global: true, price: "180", total: "170", totalCost: "180", discount: 100, amount: "$1.70" },
    { label: "国内合法零元", global: false, price: "8000", total: "0", totalCost: "8000", discount: 0, amount: "¥0.00" },
  ])("$label只展示实际总价，不将优惠当税费或禁止购买", async ({ global, price, total, totalCost, discount, amount }) => {
    regionState.isGlobal = global;
    inquireCreditPrice.mockImplementation(async (productId: string) => ({
      ...quoteFor(productId),
      currency: global ? "USD" : "CNY",
      price,
      total_cost: totalCost,
      real_total_cost: total,
      discount,
    }));
    renderSection();
    const card = await screen.findByTestId("credit-pack-card-credit_1000");
    await waitFor(() => expect(within(card).getByText(amount)).toBeInTheDocument());
    expect(card).toBeEnabled();
    await userEvent.click(card);
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    const modal = await screen.findByTestId("credit-pack-confirm-modal");
    expect(within(modal).queryByText("税费")).not.toBeInTheDocument();
    expect(within(modal).queryByText("积分包价格")).not.toBeInTheDocument();
    expect(within(modal).queryByText("最终付款价格包含税费，请以付款页面显示为准。") !== null).toBe(global);
    const payButton = screen.getByTestId("credit-pack-confirm-pay");
    expect(payButton).toHaveTextContent(`支付 ${amount}`);
    await userEvent.click(screen.getByTestId("credit-pack-terms-checkbox"));
    expect(payButton).toBeEnabled();
  });

  it("国际站绑定错误保留重新下单入口，不引导不存在的实名认证", async () => {
    regionState.isGlobal = true;
    createCreditOrder.mockRejectedValue(new Error("uin is required"));
    renderSection();
    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
    await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

    expect(await screen.findByRole("heading", { name: "支付遇到问题" })).toBeInTheDocument();
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent("uin is required");
    expect(screen.queryByTestId("credit-pack-modal-realname-action")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂不处理" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "重新下单" }));
    expect(await screen.findByRole("heading", { name: "确认订单" })).toBeInTheDocument();
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
