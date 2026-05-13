import { LegalFooter } from "@/components/site/legal-footer";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, User, Monitor, Clock, HardDrive, Settings, Zap, Sparkles, X, RefreshCw, Loader2, Wifi } from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useOpenClaw } from "@/contexts/openclaw-context";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import { BrandMark } from "@/components/site/brand-mark";
import { InviteCodeModal } from "@/components/site/login-modal";
import { RepositoryError } from "@/repositories/http-repositories";
import type { Bundle } from "@/domain/types";
import { useT } from "@/i18n/t";
import { isGlobal } from "@/lib/region";

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
  /* 未上线占位：按钮禁用，展示「即将上线 / 敬请期待」，保留正常价格 */
  comingSoon?: boolean;
  /* 免费套餐：跳过支付弹窗，直接创建 */
  skipPayment?: boolean;
  /* 当日剩余名额展示 */
  availableCount?: number;
  totalCount?: number;
  raw: Bundle;
}

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

const mapBundleToPlan = (bundle: Bundle, index: number, t: (zh: string, opts?: Record<string, unknown>) => string): PlanInfo => {
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
    const k = (entry.Key ?? "").toLowerCase();
    if (k.includes("agent") || k.includes("积分") || k.includes("credit")) continue;
/* 「独立环境」统一前端展示规格，避免后端 Value 为空导致卡片露馅 */
    if (entry.Key === "独立环境") {
      envFeature = { icon: iconForKey(entry.Key), label: t("独立环境"), value: t("2核 4G 内存") };
      continue;
    }
    /* 「专属云端存储」前端统一展示容量，避免后端缺值 */
    if (entry.Key === "专属云端存储") {
      storageFeature = { icon: iconMap.hardDrive, label: t("专属云端存储"), value: "50G" };
      continue;
    }
    /* 后端 Value 为空时，用右侧勾替代，避免卡片右侧空白 */
    if (!entry.Value) {
      otherFeatures.push({ icon: iconForKey(entry.Key), label: t(entry.Key), hasCheck: true });
      continue;
    }
    otherFeatures.push({ icon: iconForKey(entry.Key), label: t(entry.Key), value: entry.Value });
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

  /* 内测期间：无论后端是否返回 price，前端统一当免费版展示，价格右侧用 promoTag 标出"限时免费"。
     credit 是积分数量，与价格无关；price 字段待后续订阅变现时再恢复取用。 */
  const isFree = true;
  const soldOut = bundle.bundle_sales_state === "SOLD_OUT";

  return {
    id: bundle.bundle_id,
    name: bundle.bundle_name,
    badge: soldOut ? t("已售罄") : undefined,
    badgeStyle: soldOut ? "tag" : undefined,
    price: isGlobal ? "$7.5" : "¥49",
    priceUnit: isGlobal ? "/ month" : t("/ 月"),
    /* 国际站展示美元价格；国内站保留内测限时免费提示。 */
    promoTag: soldOut || isGlobal ? undefined : t("限时免费"),
    description: t("尝鲜体验，从一个 Agent 开始"),
    features,
    ctaLabel: soldOut ? t("已售罄") : t("立即开通"),
    ctaStyle: index === 0 ? "primary" : "outline",
    featured: index === 0,
    maxBots: bundle.agent_quota || 1,
    soldOut,
    skipPayment: isFree,
    availableCount: bundle.bundle_sales_available_count,
    totalCount: bundle.bundle_sales_total_count,
    raw: bundle,
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
  price: 0,
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
  },
];

/**
 * i18n 静态标记块：占位套餐的中文字面量定义在 PLACEHOLDER_PLAN_DEFS 数据里，
 * extract 脚本只能扫到 `t("...")` 字面量调用，无法跟踪 `t(def.name)` 这种动态参数。
 * 因此在这里把所有占位套餐里出现过的中文，以一次性 `t("...")` 调用的形式声明出来，
 * 既不影响运行时（这次调用结果被丢弃），又能保证 i18n-extract 把它们收录进字典。
 *
 * ⚠️ 修改 PLACEHOLDER_PLAN_DEFS 时请同步更新此处。
 */
