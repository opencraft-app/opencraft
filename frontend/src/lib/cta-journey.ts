/**
 * 用户链路分流 — 登录按钮 / Hero CTA / Footer CTA 的唯一判断源。
 *
 * 需求：issue #73 —— 登录按钮与 Hero/Footer CTA 按订阅状态分流（国内站 + 国际站）。
 *
 * 红线（PRD：wiki/prd-docs/2026-09-14-user-journey-cta-login-redirect.md）：
 * - 订阅前统一走 /subscribe（未登录、已登录未订阅都一样）；
 * - 订阅后统一走 /agents（已有 Agent 进控制台，无 Agent 时打开创建向导）；
 * - 登录成功后必须按订阅状态分流：未订阅去 /subscribe，已订阅去 /agents；
 * - Hero CTA 与 Footer CTA 必须一致：同状态下文案一致、路径一致；
 * - 国内站与国际站逻辑一致，只做语言差异，不做路径差异。
 */

import {
  AGENTS_HOME_PATH,
  SUBSCRIBE_PATH,
  getAgentCreateBotPath,
} from "@/lib/agent-routes";
import {
  publicSiteHref,
  type PublicSiteLocale,
} from "@/lib/public-site-navigation";

/** 用户链路判断所需的账号状态快照。 */
export type JourneyState = {
  isAuthenticated: boolean;
  isSubscribed: boolean;
  hasBots: boolean;
  /**
   * 历史上是否成功创建过 Bot（删光 Bot 的老用户也是 true）。
   * 后端账号级字段缺失前由 `hasEverCreatedBot()` 本地标记兜底，不传时退化为只看 hasBots。
   */
  hasCreatedBot?: boolean;
};

/** 已登录用户的订阅态（登录成功分流只取决于它）。 */
export type SubscriptionState = Pick<JourneyState, "isSubscribed" | "hasBots" | "hasCreatedBot">;

/** 链路落点：订阅页 / 控制台 / 首个 Bot 创建向导（已订阅但尚无 Agent）。 */
export type JourneyRoute = "subscribe" | "agents" | "agents-creating";

/**
 * 落点常量（工蜂 AI CR 建议：避免魔法字符串）。
 * 测试与调用方应引用这些常量，而不是直接写 "subscribe" / "agents" / "agents-creating" 字面量。
 */
export const JOURNEY_ROUTE = {
  SUBSCRIBE: "subscribe",
  AGENTS: "agents",
  AGENTS_CREATING: "agents-creating",
} as const satisfies Record<string, JourneyRoute>;

/**
 * 已订阅后的落点：
 * 已有 Agent、或历史上创建过 Agent（现在被删光也算）→ 控制台；
 * 只有从未创建过的人才进 /agents 的创建流程。
 */
export const resolveSubscribedRoute = (
  hasBots: boolean,
  hasCreatedBot = false,
): JourneyRoute =>
  hasBots || hasCreatedBot ? JOURNEY_ROUTE.AGENTS : JOURNEY_ROUTE.AGENTS_CREATING;

/**
 * 登录成功分流：
 * - 未订阅 → /subscribe
 * - 已订阅 → /agents（从未创建过时进 /agents 的创建流程）
 */
export const resolvePostLoginRoute = ({
  isSubscribed,
  hasBots,
  hasCreatedBot,
}: SubscriptionState): JourneyRoute =>
  isSubscribed ? resolveSubscribedRoute(hasBots, hasCreatedBot) : JOURNEY_ROUTE.SUBSCRIBE;

/**
 * CTA 分流（Hero / Footer 共用）：
 * - 未登录、已登录未订阅 → /subscribe
 * - 已登录且已订阅 → /agents
 */
export const resolveCtaRoute = ({
  isAuthenticated,
  isSubscribed,
  hasBots,
  hasCreatedBot,
}: JourneyState): JourneyRoute =>
  isAuthenticated && isSubscribed
    ? resolveSubscribedRoute(hasBots, hasCreatedBot)
    : JOURNEY_ROUTE.SUBSCRIBE;

/** 落点转 href：国际站按语种前缀本地化，国内站保持原路径（双站只差语言）。 */
export const journeyHref = (
  route: JourneyRoute,
  locale: PublicSiteLocale,
  options: { localized?: boolean } = {},
): string => {
  switch (route) {
    case JOURNEY_ROUTE.SUBSCRIBE:
      return publicSiteHref(SUBSCRIBE_PATH, locale, options);
    case JOURNEY_ROUTE.AGENTS_CREATING:
      // 无 Bot 表示需要先创建；creating 只用于等待已经发起创建的实例。
      return publicSiteHref(getAgentCreateBotPath(), locale, options);
    default:
      return publicSiteHref(AGENTS_HOME_PATH, locale, options);
  }
};

