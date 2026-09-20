import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 到账轮询超时（delivery_exception）的渲染契约测试。
 *
 * 真实 UI 路径：超时态不是「打开弹窗时的预设状态」，而是**弹窗开着时轮询超时
 * 的状态转换**（payment_pending → delivery_exception）。因此测试用可变控制器
 * 模拟 hook 内部的超时回调切换，断言弹窗就地转换后的渲染契约：
 *
 * - 转换是中性等待态而非错误态：标题「请完成支付」（「支付遇到问题」是 failed
 *   专用）、正文不预设「支付已完成」、二维码保留（轮询 2 分钟 < authCode TTL
 *   9 分钟，二维码仍有效，不剥夺支付入口）、弹窗外不挂警告行（对齐套餐续费的
 *   超时静默口径）。
 * - 用户「暂不处理」关弹窗后再点购买：终态（超时/失败/已完成）先 reset 旧订单，
 *   弹窗回到条款确认阶段生成新订单（对齐套餐续费每次确认都新建订单）；进行中
 *   状态（payment_pending）重开时也 reset，旧订单轮询由 hook 的代际隔离停止写回。
 *
 * hook mock：内部持有 React state 的 mini 实现，暴露 applyState 供测试模拟
 * 超时回调切换；reset 真实清空。轮询行为本身由 use-credit-checkout.test.ts 覆盖。
 */

const regionState = vi.hoisted(() => ({ isGlobal: false }));
vi.mock("@/lib/region", async (importOriginal) => {
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

const confirmDeliveryMock = vi.hoisted(() => vi.fn());
const checkDeliveryOnceMock = vi.hoisted(() => vi.fn(async () => false));
const resetMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => navigateMock,
}));

type CheckoutStatus =
  | "idle"
  | "creating"
  | "payment_pending"
  | "delivery_pending"
  | "delivered"
  | "delivery_exception"
  | "failed";

interface CheckoutSnapshot {
  status: CheckoutStatus;
  dealName: string | null;
  error: string | null;
}

const checkoutController = vi.hoisted(() => ({
  /** 组件 mount 前（beforeEach/用例体）预设的初始状态 */
  initial: null as null | CheckoutSnapshot,
  /** 组件 mount 后由 mock 填充；测试用它模拟 hook 内部的超时回调切换 */
  applyState: null as null | ((next: CheckoutSnapshot) => void),
  /** 二维码过期时间覆盖（null = 默认 9 分钟后） */
  qrExpiresAt: null as null | number,
}));

vi.mock("@/lib/use-credit-checkout", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useCreditCheckout: () => {
      const [state, setState] = useState(
        checkoutController.initial ?? { status: "idle", dealName: null, error: null },
      );
      useEffect(() => {
        checkoutController.applyState = setState;
        return () => {
          checkoutController.applyState = null;
        };
      }, [setState]);
      return {
        state,
        payUrl: null,
        bridgePlan: {
          bridgeUrl: "https://pay.example/bridge",
          expiresAt: checkoutController.qrExpiresAt ?? Date.now() + 9 * 60_000,
        },
        start: vi.fn(),
        reset: () => {
          resetMock();
          setState({ status: "idle", dealName: null, error: null });
        },
        confirmDelivery: confirmDeliveryMock,
        checkDeliveryOnce: checkDeliveryOnceMock,
      };
    },
  };
});

const inquireCreditPrice = vi.fn();
const createCreditOrder = vi.fn();
const createCreditOrderUrl = vi.fn();
const listCreditProducts = vi.fn();
const repositoriesStub = { credit: { inquireCreditPrice, createCreditOrder, createCreditOrderUrl, listCreditProducts } };
vi.mock("@/contexts/repository-context", () => ({ useRepositories: () => repositoriesStub }));

const { CreditPackSection } = await import("../credit-pack-section");

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

beforeEach(() => {
  regionState.isGlobal = false;
  checkoutController.initial = null;
  checkoutController.applyState = null;
  checkoutController.qrExpiresAt = null;
  confirmDeliveryMock.mockReset();
  checkDeliveryOnceMock.mockReset();
  checkDeliveryOnceMock.mockResolvedValue(false);
  resetMock.mockClear();
  navigateMock.mockClear();
  inquireCreditPrice.mockReset();
  inquireCreditPrice.mockImplementation(async (productId: string) => ({
    product_id: productId,
    real_total_cost: "8000",
    total_cost: "8000",
    currency: "CNY" as const,
  }));
  listCreditProducts.mockReset();
  listCreditProducts.mockResolvedValue(ALL_PRODUCTS_ONLINE);
});

