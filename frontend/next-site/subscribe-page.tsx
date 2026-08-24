import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowRight, Check, User, Monitor, Clock, HardDrive, Settings, Zap, Sparkles, X, Loader2, Wifi, CalendarClock, Puzzle, MessageSquare, Brain, UserCog, Stethoscope, Cpu, CreditCard, RefreshCw } from "lucide-react";
import React, { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useOpenClaw } from "@/contexts/agent-context";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import {
  usePaidBillingEnabled,
  useRealnamePhoneVerificationEnabled,
} from "@/contexts/runtime-config-context";
import { InviteCodeModal, LoginModal } from "@/components/site/login-modal";
import { RepositoryError } from "@/repositories/http-repositories";
import type { Bundle, BundlePrice, BundleDescriptionEntry } from "@/domain/types";
import { REALNAME_LEVEL } from "@/domain/types";
import { useT } from "@/i18n/t";
import { AppLink, useAppNavigate } from "@/lib/app-navigation";
import { isCN, isGlobal } from "@/lib/region";
import { isPaidBillingEnabled, formatYuan, centsToYuan } from "@/lib/billing-flow";
import {
  resolveBillingErrorMessage,
  getBillingErrorCode,
  isPassConflictError,
  isPassRequiresRenewError,
} from "@/lib/billing-error";
import { buildPayPlan } from "@/lib/wx-pay";
import { ACCOUNT_PATH, getAgentCreatingPath, REALNAME_REQUIRED_QUERY_KEY, SUBSCRIBE_PATH } from "@/lib/agent-routes";
import { captureProductEvent, PRODUCT_ANALYTICS_EVENTS } from "@/observability/posthog";
import { trackDatongClick, trackDatongEvent } from "@/observability/datong-tracker";
import { DATONG_EVENTS, DATONG_PAGE_IDS } from "@/observability/datong";
import { QRCodeSVG } from "qrcode.react";

/* ─── Notion DESIGN.md Tokens ─── */

const colors = {
  black: "rgba(0,0,0,0.95)",
  white: "#ffffff",
  primary: "rgba(0,0,0,0.90)",
  primaryHover: "rgba(0,0,0,0.75)",
  warmWhite: "#f6f5f4",
  warmGray500: "#615d59",
  warmGray300: "#a39e98",
  border: "rgba(0,0,0,0.1)",
  badgeBg: "rgba(0,0,0,0.04)",
  badgeText: "rgba(0,0,0,0.75)",
  /* Tooltip（免费试用提示等）配色，集中管理避免散落硬编码 */
  tooltipBg: "rgba(23,23,23,0.92)",
  tooltipShadow: "0 4px 16px rgba(0,0,0,0.18)",
};

/* ─── 套餐识别常量（避免魔法字符串） ─── */
/** 启航版套餐名匹配关键字（后端可能返回「启航」中文名或「launch」英文名） */
const LAUNCH_BUNDLE_NAME_KEYWORDS = {
  zh: "启航",
  en: "launch",
} as const;
/** AI 增强版套餐类型标识（国际站启航 AI 对新用户提供 3 天免费，巡游 AI 为首购折扣） */
const BUNDLE_TYPE_AI = "ai";
/** 巡游版套餐名匹配关键字（后端可能返回「巡游」中文名或「cruise」英文名） */
const CRUISE_BUNDLE_NAME_KEYWORDS = {
  zh: "巡游",
  en: "cruise",
} as const;
const CN_REFUND_RULES_PATH = "/docs/plans/#%E9%80%80%E6%AC%BE%E8%A7%84%E5%88%99";

/** 按套餐名判定所属档位（启航 / 巡游）；中英文名与中英混排均可命中。 */
const matchBundleTier = (bundleName: string | undefined) => {
  const nm = bundleName ?? "";
  const lower = nm.toLowerCase();
  return {
    isLaunch:
      nm.includes(LAUNCH_BUNDLE_NAME_KEYWORDS.zh) || lower.includes(LAUNCH_BUNDLE_NAME_KEYWORDS.en),
    isCruise:
      nm.includes(CRUISE_BUNDLE_NAME_KEYWORDS.zh) || lower.includes(CRUISE_BUNDLE_NAME_KEYWORDS.en),
  };
};

/**
 * AI 增强版档位的促销标签文案。
 *
 * 前端按「档位 + bundle_type」直接判定，不依赖后端 `bundle.price.discount`
 * —— 该字段在本文件内存在两套单位口径（小数 `0<d<1` 与百分数 `50`），
 * 依赖它会让国际站 AI 档位在后端下发百分数时丢标签。
 *
 * 站点口径差异（本次需求仅调整国际站，国内站维持现状）：
 *   - 国际站启航 AI：`首单免费 3 天`（**仅新用户**，见下方 isNewUser 门禁）
 *   - 国际站巡游 AI：`首月 6 折`
 *   - 国内站启航 / 巡游 AI：`首月 6 折`（与改动前一致）
 *
 * 国际站标签必须同时匹配用户资格和真实询价：
 *   - 只有新用户且实付为 0，启航 AI 才展示「首单免费 3 天」；
 *   - 只有实付价低于原价时才展示折扣，避免后端异常全价询价仍承诺优惠。
 * 未登录静态 Bundle 也携带同样的原价 / 实付价，因此继续稳定展示既定免费与折扣信息。
 *
 * 仅返回文案，不改价格、不改 CTA、不改计费链路。
 */
const aiPromoTagText = (
  tier: { isLaunch: boolean; isCruise: boolean },
  t: (zh: string, opts?: Record<string, unknown>) => string,
  /* 新用户（未订阅任何套餐）。已订阅用户不展示「首单」类文案。 */
  isNewUser: boolean,
  price?: BundlePrice | null,
): string | undefined => {
  if (isGlobal) {
    if (tier.isLaunch && isNewUser && price?.real_total_cost === 0) {
      return t("首单免费 3 天");
    }
    const discountRate = actualDiscountRate(price);
    if ((tier.isLaunch || tier.isCruise) && discountRate != null) {
      /* 既有月付 AI 活动仍使用「首月 6 折」专属文案；异常的其他折扣率按真实比值展示。 */
      return Math.abs(discountRate - 0.6) < 0.0001
        ? t("首月 6 折")
        : discountTagText(discountRate, t);
    }
    return undefined;
  }
  if (tier.isLaunch || tier.isCruise) return t("首月 6 折");
  return undefined;
};

/**
 * 折扣角标文案（季付「8.5折」这类按实际折扣计算的标签）。
 *
 * 必须走 i18n：改动前此处用模板字符串直接拼中文「折」，
 * 导致 en-US / id-ID 环境下也输出「9.8折」这类中文文案。
 *
 * 同一条 key 下发两套口径，靠插值变量区分（i18next 会忽略译文里未引用的变量）：
 *   - zh-CN / zh-Hant：`{{discount}}折`   → 9.8折（折扣率，保留 1 位小数，中式表达）
 *   - en-US / id-ID：  `Save {{percent}}%` → Save 2%（节省比例，取整，西式表达）
 *
 * @param rate 折后价 / 原价的比值，取值区间 (0, 1)
 */
const discountTagText = (
  rate: number,
  t: (zh: string, opts?: Record<string, unknown>) => string,
): string =>
  t("{{discount}}折", {
    /* 中式折扣率，保留 1 位小数：0.85 → 8.5、0.9 → 9（整数不补 .0）、0.9827 → 9.8。
       乘 100 再除 10（而非 ×1000/100）确保只保留 1 位小数，与改动前的展示精度一致。 */
    discount: Math.round(rate * 100) / 10,
    /* 西式节省比例，取整：0.85 → 15（Math.round 同时规避浮点误差，如 15.000000000000002） */
    percent: Math.round((1 - rate) * 100),
  });

/** 只接受后端可计费的正数折扣价；零元权益只由新用户资格分支处理，已订阅零元询价视为异常且不展示促销。 */
const actualDiscountRate = (price?: BundlePrice | null): number | undefined =>
  price &&
  price.total_cost > 0 &&
  price.real_total_cost > 0 &&
  price.real_total_cost < price.total_cost
    ? price.real_total_cost / price.total_cost
    : undefined;

const shadows = {
  card: "rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px, rgba(0,0,0,0.01) 0px 0.175px 1.04px",
  deep: "rgba(0,0,0,0.01) 0px 1px 3px, rgba(0,0,0,0.02) 0px 3px 7px, rgba(0,0,0,0.02) 0px 7px 15px, rgba(0,0,0,0.04) 0px 14px 28px, rgba(0,0,0,0.05) 0px 23px 52px",
  featured: `rgba(0,0,0,0.10) 0px 0px 0px 3px, rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.85px, rgba(0,0,0,0.02) 0px 0.8px 2.93px`,
};

/* ─── Animation Variants (subtle, Notion-style) ─── */

const fadeIn = {
  hidden: { opacity: 0, y: 12 },
  visible: (custom: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: custom * 0.08, duration: 0.5, ease: [0.25, 0.1, 0.25, 1] },
  }),
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

/* ─── Plan Data ─── */

interface PlanFeature {
  icon: React.ReactNode;
  label: string;
  value?: string;
  hasCheck?: boolean;
}

/**
 * 前端展示用的套餐对象，由后端 Bundle 映射而来。
 * 为了联调时追踪方便，原始 Bundle 也保留在 raw 中。
 */
interface PlanInfo {
  id: string;
  name: string;
  badge?: string;
  badgeStyle?: "tag" | "popular";
  price: string;
  /* 结构化价格（分）：确认订单弹窗三行金额的真源。登录态真实计费时填充；
     demoMode 占位卡 / 静态价为 undefined，弹窗退化为旧视觉。 */
  priceDetail?: {
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
  };
  priceUnit?: string;
  priceNote?: string;
  /* 原价（折扣前价格）：有折扣时展在活动价右侧，小字删除线灰色。无折扣时为 undefined。 */
  originalPrice?: string;
  /* 促销标签（如“限时免费”），挪到套餐名右侧，粉色小徐章风格 */
  promoTag?: string;
  description: string;
  features: PlanFeature[];
  ctaLabel: string;
  ctaStyle: "outline" | "primary" | "outline-dark";
  /* 免费试用提示：新用户启航版按钮展示「免费订阅」时，hover 到按钮上方显示的提示文案。
     非新用户 / 非启航版 / 非免费订阅态时为 undefined（不展示提示）。 */
  freeTrialHint?: string;
  featured?: boolean;
  maxBots: number;
  /* 售罄：按钮禁用，展示「当日名额已满 / 明天再试」 */
  soldOut?: boolean;
  /* 暂无报价：按钮禁用，价格位显示占位「—」，features 正常显示，不走「当日名额已满」兜底 */
  priceUnavailable?: boolean;
  /* 询价加载中：中间态（用户已切换 durationKey，但新时长的价格尚未返回）。
     此时应保留上一时长的旧价与旧单位（视觉稳定，不跳成徽章），但 CTA 仍需禁用+拦截点击，
     并在价格数字旁展示一个小 spinner 提示正在加载。与 priceUnavailable（永久缺价）解耦。 */
  pricingLoading?: boolean;
  /* 未上线占位：按钮禁用，展示「即将上线 / 敬请期待」，保留正常价格 */
  comingSoon?: boolean;
  /* 免费套餐：跳过支付弹窗，直接创建 */
  skipPayment?: boolean;
  /* 当日剩余名额展示 */
  availableCount?: number;
  totalCount?: number;
  /**
   * 套餐分类（用于按 tab 分组展示），原始值来自后端 `bundle.bundle_type`。
   * 后端枚举：`free` / `general` / `ai`（migration 000023 拍板）。
   * 联调期可能缺失或为空串：归入 `BUNDLE_TYPE_FALLBACK_KEY`（其他）兜底分组。
   * 注意：免费套餐识别只看 bundle_id，避免上海现网缺少 bundle_type 时出现兼容问题。
   */
  bundleType?: string;
  raw: Bundle;
}

const isDianshiZeroAmountPlan = (plan: PlanInfo, paidBillingActive: boolean): boolean =>
  isGlobal && paidBillingActive && plan.raw.price?.real_total_cost === 0;

/* ─── 套餐分类 Tab 配置 ─── */

/**
 * 套餐分类 tab，与后端 `bundle.bundle_type` 枚举对应（migration 000023 / 2026-06 后端联调确认）：
 *   - general  标准版（启航 / 巡游）
 *   - ai       AI 增强版（启航 AI / 巡游 AI）
 *   - free     历史免费试用分类；现网灰度识别免费套餐只看 bundle_id
 * 后端新增付费枚举后，**只需修改本数组**（顺序 / key / 文案）即可，业务逻辑无需变更。
 *
 * 渲染规则（见 SubscribePage 中实现）：
 *   1. 当所有套餐都没有 `bundle_type` → 不渲染 tab 栏（行为同改造前）
 *   2. 当前 tab 下无套餐 → 该 tab 隐藏，不占位
 *   3. 后端下发的 `bundle_type` 不在本表中（含联调期空串）→ 归入「其他」兜底分组
 */
const BUNDLE_TYPE_FALLBACK_KEY = "__uncategorized__";
const FREE_TRIAL_BUNDLE_ID_PREFIXES = ["bundle_free_trial", "bundle_free"];

const isFreeTrialBundle = (bundle: Bundle): boolean =>
  FREE_TRIAL_BUNDLE_ID_PREFIXES.some((prefix) => bundle.bundle_id.startsWith(prefix));

interface BundleTypeTabDef {
  /** 与后端 `bundle.bundle_type` 字段值匹配的 key，大小写敏感 */
  key: string;
  /** 中文文案（i18n 字典中文回显此值） */
  zhLabel: string;
}

const BUNDLE_TYPE_TABS: BundleTypeTabDef[] = [
  { key: "general", zhLabel: "标准版" },
  { key: "ai", zhLabel: "AI 增强版" },
];

/* ─── 付费时长子 Tab（月付 / 季付）─── */

/**
 * 仅在计费开关开启（paidBillingActive=true）时展示，作用于所有可购买套餐。
 * 切换后以 { time_span, time_unit } 作为 listBundles 询价参数，重拉套餐价格；
 * 下单时把 { period, time_unit } 传给 createPassOrder。
 *
 * 关于「季付」编码：用 `3m`（3 个月）。
 *   - 后端 BundleTimeUnit 允许 y/m/d，季付用月为单位最兼容、语义清晰；
 *   - 展示为「3 个月下单价」，单位「/ 季」。
 */
interface AiDurationTabDef {
  key: "monthly" | "quarterly";
  period: number;
  time_unit: "m";
  zhLabel: string;
}

const AI_DURATION_TABS: AiDurationTabDef[] = [
  { key: "monthly", period: 1, time_unit: "m", zhLabel: "月付" },
  { key: "quarterly", period: 3, time_unit: "m", zhLabel: "季付" },
];

const getBillingPriceUnit = (
  durationKey: AiDurationTabDef["key"],
  t: (zh: string, opts?: Record<string, unknown>) => string,
): string => {
  if (durationKey === "quarterly") {
    return t("/ 季");
  }
  return t("/ 月");
};

const getBillingDurationLabel = (
  duration: AiDurationTabDef,
  t: (zh: string, opts?: Record<string, unknown>) => string,
): string => {
  if (duration.key === "quarterly") return t("3个月");
  return t("1个月");
};

/* i18n 静态标记：AI_DURATION_TABS 的 zhLabel、priceUnit、确认订单周期与询价中占位文案都是动态变量，extract 脚本扫不到 t() 调用 */
const __markAiDurationTabsForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  void t("月付");
  void t("季付");
  void t("/ 月");
  void t("/ 季");
  void t("1个月");
  void t("3个月");
  void t("询价中...");
};

const iconStyle = { width: 16, height: 16, color: colors.warmGray300, strokeWidth: 1.5 };

/* ─── Icon 映射（用于纯数据 → JSX 转换）─── */

type IconKey = "user" | "monitor" | "hardDrive" | "clock" | "settings" | "zap" | "wifi" | "headphones" | "check" | "automation" | "skill" | "channel" | "memory" | "evolution" | "persona" | "diagnostics" | "modelApi";

const iconMap: Record<IconKey, React.ReactNode> = {
  user: <User {...iconStyle} />,
  monitor: <Monitor {...iconStyle} />,
  hardDrive: <HardDrive {...iconStyle} />,
  clock: <Clock {...iconStyle} />,
  settings: <Settings {...iconStyle} />,
  zap: <Zap {...iconStyle} />,
  wifi: <Wifi {...iconStyle} />,
  headphones: <Sparkles {...iconStyle} />,
  check: <Check {...iconStyle} />,
  /* Agent 核心能力点：自动任务 / 技能（包）/ 多平台通道 / 长期记忆 */
  automation: <CalendarClock {...iconStyle} />,
  skill: <Puzzle {...iconStyle} />,
  channel: <MessageSquare {...iconStyle} />,
  memory: <Brain {...iconStyle} />,
  /* Agent 自主进化：用 Sparkles 表达「持续进化 / 智能升级」 */
  evolution: <Sparkles {...iconStyle} />,
  /* 人设注入：用 UserCog 表达「可配置的人格 / 角色设定」 */
  persona: <UserCog {...iconStyle} />,
  /* 诊断中心：用 Stethoscope 表达「运行状态检查 / 问题诊断」 */
  diagnostics: <Stethoscope {...iconStyle} />,
  /* 接入主流模型 API：用 Cpu 表达「模型 / 算力接入」 */
  modelApi: <Cpu {...iconStyle} />,
};

/**
 * 将后端 Bundle 映射成前端 PlanInfo。
 * 接收 t 函数以确保所有用户可见文案都走 i18n。
 *
 * 后端 bundle_name / description.Key 目前返回的是中文（或中英混排）原文，
 * 这里一律交给 t() 按当前 locale 查字典：
 *   - zh-CN：字典里中文翻译与原文一致，回显原文
 *   - en-US：字典里填入对应英文（如 `启航 Launch` → Launch）
 *   - 字典未命中：t() 内部会回显中文原文，不会白屏
 * 如此中英切换、国际站中文模式都能交给 i18n 运行时自然处理，
 * 后续后端支持国际化字段后只要后端返中文、前端不需任何改动。
 */
const iconForKey = (key: string): React.ReactNode => {
  const k = key.toLowerCase();
  if (k.includes("agent")) return iconMap.user;
  if (k.includes("积分") || k.includes("credit")) return iconMap.zap;
  if (k.includes("存储") || k.includes("storage")) return iconMap.hardDrive;
  if (k.includes("环境") || k.includes("environment")) return iconMap.monitor;
  if (k.includes("配置") || k.includes("config")) return iconMap.settings;
  return iconMap.check;
};

/**
 * Agent 核心能力点在卡片下方按固定顺序统一渲染（见 mapBundleToPlan）。
 * 后端 description 里若也下发了同类项（最典型的是「7*24小时在线」），
 * 这里将其从 otherFeatures 中过滤掉，避免与固定能力点重复或打乱顺序。
 */
const CAPABILITY_DESC_KEYS = new Set<string>([
  "7*24小时在线", "7×24小时在线", "7×24 在线", "7*24 在线",
  "极简配置面板", "自动任务", "技能安装", "技能包", "精选技能/技能包",
  "连接主流聊天通道", "接入主流模型 API", "长期记忆", "人设注入", "Agent 自主进化", "诊断中心",
]);
const isCapabilityDescKey = (rawKey: string): boolean => {
  if (CAPABILITY_DESC_KEYS.has(rawKey)) return true;
  return /24/.test(rawKey) && /(在线|online)/i.test(rawKey);
};

/**
 * i18n 静态标记块：后端返回的 bundle_name 与 description.Key 是动态字符串，
 * extract 脚本只能扫到 `t("...")` 字面量调用，无法跟踪 `t(bundle.bundle_name)`。
 * 这里把后端目前会下发的中文原文静态列举出来，仅供脚本扫描使用：
 *   - 运行时 void 调用一次，结果丢弃，不影响逻辑
 *   - 后续后端返回字串变化时，只需同步更新本表
 */
