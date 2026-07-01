import { LegalFooter } from "@/components/site/legal-footer";
import { PublicSiteHeader, type RenderPublicSiteHeaderLink } from "@/components/site/public-site-header";
import type { LanguageSwitcherVariant } from "@/components/site/language-switcher";
import type { PublicSiteLocale } from "@/lib/public-site-navigation";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, User, Monitor, Clock, HardDrive, Settings, Zap, Sparkles, X, Loader2, Wifi } from "lucide-react";
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import { usePaidBillingEnabled } from "@/contexts/runtime-config-context";
import { InviteCodeModal } from "@/components/site/login-modal";
import { RepositoryError } from "@/repositories/http-repositories";
import type { Bundle } from "@/domain/types";
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
import { AGENTS_HOME_PATH } from "@/lib/agent-routes";
import { captureProductEvent, PRODUCT_ANALYTICS_EVENTS } from "@/observability/posthog";
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
};

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
  /* 促销标签（如“限时免费”），展在价格右侧，粉色小徐章风格 */
  promoTag?: string;
  description: string;
  features: PlanFeature[];
  ctaLabel: string;
  ctaStyle: "outline" | "primary" | "outline-dark";
  featured?: boolean;
  maxBots: number;
  /* 售罄：按钮禁用，展示「当日名额已满 / 明天再试」 */
  soldOut?: boolean;
  /* 暂无报价：按钮禁用，价格位显示占位「—」，features 正常显示，不走「当日名额已满」兜底 */
  priceUnavailable?: boolean;
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
   * 注意：`free` 套餐由订阅页上游 planList 过滤掉，不会到达分组逻辑。
   */
  bundleType?: string;
  raw: Bundle;
}

/* ─── 套餐分类 Tab 配置 ─── */

/**
 * 套餐分类 tab，与后端 `bundle.bundle_type` 枚举对应（migration 000023 / 2026-06 后端联调确认）：
 *   - general  标准版（启航 / 巡游 / 远航）
 *   - ai       AI 增强版（启航 AI / 巡游 AI / 远航 AI）
 *   - free     免费试用套餐（订阅页**不展示**，由 planList 上游过滤）
 * 后端新增付费枚举后，**只需修改本数组**（顺序 / key / 文案）即可，业务逻辑无需变更。
 *
 * 渲染规则（见 SubscribePage 中实现）：
 *   1. 当所有套餐都没有 `bundle_type` → 不渲染 tab 栏（行为同改造前）
 *   2. 当前 tab 下无套餐 → 该 tab 隐藏，不占位
 *   3. 后端下发的 `bundle_type` 不在本表中（含联调期空串）→ 归入「其他」兜底分组
 */
const BUNDLE_TYPE_FALLBACK_KEY = "__uncategorized__";

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

/* ─── AI 增强版：付费时长子 Tab（月付 / 年付）─── */

/**
 * 仅在计费开关开启（paidBillingActive=true）且当前 tab 为 `ai` 时展示。
 * 切换后以 { time_span, time_unit } 作为 listBundles 询价参数，重拉套餐价格；
 * 下单时把 { period, time_unit } 传给 createPassOrder。
 *
 * 关于「年付」编码：暂用 `12m`（12 个月）而非 `1y`。
 *   - 后端 BundleTimeUnit 类型允许 y/m/d，但当前后端未验证 y 是否已支持；
 *   - 12m 语义等价、最兼容；后端确认支持 y 后可改回。
 */
interface AiDurationTabDef {
  key: "monthly" | "yearly";
  period: number;
  time_unit: "m";
  zhLabel: string;
}

const AI_DURATION_TABS: AiDurationTabDef[] = [
  { key: "monthly", period: 1, time_unit: "m", zhLabel: "月付" },
  { key: "yearly", period: 12, time_unit: "m", zhLabel: "年付" },
];

/* i18n 静态标记：AI_DURATION_TABS 的 zhLabel 是动态变量，extract 脚本扫不到 t() 调用 */
const __markAiDurationTabsForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
  void t("月付");
  void t("年付");
};

const iconStyle = { width: 16, height: 16, color: colors.warmGray300, strokeWidth: 1.5 };

/* ─── Icon 映射（用于纯数据 → JSX 转换）─── */

