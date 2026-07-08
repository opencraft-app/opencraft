import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COOKIE_CONSENT_ACCEPTED, type CookieConsentValue } from "@/lib/cookie-consent";

// Mock cookie-consent module
vi.mock("@/lib/cookie-consent", () => ({
  COOKIE_CONSENT_ACCEPTED: "accepted" as CookieConsentValue,
  COOKIE_CONSENT_NECESSARY: "necessary" as CookieConsentValue,
  COOKIE_CONSENT_CHANGED_EVENT: "cookie-consent-changed",
  readStoredCookieConsent: vi.fn((): CookieConsentValue | null => null),
}));

// Mock region
vi.mock("@/lib/region", () => ({
  REGION: "cn" as const,
  isCN: true,
  isGlobal: false,
  DEFAULT_LOCALE: "zh-CN" as const,
}));

// Mock UniversalReport SDK —— vi.hoisted 确保 mock 函数在 vi.mock factory 执行前可用
const { mockReportEvent, mockSetPublicParams, mockSetAccountInfo, mockStartReport } = vi.hoisted(() => ({
  mockReportEvent: vi.fn(),
  mockSetPublicParams: vi.fn(),
  mockSetAccountInfo: vi.fn(),
  mockStartReport: vi.fn(),
}));

vi.mock("@tencent/universal-report", () => {
  return {
    default: class MockUniversalReport {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
      reportEvent = mockReportEvent;
      setPublicParams = mockSetPublicParams;
      setAccountInfo = mockSetAccountInfo;
      startReport = mockStartReport;
    },
  };
});

import {
  initDatong,
  resolveDatongConfig,
  reportDatongEvent,
  reportDatongPageEvent,
  setDatongUser,
  startDatongReport,
  disableDatong,
  getDatong,
  resetDatongForTest,
  DATONG_EVENTS,
  DATONG_PAGE_IDS,
  DATONG_PAGE_EVENTS,
} from "@/observability/datong";
import { trackDatongClick, trackDatongEvent } from "@/observability/datong-tracker";

const PROD_ENV = {
  PROD: "true",
  NODE_ENV: "production",
  NEXT_PUBLIC_DATONG_ENABLED: "true",
  NEXT_PUBLIC_DATONG_APPKEY: "0WEB071LS3218EU7",
};

