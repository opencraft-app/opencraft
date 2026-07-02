import UniversalReport from "@tencent/universal-report";

import { COOKIE_CONSENT_ACCEPTED, readStoredCookieConsent, type CookieConsentValue } from "@/lib/cookie-consent";
import { REGION, type Region } from "@/lib/region";

// 大同 (universal-report) 前端埋点封装
//
// 与 posthog.ts / aegis.ts 并行，作为业务级埋点系统：
//   - PostHog：全球站产品分析（session/funnel）
//   - Aegis：APM / RUM 稳定性
//   - 大同 Datong：业务埋点（PV/UV、CTA、漏斗、自定义业务事件）
//
// SDK 文档：https://datong.woa.com

type DatongEnv = {
  readonly PROD?: boolean | string;
  readonly NODE_ENV?: string;
  readonly NEXT_PUBLIC_DATONG_ENABLED?: string;
  readonly NEXT_PUBLIC_DATONG_APPKEY?: string;
  readonly VITE_DATONG_ENABLED?: string;
  readonly VITE_DATONG_APPKEY?: string;
};

// universal-report SDK 客户端类型 —— 采用宽松结构定义，仅暴露业务实际调用的成员，
// 便于与 SDK 内部私有实现解耦、方便后续版本升级。
export type DatongClient = {
  reportEvent: (payload: {
    eventName: string;
    pgid?: string;
    eid?: string;
    businessParams?: Record<string, unknown>;
  }) => void;
  setPublicParams?: (params: Record<string, unknown>) => void;
};

export type DatongConfig = {
  appKey: string;
  region: Region;
  enableNoCodeTracking: boolean;
};

/**
 * 大同事件常量表 —— 与 dt_tracking_plan/agent-platform-frontend-tracking-2026070211.md
 * （已导入大同平台、batch 7915）严格对齐。所有手动上报事件必须走此枚举，杜绝拼写错误。
 *
 * 声明式埋点（dt_pgin/dt_pgout/dt_imp/dt_clck/dt_imp_end）由 SDK 自动上报，无需在此枚举；
 * 如 `agent_create_start`、`persona_draw` 等按钮点击走 `trackElement(...)` 上报 `dt_clck`。
 */
export const DATONG_EVENTS = {
  // 登录 / 认证（3）
  LOGIN_ATTEMPT: "login_attempt",
  LOGIN_SUCCESS: "login_success",
  LOGIN_FAIL: "login_fail",
  // 订阅漏斗（3）
  SUBSCRIBE_CHECKOUT_START: "subscribe_checkout_start",
  SUBSCRIBE_PAY_SUCCESS: "subscribe_pay_success",
  SUBSCRIBE_PAY_FAIL: "subscribe_pay_fail",
  // Agent 创建（2）
  AGENT_CREATE_SUCCESS: "agent_create_success",
  AGENT_CREATE_FAIL: "agent_create_fail",
  // Channel（1）
  CHANNEL_CONNECT_SUCCESS: "channel_connect_success",
  // Model 配置（4）
  MODEL_SWITCH: "model_switch",
  MODEL_PROVIDER_SELECT: "model_provider_select",
  MODEL_API_KEY_ADD: "model_api_key_add",
  MODEL_CUSTOM_ADD: "model_custom_add",
  // 技能 / 技能包（3）
  SKILL_SEARCH: "skill_search",
  SKILL_INSTALL_SUCCESS: "skill_install_success",
  SKILL_PACK_INSTALL_SUCCESS: "skill_pack_install_success",
  // Persona（2）
  PERSONA_INJECT_SUCCESS: "persona_inject_success",
  PERSONA_INJECT_FAIL: "persona_inject_fail",
  // Automation（2）
  AUTOMATION_CREATE_SUCCESS: "automation_create_success",
  AUTOMATION_DELETE: "automation_delete",
  // Memory（1）
  MEMORY_QUOTA_UPDATE: "memory_quota_update",
  // Diagnostics（1）
  DIAGNOSTICS_ACTION: "diagnostics_action",
  // Chat / North Star（2）
  AGENT_MESSAGE_SEND: "agent_message_send",
  AGENT_MESSAGE_FAIL: "agent_message_fail",
  // Docs 搜索（2）
  DOC_SEARCH: "doc_search",
  DOC_SEARCH_RESULT_CLICK: "doc_search_result_click",
} as const;