export type CtaCopyKey = "startFree" | "myCompanion";

/** CTA 文案状态：已登录且已订阅 →「我的智能体伙伴」，其余（含未登录）→「免费试用」。 */
export const resolveCtaCopyKey = ({
  isAuthenticated,
  isSubscribed,
}: Pick<JourneyState, "isAuthenticated" | "isSubscribed">): CtaCopyKey =>
  isAuthenticated && isSubscribed ? "myCompanion" : "startFree";

/**
 * CTA 文案兜底表 —— 仅当静态片段里取不到官方译文时使用（例如片段没有对应按钮、单测夹具为空）。
 * 真实页面的文案优先由 `international-home-runtime` 从静态片段里读取，见那里的说明。
 *
 * 表内译文逐条对照既有权威来源核实，不是自行翻译。三个来源按优先级：
 * 1. 首页静态片段 `public/lightvela-intl-home/index-fragment.<locale>.html`
 *    里该 CTA 按钮已经渲染出来的官方译文（本 runtime 替换的就是这个按钮，
 *    必须跟页面既有译文保持一致）；
 * 2. `scripts/import-international-homepage.mjs` 的 `"Free trial"` /
 *    `"My AI Companion"` 映射表（片段译文的产出来源，非 zh 语种取自这里）；
 * 3. 官方 i18n 词典 `src/i18n/generated/*.json` 的 `k_248f81e2`（免费试用）/
 *    `k_2519dfba`（我的智能体伙伴），仅 zh-CN / zh-Hant 的 `startFree` 取自这里：
 *    中文文案由需求给定为「免费试用」。
 *
 * 英文 CTA 文案为 `Free trial`（与 en-US 片段按钮一致），各语种沿用 import 脚本里
 * 对应的官方译文（非英语显示值不随英文调整而变）。
 *
 * 改动这张表前，先跑一遍核对映射是否已更新，避免跟 import 脚本再次分叉：
 * `grep -n '"Free trial":\|"My AI Companion":' frontend/scripts/import-international-homepage.mjs`
 * `grep -rn 'k_248f81e2\|k_2519dfba' frontend/src/i18n/generated/`
 *
 * 英文统一 `Free trial` / `My AI Companion`，不得出现一处大写一处小写。
 */
export const CTA_COPY_BY_LOCALE: Record<
  PublicSiteLocale,
  Record<CtaCopyKey, string>
> = {
  "en-US": { startFree: "Free trial", myCompanion: "My AI Companion" },
  "zh-CN": { startFree: "免费试用", myCompanion: "我的智能体伙伴" },
  "zh-SG": { startFree: "免费试用", myCompanion: "我的智能体伙伴" },
  "zh-Hant": { startFree: "免費試用", myCompanion: "我的智能體夥伴" },
  "id-ID": { startFree: "Mulai gratis", myCompanion: "Pendamping AI saya" },
  es: { startFree: "Empieza gratis", myCompanion: "Mi compañero de IA" },
  "ja-JP": { startFree: "無料で開始", myCompanion: "私のAIパートナー" },
  "ko-KR": { startFree: "무료 시작", myCompanion: "내 AI 파트너" },
};

/** 兜底表里最终一定存在的字面量，防止 `en-US` 条目本身也缺失时仍返回 `undefined`。 */
const FALLBACK_COPY: Record<CtaCopyKey, string> = {
  startFree: "Free trial",
  myCompanion: "My AI Companion",
};

/**
 * 按可选链访问文案表：`locale` 理论上只会是 `PublicSiteLocale` 联合类型的合法值，
 * 但类型收窄不能保证运行时一定命中（例如新增语种时表和类型没有同步更新），
 * 回退到 `en-US` 时同样使用可选链访问 —— `en-US` 条目理论上必定存在，但表结构可能被
 * 后续改动破坏，仍需防御式访问，最终用 `FALLBACK_COPY` 兜底，
 * 确保任何情况下都返回字符串，不会是 `undefined`（工蜂 AI CR 边界条件建议）。
 */
export const getCtaCopy = (
  locale: PublicSiteLocale,
  state: Pick<JourneyState, "isAuthenticated" | "isSubscribed">,
): string => {
  const key = resolveCtaCopyKey(state);
  return (
    CTA_COPY_BY_LOCALE[locale]?.[key] ??
    CTA_COPY_BY_LOCALE["en-US"]?.[key] ??
    FALLBACK_COPY[key]
  );
};