const __markBundleBackendStringsForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  /* bundle_name */
  void t("启航 Launch");
  /* description.Key */
  void t("独立环境");
  void t("7×24小时在线");
  void t("7*24小时在线");
};

/**
 * i18n 静态标记块（前端常量）：BUNDLE_TYPE_TABS 的 zhLabel 是动态变量，
 * extract 脚本扫不到 `t(tab.zhLabel)`，这里把所有 tab 文案 + fallback 文案静态列举。
 * 仅供 extract 工具静态分析；运行时由 SubscribePage 在组件挂载时调用一次。
 */
const __markBundleTypeTabsForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  void t("套餐分类");
  void t("标准版");
  void t("AI 增强版");
  void t("其他");
};

const mapBundleToPlan = (
  bundle: Bundle,
  index: number,
  t: (zh: string, opts?: Record<string, unknown>) => string,
  paidBillingEnabled: boolean,
  /* 当前选中的付费时长（面向所有 bundle_type）。默认 monthly 保持向后兼容：
     - 未开启计费开关/国际站限时免费视觉：调用处可不传，单位经后面逆矩阵处理为"/ 月"
     - 开启计费开关后已选季付时：应传入 "quarterly" 以保证价格单位与后端 real_total_cost 口径一致 */
  durationKey: "monthly" | "quarterly" = "monthly",
  /* 询价中占位标记：仅在「用户已切换 durationKey，但对应时长的询价请求尚未返回」的中间态传 true。
     此时 bundle.price 仍是上一时长（如月付）的旧价，若原样展示会出现「¥49 / 季」这种严重误导，
     故价格换成 "——"、单位清空、CTA 禁用，直到新价格回来。 */
  isPricingLoading: boolean = false,
  /* 当前用户是否已开通套餐：仅用于转化引导文案。
     未开通套餐（新用户）时，第一张主推卡（启航 Launch，index===0）的 CTA 文案改为「免费开通」，
     以降低开通决策门槛、提升注册到开通转化；已开通用户维持原「立即开通」文案。 */
  isSubscribed: boolean = false,
  /* 「免费开通」引导的前提开关：仅当付费计费开关与实名手机验证开关同时关闭时才允许改文案。
     （对应 localStorage 覆盖 lightclaw:features.paidBillingEnabled=false
       与 lightclaw:features.realnamePhoneVerificationEnabled=false 的场景）
     两开关任一开启时，一律维持原「立即开通」文案，不做免费引导。 */
  freeGuideAllowed: boolean = false,
  /* 当前用户已生效权益对应的 bundle_id（来自 activePass.bundle_id）。
     命中当前卡时，CTA 文案改为「当前订阅」；配合外层 subscriptionLocked 让所有卡按钮禁用
     （暂不支持升级/更换套餐）。未订阅或国际站无 activePass 时传 null。 */
  currentBundleId: string | null = null,
  /* 是否已登录：未登录时按套餐名直接展示促销标签，不依赖后端 discount 字段。 */
  isLoggedIn: boolean = true,
): PlanInfo => {
  /* 静态标记，运行时一次性调用以让字典加载后端下发中文的翻译 */
  __markBundleBackendStringsForI18n(t);
  const features: PlanFeature[] = [];

  /* 套餐档位（tier）判定，依据 bundle_name（中/英/中英混排）识别启航 / 巡游。
     用于：独立环境规格差异化 + 一句话文案差异化。避免后端 description.Value 缺值时露馅。 */
  const bundleNm = bundle.bundle_name ?? "";
  const nmLower = bundleNm.toLowerCase();
  const isLaunchTier = bundleNm.includes("启航") || nmLower.includes("launch");
  const isCruiseTier = bundleNm.includes("巡游") || nmLower.includes("cruise");
  /* 独立环境规格：启航 2核4G；巡游升配 4核8G。 */
  const envSpec = isLaunchTier ? t("2核 4G 内存") : t("4核 8G 内存");
  /* 专属云端存储：启航 50G；巡游升配 80G。 */
  const storageSpec = isLaunchTier ? "50G" : "80G";
  /* 一句话文案按 tier 差异化（PRD 需求2）。命中 tier 时直接使用 tier 文案，不受 freeGuideAllowed 清空；
     未命中 tier（如免费试用卡）保持原有兜底逻辑。 */
  const tierTagline = isLaunchTier
    ? t("低成本上手，先让 Agent 替你跑起来")
    : isCruiseTier
      ? t("日常主力，让智能化成为习惯")
      : "";

  /* agent_quota 打头阵 */
  if (bundle.agent_quota > 0) {
    features.push({ icon: iconMap.user, label: "Agent", value: `${bundle.agent_quota} ${t("个")}` });
  }
  /* description 里的其他卖点（已出现的 Agent/积分不重复添加）*/
  /* 「独立环境」「专属云端存储」前端统一规格并固定顺序展示，其余项顺延 */
  let envFeature: PlanFeature | null = null;
  let storageFeature: PlanFeature | null = null;
  const otherFeatures: PlanFeature[] = [];
  for (const entry of bundle.description ?? []) {
    const rawKey = entry.Key ?? "";
    const k = rawKey.toLowerCase();
    if (k.includes("agent") || k.includes("积分") || k.includes("credit")) continue;
    /* 统一走 i18n 字典：当前语言是 en-US 则查英文，zh-CN 则回显原文。
       动态参数 extract 脚本扫不到，为此在 __markBundleBackendStringsForI18n 中静态列举。 */
    const label = t(rawKey);
    /* 「独立环境」统一前端展示规格，避免后端 Value 为空导致卡片露馅；
       匹配 key 仍用后端下发的「独立环境」，展示文案统一为「云端独立环境」 */
    if (rawKey === "独立环境") {
      envFeature = { icon: iconForKey(rawKey), label: t("云端独立环境"), value: envSpec };
      continue;
    }
    /* 「专属云端存储」前端按 tier 统一展示容量，避免后端缺值 */
    if (rawKey === "专属云端存储") {
      storageFeature = { icon: iconMap.hardDrive, label, value: storageSpec };
      continue;
    }
    /* 能力点（7*24小时在线 / 自动任务 / 技能 / 多通道 / 长期记忆 / 极简配置面板 / 人设注入 / 自主进化）
       统一在下方按固定顺序渲染，这里跳过后端 description 里的同类项，避免重复与乱序。 */
    if (isCapabilityDescKey(rawKey)) continue;
    /* 后端 Value 为空时，用右侧勾替代，避免卡片右侧空白 */
    if (!entry.Value) {
      otherFeatures.push({ icon: iconForKey(rawKey), label, hasCheck: true });
      continue;
    }
    otherFeatures.push({ icon: iconForKey(rawKey), label, value: entry.Value });
  }
  /* 顺序：独立环境 → 专属云端存储 → 模型积分 → 其他描述项 */
  if (envFeature) features.push(envFeature);
  if (storageFeature) features.push(storageFeature);
  /* credit > 0 时展示模型积分 */
  if (bundle.credit > 0) {
    features.push({
      icon: iconMap.zap,
      label: t("模型积分"),
      value: `${bundle.credit} ${t("积分/月")}`,
    });
  }
  features.push(...otherFeatures);
  /* 规格项兜底：后端缺失「独立环境」「专属云端存储」时补齐，仍固定排在能力点上方 */
  if (!envFeature) {
    features.push({ icon: iconMap.monitor, label: t("云端独立环境"), value: envSpec });
  }
  if (!storageFeature) {
    features.push({ icon: iconMap.hardDrive, label: t("专属云端存储"), value: storageSpec });
  }
  /* ─── Agent 核心能力点（固定顺序，所有套餐一致，统一展示在规格项下方）───
     顺序：Agent 自主进化 → 7*24小时在线 → 极简配置面板 → 连接主流聊天通道 → 接入主流模型 API
          → 精选技能/技能包 → 人设注入 → 自动任务 → 长期记忆 → 诊断中心。
     技能项不再按 tier 区分「技能安装 / 技能包」，所有套餐统一「精选技能/技能包」。 */
  const capabilityPoints: PlanFeature[] = [
    { icon: iconMap.evolution, label: t("Agent 自主进化"), hasCheck: true },
    { icon: iconMap.clock, label: t("7*24小时在线"), hasCheck: true },
    { icon: iconMap.settings, label: t("极简配置面板"), hasCheck: true },
    { icon: iconMap.channel, label: t("连接主流聊天通道"), hasCheck: true },
    { icon: iconMap.modelApi, label: t("接入主流模型 API"), hasCheck: true },
    { icon: iconMap.skill, label: t("精选技能/技能包"), hasCheck: true },
    { icon: iconMap.persona, label: t("人设注入"), hasCheck: true },
    { icon: iconMap.automation, label: t("自动任务"), hasCheck: true },
    { icon: iconMap.memory, label: t("长期记忆"), hasCheck: true },
    { icon: iconMap.diagnostics, label: t("诊断中心"), hasCheck: true },
  ];
  for (const cap of capabilityPoints) {
    if (!features.some((f) => f.label === cap.label)) features.push(cap);
  }

  /**
   * 价格 / 促销标签 / 是否跳过支付，按「计费开关 × 站点」二维分流：
   *   - `paidBillingEnabled=false`（开关未开启，老逻辑）：
   *       国内外一律走「限时免费」视觉（价格锚点 $7.5 / ¥49、显示"限时免费"标签、
   *       skipPayment=true 走免费 createPass），保证灰度期兜底与老用户视觉一致。
   *   - `paidBillingEnabled=true`（开关已开启，新逻辑）：
   *       国内站（isGlobal=false）消费后端真实价格 bundle.price.real_total_cost；
   *         无价（trade 故障 / 未登录）时禁用按钮、不展示促销徽章。
   *       国际站（isGlobal=true）已全量放开付费定价展示：
   *         登录后消费后端 bundle.price（单位分 + USD），未登录消费前端静态美元价表。
   */
  const soldOut = bundle.bundle_sales_state === "SOLD_OUT";
  /* 计费开关开启后国内外一律进入真实计费展示。
     国际站未登录不再走「限时免费 $7.5」兜底 —— 未登录消费 buildStaticBundles 下发的静态价，
     与登录后新用户的价格 / 折扣 / 标签口径一致（需求：未登录展示纯静态页，信息等同登录后新用户）。 */
  const paid = paidBillingEnabled;
  /* 新用户（未订阅任何套餐）：决定是否展示「首单」类权益文案。
     未登录一律视为新用户（未登录必然还没有订阅），与登录后的新用户展示口径保持一致。 */
  const isNewUser = !isSubscribed;
  /** 套餐卡展示的「价格基准」：产品口径为税前实付价（价签模式：卡片标税前，付款实付含税）。
   *  注意与后端 2692ca1ca 询价税费拆分的语义：
   *    real_total_cost = 含税实付；total_cost = 税前原价；tax_price = 实付税额。
   *  卡片价 = real_total_cost - tax_price = 税前实付价（含折扣）：
   *    - 有税数据：从含税实付中扣除税额，与弹窗「小计（税前）」同口径，避免
   *      「卡片 $52、弹窗小计 $45」被用户当成变价；
   *    - 无税数据（tax_price 缺失 / 静态价表）：等于 real_total_cost 直显，
   *      与静态新用户实付价（如启航月付 $0、巡游 AI $13.8）的展示设计兼容。
   *  单位转换后端给的是分，cent...Yuan 内部乘 0.01；后端 price 为 null 时返回 null。 */
  const realPriceYuan =
    paid && bundle.price
      ? centsToYuan(bundle.price.real_total_cost - (bundle.price.tax_price ?? 0))
      : null;
  const priceUnavailable = paid && !bundle.price && !soldOut;
  /* 询价中中间态：用户已切换 durationKey、但新时长的询价尚未返回。此时 bundle.price 仍是旧时长的价。
     方案 B1：视觉上保留旧价 + 旧单位（不切成新单位，避免「旧价 + 新单位」的误导组合），
     价格数字旁加一个小 spinner 让用户感知正在加载；CTA 侧独立通过 pricingLoading 保持 disabled + 拦截点击。
     不再合并进 priceUnavailable —— 徽章路径只服务永久缺价场景，中间态保留成熟数字视觉更稳定。 */
  const showPricingPlaceholder = paid && isPricingLoading && !soldOut;

  let price = "";
  let originalPrice: string | undefined;
  let promoTag: string | undefined;
  /* 需求4：是否可享受「免费 14 天 0 元下单」——命中即把 CTA 文案改为「免费开通」。
     当前口径：国内付费启航标准版（非 AI 增强、无后端折扣）享 14 天免费试用、首单 0 元。 */
  let isZeroDownFreeTrial = false;
  if (paid) {
    const currency = bundle.price?.currency ?? "CNY";
    /* 未登录静态页面：启航 discount=0（免费试用），巡游 discount=50%（首月 5 折），按折扣调整展示价 */
    let displayPriceYuan = realPriceYuan;
    /* 原价（折扣前）：未登录时即 realPriceYuan（后端下发的原价）；已登录时取后端 total_cost。 */
    let originalPriceYuan: number | null = null;
    if (isGlobal && bundle.price) {
      /* 国际站（登录与未登录同一口径）：real_total_cost 即新用户实付价、total_cost 为原价。
         未登录静态价来自 STATIC_INTL_PRICE_USD，已内置新用户实付价（如启航 AI 月付 $0、
         巡游 AI 月付 $13.8），**不能再套用下方未登录分支的 ×0.5 / ×0.6 / 置 0 二次折算**，
         否则会出现 $13.8 再打 6 折这类错误金额。
         这样未登录展示与登录后新用户完全一致（需求：未登录整页按登录后新用户呈现）。 */
      const intlOriginalYuan = centsToYuan(bundle.price.total_cost);
      if (
        intlOriginalYuan != null &&
        displayPriceYuan != null &&
        intlOriginalYuan > displayPriceYuan
      ) {
        originalPriceYuan = intlOriginalYuan;
      }
    } else if (!isLoggedIn && realPriceYuan != null) {
      const nm = bundle.bundle_name ?? "";
      const isLaunch = nm.includes("启航") || nm.toLowerCase().includes("launch");
      const isCruise = nm.includes("巡游") || nm.toLowerCase().includes("cruise");
      const notAi = bundle.bundle_type !== "ai";
      if (durationKey === "quarterly") {
        /* 季付：静态 price 已内置折扣（标准版 8.5 折 / AI 增强版 9 折，见 STATIC_*_DISCOUNT），
           结构与登录后询价一致（total_cost=原价 / real_total_cost=折后价）。此处仅取原价展示删除线，
           不套用月付促销（免费14天 / 首月5折 / 首月6折）；折后价 realPriceYuan 直接展示，
           折扣角标（如「8.5折」）由后续 promoTag 分支按 price.discount 计算。标准版与 AI 增强版一致。 */
        if (isLaunch || isCruise) {
          const staticOriginalYuan = centsToYuan(bundle.price.total_cost);
          if (
            staticOriginalYuan != null &&
            displayPriceYuan != null &&
            staticOriginalYuan > displayPriceYuan
          ) {
            originalPriceYuan = staticOriginalYuan;
          }
        }
      } else if (isLaunch && notAi) {
        displayPriceYuan = 0; // 月付：免费 14 天 → ¥0
        originalPriceYuan = realPriceYuan; // 原价展示
      } else if (isCruise && notAi) {
        displayPriceYuan = +(realPriceYuan * 0.5).toFixed(2); // 月付：首月 5 折
        originalPriceYuan = realPriceYuan; // 原价展示
      } else if ((isLaunch || isCruise) && !notAi) {
        /* AI 增强版月付：首月 6 折（静态 price 存原价，此处按 0.6 计算折后价，
           「首月 6 折」标签由后续 promoTag 分支给出）。 */
        displayPriceYuan = +(realPriceYuan * STATIC_AI_MONTHLY_DISCOUNT).toFixed(2);
        originalPriceYuan = realPriceYuan; // 原价展示
      }
    } else if (isLoggedIn && bundle.price) {
      /* 已登录：后端 real_total_cost 为折后价，total_cost 为原价；有折扣时展示原价删除线。 */
      const backendOriginalYuan = centsToYuan(bundle.price.total_cost);
      if (
        backendOriginalYuan != null &&
        displayPriceYuan != null &&
        backendOriginalYuan > displayPriceYuan
      ) {
        originalPriceYuan = backendOriginalYuan;
      }
    }
    price = displayPriceYuan != null ? formatYuan(displayPriceYuan, currency) : "";
    originalPrice = originalPriceYuan != null ? formatYuan(originalPriceYuan, currency) : undefined;
    /* 国内站不再展示"限时免费"标签 */
    const backendDiscount = bundle.price?.discount;
    if (durationKey === "quarterly") {
      /* 季付：不展示月付首期促销（免费14天 / 首月5折 / 首月6折），改为按实际折扣显示「8.5折」这类角标。
         折扣直接由「折后价 / 原价」比值算出（originalPriceYuan=原价、displayPriceYuan=折后价，前面价格逻辑已备好），
         登录取后端 total_cost/real_total_cost、未登录取静态价，口径一致，不依赖后端 discount 字段口径。
         无原价删除线（即无折扣）时不展示角标。 */
      promoTag =
        originalPriceYuan != null && displayPriceYuan != null && originalPriceYuan > displayPriceYuan
          ? discountTagText(displayPriceYuan / originalPriceYuan, t)
          : undefined;
    } else if (isGlobal) {
      /* 国际站月付：标签统一按「档位 + bundle_type + 原价 / 实付价」判定，不依赖后端 discount 字段
         （该字段在本文件内存在小数 `0<d<1` 与百分数 `50` 两套口径，依赖它会丢标签）。
         未登录静态 Bundle 也携带既定原价 / 实付价，因此展示不变；登录态异常全价询价不承诺优惠。 */
      const tier = matchBundleTier(bundle.bundle_name);
      const isAi = bundle.bundle_type === BUNDLE_TYPE_AI;
      const discountRate = actualDiscountRate(bundle.price);
      if (isAi) {
        /* AI 档位：启航零元新用户「首单免费 3 天」；有真实折扣时按询价展示。 */
        promoTag = aiPromoTagText(tier, t, isNewUser, bundle.price);
      } else if (tier.isLaunch) {
        /* 启航标准版：只有新用户实付为零才承诺 14 天免费；其他状态只展示真实折扣。 */
        if (isNewUser && bundle.price?.real_total_cost === 0) {
          promoTag = t("首单免费 14 天");
          isZeroDownFreeTrial = true;
        } else {
          promoTag = discountRate == null ? undefined : discountTagText(discountRate, t);
        }
      } else if (tier.isCruise) {
        /* 巡游标准版：新用户且真实五折时使用首购文案；其余真实折扣使用通用折扣标签。 */
        promoTag =
          discountRate == null
            ? undefined
            : isNewUser && Math.abs(discountRate - 0.5) < 0.0001
              ? t("首月 5 折")
              : discountTagText(discountRate, t);
      } else {
        promoTag = undefined;
      }
    } else if (typeof backendDiscount === "number" && backendDiscount > 0 && backendDiscount < 1) {
      /* 国内站：有真实折扣（小数口径）时按比值展示「X折」，与改动前一致。 */
      promoTag = discountTagText(backendDiscount, t);
    } else {
      const tier = matchBundleTier(bundle.bundle_name);
      const withToken = bundle.bundle_type === BUNDLE_TYPE_AI;
      if (tier.isLaunch) {
        if (withToken) {
          /* 季付已在前面 durationKey === "quarterly" 分支清空 promoTag，此处必为非季付 */
          /* AI 增强版档位促销标签由 aiPromoTagText 统一给出，不再依赖后端 discount：
             国际站启航 AI「首单免费 3 天」，国内站启航 AI「首月 6 折」（与改动前一致）。
             改动前此处被 `if (!isGlobal)` 拦截，导致国际站启航 AI 档位无任何标签。
             已订阅用户由 aiPromoTagText 内部降级为「首月 6 折」，不展示首单权益。 */
          promoTag = aiPromoTagText(tier, t, isNewUser);
        } else if (!isLoggedIn || backendDiscount === 0) {
          /* 启航01：未登录直接展示「免费 14 天」；已登录需 discount=0 */
          promoTag = t("首单免费 14 天");
          isZeroDownFreeTrial = true;
        }
      } else if (tier.isCruise) {
        if (withToken) {
          /* 季付已在前面 durationKey === "quarterly" 分支清空 promoTag，此处必为非季付 */
          /* 巡游 AI 档位国内外一致展示「首月 6 折」。
             改动前此处被 `if (!isGlobal)` 拦截，且后端 discount 单位不一致（0<d<1 与 50 两套口径），
             导致国际站巡游 AI 档位丢失「首月 6 折」标签 —— 本次需求要修的即此问题。 */
          promoTag = aiPromoTagText(tier, t, isNewUser);
        } else if (!isLoggedIn || backendDiscount === 50) {
          /* 巡游01：未登录直接展示「首月 5 折」；已登录需 discount=50 */
          promoTag = t("首月 5 折");
        }
      } else {
        promoTag = undefined;
      }
    }
  } else {
    /* 计费开关整体关闭（paidBillingEnabled=false）时的限时免费视觉，国内外一致。
       注意：国际站未登录**不再**落到这里 —— `paid` 已改为只看 paidBillingEnabled，
       未登录会消费 buildStaticBundles 的静态价，与登录后新用户口径一致。
       因此本分支只服务「开关未开启」的灰度兜底场景，保持改动前的原始行为不变。 */
    price = isGlobal ? "$7.5" : "¥49";
    promoTag = soldOut ? undefined : t("限时免费");
  }

  /** 国内站价格不可用时按「暂无报价」展示禁用 CTA，避免点击后报错。
   *  询价加载中时专门细分为 "询价中..."，区别于永久性的 "暂无报价"。
   *
   *  转化引导：正常可购买态下，第一张主推卡（启航 Launch，index===0）在用户未开通套餐时，
   *  文案由「立即开通」改为「免费开通」；已开通用户及其他套餐卡维持「立即开通」。
   *  前提：仅当付费计费开关与实名手机验证开关同时关闭（freeGuideAllowed=true）时才生效，
   *  任一开关开启时一律维持「立即开通」。
   *  售罄 / 询价中 / 暂无报价等禁用态文案优先级更高，不受此引导文案影响。 */
  const isFeaturedFreeGuide = freeGuideAllowed && index === 0 && !isSubscribed;
  /* 命中当前已订阅套餐：CTA 固定为「当前订阅」，优先级最高（覆盖售罄/询价/引导等文案）。
     暂不支持升级 / 更换套餐，所有卡按钮由外层 subscriptionLocked 统一禁用。
     别名映射：老免费版 bundle_free_trial_01 视为 bundle_launch_01 的前身，匹配同一张卡。 */
  const CURRENT_BUNDLE_ALIASES: Record<string, string[]> = {
    "bundle_launch_01": ["bundle_free_trial_01"],
  };
  const isCurrentPlan = currentBundleId != null && (
    bundle.bundle_id === currentBundleId ||
    CURRENT_BUNDLE_ALIASES[bundle.bundle_id]?.includes(currentBundleId) === true
  );
  /* 启航版（标准版，非 AI 增强版）识别。新用户只有在真实实付为零时展示「免费订阅」，
     防止登录态异常全价询价仍承诺免费；未登录静态价为零，既定展示不受影响。 */
  const bundleTier = matchBundleTier(bundle.bundle_name);
  const isLaunchStandard = bundleTier.isLaunch && bundle.bundle_type !== BUNDLE_TYPE_AI;
  /* 国际站启航 AI 增强版档位：促销标签为「首单免费 3 天」（见 aiPromoTagText）。
     国内站启航 AI 不进入本判定，CTA 维持「立即订阅」，与改动前一致。 */
  const isIntlLaunchAi =
    isGlobal && bundleTier.isLaunch && bundle.bundle_type === BUNDLE_TYPE_AI;
  /* 季付不含首期免费试用（季付价即实付价，见上方 durationKey === "quarterly" 的促销分支：
     月付首期促销一律不生效，只按实际折扣展示角标）。
     因此季付一律不展示「免费订阅」引导，CTA 维持「立即订阅」，也不展示免费试用 hover 提示。 */
  const freeTrialEligibleDuration = durationKey !== "quarterly";
  const isZeroAmountBundle = paid && bundle.price?.real_total_cost === 0;
  const isNewUserFreeLaunch =
    isLaunchStandard &&
    isZeroAmountBundle &&
    !isSubscribed &&
    !isCurrentPlan &&
    freeTrialEligibleDuration;
  /**
   * 启航 AI 档位是否展示「免费订阅」CTA。
   *
   * 必须以**实付金额为 0** 为前提，不能只看档位 —— 否则会出现
   * 「按钮承诺免费、点击后进入信用卡支付」的不一致（本次未实现 3 天试用能力，
   * 权益与支付逻辑均未改动）。
   *
   * 金额为 0 时点击链路本身也是零元流程：`isDianshiZeroAmountPlan` 命中
   * `real_total_cost === 0` 走点石零元下单，不进入信用卡支付，与 CTA 语义一致。
   * 金额非 0 时（如首月 6 折）自动回落为「立即订阅」，与实际收费一致。
   */
  const isNewUserFreeLaunchAi =
    isIntlLaunchAi &&
    isZeroAmountBundle &&
    !isSubscribed &&
    !isCurrentPlan &&
    freeTrialEligibleDuration;
  const ctaLabel = isCurrentPlan
    ? t("当前订阅")
    : soldOut
    ? t("已售罄")
    : showPricingPlaceholder
      ? t("询价中...")
      : priceUnavailable
        ? t("暂无报价")
        : /* 可享免费 14 天的零元下单，或内测「免费订阅」引导态，显示「免费订阅」。
             国际站启航标准版 / AI 版均须同时满足新用户、月付、实付为零。
             已订阅用户不展示「免费订阅」引导（当前套餐走 isCurrentPlan →「当前订阅」优先级更高）。
             季付无首期免费试用，freeTrialEligibleDuration=false 时统一收口为「立即订阅」。 */
          !isSubscribed &&
          freeTrialEligibleDuration &&
          (isZeroDownFreeTrial || isFeaturedFreeGuide || isNewUserFreeLaunch || isNewUserFreeLaunchAi)
          ? t("免费订阅")
          : t("立即订阅");
  /* 免费试用提示：仅当按钮实际展示「免费订阅」且为新用户启航版时才展示。
     售罄 / 询价中 / 暂无报价 / 当前订阅等态下 ctaLabel 不是「免费订阅」，不提示。 */
  const freeTrialHint =
    isNewUserFreeLaunch && !soldOut && !showPricingPlaceholder && !priceUnavailable
      ? t("免费试用到期后，不会自动扣费，后续如需继续使用，请手动续费。")
      : undefined;

  return {
    id: bundle.bundle_id,
    /* 统一走 i18n 字典：当前语言是 en-US 则查英文（如 `启航 Launch` → Launch），
       zh-CN 则回显后端原文。 */
    name: t(bundle.bundle_name),
    badge: soldOut ? t("已售罄") : undefined,
    badgeStyle: soldOut ? "tag" : undefined,
    /* 价格：中间态保留旧价原样展示，视觉稳定不跳变；CTA 由 pricingLoading 兜底禁用。 */
    price,
    /* 结构化价格（分）：确认订单弹窗三行金额真源（后端 2692ca1ca 询价税费拆分）。
       口径（产品确认 2026-08-24）：小计=折后价（税前实付 = real_total_cost - tax_price，
       与卡片价同源同值，避免「卡片 $7、弹窗小计 $14」变价错觉）、税费=tax_price、
       合计=real_total_cost（含税实付）。原价/折扣差不单列展示。
       仅在登录态真实计费（paid && bundle.price）时填充；
       询价中间态沿用旧 bundle.price，与新时长无关——弹窗在 CTA 禁用期间不可打开，无误导窗口。 */
    priceDetail:
      paid && bundle.price
        ? {
            subtotalCents: bundle.price.real_total_cost - (bundle.price.tax_price ?? 0),
            taxCents: bundle.price.tax_price ?? 0,
            totalCents: bundle.price.real_total_cost,
          }
        : undefined,
    /* 原价（折扣前）：有折扣时展在活动价右侧删除线；询价加载中不展示，避免误导。 */
    originalPrice: showPricingPlaceholder ? undefined : originalPrice,
    /* 价格单位需与当前 durationKey 一致，且中间态必须与旧价口径一致：
       - 未付费（限时免费视觉）：paid=false 就一定是默认月价锚点，单位固定为"/ 月"
       - 已付费：paid=true 时，当前价格已是后端按 durationKey 询价回来的 real_total_cost；
         季付回来的是 3 个月总价，若单位仍写"/ 月"会误导用户，必须同步切换为"/ 季"。
       - 询价加载中（showPricingPlaceholder）：此时 bundle.price 还是旧时长的价，
         为避免「旧价 + 新单位」的误导，单位强制回退为"/ 月"，与旧价口径保持一致，
         直到新价格返回后再随 durationKey 一并切成"/ 季"。 */
    priceUnit: paid && !showPricingPlaceholder ? getBillingPriceUnit(durationKey, t) : getBillingPriceUnit("monthly", t),
    /* 国际站中英文都展示促销标签：英文为 Limited free，中文为限时免费；国内站保持原有中文标签。
       询价加载中（showPricingPlaceholder）不展示折扣角标：此时 bundle.price 仍是旧时长的价，
       与 originalPrice 同样口径处理，避免月付切季付的中间态基于旧价算出「0折 / 5折」等误导角标。 */
    promoTag: showPricingPlaceholder ? undefined : promoTag,
    /* 命中 tier 时用 tier 一句话文案（需求2）；未命中 tier 时维持原兜底：
       freeGuideAllowed（两开关同时关闭）去掉描述，其余展示「尝鲜体验，从一个 Agent 开始」。 */
    description: tierTagline || (freeGuideAllowed ? "" : t("尝鲜体验，从一个 Agent 开始")),
    features,
    ctaLabel,
    freeTrialHint,
    /* 国际站两张卡 CTA 统一黑底白字（primary），视觉权重一致；
       国内站维持原样（仅主推卡 index===0 为 primary，其余 outline），本次不改国内站。
       featured（卡片描边 / 圆角强调）仍只由 tier 顺序决定，不随配色统一而变。 */
    ctaStyle: isGlobal || index === 0 ? "primary" : "outline",
    featured: index === 0,
    maxBots: bundle.agent_quota || 1,
    /* 真实缺价走 priceUnavailable（触发徽章 + CTA 禁用 + 点击拦截）；
       询价加载中走 pricingLoading（不触发徽章、保留旧价视觉，但 CTA 仍禁用 + 拦截点击）。
       两者语义解耦：一个是永久性缺价，一个是短暂中间态，视觉表现刻意区分以获得更稳定的用户感知。 */
    soldOut,
    priceUnavailable,
    pricingLoading: showPricingPlaceholder,
    /* 国际站继续走免费试用；国内站走付费下单 */
    skipPayment: !paid,
    availableCount: bundle.bundle_sales_available_count,
    totalCount: bundle.bundle_sales_total_count,
    /* 后端联调期可能缺失：缺失时由后续 tabGroups 兜底到「未分类」分组 */
    bundleType: bundle.bundle_type,
    /**
     * TODO(temp-bypass, 联调期): 后端 /v1/bundles 列表当前未下发 time_span / time_unit，
     * 导致 createPassOrder 的 body 缺少 period / time_unit 字段，被后端 prepareCreatePassOrder
     * 校验 `period <= 0` 挡掉，返回 400 PASS_INVALID_PARAM。
     *
     * 这里前端临时按"月付"兜底，**仅用于联调跑通整条支付链路**。
     *
     * ⚠️ 风险：一旦后端未来上线季付等多周期套餐而仍未下发 time_span/time_unit，
     *     这里会按 1 个月下单但发放更长周期权益，导致财务对账事故。
     *
     * 正确做法：推后端在 bundle 配置里加 time_span / time_unit 字段并由 /v1/bundles 透出。
     * 后端补完字段后，**必须删除以下兜底，恢复 `raw: bundle`**。
     */
    raw: {
      ...bundle,
      time_span: bundle.time_span ?? 1,
      time_unit: bundle.time_unit ?? "m",
    },
  };
};

