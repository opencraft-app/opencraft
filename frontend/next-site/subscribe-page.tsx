import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, User, Monitor, Clock, HardDrive, Settings, Zap, Sparkles, X, Loader2, Wifi, CalendarClock, Puzzle, MessageSquare, Brain, UserCog, Stethoscope, Cpu, CreditCard } from "lucide-react";
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
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
import { isGlobal } from "@/lib/region";
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
/** AI 增强版套餐类型标识（首月折扣付费，不在免费试用范围内） */
const BUNDLE_TYPE_AI = "ai";

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

/* ─── 套餐分类 Tab 配置 ─── */

/**
 * 套餐分类 tab，与后端 `bundle.bundle_type` 枚举对应（migration 000023 / 2026-06 后端联调确认）：
 *   - general  标准版（启航 / 巡游 / 远航）
 *   - ai       AI 增强版（启航 AI / 巡游 AI / 远航 AI）
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
    return isGlobal ? "/ quarter" : t("/ 季");
  }
  return isGlobal ? "/ month" : t("/ 月");
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

  /* 套餐档位（tier）判定，依据 bundle_name（中/英/中英混排）识别启航 / 巡游 / 远航。
     用于：独立环境规格差异化 + 一句话文案差异化。避免后端 description.Value 缺值时露馅。 */
  const bundleNm = bundle.bundle_name ?? "";
  const nmLower = bundleNm.toLowerCase();
  const isLaunchTier = bundleNm.includes("启航") || nmLower.includes("launch");
  const isCruiseTier = bundleNm.includes("巡游") || nmLower.includes("cruise");
  const isVoyageTier = bundleNm.includes("远航") || nmLower.includes("voyage");
  /* 独立环境规格：启航 2核4G；巡游 / 远航 升配 4核8G。 */
  const envSpec = isLaunchTier ? t("2核 4G 内存") : t("4核 8G 内存");
  /* 专属云端存储：启航 50G；巡游 / 远航 升配 80G。 */
  const storageSpec = isLaunchTier ? "50G" : "80G";
  /* 一句话文案按 tier 差异化（PRD 需求2）。命中 tier 时直接使用 tier 文案，不受 freeGuideAllowed 清空；
     未命中 tier（如免费试用卡）保持原有兜底逻辑。 */
  const tierTagline = isLaunchTier
    ? t("低成本上手，先让 Agent 替你跑起来")
    : isCruiseTier
      ? t("日常主力，让智能化成为习惯")
      : isVoyageTier
        ? t("体验进阶，专业玩家的配置")
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
   *       国际站（isGlobal=true）登录后走真实计费展示（消费后端 bundle.price，单位分 + USD）；
   *       未登录仍走「限时免费」免费试用视觉。
   */
  const soldOut = bundle.bundle_sales_state === "SOLD_OUT";
  /* 计费开关开启后：国内站进入真实计费；国际站登录后进入真实计费（后端 bundle.price），未登录走免费视觉。 */
  const paid = paidBillingEnabled && (!isGlobal || isLoggedIn);
  /** 国内站要展示的真实金额（元）；后端 bundle.price.real_total_cost 单位是分，
   *  展示前需调 centsToYuan 转为元；后端 price 为 null 时返回 null 并标记为「暂无报价」禁用 */
  const realPriceYuan =
    paid && bundle.price ? centsToYuan(bundle.price.real_total_cost) : null;
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
    if (!isLoggedIn && realPriceYuan != null) {
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
          ? `${Math.round((displayPriceYuan / originalPriceYuan) * 100) / 10}折`
          : undefined;
    } else if (typeof backendDiscount === "number" && backendDiscount > 0 && backendDiscount < 1) {
      /* 国际站 AI 增强版月付有真实折扣时展示「首月 6 折」；其他场景按比值展示「X折」。
         无折扣（d=0/1/undefined）时不进入本分支，由 else 兜底为 undefined — 满足「有折扣才展示」。 */
      const nm = bundle.bundle_name ?? "";
      const isLaunch = nm.includes("启航") || nm.toLowerCase().includes("launch");
      const isCruise = nm.includes("巡游") || nm.toLowerCase().includes("cruise");
      const isAi = bundle.bundle_type === "ai";
      if (isGlobal && (isLaunch || isCruise) && isAi) {
        promoTag = t("首月 6 折");
      } else {
        promoTag = `${Math.round(backendDiscount * 100) / 10}折`;
      }
    } else {
      const nm = bundle.bundle_name ?? "";
      const isLaunch = nm.includes("启航") || nm.toLowerCase().includes("launch");
      const isCruise = nm.includes("巡游") || nm.toLowerCase().includes("cruise");
      const withToken = bundle.bundle_type === "ai";
      if (isLaunch) {
        if (withToken) {
          /* 季付已在前面 durationKey === "quarterly" 分支清空 promoTag，此处必为非季付 */
          /* 国内站保持原样总是展示「首月 6 折」；国际站依赖后端真实 discount（在前面 0<d<1 分支处理） */
          if (!isGlobal) {
            promoTag = t("首月 6 折");
          }
        } else if (!isLoggedIn || backendDiscount === 0) {
          /* 启航01：未登录直接展示「免费 14 天」；已登录需 discount=0 */
          promoTag = t("首单免费 14 天");
          isZeroDownFreeTrial = true;
        }
      } else if (isCruise) {
        if (withToken) {
          /* 季付已在前面 durationKey === "quarterly" 分支清空 promoTag，此处必为非季付 */
          /* 国内站保持原样总是展示「首月 6 折」；国际站依赖后端真实 discount（在前面 0<d<1 分支处理） */
          if (!isGlobal) {
            promoTag = t("首月 6 折");
          }
        } else if (!isLoggedIn || backendDiscount === 50) {
          /* 巡游01：未登录直接展示「首月 5 折」；已登录需 discount=50 */
          promoTag = t("首月 5 折");
        }
      } else {
        promoTag = undefined;
      }
    }
  } else {
    /* 国际站：保持当前限时免费视觉 */
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
  /* 启航版（标准版，非 AI 增强版）识别。需求：新用户（未订阅任何套餐）无论登录态 / 未登录态，
     启航版订阅按钮统一展示「免费订阅」，并在 hover 时提示「免费试用到期后不自动扣款、需手动续费」。
     AI 增强版（bundle_type === "ai"）为付费首月折扣，不在此免费试用范围内。 */
  const _launchBundleName = bundle.bundle_name ?? "";
  const isLaunchStandard =
    (_launchBundleName.includes(LAUNCH_BUNDLE_NAME_KEYWORDS.zh) ||
      _launchBundleName.toLowerCase().includes(LAUNCH_BUNDLE_NAME_KEYWORDS.en)) &&
    bundle.bundle_type !== BUNDLE_TYPE_AI;
  const isNewUserFreeLaunch = isLaunchStandard && !isSubscribed && !isCurrentPlan;
  const ctaLabel = isCurrentPlan
    ? t("当前订阅")
    : soldOut
    ? t("已售罄")
    : showPricingPlaceholder
      ? t("询价中...")
      : priceUnavailable
        ? t("暂无报价")
        : /* 需求4：可享免费 14 天 0 元下单，或内测「免费订阅」引导态，一律显示「免费订阅」。
             需求（新用户启航版）：无论登录 / 未登录，新用户启航版一律展示「免费订阅」。
             已订阅用户不展示「免费订阅」引导（当前套餐走 isCurrentPlan →「当前订阅」优先级更高）。 */
          !isSubscribed && (isZeroDownFreeTrial || isFeaturedFreeGuide || isNewUserFreeLaunch)
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
    ctaStyle: index === 0 ? "primary" : "outline",
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
 *
 * 价格为线上确认值（金额敏感），此处均为「原价」：
 *   - 启航标准版：月付 ¥45 / 季付 ¥135（月×3）
 *   - 巡游标准版：月付 ¥95 / 季付 ¥285（月×3）
 * 季付统一享 8.5 折优惠（与登录后询价下发折扣一致）：启航 ¥114.75 / 巡游 ¥242.25，原价删除线展示。
 * 远航统一「敬请期待」（price=null 由 planTiers 强制）；AI 增强版已露静态价，见 STATIC_AI_TIER_PRICE_YUAN。
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

/** 标准版通用卖点（与后端 description 对齐；独立环境规格 / 存储 / 积分等具体展示由 mapBundleToPlan 内部统一处理）。 */
const STATIC_GENERAL_DESC: BundleDescriptionEntry[] = [
  { Key: "独立环境", Value: "" },
  { Key: "专属云端存储", Value: "" },
  { Key: "7×24小时在线", Value: "" },
];

/**
 * 生成未登录静态 Bundle 列表（6 张，覆盖启航/巡游/远航 × 标准版/AI 增强版），
 * 走与后端相同的 mapBundleToPlan / planTiers 链路渲染。
 *   - 标准版：露真实价（启航/巡游随 durationKey 取月付/季付；远航由 planTiers 强制「敬请期待」，price=null）
 *   - AI 增强版：露静态价（启航/巡游随 durationKey 取月付/季付，见 STATIC_AI_TIER_PRICE_YUAN；月付「首月 6 折」/季付「9折」角标），积分写死（启航 4500 / 巡游 10000）
 * bundle_id 与线上真实配置一致（见 scripts/seed_trade_shprod_bundle_definition.sql），
 * 但未登录不会触发下单（点订阅先引导登录），仅用于展示。
 */

const buildStaticBundles = (durationKey: "monthly" | "quarterly"): Bundle[] => {
  const span = durationKey === "quarterly" ? 3 : 1;
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
      price: buildStaticPrice(
        STATIC_TIER_PRICE_YUAN.launch[durationKey],
        durationKey === "quarterly" ? STATIC_QUARTERLY_DISCOUNT : 1.0,
      ),
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
      price: buildStaticPrice(
        STATIC_AI_TIER_PRICE_YUAN.launch[durationKey],
        durationKey === "quarterly" ? STATIC_AI_QUARTERLY_DISCOUNT : 1.0,
      ),
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
      price: buildStaticPrice(
        STATIC_TIER_PRICE_YUAN.cruise[durationKey],
        durationKey === "quarterly" ? STATIC_QUARTERLY_DISCOUNT : 1.0,
      ),
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
      price: buildStaticPrice(
        STATIC_AI_TIER_PRICE_YUAN.cruise[durationKey],
        durationKey === "quarterly" ? STATIC_AI_QUARTERLY_DISCOUNT : 1.0,
      ),
      time_span: span,
    },
    /* 远航 Voyage —— planTiers 强制单卡「敬请期待」，无需价格 */
    {
      ...base,
      bundle_id: "bundle_voyage_01",
      bundle_name: "远航 Voyage",
      bundle_type: "general",
      description: STATIC_GENERAL_DESC,
      agent_quota: 3,
      credit: 500,
      price: null,
      time_span: 1,
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
   * 缺省会落入「其他」兜底分组；巡游/远航属于传统标准套餐语义，默认 "general"。
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
    releasedOnGlobal: true,
    agentQuota: 1,
    bundleType: "general",
  },
  {
    id: "placeholder-pro",
    name: "远航 Voyage",
    price: "¥279",
    priceGlobal: "$42",
    priceUnit: "/ 月",
    priceUnitGlobal: "/ month",
    description: "体验进阶，专业玩家的配置",
    features: [
      { iconKey: "user", label: "Agent", value: "3 个" },
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
    maxBots: 3,
    comingSoon: true,
    agentQuota: 3,
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
  void t("远航 Voyage");
  void t("日常主力，让智能化成为习惯");
  void t("体验进阶，专业玩家的配置");
  void t("1 个");
  void t("3 个");
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
      priceUnit: isGlobal ? def.priceUnitGlobal : t(def.priceUnit),
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

/* ─── 套餐档位（tier）分组：启航 / 巡游 / 远航 ─── */

/**
 * 需求3 重构：不再用「标准版 / AI 增强版」全局 tab 切换整排卡，而是
 * 三张卡按 tier（启航 / 巡游 / 远航）固定展示，同一 tier 下的标准版 / AI 增强版
 * 收敛为卡内「积分」切换（见 PlanCard）。这里定义 tier 分组所需的类型与工具。
 */
type PlanTierKey = "launch" | "cruise" | "voyage";
const PLAN_TIER_ORDER: PlanTierKey[] = ["launch", "cruise", "voyage"];

/** 按 bundle_name（中 / 英 / 中英混排）判定 tier；未命中返回 null（如免费试用卡）。 */
const tierOfPlan = (plan: PlanInfo): PlanTierKey | null => {
  const raw = plan.raw.bundle_name ?? plan.name ?? "";
  const lower = raw.toLowerCase();
  if (raw.includes("启航") || lower.includes("launch")) return "launch";
  if (raw.includes("巡游") || lower.includes("cruise")) return "cruise";
  if (raw.includes("远航") || lower.includes("voyage")) return "voyage";
  return null;
};

/** 一个 tier 分组：同 tier 的多个档位（variants，按积分升序）+ 是否敬请期待。 */
interface PlanTierGroup {
  /** tier key（launch/cruise/voyage）或未命中 tier 时的 plan.id（各自单卡） */
  key: string;
  /** 同 tier 的档位列表，按 credit 降序（AI 增强版在左、标准版在右） */
  variants: PlanInfo[];
}

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
  /* 是否为「无积分切换」的卡（如远航敬请期待）预留等高占位，使其 CTA/功能点与有积分切换的卡对齐 */
  reserveCreditTabSpace?: boolean;
  /* 用户已有生效订阅：暂不支持升级 / 更换套餐，所有卡按钮统一禁用（当前套餐卡文案为「当前订阅」）。 */
  subscriptionLocked?: boolean;
}) => {
  const t = useT();
  /* 卡内积分档位切换：同 tier 的 AI 增强版 / 标准版收敛为 variants，切换即换整份 PlanInfo，
     价格 / 积分 / 折扣 / 下单套餐随之联动。默认选中第一个（高积分 AI 增强版）。 */
  const [activeVariantIdx, setActiveVariantIdx] = useState(0);
  const safeIdx = activeVariantIdx < variants.length ? activeVariantIdx : 0;
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
  /* 积分切换 tab：只要有 >1 个档位就展示（远航为单档位天然不展示）。
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
            切换即联动价格 / 积分 / 折扣 / 下单套餐（需求3）。远航（敬请期待）不展示。 */}
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

        {/* 无积分切换的卡（如远航敬请期待）补一段与积分 tabs 等高的占位，使 CTA/分割线/功能点与其他卡对齐 */}
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
  onCancel,
  onPay,
}: {
  plan: PlanInfo;
  billingPeriodLabel: string;
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
              {t("支付")} {currencySymbol}{priceNum}
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
 * ⚠️ 税费为前端占位（TAX_RATE = 0），真实税额应由后端结算返回后替换。
 */
const TAX_RATE = 0; // 前端占位税率；接入后端结算后用真实税额替换

const CreditCardConfirmOrderModal = ({
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
  onPay: () => void;
}) => {
  const t = useT();
  const [view, setView] = useState<"order" | "bindCard" | "success">("order");
  const [autoRenew, setAutoRenew] = useState(false);
  /* 纯前端演示的绑卡状态：仅保留卡尾号用于回显 */
  const [boundCardLast4, setBoundCardLast4] = useState<string | null>(null);
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [cardError, setCardError] = useState<string | null>(null);

  const subtotal = parseFloat(plan.price.replace(/[^0-9.]/g, "")) || 0;
  const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  /* 自动续费开启但未绑卡：必须先绑卡才能支付 */
  const needsCard = autoRenew && !boundCardLast4;

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: `1px solid ${colors.border}`,
    fontSize: 14,
    color: colors.black,
    outline: "none",
    background: colors.white,
    boxSizing: "border-box",
  };
  const fieldLabelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: colors.warmGray500,
    margin: "0 0 6px",
  };

  const formatCardNumber = (v: string) =>
    v.replace(/\D/g, "").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
  const formatExpiry = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 4);
    return d.length >= 3 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  };

  const handleSaveCard = () => {
    const digits = cardNumber.replace(/\D/g, "");
    if (digits.length < 13) { setCardError("Please enter a valid card number."); return; }
    if (!/^\d{2}\/\d{2}$/.test(expiry)) { setCardError("Expiry date must be MM / YY."); return; }
    if (cvc.replace(/\D/g, "").length < 3) { setCardError("Invalid security code."); return; }
    if (!holder.trim()) { setCardError("Cardholder name is required."); return; }
    setBoundCardLast4(digits.slice(-4));
    setCardError(null);
    setView("order");
  };

  const handlePayClick = () => {
    /* 开了自动续费却未绑卡：不直接下单，先引导绑卡 */
    if (needsCard) { setView("bindCard"); return; }
    /* 纯前端演示：不调后端下单，直接展示支付成功 */
    if (demoMode) { setView("success"); return; }
    onPay();
  };

  const backToOrder = () => { setView("order"); setCardError(null); };

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
          aria-label="Close"
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
              Payment successful
            </h3>
            <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 4px" }}>
              You&rsquo;ve subscribed to the {plan.name} plan.
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
              Done
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
                {boundCardLast4 && (
                  <span style={{ marginLeft: "auto", fontSize: 13, color: colors.warmGray500, fontVariantNumeric: "tabular-nums" }}>
                    •••• {boundCardLast4}
                  </span>
                )}
              </div>

              {boundCardLast4 && (
                <div style={{ marginTop: 6, textAlign: "right" }}>
                  <button
                    onClick={() => setView("bindCard")}
                    style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontWeight: 600, color: colors.primary, textDecoration: "underline" }}
                  >
                    {t("更换卡片")}
                  </button>
                </div>
              )}

              <div style={{ height: 1, background: colors.border, margin: "16px 0" }} />

              {/* Auto-renew toggle */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.black }}>{t("自动续费")}</div>
                  <div style={{ fontSize: 12, color: colors.warmGray500, marginTop: 2 }}>
                    {t("每个计费周期结束时自动续费")}
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={autoRenew}
                  aria-label={t("自动续费")}
                  onClick={() => setAutoRenew((v) => !v)}
                  style={{
                    position: "relative",
                    width: 40,
                    height: 22,
                    borderRadius: 999,
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    flexShrink: 0,
                    background: autoRenew ? colors.primary : colors.border,
                    transition: "background 0.2s",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: 2,
                      left: autoRenew ? 20 : 2,
                      width: 18,
                      height: 18,
                      borderRadius: "50%",
                      background: colors.white,
                      boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                      transition: "left 0.2s",
                    }}
                  />
                </button>
              </div>

              {/* 未绑卡提示 */}
              {needsCard && (
                <div
                  style={{
                    marginTop: 14,
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: colors.warmWhite,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}
                >
                  <span style={{ fontSize: 13, color: colors.warmGray500 }}>
                    {t("请先绑定卡片以启用自动续费")}
                  </span>
                  <button
                    onClick={() => setView("bindCard")}
                    style={{
                      flexShrink: 0,
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: `1px solid ${colors.primary}`,
                      background: colors.white,
                      color: colors.primary,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("绑定卡片")}
                  </button>
                </div>
              )}
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
                disabled={needsCard || paying}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: "none",
                  background: (needsCard || paying) ? colors.warmGray300 : colors.primary,
                  color: colors.white,
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: (needsCard || paying) ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (!needsCard && !paying) e.currentTarget.style.background = colors.primaryHover; }}
                onMouseLeave={(e) => { if (!needsCard && !paying) e.currentTarget.style.background = colors.primary; }}
              >
                {paying ? t("处理中...") : t("支付 {{amount}}", { amount: fmt(total) })}
              </button>
            </div>
          </div>
        ) : (
          /* ─── Bind card view ─── */
          <div style={{ padding: "28px 28px 24px" }}>
            <button
              onClick={backToOrder}
              aria-label={t("返回")}
              style={{ position: "absolute", top: 16, left: 16, background: "none", border: "none", cursor: "pointer", color: colors.warmGray300, padding: 4, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
            >
              <ArrowLeft style={{ width: 18, height: 18 }} />
            </button>

            <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "4px 0 6px", letterSpacing: "-0.25px", textAlign: "center" }}>
              {t("添加支付卡")}
            </h3>
            <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 20px", textAlign: "center" }}>
              {t("您的卡片将用于自动续费")}
            </p>

            <div style={{ marginBottom: 16 }}>
              <label style={fieldLabelStyle}>{t("卡号")}</label>
              <input
                value={cardNumber}
                onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
                placeholder="1234 5678 9012 3456"
                inputMode="numeric"
                autoComplete="cc-number"
                style={inputStyle}
              />
            </div>

            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabelStyle}>{t("有效期")}</label>
                <input
                  value={expiry}
                  onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                  placeholder="MM / YY"
                  inputMode="numeric"
                  autoComplete="cc-exp"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabelStyle}>{t("安全码")}</label>
                <input
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="123"
                  inputMode="numeric"
                  autoComplete="cc-csc"
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginBottom: cardError ? 12 : 24 }}>
              <label style={fieldLabelStyle}>{t("持卡人姓名")}</label>
              <input
                value={holder}
                onChange={(e) => setHolder(e.target.value)}
                placeholder={t("卡片上的姓名")}
                autoComplete="cc-name"
                style={inputStyle}
              />
            </div>

            {cardError && (
              <p style={{ fontSize: 13, color: "#d92d20", margin: "0 0 16px" }}>{cardError}</p>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={backToOrder}
                style={{ flex: 1, padding: "12px 16px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, color: colors.black, fontSize: 15, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.white; }}
              >
                {t("取消")}
              </button>
              <button
                onClick={handleSaveCard}
                style={{ flex: 1, padding: "12px 16px", borderRadius: 8, border: "none", background: colors.primary, color: colors.white, fontSize: 15, fontWeight: 600, cursor: "pointer", transition: "all 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
              >
                {t("保存卡片")}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
};

/* ─── Payment Pending Modal ─── */

/**
 * 付费进行中弹窗——取代原来的 mock 微信二维码。该弹窗同时覆盖两个状态：
 *   - paying ：已跳转新窗口，后台轮询 listMyPasses 中
 *   - polling：用户点击「我已完成支付」，立即询问一次
 *
 * 表现上这两个状态只在 spinner / 文案上轻微区分，避免闪烁。
 */
const PaymentPendingModal = ({
  bridgeUrl,
  redirectUrl,
  onCancel,
  onManualConfirm,
  onRefresh,
  refreshing,
  t,
}: {
  /** 国内站：中转页绝对 URL，用作 QRCode value */
  bridgeUrl?: string;
  /** 国际站：信用卡 hosted page URL（pay_url），用于「重新打开支付页」 */
  redirectUrl?: string;
  onCancel: () => void;
  onManualConfirm: () => void;
  /** 「刷新」按钮：重新生成二维码（重新下单换新 auth_code）— 仅国内站 bridge 模式 */
  onRefresh: () => void;
  /** 刷新进行中（重新下单的网络往返期间），用于禁用按钮防止重复请求 */
  refreshing: boolean;
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
            {t("请完成支付")}
          </h3>
          <p style={{ fontSize: 13, color: colors.warmGray500, margin: "0 0 24px" }}>
            {bridgeUrl
              ? t("请使用微信扫描下方二维码完成支付")
              : t("信用卡支付页已在新窗口打开，完成支付后本页将自动跳转")}
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

          <p style={{ fontSize: 13, color: colors.warmGray500, textAlign: "center", margin: "0 0 20px" }}>
            {t("支付完成后，需等待约15秒完成下单")}
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
            ) : (
              <button
                onClick={() => {
                  if (redirectUrl) window.open(redirectUrl, "_blank", "noopener,noreferrer");
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
            )}
            {/* 「我已完成支付」：轮询超时兜底，手动触发 refreshPasses + finalizeBot */}
            <button
              onClick={onManualConfirm}
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
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.9"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
            >
              {t("我已完成支付")}
            </button>
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
 * SDK 自身会通过 callback 通知支付完成；用户使用兜底入口时手动点「我已完成支付」即可。
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
     对应 localStorage 覆盖 lightclaw:features.paidBillingEnabled=false
     且 lightclaw:features.realnamePhoneVerificationEnabled=false 的场景。
     任一开关开启时不做免费引导，CTA 维持「立即开通」。 */
  const freeGuideAllowed = !paidBillingEnabled && !realnamePhoneVerificationEnabled;
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
          setBundlesError(err instanceof Error ? err.message : t("套餐列表加载失败"));
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
   * 需求3：按 tier（启航 / 巡游 / 远航）把 planList 分组，取代原「标准版 / AI 增强版」全局 tab。
   *   - 同 tier 的 AI 增强版 / 标准版收敛为一张卡的多个 variants（按积分降序），卡内切换（见 PlanCard）
   *   - tier 顺序固定：启航 → 巡游 → 远航
   *   - 远航（voyage）保持「敬请期待」：只取首个 variant 并强制 comingSoon、不放积分切换（PRD 决策）
   *   - 未命中 tier 的套餐（如免费试用卡）各自单卡展示，追加在后，保持 planList 原顺序
   */
  const planTiers = useMemo<PlanTierGroup[]>(() => {
    const tierMap = new Map<PlanTierKey, PlanInfo[]>();
    const uncategorized: PlanInfo[] = [];
    for (const plan of planList) {
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
      /* 按积分降序：AI 增强版（积分多）在左并作为默认选中，标准版（积分少）在右 */
      const sorted = [...variants].sort((a, b) => (b.raw.credit ?? 0) - (a.raw.credit ?? 0));
      if (tk === "voyage") {
        /* 远航（需求1）：屏蔽后端可能已配置的价格 / 促销 / 下单入口，统一「敬请期待」，单卡无积分切换。
           清空 price / promoTag 并复位 priceUnavailable / pricingLoading，确保价格区落到「敬请期待」分支；
           CTA 文案同步改为「敬请期待」。 */
        const first = sorted[0]!;
        groups.push({
          key: tk,
          variants: [{
            ...first,
            comingSoon: true,
            price: "",
            promoTag: undefined,
            priceUnavailable: false,
            pricingLoading: false,
            ctaLabel: t("敬请期待"),
          }],
        });
      } else {
        /* AI 增强版可见性：启航 / 巡游的 AI 档位（月付 / 季付）均展示价格 + 下单入口。
           - 已登录：保留后端真实价格 / 促销 / 下单入口，积分取后端 bundle.credit。
           - 未登录：走前端静态价（buildStaticBundles 已为 AI bundle 补上原价 + 折扣，
             月付「首月 6 折」/季付 9 折无标签），展示折后价 + 原价删除线；CTA 点击引导登录，
             与标准版未登录一致。
           - 远航（voyage）仍在上方单独强制「敬请期待」。 */
        groups.push({ key: tk, variants: sorted });
      }
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
  } | null>(null);

  /* 引用快照供 useCallback 中读取最新 paymentContext，避免重复触发依赖 */
  const paymentContextRef = useRef(paymentContext);
  paymentContextRef.current = paymentContext;

  /* isSubscribed / finalizeBot 的 ref 镜像 — 给付费轮询 effect 用：
     setInterval 闭包必须读最新值才能正确判断「是否已拿到 active pass」；
     而 effect 又不能把它们放进依赖数组，否则会因 isSubscribed 翻转 / finalizeBot 重建
     反复销毁重建 timer，浪费请求 + 错过窗口 */
  const isSubscribedRef = useRef(isSubscribed);
  isSubscribedRef.current = isSubscribed;

  /* 重复使用的收尾逻辑：addBot + subscribe + navigate 。
     供两个链路（免费试用 / 付费下单后）复用 */
  const finalizeBot = useCallback(async (plan: PlanInfo) => {
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
  const startIntlCardPay = useCallback(async (plan: PlanInfo) => {
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
      /* 1. 下单拿 deal_names */
      const order = await repositories.plans.createPassOrder({
        bundle_id: plan.raw.bundle_id,
        period: aiDuration.period,
        time_unit: aiDuration.time_unit,
      });
      /* 2. 拉信用卡支付页 URL（PC 端 Bearer 鉴权） */
      const orderUrl = await repositories.plans.getPassOrderUrl({
        deal_names: order.deal_names,
        platform: "pc",
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

  /* paying 阶段轮询 listMyPasses：代替 SDK callback。
     轮询到有效 active pass 后自动 finalizeBot 接棒（用户无需再点「我已完成支付」）；
     超时（PAY_POLL_TIMEOUT_MS）不主动报错，用户仍可手动点「我已完成支付」兜底。 */
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
        window.clearInterval(timer);
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
  const executeCreateBot = useCallback(async (plan: PlanInfo) => {
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
      if ((!isGlobal || paidBillingActive) && !plan.skipPayment) {
        if (isGlobal) {
          /* 国际站付费链路：信用卡 hosted page 跳转（createPassOrder + getPassOrderUrl）。
             startIntlCardPay 内部新窗口打开支付页 + 进入 paying 轮询接棒 finalizeBot，
             这里不能继续往下 addBot/navigate，finalize 已处理跳转。 */
          await startIntlCardPay(plan);
        } else {
          /* 国内站付费链路：startPaidPassOrder 只展示二维码并把弹窗切到 paying；
             真正的 addBot + 跳转由两条接棒路径承接：
               ① paying 阶段轮询到 active pass → 自动 finalizeBot
               ② 用户点「我已完成支付」 → handleManualConfirm → finalizeBot
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
        const message = code === "PASS_ISOLATED"
          ? t("当前套餐已进入隔离期，请前往我的账号续费恢复使用，或在账号页销毁后重新购买。")
          : t("当前套餐已到期，请前往我的账号续费后继续使用。");
        setError({
          code,
          message,
          action: {
            label: t("前往续费"),
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
  }, [paidBillingActive, startPaidPassOrder, startIntlCardPay, startTrialPass, t]);

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
  const handlePay = useCallback(() => {
    if (!selectedPlan) return;
    /* 占位付费卡为纯前端演示：确认弹窗内部已处理支付成功展示，绝不能拿假 bundle_id 调后端下单。
       这里再兜底一层，防止误触真实下单链路。 */
    if (selectedPlan.id.startsWith("placeholder-")) return;
    void executeCreateBot(selectedPlan);
  }, [selectedPlan, executeCreateBot]);

  /**
   * 用户在「付费进行中」弹窗点「我已完成支付」 → 直接刷新 pass 列表 + finalize。
   * 仅在 fallback 模式（新窗口拉起、SDK 不可用）会出现此按钮；SDK 模式由 callback 驱动。
   * 后端 v1.7.30 明确「前端不需要轮询支付状态」，只要刷一次 pass 即可。
   */
  const handleManualConfirm = useCallback(async () => {
    const ctx = paymentContextRef.current;
    if (!ctx) return;
    try {
      await refreshPasses();
      await finalizeBot(ctx.plan);
    } catch (err) {
      const fallbackMsg = err instanceof Error ? err.message : t("创建实例失败，请稍后重试。");
      console.error("[subscribe] manual confirm finalize failed", err);
      setError({ code: getBillingErrorCode(err), message: resolveBillingErrorMessage(err, fallbackMsg) });
      setModalStep("closed");
      setSelectedPlan(null);
      setPaymentContext(null);
    }
  }, [refreshPasses, finalizeBot, t]);

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
          )}
        </section>
      </main>

      <LegalFooter />

      {/* Payment Modals */}
      <AnimatePresence>
        {modalStep === "confirm" && selectedPlan && (
          isGlobal ? (
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
            onManualConfirm={handleManualConfirm}
            onRefresh={() => void handleRefreshPayment()}
            refreshing={paymentRefreshing}
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
