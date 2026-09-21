// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import UniversalReport from "../../universal-report-adapter";

import { COOKIE_CONSENT_ACCEPTED, readStoredCookieConsent, type CookieConsentValue } from "../lib/cookie-consent";
import { REGION, type Region } from "../lib/region";

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
  // dev 模式上报开关：本地/预览环境显式打开后，即便非生产构建也允许初始化 SDK。
  readonly NEXT_PUBLIC_DATONG_DEV_ENABLED?: string;
  readonly VITE_DATONG_DEV_ENABLED?: string;
  // 部署环境标识：staging / production，区分预发与正式
  readonly NEXT_PUBLIC_APP_ENV?: string;
  readonly VITE_APP_ENV?: string;
  // 认证 API 地址，用于推断部署环境（staging 域名含 lightclaw）
  readonly NEXT_PUBLIC_AUTH_API_BASE_URL?: string;
  readonly VITE_AUTH_API_BASE_URL?: string;
};

// universal-report SDK 客户端类型 —— 采用宽松结构定义，仅暴露业务实际调用的成员，
// 便于与 SDK 内部私有实现解耦、方便后续版本升级。
//
// SDK reportEvent 的 IContext 没有 eid 字段，eid 需放在 businessParams.eid 里，
// SDK formatContext 从 businessParams.eid 提取并转为 dt_eid 放入 publicParams。
export type DatongClient = {
  reportEvent: (payload: {
    eventName: string;
    pgid?: string;
    businessParams?: Record<string, unknown>;
  }) => void;
  setPublicParams?: (params: Record<string, unknown>) => void;
  // startReport 刷新 waitReport 缓存的事件，开始真正上报
  startReport?: () => void;
};

export type DatongConfig = {
  appKey: string;
  region: Region;
  appEnv: string;
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
  // 来源追踪（1）—— SDK 初始化成功后立即上报，捕获外部渠道引流（discord/twitter/kol 等）
  LANDING_REFERRAL: "landing_referral",
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
  AGENT_ACHIEVEMENT: "agent_achievement",
} as const;

export type DatongPageId = (typeof DATONG_PAGE_IDS)[keyof typeof DATONG_PAGE_IDS];

/**
 * pgid → 中文页面名映射。
 *
 * dt_pgid 列存英文标识（与埋点计划一致），page_name 列存中文名（便于看板直接展示）。
 * 与 dt_tracking_plan/agent-platform-frontend-tracking-2026070211.md 的页面命名对齐。
 */
const PAGE_NAME_MAP: Record<string, string> = {
  home: "首页",
  about: "关于我们",
  changelog: "更新日志",
  docs: "文档中心",
  cookie_policy: "Cookie 政策",
  privacy_policy: "隐私政策",
  open_source_licenses: "开源许可",
  plans: "套餐选择页",
  plan_select: "套餐比对页",
  subscribe: "支付页",
  account: "账户中心",
  account_orders: "我的订单",
  agents_home: "Agent 首页",
  agent_creating: "Agent 创建向导",
  agent_workbench: "Agent 工作台",
  agent_chat: "Agent 会话页",
  agent_channels: "IM 通道页",
  agent_models: "模型配置页",
  agent_skills: "技能页",
  agent_persona: "人设页",
  agent_automations: "定时任务页",
  agent_memory: "记忆页",
  agent_files: "云存储页",
  agent_diagnostics: "诊断页",
  agent_achievement: "成就页",
};

/** 根据 pgid 解析中文页面名，未匹配时回退为 pgid 英文原值。 */
function resolvePageName(pgid: string | undefined): string | undefined {
  if (!pgid) return undefined;
  return PAGE_NAME_MAP[pgid] ?? pgid;
}

/**
 * eid → 中文元素名映射。
 *
 * dt_eid 列存英文标识（与埋点计划一致），ename 列存中文名（便于看板直接展示）。
 * 与 dt_tracking_plan/agent-platform-frontend-tracking-2026070211.md 的元素命名对齐。
 */