/**
 * 占位套餐的最小化 fake Bundle（按钮禁用，bundle_id 不会被真实使用）
 */
const makePlaceholderBundle = (id: string, name: string, agentQuota: number): Bundle => ({
  bundle_id: id,
  bundle_name: name,
  description: [],
  bundle_state: "OFFLINE",
  agent_quota: agentQuota,
  credit: 0,
  price: null,
  time_span: 1,
  time_unit: "m",
  bundle_sales_available_count: 0,
  bundle_sales_total_count: 0,
  bundle_sales_state: "SOLD_OUT",
});

/* ─── 未登录静态定价表（功能点2b / PRD 方案A）─────────────────────────
 * 未登录用户不调 GET /v1/bundles（匿名调用后端返回 price=null，会全线落到「暂无报价」+ 按钮禁用，
 * 表现为「打开啥也没有」），改用下面写死的静态 Bundle 列表，喂给同一套 mapBundleToPlan / planTiers
 * 渲染，保证「未登录静态展示」与「登录后询价展示」的结构、文案、促销角标完全一致；
 * 仅在点击订阅按钮时才引导登录（见 handleSubscribe 的 !isLoggedIn → login()）。
 * 国际站付费已全量放开：planList 直接展示付费套餐，无 reveal 门禁。
 *
 * 价格为线上确认值（金额敏感），此处均为「原价」：
 *   - 启航标准版：月付 ¥45 / 季付 ¥135（月×3）
 *   - 巡游标准版：月付 ¥95 / 季付 ¥285（月×3）
 * 季付统一享 8.5 折优惠（与登录后询价下发折扣一致）：启航 ¥114.75 / 巡游 ¥242.25，原价删除线展示。
 * AI 增强版已露静态价，见 STATIC_AI_TIER_PRICE_YUAN。
 * ⚠️ 后端调整线上价格 / 折扣时请同步更新此表，避免未登录静态价与登录后询价价不一致。 */
const STATIC_TIER_PRICE_YUAN: Record<"launch" | "cruise", Record<"monthly" | "quarterly", number>> = {
  launch: { monthly: 45, quarterly: 135 },
  cruise: { monthly: 95, quarterly: 285 },
};

/** 季付统一优惠折扣：8.5 折（与登录后询价下发的 discount 对齐，未登录静态展示据此计算折后价）。 */
const STATIC_QUARTERLY_DISCOUNT = 0.85;

/**
 * AI 增强版静态原价（元）：与登录后询价原价对齐（启航月付 ¥68 / 巡游月付 ¥158，季付 = 月付×3）。
 * 未登录静态展示据此计算：月付享「首月 6 折」、季付享 9 折（展示「9折」角标）。
 * ⚠️ 后端调整线上 AI 价格 / 折扣时请同步更新此表，避免未登录静态价与登录后询价不一致。
 */
const STATIC_AI_TIER_PRICE_YUAN: Record<"launch" | "cruise", Record<"monthly" | "quarterly", number>> = {
  launch: { monthly: 68, quarterly: 204 },
  cruise: { monthly: 158, quarterly: 474 },
};

/** AI 增强版月付首期折扣：首月 6 折（0.6），后续原价；仅未登录静态展示据此计算折后价 + 展示「首月 6 折」标签。 */
const STATIC_AI_MONTHLY_DISCOUNT = 0.6;

/** AI 增强版季付折扣：9 折（0.9），展示「9折」角标（季付按实际折扣显示，不套月付首期促销）。 */
const STATIC_AI_QUARTERLY_DISCOUNT = 0.9;

/**
 * 国际站未登录静态价（美元，面向新用户口径）。
 *
 * 需求：未登录整页按「登录后新用户」呈现，含美元与折扣。国际站美元价由腾讯云计费系统
 * 实时询价返回（见 `trade/internal/logic/inquiry/service.go`，按 SiteKind 返回 USD），
 * 代码中无权威价表，故此处按产品确认值硬编码。
 *
 * `original` = 原价（展示删除线）；`real` = 新用户实付价（展示主价）。
 * **直接指定 real，不由 original × 折扣率乘算** —— 产品确认的折后价与乘算结果存在
 * 分币差异（如季付 19.5 × 0.93 = 18.135，产品定价 18.07），乘算会导致展示与实际定价不一致。
 *
 * 折扣角标由 mapBundleToPlan 按 `real / original` 比值反算展示（en-US 为 `Save X%`）。
 *
 * ⚠️ 产品调整国际站线上价格 / 折扣时必须同步此表，否则未登录静态价与登录后询价不一致。
 * 数据来源：产品 2026-08-21 确认。
 */
const STATIC_INTL_PRICE_USD: Record<
  "launch" | "cruise",
  Record<"general" | "ai", Record<"monthly" | "quarterly", { original: number; real: number }>>
> = {
  launch: {
    /* 启航标准版：月付 $6.5，新用户 14 天免费（实付 $0）；季付 $19.5 → 9.3 折 $18.07 */
    general: {
      monthly: { original: 6.5, real: 0 },
      quarterly: { original: 19.5, real: 18.07 },
    },
    /* 启航 AI 版：月付 $10，新用户 3 天免费（实付 $0）；季付 $30 → 9.8 折 $29.43 */
    ai: {
      monthly: { original: 10, real: 0 },
      quarterly: { original: 30, real: 29.43 },
    },
  },
  cruise: {
    /* 巡游标准版：月付 $14，新用户首购 5 折 $7；季付 $42 → 9.3 折 $38.92 */
    general: {
      monthly: { original: 14, real: 7 },
      quarterly: { original: 42, real: 38.92 },
    },
    /* 巡游 AI 版：月付 $23，新用户首购 6 折 $13.8；季付 $69 → 9.8 折 $67.69 */
    ai: {
      monthly: { original: 23, real: 13.8 },
      quarterly: { original: 69, real: 67.69 },
    },
  },
};

/** 静态价格构造器：入参以「元」为单位的原价，可选 discount（0~1，默认 1.0 不打折）。
 *  内部转「分」并按 discount 计算折后价，与后端询价 BundlePrice 口径一致
 *  （total_cost=原价 / real_total_cost=折后价 / discount=折扣率）。 */
const buildStaticPrice = (yuan: number, discount = 1.0): BundlePrice => {
  const originalCents = Math.round(yuan * 100);
  const realCents = Math.round(yuan * discount * 100);
  return {
    price: originalCents,
    total_cost: originalCents,
    real_total_cost: realCents,
    currency: "CNY",
    discount,
  };
};

/**
 * 国际站静态价构造器：原价与折后价均由 STATIC_INTL_PRICE_USD 直接给出（美元），
 * 不做折扣率乘算，避免分币差异。`discount` 字段按比值回填，仅供折扣角标反算。
 */
const buildIntlStaticPrice = (entry: { original: number; real: number }): BundlePrice => {
  const originalCents = Math.round(entry.original * 100);
  const realCents = Math.round(entry.real * 100);
  return {
    price: originalCents,
    total_cost: originalCents,
    real_total_cost: realCents,
    currency: "USD",
    /* 比值口径（0~1 小数），与本文件 discountTagText 的入参口径一致；原价为 0 时兜底 1。 */
    discount: originalCents > 0 ? realCents / originalCents : 1,
  };
};