export type DatongEvent = (typeof DATONG_EVENTS)[keyof typeof DATONG_EVENTS];

/** 大同页面 ID 常量表 —— 用于声明式 dt-pgid 属性，避免字符串散落在业务代码中。 */
export const DATONG_PAGE_IDS = {
  // 公开站
  HOME: "home",
  ABOUT: "about",
  CHANGELOG: "changelog",
  DOCS: "docs",
  COOKIE_POLICY: "cookie_policy",
  PRIVACY_POLICY: "privacy_policy",
  OPEN_SOURCE_LICENSES: "open_source_licenses",
  // 订阅漏斗
  PLANS: "plans",
  PLAN_SELECT: "plan_select",
  SUBSCRIBE: "subscribe",
  // 账户
  ACCOUNT: "account",
  ACCOUNT_ORDERS: "account_orders",
  // Agent
  AGENTS_HOME: "agents_home",
  AGENT_CREATING: "agent_creating",
  AGENT_WORKBENCH: "agent_workbench",
  AGENT_CHAT: "agent_chat",
  AGENT_CHANNELS: "agent_channels",
  AGENT_MODELS: "agent_models",
  AGENT_SKILLS: "agent_skills",
  AGENT_PERSONA: "agent_persona",
  AGENT_AUTOMATIONS: "agent_automations",
  AGENT_MEMORY: "agent_memory",
  AGENT_FILES: "agent_files",
  AGENT_DIAGNOSTICS: "agent_diagnostics",
} as const;

export type DatongPageId = (typeof DATONG_PAGE_IDS)[keyof typeof DATONG_PAGE_IDS];

/** 手动上报的业务参数值类型（避免上报对象/循环引用）。 */
export type DatongBusinessParamValue = string | number | boolean | null | undefined;
export type DatongBusinessParams = Record<string, DatongBusinessParamValue>;

let client: DatongClient | null = null;
let initPromise: Promise<DatongClient | null> | null = null;
let pendingUserId: string | undefined;
let identifiedUserId: string | undefined;
let activeRegion: Region | undefined;
let activeAppSurface = "lightvela-web";

// 与 posthog.ts 保持同样的 PII 拦截约定：手动上报的 businessParams 中若命中这些 key 会被丢弃。
const PII_PROPERTY_KEYS = new Set([
  "address",
  "authorization",
  "birthday",
  "email",
  "full_name",
  "invite_code",
  "invitecode",
  "ip",
  "ip_address",
  "mobile",
  "name",
  "password",
  "phone",
  "phone_number",
  "real_name",
  "token",
  "user_email",
  "user_name",
]);

const isTruthy = (value: boolean | string | undefined): boolean => {
  if (typeof value === "boolean") return value;
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
};

const readImportMetaEnv = (): DatongEnv => {
  try {
    return import.meta.env ?? {};
  } catch {
    return {};
  }
};

/**
 * 安全读取 Next.js 端的 process.env（Vite 端无 process 全局）。
 * `globalThis` 在浏览器和 Node/Next 运行时均存在，通过宽松索引访问避免类型错误。
 */
const readNextPublicEnv = (): Pick<DatongEnv, "NEXT_PUBLIC_DATONG_ENABLED" | "NEXT_PUBLIC_DATONG_APPKEY" | "NODE_ENV"> => {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const env = g.process?.env ?? {};
  return {
    NEXT_PUBLIC_DATONG_ENABLED: env.NEXT_PUBLIC_DATONG_ENABLED,
    NEXT_PUBLIC_DATONG_APPKEY: env.NEXT_PUBLIC_DATONG_APPKEY,
    NODE_ENV: env.NODE_ENV,
  };
};

