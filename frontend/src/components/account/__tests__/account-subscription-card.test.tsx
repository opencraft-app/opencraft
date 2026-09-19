import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CurrentSubscription, Pass } from "@/domain/types";
import {
  resolveAccountSubscriptionState,
  type UseAccountSubscriptionModelOptions,
} from "@/lib/use-account-subscription-model";
import {
  AccountSubscriptionCard,
  type AccountSubscriptionCardProps,
} from "../account-subscription-card";

vi.mock("@/i18n/t", () => ({ useT: () => (text: string, options?: { days?: number }) =>
  options?.days == null ? text : text.replace("{{days}}", String(options.days)) }));

afterEach(cleanup);

const buildPass = (overrides: Partial<Pass> = {}): Pass => ({
  pass_id: "pass-1",
  user_id: "user-1",
  bundle_id: "bundle-1",
  bundle_name: "Hermes Pro",
  status: "active",
  created_time: "2026-09-01T00:00:00Z",
  expired_time: "2026-10-01T00:00:00Z",
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 800,
  ...overrides,
});

const baseProps = (overrides: Partial<AccountSubscriptionCardProps> = {}): AccountSubscriptionCardProps => ({
  state: "ready",
  pass: buildPass(),
  displayName: "Hermes Pro",
  validity: {
    startDate: "2026/09/01",
    endDate: "2026/10/01",
    remainDays: 13,
    expired: false,
  },
  credits: { total: 1000, used: 200, usedPercent: 20 },
  passStatus: "active",
  passState: "current",
  actions: {
    canRenew: true,
    renewalAvailable: true,
    canDelete: false,
    upgradeHref: "/subscribe/?upgrade_pass_id=pass-1",
    onRenew: vi.fn(),
    onDelete: vi.fn(),
    onRetryUpgrade: vi.fn(),
  },
  error: { summary: false, upgrade: false },
  subscribeHref: "/subscribe",
  ...overrides,
});

const renderCard = (props: AccountSubscriptionCardProps) => render(
  <MemoryRouter>
    <AccountSubscriptionCard {...props} />
  </MemoryRouter>,
);