/** 标准版通用卖点（与后端 description 对齐；独立环境规格 / 存储 / 积分等具体展示由 mapBundleToPlan 内部统一处理）。 */
const STATIC_GENERAL_DESC: BundleDescriptionEntry[] = [
  { Key: "独立环境", Value: "" },
  { Key: "专属云端存储", Value: "" },
  { Key: "7×24小时在线", Value: "" },
];

/**
 * 生成未登录静态 Bundle 列表（覆盖启航/巡游 × 标准版/AI 增强版），
 * 走与后端相同的 mapBundleToPlan / planTiers 链路渲染。
 *   - 国际站：使用 STATIC_INTL_PRICE_USD，直接指定原价与新用户实付价，避免分币误差。
 *   - 国内站：沿用 STATIC_TIER_PRICE_YUAN / STATIC_AI_TIER_PRICE_YUAN 与既有折扣率。
 * AI 增强版积分写死为启航 4500 / 巡游 10000。
 * bundle_id 与线上真实配置一致（见 scripts/seed_trade_shprod_bundle_definition.sql），
 * 但未登录不会触发下单（点订阅先引导登录），仅用于展示。
 */

const buildStaticBundles = (durationKey: "monthly" | "quarterly"): Bundle[] => {
  const span = durationKey === "quarterly" ? 3 : 1;
  /**
   * 静态价按站点分流：
   *   - 国际站：STATIC_INTL_PRICE_USD（美元，原价 + 新用户实付价直接指定）
   *   - 国内站：STATIC_TIER_PRICE_YUAN / STATIC_AI_TIER_PRICE_YUAN（人民币，原价 × 折扣率）
   * 国内站分支保持改动前行为不变。
   */
  const staticPrice = (tier: "launch" | "cruise", kind: "general" | "ai"): BundlePrice => {
    if (isGlobal) {
      return buildIntlStaticPrice(STATIC_INTL_PRICE_USD[tier][kind][durationKey]);
    }
    if (kind === "ai") {
      return buildStaticPrice(
        STATIC_AI_TIER_PRICE_YUAN[tier][durationKey],
        durationKey === "quarterly" ? STATIC_AI_QUARTERLY_DISCOUNT : 1.0,
      );
    }
    return buildStaticPrice(
      STATIC_TIER_PRICE_YUAN[tier][durationKey],
      durationKey === "quarterly" ? STATIC_QUARTERLY_DISCOUNT : 1.0,
    );
  };
  const base = {
    bundle_state: "ONLINE" as const,
    time_unit: "m" as const,
    /* 未登录纯静态展示不露出「今日剩余 N/M 份」名额提示：available === total 时，
       PlanCard 的 `availableCount < totalCount` 条件不成立，名额行不渲染。 */
    bundle_sales_available_count: 100,
    bundle_sales_total_count: 100,
    bundle_sales_state: "AVAILABLE" as const,
  };
  return [
    /* 免费试用：仅在计费开关关闭（paidBillingActive=false）时经 planList 过滤后展示；
       开关开启的付费场景会被 planList 过滤掉，与登录后一致。 */
    {
      ...base,
      bundle_id: "bundle_free_7d",
      bundle_name: "启航 Launch",
      bundle_type: "free",
      description: STATIC_GENERAL_DESC,
      agent_quota: 1,
      credit: 0,
      price: null,
      time_span: 7,
      time_unit: "d",
    },
    /* 启航 Launch —— 标准版（可购买、露真实价，促销「免费 14 天」）+ AI 增强版（敬请期待） */
    {
      ...base,
      bundle_id: "bundle_launch_01",
      bundle_name: "启航 Launch",
      bundle_type: "general",
      description: STATIC_GENERAL_DESC,
      agent_quota: 1,
      credit: 100,
      price: staticPrice("launch", "general"),
      time_span: span,
    },
    {
      ...base,
      bundle_id: "bundle_launch_ai_01",
      bundle_name: "启航 Launch",
      bundle_type: "ai",
      description: STATIC_GENERAL_DESC,
      agent_quota: 1,
      credit: 4500,
      price: staticPrice("launch", "ai"),
      time_span: span,
    },
    /* 巡游 Cruise —— 标准版（促销「首月 5 折」）+ AI 增强版（敬请期待） */
    {
      ...base,
      bundle_id: "bundle_cruise_01",
      bundle_name: "巡游 Cruise",
      bundle_type: "general",
      description: STATIC_GENERAL_DESC,
      agent_quota: 1,
      credit: 200,
      price: staticPrice("cruise", "general"),
      time_span: span,
    },
    {
      ...base,
      bundle_id: "bundle_cruise_ai_01",
      bundle_name: "巡游 Cruise",
      bundle_type: "ai",
      description: STATIC_GENERAL_DESC,
      agent_quota: 1,
      credit: 10000,
      price: staticPrice("cruise", "ai"),
      time_span: span,
    },
  ];
};

/**
 * 占位套餐纯数据定义（不含 JSX），渲染时通过 buildPlaceholderPlans 转为 PlanInfo。
 */
interface PlaceholderFeatureDef {
  iconKey: IconKey;
  label: string;
  value?: string;
  hasCheck?: boolean;
}

interface PlaceholderPlanDef {
  id: string;
  name: string;
  price: string;
  priceGlobal: string;
  priceUnit: string;
  priceUnitGlobal: string;
  description: string;
  features: PlaceholderFeatureDef[];
  ctaLabel: string;
  ctaStyle: "outline" | "primary" | "outline-dark";
  maxBots: number;
  comingSoon?: boolean;
  /**
   * 国际站放开为可购买（进信用卡确认弹窗、纯前端演示下单）。
   * 仅在 isGlobal 构建下生效；国内站及其他占位卡仍维持 comingSoon「即将上线」。
   */
  releasedOnGlobal?: boolean;
  agentQuota: number;
  /**
   * 套餐分类，用于未开启计费开关（国际站占位卡场景）时也能按 BUNDLE_TYPE_TABS 分 tab。
   * 缺省会落入「其他」兜底分组；巡游属于传统标准套餐语义，默认 "general"。
   */
  bundleType?: string;
}

const PLACEHOLDER_PLAN_DEFS: PlaceholderPlanDef[] = [
  {
    id: "placeholder-starter",
    name: "巡游 Cruise",
    price: "¥99",
    priceGlobal: "$15",
    priceUnit: "/ 月",
    priceUnitGlobal: "/ month",
    description: "日常主力，让智能化成为习惯",
    features: [
      { iconKey: "user", label: "Agent", value: "1 个" },
      { iconKey: "monitor", label: "云端独立环境", value: "4核 8G 内存" },
      { iconKey: "hardDrive", label: "专属云端存储", value: "80G" },
      { iconKey: "zap", label: "模型积分", value: "-" },
      { iconKey: "evolution", label: "Agent 自主进化", hasCheck: true },
      { iconKey: "clock", label: "7*24小时在线", hasCheck: true },
      { iconKey: "settings", label: "极简配置面板", hasCheck: true },
      { iconKey: "channel", label: "连接主流聊天通道", hasCheck: true },
      { iconKey: "modelApi", label: "接入主流模型 API", hasCheck: true },
      { iconKey: "skill", label: "精选技能/技能包", hasCheck: true },
      { iconKey: "persona", label: "人设注入", hasCheck: true },
      { iconKey: "automation", label: "自动任务", hasCheck: true },
      { iconKey: "memory", label: "长期记忆", hasCheck: true },
      { iconKey: "diagnostics", label: "诊断中心", hasCheck: true },
    ],
    ctaLabel: "即将上线",
    ctaStyle: "outline-dark",
    maxBots: 1,
    comingSoon: true,
    agentQuota: 1,
    bundleType: "general",
  },
];

/**
 * i18n 静态标记块：占位套餐的中文字面量定义在 PLACEHOLDER_PLAN_DEFS 数据里，
 * extract 脚本只能扫到 `t("...")` 字面量调用，无法跟踪 `t(def.name)` 这种动态参数。
 *
 * 修改 PLACEHOLDER_PLAN_DEFS 时请同步更新此处。
 */
const __markPlaceholderPlansForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  void t("免费试用 7天");
  void t("巡游 Cruise");
  void t("日常主力，让智能化成为习惯");
  void t("1 个");
  void t("云端独立环境");
  void t("4核 8G 内存");
  void t("极简配置面板");
  void t("自动任务");
  void t("精选技能/技能包");
  void t("人设注入");
  void t("连接主流聊天通道");
  void t("接入主流模型 API");
  void t("长期记忆");
  void t("Agent 自主进化");
  void t("7*24小时在线");
  void t("诊断中心");
};

/** 将纯数据占位套餐转为带 JSX + i18n 的 PlanInfo */
const buildPlaceholderPlans = (t: (zh: string, opts?: Record<string, unknown>) => string): PlanInfo[] => {
  __markPlaceholderPlansForI18n(t);
  return PLACEHOLDER_PLAN_DEFS.map((def) => {
    /* 国际站放开的占位卡（当前仅「巡游 Cruise」）：解除「即将上线」禁用、CTA 改为「立即订阅」，
       并置 skipPayment=false 让点击走信用卡确认弹窗（纯前端演示下单，见 CreditCardConfirmOrderModal）。
       国内站及未放开的占位卡（如「远航」）维持 comingSoon「即将上线」原样。 */
    const releasedForGlobal = isGlobal && def.releasedOnGlobal === true;
    return {
      id: def.id,
      name: t(def.name),
      price: isGlobal ? def.priceGlobal : def.price,
      priceUnit: isGlobal ? t(def.priceUnitGlobal) : t(def.priceUnit),
      description: t(def.description),
      features: def.features.map((f) => ({
        icon: iconMap[f.iconKey],
        label: t(f.label),
        value: f.value ? t(f.value) : undefined,
        hasCheck: f.hasCheck,
      })),
      ctaLabel: releasedForGlobal ? t("立即订阅") : t(def.ctaLabel),
      ctaStyle: releasedForGlobal ? "primary" : def.ctaStyle,
      maxBots: def.maxBots,
      comingSoon: releasedForGlobal ? false : def.comingSoon,
      /* 放开后不走免费直建链路，改由确认弹窗承接（纯前端演示） */
      skipPayment: releasedForGlobal ? false : undefined,
      bundleType: def.bundleType,
      raw: makePlaceholderBundle(def.id, def.name, def.agentQuota),
    };
  });
};

/* ─── 套餐档位（tier）分组：启航 / 巡游 ─── */

/**
 * 需求3 重构：不再用「标准版 / AI 增强版」全局 tab 切换整排卡，而是
 * 按 tier（启航 / 巡游）固定展示，同一 tier 下的标准版 / AI 增强版
 * 收敛为卡内「积分」切换（见 PlanCard）。这里定义 tier 分组所需的类型与工具。
 */
type PlanTierKey = "launch" | "cruise";
const PLAN_TIER_ORDER: PlanTierKey[] = ["launch", "cruise"];

/** 按 bundle_name（中 / 英 / 中英混排）判定 tier；未命中返回 null（如免费试用卡）。 */
const tierOfPlan = (plan: PlanInfo): PlanTierKey | null => {
  const raw = plan.raw.bundle_name ?? plan.name ?? "";
  const lower = raw.toLowerCase();
  if (raw.includes("启航") || lower.includes("launch")) return "launch";
  if (raw.includes("巡游") || lower.includes("cruise")) return "cruise";
  return null;
};

const isRetiredVoyagePlan = (plan: PlanInfo): boolean => {
  const raw = plan.raw.bundle_name ?? plan.name ?? "";
  const lower = raw.toLowerCase();
  return raw.includes("远航") || lower.includes("voyage");
};

/** 一个 tier 分组：同 tier 的多个档位（variants，按积分升序展示）+ 是否敬请期待。 */
interface PlanTierGroup {
  /** tier key（launch/cruise）或未命中 tier 时的 plan.id（各自单卡） */
  key: string;
  /** 同 tier 的档位列表，按 credit 升序（标准版在左、AI 增强版在右） */
  variants: PlanInfo[];
}

const getDefaultVariantIndex = (variants: PlanInfo[]): number => {
  if (variants.length <= 1) return 0;
  return variants.reduce((lowestIndex, variant, index) => {
    const lowestCredit = variants[lowestIndex]?.raw.credit ?? Number.POSITIVE_INFINITY;
    const credit = variant.raw.credit ?? Number.POSITIVE_INFINITY;
    return credit < lowestCredit ? index : lowestIndex;
  }, 0);
};

/**
 * 实名校验错误码兜底文案 — 计费侧错误码统一走 lib/billing-error 的 resolveBillingErrorMessage
 */
const resolveRealnameErrorMessage = (t: (zh: string) => string): string =>
  isGlobal ? t("创建失败，请稍后重试。") : t("请先完成实名认证后再开通套餐。");

const renderAppHeaderLink: RenderPublicSiteHeaderLink = ({
  ariaLabel,
  children,
  href,
  ...props
}) => (
  <AppLink to={href} aria-label={ariaLabel} {...props}>
    {children}
  </AppLink>
);

type SubscribePageHeaderProps = {
  authControls?: ReactNode;
  authReady: boolean;
  isAuthenticated: boolean;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink: RenderPublicSiteHeaderLink;
};

const SubscribePageHeader = ({
  authControls,
  authReady,
  isAuthenticated,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink,
}: SubscribePageHeaderProps) => (
  <PublicSiteHeader
    authControls={authControls}
    authSnapshot={{ authReady, isAuthenticated }}
    currentPath="/subscribe"
    locale={publicLocale}
    localized={publicLocalized}
    position="fixed"
    renderLanguageSwitcher={renderLanguageSwitcher}
    renderLink={renderLink}
    showLanguageSwitcher={isGlobal}
  />
);

/* ─── Plan Card Component ─── */