describe("大同埋点全链路模拟上报", () => {
  beforeEach(() => {
    resetDatongForTest();
    mockReportEvent.mockClear();
    mockSetPublicParams.mockClear();
    mockSetAccountInfo.mockClear();
    mockStartReport.mockClear();
    // 模拟 sessionStorage
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    });
    // 模拟 URL 无来源参数
    vi.stubGlobal("location", {
      search: "",
      pathname: "/",
    });
  });

  afterEach(() => {
    resetDatongForTest();
    vi.unstubAllGlobals();
  });

  describe("1. SDK 初始化门禁", () => {
    it("非生产构建不初始化", async () => {
      const config = resolveDatongConfig(
        { NODE_ENV: "development", NEXT_PUBLIC_DATONG_ENABLED: "true", NEXT_PUBLIC_DATONG_APPKEY: "0WEB071LS3218EU7" } as never,
        "cn",
        "accepted" as CookieConsentValue,
      );
      expect(config).toBeNull();
    });

    it("非生产构建但显式打开 dev 开关 → 初始化成功", async () => {
      const config = resolveDatongConfig(
        {
          NODE_ENV: "development",
          NEXT_PUBLIC_DATONG_ENABLED: "true",
          NEXT_PUBLIC_DATONG_APPKEY: "0WEB071LS3218EU7",
          NEXT_PUBLIC_DATONG_DEV_ENABLED: "true",
        } as never,
        "cn",
        "accepted" as CookieConsentValue,
      );
      expect(config).toEqual({
        appKey: "0WEB071LS3218EU7",
        region: "cn",
        enableNoCodeTracking: false,
      });
    });

    it("dev 开关打开但 appKey 缺失 → 仍不初始化", async () => {
      const config = resolveDatongConfig(
        {
          NODE_ENV: "development",
          NEXT_PUBLIC_DATONG_ENABLED: "true",
          NEXT_PUBLIC_DATONG_APPKEY: undefined,
          NEXT_PUBLIC_DATONG_DEV_ENABLED: "true",
        } as never,
        "cn",
        "accepted" as CookieConsentValue,
      );
      expect(config).toBeNull();
    });

    it("dev 开关打开 + cookie consent 未同意 → 仍初始化（跳过 consent 门禁）", async () => {
      const config = resolveDatongConfig(
        {
          NODE_ENV: "development",
          NEXT_PUBLIC_DATONG_ENABLED: "true",
          NEXT_PUBLIC_DATONG_APPKEY: "0WEB071LS3218EU7",
          NEXT_PUBLIC_DATONG_DEV_ENABLED: "true",
        } as never,
        "cn",
        null,
      );
      expect(config).toEqual({
        appKey: "0WEB071LS3218EU7",
        region: "cn",
        enableNoCodeTracking: false,
      });
    });

    it("cookie consent 未同意不初始化", async () => {
      const config = resolveDatongConfig(PROD_ENV as never, "cn", null);
      expect(config).toBeNull();
    });

    it("enabled=false 不初始化", async () => {
      const config = resolveDatongConfig(
        { ...PROD_ENV, NEXT_PUBLIC_DATONG_ENABLED: "false" } as never,
        "cn",
        "accepted" as CookieConsentValue,
      );
      expect(config).toBeNull();
    });

    it("appKey 缺失不初始化", async () => {
      const config = resolveDatongConfig(
        { ...PROD_ENV, NEXT_PUBLIC_DATONG_APPKEY: undefined } as never,
        "cn",
        "accepted" as CookieConsentValue,
      );
      expect(config).toBeNull();
    });

    it("全部门禁通过 → 初始化成功", async () => {
      const config = resolveDatongConfig(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      expect(config).toEqual({
        appKey: "0WEB071LS3218EU7",
        region: "cn",
        enableNoCodeTracking: false,
      });
    });
  });

  describe("2. SDK 初始化 + 公参注入", () => {
    it("初始化后 client 可用，公参包含 app_region/app_site/app_surface", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      expect(getDatong()).not.toBeNull();
    });

    it("setDatongUser 调用 setPublicParams 注入 user_id", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      setDatongUser("usr_12345");
      expect(mockSetPublicParams).toHaveBeenCalledWith({ user_id: "usr_12345" });
    });

    it("waitReport 模式：initDatong 后不自动 startReport", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      expect(mockStartReport).not.toHaveBeenCalled();
    });

    it("waitReport 模式：setDatongUser 注入 user_id 后触发 startReport", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      setDatongUser("usr_12345");
      expect(mockStartReport).toHaveBeenCalledTimes(1);
    });

    it("waitReport 模式：startDatongReport 幂等，多次调用不重复", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      setDatongUser("usr_12345");
      startDatongReport();
      startDatongReport();
      expect(mockStartReport).toHaveBeenCalledTimes(1);
    });

    it("disableDatong 清除 client", async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
      expect(getDatong()).not.toBeNull();
      disableDatong();
      expect(getDatong()).toBeNull();
    });
  });

  describe("3. 业务事件上报（核心链路）", () => {
    beforeEach(async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
    });

    it("login_success 上报正确事件名和参数", () => {
      reportDatongEvent(DATONG_EVENTS.LOGIN_SUCCESS, {
        businessParams: { method: "google" },
      });

      expect(mockReportEvent).toHaveBeenCalledTimes(1);
      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("login_success");
      expect(call.businessParams.method).toBe("google");
    });

    it("subscribe_pay_success 上报正确事件名和参数", () => {
      reportDatongEvent(DATONG_EVENTS.SUBSCRIBE_PAY_SUCCESS, {
        pgid: DATONG_PAGE_IDS.SUBSCRIBE,
        businessParams: { plan: "pro", order_id: "ord_123" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("subscribe_pay_success");
      expect(call.pgid).toBe("subscribe");
      expect(call.businessParams.plan).toBe("pro");
      expect(call.businessParams.order_id).toBe("ord_123");
    });

    it("agent_message_send (North Star) 上报正确", () => {
      reportDatongEvent(DATONG_EVENTS.AGENT_MESSAGE_SEND, {
        pgid: DATONG_PAGE_IDS.AGENT_CHAT,
        businessParams: { bot_id: "bot_1", msg_len: 42, session_id: "sess_1" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("agent_message_send");
      expect(call.pgid).toBe("agent_chat");
      expect(call.businessParams.bot_id).toBe("bot_1");
      expect(call.businessParams.msg_len).toBe(42);
    });

    it("trackDatongEvent 便捷 API 正确转发", () => {
      trackDatongEvent(DATONG_EVENTS.AGENT_CREATE_SUCCESS, {
        pgid: DATONG_PAGE_IDS.AGENT_CREATING,
        params: { bot_id: "bot_new", create_duration_ms: 1200 },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("agent_create_success");
      expect(call.pgid).toBe("agent_creating");
      expect(call.businessParams.bot_id).toBe("bot_new");
      expect(call.businessParams.create_duration_ms).toBe(1200);
    });
  });

  describe("4. eid 正确放入 businessParams（关键修复验证）", () => {
    beforeEach(async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
    });

    it("trackDatongClick: eid 在 pageParams.eid 中，不在顶层", () => {
      trackDatongClick("header_create_now_btn", {
        pgid: DATONG_PAGE_IDS.HOME,
        params: { has_bots: false, target: "/agents" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("dt_clck");
      expect(call.pgid).toBe("home");
      // 关键断言：eid 必须在 pageParams 中
      expect(call.pageParams.eid).toBe("header_create_now_btn");
      // 顶层不应有 eid 字段
      expect(call.eid).toBeUndefined();
      // 其他参数也保留
      expect(call.pageParams.has_bots).toBe(false);
      expect(call.pageParams.target).toBe("/agents");
    });

    it("reportDatongPageEvent: dt_imp 事件的 eid 在 pageParams.eid", () => {
      reportDatongPageEvent(DATONG_PAGE_EVENTS.ELEMENT_IMPRESSION, {
        pgid: DATONG_PAGE_IDS.PLANS,
        eid: "plan_card",
        businessParams: { plan: "pro", billing_period: "monthly" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("dt_imp");
      expect(call.pgid).toBe("plans");
      expect(call.pageParams.eid).toBe("plan_card");
      expect(call.eid).toBeUndefined();
      expect(call.pageParams.plan).toBe("pro");
    });

    it("reportDatongPageEvent: dt_clck 事件的 eid 在 pageParams.eid", () => {
      reportDatongPageEvent(DATONG_PAGE_EVENTS.ELEMENT_CLICK, {
        pgid: DATONG_PAGE_IDS.SUBSCRIBE,
        eid: "pay_now_btn",
        businessParams: { plan: "pro", pay_channel: "wechat" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.eventName).toBe("dt_clck");
      expect(call.pageParams.eid).toBe("pay_now_btn");
      expect(call.eid).toBeUndefined();
    });
  });

  describe("5. PII 过滤", () => {
    beforeEach(async () => {
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);
    });

    it("email 字段被过滤", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      reportDatongEvent(DATONG_EVENTS.LOGIN_SUCCESS, {
        businessParams: { method: "google", email: "test@example.com" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.businessParams.email).toBeUndefined();
      expect(call.businessParams.method).toBe("google");
      expect(warnSpy).toHaveBeenCalledWith("Dropped unsafe Datong business param key");
      warnSpy.mockRestore();
    });

    it("token 字段被过滤", () => {
      reportDatongEvent(DATONG_EVENTS.LOGIN_SUCCESS, {
        businessParams: { method: "google", access_token: "secret123" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.businessParams.access_token).toBeUndefined();
    });

    it("phone_number 字段被过滤", () => {
      reportDatongEvent(DATONG_EVENTS.LOGIN_SUCCESS, {
        businessParams: { method: "google", phone_number: "13800138000" },
      });

      const call = mockReportEvent.mock.calls[0][0];
      expect(call.businessParams.phone_number).toBeUndefined();
    });
  });

  describe("6. URL 来源捕获", () => {
    it("URL 含 ?from=discord 时捕获 ref_from", async () => {
      vi.stubGlobal("location", { search: "?from=discord", pathname: "/" });
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);

      // landing_referral 事件应被立即上报
      const refCall = mockReportEvent.mock.calls.find(
        (c) => c[0].eventName === "landing_referral",
      );
      expect(refCall).toBeDefined();
      expect(refCall[0].businessParams.ref_from).toBe("discord");
    });

    it("URL 含 utm_* 参数时捕获", async () => {
      vi.stubGlobal("location", {
        search: "?utm_source=google&utm_medium=cpc&utm_campaign=summer",
        pathname: "/",
      });
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);

      const refCall = mockReportEvent.mock.calls.find(
        (c) => c[0].eventName === "landing_referral",
      );
      expect(refCall).toBeDefined();
      expect(refCall[0].businessParams.utm_source).toBe("google");
      expect(refCall[0].businessParams.utm_medium).toBe("cpc");
      expect(refCall[0].businessParams.utm_campaign).toBe("summer");
    });

    it("URL 无来源参数时不发 landing_referral", async () => {
      vi.stubGlobal("location", { search: "", pathname: "/" });
      await initDatong(PROD_ENV as never, "cn", "accepted" as CookieConsentValue);

      const refCall = mockReportEvent.mock.calls.find(
        (c) => c[0].eventName === "landing_referral",
      );
      expect(refCall).toBeUndefined();
    });
  });

  describe("7. SDK 未初始化时为 no-op", () => {
    it("reportDatongEvent 不抛错", () => {
      expect(() => {
        reportDatongEvent(DATONG_EVENTS.LOGIN_SUCCESS, {
          businessParams: { method: "google" },
        });
      }).not.toThrow();
      expect(mockReportEvent).not.toHaveBeenCalled();
    });

    it("trackDatongClick 不抛错", () => {
      expect(() => {
        trackDatongClick("test_btn", {
          pgid: DATONG_PAGE_IDS.HOME,
          params: {},
        });
      }).not.toThrow();
      expect(mockReportEvent).not.toHaveBeenCalled();
    });
  });
});