describe("AccountSubscriptionCard", () => {
  it("preserves credit-pack sources and retry alongside the shared progress", () => {
    const onRetry = vi.fn();
    renderCard(baseProps({
      pass: buildPass({ credit_available: 0 }),
      credits: { total: 1500, used: 1000, usedPercent: 67 },
      creditPacks: {
        sources: [{ source_id: "paid-1", source_type: "paid_pack", display_name: "500 积分包", credit_total: 500, credit_available: 500 }],
        sourceCount: 2,
        purchaseHref: "/subscribe?section=credits",
        failed: true,
        onRetry,
      },
    }));
    expect(screen.getByRole("link", { name: "购买积分包" })).toHaveAttribute("href", "/subscribe?section=credits");
    expect(screen.getByText("500 积分包")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "67");
    expect(screen.queryByText("模型积分已用尽", { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "积分包额度加载失败，点击重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("preserves the CurrentSubscription contract and summary state precedence", () => {
    const legacySubscription: CurrentSubscription = {
      tier: "max",
      code: "pro",
      status: "active",
      currentPeriodStart: "2026-09-01T00:00:00Z",
      currentPeriodEnd: "2026-10-01T00:00:00Z",
    };

    expectTypeOf<UseAccountSubscriptionModelOptions["subscription"]>()
      .toEqualTypeOf<CurrentSubscription | null | undefined>();
    expect(resolveAccountSubscriptionState("loading", null, legacySubscription)).toBe("loading");
    expect(resolveAccountSubscriptionState("error", null, legacySubscription)).toBe("error");
    expect(resolveAccountSubscriptionState("none", null, legacySubscription)).toBe("ready");
    expect(resolveAccountSubscriptionState("idle", null, null)).toBe("idle");
    expect(resolveAccountSubscriptionState("error", buildPass(), legacySubscription)).toBe("ready");
  });

  it("renders the active plan, dates, renew and upgrade actions", () => {
    const props = baseProps();
    renderCard(props);

    expect(screen.getByText("Hermes Pro")).toBeVisible();
    expect(screen.getByText("2026/09/01 — 2026/10/01")).toBeVisible();
    expect(screen.getByText("剩余 13 天")).toBeVisible();
    expect(screen.getByRole("link", { name: "升级套餐" })).toHaveAttribute("href", "/subscribe/?upgrade_pass_id=pass-1");
    fireEvent.click(screen.getByRole("button", { name: "立即续费" }));
    expect(props.actions.onRenew).toHaveBeenCalledOnce();
  });

  it("renders modifying and failed modifying status without destructive actions", () => {
    const { rerender } = renderCard(baseProps({
      pass: buildPass({ status: "modifying" }),
      passState: "modifying",
      actions: { ...baseProps().actions, canRenew: false, canDelete: false, upgradeHref: null },
    }));
    expect(screen.getByRole("status")).toHaveTextContent("套餐升级中");
    expect(screen.queryByRole("button", { name: "销毁套餐" })).not.toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <AccountSubscriptionCard {...baseProps({ passState: "modify-failed" })} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("套餐升级失败");
  });

  it.each([
    ["expired", "已过期", "套餐已过期，请及时续费以免进入隔离期。"],
    ["isolated", "已过期", "套餐已进入隔离期，可选择续费恢复使用或销毁当前套餐。销毁后可重新购买。"],
  ] as const)("renders the %s lifecycle warning", (passStatus, dateLabel, warning) => {
    const onDelete = vi.fn();
    renderCard(baseProps({
      pass: buildPass(passStatus === "isolated" ? { isolated_time: "2026-09-10T00:00:00Z" } : { expired_time: "2026-09-10T00:00:00Z" }),
      passStatus,
      validity: { startDate: "2026/08/01", endDate: "2026/09/10", remainDays: 0, expired: true },
      actions: { ...baseProps().actions, canDelete: passStatus === "isolated", onDelete },
    }));

    expect(screen.getByText(dateLabel)).toBeVisible();
    expect(screen.getByText(dateLabel)).toHaveAttribute("data-tone", passStatus === "isolated" ? "warning" : "danger");
    expect(screen.getByText(warning)).toBeVisible();
    if (passStatus === "isolated") {
      fireEvent.click(screen.getByRole("button", { name: "销毁套餐" }));
      expect(onDelete).toHaveBeenCalledOnce();
    }
  });

  it("renders one create action for the empty state", () => {
    renderCard(baseProps({
      state: "none",
      pass: null,
      displayName: "Legacy",
      validity: null,
      credits: null,
      passStatus: null,
      actions: { ...baseProps().actions, canRenew: false, canDelete: false, upgradeHref: null },
    }));

    expect(screen.getByText("还没有订阅套餐")).toBeVisible();
    expect(screen.getAllByRole("link", { name: "立即创建" })).toHaveLength(1);
  });

  it.each([
    ["loading", "正在加载"],
    ["error", "套餐列表加载失败"],
  ] as const)("renders %s feedback without a create action", (state, message) => {
    renderCard(baseProps({
      state,
      pass: null,
      validity: null,
      credits: null,
      passStatus: null,
      error: { summary: state === "error", upgrade: false },
    }));

    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByRole("link", { name: "立即创建" })).not.toBeInTheDocument();
    expect(screen.queryByText("还没有订阅套餐")).not.toBeInTheDocument();
  });

  it("treats idle as a confirmed empty state under the summary contract", () => {
    renderCard(baseProps({
      state: "idle",
      pass: null,
      validity: null,
      credits: null,
      passStatus: null,
    }));

    expect(screen.getByRole("link", { name: "立即创建" })).toHaveAttribute("href", "/subscribe");
  });

  it("renders a ready legacy subscription without pass quota or a create action", () => {
    renderCard(baseProps({
      state: "ready",
      pass: null,
      displayName: "Legacy Launch",
      credits: null,
      passStatus: null,
      actions: { ...baseProps().actions, canRenew: false, canDelete: false, upgradeHref: null },
    }));

    expect(screen.getByText("Legacy Launch")).toBeVisible();
    expect(screen.queryByRole("link", { name: "立即创建" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("keeps the unavailable renewal action disabled and explains it with a tooltip", async () => {
    renderCard(baseProps({
      actions: { ...baseProps().actions, renewalAvailable: false, upgradeHref: null },
    }));

    const renew = screen.getByRole("button", { name: "立即续费" });
    expect(renew).toHaveAttribute("aria-disabled", "true");
    fireEvent.focus(renew);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("敬请期待");
  });

  it.each([
    [0, 0, 0],
    [0, 0, 1000],
    [80, 800, 1000],
    [95, 950, 1000],
    [100, 1000, 1000],
  ])("exposes %s percent credit usage through Progress", (usedPercent, used, total) => {
    renderCard(baseProps({ credits: { total, used, usedPercent } }));

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(usedPercent));
    expect(screen.getByText(`/ ${total.toLocaleString()}`).parentElement).toHaveTextContent(`${used.toLocaleString()} / ${total.toLocaleString()}`);
    expect(screen.getByText(`/ ${total.toLocaleString()}`).parentElement).toHaveClass("tabular-nums");
  });

  it("does not fabricate a progress value when credits are unknown", () => {
    renderCard(baseProps({ credits: null }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