afterEach(() => {
  cleanup();
});

/** 走到支付阶段：选卡 → 打开弹窗 → 勾选条款 → 确认支付（mock 的 start 不改状态，
 *  测试用 applyState 驱动后续转换） */
async function reachPayStage(initialStatus: CheckoutStatus) {
  checkoutController.initial = { status: "idle", dealName: null, error: null };
  render(
    <CreditPackSection isLoggedIn hasActivePlan onRequireLogin={() => undefined} onRequirePlan={() => undefined} />,
  );
  await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));
  await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
  await userEvent.click(await screen.findByTestId("credit-pack-terms-checkbox"));
  await userEvent.click(screen.getByTestId("credit-pack-confirm-pay"));

  /* 组件确认支付后由 hook 决定状态；这里直接落到指定的进行中状态 */
  act(() => {
    checkoutController.applyState?.({
      status: initialStatus,
      dealName: "20260916995023682746371",
      error: null,
    });
  });
  await screen.findByRole("dialog");
}

describe("CreditPackSection 到账轮询超时（delivery_exception）", () => {
  it("购买成功后点击完成跳转到 account 页面", async () => {
    await reachPayStage("delivered");

    await userEvent.click(await screen.findByRole("button", { name: "完成" }));

    expect(navigateMock).toHaveBeenCalledWith("/account");
  });

  it("轮询超时就地转换：标题常驻「请完成支付」不切错误，文案中性不误报「支付已完成」", async () => {
    await reachPayStage("payment_pending");

    /* 模拟轮询超时：hook 内部 payment_pending → delivery_exception */
    act(() => {
      checkoutController.applyState?.({
        status: "delivery_exception",
        dealName: "20260916995023682746371",
        error: null,
      });
    });

    /* 标题常驻（对齐套餐 renew-pass-modal：轮询状态切换不动标题，超时静默） */
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "请完成支付" })).toBeInTheDocument();
    });
    /* 超时不是错误：绝不出现「支付遇到问题」标题（那是 failed 专用） */
    expect(screen.queryByRole("heading", { name: "支付遇到问题" })).not.toBeInTheDocument();
    /* 中性文案：不预设用户已支付（对齐套餐字面） */
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent(
      "暂未确认支付结果，请稍后刷新。",
    );
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).not.toHaveTextContent("支付已完成");
    /* 订单号仍透出（客服排查入口） */
    expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent("20260916995023682746371");
  });

  it("超时后国内站二维码仍展示（二维码 TTL 未到，不剥夺支付入口）并提供常驻手动刷新", async () => {
    await reachPayStage("payment_pending");
    await screen.findByTestId("credit-pack-wx-qr");

    act(() => {
      checkoutController.applyState?.({ status: "delivery_exception", dealName: "deal-x", error: null });
    });

    /* 二维码保留：用户只是慢了仍可扫码支付 */
    expect(screen.getByTestId("credit-pack-wx-qr")).toBeInTheDocument();
    const recheck = await screen.findByRole("button", { name: "刷新" });
    await userEvent.click(recheck);
    expect(checkDeliveryOnceMock).toHaveBeenCalled();
  });

  it("payment_pending 阶段即有常驻「刷新」按钮，手动单查未到账提示「暂未确认支付结果」", async () => {
    await reachPayStage("payment_pending");

    /* 对齐套餐：支付等待阶段就能手动刷新，不必等轮询超时 */
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();

    /* 单查未到账：状态保持 payment_pending（自动轮询继续），弹窗内提示 */
    checkDeliveryOnceMock.mockResolvedValue(false);
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-modal-checkout-status")).toHaveTextContent(
        "暂未确认支付结果，请稍后刷新。",
      );
    });
    /* 二维码不受手动刷新影响 */
    expect(screen.getByTestId("credit-pack-wx-qr")).toBeInTheDocument();
  });

  it("弹窗外不持续挂超时警告行（用户点「暂不处理」即选择暂时搁置）", async () => {
    await reachPayStage("payment_pending");

    act(() => {
      checkoutController.applyState?.({ status: "delivery_exception", dealName: "deal-x", error: null });
    });
    await screen.findByRole("heading", { name: "请完成支付" });

    /* 超时/失败提示只留在弹窗内，页面按钮下方不挂警告 */
    expect(screen.queryByTestId("credit-pack-checkout-status")).not.toBeInTheDocument();

    /* 点「暂不处理」关闭后同样不挂 */
    await userEvent.click(await screen.findByRole("button", { name: "暂不处理" }));
    expect(screen.queryByTestId("credit-pack-checkout-status")).not.toBeInTheDocument();
  });

  it("暂不处理关闭弹窗后重新购买：reset 旧订单，弹窗回到条款确认阶段（可生成新订单）", async () => {
    await reachPayStage("payment_pending");
    act(() => {
      checkoutController.applyState?.({ status: "delivery_exception", dealName: "deal-stale", error: null });
    });

    /* 点「暂不处理」关闭弹窗 */
    await userEvent.click(await screen.findByRole("button", { name: "暂不处理" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    /* 重新点「购买所选积分包」：reset 清掉旧订单状态，弹窗回到条款确认阶段
       （而非复用旧订单的支付阶段）——确认支付将创建新订单 */
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    expect(await screen.findByTestId("credit-pack-terms-checkbox")).toBeInTheDocument();
    expect(screen.queryByTestId("credit-pack-wx-qr")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确认订单" })).toBeInTheDocument();
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it("二维码过期后重开弹窗：先 reset 旧订单，回到条款确认阶段生成新单", async () => {
    /* 预设已过期的二维码（模拟：payment_pending 保留态下隔了 TTL 再开弹窗） */
    checkoutController.qrExpiresAt = Date.now() - 1_000;
    checkoutController.initial = { status: "payment_pending", dealName: "deal-expired", error: null };

    render(
      <CreditPackSection isLoggedIn hasActivePlan onRequireLogin={() => undefined} onRequirePlan={() => undefined} />,
    );
    await userEvent.click(await screen.findByTestId("credit-pack-card-credit_1000"));

    /* QR 已过期：handlePrimary 直接 reset 旧订单，弹窗回条款确认阶段 */
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));
    expect(await screen.findByTestId("credit-pack-terms-checkbox")).toBeInTheDocument();
    expect(resetMock).toHaveBeenCalledTimes(1);
  });

  it("弹窗开着时二维码过期（就地翻转）：不再渲染 QR，显示过期提示与「重新下单」", async () => {
    await reachPayStage("payment_pending");
    await screen.findByTestId("credit-pack-wx-qr");

    /* 模拟时间流逝到过期（每秒 tick 驱动翻转，最长 ~1s） */
    act(() => {
      checkoutController.qrExpiresAt = Date.now() - 60_000;
    });
    await waitFor(() => {
      expect(screen.getByTestId("credit-pack-qr-expired")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("credit-pack-wx-qr")).not.toBeInTheDocument();
    expect(screen.getByTestId("credit-pack-reorder")).toBeInTheDocument();
  });

  it("failed（下单/支付链接失败）就地转换后仍使用「支付遇到问题」错误标题", async () => {
    await reachPayStage("payment_pending");

    act(() => {
      checkoutController.applyState?.({ status: "failed", dealName: null, error: "库存不足" });
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "支付遇到问题" })).toBeInTheDocument();
    });
  });

  it("进行中状态（payment_pending）点「暂不处理」后重开弹窗：一律 reset 重新下单", async () => {
    await reachPayStage("payment_pending");
    await screen.findByTestId("credit-pack-wx-qr");

    await userEvent.click(await screen.findByRole("button", { name: "暂不处理" }));
    await userEvent.click(screen.getByTestId("credit-pack-primary-action"));

    /* 对齐套餐：关闭弹窗即结束本轮，重开一律从条款确认开始生成新订单，
       不复用上一单的支付码与等待态 */
    expect(await screen.findByTestId("credit-pack-terms-checkbox")).toBeInTheDocument();
    expect(screen.queryByTestId("credit-pack-wx-qr")).not.toBeInTheDocument();
    expect(resetMock).toHaveBeenCalledTimes(1);
  });
});
