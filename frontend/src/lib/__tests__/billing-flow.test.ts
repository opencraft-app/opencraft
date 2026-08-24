/**
 * 单测：frontend/src/lib/billing-flow.ts
 * 覆盖：站点分流、时间单位转换、Pass 状态推断
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pass } from "@/domain/types";
import {
  canCreateNewPass,
  canDeletePass,
  canRenewPass,
  centsToYuan,
  findActivePass,
  formatDuration,
  formatTimeUnit,
  formatYuan,
  getPassStatus,
} from "@/lib/billing-flow";

// 固定的"当前时间"参考点，便于测试 Pass 过期/未过期
const NOW = new Date("2026-05-20T10:00:00Z").getTime();

const buildPass = (overrides: Partial<Pass> = {}): Pass => ({
  pass_id: "pass-001",
  user_id: "user-001",
  bundle_id: "bundle_launch_01",
  bundle_name: "启航 Launch",
  uin: 700000164995,
  app_id: 1322244500,
  created_time: "2026-05-01T00:00:00Z",
  expired_time: "2026-06-01T00:00:00Z",
  isolated_time: null,
  deleted_time: null,
  agent_quota_total: 1,
  agent_quota_available: 1,
  credit_total: 100,
  credit_available: 100,
  ...overrides,
});

describe("billing-flow / 时间单位转换", () => {
  describe("formatTimeUnit", () => {
    it("d → 天", () => {
      expect(formatTimeUnit("d")).toBe("天");
    });
    it("m → 个月", () => {
      expect(formatTimeUnit("m")).toBe("个月");
    });
    it("y → 年", () => {
      expect(formatTimeUnit("y")).toBe("年");
    });
  });

  describe("formatDuration", () => {
    it("拼接时长与单位", () => {
      expect(formatDuration(7, "d")).toBe("7 天");
      expect(formatDuration(1, "m")).toBe("1 个月");
      expect(formatDuration(2, "y")).toBe("2 年");
    });
    it("零值与极值边界", () => {
      expect(formatDuration(0, "d")).toBe("0 天");
      expect(formatDuration(99, "m")).toBe("99 个月");
    });
  });

  describe("centsToYuan", () => {
    it("整数分转元", () => {
      expect(centsToYuan(4900)).toBe(49);
      expect(centsToYuan("4900")).toBe(49);
    });
    it("小数分（jifei 极少出现，但要安全）", () => {
      expect(centsToYuan(4999)).toBe(49.99);
    });
    it("零值", () => {
      expect(centsToYuan(0)).toBe(0);
      expect(centsToYuan("0")).toBe(0);
    });
    it("非数字字符串安全降级到 0", () => {
      expect(centsToYuan("abc")).toBe(0);
      expect(centsToYuan("")).toBe(0);
    });
    it("Infinity 安全降级到 0", () => {
      expect(centsToYuan(Number.POSITIVE_INFINITY)).toBe(0);
      expect(centsToYuan(Number.NaN)).toBe(0);
    });
  });

  describe("formatYuan", () => {
    it("CNY 货币格式化为 ¥xx.xx", () => {
      expect(formatYuan(49)).toBe("¥49.00");
      expect(formatYuan(49.5)).toBe("¥49.50");
    });
    it("零值", () => {
      expect(formatYuan(0)).toBe("¥0.00");
    });
    it("USD 用 $ 前缀，其他非 CNY 通用格式", () => {
      expect(formatYuan(7.5, "USD")).toBe("$7.50");
      expect(formatYuan(9, "EUR")).toBe("9 EUR");
    });
  });
});

describe("billing-flow / Pass 状态推断", () => {
  describe("getPassStatus", () => {
    it("未过期 + 未隔离 + 未销毁 → active", () => {
      const pass = buildPass({ expired_time: "2026-06-01T00:00:00Z" });
      expect(getPassStatus(pass, NOW)).toBe("active");
    });

    it("已过期但未隔离/未销毁 → expired", () => {
      const pass = buildPass({ expired_time: "2026-04-01T00:00:00Z" });
      expect(getPassStatus(pass, NOW)).toBe("expired");
    });

    it("有 isolated_time → isolated（即使尚未到 expired_time 也优先）", () => {
      const pass = buildPass({
        expired_time: "2026-06-01T00:00:00Z",
        isolated_time: "2026-05-15T00:00:00Z",
      });
      expect(getPassStatus(pass, NOW)).toBe("isolated");
    });

    it("有 deleted_time → deleted（最高优先级）", () => {
      const pass = buildPass({
        isolated_time: "2026-05-15T00:00:00Z",
        deleted_time: "2026-05-19T00:00:00Z",
      });
      expect(getPassStatus(pass, NOW)).toBe("deleted");
    });

    it("expired_time 等于当前时间 → expired（边界含等号）", () => {
      const pass = buildPass({ expired_time: new Date(NOW).toISOString() });
      expect(getPassStatus(pass, NOW)).toBe("expired");
    });

    it("expired_time 非法字符串 → 退化为 active（不抛异常）", () => {
      const pass = buildPass({ expired_time: "invalid-date" });
      expect(getPassStatus(pass, NOW)).toBe("active");
    });

    it("默认参数使用 Date.now()", () => {
      // 用一个绝对未过期的 pass 验证默认参数路径不抛异常
      const pass = buildPass({ expired_time: "2099-12-31T00:00:00Z" });
      expect(getPassStatus(pass)).toBe("active");
    });
  });

  describe("findActivePass", () => {
    it("从混合列表中找到唯一 active", () => {
      const list = [
        buildPass({ pass_id: "p1", expired_time: "2026-04-01T00:00:00Z" }), // expired
        buildPass({ pass_id: "p2", expired_time: "2026-06-01T00:00:00Z" }), // active
        buildPass({ pass_id: "p3", deleted_time: "2026-04-01T00:00:00Z" }), // deleted
      ];
      expect(findActivePass(list, NOW)?.pass_id).toBe("p2");
    });

    it("空列表返回 null", () => {
      expect(findActivePass([], NOW)).toBeNull();
    });

    it("全部非 active 返回 null", () => {
      const list = [
        buildPass({ pass_id: "p1", expired_time: "2026-04-01T00:00:00Z" }),
        buildPass({ pass_id: "p2", deleted_time: "2026-04-01T00:00:00Z" }),
      ];
      expect(findActivePass(list, NOW)).toBeNull();
    });
  });

  describe("canDeletePass", () => {
    it("仅 isolated 返回 true", () => {
      const isolated = buildPass({ isolated_time: "2026-05-15T00:00:00Z" });
      expect(canDeletePass(isolated, NOW)).toBe(true);
    });

    it("active / expired / deleted 都返回 false", () => {
      expect(canDeletePass(buildPass({ expired_time: "2099-01-01T00:00:00Z" }), NOW)).toBe(false);
      expect(canDeletePass(buildPass({ expired_time: "2024-01-01T00:00:00Z" }), NOW)).toBe(false);
      expect(canDeletePass(buildPass({ deleted_time: "2026-05-10T00:00:00Z" }), NOW)).toBe(false);
    });
  });

  describe("canRenewPass", () => {
    it.each<["active" | "expired" | "isolated" | "deleted", boolean]>([
      ["active", true],
      ["expired", true],
      ["isolated", true],
      ["deleted", false],
    ])("status=%s → %s", (status, expected) => {
      let pass: Pass;
      switch (status) {
        case "active":
          pass = buildPass({ expired_time: "2099-01-01T00:00:00Z" });
          break;
        case "expired":
          pass = buildPass({ expired_time: "2024-01-01T00:00:00Z" });
          break;
        case "isolated":
          pass = buildPass({ isolated_time: "2026-05-15T00:00:00Z" });
          break;
        case "deleted":
          pass = buildPass({ deleted_time: "2026-05-19T00:00:00Z" });
          break;
      }
      expect(canRenewPass(pass, NOW)).toBe(expected);
    });
  });

  describe("canCreateNewPass", () => {
    it("空列表允许新购", () => {
      expect(canCreateNewPass([], NOW)).toBe(true);
    });

    it("仅 deleted pass 也允许新购（互斥占用规则前置 UI 优化）", () => {
      const list = [buildPass({ deleted_time: "2026-04-01T00:00:00Z" })];
      expect(canCreateNewPass(list, NOW)).toBe(true);
    });

    it("存在 active pass 时禁止新购", () => {
      const list = [buildPass({ expired_time: "2099-01-01T00:00:00Z" })];
      expect(canCreateNewPass(list, NOW)).toBe(false);
    });

    it("存在 expired/isolated pass 时禁止新购（应走续费路径）", () => {
      expect(canCreateNewPass([buildPass({ expired_time: "2024-01-01T00:00:00Z" })], NOW)).toBe(false);
      expect(canCreateNewPass([buildPass({ isolated_time: "2026-05-15T00:00:00Z" })], NOW)).toBe(false);
    });
  });
});

describe("billing-flow / 运行时付费开关与站点分流", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/region");
  });

  it("付费开关只接受显式 true", async () => {
    const mod = await import("@/lib/billing-flow");
    expect(mod.isPaidBillingEnabled(true)).toBe(true);
    expect(mod.isPaidBillingEnabled(false)).toBe(false);
  });

  it("国内站：isFreeTrialOnlyMode=false", async () => {
    vi.resetModules();
    vi.doMock("@/lib/region", () => ({
      REGION: "cn",
      isCN: true,
      isGlobal: false,
      DEFAULT_LOCALE: "zh-CN",
    }));
    const mod = await import("@/lib/billing-flow");
    expect(mod.isFreeTrialOnlyMode()).toBe(false);
  });

  it("国际站：isFreeTrialOnlyMode=true", async () => {
    vi.resetModules();
    vi.doMock("@/lib/region", () => ({
      REGION: "global",
      isCN: false,
      isGlobal: true,
      DEFAULT_LOCALE: "en-US",
    }));
    const mod = await import("@/lib/billing-flow");
    expect(mod.isFreeTrialOnlyMode()).toBe(true);
  });
});