const PlanCard = ({
  variants,
  index,
  onSubscribe,
  subscribingPlanId,
  currentBots,
  reserveCreditTabSpace,
  subscriptionLocked,
}: {
  /* 同一 tier 的档位列表（AI 增强版 / 标准版）；未命中 tier 时长度为 1 */
  variants: PlanInfo[];
  index: number;
  onSubscribe: (planId: string) => void;
  subscribingPlanId: string | null;
  currentBots: number;
  /* 是否为「无积分切换」的卡预留等高占位，使其 CTA/功能点与有积分切换的卡对齐 */
  reserveCreditTabSpace?: boolean;
  /* 用户已有生效订阅：暂不支持升级 / 更换套餐，所有卡按钮统一禁用（当前套餐卡文案为「当前订阅」）。 */
  subscriptionLocked?: boolean;
}) => {
  const t = useT();
  /* 卡内积分档位切换：同 tier 的 AI 增强版 / 标准版收敛为 variants，切换即换整份 PlanInfo，
     价格 / 积分 / 折扣 / 下单套餐随之联动。默认选中低积分标准版（启航 100 / 巡游 200）。 */
  const defaultVariantIdx = getDefaultVariantIndex(variants);
  const [activeVariantIdx, setActiveVariantIdx] = useState(() => defaultVariantIdx);
  const safeIdx = activeVariantIdx < variants.length ? activeVariantIdx : defaultVariantIdx;
  const plan = variants[safeIdx]!;
  const subscribing = subscribingPlanId === plan.id;
  /* 新用户启航版「免费订阅」按钮 hover 时，上方展示免费试用到期不自动扣款的提示（plan.freeTrialHint） */
  const [showFreeTrialHint, setShowFreeTrialHint] = useState(false);
  const quotaWouldExceed = currentBots >= plan.maxBots;
  /* 主推卡由 tier 顺序决定（启航，index===0），不随积分切换变化 */
  const isFeatured = index === 0;
  const isSoldOut = plan.soldOut === true;
  const isComingSoon = plan.comingSoon === true;
  const isPriceUnavailable = plan.priceUnavailable === true;
  /* 积分切换 tab：只要有 >1 个档位就展示。
     即便当前选中的档位是「敬请期待」（如本期未上线的 AI 增强版），也保留切换入口，
     否则用户切到 AI 档后会因 tab 消失而无法切回标准版。 */
  const showCreditTabs = variants.length > 1;
  /* 售罄 / 未上线 / 暂无报价 / 询价加载中：按钮禁用。
     询价加载中虽然价格数字仍在展示（旧价），但为避免用户以旧价口径提交订单，CTA 必须 disabled。 */
  /* subscriptionLocked：用户已有生效订阅，暂不支持升级/更换套餐，所有卡按钮一律禁用。 */
  const disabled = isSoldOut || isComingSoon || isPriceUnavailable || plan.pricingLoading === true || subscribing || quotaWouldExceed || subscriptionLocked === true;

  return (
    <motion.div
      variants={fadeIn}
      custom={index}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: colors.white,
        border: isFeatured ? `1.5px solid ${colors.primary}` : `1px solid ${colors.border}`,
        borderRadius: isFeatured ? 16 : 12,
        /* 需求3：三张卡统一取消阴影，仅保留边框（主推卡为高亮描边） */
        boxShadow: "none",
        overflow: "hidden",
        transition: "transform 0.3s",
      }}
      onMouseEnter={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.transform = "translateY(-2px)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.transform = "translateY(0)";
        }
      }}
    >
      {/* Popular Badge */}
      {plan.badge && plan.badgeStyle === "popular" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 0",
            background: colors.primary,
            color: colors.white,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.125px",
            lineHeight: 1.33,
          }}
        >
          {plan.badge}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "32px 28px 28px" }}>
        {/* Header: Name + Description */}
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <h3
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: "-0.25px",
                lineHeight: 1.27,
                color: colors.black,
                margin: 0,
              }}
            >
              {plan.name}
            </h3>
            {/* 促销小徐章：挪到套餐名右侧，粉色背景 + 深色文字，醒目告诉用户促销信息 */}
            {plan.promoTag && (
              <span
                style={{
                  fontSize: isGlobal ? 11 : 12,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: "#D14081",
                  background: "#FDE7F0",
                  border: "1px solid #F7B8D2",
                  borderRadius: 999,
                  padding: isGlobal ? "3px 8px" : "4px 10px",
                  whiteSpace: "nowrap",
                }}
              >
                {plan.promoTag}
              </span>
            )}
          </div>
          {plan.badge && plan.badgeStyle === "tag" && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "2px 10px",
                borderRadius: 9999,
                background: colors.badgeBg,
                color: colors.badgeText,
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: "0.125px",
                lineHeight: 1.33,
                marginBottom: 8,
              }}
            >
              {plan.badge}
            </span>
          )}
          {/* Description - 移到套餐名下方；为空时不渲染，避免留下空段落间距 */}
          {plan.description ? (
            <p
              style={{
                fontSize: 14,
                fontWeight: 400,
                lineHeight: 1.43,
                color: colors.warmGray500,
                margin: 0,
              }}
            >
              {plan.description}
            </p>
          ) : null}
        </div>

        {/* 积分档位切换（segmented control）：同 tier 的标准版 / AI 增强版通过积分数值切换，
            切换即联动价格 / 积分 / 折扣 / 下单套餐（需求3）。 */}
        {showCreditTabs && (
          <div
            role="tablist"
            aria-label={t("模型积分")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: 3,
              marginTop: 4,
              marginBottom: 16,
              background: "rgba(0,0,0,0.04)",
              borderRadius: 9999,
              alignSelf: "flex-start",
              /* 需求3：卡内顺序 价格 → 积分切换 → 开通按钮 → 分割线 → 功能点（flex order 重排） */
              order: 2,
            }}
          >
            {variants.map((v, vi) => {
              const active = vi === safeIdx;
              return (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveVariantIdx(vi)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "5px 14px",
                    borderRadius: 9999,
                    border: "none",
                    background: active ? colors.white : "transparent",
                    color: active ? colors.black : colors.warmGray500,
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    cursor: "pointer",
                    boxShadow: active ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                    transition: "all 0.2s ease",
                  }}
                >
                  <Zap style={{ width: 13, height: 13, color: active ? "#D14081" : colors.warmGray300, strokeWidth: 2 }} />
                  <span>{v.raw.credit}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 无积分切换的卡补一段与积分 tabs 等高的占位，使 CTA/分割线/功能点与其他卡对齐 */}
        {!showCreditTabs && reserveCreditTabSpace && (
          <div aria-hidden style={{ height: 32, marginTop: 4, marginBottom: 16, order: 2 }} />
        )}

        {/* Price - 未上线占位卡：有价格时正常展示价格，无价格时显示「敬请期待」；售罄套餐用「已售罄」遮盖价格 */}
        {isComingSoon && !plan.price ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, minHeight: 48 }}>
            <span
              style={{
                fontSize: 28,
                fontWeight: 700,
                letterSpacing: "-0.5px",
                lineHeight: 1.5,
                color: colors.warmGray500,
              }}
            >
              {t("敬请期待")}
            </span>
          </div>
        ) : isSoldOut ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 8 }}>
            <span
              style={{
                fontSize: 32,
                fontWeight: 700,
                letterSpacing: "-0.5px",
                lineHeight: 1.5,
                color: colors.warmGray300,
              }}
            >
              {t("已售罄")}
            </span>
          </div>
        ) : isPriceUnavailable ? (
          /* 暂无报价：用低调的灰色提示文字替代价格，撑住版式高度，避免大字号 "—" 造成视觉粗黑横线 */
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: 8,
              minHeight: 48,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 14,
                fontWeight: 500,
                lineHeight: 1.43,
                color: colors.warmGray500,
                background: "rgba(0,0,0,0.04)",
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                padding: "6px 12px",
              }}
            >
              {t("暂无报价")}
            </span>
          </div>
        ) : plan.price ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 8, flexWrap: isGlobal ? "nowrap" : "wrap", rowGap: 6 }}>
            {(() => {
              /* 价格拆分：把前缀货币符号（¥ / $）与数字分离，符号用更小字号并顶端对齐，
                 让数字成为视觉主体（参考设计稿）。无符号时整体按数字大字号展示。 */
              const m = /^(\D*)(.*)$/.exec(plan.price ?? "");
              const symbol = m?.[1] ?? "";
              const amount = m?.[2] ?? (plan.price ?? "");
              return (
                <span style={{ display: "inline-flex", alignItems: "flex-start", color: colors.black }}>
                  {symbol && (
                    <span
                      style={{
                      fontSize: 22,
                      fontWeight: 700,
                      lineHeight: 1,
                      marginRight: 4,
                    }}
                  >
                    {symbol}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 48,
                      fontWeight: 700,
                      letterSpacing: "-1.5px",
                      lineHeight: 1,
                    }}
                  >
                    {amount}
                  </span>
                </span>
              );
            })()}
            {(plan.priceUnit || plan.priceNote) && (
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 400,
                  color: colors.warmGray300,
                  lineHeight: 1,
                  marginLeft: 2,
                  /* 时长单位与价格数字底部对齐，并整体上移一点点 */
                  alignSelf: "flex-end",
                  marginBottom: 4,
                }}
              >
                {plan.priceUnit || plan.priceNote}
              </span>
            )}
            {/* 原价（折扣前）：紧跟活动价右侧，小字灰色删除线，突出优惠力度 */}
            {plan.originalPrice && (
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 400,
                  lineHeight: 1,
                  color: colors.warmGray300,
                  textDecoration: "line-through",
                  alignSelf: "flex-end",
                  marginBottom: 4,
                  marginLeft: 6,
                  whiteSpace: "nowrap",
                }}
              >
                {plan.originalPrice}
              </span>
            )}
          </div>
        ) : (
          /* 兜底：price 为空且非售罄非占位（理论上不会走到），保留占位高度避免塌陷 */
          <div style={{ minHeight: 48, marginBottom: 8 }} />
        )}
        {/* 今日剩余名额提示：只在未售罄且剩余比例较低时显示，避免每张卡都出现 */}
        {!isSoldOut && typeof plan.availableCount === "number" && typeof plan.totalCount === "number" && plan.totalCount > 0 && plan.availableCount < plan.totalCount && (
          <p
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: plan.availableCount <= 5 ? "#C67B1E" : colors.warmGray500,
              marginTop: isGlobal ? 6 : -20,
              marginBottom: isGlobal ? 18 : 20,
            }}
          >
            {t("今日剩余 {{available}}/{{total}} 份", { available: plan.availableCount, total: plan.totalCount })}
          </p>
        )}
        {/* Divider */}
        <div style={{ height: 1, background: colors.border, marginTop: 4, marginBottom: 24, order: 4 }} />

        {/* Features - 售罄 / （无卖点的）未上线时展示占位文案 */}
        {isSoldOut || (isComingSoon && plan.features.length === 0) || (!isComingSoon && !isSoldOut && plan.features.length === 0) ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 16px",
              gap: 8,
              textAlign: "center",
              order: 5,
            }}
          >
            <Sparkles style={{ width: 24, height: 24, color: colors.warmGray300 }} />
            <p
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: colors.warmGray500,
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {isComingSoon ? t("即将上线") : isSoldOut ? t("当日名额已满") : t("暂无详情")}
            </p>
            {!isComingSoon && (
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: colors.warmGray300,
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                {isSoldOut ? t("明天 10:00 再来试试") : t("稍后再看")}
              </p>
            )}
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, display: "flex", flexDirection: "column", gap: 16, order: 5 }}>
            {plan.features.map((feature, idx) => (
              <li
                key={idx}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: 14,
                  fontWeight: 400,
                  lineHeight: 1.43,
                  color: colors.warmGray500,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {feature.icon}
                  <span>{feature.label}</span>
                </span>
                {feature.value ? (
                  <span style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>
                    {feature.value}
                  </span>
                ) : feature.hasCheck ? (
                  <Check style={{ width: 16, height: 16, color: colors.warmGray500, strokeWidth: 2 }} />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {/* CTA Button — 需求3：上移到功能点上方（积分切换与分割线之间），order=3 */}
        <div
          style={{ position: "relative", marginTop: 4, marginBottom: 4, order: 3 }}
          onMouseEnter={() => {
            if (plan.freeTrialHint) setShowFreeTrialHint(true);
          }}
          onMouseLeave={() => setShowFreeTrialHint(false)}
        >
          {/* 免费试用提示：新用户启航版「免费订阅」按钮 hover 时，在按钮上方展示 */}
          {plan.freeTrialHint && showFreeTrialHint && (
            <div
              role="tooltip"
              style={{
                position: "absolute",
                bottom: "calc(100% + 8px)",
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 20,
                width: "max-content",
                maxWidth: 240,
                padding: "8px 12px",
                borderRadius: 8,
                background: colors.tooltipBg,
                color: colors.white,
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1.5,
                textAlign: "center",
                boxShadow: colors.tooltipShadow,
                pointerEvents: "none",
                whiteSpace: "normal",
              }}
            >
              {plan.freeTrialHint}
              {/* 指向按钮的小三角箭头 */}
              <span
                style={{
                  position: "absolute",
                  top: "100%",
                  left: "50%",
                  transform: "translateX(-50%)",
                  width: 0,
                  height: 0,
                  borderLeft: "5px solid transparent",
                  borderRight: "5px solid transparent",
                  borderTop: `5px solid ${colors.tooltipBg}`,
                }}
              />
            </div>
          )}
          {isComingSoon ? (
            <button
              disabled
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: `1px solid rgba(0,0,0,0.06)`,
                background: "rgba(0,0,0,0.03)",
                color: "rgba(0,0,0,0.35)",
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.33,
                cursor: "not-allowed",
              }}
            >
              {plan.ctaLabel}
            </button>
          ) : plan.ctaStyle === "primary" ? (
            <button
              onClick={() => onSubscribe(plan.id)}
              disabled={disabled}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: isSoldOut || quotaWouldExceed ? "rgba(0,0,0,0.15)" : colors.primary,
                color: isSoldOut || quotaWouldExceed ? "rgba(0,0,0,0.40)" : colors.white,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.33,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: subscribing ? 0.6 : 1,
                transition: "background 0.2s, transform 0.15s",
              }}
              onMouseEnter={(e) => {
                if (!disabled) {
                  e.currentTarget.style.background = colors.primaryHover;
                }
              }}
              onMouseLeave={(e) => {
                if (!isSoldOut && !quotaWouldExceed) {
                  e.currentTarget.style.background = colors.primary;
                }
              }}
            >
              {subscriptionLocked ? plan.ctaLabel : isSoldOut ? plan.ctaLabel : subscribing ? t("正在创建...") : plan.ctaLabel}
            </button>
          ) : (
            <button
              onClick={() => onSubscribe(plan.id)}
              disabled={disabled}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: `1px solid ${isSoldOut || quotaWouldExceed ? "rgba(0,0,0,0.06)" : colors.border}`,
                background: isSoldOut || quotaWouldExceed ? "rgba(0,0,0,0.03)" : colors.white,
                color: isSoldOut || quotaWouldExceed ? "rgba(0,0,0,0.35)" : colors.black,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 1.33,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: subscribing ? 0.6 : 1,
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!disabled) {
                  e.currentTarget.style.background = colors.warmWhite;
                  e.currentTarget.style.borderColor = "rgba(0,0,0,0.2)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isSoldOut && !quotaWouldExceed) {
                  e.currentTarget.style.background = colors.white;
                  e.currentTarget.style.borderColor = colors.border;
                }
              }}
            >
              {subscriptionLocked ? plan.ctaLabel : isSoldOut ? plan.ctaLabel : subscribing ? t("正在创建...") : plan.ctaLabel}
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
};

/* ─── Modal shared styles ─── */

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
  backdropFilter: "blur(4px)",
};

const modalPanelStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: 440,
  margin: "0 16px",
  background: colors.white,
  borderRadius: 16,
  boxShadow: shadows.deep,
  overflow: "hidden",
};

const modalCloseStyle: React.CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  background: "none",
  border: "none",
  cursor: "pointer",
  color: colors.warmGray300,
  padding: 4,
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "color 0.15s, background 0.15s",
};

/* ─── Confirm Order Modal ─── */

