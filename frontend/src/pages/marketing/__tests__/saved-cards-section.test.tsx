import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepositoryError } from "@/repositories/http-repositories";
import { SavedCardsSection } from "../saved-cards-section";

const mocks = vi.hoisted(() => ({
  createSignOrder: vi.fn(),
  deletePaymentMethod: vi.fn(),
  listPaymentMethods: vi.fn(),
  search: "",
  setDefaultPaymentMethod: vi.fn(),
  setSearchParams: vi.fn(),
  translate: (text: string, options?: Record<string, unknown>) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key: string) => (
      options?.[key] === undefined ? raw : String(options[key])
    )),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      createPaymentMethodSignOrder: mocks.createSignOrder,
      deletePaymentMethod: mocks.deletePaymentMethod,
      listPaymentMethods: mocks.listPaymentMethods,
      setDefaultPaymentMethod: mocks.setDefaultPaymentMethod,
    },
  }),
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppSearchParams: () => [new URLSearchParams(mocks.search), mocks.setSearchParams],
}));

vi.mock("@/i18n/t", () => ({
  useT: () => mocks.translate,
  t: (text: string) => text,
}));

vi.mock("@/i18n", () => ({
  default: { language: "en-US" },
}));

const defaultMethod = {
  contractCode: "contract-default",
  maskedNumber: "555555****4444",
  payerName: "Ada Lovelace",
  type: "CREDIT_CARD",
  isDefault: true,
};

const secondaryMethod = {
  contractCode: "contract-secondary",
  maskedNumber: "411111****1111",
  payerName: "Grace Hopper",
  type: "CREDIT_CARD",
  isDefault: false,
};