const ELEMENT_NAME_MAP: Record<string, string> = {
  // 首页
  header_create_now_btn: "顶栏创建按钮",
  hero_create_now_btn: "Hero区创建按钮",
  footer_create_now_btn: "底部创建按钮",
  header_login_btn: "顶栏登录按钮",
  header_docs_link: "顶栏文档入口",
  header_pricing_link: "顶栏定价入口",
  language_switcher_btn: "语言切换",
  // 套餐页
  plan_card: "套餐卡片",
  plan_select_btn: "选择套餐按钮",
  billing_period_toggle: "计费周期切换",
  // 支付页
  pay_now_btn: "立即支付按钮",
  // 账户页
  orders_entry_link: "订单入口",
  // Agent 首页
  agent_create_start_btn: "开始创建按钮",
  agent_create_confirm_btn: "确认创建按钮",
  agent_enter_console_btn: "进入控制台按钮",
  agent_restart_btn: "重启按钮",
  agent_delete_btn: "删除按钮",
  // Channels 页
  channel_guide_btn: "通道Guide按钮",
  channel_connect_btn: "通道Connect按钮",
  // Skills 页
  skills_search_input: "技能搜索框",
  skill_item_card: "技能卡片",
  skill_pack_card: "技能包卡片",
  // Persona 页
  persona_draw_btn: "人设抽取按钮",
  persona_confirm_btn: "添加此人设按钮",
  persona_select_card: "人设选择卡片",
  persona_inject_btn: "人设注入按钮",
  // Automations 页
  automation_template_card: "定时任务模板卡片",
  automation_create_btn: "添加定时任务按钮",
};

/** 根据 eid 解析中文元素名，未匹配时回退为 eid 英文原值。 */
function resolveElementName(eid: string | undefined): string | undefined {
  if (!eid) return undefined;
  return ELEMENT_NAME_MAP[eid] ?? eid;
}

/** 手动上报的业务参数值类型（避免上报对象/循环引用）。 */
export type DatongBusinessParamValue = string | number | boolean | null | undefined;
export type DatongBusinessParams = Record<string, DatongBusinessParamValue>;

let client: DatongClient | null = null;
let initPromise: Promise<DatongClient | null> | null = null;
let pendingUserId: string | undefined;
let identifiedUserId: string | undefined;
let activeRegion: Region | undefined;
let activeAppSurface = "lightvela-web";
let activeAppKey: string | undefined;
// waitReport 模式：SDK 初始化后事件缓存不上报，等用户身份确定后 startReport 刷新。
let reportStarted = false;

/**
 * URL 来源参数捕获 —— 首次进入站点时从 URL 读取 `from` 及标准 UTM 参数，
 * 存入 sessionStorage 避免站内跳转后丢失。后续每条事件都携带，便于按来源维度分析转化漏斗。
 *
 * 支持的 URL 参数：
 *   - from           : 业务自定义来源（discord / twitter / kol_xxx 等）
 *   - utm_source     : 标准 UTM 来源
 *   - utm_medium     : 标准 UTM 媒介
 *   - utm_campaign   : 标准 UTM 活动
 */
const REF_SOURCE_STORAGE_KEY = "lc_ref_source";
const REF_SOURCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

type RefSource = {
  ref_from?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  captured_at: number;
};

const readUrlParam = (search: string, key: string): string | undefined => {
  try {
    const params = new URLSearchParams(search);
    const value = params.get(key);
    return value?.trim() || undefined;
  } catch {
    return undefined;
  }
};

const captureRefSourceFromUrl = (): RefSource | null => {
  if (typeof window === "undefined") return null;
  const search = window.location.search;
  if (!search) return null;
  const ref_from = readUrlParam(search, "from");
  const utm_source = readUrlParam(search, "utm_source");
  const utm_medium = readUrlParam(search, "utm_medium");
  const utm_campaign = readUrlParam(search, "utm_campaign");
  if (!ref_from && !utm_source && !utm_medium && !utm_campaign) return null;
  return { ref_from, utm_source, utm_medium, utm_campaign, captured_at: Date.now() };
};