const __markPlaceholderPlansForI18n = (t: (zh: string, opts?: Record<string, unknown>) => string): void => {
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
  /* 静态标记，运行时一次性调用以让字典加载它们的翻译 */
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
    raw: makePlaceholderBundle(def.id, def.name, def.agentQuota),
  }));
};

/**
 * 后端错误码 → 用户提示文案映射（与 frontend-bundle-pass-integration.md 对齐）
 */
const mapPassErrorToMessage = (code: string | undefined, fallback: string, t: (zh: string) => string): string => {
  switch (code) {
    case "PASS_INVALID_PARAM":
      return t("请选择套餐");
    case "BUNDLE_NOT_FOUND":
      return t("套餐已下架");
    case "PASS_BUNDLE_OFFLINE":
      return t("该套餐已下线");
    case "PASS_BUNDLE_SOLD_OUT":
      return t("该套餐暂时售罄");
    case "BUNDLE_SALES_QUOTA_EMPTY":
      return t("今日名额已抢完，明天再试");
    case "PASS_ALREADY_EXISTS":
      return t("您已拥有权益，无需重复购买");
    case "PASS_QUOTA_EXCEEDED":
      return t("当前使用量超出该套餐限额");
    case "realname_required":
      return isGlobal ? t("创建失败，请稍后重试。") : t("请先完成实名认证后再开通套餐。");
    default:
      return fallback;
  }
};

/* ─── Notion-style Navbar ─── */

const SubscribeNavbar = () => {
  const t = useT();
  return (
    <header
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        zIndex: 50,
        background: "rgba(255,255,255,0.96)",
        backdropFilter: "blur(12px) saturate(180%)",
        WebkitBackdropFilter: "blur(12px) saturate(180%)",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 56,
          padding: "0 24px",
        }}
      >
        <BrandMark to="/" />
        <Link
          to="/"
          style={{
            fontSize: 15,
            fontWeight: 500,
            color: colors.warmGray500,
            transition: "color 0.2s",
            textDecoration: "none",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = colors.warmGray500; }}
        >
          {t("返回首页")}
        </Link>
      </div>
    </header>
  );
};

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
  /* 售罄 / 未上线套餐：按钮永远禁用 */
  const disabled = isSoldOut || isComingSoon || subscribing || quotaWouldExceed;

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
        ) : plan.price ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 2, marginBottom: 8, flexWrap: "wrap", rowGap: 6 }}>
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
                  fontSize: 12,
                  fontWeight: 600,
                  lineHeight: 1,
                  color: "#D14081",
                  background: "#FDE7F0",
                  border: "1px solid #F7B8D2",
                  borderRadius: 999,
                  padding: "4px 10px",
                  marginLeft: 8,
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

/* ─── WeChat QR Code Modal ─── */

