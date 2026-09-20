import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCreditCheckout } from "../use-credit-checkout";

/* 站点切换：getter 型 mock，运行时可改 regionState.isGlobal 模拟国内/国际站。
   vi.hoisted 提升到 import 之前，避免 mock 工厂执行时 TDZ 报错。 */
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

let assignMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  /* 默认国内站（REGION=cn），国际站用例内显式切换 */
  regionState.isGlobal = false;
  createCreditOrder.mockReset();
  createCreditOrderUrl.mockReset();
  listCreditPackages.mockReset();

  /* 后端 !3910 起正常形态应带 auth_code（票据发放失败时为空串，
     见「auth_code 为空」专项用例） */
  createCreditOrder.mockResolvedValue({
    dealName: "deal-1",
    bigOrderId: "big-1",
    auth_code: "ticket-default",
  });
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

describe("useCreditCheckout 国内站（中转页 + wxSign 模式）", () => {
  it("创建订单后不调 order-url，生成中转页支付计划并进入 payment_pending", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
    expect(result.current.state.dealName).toBe("deal-1");
    /* PC 端不调 order-url：jifei pay_url 绑定 wx_open_id，
       由手机端中转页拉取（对齐 pass 链路） */
    expect(createCreditOrderUrl).not.toHaveBeenCalled();
    /* 中转页支付计划已生成，供 UI 渲染二维码 */
    expect(result.current.bridgePlan).not.toBeNull();
    expect(result.current.bridgePlan?.bridgeUrl).toContain("/auth/wechat-pay");
  });

  it("中转页 URL 携带积分包类型标记与订单号", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_4000");

    await waitFor(() => {
      expect(result.current.bridgePlan).not.toBeNull();
    });
    const url = new URL(result.current.bridgePlan!.bridgeUrl);
    expect(url.searchParams.get("k")).toBe("cp");
    expect(url.searchParams.get("d")).toBe("deal-1");
  });

  it("order 响应带 auth_code 时写入中转页 URL（后端补齐后的完整形态）", async () => {
    createCreditOrder.mockResolvedValue({
      dealName: "deal-1",
      bigOrderId: "big-1",
      auth_code: "ticket-abc",
    });
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.bridgePlan).not.toBeNull();
    });
    const url = new URL(result.current.bridgePlan!.bridgeUrl);
    expect(url.searchParams.get("ac")).toBe("ticket-abc");
  });

  it("auth_code 为空时直接判失败，不生成必然失效的中转页（!3910 校验上线后）", async () => {
    /* 后端票据发放失败静默降级：下单成功但 auth_code 为空串。
       order-url 已强制校验票据，此时中转页必然显示「二维码已失效」，
       必须在 PC 端就明确失败并保留订单号供排查。 */
    createCreditOrder.mockResolvedValue({
      dealName: "deal-1",
      bigOrderId: "big-1",
      auth_code: "",
    });
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.state.error).toContain("支付票据未下发");
    /* 订单号保留：下单已成功，供用户联系客服排查票据问题 */
    expect(result.current.state.dealName).toBe("deal-1");
    /* 不生成中转页支付计划（不渲染二维码） */
    expect(result.current.bridgePlan).toBeNull();
    expect(createCreditOrderUrl).not.toHaveBeenCalled();
  });

  it("auth_code 字段缺失（旧后端镜像）同样判失败，不进入中转页", async () => {
    /* !3910 之前的后端镜像响应无 auth_code 字段 → undefined。
       与空串同一分支处理：!authCode 拦截。 */
    createCreditOrder.mockResolvedValue({
      dealName: "deal-1",
      bigOrderId: "big-1",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("failed");
    });
    expect(result.current.bridgePlan).toBeNull();
    /* 失败必须有前端痕迹（对齐 renew-pass-modal 的 console.error 惯例） */
    expect(errorSpy).toHaveBeenCalledWith(
      "[credit] order issued without auth_code",
      expect.objectContaining({ dealName: "deal-1" }),
    );
    errorSpy.mockRestore();
  });

  it("国内站不发生页面跳转（等待扫码而非直跳）", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("reset 同时清空中转页支付计划", async () => {
    const { result } = renderHook(() => useCreditCheckout());
    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.bridgePlan).not.toBeNull();
    });

    result.current.reset();

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "idle", dealName: null, error: null });
      expect(result.current.bridgePlan).toBeNull();
    });
  });
});