type IconKey = "user" | "monitor" | "hardDrive" | "clock" | "settings" | "zap" | "wifi" | "headphones" | "check";

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

const mapBundleToPlan = (bundle: Bundle, index: number, t: (zh: string, opts?: Record<string, unknown>) => string, paidBillingEnabled: boolean): PlanInfo => {
  /* 静态标记，运行时一次性调用以让字典加载后端下发中文的翻译 */
  __markBundleBackendStringsForI18n(t);
  const features: PlanFeature[] = [];

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
    /* 「独立环境」统一前端展示规格，避免后端 Value 为空导致卡片露馅 */
    if (rawKey === "独立环境") {
      envFeature = { icon: iconForKey(rawKey), label, value: t("2核 4G 内存") };
      continue;
    }
    /* 「专属云端存储」前端统一展示容量，避免后端缺值 */
    if (rawKey === "专属云端存储") {
      storageFeature = { icon: iconMap.hardDrive, label, value: "50G" };
      continue;
    }
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
      value: `${bundle.credit} ${t("体验积分")}`,
    });
  }
  features.push(...otherFeatures);
  /* 如果 features 比较少，填几个通用卖点（顺序：独立环境 → 专属云端存储 → 7×24 在线）*/
  if (!envFeature) {
    features.push({ icon: iconMap.monitor, label: t("独立环境"), value: t("2核 4G 内存") });
  }
  if (!storageFeature) {
    features.push({ icon: iconMap.hardDrive, label: t("专属云端存储"), value: "50G" });
  }
  if (features.length < 4 && !features.some((f) => f.label === t("7×24 在线"))) {
    features.push({ icon: iconMap.clock, label: t("7×24 在线"), hasCheck: true });
  }
  if (isGlobal && !features.some((f) => f.label === t("极简配置面板"))) {
    features.push({ icon: iconMap.settings, label: t("极简配置面板"), hasCheck: true });
  }

  /**
   * 价格 / 促销标签 / 是否跳过支付，按「计费开关 × 站点」二维分流：
   *   - `paidBillingEnabled=false`（开关未开启，老逻辑）：
   *       国内外一律走「限时免费」视觉（价格锚点 $7.5 / ¥49、显示"限时免费"标签、
   *       skipPayment=true 走免费 createPass），保证灰度期兜底与老用户视觉一致。
   *   - `paidBillingEnabled=true`（开关已开启，新逻辑）：
   *       国内站（isGlobal=false）消费后端真实价格 bundle.price.real_total_cost；
   *         无价（trade 故障 / 未登录）时禁用按钮、不展示促销徽章。
   *       国际站（isGlobal=true）暂时仍保持「限时免费」内测策略，待海外计费闭环后再切换。
   */
  const soldOut = bundle.bundle_sales_state === "SOLD_OUT";
  /* 计费开关未开启时无论国内外都视为免费视觉；开启后仅国内站进入真实计费。 */
  const paid = paidBillingEnabled && !isGlobal;
  /** 国内站要展示的真实金额（元）；后端 bundle.price.real_total_cost 单位是分，
   *  展示前需调 centsToYuan 转为元；后端 price 为 null 时返回 null 并标记为「暂无报价」禁用 */
  const realPriceYuan =
    paid && bundle.price ? centsToYuan(bundle.price.real_total_cost) : null;
  const priceUnavailable = paid && !bundle.price && !soldOut;

  let price = "";
  let promoTag: string | undefined;
  if (paid) {
    price = realPriceYuan != null ? formatYuan(realPriceYuan, bundle.price?.currency ?? "CNY") : "";
    /* 国内站不再展示"限时免费"标签 */
    promoTag = undefined;
  } else {
    /* 国际站：保持当前限时免费视觉 */
    price = isGlobal ? "$7.5" : "¥49";
    promoTag = soldOut ? undefined : t("限时免费");
  }

  /** 国内站价格不可用时按「暂无报价」展示禁用 CTA，避免点击后报错 */
  const ctaLabel = soldOut
    ? t("已售罄")
    : priceUnavailable
      ? t("暂无报价")
      : t("立即开通");

  return {
    id: bundle.bundle_id,
    /* 统一走 i18n 字典：当前语言是 en-US 则查英文（如 `启航 Launch` → Launch），
       zh-CN 则回显后端原文。 */
    name: t(bundle.bundle_name),
    badge: soldOut ? t("已售罄") : undefined,
    badgeStyle: soldOut ? "tag" : undefined,
    price,
    priceUnit: isGlobal ? "/ month" : t("/ 月"),
    /* 国际站中英文都展示促销标签：英文为 Limited free，中文为限时免费；国内站保持原有中文标签。 */
    promoTag,
    description: t("尝鲜体验，从一个 Agent 开始"),
    features,
    ctaLabel,
    ctaStyle: index === 0 ? "primary" : "outline",
    featured: index === 0,
    maxBots: bundle.agent_quota || 1,
    /* 真实售罄走 soldOut；询价缺失走 priceUnavailable，二者互斥 */
    soldOut,
    priceUnavailable,
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
     * ⚠️ 风险：一旦后端未来上线季付/年付套餐而仍未下发 time_span/time_unit，
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
      { iconKey: "monitor", label: "独立环境", value: "4核 8G 内存" },
      { iconKey: "hardDrive", label: "专属云端存储", value: "80G" },
      { iconKey: "zap", label: "模型积分", value: "-" },
      { iconKey: "clock", label: "7×24 在线", hasCheck: true },
      { iconKey: "settings", label: "极简配置面板", hasCheck: true },
    ],
    ctaLabel: "即将上线",
    ctaStyle: "outline-dark",
    maxBots: 1,
    comingSoon: true,
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
    description: "体验进阶，把效率拉满",
    features: [
      { iconKey: "user", label: "Agent", value: "3 个" },
      { iconKey: "monitor", label: "独立环境", value: "4核 8G 内存" },
      { iconKey: "hardDrive", label: "专属云端存储", value: "80G" },
      { iconKey: "zap", label: "模型积分", value: "-" },
      { iconKey: "clock", label: "7×24 在线", hasCheck: true },
      { iconKey: "settings", label: "极简配置面板", hasCheck: true },
      { iconKey: "zap", label: "新功能优先体验", hasCheck: true },
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
  void t("体验进阶，把效率拉满");
  void t("1 个");
  void t("3 个");
  void t("4核 8G 内存");
  void t("极简配置面板");
  void t("新功能优先体验");
};