const readDatongEnv = (): DatongEnv => ({
  ...readImportMetaEnv(),
  ...readNextPublicEnv(),
});

const envValue = (
  env: DatongEnv,
  nextKey: keyof DatongEnv,
  viteKey: keyof DatongEnv,
): string | undefined => {
  const nextVal = env[nextKey];
  if (typeof nextVal === "string" && nextVal.trim()) return nextVal;
  const viteVal = env[viteKey];
  return typeof viteVal === "string" ? viteVal : undefined;
};

/**
 * 解析大同 SDK 生效条件。默认策略：
 *   1. 只在生产构建启用（NODE_ENV=production 或 PROD=true）
 *   2. 全球站与国内站均启用（大同双区可用；PostHog 只在 global 启用）
 *   3. 需通过 cookie consent
 *   4. 需要显式打开 NEXT_PUBLIC_DATONG_ENABLED
 *   5. 需要提供 appKey（可从环境变量注入或走 fallback 常量）
 */
export function resolveDatongConfig(
  env: DatongEnv = readDatongEnv(),
  region: Region = REGION,
  consent: CookieConsentValue | null = readStoredCookieConsent(),
): DatongConfig | null {
  const isProduction = isTruthy(env.PROD) || env.NODE_ENV === "production";
  if (!isProduction) return null;
  if (consent !== COOKIE_CONSENT_ACCEPTED) return null;

  if (!isTruthy(envValue(env, "NEXT_PUBLIC_DATONG_ENABLED", "VITE_DATONG_ENABLED"))) {
    return null;
  }

  const appKey = envValue(env, "NEXT_PUBLIC_DATONG_APPKEY", "VITE_DATONG_APPKEY")?.trim();
  if (!appKey) return null;

  return {
    appKey,
    region,
    enableNoCodeTracking: false,
  };
}

/**
 * 幂等地初始化大同 SDK。多次调用会复用同一 client / initPromise。
 * 采用 `@tencent/universal-report` 官方推荐写法：直接静态默认导入并 `new UniversalReport(...)`。
 * 保留 async 签名以兼容既有调用方（`datong-tracker-bridge` 里以 Promise 方式串联）。
 * 初始化失败一律降级为 no-op（不抛错），与 aegis.ts / posthog.ts 保持一致。
 */
export async function initDatong(
  env: DatongEnv = readDatongEnv(),
  region: Region = REGION,
  consent: CookieConsentValue | null = readStoredCookieConsent(),
): Promise<DatongClient | null> {
  if (client) {
    applyPendingUser();
    return client;
  }
  if (initPromise) return initPromise;

  const config = resolveDatongConfig(env, region, consent);
  if (!config) return null;
  initPromise = (async () => {
    try {
      // 全站公参：随每一条上报下发，构造时通过 `publicParams` 一次性注入。
      // 项目主登录方式为 email / google / wallet，非 QQ / 微信 / 微博，
      // 因此不传 accountInfo；用户身份统一走 setDatongUser -> setPublicParams({ user_id }) 通路。
      const instance = new UniversalReport({
        beacon: config.appKey,
        publicParams: {
          app_region: config.region,
          app_surface: activeAppSurface,
        },
        enableNoCodeTracking: config.enableNoCodeTracking,
      } as ConstructorParameters<typeof UniversalReport>[0]) as unknown as DatongClient;

      client = instance;
      activeRegion = config.region;
      applyPendingUser();
      return client;
    } catch (error: unknown) {
      console.warn("Failed to initialize Datong analytics", error);
      initPromise = null;
      return null;
    }
  })();

  return initPromise;
}

function applyPendingUser(): void {
  if (!client) return;
  if (!pendingUserId) {
    if (identifiedUserId) {
      client.setPublicParams?.({ user_id: undefined });
      identifiedUserId = undefined;
    }
    return;
  }
  if (identifiedUserId === pendingUserId) return;
  client.setPublicParams?.({ user_id: pendingUserId });
  identifiedUserId = pendingUserId;
}