const loadStoredRefSource = (): RefSource | null => {
  try {
    const raw = sessionStorage.getItem(REF_SOURCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RefSource;
    if (!parsed.captured_at) return null;
    // 过期清理
    if (Date.now() - parsed.captured_at > REF_SOURCE_MAX_AGE_MS) {
      sessionStorage.removeItem(REF_SOURCE_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const storeRefSource = (source: RefSource) => {
  try {
    sessionStorage.setItem(REF_SOURCE_STORAGE_KEY, JSON.stringify(source));
  } catch {
    /* sessionStorage 不可用时静默降级 */
  }
};

/**
 * 解析当前来源参数：URL 有新参数时捕获并覆盖存储；否则读 sessionStorage 续用。
 * 返回值注入 publicParams，随每条事件下发。
 */
const resolveRefSource = (): Record<string, string> => {
  const fresh = captureRefSourceFromUrl();
  if (fresh) {
    storeRefSource(fresh);
  }
  const stored = fresh ?? loadStoredRefSource();
  if (!stored) return {};
  const params: Record<string, string> = {};
  if (stored.ref_from) params.ref_from = stored.ref_from;
  if (stored.utm_source) params.utm_source = stored.utm_source;
  if (stored.utm_medium) params.utm_medium = stored.utm_medium;
  if (stored.utm_campaign) params.utm_campaign = stored.utm_campaign;
  return params;
};

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
 * 读取 Next.js 端的 process.env。
 *
 * ⚠️ 必须直接静态引用 `process.env.NEXT_PUBLIC_*`，Next.js 的 DefinePlugin 才能在构建时
 * 把这些变量内联到客户端 bundle。通过 `globalThis.process?.env?.XXX` 间接访问会导致
 * DefinePlugin 静态分析匹配不到，变量不会被内联，浏览器端运行时读不到值。
 *
 * 与 aegis.ts / posthog.ts 保持一致的 `typeof process !== "undefined"` 内联三元写法。
 */
const readNextPublicEnv = (): DatongEnv => ({
  PROD: typeof process !== "undefined" ? process.env.PROD : undefined,
  NODE_ENV: typeof process !== "undefined" ? process.env.NODE_ENV : undefined,
  NEXT_PUBLIC_DATONG_ENABLED:
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DATONG_ENABLED : undefined,
  NEXT_PUBLIC_DATONG_APPKEY:
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DATONG_APPKEY : undefined,
  NEXT_PUBLIC_DATONG_DEV_ENABLED:
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_DATONG_DEV_ENABLED : undefined,
  NEXT_PUBLIC_APP_ENV:
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_APP_ENV : undefined,
  NEXT_PUBLIC_AUTH_API_BASE_URL:
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AUTH_API_BASE_URL : undefined,
  // VITE_AUTH_API_BASE_URL 通过 next.config.mjs env 桥接后可在客户端读取
  VITE_AUTH_API_BASE_URL:
    typeof process !== "undefined" ? process.env.VITE_AUTH_API_BASE_URL : undefined,
});

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
 *   1. 只在生产构建启用（NODE_ENV=production 或 PROD=true）；
 *      本地 dev 模式可显式打开 NEXT_PUBLIC_DATONG_DEV_ENABLED / VITE_DATONG_DEV_ENABLED 放行
 *   2. 全球站与国内站均启用（大同双区可用；PostHog 只在 global 启用）
 *   3. cookie consent 门禁仅国际站需要（GDPR/隐私合规）；国内站直接上报，dev 模式下跳过此门禁
 *   4. 需要显式打开 NEXT_PUBLIC_DATONG_ENABLED
 *   5. 需要提供 appKey（可从环境变量注入或走 fallback 常量）
 */
export function isDatongDevEnabled(env: DatongEnv = readDatongEnv()): boolean {
  return isTruthy(
    envValue(env, "NEXT_PUBLIC_DATONG_DEV_ENABLED", "VITE_DATONG_DEV_ENABLED"),
  );
}

/**
 * 推断部署环境标识（staging / production）。
 *
 * 优先级：
 *   1. 显式环境变量 NEXT_PUBLIC_APP_ENV / VITE_APP_ENV（release-matrix 注入）
 *   2. 从 AUTH_API_BASE_URL 推断（CI 构建脚本的通用标识）
 *      - 含 lightclaw → staging（预发域名）
 *      - 含 lightvela → production（正式域名）
 *   3. 默认 production
 */
function resolveAppEnv(env: DatongEnv): string {
  const explicit = envValue(env, "NEXT_PUBLIC_APP_ENV", "VITE_APP_ENV");
  if (explicit) return explicit.trim();

  const authUrl = envValue(env, "NEXT_PUBLIC_AUTH_API_BASE_URL", "VITE_AUTH_API_BASE_URL") ?? "";
  if (authUrl.includes("localhost") || authUrl.includes("127.0.0.1")) return "development";
  if (authUrl.includes("lightclaw")) return "staging";
  if (authUrl.includes("lightvela")) return "production";

  return "production";
}

export function resolveDatongConfig(
  env: DatongEnv = readDatongEnv(),
  region: Region = REGION,
  consent: CookieConsentValue | null = readStoredCookieConsent(),
): DatongConfig | null {
  const isProduction = isTruthy(env.PROD) || env.NODE_ENV === "production";
  const devEnabled = isDatongDevEnabled(env);
  // 非生产构建且未显式打开 dev 开关时，保持原行为（不初始化）
  if (!isProduction && !devEnabled) return null;
  // dev 模式下跳过 cookie consent 门禁，便于本地联调埋点
  // 国内站无需 cookie consent 门禁，直接上报；仅国际站（GDPR/隐私合规）需用户同意
  if (!devEnabled && region === "global" && consent !== COOKIE_CONSENT_ACCEPTED) return null;

  if (!isTruthy(envValue(env, "NEXT_PUBLIC_DATONG_ENABLED", "VITE_DATONG_ENABLED"))) {
    return null;
  }

  const appKey = envValue(env, "NEXT_PUBLIC_DATONG_APPKEY", "VITE_DATONG_APPKEY")?.trim();
  if (!appKey) return null;

  return {
    appKey,
    region,
    appEnv: resolveAppEnv(env),
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
      // 注意：大同平台 ETL 只解析预定义的公参字段（dt_ 前缀），app_region / app_site /
      // app_surface 等自定义 key 不会进入数据表列，因此同时也在 businessParams 里携带。

      //
      // 公参字段说明：
      //   - app_region  : "cn" / "global"，区分国内站与国际站
      //   - app_site    : "lightvela-cn" / "lightvela-global"，品牌+区域，便于看板直筛
      //   - app_surface : "lightvela-web"，前端 surface
      //   - app_env     : "staging" / "production"，区分预发与正式环境
      //   - ref_from    : URL ?from=xxx 捕获的来源（discord / twitter / kol_xxx）
      //   - utm_*       : 标准 UTM 参数
      const refSourceParams = resolveRefSource();
      const instance = new UniversalReport({
        beacon: config.appKey,
        publicParams: {
          app_region: config.region,
          app_site: `lightvela-${config.region}`,
          app_surface: activeAppSurface,
          app_env: config.appEnv,
          ...refSourceParams,
        },
        enableNoCodeTracking: config.enableNoCodeTracking,
        // 禁用 SDK 自动 PV 上报（initPage → reportPV），由 DatongPageEffect 手动管理
        // dt_pgin / dt_pgout，支持自定义 pgid 路由解析、私参、停留时长。
        isDisableInitPage: true,
        // waitReport: 事件缓存不上报，等 setDatongUser 确定 user_id 后 startReport 刷新。
        // 确保所有上报事件都携带 user_id，避免匿名事件丢失用户身份。
        waitReport: true,
      } as ConstructorParameters<typeof UniversalReport>[0]) as unknown as DatongClient;

      client = instance;
      activeRegion = config.region;
      activeAppKey = config.appKey;
      applyPendingUser();

      // 来源即时上报：SDK 初始化成功后，如果有 URL 来源参数（from / utm_*），
      // 立即发一条 landing_referral 事件。这样即使用户在当前页面就关闭离开，
      // 来源数据也已上报，不会因 cookie consent 延迟或未跳转而丢失。
      if (Object.keys(refSourceParams).length > 0) {
        client.reportEvent({
          eventName: DATONG_EVENTS.LANDING_REFERRAL,
          pgid: DATONG_PAGE_IDS.HOME,
          businessParams: {
            ...refSourceParams,
            page_name: resolvePageName(DATONG_PAGE_IDS.HOME),
          },
        });
      }

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
  // 用户身份确定后开启上报（flush waitReport 缓存的事件）
  startDatongReport();
}

/** 与 setPostHogUser 对称的用户身份注入。传 null/undefined 表示登出。 */
export function setDatongUser(userId: string | null | undefined): void {
  pendingUserId = userId || undefined;
  applyPendingUser();
}

/**
 * 开启上报：flush waitReport 缓存的事件。
 * 幂等，多次调用安全。由 setDatongUser（用户登录后）或 DatongTrackerBridge（authReady 后）触发。
 */
export function startDatongReport(): void {
  if (!client || reportStarted) return;
  reportStarted = true;
  client.startReport?.();
}

/** 关闭上报（cookie consent 撤回时调用）；保留 pendingUserId 供再次同意后 re-identify。 */
export function disableDatong(): void {
  identifiedUserId = undefined;
  client = null;
  initPromise = null;
  activeAppKey = undefined;
  reportStarted = false;
}

export function getDatong(): DatongClient | null {
  return client;
}

/**
 * 只读诊断快照 —— 用于现网验证 SDK 是否正常初始化、公参是否注入。
 *
 * 在浏览器控制台执行：
 *   __datongDebug()          // 打印诊断信息
 *   __datongDebug().ready    // true 表示 SDK 已初始化
 *
 * 不暴露 appKey 明文，只返回前 8 位 + 掩码。
 * 仅在浏览器环境挂载，SSR 安全。
 */
type DatongDebugSnapshot = {
  ready: boolean;
  region: string | undefined;
  appSite: string;
  appSurface: string;
  appKeyMasked: string;
  userId: string | undefined;
  hasRefSource: boolean;
  refFrom: string | undefined;
  envEnabled: boolean | undefined;
  envAppKeyPresent: boolean;
};

export function getDatongDebugSnapshot(): DatongDebugSnapshot {
  const env = readDatongEnv();
  const enabledVal = envValue(env, "NEXT_PUBLIC_DATONG_ENABLED", "VITE_DATONG_ENABLED");
  const appKeyVal = envValue(env, "NEXT_PUBLIC_DATONG_APPKEY", "VITE_DATONG_APPKEY");
  const stored = loadStoredRefSource();
  const appKey = activeAppKey ?? appKeyVal ?? "";
  return {
    ready: client !== null,
    region: activeRegion ?? REGION,
    appSite: `lightvela-${activeRegion ?? REGION}`,
    appSurface: activeAppSurface,
    appKeyMasked: appKey ? `${appKey.slice(0, 8)}****` : "(empty)",
    userId: identifiedUserId,
    hasRefSource: stored !== null,
    refFrom: stored?.ref_from,
    envEnabled: enabledVal ? isTruthy(enabledVal) : undefined,
    envAppKeyPresent: Boolean(appKeyVal),
  };
}

// 浏览器环境挂载到 window.__datongDebug，控制台可直接调用
if (typeof window !== "undefined") {
  (window as unknown as { __datongDebug?: () => DatongDebugSnapshot }).__datongDebug =
    getDatongDebugSnapshot;
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
    businessParams: {
      ...safeParams,
      eid: options?.eid,
      ename: resolveElementName(options?.eid),
      page_name: resolvePageName(options?.pgid),
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
  activeAppKey = undefined;
  activeAppSurface = "lightvela-web";
  reportStarted = false;
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
    businessParams: {
      ...safeParams,
      eid: options?.eid,
      ename: resolveElementName(options?.eid),
      page_name: resolvePageName(options?.pgid),
    },
  });
}