/** 将纯数据占位套餐转为带 JSX + i18n 的 PlanInfo */
const buildPlaceholderPlans = (t: (zh: string, opts?: Record<string, unknown>) => string): PlanInfo[] => {
  __markPlaceholderPlansForI18n(t);
  return PLACEHOLDER_PLAN_DEFS.map((def) => ({
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
    ctaLabel: t(def.ctaLabel),
    ctaStyle: def.ctaStyle,
    maxBots: def.maxBots,
    comingSoon: def.comingSoon,
    bundleType: def.bundleType,
    raw: makePlaceholderBundle(def.id, def.name, def.agentQuota),
  }));
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
  plan,
  index,
  onSubscribe,
  subscribing,
  currentBots,
}: {
  plan: PlanInfo;
  index: number;
  onSubscribe: () => void;
  subscribing: boolean;
  currentBots: number;
}) => {
  const t = useT();
  const quotaWouldExceed = currentBots >= plan.maxBots;
  const isFeatured = plan.featured;
  const isSoldOut = plan.soldOut === true;
  const isComingSoon = plan.comingSoon === true;
  const isPriceUnavailable = plan.priceUnavailable === true;
  /* 售罄 / 未上线 / 暂无报价：按钮永远禁用 */
  const disabled = isSoldOut || isComingSoon || isPriceUnavailable || subscribing || quotaWouldExceed;

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
        boxShadow: isFeatured ? shadows.featured : shadows.card,
        overflow: "hidden",
        transition: "box-shadow 0.3s, transform 0.3s",
      }}
      onMouseEnter={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.boxShadow = shadows.deep;
          e.currentTarget.style.transform = "translateY(-2px)";
        }
      }}
      onMouseLeave={(e) => {
        if (!isFeatured) {
          e.currentTarget.style.boxShadow = shadows.card;
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
          <h3
            style={{
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: "-0.25px",
              lineHeight: 1.27,
              color: colors.black,
              margin: 0,
              marginBottom: 12,
            }}
          >
            {plan.name}
          </h3>
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
          {/* Description - 移到套餐名下方 */}
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
        </div>

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
              {t("价格更新中")}
            </span>
          </div>
        ) : plan.price ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 8, flexWrap: isGlobal ? "nowrap" : "wrap", rowGap: 6 }}>
            <span
              style={{
                fontSize: 48,
                fontWeight: 700,
                letterSpacing: "-1.5px",
                lineHeight: 1,
                color: colors.black,
              }}
            >
              {plan.price}
            </span>
            {(plan.priceUnit || plan.priceNote) && (
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 400,
                  color: colors.warmGray300,
                  lineHeight: 1.43,
                  marginLeft: 2,
                }}
              >
                {plan.priceUnit || plan.priceNote}
              </span>
            )}
            {/* 促销小徐章：位于价格右侧，粉色背景 + 深色文字，醒目告诉用户"限时免费" */}
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
                  marginLeft: isGlobal ? 6 : 8,
                  whiteSpace: "nowrap",
                  alignSelf: "center",
                }}
              >
                {plan.promoTag}
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
        <div style={{ height: 1, background: colors.border, marginBottom: 24 }} />

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
          <ul style={{ listStyle: "none", padding: 0, margin: 0, flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
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

        {/* CTA Button */}
        <div style={{ marginTop: 32 }}>
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
              onClick={onSubscribe}
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
              {isSoldOut ? plan.ctaLabel : subscribing ? t("正在创建...") : quotaWouldExceed ? t("已达上限（{{current}}/{{max}}）", { current: currentBots, max: plan.maxBots }) : plan.ctaLabel}
            </button>
          ) : (
            <button
              onClick={onSubscribe}
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
              {isSoldOut ? plan.ctaLabel : subscribing ? t("正在创建...") : quotaWouldExceed ? t("已达上限（{{current}}/{{max}}）", { current: currentBots, max: plan.maxBots }) : plan.ctaLabel}
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
  onCancel,
  onPay,
}: {
  plan: PlanInfo;
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
              <span style={{ fontWeight: 600, color: colors.black }}>{t("1个月")}</span>
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
  onCancel,
  onManualConfirm,
  onRefresh,
  refreshing,
  t,
}: {
  /** 中转页绝对 URL，用作 QRCode value */
  bridgeUrl: string;
  onCancel: () => void;
  onManualConfirm: () => void;
  /** 「刷新」按钮：重新生成二维码（重新下单换新 auth_code） */
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
            {t("请使用微信扫描下方二维码，授权后即可在微信内完成签约")}
          </p>

          {/* bridge 模式：渲染中转页 URL 的二维码，用户在微信扫码后由中转页负责走 OAuth + wxSign */}
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

          {/* 底部按钮区：左「刷新」（描边白底，重新生成二维码）+ 右「完成」（实色，等价于「我已完成支付」） */}
          <div style={{ display: "flex", flexDirection: "row", gap: 12 }}>
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
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              {t("完成")}
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
  const { isLoggedIn, login, isSubscribed, subscribe, addBot, bots, user, refreshPasses } = useOpenClaw();
  const { authReady, isAuthenticated, session } = useSession();
  const repositories = useRepositories();
  const [subscribingPlanId, setSubscribingPlanId] = useState<string | null>(null);
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

  /* 当前选中的套餐分类 tab key；null 表示尚未根据数据初始化 */
  const [selectedBundleTab, setSelectedBundleTab] = useState<string | null>(null);

  /* AI 增强版付费时长（仅 paidBillingActive && selectedBundleTab==='ai' 时生效）；
     切换时会触发 listBundles 用新时长重拉价格。默认月付。 */
  const [aiDurationKey, setAiDurationKey] = useState<AiDurationTabDef["key"]>("monthly");
  const aiDuration = useMemo(
    () => AI_DURATION_TABS.find((d) => d.key === aiDurationKey) ?? AI_DURATION_TABS[0],
    [aiDurationKey],
  );

  const paidBillingEnabled = usePaidBillingEnabled();
  const paidBillingActive = isPaidBillingEnabled(paidBillingEnabled);
  const quotaExceeded = bots.length >= user.plan.maxBots;
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

  /* 进入订阅页即触发登录态 */
  useEffect(() => {
    if (!isLoggedIn) {
      login();
    }
  }, [isLoggedIn, login]);

  /* 拉取上线套餐列表（GET /v1/bundles）
     计费开关开启且当前是 AI tab 时，携带 { time_span, time_unit } 询价参数；
     其他情况保持无参调用（老逻辑，含未开启计费开关的国际站占位卡场景）。

     加载策略（避免首屏多余请求）：
       - selectedBundleTab === null（首屏未初始化）：无参加载一次
       - selectedBundleTab === 'ai' && paidBillingActive && 非默认时长（如年付）：带参重拉覆盖价格
       - selectedBundleTab === 'ai' && paidBillingActive && 月付（默认）：复用首屏无参结果
         （已与后端约定：无参调用 == time_span=1&time_unit=m 的月付定价）
       - selectedBundleTab 变为其他 tab：不再重复拉取（数据已有，切 tab 只做前端分组）

     使用 loadKey 显式表达「要拉哪批数据」，只在 loadKey 变化时触发。
     ⚠️ 契约：loadKey 必须是稳定字符串——非 AI tab 与 AI 月付一律映射到 "__initial__"，
     依赖 useEffect 依赖 diff 机制实现「切回已加载过的场景不重拉」。
     修改本处务必保持这一映射稳定，否则会破坏首屏请求次数优化。

     retryToken 用于错误重试：++retryToken 会让 loadKey 变更 → useEffect 重跑，
     自然享受同一套 cancelled 竞态保护，无需重复抽取加载函数。 */
  const [retryToken, setRetryToken] = useState(0);
  /* AI tab 是否需要带参询价：仅当选中非默认时长（当前即年付）时为 true。
     月付为默认，与首屏无参调用返回的价格等价，直接复用即可。 */
  const needsAiPriceQuery =
    paidBillingActive && selectedBundleTab === "ai" && aiDurationKey !== "monthly";
  const loadKey = useMemo(() => {
    const base = needsAiPriceQuery
      ? `ai:${aiDurationKey}`
      : "__initial__";
    return `${base}#${retryToken}`;
  }, [needsAiPriceQuery, aiDurationKey, retryToken]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setBundlesLoading(true);
      setBundlesError(null);
      try {
        const list = await repositories.plans.listBundles(
          needsAiPriceQuery
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
    /* 防御性过滤：bundle_type === "free" 是免费试用套餐（走 CreateTrialPass 链路，不下单不计费），
       后端语义上不应出现在订阅付费页；即使运营误推或后端未来口径变更，前端也明确不展示。 */
    const purchasable = bundles.filter((b) => b.bundle_type !== "free");
    const fromBackend = purchasable.map((b, idx) => mapBundleToPlan(b, idx, t, paidBillingActive));
    /* 国内站一律以后端返回为准，不再补占位卡；
       国际站维持既有策略：付费开关关闭时补两张「敬请期待」占位卡。 */
    if (!isGlobal) return fromBackend;
    return paidBillingActive ? fromBackend : [...fromBackend, ...buildPlaceholderPlans(t)];
  }, [bundles, paidBillingActive, t]);

  /**
   * 按 `bundleType` 把 planList 分组：
   *   - 所有套餐都没有 bundleType → hasAnyType=false，UI 不渲染 tab 栏（兼容后端未下发字段的过渡期）
   *   - 命中 BUNDLE_TYPE_TABS 的归入对应 key；未命中或为空 → 归入 fallback（未分类）
   *   - 仅保留「有套餐」的 tab；空 tab 不展示
   */
  const { tabs: bundleTabs, plansByTab } = useMemo(() => {
    const hasAnyType = planList.some((p) => typeof p.bundleType === "string" && p.bundleType.trim() !== "");
    if (!hasAnyType) {
      return {
        tabs: [] as { key: string; label: string }[],
        plansByTab: {} as Record<string, PlanInfo[]>,
      };
    }
    const knownKeys = new Set(BUNDLE_TYPE_TABS.map((tab) => tab.key));
    const groups: Record<string, PlanInfo[]> = {};
    for (const plan of planList) {
      const raw = plan.bundleType?.trim() ?? "";
      const bucketKey = raw && knownKeys.has(raw) ? raw : BUNDLE_TYPE_FALLBACK_KEY;
      if (!groups[bucketKey]) groups[bucketKey] = [];
      groups[bucketKey].push(plan);
    }
    const orderedTabs: { key: string; label: string }[] = [];
    for (const tab of BUNDLE_TYPE_TABS) {
      if (groups[tab.key]?.length) {
        orderedTabs.push({ key: tab.key, label: t(tab.zhLabel) });
      }
    }
    if (groups[BUNDLE_TYPE_FALLBACK_KEY]?.length) {
      orderedTabs.push({ key: BUNDLE_TYPE_FALLBACK_KEY, label: t("其他") });
    }
    return { tabs: orderedTabs, plansByTab: groups };
  }, [planList, t]);

  /* 数据加载完后初始化默认选中 tab：选第一个有套餐的 tab；若用户切换后数据刷新导致选中 tab 消失，自动回退到第一个 tab */
  useEffect(() => {
    if (bundleTabs.length === 0) {
      if (selectedBundleTab !== null) setSelectedBundleTab(null);
      return;
    }
    if (selectedBundleTab === null || !bundleTabs.some((tab) => tab.key === selectedBundleTab)) {
      setSelectedBundleTab(bundleTabs[0].key);
    }
  }, [bundleTabs, selectedBundleTab]);

  /* 当前 tab 下展示的套餐：没有 tab（后端未下发字段）时直接展示全部 */
  const visiblePlans = useMemo<PlanInfo[]>(() => {
    if (bundleTabs.length === 0) return planList;
    if (!selectedBundleTab) return [];
    return plansByTab[selectedBundleTab] ?? [];
  }, [bundleTabs, plansByTab, planList, selectedBundleTab]);

  /* 付费过程上下文：仅在国内站走付费链路时使用。
     v1.7.31 起统一走 bridge 中转页二维码方案；不再保留 fallback 新窗口模式。
     保存当前订单 deal_names + 已选套餐 + 二维码 URL，供 PaymentPendingModal 渲染 QRCode。 */
  const [paymentContext, setPaymentContext] = useState<{
    plan: PlanInfo;
    dealNames: string[];
    bridgeUrl: string;
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
    subscribe();
    setModalStep("closed");
    setSelectedPlan(null);
    setPaymentContext(null);
    navigate(`${AGENTS_HOME_PATH}?creating=${encodeURIComponent(createdBot.id)}&plan=${encodeURIComponent(plan.id)}`);
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
    if (isSubscribed) {
      /* 已有有效 pass，直接创建实例即可 */
      await finalizeBot(plan);
      return;
    }
    /* 阶段一：下单拿 deal_names + auth_code
       AI 增强版下单：优先使用当前选中的付费时长（AI_DURATION_TABS），
       其他 tab 或未开启计费开关时沿用 bundle 自带 time_span/time_unit（老逻辑）。 */
    const useAiDuration = paidBillingActive && plan.bundleType === "ai";
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
        /* 付费链路：startPaidPassOrder 只展示二维码并把弹窗切到 paying；
           真正的 addBot + 跳转由两条接棒路径承接：
             ① paying 阶段轮询到 active pass → 自动 finalizeBot
             ② 用户点「我已完成支付」 → handleManualConfirm → finalizeBot
           因此这里**不能**再继续往下做 addBot/navigate，否则用户还没付钱实例就建了 */
        await startPaidPassOrder(plan);
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
        setError({ code, message: t("您的套餐已过期或进入隔离期，请前往「我的账号」续费。") });
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
  }, [paidBillingActive, startPaidPassOrder, startTrialPass, t]);

  const handleSubscribe = useCallback((planId: string) => {
    const plan = planList.find((p) => p.id === planId);
    if (!plan) return;

    /* 售罄 / 未上线 / 暂无报价 套餐按钮已 disabled，这里再加一层保护 */
    if (plan.soldOut || plan.comingSoon || plan.priceUnavailable) return;

    /* 检查龙虾个数是否已达该套餐上限 */
    if (bots.length >= plan.maxBots) {
      setError({ message: t("当前已有 {{current}} 个 Hermes，{{plan}}套餐最多可创建 {{max}} 只。", { current: bots.length, plan: plan.name, max: plan.maxBots }) });
      return;
    }

    setError(null);

    /* 免费套餐：跳过「确认订单」和「支付」弹窗，直接创建 */
    if (plan.skipPayment) {
      void executeCreateBot(plan);
      return;
    }

    /* 付费套餐：进入确认订单弹窗 */
    setSelectedPlan(plan);
    setModalStep("confirm");
  }, [planList, bots.length, executeCreateBot, session.stage, session.user]);

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

  if (quotaExceeded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
        {header}
        <main style={{ flexGrow: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "96px 24px 64px" }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 16,
                background: "rgba(0,0,0,0.04)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 32px",
              }}
            >
              <Sparkles style={{ width: 32, height: 32, color: colors.warmGray500 }} />
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: colors.black, marginBottom: 16 }}>{t("已达创建上限")}</h2>
            <p style={{ fontSize: 14, color: colors.warmGray300, marginBottom: 40, lineHeight: 1.6 }}>
              {t("当前 {{plan}} 套餐最多可创建 {{max}} 个 Hermes，你已达到上限。", { plan: user.plan.name, max: user.plan.maxBots })}
            </p>
            <AppLink
              to={AGENTS_HOME_PATH}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "12px 24px",
                borderRadius: 8,
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
                transition: "background 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = colors.primaryHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = colors.primary; }}
            >
              {t("管理我的智能体伙伴")} <ArrowRight style={{ width: 16, height: 16 }} />
            </AppLink>
            <div style={{ marginTop: 24 }}>
              <AppLink
                to="/"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 14,
                  color: colors.warmGray300,
                  textDecoration: "none",
                  transition: "color 0.2s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = colors.primary; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray300; }}
              >
                <ArrowLeft style={{ width: 14, height: 14 }} /> {t("返回首页")}
              </AppLink>
            </div>
          </div>
        </main>
        <LegalFooter />
      </div>
    );
  }

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
              {t("一键创建云端 Hermes Agent")}
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
                      to="/account"
                      style={{ color: "#cf3d4c", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 3 }}
                    >
                      {t("我的账号")}
                    </AppLink>{" "}
                    {t("进行实名。")}
                  </>
                ) : error.message}
              </p>
            </motion.div>
          )}

          {/* Bundle Type Tabs — 后端联调期：bundleTabs 为空时（所有套餐缺 bundle_type）整段不渲染，行为退化为改造前 */}
          {bundleTabs.length > 0 && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 8,
                marginBottom: 32,
              }}
              role="tablist"
              aria-label={t("套餐分类")}
            >
              {bundleTabs.map((tab) => {
                const active = tab.key === selectedBundleTab;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelectedBundleTab(tab.key)}
                    style={{
                      padding: "8px 20px",
                      borderRadius: 9999,
                      border: `1px solid ${active ? colors.black : colors.border}`,
                      background: active ? colors.black : colors.white,
                      color: active ? colors.white : colors.warmGray500,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: "pointer",
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      if (!active) {
                        e.currentTarget.style.color = colors.black;
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!active) {
                        e.currentTarget.style.color = colors.warmGray500;
                      }
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* AI 增强版付费时长子 Tab — 仅开启计费开关且当前 tab 为 AI 时展示 */}
          {paidBillingActive && selectedBundleTab === "ai" && (
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
          ) : visiblePlans.length === 0 ? (
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
                gridTemplateColumns: visiblePlans.length >= 3 ? "repeat(3, 1fr)" : `repeat(${visiblePlans.length}, 1fr)`,
                gap: 24,
                maxWidth: 960,
                margin: "0 auto",
              }}
            >
              {visiblePlans.map((plan, idx) => (
                <PlanCard
                  key={plan.id}
                  plan={plan}
                  index={idx}
                  onSubscribe={() => void handleSubscribe(plan.id)}
                  subscribing={subscribingPlanId === plan.id}
                  currentBots={bots.length}
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
          <ConfirmOrderModal
            key="confirm"
            plan={selectedPlan}
            onCancel={handleCloseModal}
            onPay={handlePay}
          />
        )}
        {modalStep === "paying" && paymentContext && (
          <PaymentPendingModal
            key="paying"
            bridgeUrl={paymentContext.bridgeUrl}
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