/** 与 setPostHogUser 对称的用户身份注入。传 null/undefined 表示登出。 */
export function setDatongUser(userId: string | null | undefined): void {
  pendingUserId = userId || undefined;
  applyPendingUser();
}

/** 关闭上报（cookie consent 撤回时调用）；保留 pendingUserId 供再次同意后 re-identify。 */
export function disableDatong(): void {
  identifiedUserId = undefined;
  client = null;
  initPromise = null;
}

export function getDatong(): DatongClient | null {
  return client;
}

function sanitizeBusinessParams(params: DatongBusinessParams | undefined): DatongBusinessParams | undefined {
  if (!params) return undefined;
  const safe: DatongBusinessParams = {};
  let dropped = false;
  for (const [key, value] of Object.entries(params)) {
    const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
    if (PII_PROPERTY_KEYS.has(normalized) || normalized.endsWith("_token")) {
      dropped = true;
      continue;
    }
    safe[key] = value;
  }
  if (dropped) {
    console.warn("Dropped unsafe Datong business param key");
  }
  return safe;
}

/**
 * 手动上报业务事件。
 *
 * 使用场景：与页面/元素**无直接关联**的业务事件（如 subscribe_success、agent_create_success）。
 * 页面级和元素级事件请使用声明式标签埋点（dt-pgid / dt-eid），由 SDK 自动上报，避免走本函数。
 *
 * PII 保护：会自动过滤掉 email/phone/token 等敏感字段。传入前 caller 也应自查。
 */
export function reportDatongEvent(
  eventName: DatongEvent,
  options?: {
    pgid?: DatongPageId;
    eid?: string;
    businessParams?: DatongBusinessParams;
  },
): void {
  if (!client) return;
  const safeParams = sanitizeBusinessParams(options?.businessParams);
  client.reportEvent({
    eventName,
    pgid: options?.pgid,
    eid: options?.eid,
    businessParams: {
      ...safeParams,
      app_region: activeRegion ?? REGION,
      app_surface: activeAppSurface,
    },
  });
}

/** 单元测试专用重置。生产代码禁止调用。 */
export function resetDatongForTest(): void {
  client = null;
  initPromise = null;
  pendingUserId = undefined;
  identifiedUserId = undefined;
  activeRegion = undefined;
  activeAppSurface = "lightvela-web";
}

/** SDK 保留的事件名（非业务自定义），与业务事件常量分离维护。 */
export const DATONG_PAGE_EVENTS = {
  PAGE_IN: "dt_pgin",
  PAGE_OUT: "dt_pgout",
  ELEMENT_CLICK: "dt_clck",
  ELEMENT_IMPRESSION: "dt_imp",
  ELEMENT_IMPRESSION_END: "dt_imp_end",
} as const;

export type DatongPageEventName = (typeof DATONG_PAGE_EVENTS)[keyof typeof DATONG_PAGE_EVENTS];

/**
 * 上报 SDK 保留事件（`dt_pgin` / `dt_pgout` / `dt_clck` / `dt_imp` / `dt_imp_end`）。
 *
 * 与 `reportDatongEvent` 的区别：
 *   - `reportDatongEvent`：面向 30 个业务事件常量（DATONG_EVENTS 枚举）
 *   - `reportDatongPageEvent`：仅供 DatongPageEffect / trackDatongClick 等公共 helper 调用
 *
 * 对未初始化的 SDK 是 no-op；同样会应用 PII 过滤。
 */
export function reportDatongPageEvent(
  eventName: DatongPageEventName,
  options?: {
    pgid?: DatongPageId;
    eid?: string;
    businessParams?: DatongBusinessParams;
  },
): void {
  if (!client) return;
  const safeParams = sanitizeBusinessParams(options?.businessParams);
  client.reportEvent({
    eventName,
    pgid: options?.pgid,
    eid: options?.eid,
    businessParams: {
      ...safeParams,
      app_region: activeRegion ?? REGION,
      app_surface: activeAppSurface,
    },
  });
}
