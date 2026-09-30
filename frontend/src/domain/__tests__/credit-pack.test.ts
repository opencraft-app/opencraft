import { describe, expect, it } from "vitest";

import {
  CREDIT_PACK_DENOMINATIONS,
  creditPackageSourceId,
  sortCreditSources,
  summarizeCreditSources,
  type CreditPackageItem,
  type CreditSourceView,
} from "../credit-pack";

const source = (overrides: Partial<CreditSourceView>): CreditSourceView => ({
  source_type: "paid_pack",
  source_id: "pack-1",
  display_name: "1000 积分包",
  credit_total: 1000,
  credit_available: 1000,
  ...overrides,
});

describe("CREDIT_PACK_DENOMINATIONS", () => {
  it("按产品方案提供 5 个面额且金额递增", () => {
    expect(CREDIT_PACK_DENOMINATIONS.map((d) => d.credit_total)).toEqual([1000, 2000, 4000, 8000, 12000]);
  });

  it("product_id 唯一，避免卡片 key 冲突", () => {
    const ids = CREDIT_PACK_DENOMINATIONS.map((d) => d.product_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("product_id 与后端 seed 真源一致（scripts/seed_credit_beijing_sandbox_products.sql）", () => {
    /* 后端用下划线命名（credit_1000），不是连字符。写错会导致询价全部失败。 */
    expect(CREDIT_PACK_DENOMINATIONS.map((d) => d.product_id)).toEqual([
      "credit_1000",
      "credit_2000",
      "credit_4000",
      "credit_8000",
      "credit_12000",
    ]);
  });
});

describe("summarizeCreditSources", () => {
  it("汇总多个来源的可用额度与总额度", () => {
    const summary = summarizeCreditSources([
      source({ source_id: "plan", source_type: "plan", credit_total: 5000, credit_available: 2000 }),
      source({ source_id: "pack-a", credit_total: 1000, credit_available: 1000 }),
      source({ source_id: "pack-b", credit_total: 2000, credit_available: 500 }),
    ]);

    expect(summary).toEqual({ available: 3500, total: 8000, used: 4500, sourceCount: 3 });
  });

  it("无来源时全部为 0", () => {
    expect(summarizeCreditSources([])).toEqual({ available: 0, total: 0, used: 0, sourceCount: 0 });
  });

  it("可用额度超过总额度时已使用不为负数", () => {
    const summary = summarizeCreditSources([source({ credit_total: 100, credit_available: 300 })]);

    expect(summary.used).toBe(0);
  });

  it("余额为 0 但未到期的来源仍计入来源数量", () => {
    const summary = summarizeCreditSources([
      source({ source_id: "exhausted", credit_total: 1000, credit_available: 0 }),
    ]);

    expect(summary.sourceCount).toBe(1);
    expect(summary.used).toBe(1000);
  });
});

describe("sortCreditSources", () => {
  it("赠送积分优先于更早到期的套餐和付费积分包", () => {
    const sorted = sortCreditSources([
      source({ source_id: "plan", source_type: "plan", next_expire_at: "2026-10-01T00:00:00Z" }),
      source({ source_id: "free", source_type: "free_credit", next_expire_at: "2126-09-29T00:00:00Z" }),
      source({ source_id: "paid", next_expire_at: "2026-11-01T00:00:00Z" }),
    ]);
    expect(sorted.map((item) => item.source_id)).toEqual(["free", "plan", "paid"]);
  });

  it("到期时间更早的来源排在前面", () => {
    const sorted = sortCreditSources([
      source({ source_id: "late", next_expire_at: "2026-12-01T00:00:00Z" }),
      source({ source_id: "early", next_expire_at: "2026-10-01T00:00:00Z" }),
      source({ source_id: "middle", next_expire_at: "2026-11-01T00:00:00Z" }),
    ]);

    expect(sorted.map((s) => s.source_id)).toEqual(["early", "middle", "late"]);
  });

  it("时间相同时保持输入顺序，避免页面抖动", () => {
    const sorted = sortCreditSources([
      source({ source_id: "first", next_expire_at: "2026-10-01T00:00:00Z" }),
      source({ source_id: "second", next_expire_at: "2026-10-01T00:00:00Z" }),
    ]);

    expect(sorted.map((s) => s.source_id)).toEqual(["first", "second"]);
  });

  it("缺少时间的来源排在最后", () => {
    const sorted = sortCreditSources([
      source({ source_id: "no-time", next_expire_at: undefined }),
      source({ source_id: "has-time", next_expire_at: "2026-10-01T00:00:00Z" }),
    ]);

    expect(sorted.map((s) => s.source_id)).toEqual(["has-time", "no-time"]);
  });

  it("无法解析的时间视同缺失排在最后，不产生 NaN 比较", () => {
    const sorted = sortCreditSources([
      source({ source_id: "broken", next_expire_at: "not-a-date" }),
      source({ source_id: "valid", next_expire_at: "2026-10-01T00:00:00Z" }),
    ]);

    expect(sorted.map((s) => s.source_id)).toEqual(["valid", "broken"]);
  });

  it("不修改传入数组", () => {
    const input = [
      source({ source_id: "b", next_expire_at: "2026-12-01T00:00:00Z" }),
      source({ source_id: "a", next_expire_at: "2026-10-01T00:00:00Z" }),
    ];
    sortCreditSources(input);

    expect(input.map((s) => s.source_id)).toEqual(["b", "a"]);
  });
});

describe("creditPackageSourceId", () => {
  const item = (overrides: Partial<CreditPackageItem>): CreditPackageItem => ({
    credit_type: "paid",
    credit_total: 1000,
    credit_available: 1000,
    expired_time: "2026-10-01T00:00:00Z",
    ...overrides,
  });

  it("同额度不同到期时间的积分包生成不同 key", () => {
    const a = creditPackageSourceId(item({ expired_time: "2026-10-01T00:00:00Z" }));
    const b = creditPackageSourceId(item({ expired_time: "2026-11-01T00:00:00Z" }));

    expect(a).not.toBe(b);
  });

  it("不同额度的积分包生成不同 key", () => {
    const a = creditPackageSourceId(item({ credit_total: 1000 }));
    const b = creditPackageSourceId(item({ credit_total: 2000 }));

    expect(a).not.toBe(b);
  });

  it("付费与免费积分区分开", () => {
    const paid = creditPackageSourceId(item({ credit_type: "paid" }));
    const free = creditPackageSourceId(item({ credit_type: "free" }));

    expect(paid).not.toBe(free);
  });

  it("已知限制：同额度且到期时间相同的两个包会冲突（待后端补 package_id）", () => {
    /* 这条断言记录当前实现的已知缺陷，后端补 package_id 后应改为不冲突 */
    const a = creditPackageSourceId(item({}));
    const b = creditPackageSourceId(item({}));

    expect(a).toBe(b);
  });
});
