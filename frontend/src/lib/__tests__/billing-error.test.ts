/**
 * 单测：frontend/src/lib/billing-error.ts
 * 覆盖：错误码映射、code 提取、错误分类工具
 */
import { describe, expect, it, vi } from "vitest";
import {
  getBillingErrorCode,
  isPassConflictError,
  isPassRequiresRenewError,
  isPassTerminalError,
  isPassTransientError,
  resolveBillingErrorMessage,
  type BillingErrorCode,
} from "@/lib/billing-error";
import { RepositoryError } from "@/repositories/http-repositories";

// 不 mock RepositoryError —— 直接用真实类即可，模块加载在 jsdom 下安全

describe("billing-error", () => {
  describe("getBillingErrorCode", () => {
    it("从 RepositoryError 中提取 code", () => {
      const err = new RepositoryError("已售罄", 400, "PASS_BUNDLE_SOLD_OUT");
      expect(getBillingErrorCode(err)).toBe("PASS_BUNDLE_SOLD_OUT");
    });

    it("RepositoryError 没带 code 时返回 null", () => {
      const err = new RepositoryError("network down", 0);
      expect(getBillingErrorCode(err)).toBeNull();
    });

    it("鸭子类型识别 fake-repositories 抛的 { code } Error", () => {
      const err = Object.assign(new Error("已存在"), { code: "PASS_ALREADY_EXISTS" });
      expect(getBillingErrorCode(err)).toBe("PASS_ALREADY_EXISTS");
    });

    it("普通 Error 返回 null", () => {
      expect(getBillingErrorCode(new Error("oops"))).toBeNull();
    });

    it("非对象输入安全降级 — null/undefined/数字/字符串", () => {
      expect(getBillingErrorCode(null)).toBeNull();
      expect(getBillingErrorCode(undefined)).toBeNull();
      expect(getBillingErrorCode(42)).toBeNull();
      expect(getBillingErrorCode("PASS_NOT_FOUND")).toBeNull();
    });

    it("非字符串 code 字段被忽略（避免 number/object 误穿透）", () => {
      const err = Object.assign(new Error(), { code: 404 });
      expect(getBillingErrorCode(err)).toBeNull();
    });
  });

  describe("resolveBillingErrorMessage", () => {
    it("命中映射表时返回中文文案", () => {
      const err = new RepositoryError("ignored", 409, "PASS_ALREADY_EXISTS");
      expect(resolveBillingErrorMessage(err)).toBe("您已有有效套餐，无需重复购买。");
    });

    it("通用错误码（INVALID_PARAMETER）返回对应文案", () => {
      const err = new RepositoryError("ignored", 400, "INVALID_PARAMETER");
      expect(resolveBillingErrorMessage(err)).toBe("请求参数有误，请检查后重试。");
    });

    it("Bundle 错误码（BUNDLE_AIGATEWAY_UNAVAILABLE）返回对应文案", () => {
      const err = new RepositoryError("upstream down", 502, "BUNDLE_AIGATEWAY_UNAVAILABLE");
      expect(resolveBillingErrorMessage(err)).toBe("计费服务暂时不可用，请稍后再试。");
    });

    it("命中映射表的 23 条 Pass 错误码全部覆盖", () => {
      const passCodes: BillingErrorCode[] = [
        "PASS_NOT_FOUND",
        "PASS_INVALID_PARAM",
        "PASS_INVALID_TIME_UNIT",
        "PASS_BUNDLE_OFFLINE",
        "PASS_BUNDLE_SOLD_OUT",
        "PASS_NOT_ISOLATED",
        "PASS_EXPIRED",
        "PASS_QUOTA_EXCEEDED",
        "PASS_ISOLATING",
        "PASS_ISOLATED",
        "PASS_RENEWING",
        "PASS_NOT_RENEWABLE",
        "PASS_DELETING",
        "PASS_TERMINATING",
        "PASS_SHADOW_BINDING_NOT_FOUND",
        "PASS_ALREADY_EXISTS",
      ];
      for (const code of passCodes) {
        const err = new RepositoryError("ignored", 400, code);
        const message = resolveBillingErrorMessage(err);
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toBe("ignored"); // 应该走映射表，而非透传 RepositoryError.message
      }
    });

    it("RepositoryError 未命中映射表但有 message 时透传 message", () => {
      const err = new RepositoryError("自定义错误", 400, "UNKNOWN_CODE_XYZ");
      expect(resolveBillingErrorMessage(err)).toBe("自定义错误");
    });

    it("RepositoryError 透传旧系统繁忙文案时统一为刷新提示", () => {
      const err = new RepositoryError("系统繁忙，请稍后再试。", 500, "UNKNOWN_CODE_XYZ");
      expect(resolveBillingErrorMessage(err)).toBe("系统繁忙，请刷新页面后重试");
    });

    it("RepositoryError message 为空 + 5xx 状态时返回 5xx 兜底", () => {
      const err = new RepositoryError("", 503);
      expect(resolveBillingErrorMessage(err)).toBe("系统繁忙，请刷新页面后重试");
    });

    it("RepositoryError message 为空 + 4xx 状态时返回 4xx 兜底", () => {
      const err = new RepositoryError("", 400);
      expect(resolveBillingErrorMessage(err)).toBe("请求未能完成，请检查后重试。");
    });

    it("普通 Error 透传其 message", () => {
      expect(resolveBillingErrorMessage(new Error("network"))).toBe("network");
    });

    it("Error 无 message 时回退到 fallback 参数", () => {
      const err = new Error();
      // Error message 为空时走默认兜底
      expect(resolveBillingErrorMessage(err, "下单失败")).toBe("下单失败");
    });

    it("非 Error 输入 + 自定义 fallback", () => {
      expect(resolveBillingErrorMessage(null, "操作未完成")).toBe("操作未完成");
      expect(resolveBillingErrorMessage(undefined, "操作未完成")).toBe("操作未完成");
    });

    it("非 Error 输入无 fallback 走默认兜底", () => {
      expect(resolveBillingErrorMessage(null)).toBe("操作失败，请稍后再试。");
    });

    it("鸭子类型 Error & {code} 也能命中映射表", () => {
      const err = Object.assign(new Error("orig"), { code: "PASS_BUNDLE_SOLD_OUT" });
      expect(resolveBillingErrorMessage(err)).toBe("套餐已售罄，请选择其他套餐。");
    });
  });

  describe("isPassTransientError", () => {
    it.each([
      ["PASS_ISOLATING", true],
      ["PASS_RENEWING", true],
      ["PASS_DELETING", true],
      ["PASS_TERMINATING", true],
      ["PASS_NOT_FOUND", false],
      ["PASS_ALREADY_EXISTS", false],
      ["", false],
    ] as const)("code=%s → %s", (code, expected) => {
      expect(isPassTransientError(code)).toBe(expected);
    });

    it("null/undefined 输入返回 false", () => {
      expect(isPassTransientError(null)).toBe(false);
      expect(isPassTransientError(undefined)).toBe(false);
    });
  });

  describe("isPassRequiresRenewError", () => {
    it("PASS_EXPIRED / PASS_ISOLATED 返回 true", () => {
      expect(isPassRequiresRenewError("PASS_EXPIRED")).toBe(true);
      expect(isPassRequiresRenewError("PASS_ISOLATED")).toBe(true);
    });

    it("其他错误码返回 false", () => {
      expect(isPassRequiresRenewError("PASS_NOT_FOUND")).toBe(false);
      expect(isPassRequiresRenewError("PASS_ALREADY_EXISTS")).toBe(false);
    });

    it("空值安全", () => {
      expect(isPassRequiresRenewError(null)).toBe(false);
      expect(isPassRequiresRenewError(undefined)).toBe(false);
    });
  });

  describe("isPassConflictError", () => {
    it("仅 PASS_ALREADY_EXISTS 返回 true", () => {
      expect(isPassConflictError("PASS_ALREADY_EXISTS")).toBe(true);
      expect(isPassConflictError("PASS_NOT_FOUND")).toBe(false);
      expect(isPassConflictError(null)).toBe(false);
      expect(isPassConflictError(undefined)).toBe(false);
    });
  });

  describe("isPassTerminalError", () => {
    it.each([
      "PASS_NOT_FOUND",
      "BUNDLE_NOT_FOUND",
      "PASS_BUNDLE_OFFLINE",
      "PASS_BUNDLE_SOLD_OUT",
    ])("不可恢复错误码 %s 返回 true", (code) => {
      expect(isPassTerminalError(code)).toBe(true);
    });

    it("过渡态错误码不算 terminal", () => {
      expect(isPassTerminalError("PASS_DELETING")).toBe(false);
      expect(isPassTerminalError("PASS_RENEWING")).toBe(false);
    });

    it("空值返回 false", () => {
      expect(isPassTerminalError(null)).toBe(false);
      expect(isPassTerminalError("")).toBe(false);
    });
  });
});

vi.unmock("@/repositories/http-repositories");