describe("SavedCardsSection", () => {
  beforeEach(() => {
    mocks.search = "";
    mocks.createSignOrder.mockReset();
    mocks.deletePaymentMethod.mockReset().mockResolvedValue(undefined);
    mocks.listPaymentMethods.mockReset().mockResolvedValue({
      total: 2,
      items: [defaultMethod, secondaryMethod],
    });
    mocks.setDefaultPaymentMethod.mockReset().mockResolvedValue(undefined);
    mocks.setSearchParams.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads and renders only masked card data from the API", async () => {
    render(<SavedCardsSection />);

    expect(screen.getByText("正在加载签约卡…")).toBeInTheDocument();
    expect(await screen.findByText("555555****4444")).toBeInTheDocument();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText("默认卡")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/卡号|Card number/i)).not.toBeInTheDocument();
  });

  it("renders an empty state when the account has no signed cards", async () => {
    mocks.listPaymentMethods.mockResolvedValue({ total: 0, items: [] });

    render(<SavedCardsSection />);

    expect(await screen.findByText("还没有绑定支付卡")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加支付卡" })).toBeEnabled();
  });

  it("creates a sign order and navigates to the approved hosted page", async () => {
    const navigate = vi.fn();
    mocks.createSignOrder.mockResolvedValue({
      contractCode: "contract-new",
      redirectUrl: "https://sandbox-card.centauriglobal.com/sign?token=opaque",
    });

    render(<SavedCardsSection navigateToHostedPage={navigate} />);
    await screen.findByText("555555****4444");
    await userEvent.click(screen.getByRole("button", { name: "添加支付卡" }));

    await waitFor(() => {
      expect(mocks.createSignOrder).toHaveBeenCalledWith("en");
      expect(navigate).toHaveBeenCalledWith("https://sandbox-card.centauriglobal.com/sign?token=opaque");
    });
    expect(window.sessionStorage.getItem("lightvela-payment-method-sign-order-v1")).toContain("contract-new");
  });

  it("navigates to the international production hosted payment page", async () => {
    const navigate = vi.fn();
    mocks.createSignOrder.mockResolvedValue({
      contractCode: "contract-intl-production",
      redirectUrl: "https://card.harvestsharp.com/apps/creditcard/views/sign?token=opaque",
    });

    render(<SavedCardsSection navigateToHostedPage={navigate} />);
    await screen.findByText("555555****4444");
    await userEvent.click(screen.getByRole("button", { name: "添加支付卡" }));

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        "https://card.harvestsharp.com/apps/creditcard/views/sign?token=opaque",
      );
    });
  });

  it("refuses to navigate to an unapproved redirect host", async () => {
    const navigate = vi.fn();
    mocks.createSignOrder.mockResolvedValue({
      contractCode: "contract-new",
      redirectUrl: "https://attacker.example/sign?token=opaque",
    });

    render(<SavedCardsSection navigateToHostedPage={navigate} />);
    await screen.findByText("555555****4444");
    await userEvent.click(screen.getByRole("button", { name: "添加支付卡" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("签约页面地址无效，请稍后重试。");
    expect(navigate).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("lightvela-payment-method-sign-order-v1")).toBeNull();
  });

  it("sets a non-default payment method as default and refreshes the list", async () => {
    render(<SavedCardsSection />);
    await screen.findByText("411111****1111");

    await userEvent.click(screen.getByRole("button", { name: "设为默认卡" }));

    await waitFor(() => expect(mocks.setDefaultPaymentMethod).toHaveBeenCalledWith("contract-secondary"));
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(2);
  });

  it("shows the upstream retry delay when a mutation is rate limited", async () => {
    mocks.setDefaultPaymentMethod.mockRejectedValue(
      new RepositoryError("rate limited", 429, "rate_limited", 12),
    );

    render(<SavedCardsSection />);
    await screen.findByText("411111****1111");
    await userEvent.click(screen.getByRole("button", { name: "设为默认卡" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作过于频繁，请在 12 秒后重试。");
    expect(screen.getByText("411111****1111")).toBeInTheDocument();
  });

  it("confirms deletion of a non-default method while keeping default cards protected", async () => {
    render(<SavedCardsSection />);
    await screen.findByText("411111****1111");

    expect(screen.getAllByRole("button", { name: "解绑支付卡" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "解绑支付卡" }));
    expect(screen.getByRole("dialog", { name: "解绑支付卡" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "确认解绑" }));

    await waitFor(() => expect(mocks.deletePaymentMethod).toHaveBeenCalledWith("contract-secondary"));
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(2);
  });

  it("hides the section when the environment has not enabled payment methods", async () => {
    mocks.listPaymentMethods.mockRejectedValue(
      new RepositoryError("not enabled", 503, "payment_methods_unavailable"),
    );

    const { container } = render(<SavedCardsSection />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("consumes a successful callback and confirms the exact contract code", async () => {
    mocks.search = "?payment-method=success&from=account";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      startedAt: Date.now(),
    }));
    mocks.listPaymentMethods.mockResolvedValue({
      total: 1,
      items: [{ ...secondaryMethod, contractCode: "contract-new" }],
    });

    render(<SavedCardsSection />);

    expect(await screen.findByText("支付卡已绑定。")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("lightvela-payment-method-sign-order-v1")).toBeNull();
    const nextParams = mocks.setSearchParams.mock.calls[0]?.[0] as URLSearchParams;
    expect(nextParams.get("payment-method")).toBeNull();
    expect(nextParams.get("from")).toBe("account");
    expect(mocks.setSearchParams).toHaveBeenCalledWith(expect.any(URLSearchParams), { replace: true });
  });

  it("polls until the exact returned contract code becomes visible", async () => {
    mocks.search = "?payment-method=success";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      startedAt: Date.now(),
    }));
    mocks.listPaymentMethods
      .mockResolvedValueOnce({ total: 1, items: [defaultMethod] })
      .mockResolvedValueOnce({
        total: 2,
        items: [defaultMethod, { ...secondaryMethod, contractCode: "contract-new" }],
      });

    render(<SavedCardsSection />);

    expect(await screen.findByText("正在同步支付卡…")).toBeInTheDocument();
    expect(await screen.findByText("支付卡已绑定。", {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(2);
  });

  /* 回归：deadline 必须在「回跳时刻」计算，而不是跳转前就写进 sessionStorage。
     用户在 hosted page 填卡通常 20–60 秒，远超 5s 同步窗口；
     若沿用跳转前的 deadline，回跳时必然已过期，轮询会一次都不执行。 */
  it("still polls after a long stay on the hosted page", async () => {
    mocks.search = "?payment-method=success";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      /* 模拟用户在 hosted page 停留 60 秒后才回跳 */
      startedAt: Date.now() - 60_000,
    }));
    mocks.listPaymentMethods
      .mockResolvedValueOnce({ total: 1, items: [defaultMethod] })
      .mockResolvedValueOnce({
        total: 2,
        items: [defaultMethod, { ...secondaryMethod, contractCode: "contract-new" }],
      });

    render(<SavedCardsSection />);

    expect(await screen.findByText("支付卡已绑定。", {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(2);
  });

  /* 过于陈旧的记录（用户放弃绑卡、未走 cancel 回跳）必须丢弃，
     否则会拿旧 contractCode 比对新卡而一直提示「仍在同步」。 */
  it("discards a stale pending sign order", async () => {
    mocks.search = "?payment-method=success";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      startedAt: Date.now() - 31 * 60_000,
    }));
    mocks.listPaymentMethods.mockResolvedValue({ total: 1, items: [defaultMethod] });

    render(<SavedCardsSection />);

    /* 无 pending 可比对：只刷新一次，不进入轮询，也不误报「仍在同步」 */
    expect(await screen.findByText("签约结果已刷新。")).toBeInTheDocument();
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("lightvela-payment-method-sign-order-v1")).toBeNull();
  });

  it("stops polling at the client deadline without reporting a false failure", async () => {
    mocks.search = "?payment-method=success";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      startedAt: Date.now(),
    }));
    /* 目标卡始终不出现：轮询应在 5s 窗口耗尽后停止，而不是无限重试 */
    mocks.listPaymentMethods.mockResolvedValue({ total: 1, items: [defaultMethod] });

    vi.useFakeTimers();
    render(<SavedCardsSection />);
    /* 推进超过同步窗口，flush 掉全部轮询定时器与 microtask */
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();

    expect(await screen.findByText("签约结果仍在同步，请稍后重新加载。")).toBeInTheDocument();
    /* 首次 + 若干次轮询：证明确实轮询过，且已停止（不再增长） */
    const callsAfterDeadline = mocks.listPaymentMethods.mock.calls.length;
    expect(callsAfterDeadline).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.listPaymentMethods).toHaveBeenCalledTimes(callsAfterDeadline);
    expect(screen.queryByText("支付卡已绑定。")).not.toBeInTheDocument();
  });

  it("consumes a cancelled callback without mutating payment methods", async () => {
    mocks.search = "?payment-method=cancelled";
    window.sessionStorage.setItem("lightvela-payment-method-sign-order-v1", JSON.stringify({
      contractCode: "contract-new",
      startedAt: Date.now(),
    }));

    render(<SavedCardsSection />);

    expect(await screen.findByText("已取消添加支付卡。")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("lightvela-payment-method-sign-order-v1")).toBeNull();
    expect(mocks.createSignOrder).not.toHaveBeenCalled();
    expect(mocks.deletePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.setDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it("keeps the current list and offers retry when loading fails", async () => {
    mocks.listPaymentMethods.mockRejectedValue(new RepositoryError("upstream failed", 502, "upstream_error"));

    render(<SavedCardsSection />);

    expect(await screen.findByRole("alert")).toHaveTextContent("支付卡加载失败，请稍后重试。");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeEnabled();
  });
});