const ConfirmOrderModal = ({
  plan,
  billingPeriodLabel,
  showPaymentMethod = true,
  actionLabel,
  onCancel,
  onPay,
}: {
  plan: PlanInfo;
  billingPeriodLabel: string;
  showPaymentMethod?: boolean;
  actionLabel?: string;
  onCancel: () => void;
  onPay: () => void;
}) => {
  const t = useT();
  const currencySymbol = plan.price.trim().startsWith("$") ? "$" : "¥";
  const priceNum = plan.price.replace(/[^0-9.]/g, "");

  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onCancel}
    >
      <motion.div
        style={modalPanelStyle}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          style={modalCloseStyle}
          onClick={onCancel}
          aria-label={t("关闭")}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 6px", letterSpacing: "-0.25px" }}>
            {t("确认订单")}
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 20px" }}>{t("订单详情")}</p>

          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: 12,
              padding: "20px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 14, color: colors.warmGray500 }}>
              <span>{plan.name}{t("订阅")}</span>
              <span style={{ fontWeight: 600, color: colors.black }}>{currencySymbol}{priceNum}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: 14, color: colors.warmGray500 }}>
              <span>{t("订阅周期")}</span>
              <span style={{ fontWeight: 600, color: colors.black }}>{billingPeriodLabel}</span>
            </div>
            <div style={{ height: 1, background: colors.border, margin: "0 0 16px" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 14, color: colors.warmGray500 }}>{t("总计:")}</span>
              <span style={{ fontSize: 28, fontWeight: 700, color: colors.black, letterSpacing: "-1px" }}>{currencySymbol}{priceNum}</span>
            </div>
          </div>

          {showPaymentMethod && (
            <div
              style={{
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: "16px 20px",
                marginBottom: 24,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: `2px solid ${colors.primary}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: colors.primary }} />
              </div>
              <svg viewBox="0 0 24 24" style={{ width: 22, height: 22, flexShrink: 0 }}>
                <circle cx="12" cy="12" r="12" fill="#07C160" />
                <path d="M17.2 10.8c-.4-2.1-2.5-3.6-5-3.6-2.8 0-5.1 1.9-5.1 4.3 0 1.4.8 2.6 2 3.5l-.5 1.5 1.8-1c.6.2 1.2.3 1.8.3.3 0 .5 0 .8-.1-.2-.4-.2-.8-.2-1.2 0-2.1 2-3.7 4.4-3.7z" fill="#fff" />
                <path d="M19.5 14.5c0-1.7-1.7-3.1-3.8-3.1s-3.8 1.4-3.8 3.1 1.7 3.1 3.8 3.1c.4 0 .9-.1 1.3-.2l1.2.7-.3-1.1c1-0.6 1.6-1.5 1.6-2.5z" fill="#fff" />
              </svg>
              <span style={{ fontSize: 14, fontWeight: 500, color: colors.black }}>{t("微信支付")}</span>
            </div>
          )}

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={onCancel}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                background: colors.white,
                color: colors.black,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
            >
              {t("取消")}
            </button>
            <button
              onClick={onPay}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              {actionLabel ?? `${t("支付")} ${currencySymbol}${priceNum}`}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Credit Card Confirm Order Modal（国际站）─── */

/**
 * 国际站信用卡确认订单弹窗。
 *
 * 与国内站微信版 ConfirmOrderModal 并列，由渲染点按编译期常量 isGlobal 分流：
 * 国内包不会打进本组件，国际包不会打进微信版（tree-shaking）。
 *
 * 本组件为纯前端 UI / 交互还原（不接后端）：
 *   - 订单明细：Subtotal / Tax / Total
 *   - 支付方式：仅信用卡（Credit card）
 *   - 信用卡下「自动续费（Auto-renew）」开关；开关开启且未绑卡时，
 *     提示绑卡并拦截支付，点击「Bind card」进入绑卡表单
 *   - 绑卡为前端演示：卡片状态仅在弹窗生命周期内维护，不落库、不发请求
 *
 * 金额三行口径（后端计费字段，单位分，见 BundlePrice.tax_price 注释）：
 *   小计 ← 折后价（real_total_cost - tax_price，与卡片价同源）；税费 ← tax_price（未下发视为 0）；
 *   合计 ← real_total_cost（含税实付）直接展示，不做前端加总。
 * 原价与折扣差不展示（不单列折扣行），弹窗内不出现原价。
 */

export const CreditCardConfirmOrderModal = ({
  plan,
  billingPeriodLabel,
  demoMode = false,
  paying = false,
  onCancel,
  onPay,
}: {
  plan: PlanInfo;
  billingPeriodLabel: string;
  /** 纯前端演示：点「Pay」不调后端下单，直接在弹窗内展示支付成功（国际站占位付费卡放开场景）。 */
  demoMode?: boolean;
  /** 支付处理中（onPay 已触发、后端 order-and-pay 未返回）：禁用按钮防重复下单扣款。 */
  paying?: boolean;
  onCancel: () => void;
  /** 确认支付；autoRenew = 用户是否开启自动续费（透传后端 auto_renew_flag） */
  onPay: (autoRenew: boolean) => void;
}) => {
  const t = useT();
  const [view, setView] = useState<"order" | "success">("order");

  /* 有 priceDetail（登录态真实计费）时三行全部用后端真源：
     小计=折后价（real_total_cost - tax_price，与卡片价同源）、税费=tax_price、
     合计=real_total_cost（含税实付）直显。
     合计不做前端加总——分转元的舍入误差与后端未来的调整项都会让加总对不上实付。
     无 priceDetail（demoMode 占位卡 / 静态价）时退化为旧视觉：tax=0、合计=小计。 */
  const subtotal = plan.priceDetail
    ? plan.priceDetail.subtotalCents / 100
    : parseFloat(plan.price.replace(/[^0-9.]/g, "")) || 0;
  const tax = plan.priceDetail ? plan.priceDetail.taxCents / 100 : 0;
  const total = plan.priceDetail ? plan.priceDetail.totalCents / 100 : subtotal + tax;
  /* 币种符号必须跟随 plan.price，不能硬编码 "$"：
     plan.price 由 formatYuan(displayPriceYuan, bundle.price.currency) 产出，
     而 currency 走 `bundle.price?.currency ?? "CNY"` 兜底。
     国际站正常路径后端下发 currency=USD（trade 按 LIGHTVELA_SITE_KIND 分流，intl=USD / cn=CNY），
     但一旦该字段缺失或为其他币种，formatYuan 会输出「¥45.00」/「7500 KRW」，
     此处 parseFloat 剥离符号后若再用固定 "$" 重排，就会把非美元价展示成美元价（金额误导）。
     判定方式与本文件 PlanCard 的 currencySymbol 保持一致。 */
  const currencySymbol = plan.price.trim().startsWith("$") ? "$" : "¥";
  const fmt = (n: number) => `${currencySymbol}${n.toFixed(2)}`;

  const handlePayClick = () => {
    /* 纯前端演示：不调后端下单，直接展示支付成功 */
    if (demoMode) { setView("success"); return; }
    /* 国际站信用卡为订阅制，固定开启自动续费。
       注意 auto_renew_flag 只影响新购订单的 goodsDetail.autoRenewFlag，
       是否发起签约（ContractOrder）由后端查询用户绑卡状态决定，与此值解耦。
       见 codesign/ctl-frontend-billing-api.md「国际站支付模式」。 */
    onPay(true);
  };

  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onCancel}
    >
      <motion.div
        style={modalPanelStyle}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          style={modalCloseStyle}
          onClick={onCancel}
          aria-label={t("关闭")}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        {view === "success" ? (
          /* ─── Payment success view（纯前端演示）─── */
          <div style={{ padding: "36px 28px 28px", textAlign: "center" }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                background: colors.primary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 18px",
              }}
            >
              <Check style={{ width: 30, height: 30, color: colors.white }} strokeWidth={3} />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 6px", letterSpacing: "-0.25px" }}>
              {t("支付成功")}
            </h3>
            <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 4px" }}>
              {t("你已订阅「{{plan}}」套餐。", { plan: plan.name })}
            </p>
            <p style={{ fontSize: 20, fontWeight: 700, color: colors.black, margin: "8px 0 24px", letterSpacing: "-0.5px" }}>
              {fmt(total)}
              <span style={{ fontSize: 13, fontWeight: 500, color: colors.warmGray500 }}> {billingPeriodLabel}</span>
            </p>
            <button
              onClick={onCancel}
              style={{ width: "100%", padding: "12px 16px", borderRadius: 8, border: "none", background: colors.primary, color: colors.white, fontSize: 15, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              {t("关闭")}
            </button>
          </div>
        ) : view === "order" ? (
          <div style={{ padding: "28px 28px 24px" }}>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 6px", letterSpacing: "-0.25px" }}>
              {t("确认订单")}
            </h3>
            <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 20px" }}>{t("请核对以下订单信息")}</p>

            {/* Order summary */}
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 14, color: colors.warmGray500 }}>
                <span>{t("「{{plan}}」套餐", { plan: plan.name })}</span>
                {/* 套餐行展示折后价（与小计行同源同值，= real_total_cost - tax_price）。 */}
                <span style={{ fontWeight: 600, color: colors.black }}>{fmt(subtotal)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: 14, color: colors.warmGray500 }}>
                <span>{t("计费周期")}</span>
                <span style={{ fontWeight: 600, color: colors.black }}>{billingPeriodLabel}</span>
              </div>
              <div style={{ height: 1, background: colors.border, margin: "0 0 16px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 13, color: colors.warmGray500 }}>
                <span>{t("小计")}</span>
                <span>{fmt(subtotal)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16, fontSize: 13, color: colors.warmGray500 }}>
                <span>{t("税费")}</span>
                <span>{fmt(tax)}</span>
              </div>
              <div style={{ height: 1, background: colors.border, margin: "0 0 16px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 14, color: colors.warmGray500 }}>{t("合计")}</span>
                <span style={{ fontSize: 28, fontWeight: 700, color: colors.black, letterSpacing: "-1px" }}>{fmt(total)}</span>
              </div>
            </div>

            {/* Payment method */}
            <div style={{ fontSize: 12, fontWeight: 600, color: colors.warmGray500, margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.4px" }}>
              {t("支付方式")}
            </div>
            <div style={{ border: `1px solid ${colors.primary}`, borderRadius: 12, padding: "16px 20px", marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${colors.primary}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: colors.primary }} />
                </div>
                <CreditCard style={{ width: 20, height: 20, flexShrink: 0, color: colors.black }} />
                <span style={{ fontSize: 14, fontWeight: 500, color: colors.black }}>{t("信用卡")}</span>
              </div>

              <div style={{ height: 1, background: colors.border, margin: "16px 0" }} />

              {/* 自动续费说明：国际站信用卡为订阅制，不提供一次性购买，
                  因此这里是只读告知而非开关——给一个点了会被拦的假开关只会浪费用户一次点击。 */}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <RefreshCw style={{ width: 16, height: 16, flexShrink: 0, marginTop: 2, color: colors.primary }} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.black }}>{t("自动续费")}</div>
                  <div style={{ fontSize: 12, color: colors.warmGray500, marginTop: 2, lineHeight: 1.6 }}>
                    {t("订阅将在每个计费周期结束时自动续费，可随时在账号管理页取消。")}
                  </div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={onCancel}
                style={{ flex: 1, padding: "12px 16px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, color: colors.black, fontSize: 15, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
              >
                {t("取消")}
              </button>
              <button
                onClick={handlePayClick}
                disabled={paying}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: paying ? colors.warmGray300 : colors.primary,
                  color: colors.white,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: paying ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (!paying) e.currentTarget.style.background = colors.primaryHover; }}
                onMouseLeave={(e) => { if (!paying) e.currentTarget.style.background = colors.primary; }}
              >
                {paying ? t("处理中...") : t("支付 {{amount}}", { amount: fmt(total) })}
              </button>
            </div>
          </div>
        ) : null}
      </motion.div>
    </motion.div>
  );
};

/* ─── Payment Pending Modal ─── */

/**
 * 付费进行中弹窗——取代原来的 mock 微信二维码。
 * 弹窗期间后台轮询 listMyPasses，轮询到有效 pass 后自动 finalizeBot 接棒，
 * 用户无需任何手动确认按钮。
 */
const PaymentPendingModal = ({
  bridgeUrl,
  redirectUrl,
  onCancel,
  onRefresh,
  refreshing,
  timedOut = false,
  provisioningOnly = false,
  t,
}: {
  /** 国内站：中转页绝对 URL，用作 QRCode value */
  bridgeUrl?: string;
  /** 国际站：信用卡 hosted page URL（pay_url），用于「重新打开支付页」 */
  redirectUrl?: string;
  onCancel: () => void;
  /** 「刷新」按钮：重新生成二维码（重新下单换新 auth_code）— 仅国内站 bridge 模式 */
  onRefresh: () => void;
  /** 刷新进行中（重新下单的网络往返期间），用于禁用按钮防止重复请求 */
  refreshing: boolean;
  /** 轮询已超时：后台发货延迟，改为提示用户稍后重试而不是一直转圈 */
  timedOut?: boolean;
  /** 点石零元单已完成下单并支付，只等待 Pass 发货。 */
  provisioningOnly?: boolean;
  t: (zh: string, opts?: Record<string, unknown>) => string;
}) => {
  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onCancel}
    >
      <motion.div
        style={{ ...modalPanelStyle, maxWidth: 440 }}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          style={modalCloseStyle}
          onClick={onCancel}
          aria-label={t("关闭")}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 6px", letterSpacing: "-0.25px" }}>
            {timedOut ? t("正在开通，请稍候") : provisioningOnly ? t("正在开通套餐") : t("请完成支付")}
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 24px" }}>
            {timedOut
              ? t("已收到你的支付，套餐开通稍有延迟，本页会自动完成开通，请勿关闭。")
              : provisioningOnly
                ? t("订单已提交，正在等待套餐开通，完成后将自动跳转")
              : bridgeUrl
                ? t("请使用微信扫描下方二维码完成支付")
                /* 支付回跳场景没有 redirectUrl（原窗口已被替换），此时是在等后台发货，
                   不能再说「支付页已在新窗口打开」。 */
                : redirectUrl
                  ? t("信用卡支付页已在新窗口打开，完成支付后本页将自动跳转")
                  : t("正在确认支付结果并开通套餐，完成后将自动跳转")}
          </p>

          {/* 国内站 bridge 模式：渲染中转页 URL 的二维码，用户在微信扫码后由中转页负责走 OAuth + wxSign */}
          {bridgeUrl && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                marginBottom: 20,
                padding: 16,
                borderRadius: 12,
                background: colors.warmWhite,
              }}
            >
              <QRCodeSVG value={bridgeUrl} size={180} level="M" includeMargin={false} />
            </div>
          )}

          {/* 国际站信用卡模式：展示支付页已打开的提示 */}
          {redirectUrl && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                marginBottom: 20,
                padding: 24,
                borderRadius: 12,
                background: colors.warmWhite,
              }}
            >
              <CreditCard style={{ width: 36, height: 36, color: colors.primary }} />
              <span style={{ fontSize: 13, color: colors.warmGray500 }}>{t("信用卡支付")}</span>
            </div>
          )}

          {/* 支付回跳等发货：既没有二维码也没有 pay_url，用 loading 表达「正在开通」 */}
          {!bridgeUrl && !redirectUrl && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                marginBottom: 20,
                padding: 24,
                borderRadius: 12,
                background: colors.warmWhite,
              }}
            >
              {timedOut
                ? <Clock style={{ width: 36, height: 36, color: colors.primary }} />
                : <Loader2 className="animate-spin" style={{ width: 36, height: 36, color: colors.primary }} />}
              <span style={{ fontSize: 13, color: colors.warmGray500 }}>
                {timedOut ? t("开通中") : t("正在开通套餐")}
              </span>
            </div>
          )}

          <p style={{ fontSize: 13, color: colors.warmGray500, textAlign: "center", margin: "0 0 20px" }}>
            {timedOut ? t("如长时间未开通，请联系客服") : t("支付完成后，需等待约15秒完成下单")}
          </p>

          {/* 底部按钮区：国内站「刷新」重新生成二维码；国际站「重新打开支付页」 */}
          <div style={{ display: "flex", flexDirection: "row", gap: 12 }}>
            {bridgeUrl ? (
              <button
                onClick={onRefresh}
                disabled={refreshing}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: `1px solid ${colors.primary}`,
                  background: colors.white,
                  color: colors.primary,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: refreshing ? "not-allowed" : "pointer",
                  opacity: refreshing ? 0.6 : 1,
                  transition: "background 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => {
                  if (refreshing) return;
                  e.currentTarget.style.background = colors.warmWhite;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = colors.white;
                }}
              >
                {refreshing ? t("刷新中...") : t("刷新")}
              </button>
            ) : redirectUrl ? (
              <button
                onClick={() => {
                  window.open(redirectUrl, "_blank", "noopener,noreferrer");
                }}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: `1px solid ${colors.primary}`,
                  background: colors.white,
                  color: colors.primary,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
              >
                {t("重新打开支付页")}
              </button>
            ) : null}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Subscribe Page ─── */

/**
 * 弹窗状态机：
 *   - closed   ：无弹窗
 *   - confirm  ：订单确认弹窗（仅国内站付费链路）
 *   - paying   ：已通过 tcb-jssdk 拉起 Midas 收银台（页内二维码 / 兜底新窗口），等待用户支付完成
 *
 * 注：v1.7.30 后端联调文档明确「前端不需要轮询支付状态」——
 * 实际以 paying 阶段的 listMyPasses 轮询为准，自动 finalizeBot，无需用户手动确认。
 */
type ModalStep = "closed" | "confirm" | "paying";

type SubscribeError = {
  code?: string | null;
  message: string;
  action?: {
    label: string;
    href: string;
  };
};

type SubscribePageProps = {
  authControls?: ReactNode;
  publicLocale?: PublicSiteLocale;
  publicLocalized?: boolean;
  renderLanguageSwitcher?: (options: { activeLocale: PublicSiteLocale; reloadAfterSwitch: boolean; variant: LanguageSwitcherVariant }) => ReactNode;
  renderLink?: RenderPublicSiteHeaderLink;
};

/** v1.7.30 后端允许轮询 listMyPasses 检测支付是否完成，间隔 / 超时控制 */
const PAY_POLL_INTERVAL_MS = 3000;
const PAY_POLL_TIMEOUT_MS = 180_000;

/**
 * 支付回跳标记：国际站信用卡的占位窗口被弹窗拦截时，会用
 * window.location.assign 替换当前页去支付，付款后 return_url 回到的是全新页面，
 * 原窗口的 paying 轮询已经销毁。带上这两个 query 才能在回跳页重新接棒
 * 「等后台发货 → 自动创建实例 → 跳实例管理页」。
 */
const PAY_RETURN_QUERY_KEY = "pay_return";
const PAY_RETURN_PLAN_QUERY_KEY = "pay_plan";

export const SubscribePage = ({
  authControls,
  publicLocale,
  publicLocalized,
  renderLanguageSwitcher,
  renderLink = renderAppHeaderLink,
}: SubscribePageProps = {}) => {
  const t = useT();
  /* i18n 静态标记：BUNDLE_TYPE_TABS 里的 zhLabel 是动态变量，extract 脚本扫不到 t() 调用，
     这里在组件函数体顺序执行一次，与 t 同生命周期，避免放在 useEffect 的异步路径里漏扣。 */
  __markBundleTypeTabsForI18n(t);
  const navigate = useAppNavigate();
  const { isLoggedIn, isSubscribed, subscribe, addBot, bots, user, refreshPasses, activePass, latestPass } = useOpenClaw();
  const { authReady, isAuthenticated, session } = useSession();
  const repositories = useRepositories();
  const [subscribingPlanId, setSubscribingPlanId] = useState<string | null>(null);
  /* 未登录用户点「订阅」时弹出的登录引导弹窗开关（见 handleSubscribe）。 */
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [error, setError] = useState<SubscribeError | null>(null);
  const [modalStep, setModalStep] = useState<ModalStep>("closed");
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);
  /* 邀请码守卫：未激活邀请码时拦截「立即开通」，弹窗输入后自动继续 */
  const [showInviteCode, setShowInviteCode] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PlanInfo | null>(null);
  /* 从后端加载的套餐列表 */
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [bundlesLoading, setBundlesLoading] = useState(false);
  const [bundlesError, setBundlesError] = useState<string | null>(null);

  /* 付费时长（月付 / 季付）；切换时会触发 listBundles 用新时长重拉价格。默认月付。
     作用于所有可购买套餐（general / ai），与卡内积分档位切换正交。 */
  const [aiDurationKey, setAiDurationKey] = useState<AiDurationTabDef["key"]>("monthly");
  const aiDuration = useMemo(
    () => AI_DURATION_TABS.find((d) => d.key === aiDurationKey) ?? AI_DURATION_TABS[0],
    [aiDurationKey],
  );

  const paidBillingEnabled = usePaidBillingEnabled();
  const paidBillingActive = isPaidBillingEnabled(paidBillingEnabled);
  const realnamePhoneVerificationEnabled = useRealnamePhoneVerificationEnabled();
  /* 「免费开通」引导前提：付费计费开关与实名手机验证开关必须同时关闭。
     国际站已全量放开，付费开关只由后端 features 熔断；
     任一最终生效的门禁开启时不做免费引导，CTA 维持「立即开通」。 */
  const freeGuideAllowed = !paidBillingActive && !realnamePhoneVerificationEnabled;
  const header = (
    <SubscribePageHeader
      authControls={authControls}
      authReady={authReady}
      isAuthenticated={isAuthenticated}
      publicLocale={publicLocale}
      publicLocalized={publicLocalized}
      renderLanguageSwitcher={renderLanguageSwitcher}
      renderLink={renderLink}
    />
  );

  /* 功能点2b：进入订阅页不再强制登录，允许未登录用户浏览静态价格。
     登录引导下沉到点「订阅」按钮时（见 handleSubscribe）。 */

  /* 拉取上线套餐列表（GET /v1/bundles）
     计费开关开启且当前为非默认时长时，携带 { time_span, time_unit } 询价参数；
     其他情况保持无参调用（老逻辑，含未开启计费开关的国际站占位卡场景）。

     加载策略（避免首屏多余请求）：
       - selectedBundleTab === null（首屏未初始化）：无参加载一次
       - paidBillingActive && 非默认时长（如季付）：带参重拉覆盖价格
       - paidBillingActive && 月付（默认）：复用首屏无参结果
         （已与后端约定：无参调用 == time_span=1&time_unit=m 的月付定价）
       - selectedBundleTab 变为其他 tab：不再重复拉取（数据已有，切 tab 只做前端分组）

     使用 loadKey 显式表达「要拉哪批数据」，只在 loadKey 变化时触发。
     ⚠️ 契约：loadKey 必须是稳定字符串——默认月付一律映射到 "__initial__"，
     依赖 useEffect 依赖 diff 机制实现「切回已加载过的场景不重拉」。
     修改本处务必保持这一映射稳定，否则会破坏首屏请求次数优化。

     retryToken 用于错误重试：++retryToken 会让 loadKey 变更 → useEffect 重跑，
     自然享受同一套 cancelled 竞态保护，无需重复抽取加载函数。 */
  const [retryToken, setRetryToken] = useState(0);
  /* 是否需要带参询价：仅当计费开关开启且选中非默认时长（当前即季付）时为 true。
     月付为默认，与首屏无参调用返回的价格等价，直接复用即可。
     注：不再区分 bundle_type——general / ai 等所有付费套餐共用同一份询价结果，
     后端已确认所有 bundle_type 都支持 { time_span, time_unit } 询价。 */
  const needsExplicitDurationPriceQuery =
    paidBillingActive && aiDurationKey !== "monthly";
  const loadKey = useMemo(() => {
    /* 登录态必须参与 loadKey：未登录走前端静态定价表、已登录走后端询价；
       auth 就绪 / 登录态翻转时触发 useEffect 重跑，重新选择数据来源。 */
    const authSeg = !authReady ? "authpending" : isAuthenticated ? "auth" : "anon";
    const base = needsExplicitDurationPriceQuery
      ? `paid:${aiDurationKey}`
      : "__initial__";
    return `${authSeg}#${base}#${retryToken}`;
  }, [authReady, isAuthenticated, needsExplicitDurationPriceQuery, aiDurationKey, retryToken]);

  useEffect(() => {
    let cancelled = false;
    /* 功能点2b：未登录不请求后端（匿名调用 price 返回 null，会全线落到「暂无报价」+ 按钮禁用），
       直接用前端静态定价表填充，使未登录静态展示与登录后询价展示保持一致；
       登录引导下沉到点「订阅」按钮时（见 handleSubscribe 的 !isLoggedIn → login()）。 */
    if (authReady && !isAuthenticated) {
      setBundles(buildStaticBundles(aiDurationKey));
      setBundlesError(null);
      setBundlesLoading(false);
      return () => {
        cancelled = true;
      };
    }
    /* 登录态尚未就绪：先保持 loading，避免「先闪静态价、再闪询价价」的跳变；
       authReady 后 loadKey 变更会重跑本 effect 选择正确来源。 */
    if (!authReady) {
      setBundlesLoading(true);
      return () => {
        cancelled = true;
      };
    }
    const run = async () => {
      setBundlesLoading(true);
      setBundlesError(null);
      try {
        const list = await repositories.plans.listBundles(
          needsExplicitDurationPriceQuery
            ? { time_span: aiDuration.period, time_unit: aiDuration.time_unit }
            : undefined,
        );
        if (!cancelled) {
          setBundles(list);
        }
      } catch (err) {
        if (!cancelled) {
          const code = getBillingErrorCode(err);
          const rawMessage = err instanceof Error ? err.message : "";
          const isUnauthorized = code === "unauthorized" || /unauthorized/i.test(rawMessage);
          setBundlesError(isUnauthorized ? t("请先登录") : rawMessage || t("套餐列表加载失败"));
        }
      } finally {
        if (!cancelled) {
          setBundlesLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  /* 映射成 PlanInfo，保留原 bundle 用于后续时用 bundle_id 调购买 */
  const planList = useMemo<PlanInfo[]>(() => {
    if (!bundles) return [];
    /* 灰度门控：
       - paidBillingActive=false：只展示免费试用 bundle，保持现网用户走 CreateTrialPass 免费链路。
       - paidBillingActive=true：隐藏免费试用 bundle，只展示 general / ai 等付费 bundle，测试账号走付费链路。
       这里是前端展示与路由门控，不是安全边界；严格账号 allowlist 仍应由后端兜底。 */
    const displayable = paidBillingActive
      ? bundles.filter((b) => !isFreeTrialBundle(b))
      : bundles.filter(isFreeTrialBundle);
    /* 询价中中间态识别：仅当已存在旧数据 (bundles != null) 且此刻仍在加载时才成立。
       - 首屏加载：bundles 为 null，走上层 loader 分支，不会走到这里
       - 切换 durationKey：bundles 保留旧数据、bundlesLoading=true → 触发占位符
       - 加载完成：bundlesLoading=false，恢复正常渲染
       仅对 paidBillingActive 生效由 mapBundleToPlan 内部 paid 门控进一步收敛。 */
    const isPricingLoading = bundlesLoading;
    const fromBackend = displayable.map((b, idx) => {
      /* 保留 isSubscribed / freeGuideAllowed 两个参数，用于启航版卡片「免费开通」引导文案与内测免费副标题门控。 */
      const plan = mapBundleToPlan(
        b,
        idx,
        t,
        paidBillingActive,
        aiDurationKey,
        isPricingLoading,
        isSubscribed || bots.length > 0,
        freeGuideAllowed,
        /* 已订阅套餐的 bundle_id：命中当前卡时 CTA 显示「当前订阅」。
           activePass 为 null（pass 过期）时回退到 latestPass，仍能匹配用户曾订阅的套餐。 */
        activePass?.bundle_id ?? latestPass?.bundle_id ?? null,
        isLoggedIn,
      );
      return paidBillingActive ? plan : { ...plan, bundleType: undefined };
    });
    if (paidBillingActive) return fromBackend;
    /* 免费链路保留两张前端占位套餐；同时抹掉 bundleType，让免费卡和占位卡同屏展示，不出现付费分组 tab。 */
    const placeholders = buildPlaceholderPlans(t).map((plan) => ({ ...plan, bundleType: undefined }));
    return [...fromBackend, ...placeholders];
    /* aiDurationKey 影响 priceUnit 文案（/月 vs /年），必须进依赖数组；
       bundlesLoading 影响询价中占位符，也必须进依赖数组；
       isSubscribed 影响启航 Launch 卡的「免费开通/立即开通」引导文案，必须进依赖数组；
       freeGuideAllowed 是「免费开通」引导的前提开关，同样影响文案，必须进依赖数组；
       正常路径下切换时长会先触发 loadKey → bundlesLoading 变更连带重算。 */
  }, [bundles, bundlesLoading, paidBillingActive, t, aiDurationKey, isSubscribed, bots.length, freeGuideAllowed, activePass?.bundle_id, latestPass?.bundle_id, isLoggedIn]);

  /**
   * 需求3：按 tier（启航 / 巡游）把 planList 分组，取代原「标准版 / AI 增强版」全局 tab。
   *   - 同 tier 的标准版 / AI 增强版收敛为一张卡的多个 variants（按积分升序），卡内切换（见 PlanCard）
   *   - tier 顺序固定：启航 → 巡游
   *   - 未命中 tier 的套餐（如免费试用卡）各自单卡展示，追加在后，保持 planList 原顺序
   */
  const planTiers = useMemo<PlanTierGroup[]>(() => {
    const tierMap = new Map<PlanTierKey, PlanInfo[]>();
    const uncategorized: PlanInfo[] = [];
    for (const plan of planList) {
      if (isRetiredVoyagePlan(plan)) continue;
      const tk = tierOfPlan(plan);
      if (tk) {
        if (!tierMap.has(tk)) tierMap.set(tk, []);
        tierMap.get(tk)!.push(plan);
      } else {
        uncategorized.push(plan);
      }
    }
    const groups: PlanTierGroup[] = [];
    for (const tk of PLAN_TIER_ORDER) {
      const variants = tierMap.get(tk);
      if (!variants || variants.length === 0) continue;
      /* 按积分升序：标准版（积分少）在左，AI 增强版（积分多）在右 */
      const sorted = [...variants].sort((a, b) => (a.raw.credit ?? 0) - (b.raw.credit ?? 0));
      /* AI 增强版可见性：启航 / 巡游的 AI 档位（月付 / 季付）均展示价格 + 下单入口。
         - 已登录：保留后端真实价格 / 促销 / 下单入口，积分取后端 bundle.credit。
         - 未登录：走 buildStaticBundles 的国际站静态美元价，展示新用户
           实付价 + 原价删除线 + 对应促销标签；CTA 点击仍只引导登录。 */
      groups.push({ key: tk, variants: sorted });
    }
    for (const plan of uncategorized) {
      groups.push({ key: plan.id, variants: [plan] });
    }
    return groups;
  }, [planList, t]);

  /* 付费过程上下文：国内站走 bridge 中转页二维码方案；国际站走信用卡 hosted page 跳转。
     保存当前订单 deal_names + 已选套餐 + 支付页 URL，供 PaymentPendingModal 渲染。 */
  const [paymentContext, setPaymentContext] = useState<{
    plan: PlanInfo;
    dealNames: string[];
    /** 国内站：中转页二维码 URL */
    bridgeUrl?: string;
    /** 国际站：信用卡 hosted page URL（getPassOrderUrl 返回的 pay_url） */
    redirectUrl?: string;
    /** 点石零元下单已完成，仅等待发货。 */
    provisioningOnly?: boolean;
  } | null>(null);

  /* 轮询超时标记：后台发货延迟超过 PAY_POLL_TIMEOUT_MS 时不静默停住，
     改为在 PaymentPendingModal 提示「已收到支付、开通稍有延迟」并给手动重试入口。

     重置时机放在「进入 paying」这一状态迁移处，而不是轮询 effect 体内：
     该 effect 依赖 refreshPasses / t，它们引用变化会让 effect 重跑，
     若在体内重置就会连同 startedAt 一起复位，导致超时提示永远不出现、轮询无限续命。 */
  const [payPollTimedOut, setPayPollTimedOut] = useState(false);
  useEffect(() => {
    if (modalStep === "paying") setPayPollTimedOut(false);
  }, [modalStep]);

  /* 引用快照供 useCallback 中读取最新 paymentContext，避免重复触发依赖 */
  const paymentContextRef = useRef(paymentContext);
  paymentContextRef.current = paymentContext;

  /* isSubscribed / finalizeBot 的 ref 镜像 — 给付费轮询 effect 用：
     setInterval 闭包必须读最新值才能正确判断「是否已拿到 active pass」；
     而 effect 又不能把它们放进依赖数组，否则会因 isSubscribed 翻转 / finalizeBot 重建
     反复销毁重建 timer，浪费请求 + 错过窗口 */
  const isSubscribedRef = useRef(isSubscribed);
  isSubscribedRef.current = isSubscribed;

  /* bots 的 ref 镜像 — 给 finalizeBot 的幂等保护用：
     原窗口轮询与支付回跳页轮询可能同时命中同一个已发货 pass，
     若不拦截会各建一个实例（用户还要为多余实例付费）。 */
  const botsRef = useRef(bots);
  botsRef.current = bots;

  /* finalizeBot 的执行闸门：同一次支付只允许创建一个实例。
     用 ref 而非 state：轮询回调里必须同步读到最新值，state 异步更新拦不住并发。 */
  const finalizingRef = useRef(false);

  /* 重复使用的收尾逻辑：addBot + subscribe + navigate 。
     供多个链路（免费试用 / 付费下单后 / 支付回跳）复用 */
  const finalizeBot = useCallback(async (plan: PlanInfo) => {
    /* 幂等闸门①：拦并发。原窗口轮询与支付回跳页轮询可能同时命中同一个已发货 pass。
       注意闸门只覆盖单次执行窗口，finally 里必须复位：
       这是 SPA，用户从 /agents 返回订阅页时组件不会重新挂载、ref 会保留，
       若成功后不复位，用户下次购买会在第一行被静默 return，付了钱却毫无反应。
       防「重复创建」靠的是下面的闸门②，不是这个标志位。 */
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    try {
      /* 幂等闸门②：账号下已有实例说明发货后实例已建好（如原窗口先完成、或用户重复回跳），
         此时只做跳转，不再创建。 */
      const existingBot = botsRef.current[0];
      if (existingBot) {
        subscribe();
        setModalStep("closed");
        setSelectedPlan(null);
        setPaymentContext(null);
        navigate(getAgentCreatingPath(existingBot.id));
        return;
      }
      const createdBot = await addBot({
        name: "我的Hermes",
        personality: "默认设定",
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
      });
      captureProductEvent(PRODUCT_ANALYTICS_EVENTS.AGENT_CREATE_SUCCEEDED, {
        plan_id: plan.id,
        plan_name: plan.name,
        bot_status: createdBot.status,
      });
      trackDatongEvent(DATONG_EVENTS.SUBSCRIBE_PAY_SUCCESS, {
        pgid: DATONG_PAGE_IDS.SUBSCRIBE,
        params: {
          plan: plan.id,
          plan_name: plan.name,
        },
      });
      trackDatongEvent(DATONG_EVENTS.AGENT_CREATE_SUCCESS, {
        pgid: DATONG_PAGE_IDS.SUBSCRIBE,
        params: {
          bot_id: createdBot.id,
          plan: plan.id,
        },
      });
      subscribe();
      setModalStep("closed");
      setSelectedPlan(null);
      setPaymentContext(null);
      navigate(getAgentCreatingPath(createdBot.id));
    } finally {
      /* 无论成功失败都复位：失败时后续轮询要能重试，
         成功时用户可能返回本页再次购买（SPA 不重新挂载，ref 会保留）。 */
      finalizingRef.current = false;
    }
  }, [addBot, subscribe, navigate]);

  /**
   * 免费试用链路 — 仅国际站 / 存在老 pass 的内测场景。
   * 逻辑保持 P3 之前的原状：POST /v1/passes 走免费试用，PASS_ALREADY_EXISTS 不作错误
   */
  const startTrialPass = useCallback(async (plan: PlanInfo) => {
    if (!isSubscribed) {
      try {
        await repositories.plans.createPass(plan.raw.bundle_id);
        await refreshPasses();
      } catch (passErr) {
        if (!isPassConflictError(getBillingErrorCode(passErr))) {
          throw passErr;
        }
        await refreshPasses();
      }
    }
    await finalizeBot(plan);
  }, [isSubscribed, repositories.plans, refreshPasses, finalizeBot]);

  /**
   * 付费下单链路 — 仅国内站。CodeBuddy AuthCode 安全模型：
   *
   *   阶段一（PC 端）：调 createPassOrder 拿 { deal_names, auth_code }
   *   阶段二（中转页）：buildPayPlan 直接用 dealName + authCode 编二维码；
   *                     用户扫码后中转页用 wx_code + auth_code 调 getPassOrderUrl
   *                     拿 pay_url，再调 wxSign 拉起委托划扣。
   *
   * **PC 端不再调 getPassOrderUrl** —— 因为 jifei pay_url 生成时绑定 wx_open_id，
   * PC 端没有 wx_open_id，提前调只能拿到错误的 url（与 CodeBuddy 一致）。
   *
   * 零元订单（need_charge === 0）改由中转页判定：中转页拿到 getPassOrderUrl 响应后
   * 走「已完成」分支，PC 端继续轮询 listMyPasses 接棒 finalize。
   *
   * 安全：二维码里**只有 deal_name + auth_code + expires_at**，无 Bearer token、无 pay_url；
   * auth_code 是一次性 ticket（TTL ≤10 分钟），截图泄漏的最坏后果是替受害者发起一次支付。
   *
   * 注意：如果用户已拥有 active pass（互斥占用规则），trade 会返回 PASS_ALREADY_EXISTS，
   * 此时跳过下单、直接走 finalizeBot（与免费链路一致）。
   */
  const startPaidPassOrder = useCallback(async (plan: PlanInfo) => {
    trackDatongEvent(DATONG_EVENTS.SUBSCRIBE_CHECKOUT_START, {
      pgid: DATONG_PAGE_IDS.SUBSCRIBE,
      params: {
        plan: plan.id,
        plan_name: plan.name,
        billing_period: paidBillingActive ? aiDuration.period : plan.raw.time_span,
      },
    });
    if (isSubscribed) {
      /* 已有有效 pass，直接创建实例即可 */
      await finalizeBot(plan);
      return;
    }
    /* 阶段一：下单拿 deal_names + auth_code
       计费开关开启时：所有 bundle_type 统一使用当前选中的付费时长（AI_DURATION_TABS 状态即全局时长选择），
       未开启计费开关时沿用 bundle 自带 time_span/time_unit（老逻辑）。 */
    const useAiDuration = paidBillingActive;
    const order = await repositories.plans.createPassOrder({
      bundle_id: plan.raw.bundle_id,
      period: useAiDuration ? aiDuration.period : plan.raw.time_span,
      time_unit: useAiDuration ? aiDuration.time_unit : plan.raw.time_unit,
    });

    /* 把 deal_name + auth_code + bundleName 编进二维码 URL；
       中转页拿到后用 wx_code + auth_code 调 getPassOrderUrl 拉 pay_url */
    const payPlan = buildPayPlan({
      dealName: order.deal_names[0] ?? "",
      authCode: order.auth_code,
      bundleName: plan.raw.bundle_name,
    });

    /* bridge：渲染二维码，用户微信扫码 → 中转页支付，PC 端轮询 listMyPasses 接棒 finalize */
    setPaymentContext({ plan, dealNames: order.deal_names, bridgeUrl: payPlan.bridgeUrl });
    setSelectedPlan(plan);
    setModalStep("paying");
  }, [isSubscribed, repositories.plans, finalizeBot, paidBillingActive, aiDuration]);

  const startDianshiOrderAndPay = useCallback(async (plan: PlanInfo) => {
    trackDatongEvent(DATONG_EVENTS.SUBSCRIBE_CHECKOUT_START, {
      pgid: DATONG_PAGE_IDS.SUBSCRIBE,
      params: {
        plan: plan.id,
        plan_name: plan.name,
        billing_period: aiDuration.period,
      },
    });
    if (isSubscribed) {
      await finalizeBot(plan);
      return;
    }

    const order = await repositories.plans.createDianshiPassOrderAndPay({
      bundle_id: plan.raw.bundle_id,
      period: aiDuration.period,
      time_unit: aiDuration.time_unit,
    });
    setPaymentContext({
      plan,
      dealNames: [order.deal_name],
      provisioningOnly: true,
    });
    setSelectedPlan(plan);
    setModalStep("paying");
    await refreshPasses();
  }, [aiDuration, finalizeBot, isSubscribed, refreshPasses, repositories.plans]);

  /**
   * 国际站信用卡支付链路（正式）。
   *
   * 与国内站 startPaidPassOrder 的区别：不走微信扫码，走信用卡 hosted page 跳转：
   *   1. createPassOrder 拿 deal_names
   *   2. getPassOrderUrl（PC 端 Bearer）拿 pay_url（信用卡支付页 URL）+ need_charge
   *   3. need_charge=0 时零元订单已支付成功，直接接棒 finalize；
   *      否则 window.open 新窗口打开支付页，进入 paying 阶段
   *   4. paying 阶段轮询 listMyPasses，检测到新生效 pass 后 finalizeBot 接棒
   *
   * 抛错由 executeCreateBot 的 try/catch 统一走错误映射（realname_required / invite 等）。
   */
  const startIntlCardPay = useCallback(async (plan: PlanInfo, autoRenew: boolean) => {
    trackDatongEvent(DATONG_EVENTS.SUBSCRIBE_CHECKOUT_START, {
      pgid: DATONG_PAGE_IDS.SUBSCRIBE,
      params: {
        plan: plan.id,
        plan_name: plan.name,
        billing_period: aiDuration.period,
      },
    });
    if (isSubscribed) {
      /* 已有有效 pass，直接创建实例即可 */
      await finalizeBot(plan);
      return;
    }
    /* 同步打开占位窗口：window.open 必须在用户手势同步调用栈内，跨 await（网络往返）后
       会被浏览器弹窗拦截。先开 about:blank 占位，拿到 pay_url 后再赋值 location 跳转。 */
    const payWindow = window.open("about:blank", "_blank");
    try {
      /* 1. 下单拿 deal_names。国际站为订阅制，auto_renew_flag 固定 auto_renew；
         该字段只作用于新购订单的 goodsDetail.autoRenewFlag，是否签约由后端查绑卡状态决定。 */
      const order = await repositories.plans.createPassOrder({
        bundle_id: plan.raw.bundle_id,
        period: aiDuration.period,
        time_unit: aiDuration.time_unit,
        auto_renew_flag: autoRenew ? "auto_renew" : "notify_and_manual_renew",
      });
      /* 2. 拉信用卡支付页 URL（PC 端 Bearer 鉴权）。
         cancel_url / return_url 协议上可选（不传时 trade 用环境兜底 TRADE_BILLING_PAY_REDIRECT_URL），
         但这里显式传当前页面地址，避免被兜底地址带到别的页面；
         按协议要求去掉 query/hash，防止把 OAuth code / 一次性 ticket 带进计费回跳地址。

         return_url 额外带 pay_return / pay_plan 标记：占位窗口被弹窗拦截时会走
         window.location.assign 替换掉当前页，付款后回跳到的是一个全新页面，
         原窗口的 paying 轮询已随之销毁。有标记才能在回跳页重新接棒
         「等发货 → 自动建实例 → 跳管理页」，否则用户会停在订阅页且实例没建。 */
      const payRedirectBase = window.location.href.split("#")[0].split("?")[0];
      const payReturnUrl = `${payRedirectBase}?${PAY_RETURN_QUERY_KEY}=1&${PAY_RETURN_PLAN_QUERY_KEY}=${encodeURIComponent(plan.id)}`;
      const orderUrl = await repositories.plans.getPassOrderUrl({
        deal_names: order.deal_names,
        platform: "pc",
        cancel_url: payRedirectBase,
        return_url: payReturnUrl,
      });
      /* 3. need_charge=0：零元订单已支付成功，关闭占位窗口，直接接棒 finalize */
      if (orderUrl.need_charge === 0) {
        payWindow?.close();
        await refreshPasses();
        await finalizeBot(plan);
        setModalStep("closed");
        setSelectedPlan(null);
        return;
      }
      /* 4. need_charge=1：占位窗口跳转信用卡 hosted page；pay_url 为空视为异常 */
      if (!orderUrl.pay_url) {
        throw new Error("trade generate pay url: empty pay_url");
      }
      if (payWindow) {
        payWindow.location.href = orderUrl.pay_url;
      } else {
        /* 占位窗口被拦截（浏览器弹窗限制）：兜底当前页跳转 */
        window.location.assign(orderUrl.pay_url);
      }
      setPaymentContext({ plan, dealNames: order.deal_names, redirectUrl: orderUrl.pay_url });
      setModalStep("paying");
    } catch (err) {
      payWindow?.close();
      throw err;
    }
  }, [isSubscribed, repositories.plans, finalizeBot, refreshPasses, aiDuration]);

  /* finalizeBot 的 ref 镜像 — 见 isSubscribedRef 的注释，目的相同：
     轮询 effect 内的 setInterval 闭包要拿最新 finalizeBot，又不能依赖它（会反复重建）。
     注意：必须放在 finalizeBot 声明之后，用一个独立 effect 来同步。 */
  const finalizeBotRef = useRef(finalizeBot);
  useEffect(() => {
    finalizeBotRef.current = finalizeBot;
  }, [finalizeBot]);

  /* 支付回跳接管：识别 return_url 带回的 pay_return 标记，直接进入 paying 态，
     复用下方已验证的轮询链路等后台发货，发货后自动 finalizeBot 建实例并跳管理页。
     顺带解决「回跳后订阅页不显示当前订阅」——轮询本身会持续 refreshPasses。

     只跑一次：立刻清掉 query，避免用户刷新页面又触发一遍轮询。 */
  const payReturnHandledRef = useRef(false);
  useEffect(() => {
    if (payReturnHandledRef.current) return;
    if (!isGlobal) return;
    /* 必须等鉴权与套餐列表就绪：planList 为空时找不到 plan，无法 finalize。 */
    if (!authReady || !isAuthenticated) return;
    if (planList.length === 0) return;
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    if (params.get(PAY_RETURN_QUERY_KEY) !== "1") return;

    const planId = params.get(PAY_RETURN_PLAN_QUERY_KEY);
    const plan = planId ? planList.find((item) => item.id === planId) : undefined;

    payReturnHandledRef.current = true;
    /* 先清 query 再进流程：保留 pathname + hash，避免刷新重复触发。 */
    params.delete(PAY_RETURN_QUERY_KEY);
    params.delete(PAY_RETURN_PLAN_QUERY_KEY);
    const nextSearch = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}${window.location.hash}`,
    );

    if (!plan) {
      /* 拿不到套餐（planList 变更 / 链接被改）：不静默失败，至少刷一次让当前订阅显示出来。 */
      void refreshPasses();
      return;
    }
    /* dealNames 留空：回跳页没有原订单号，轮询只依赖 pass 状态，不需要它。 */
    setSelectedPlan(plan);
    setPaymentContext({ plan, dealNames: [] });
    setModalStep("paying");
  }, [authReady, isAuthenticated, planList, refreshPasses]);

  /* paying 阶段轮询 listMyPasses：代替 SDK callback。
     轮询到有效 active pass 后自动 finalizeBot 接棒，用户无需任何手动确认。
     超时（PAY_POLL_TIMEOUT_MS）只切换 UI 到「开通中」的耐心文案，不停止轮询——
     手动确认按钮已移除，轮询是唯一的自动接棒途径，停了用户就只能刷新页面自救。 */
  useEffect(() => {
    if (modalStep !== "paying") return;
    const ctx = paymentContext;
    if (!ctx) return;
    let cancelled = false;
    let finalizing = false;
    const startedAt = Date.now();
    const timer = window.setInterval(async () => {
      if (cancelled || finalizing) return;
      try {
        await refreshPasses();
      } catch (err) {
        console.warn("[subscribe] poll refreshPasses failed", err);
      }
      if (cancelled) return;
      /* 命中有效 pass：停轮询 + 主动 finalize，承接 PC 端创建实例 + 跳管理页 */
      if (isSubscribedRef.current) {
        finalizing = true;
        window.clearInterval(timer);
        try {
          await finalizeBotRef.current(ctx.plan);
        } catch (err) {
          if (!cancelled) {
            const fallbackMsg = err instanceof Error ? err.message : t("创建实例失败，请稍后重试。");
            console.error("[subscribe] poll finalize failed", err);
            setError({ code: getBillingErrorCode(err), message: resolveBillingErrorMessage(err, fallbackMsg) });
            setModalStep("closed");
            setSelectedPlan(null);
            setPaymentContext(null);
          }
        }
        return;
      }
      if (Date.now() - startedAt > PAY_POLL_TIMEOUT_MS) {
        /* 只切文案不停止轮询：手动确认按钮已移除，若停轮询，
           发货慢的用户将永远等不到自动开通。轮询随弹窗关闭（cleanup）而终止。 */
        if (!cancelled) setPayPollTimedOut(true);
      }
    }, PAY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [modalStep, paymentContext, refreshPasses, t]);
  /**
   * 总调度 — 根据站点路由到免费试用或付费下单，并统一出错处理
   */
  const executeCreateBot = useCallback(async (plan: PlanInfo, autoRenew = false) => {
    setSubscribingPlanId(plan.id);
    setError(null);
    captureProductEvent(PRODUCT_ANALYTICS_EVENTS.AGENT_CREATE_STARTED, {
      plan_id: plan.id,
      plan_name: plan.name,
      skip_payment: plan.skipPayment === true,
      paid_billing_active: paidBillingActive,
    });
    try {
      /* 国内站一律走付费下单链路（plan.skipPayment 已在 mapBundleToPlan 中按站点置为 false）；
         国际站维持「paidBillingActive 开关 + skipPayment」组合控制。 */
      if (isDianshiZeroAmountPlan(plan, paidBillingActive)) {
        await startDianshiOrderAndPay(plan);
      } else if ((!isGlobal || paidBillingActive) && !plan.skipPayment) {
        if (isGlobal) {
          /* 国际站付费链路：信用卡 hosted page 跳转（createPassOrder + getPassOrderUrl）。
             startIntlCardPay 内部新窗口打开支付页 + 进入 paying 轮询接棒 finalizeBot，
             这里不能继续往下 addBot/navigate，finalize 已处理跳转。 */
          await startIntlCardPay(plan, autoRenew);
        } else {
          /* 国内站付费链路：startPaidPassOrder 只展示二维码并把弹窗切到 paying；
             真正的 addBot + 跳转由 paying 阶段轮询接棒（轮询到 active pass → 自动 finalizeBot）。
             因此这里**不能**再继续往下做 addBot/navigate，否则用户还没付钱实例就建了 */
          await startPaidPassOrder(plan);
        }
      } else {
        /* 免费链路：startTrialPass 内部已 await finalizeBot，addBot + 跳转一气呵成 */
        await startTrialPass(plan);
      }
    } catch (err) {
      const code = getBillingErrorCode(err);
      const fallbackMsg = err instanceof Error ? err.message : t("创建失败，请稍后重试。");
      console.error("[subscribe] create bot failed", err instanceof RepositoryError
        ? { status: err.status, code: err.code, message: err.message }
        : err);
      captureProductEvent(PRODUCT_ANALYTICS_EVENTS.AGENT_CREATE_FAILED, {
        plan_id: plan.id,
        plan_name: plan.name,
        code,
      });
      /* 特例 1：后端以「邀请码」拒绝创建 → 拉起邀请码弹窗，激活后代为重试 */
      const isInviteError = /invite|邀请码/i.test(fallbackMsg) || /invite/i.test(code ?? "");
      if (isInviteError) {
        setPendingPlan(plan);
        setShowInviteCode(true);
        setModalStep("closed");
        setSelectedPlan(null);
        setPaymentContext(null);
        return;
      }
      /* 特例 2：实名报错 → 专项文案，让错误展示处给超链接 */
      if (code === "realname_required") {
        setError({ code, message: resolveRealnameErrorMessage(t) });
        setModalStep("closed");
        setSelectedPlan(null);
        setPaymentContext(null);
        return;
      }
      /* 特例 3：需要走续费路径（expired/isolated） → 引导到账号页 */
      if (isPassRequiresRenewError(code)) {
        const message = isGlobal
          ? code === "PASS_ISOLATED"
            ? t("当前套餐已进入隔离期，请在账号页管理套餐，销毁后可重新购买。")
            : t("当前套餐已到期，续费功能敬请期待；请在账号页查看套餐，销毁后可重新购买。")
          : code === "PASS_ISOLATED"
            ? t("当前套餐已进入隔离期，请前往我的账号续费恢复使用，或在账号页销毁后重新购买。")
            : t("当前套餐已到期，请前往我的账号续费后继续使用。");
        setError({
          code,
          message,
          action: {
            label: isGlobal ? t("管理套餐") : t("前往续费"),
            href: ACCOUNT_PATH,
          },
        });
        setModalStep("closed");
        setSelectedPlan(null);
        setPaymentContext(null);
        return;
      }
      /* 其他错误：走统一映射 */
      setError({ code, message: resolveBillingErrorMessage(err, fallbackMsg) });
      setModalStep("closed");
      setSelectedPlan(null);
      setPaymentContext(null);
    } finally {
      setSubscribingPlanId(null);
    }
  }, [paidBillingActive, startDianshiOrderAndPay, startPaidPassOrder, startIntlCardPay, startTrialPass, t]);

  const handleSubscribe = useCallback((planId: string) => {
    const plan = planList.find((p) => p.id === planId);
    if (!plan) return;

    /* 功能点2b：进页不再强制登录，未登录用户可浏览静态价；
       点「订阅」按钮时再引导登录，登录后回到本页继续操作。 */
    if (!isLoggedIn) {
      /* 未登录：弹出登录弹窗引导登录（OAuth 整页跳转）。
         登录回跳后进入已登录态定价页，用户再次点「订阅」即走下方实名判断链路。 */
      setShowLoginModal(true);
      return;
    }

    /* 售罄 / 未上线 / 暂无报价 / 询价加载中 套餐按钮已 disabled，这里再加一层保护，
       防止浏览器绕过 disabled 或竞态触发时以旧价/无价的口径下单。 */
    if (plan.soldOut || plan.comingSoon || plan.priceUnavailable || plan.pricingLoading) return;

    /* 上报「立即开通」按钮点击 */
    trackDatongClick("plan_select_btn", {
      pgid: DATONG_PAGE_IDS.SUBSCRIBE,
      params: {
        plan: plan.id,
        billing_period: paidBillingActive ? aiDuration.period : plan.raw.time_span,
      },
    });

    /* 检查龙虾个数是否已达该套餐上限 */
    if (bots.length >= plan.maxBots) {
      setError({ message: t("当前已有 {{current}} 个 Hermes，{{plan}}套餐最多可创建 {{max}} 只。", { current: bots.length, plan: plan.name, max: plan.maxBots }) });
      return;
    }

    setError(null);

    /* 实名前置校验（仅国内站，国际站无实名概念）：
       未实名用户先引导去账号页完成实名，再回来开通，避免（尤其是「免费开通」这类
       skipPayment 直接创建的链路）绕过确认弹窗后被后端 realname_required 拒绝、体验断裂。
       口径与账号页 verified 判定一致：开启手机实名开关时要求 phone_3fa，否则看 realnameVerified。
       跳转携带 realname_required query，触发账号页的实名提醒（与首页「立即创建」一致）。 */
    if (!isGlobal) {
      const u = session.user;
      const realnameOk = realnamePhoneVerificationEnabled
        ? u?.realnameLevel === REALNAME_LEVEL.PHONE_3FA
        : Boolean(u?.realnameVerified);
      if (!realnameOk) {
        navigate(`${ACCOUNT_PATH}/?${REALNAME_REQUIRED_QUERY_KEY}=1&return_to=${encodeURIComponent(SUBSCRIBE_PATH + "/")}`);
        return;
      }
    }

    /* 免费套餐：跳过「确认订单」和「支付」弹窗，直接创建 */
    if (plan.skipPayment) {
      void executeCreateBot(plan);
      return;
    }

    /* 付费套餐：进入确认订单弹窗 */
    setSelectedPlan(plan);
    setModalStep("confirm");
  }, [planList, bots.length, executeCreateBot, session.stage, session.user, isLoggedIn, realnamePhoneVerificationEnabled, navigate]);

  /* 邀请码激活成功后：自动继续用户之前点击的套餐流程 */
  const handleInviteSuccess = useCallback(() => {
    setShowInviteCode(false);
    const plan = pendingPlan;
    setPendingPlan(null);
    if (!plan) return;

    /* 激活后再校验一次配额 */
    if (bots.length >= plan.maxBots) {
      setError({ message: t("当前已有 {{current}} 个 Hermes，{{plan}}套餐最多可创建 {{max}} 只。", { current: bots.length, plan: plan.name, max: plan.maxBots }) });
      return;
    }

    if (plan.skipPayment) {
      void executeCreateBot(plan);
    } else {
      setSelectedPlan(plan);
      setModalStep("confirm");
    }
  }, [pendingPlan, bots.length, executeCreateBot]);

  const handleCloseInviteModal = useCallback(() => {
    setShowInviteCode(false);
    setPendingPlan(null);
  }, []);

  const handleCloseModal = useCallback(() => {
    setModalStep("closed");
    setSelectedPlan(null);
    setPaymentContext(null);
  }, []);

  /**
   * 「确认订单」点「支付」 → 发起 createPassOrder 跳转 jifei（走付费链路主入口）
   */
  const handlePay = useCallback((autoRenew: boolean) => {
    if (!selectedPlan) return;
    /* 占位付费卡为纯前端演示：确认弹窗内部已处理支付成功展示，绝不能拿假 bundle_id 调后端下单。
       这里再兜底一层，防止误触真实下单链路。 */
    if (selectedPlan.id.startsWith("placeholder-")) return;
    void executeCreateBot(selectedPlan, autoRenew);
  }, [selectedPlan, executeCreateBot]);

  /* 「我已完成支付」手动确认入口已移除：轮询是唯一自动接棒途径，
     超时后也持续轮询（见上方 paying 轮询 effect），用户无需手动确认。 */

  /* 「刷新」按钮：重新下单生成一份新的 deal_name + auth_code，重新生成二维码。
     主要场景：二维码接近/已过期、后台 auth_code 已被 Consume、用户重新扫码。
     复用 startPaidPassOrder 以保证与首次下单逻辑一致。 */
  const [paymentRefreshing, setPaymentRefreshing] = useState(false);
  const handleRefreshPayment = useCallback(async () => {
    const ctx = paymentContextRef.current;
    if (!ctx || paymentRefreshing) return;
    setPaymentRefreshing(true);
    try {
      await startPaidPassOrder(ctx.plan);
    } catch (err) {
      const fallbackMsg = err instanceof Error ? err.message : t("刷新二维码失败，请稍后重试。");
      console.error("[subscribe] refresh payment failed", err);
      setError({ code: getBillingErrorCode(err), message: resolveBillingErrorMessage(err, fallbackMsg) });
    } finally {
      setPaymentRefreshing(false);
    }
  }, [paymentRefreshing, startPaidPassOrder, t]);

  /* v1.7.31 起统一二维码 bridge 模式，不再保留 fallback / 重新打开支付页 — 原 handleReopenPayUrl 已删除 */

  /* v1.7.30 后端联调文档明确「前端不需要轮询支付状态」——
     原轮询 listMyPasses 的 useEffect 已删除，SDK callback / 用户手动确认均会走 finalizeBot 接棒。 */

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
      {header}

      <main style={{ flexGrow: 1, padding: "96px 24px 64px" }}>
        <section style={{ maxWidth: 1080, margin: "0 auto" }}>
          {/* Page Header — Notion style */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            style={{ marginBottom: 48, textAlign: "center" }}
          >
            <h1
              style={{
                fontSize: "clamp(1.625rem, 3vw, 2rem)",
                fontWeight: 700,
                letterSpacing: "-0.625px",
                lineHeight: 1.23,
                color: colors.black,
                margin: 0,
              }}
            >
              {t("选择适合你的套餐")}
            </h1>
            <p
              style={{
                fontSize: 16,
                fontWeight: 400,
                lineHeight: 1.5,
                color: colors.warmGray500,
                marginTop: 8,
              }}
            >
              {freeGuideAllowed ? (
                <>
                  {t("当前LightVela为内测阶段，内测期间限时免费。")}
                  <a
                    href={isGlobal ? "https://lightvela.ai/docs/overview/" : "/docs/announcements/public-beta/"}
                    {...(isGlobal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    style={{
                      color: colors.primary,
                      fontWeight: 500,
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t("查看详情")}
                    {" >>"}
                  </a>
                </>
              ) : (
                t("免费开始，一键创建你的云端智能伙伴")
              )}
            </p>
            {/* {bots.length > 0 && (
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: 1.5,
                  color: colors.warmGray300,
                  marginTop: 12,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 14px",
                  borderRadius: 9999,
                  background: colors.badgeBg,
                }}
              >
                当前已有 {bots.length} 个 Hermes
              </p>
            )} */}
          </motion.div>

          {/* Error */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ maxWidth: 960, margin: "0 auto 24px" }}
            >
              <p
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "10px 16px",
                  borderRadius: 8,
                  textAlign: "center",
                  fontSize: 14,
                  fontWeight: 500,
                  background: "rgba(207,61,76,0.08)",
                  color: "#cf3d4c",
                }}
              >
                {!isGlobal && error.code === "realname_required" ? (
                  <>
                    {t("请前往")}{" "}
                    <AppLink
                      to={`${ACCOUNT_PATH}/?${REALNAME_REQUIRED_QUERY_KEY}=1&return_to=${encodeURIComponent(SUBSCRIBE_PATH + "/")}`}
                      style={{ color: "#cf3d4c", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 3 }}
                    >
                      {t("我的账号")}
                    </AppLink>{" "}
                    {t("进行实名。")}
                  </>
                ) : (
                  <>
                    <span>{error.message}</span>
                    {error.action && (
                      <AppLink
                        to={error.action.href}
                        style={{ color: "#cf3d4c", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 3 }}
                      >
                        {error.action.label}
                      </AppLink>
                    )}
                  </>
                )}
              </p>
            </motion.div>
          )}

          {/* 付费时长子 Tab — 计费开关开启即展示，作用于所有 bundle_type（general / ai / 其他），
              切换后重新询价并影响所有可购买套餐的展示价格与下单参数。 */}
          {paidBillingActive && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 8,
                marginBottom: 24,
                marginTop: -16,
              }}
              role="tablist"
              aria-label={t("付费时长")}
            >
              {AI_DURATION_TABS.map((tab) => {
                const active = tab.key === aiDurationKey;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setAiDurationKey(tab.key)}
                    disabled={bundlesLoading}
                    style={{
                      padding: "6px 16px",
                      borderRadius: 9999,
                      border: `1px solid ${active ? colors.black : colors.border}`,
                      background: active ? colors.black : colors.white,
                      color: active ? colors.white : colors.warmGray500,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: bundlesLoading ? "not-allowed" : "pointer",
                      opacity: bundlesLoading && !active ? 0.6 : 1,
                      transition: "all 0.2s ease",
                    }}
                  >
                    {t(tab.zhLabel)}
                  </button>
                );
              })}
            </div>
          )}

          {/* Plan Cards */}
          {bundlesLoading && !bundles ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 0", gap: 8 }}>
              <Loader2 style={{ width: 20, height: 20, color: colors.warmGray300 }} className="animate-spin" />
              <span style={{ fontSize: 14, color: colors.warmGray300 }}>{t("加载套餐中...")}</span>
            </div>
          ) : bundlesError ? (
            <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center", padding: "32px 0" }}>
              <p style={{ fontSize: 14, color: "#cf3d4c", marginBottom: 12 }}>{bundlesError}</p>
              <button
                onClick={() => {
                  setBundlesError(null);
                  setRetryToken((n) => n + 1);
                }}
                style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, color: colors.black, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                {t("重试")}
              </button>
            </div>
          ) : planTiers.length === 0 ? (
            <div style={{ maxWidth: 480, margin: "0 auto", textAlign: "center", padding: "48px 0" }}>
              <Sparkles style={{ width: 24, height: 24, color: colors.warmGray300, margin: "0 auto 8px" }} />
              <p style={{ fontSize: 14, color: colors.warmGray300 }}>{t("暂无在售套餐，敬请期待")}</p>
            </div>
          ) : (
            <>
              <motion.div
                variants={staggerContainer}
                initial="hidden"
                animate="visible"
                style={{
                  display: "grid",
                  gridTemplateColumns: planTiers.length >= 3 ? "repeat(3, 1fr)" : `repeat(${planTiers.length}, 1fr)`,
                  gap: 24,
                  maxWidth: 1080,
                  margin: "0 auto",
                }}
              >
                {planTiers.map((tier, idx) => (
                  <PlanCard
                    key={tier.key}
                    variants={tier.variants}
                    index={idx}
                    onSubscribe={(planId) => void handleSubscribe(planId)}
                    subscribingPlanId={subscribingPlanId}
                    currentBots={bots.length}
                    reserveCreditTabSpace={planTiers.some((tt) => tt.variants.length > 1)}
                    /* 已有生效订阅或有智能体：暂不支持升级/更换套餐，所有卡按钮禁用（当前套餐卡文案为「当前订阅」）。 */
                    subscriptionLocked={isSubscribed || bots.length > 0}
                  />
                ))}
              </motion.div>
              {isCN && (
                <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
                  <AppLink
                    to={CN_REFUND_RULES_PATH}
                    style={{
                      color: colors.warmGray500,
                      fontSize: 12,
                      fontWeight: 500,
                      lineHeight: 1.5,
                      textDecoration: "underline",
                      textUnderlineOffset: 3,
                    }}
                  >
                    {t("退款规则")}
                  </AppLink>
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <LegalFooter />

      {/* Payment Modals */}
      <AnimatePresence>
        {modalStep === "confirm" && selectedPlan && (
          isDianshiZeroAmountPlan(selectedPlan, paidBillingActive) ? (
            <ConfirmOrderModal
              key="confirm-dianshi"
              plan={selectedPlan}
              billingPeriodLabel={getBillingDurationLabel(aiDuration, t)}
              showPaymentMethod={false}
              actionLabel={t("确认开通")}
              onCancel={handleCloseModal}
              onPay={() => handlePay(false)}
            />
          ) : isGlobal ? (
            <CreditCardConfirmOrderModal
              key="confirm"
              plan={selectedPlan}
              billingPeriodLabel={getBillingDurationLabel(aiDuration, t)}
              demoMode={selectedPlan.id.startsWith("placeholder-")}
              paying={subscribingPlanId === selectedPlan.id}
              onCancel={handleCloseModal}
              onPay={handlePay}
              t={t}
            />
          ) : (
            <ConfirmOrderModal
              key="confirm"
              plan={selectedPlan}
              billingPeriodLabel={getBillingDurationLabel(aiDuration, t)}
              onCancel={handleCloseModal}
              onPay={handlePay}
            />
          )
        )}
        {modalStep === "paying" && paymentContext && (
          <PaymentPendingModal
            key="paying"
            bridgeUrl={paymentContext.bridgeUrl}
            redirectUrl={paymentContext.redirectUrl}
            onCancel={handleCloseModal}
            onRefresh={() => void handleRefreshPayment()}
            refreshing={paymentRefreshing}
            timedOut={payPollTimedOut}
            provisioningOnly={paymentContext.provisioningOnly}
            t={t}
          />
        )}
      </AnimatePresence>

      {/* Invite Code Modal — 未激活邀请码时拦截「立即开通」 */}
      <InviteCodeModal
        open={showInviteCode}
        onClose={handleCloseInviteModal}
        onSuccess={handleInviteSuccess}
      />

      {/* Login Modal — 未登录点「订阅」时引导登录；登录成功仅关闭弹窗，
          OAuth 整页跳转回跳后即为已登录态定价页。 */}
      <LoginModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
      />

      {/* Responsive: collapse to single column on mobile */}
      <style>{`
        @media (max-width: 768px) {
          [style*="grid-template-columns: repeat(3"] {
            grid-template-columns: 1fr !important;
            max-width: 400px !important;
          }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          [style*="grid-template-columns: repeat(3"] {
            gap: 16px !important;
          }
        }
      `}</style>
    </div>
  );
};
