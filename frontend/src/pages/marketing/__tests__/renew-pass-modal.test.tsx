import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pass } from "@/domain/types";
import { RenewPassModal } from "@/pages/marketing/renew-pass-modal";

const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();
const listMyPasses = vi.fn();

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => {
    const value = options?.[name];
    return value === undefined || value === null ? raw : String(value);
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    plans: {
      getRenewPrice,
      createRenewOrder,
      listMyPasses,
    },
  }),
}));

const buildPass = (): Pass => ({
  pass_id: "pass_renew_modal",
  user_id: "usr_renew_modal",
  bundle_id: "bundle_launch",
  bundle_name: "启航套餐",
  created_time: "2026-07-01T00:00:00.000Z",
  expired_time: "2026-08-01T00:00:00.000Z",
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 800,
});

describe("RenewPassModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRenewPrice.mockResolvedValue({
      bundle_id: "bundle_launch",
      price: 4900,
      total_cost: 4900,
      real_total_cost: 4900,
      currency: "CNY",
      discount: 100,
    });
    createRenewOrder.mockResolvedValue({
      order_id: "order_renew_modal",
      pass_id: "pass_renew_modal",
      auth_code: "auth_renew_modal",
      deal_names: ["renew_deal_modal"],
    });
    listMyPasses.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps automatic payment status polling serial while a request is still in flight", async () => {
    let resolveFirstCheck: ((passes: Pass[]) => void) | null = null;
    const intervalCallbacks: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((handler, timeout) => {
      if (timeout === 3_000) {
        intervalCallbacks.push(handler as () => void);
      }
      return 1;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    listMyPasses.mockImplementationOnce(() => new Promise<Pass[]>((resolve) => {
      resolveFirstCheck = resolve;
    }));

    render(
      <RenewPassModal
        pass={buildPass()}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    await screen.findByText("¥49.00");
    expect(getRenewPrice).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认续费" }));
    expect(await screen.findByText("微信扫码支付")).toBeInTheDocument();
    expect(intervalCallbacks).toHaveLength(1);

    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(1);

    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(1);

    resolveFirstCheck?.([]);
    await Promise.resolve();
    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(2);
  });
});
