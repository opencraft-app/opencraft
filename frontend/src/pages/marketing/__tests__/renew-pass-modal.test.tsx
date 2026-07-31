import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Pass, User } from "@/domain/types";
import { RenewPassModal } from "@/pages/marketing/renew-pass-modal";

const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();
const listMyPasses = vi.fn();
const refreshProfile = vi.fn();
let sessionUser: User | null = null;
let realnamePhoneVerificationEnabled = false;

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

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: { user: sessionUser },
    refreshProfile,
  }),
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  useRealnamePhoneVerificationEnabled: () => realnamePhoneVerificationEnabled,
}));

vi.mock("@/pages/marketing/verify-identity-modal", () => ({
  VerifyIdentityModal: ({ onSuccess }: { onSuccess: () => void }) => (
    <div role="dialog" aria-label="实名认证">
      <button type="button" onClick={onSuccess}>完成实名</button>
    </div>
  ),
}));

const buildPass = (overrides: Partial<Pass> = {}): Pass => ({
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
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: "usr_renew_modal",
  name: "Renew User",
  inviteRequired: false,
  realnameVerified: true,
  realnameLevel: "idcard_2fa",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...overrides,
});

describe("RenewPassModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionUser = buildUser();
    realnamePhoneVerificationEnabled = false;
    refreshProfile.mockResolvedValue(undefined);
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
    await waitFor(() => expect(intervalCallbacks).toHaveLength(1));

    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(1);

    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(1);

    resolveFirstCheck?.([]);
    await Promise.resolve();
    intervalCallbacks[0]!();
    expect(listMyPasses).toHaveBeenCalledTimes(2);
  });

  it("uses non-green badge colors for expired and isolated passes", async () => {
    const renderModal = (pass: Pass) => (
      <RenewPassModal
        pass={pass}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />
    );

    const { rerender } = render(renderModal(buildPass({
      expired_time: "2026-07-01T00:00:00.000Z",
    })));

    const expiredBadge = await screen.findByText("已过期");
    expect(expiredBadge).toHaveClass("bg-black/[0.06]");
    expect(expiredBadge).toHaveClass("text-black/45");
    expect(expiredBadge.className).not.toContain("#147A56");

    rerender(renderModal(buildPass({
      isolated_time: "2026-07-20T00:00:00.000Z",
    })));

    const isolatedBadge = await screen.findByText("隔离期");
    expect(isolatedBadge).toHaveClass("bg-[rgba(198,123,30,0.12)]");
    expect(isolatedBadge).toHaveClass("text-[#9A5A00]");
    expect(isolatedBadge.className).not.toContain("#147A56");
  });

  it("prompts realname verification in the renewal modal before opening the realname dialog", async () => {
    sessionUser = buildUser({
      realnameVerified: false,
      realnameLevel: "none",
    });
    const onClose = vi.fn();
    refreshProfile.mockImplementationOnce(async () => {
      sessionUser = buildUser({
        realnameVerified: true,
        realnameLevel: "idcard_2fa",
      });
    });

    render(
      <RenewPassModal
        pass={buildPass()}
        onClose={onClose}
        onSuccess={vi.fn()}
        initialRealnameRequired
      />,
    );

    expect(await screen.findByText("暂无价格")).toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认续费" })).toBeDisabled();

    expect(createRenewOrder).not.toHaveBeenCalled();
    expect(await screen.findByText("续费前需先")).toBeInTheDocument();
    expect(screen.getByText("，完成后再确认续费。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "更新实名认证信息" })).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更新实名认证信息" }));

    expect(screen.queryByText("续费套餐")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "实名认证" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "完成实名" }));

    await waitFor(() => expect(refreshProfile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText("续费套餐")).toBeInTheDocument();
    await waitFor(() => expect(getRenewPrice).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "确认续费" })).not.toBeDisabled();
  });

  it("requires phone-level realname when phone verification is enabled", async () => {
    realnamePhoneVerificationEnabled = true;
    sessionUser = buildUser({
      phone: "13800138000",
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
    });

    render(
      <RenewPassModal
        pass={buildPass()}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        initialRealnameRequired
      />,
    );

    expect(await screen.findByText("暂无价格")).toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认续费" })).toBeDisabled();

    expect(createRenewOrder).not.toHaveBeenCalled();
    expect(await screen.findByText("续费前需先")).toBeInTheDocument();
    expect(screen.getByText("，完成后再确认续费。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "更新实名认证信息" })).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更新实名认证信息" }));

    expect(screen.queryByText("续费套餐")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "实名认证" })).toBeInTheDocument();
  });
});