describe("useCreditCheckout 国际站（信用卡托管页直跳）", () => {
  beforeEach(() => {
    regionState.isGlobal = true;
  });

  it("下单成功后经占位窗打开支付页并进入 payment_pending", async () => {
    /* 占位窗模式（对齐 pass 的 startIntlCardPay）：window.open 同步开 about:blank，
       拿到 pay_url 后赋给占位窗 location，而非 location.assign */
    const payWindowStub = { location: { href: "" } };
    const openMock = vi.fn(() => payWindowStub);
    Object.defineProperty(window, "open", { value: openMock, writable: true });

    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
    expect(result.current.state.dealName).toBe("deal-1");
    expect(openMock).toHaveBeenCalledWith("about:blank", "_blank");
    expect(payWindowStub.location.href).toBe("https://pay.example/checkout");
    expect(result.current.payUrl).toBe("https://pay.example/checkout");
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("占位窗被弹窗拦截时兜底当前页跳转", async () => {
    /* window.open 返回 null（浏览器弹窗限制场景） */
    const openMock = vi.fn(() => null);
    Object.defineProperty(window, "open", { value: openMock, writable: true });

    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_1000");

    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
    expect(assignMock).toHaveBeenCalledWith("https://pay.example/checkout");
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
});

describe("useCreditCheckout 站点无关（下单与到账确认）", () => {
  it("初始状态为 idle", () => {
    const { result } = renderHook(() => useCreditCheckout());

    expect(result.current.state).toEqual({ status: "idle", dealName: null, error: null });
  });

  it("下单请求带上固定周期的商品 ID", async () => {
    const { result } = renderHook(() => useCreditCheckout());

    await result.current.start("credit_4000");

    expect(createCreditOrder).toHaveBeenCalledWith("credit_4000");
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

  it("checkDeliveryOnce 单查命中即切 delivered（对齐套餐手动刷新的单查语义）", async () => {
    const onDelivered = vi.fn();
    listCreditPackages.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useCreditCheckout({ onDelivered }));
    await result.current.start("credit_1000");

    listCreditPackages.mockResolvedValue([pack(1000, "2026-10-10T00:00:00Z")]);
    const delivered = await result.current.checkDeliveryOnce();

    expect(delivered).toBe(true);
    /* setState 在 await 之后提交，需 waitFor 等待 React 落定 */
    await waitFor(() => {
      expect(result.current.state.status).toBe("delivered");
    });
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("checkDeliveryOnce 未到账返回 false 且不改状态（自动轮询继续由调用方决定）", async () => {
    const existing = pack(1000, "2026-10-10T00:00:00Z");
    listCreditPackages.mockResolvedValueOnce([existing]);
    const { result } = renderHook(() => useCreditCheckout());
    await result.current.start("credit_1000");

    listCreditPackages.mockResolvedValue([existing]);
    const delivered = await result.current.checkDeliveryOnce();

    expect(delivered).toBe(false);
    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });
  });

  it("confirmDelivery 防重入：轮询进行中重复调用直接返回不并发", async () => {
    listCreditPackages.mockResolvedValue([]);
    const { result } = renderHook(() => useCreditCheckout({ pollIntervalMs: 10, pollTimeoutMs: 200 }));
    await result.current.start("credit_1000");
    await waitFor(() => {
      expect(result.current.state.status).toBe("payment_pending");
    });

    /* 第一次进入轮询循环（不 await，让它在后台跑） */
    const first = result.current.confirmDelivery();
    /* 立即重入：应被防重入挡住，不产生第二次查询请求 */
    await result.current.confirmDelivery();

    /* 第一次只发起了一轮查询（重入未叠加请求），且状态未变。
       setState 在 await 之后提交，需 waitFor 等待 React 落定。 */
    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(2); /* start 快照 1 次 + 轮询首查 1 次 */
    });
    expect(result.current.state.status).toBe("payment_pending");

    await first;
  });

  it("reset 后新订单可独立轮询，旧订单响应不会覆盖新订单状态", async () => {
    const onDelivered = vi.fn();
    const firstPollResponse = deferred<ReturnType<typeof pack>[]>();
    const secondPollResponse = deferred<ReturnType<typeof pack>[]>();
    const { result } = renderHook(() =>
      useCreditCheckout({ onDelivered, pollIntervalMs: 1, pollTimeoutMs: 200 }),
    );

    listCreditPackages.mockResolvedValueOnce([]);
    await result.current.start("credit_1000");
    await waitFor(() => {
      expect(result.current.state.dealName).toBe("deal-1");
    });

    listCreditPackages.mockImplementationOnce(() => firstPollResponse.promise);
    const firstPoll = result.current.confirmDelivery();
    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(2);
    });

    act(() => {
      result.current.reset();
    });
    createCreditOrder.mockResolvedValueOnce({
      dealName: "deal-2",
      bigOrderId: "big-2",
      auth_code: "ticket-2",
    });
    listCreditPackages.mockResolvedValueOnce([]);
    await result.current.start("credit_2000");
    await waitFor(() => {
      expect(result.current.state.dealName).toBe("deal-2");
    });

    listCreditPackages.mockImplementationOnce(() => secondPollResponse.promise);
    const secondPoll = result.current.confirmDelivery();
    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(4);
    });

    secondPollResponse.resolve([pack(2000, "2026-11-01T00:00:00Z")]);
    await secondPoll;
    await waitFor(() => {
      expect(result.current.state).toMatchObject({ status: "delivered", dealName: "deal-2" });
    });

    firstPollResponse.resolve([pack(1000, "2026-10-10T00:00:00Z")]);
    await firstPoll;
    expect(result.current.state).toMatchObject({ status: "delivered", dealName: "deal-2" });
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });
});
