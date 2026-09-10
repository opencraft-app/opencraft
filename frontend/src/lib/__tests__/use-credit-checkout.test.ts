import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCreditCheckout } from "../use-credit-checkout";

const createCreditOrder = vi.fn();
const createCreditOrderUrl = vi.fn();
const listCreditPackages = vi.fn();

const repositoriesStub = {
  credit: { createCreditOrder, createCreditOrderUrl, listCreditPackages },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositoriesStub,
}));

const pack = (total: number, expired: string) => ({
  credit_type: "paid" as const,
  credit_total: total,
  credit_available: total,
  expired_time: expired,
});

let assignMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createCreditOrder.mockReset();
  createCreditOrderUrl.mockReset();
  listCreditPackages.mockReset();

  createCreditOrder.mockResolvedValue({ dealName: "deal-1", bigOrderId: "big-1" });
  createCreditOrderUrl.mockResolvedValue({
    deal_name: "deal-1",
    pay_url: "https://pay.example/checkout",
    need_charge: 1,
  });
  listCreditPackages.mockResolvedValue([]);

  assignMock = vi.fn();
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: assignMock, href: "https://app.example/subscribe" },
    writable: true,
  });
});

describe("useCreditCheckout", () => {
  it("初始状态为 idle", () => {
    const { result } = renderHook(() => useCreditCheckout());

    expect(result.current.state).toEqual({ status: "idle", dealName: null, error: null });
  });

  it("下单成功后跳转支付页并进入 payment_pending", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
    expect(result.current.state.dealName).toBe("deal-1");
    expect(assignMock).toHaveBeenCalledWith("https://pay.example/checkout");
  });

  it("下单请求带上固定周期的商品 ID", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_4000");

    expect(createCreditOrder).toHaveBeenCalledWith("credit_4000");
  });

  it("order-url 请求携带 deal_name / platform / 回跳地址", async () => {
    const { result } = renderHook(() =>
      useCreditCheckout({ returnUrl: "https://app/ok", cancelUrl: "https://app/cancel" }),
    );

    await result.current.start("credit_1000");

    expect(createCreditOrderUrl).toHaveBeenCalledWith({
      deal_name: "deal-1",
      platform: "pc",
      return_url: "https://app/ok",
      cancel_url: "https://app/cancel",
    });
  });

  it("need_charge=0 时不跳转，直接进入到账确认", async () => {
    createCreditOrderUrl.mockResolvedValue({ deal_name: "deal-1", pay_url: "", need_charge: 0 });
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("delivery_pending");
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("创建订单失败时进入 failed 且不请求支付链接", async () => {
    createCreditOrder.mockRejectedValue(new Error("下单被拒绝"));
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state.error).toBe("下单被拒绝");
    expect(createCreditOrderUrl).not.toHaveBeenCalled();
  });

  it("支付链接失败时保留订单号，且不自动重新下单", async () => {
    createCreditOrderUrl.mockRejectedValue(new Error("订单不存在"));
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    /* 订单号必须保留：供用户联系客服排查 */
    expect(result.current.state.dealName).toBe("deal-1");
    /* 产品方案要求不自动创建第二笔订单 */
    expect(createCreditOrder).toHaveBeenCalledTimes(1);
  });

  it("pay_url 为空时判定失败，不跳转", async () => {
    createCreditOrderUrl.mockResolvedValue({ deal_name: "deal-1", pay_url: "", need_charge: 1 });
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("出现新积分包时判定为 delivered 并触发回调", async () => {
    const onDelivered = vi.fn();
    /* 购买前快照为空，购买后出现一个包 */
    listCreditPackages.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useCreditCheckout({ onDelivered }));

    await result.current.start("credit_1000");

    listCreditPackages.mockResolvedValue([pack(1000, "2026-10-10T00:00:00Z")]);
    await result.current.confirmDelivery();

    await waitFor(() => {
      expect(result.current.state.status).toBe("delivered");
    });
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("购买前已存在的包不会被误判为本次到账", async () => {
    const existing = pack(1000, "2026-10-10T00:00:00Z");
    /* 购买前就有这个包 */
    listCreditPackages.mockResolvedValueOnce([existing]);
    /* 注入短间隔与短超时，避免依赖真实等待 */
    const { result } = renderHook(() => useCreditCheckout({ pollIntervalMs: 1, pollTimeoutMs: 5 }));

    await result.current.start("credit_1000");

    /* 到账查询仍只返回同一个包 → 不应判定为已到账 */
    listCreditPackages.mockResolvedValue([existing]);
    await result.current.confirmDelivery();

    /* 超时后应为交付异常，而非误报成功。
       setState 在 await 之后提交，需 waitFor 等待 React 落定。 */
    await waitFor(() => {
      expect(result.current.state.status).toBe("delivery_exception");
    });
  });

  it("查询报错不终止轮询，恢复后仍能判定到账", async () => {
    listCreditPackages.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useCreditCheckout({ pollIntervalMs: 1, pollTimeoutMs: 200 }));
    await result.current.start("credit_1000");

    listCreditPackages
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue([pack(2000, "2026-11-01T00:00:00Z")]);

    await result.current.confirmDelivery();

    await waitFor(() => {
      expect(result.current.state.status).toBe("delivered");
    });
  });

  it("reset 恢复到 idle，允许重新发起新订单", async () => {
    const { result } = renderHook(() => useCreditCheckout());
    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });

    result.current.reset();

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "idle", dealName: null, error: null });
    });
  });
});
