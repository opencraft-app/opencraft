import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCreditSources, type PlanCreditInput } from "../use-credit-sources";

const listCreditPackages = vi.fn();

/* 稳定引用：真实 context 返回同一对象，mock 也保持稳定，避免掩盖引用依赖问题 */
const repositoriesStub: { credit?: { listCreditPackages: typeof listCreditPackages } } = {
  credit: { listCreditPackages },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositoriesStub,
}));

const planCredit: PlanCreditInput = {
  displayName: "启航版",
  creditTotal: 5000,
  creditAvailable: 2000,
  nextRefreshAt: "2026-10-15T00:00:00Z",
};

beforeEach(() => {
  listCreditPackages.mockReset();
  listCreditPackages.mockResolvedValue([]);
  repositoriesStub.credit = { listCreditPackages };
});

describe("useCreditSources", () => {
  it("只有套餐积分时正确汇总", async () => {
    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.summary).toEqual({
      available: 2000,
      total: 5000,
      used: 3000,
      sourceCount: 1,
    });
  });

  it("合并套餐积分与多个积分包并汇总", async () => {
    listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 1000, credit_available: 600, expired_time: "2026-09-20T00:00:00Z" },
      { credit_type: "paid", credit_total: 4000, credit_available: 4000, expired_time: "2026-11-01T00:00:00Z" },
    ]);

    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(result.current.sources).toHaveLength(3);
    });

    expect(result.current.summary).toEqual({
      available: 6600,
      total: 10000,
      used: 3400,
      sourceCount: 3,
    });
  });

  it("将额外积分作为独立来源计入汇总", async () => {
    const { result } = renderHook(() =>
      useCreditSources(planCredit, {
        displayName: "额外积分",
        creditTotal: 500,
        creditAvailable: 500,
      }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sources.map((source) => source.source_type)).toEqual(["plan", "free_credit"]);
    expect(result.current.summary).toEqual({
      available: 2500,
      total: 5500,
      used: 3000,
      sourceCount: 2,
    });
  });

  it("按到期/刷新时间从早到晚排序，与扣减顺序一致", async () => {
    listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 4000, credit_available: 4000, expired_time: "2026-11-01T00:00:00Z" },
      { credit_type: "paid", credit_total: 1000, credit_available: 600, expired_time: "2026-09-20T00:00:00Z" },
    ]);

    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(result.current.sources).toHaveLength(3);
    });

    /* 09-20 积分包 → 10-15 套餐刷新 → 11-01 积分包 */
    expect(result.current.sources.map((s) => s.display_name)).toEqual([
      "1,000 积分包",
      "启航版",
      "4,000 积分包",
    ]);
  });

  it("积分包查询失败时仍展示套餐积分并标记失败", async () => {
    listCreditPackages.mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(result.current.failed).toBe(true);
    });

    expect(result.current.sources).toHaveLength(1);
    expect(result.current.summary.total).toBe(5000);
  });

  it("无套餐时只展示积分包", async () => {
    listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 2000, credit_available: 1500, expired_time: "2026-10-01T00:00:00Z" },
    ]);

    const { result } = renderHook(() => useCreditSources(null));

    await waitFor(() => {
      expect(result.current.sources).toHaveLength(1);
    });

    expect(result.current.summary).toEqual({
      available: 1500,
      total: 2000,
      used: 500,
      sourceCount: 1,
    });
  });

  it("套餐额度为 0 时不计入来源", async () => {
    const { result } = renderHook(() =>
      useCreditSources({ displayName: "启航版", creditTotal: 0, creditAvailable: 0 }),
    );

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sources).toHaveLength(0);
    expect(result.current.summary.sourceCount).toBe(0);
  });

  it("余额为 0 但未到期的积分包仍保留在明细中", async () => {
    listCreditPackages.mockResolvedValue([
      { credit_type: "paid", credit_total: 1000, credit_available: 0, expired_time: "2026-10-01T00:00:00Z" },
    ]);

    const { result } = renderHook(() => useCreditSources(null));

    await waitFor(() => {
      expect(result.current.sources).toHaveLength(1);
    });

    expect(result.current.sources[0]?.credit_available).toBe(0);
    expect(result.current.summary.used).toBe(1000);
  });

  it("repositories 缺少 credit 仓储时退化为仅套餐积分，不抛错", async () => {
    /* 既有账号页测试的 mock repositories 只有 auth/plans/bots，没有 credit。
       积分包是增量能力，缺失它不能让整个页面崩溃。 */
    repositoriesStub.credit = undefined;

    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.failed).toBe(false);
    expect(result.current.sources).toHaveLength(1);
    expect(result.current.summary.total).toBe(5000);
    expect(listCreditPackages).not.toHaveBeenCalled();
  });

  it("reload 会重新拉取积分包", async () => {
    const { result } = renderHook(() => useCreditSources(planCredit));

    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(1);
    });

    result.current.reload();

    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(2);
    });
  });

  it("套餐入参变化不会重复请求积分包", async () => {
    const { result, rerender } = renderHook(({ plan }) => useCreditSources(plan), {
      initialProps: { plan: planCredit },
    });

    await waitFor(() => {
      expect(listCreditPackages).toHaveBeenCalledTimes(1);
    });

    rerender({ plan: { ...planCredit, creditAvailable: 1800 } });

    await waitFor(() => {
      expect(result.current.summary.available).toBe(1800);
    });
    /* 套餐数值变化只影响汇总，不应触发积分包重新查询 */
    expect(listCreditPackages).toHaveBeenCalledTimes(1);
  });
});