const WechatQRModal = ({
  onClose,
  onComplete,
  submitting,
}: {
  onClose: () => void;
  onComplete: () => void;
  submitting: boolean;
}) => {
  const t = useT();
  const [refreshKey, setRefreshKey] = useState(0);
  const mockQrValue = `https://lightclaw.tech/pay/mock?t=${Date.now()}&k=${refreshKey}`;

  return (
    <motion.div
      style={modalOverlayStyle}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onClose}
    >
      <motion.div
        style={{ ...modalPanelStyle, maxWidth: 400 }}
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.25, ease: [0.25, 0.1, 0.25, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          style={modalCloseStyle}
          onClick={onClose}
          onMouseEnter={(e) => { e.currentTarget.style.background = colors.warmWhite; e.currentTarget.style.color = colors.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = colors.warmGray300; }}
        >
          <X style={{ width: 18, height: 18 }} />
        </button>

        <div style={{ padding: "28px 28px 24px", textAlign: "center" }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: colors.black, margin: "0 0 24px", letterSpacing: "-0.25px", textAlign: "left" }}>
            {t("微信支付")}
          </h3>

          <div
            style={{
              display: "inline-flex",
              padding: 16,
              borderRadius: 12,
              border: `1px solid ${colors.border}`,
              background: colors.white,
              marginBottom: 20,
            }}
          >
            <QRCodeSVG
              value={mockQrValue}
              size={200}
              level="M"
              bgColor="#ffffff"
              fgColor="#000000"
              style={{ display: "block" }}
            />
          </div>

          <p style={{ fontSize: 14, fontWeight: 500, color: colors.black, margin: "0 0 4px" }}>
            {t("请使用微信扫描二维码完成支付")}
          </p>
          <p style={{ fontSize: 13, color: colors.warmGray300, margin: "0 0 24px" }}>
            {t("扫码后请在手机上完成操作")}
          </p>

          <div style={{ display: "flex", gap: 12 }}>
            <button
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={submitting}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "12px 16px",
                borderRadius: 8,
                border: `1px solid ${colors.border}`,
                background: colors.white,
                color: colors.black,
                fontSize: 15,
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.5 : 1,
                transition: "all 0.15s",
              }}
            >
              <RefreshCw style={{ width: 15, height: 15 }} />
              {t("刷新")}
            </button>
            <button
              onClick={onComplete}
              disabled={submitting}
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: colors.primary,
                color: colors.white,
                fontSize: 15,
                fontWeight: 600,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
                transition: "all 0.15s",
              }}
            >
              {submitting ? t("处理中...") : t("完成")}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

/* ─── Subscribe Page ─── */

type ModalStep = "closed" | "confirm" | "qrcode";
type SubscribeError = {
  code?: string;
  message: string;
};

