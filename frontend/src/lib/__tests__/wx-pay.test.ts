/**
 * 单测：frontend/src/lib/wx-pay.ts（v1.7.31 + CodeBuddy AuthCode 安全模型）
 *
 * 覆盖：
 *   - buildPayPlan：dealName 缺失抛错；正常路径 needCharge 恒为 true、生成 bridgeUrl、expiresAt
 *   - bridgeUrl query 编码协议（dealName/authCode/passId/expiresAt/sandbox/bundleName）
 *   - sandbox 开关传递（参数 / 环境变量两种来源）
 *   - bridgeBaseUrl 优先级：参数 > NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL > window.location.origin
 *   - encodeBase64Url / decodeBase64Url 互逆 + URL 安全字符
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_QUERY_KEYS,
  buildPayPlan,
  decodeBase64Url,
  encodeBase64Url,
  type BuildPayPlanInput,
} from "@/lib/wx-pay";

const baseInput: BuildPayPlanInput = {
  dealName: "20231019551041263427081",
  authCode: "AC-7f3e4b29c1d24e6a9b1f0e8d7a5c4b30",
};

describe("wx-pay / buildPayPlan", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("基本路径（dealName 必填）", () => {
    it("needCharge 恒为 true（CodeBuddy 模式 PC 端拿不到 need_charge）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/wx-pay-bridge",
      });
      expect(plan.needCharge).toBe(true);
      expect(plan.bridgeUrl).toBeTruthy();
      expect(plan.expiresAt).toBeGreaterThan(Date.now());
    });

    it("仅传 dealName（authCode 缺省）也能生成 bridgeUrl，且不附加 ac 字段", () => {
      const plan = buildPayPlan({
        dealName: baseInput.dealName,
        bridgeBaseUrl: "https://example.com/b",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.dealName)).toBe(baseInput.dealName);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.authCode)).toBe(false);
    });

    it("authCode 传入时编入 ac 字段", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.authCode)).toBe(baseInput.authCode);
    });

    it("authCode 为空字符串时不附加 ac 字段（避免空 query 干扰）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        authCode: "",
        bridgeBaseUrl: "https://example.com/b",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.authCode)).toBe(false);
    });
  });

  describe("query 编码协议", () => {
    it("dealName / expiresAt 一定会写入 query", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/wx-pay-bridge",
      });

      const url = new URL(plan.bridgeUrl);
      expect(url.origin + url.pathname).toBe("https://example.com/wx-pay-bridge");
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.dealName)).toBe(baseInput.dealName);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.expiresAt)).toBe(String(plan.expiresAt));
    });

    it("passId 传入时编入 pid 字段（续费场景）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
        passId: "pass_2024_pro_001",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.passId)).toBe("pass_2024_pro_001");
    });

    it("passId 缺省时不附加 pid 字段（新购场景）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.passId)).toBe(false);
    });

    it("expiresAt 默认为 now + 9 分钟（前端 buffer：比后端 600s 短 1min）", () => {
      const before = Date.now();
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
      });
      const after = Date.now();
      const nineMin = 9 * 60 * 1000;
      expect(plan.expiresAt).toBeGreaterThanOrEqual(before + nineMin);
      expect(plan.expiresAt).toBeLessThanOrEqual(after + nineMin);
    });

    it("自定义 ttlMs 覆盖默认值", () => {
      const before = Date.now();
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
        ttlMs: 60_000,
      });
      const after = Date.now();
      expect(plan.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(plan.expiresAt).toBeLessThanOrEqual(after + 60_000);
    });
  });

  describe("sandbox 开关来源", () => {
    it("options.sandbox=true 时附加 sb=1", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
        sandbox: true,
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.sandbox)).toBe("1");
    });

    it("NEXT_PUBLIC_MIDAS_SANDBOX=true 时默认开启 sandbox", () => {
      vi.stubEnv("NEXT_PUBLIC_MIDAS_SANDBOX", "true");
      const plan = buildPayPlan({ ...baseInput, bridgeBaseUrl: "https://example.com/b" });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.sandbox)).toBe("1");
    });

    it("sandbox 未开启时不附加 sb 字段", () => {
      vi.stubEnv("NEXT_PUBLIC_MIDAS_SANDBOX", "false");
      const plan = buildPayPlan({ ...baseInput, bridgeBaseUrl: "https://example.com/b" });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.sandbox)).toBe(false);
    });
  });

  describe("bundleName 行为", () => {
    it("bundleName 传入时编入 query n 字段（中转页主标题展示）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
        bundleName: "专业版套餐",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.get(BRIDGE_QUERY_KEYS.bundleName)).toBe("专业版套餐");
    });

    it("bundleName 为空字符串时不附加 n 字段", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
        bundleName: "",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.bundleName)).toBe(false);
    });

    it("未传 bundleName 时不附加 n 字段（中转页走默认标题兜底）", () => {
      const plan = buildPayPlan({
        ...baseInput,
        bridgeBaseUrl: "https://example.com/b",
      });
      const url = new URL(plan.bridgeUrl);
      expect(url.searchParams.has(BRIDGE_QUERY_KEYS.bundleName)).toBe(false);
    });
  });

  describe("bridgeBaseUrl 解析优先级", () => {
    it("NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL 配置时被采用（未显式传 bridgeBaseUrl）", () => {
      vi.stubEnv("NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL", "https://env.example.com/bridge");
      const plan = buildPayPlan(baseInput);
      expect(plan.bridgeUrl.startsWith("https://env.example.com/bridge?")).toBe(true);
    });

    it("未配置环境变量时回退到 window.location.origin + /auth/wechat-pay", () => {
      vi.stubEnv("NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL", "");
      const plan = buildPayPlan(baseInput);
      const url = new URL(plan.bridgeUrl);
      expect(url.origin).toBe(window.location.origin);
      expect(url.pathname).toBe("/auth/wechat-pay");
    });

    it("显式传 bridgeBaseUrl 覆盖环境变量", () => {
      vi.stubEnv("NEXT_PUBLIC_WX_PAY_BRIDGE_BASE_URL", "https://env.example.com/bridge");
      const plan = buildPayPlan({ ...baseInput, bridgeBaseUrl: "https://override.example.com/b" });
      expect(plan.bridgeUrl.startsWith("https://override.example.com/b?")).toBe(true);
    });
  });

  describe("error 路径", () => {
    it("dealName 为空字符串抛错", () => {
      expect(() => buildPayPlan({ ...baseInput, dealName: "" })).toThrow(/dealName/);
    });
  });
});

describe("wx-pay / base64-url codec", () => {
  it("ASCII 字符串编解码互逆", () => {
    const raw = "https://mc.qq.com/payv2.html?token=E-AAA&pf=midas-pay-html5";
    expect(decodeBase64Url(encodeBase64Url(raw))).toBe(raw);
  });

  it("含中文 / Unicode 时仍可往返", () => {
    const raw = "https://example.com/pay?title=测试订单&tag=😀";
    expect(decodeBase64Url(encodeBase64Url(raw))).toBe(raw);
  });

  it("空字符串编解码均返回空", () => {
    expect(encodeBase64Url("")).toBe("");
    expect(decodeBase64Url("")).toBe("");
  });

  it("编码结果不含 base64 中容易在 URL 出问题的字符 (+ / =)", () => {
    /* 构造一个会产生 padding 与 + / 的输入 */
    const raw = "??>>>aaa+bbb/ccc=ddd<<<";
    const encoded = encodeBase64Url(raw);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeBase64Url(encoded)).toBe(raw);
  });
});