export const SubscribePage = () => {
  const t = useT();
  const navigate = useNavigate();
  const { isLoggedIn, login, isSubscribed, subscribe, addBot, bots, user, refreshPasses } = useOpenClaw();
  const { session } = useSession();
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

  const quotaExceeded = bots.length >= user.plan.maxBots;

  /* 进入订阅页即触发登录态 */
  useEffect(() => {
    if (!isLoggedIn) {
      login();
    }
  }, [isLoggedIn, login]);

  /* 拉取上线套餐列表（GET /v1/bundles）*/
  useEffect(() => {
    let cancelled = false;
    const loadBundles = async () => {
      setBundlesLoading(true);
      setBundlesError(null);
      try {
        const list = await repositories.plans.listBundles();
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
    void loadBundles();
    return () => {
      cancelled = true;
    };
  }, [repositories.plans]);

  /* 映射成 PlanInfo，保留原 bundle 用于后续时用 bundle_id 调购买 */
  const planList = useMemo<PlanInfo[]>(() => {
    if (!bundles) return [];
    const fromBackend = bundles.map((b, idx) => mapBundleToPlan(b, idx, t));
    /* 后端目前只上线了免费版，前端补两张「敬请期待」的占位卡，保持三列栅格 */
    return [...fromBackend, ...buildPlaceholderPlans(t)];
  }, [bundles, t]);

  /* 执行真正的购买权益 + 创建实例流程 */
  const executeCreateBot = useCallback(async (plan: PlanInfo) => {
    setSubscribingPlanId(plan.id);
    setError(null);
    try {
      /* 1. 未订阅时先在后端创建权益（POST /v1/passes）；已有活跃权益则跳过 */
      if (!isSubscribed) {
        try {
          await repositories.plans.createPass(plan.raw.bundle_id);
          /* 同步一下 context 的 pass 缓存 */
          await refreshPasses();
        } catch (passErr) {
          /* PASS_ALREADY_EXISTS 不当做错误，直接进入创建 Agent 流程 */
          const code = (passErr as RepositoryError).code;
          if (code !== "PASS_ALREADY_EXISTS") {
            throw passErr;
          }
          await refreshPasses();
        }
      }
      /* 2. 调用后端创建实例资源 */
      const createdBot = await addBot({
        name: t("我的Hermes"),
        personality: t("默认设定"),
        personalityEmoji: "✨",
        intro: "",
        soulTemplateId: undefined,
        status: "running",
      });
      subscribe();
      setModalStep("closed");
      setSelectedPlan(null);
      /* 3. 跳转到管理页，由管理页轮询真实后端状态，Running 后才交付 */
      navigate(`/dashboard/settings?creating=${encodeURIComponent(createdBot.id)}`);
    } catch (err) {
      const fallbackMsg = err instanceof Error ? err.message : t("创建失败，请稍后重试。");
      const code = err instanceof RepositoryError ? err.code : (err as Error & { code?: string })?.code;
      console.error("[subscribe] create bot failed", err instanceof RepositoryError
        ? { status: err.status, code: err.code, message: err.message }
        : err);
      /* 兼容：后端若以「邀请码」相关错误拒绝创建，自动弹出邀请码弹窗，激活后继续订阅 */
      const isInviteError = /invite|邀请码/i.test(fallbackMsg) || /invite/i.test(code ?? "");
      if (isInviteError) {
        setPendingPlan(plan);
        setShowInviteCode(true);
        setModalStep("closed");
        setSelectedPlan(null);
      } else {
        setError({ code, message: mapPassErrorToMessage(code, fallbackMsg, t) });
        setModalStep("closed");
        setSelectedPlan(null);
      }
    } finally {
      setSubscribingPlanId(null);
    }
  }, [isSubscribed, repositories.plans, refreshPasses, addBot, subscribe, navigate]);

  const handleSubscribe = useCallback((planId: string) => {
    const plan = planList.find((p) => p.id === planId);
    if (!plan) return;

    /* 售罄 / 未上线套餐按钮已 disabled，这里再加一层保护 */
    if (plan.soldOut || plan.comingSoon) return;

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
  }, []);

  const handlePay = useCallback(() => {
    setModalStep("qrcode");
  }, []);

  const handleComplete = useCallback(async () => {
    if (!selectedPlan) return;
    await executeCreateBot(selectedPlan);
  }, [selectedPlan, executeCreateBot]);

  if (quotaExceeded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
        <SubscribeNavbar />
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
            <Link
              to="/dashboard/settings"
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
            </Link>
            <div style={{ marginTop: 24 }}>
              <Link
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
              </Link>
            </div>
          </div>
        </main>
        <LegalFooter />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh", background: colors.white, color: colors.black }}>
      <SubscribeNavbar />

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
                    <Link
                      to="/account"
                      style={{ color: "#cf3d4c", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 3 }}
                    >
                      {t("我的账号")}
                    </Link>{" "}
                    {t("进行实名。")}
                  </>
                ) : error.message}
              </p>
            </motion.div>
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
                  setBundles(null);
                  setBundlesError(null);
                  void repositories.plans.listBundles().then(setBundles).catch((err) => setBundlesError(err instanceof Error ? err.message : t("套餐列表加载失败")));
                }}
                style={{ padding: "8px 20px", borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, color: colors.black, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
              >
                {t("重试")}
              </button>
            </div>
          ) : planList.length === 0 ? (
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
                gridTemplateColumns: planList.length >= 3 ? "repeat(3, 1fr)" : `repeat(${planList.length}, 1fr)`,
                gap: 24,
                maxWidth: 960,
                margin: "0 auto",
              }}
            >
              {planList.map((plan, idx) => (
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
        {modalStep === "qrcode" && (
          <WechatQRModal
            key="qrcode"
            onClose={handleCloseModal}
            onComplete={() => void handleComplete()}
            submitting={subscribingPlanId !== null}
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
