/**
 * Agent 总览面板（静态 Demo）
 *
 * 位于 Agent 详情页「探索」tab 顶部的「总览」入口，用于新用户引导。
 * 当前为**纯静态 Demo**：所有数据均为本文件内的常量，交互只改本地 state，
 * 不接任何后端接口、不写任何持久化。后续接真实逻辑时替换 DEMO_* 常量与
 * 三个 handler 即可（见各处 TODO(demo) 注释）。
 *
 * 四个板块（自上而下）：
 * 0. 陪伴横幅 —— 徽章 + 陪伴天数 + 右侧数据卡
 * 1. 快速配置个人助手 —— 场景卡片，点击开弹窗（改名 / 改描述 / 删技能 / 创建或切换）
 * 2. 产品动态   —— 最近 5 条更新，每屏 2 条，自动滚动轮播
 * 3. 推荐自动化 —— 3 张任务卡 + 「查看全部」跳转自动任务页
 */

import {
  Activity,
  ChevronRight,
  Newspaper,
  Wallet,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCurrentLocale, useT } from "@/i18n/t";
import { ACCOUNT_BILLING_PATH, ACCOUNT_PATH, AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import { AppLink } from "@/lib/app-navigation";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import {
  GeometricAvatar,
} from "@/pages/marketing/agent-avatar-shapes";
import { AgentHomepageAvatar } from '@/pages/marketing/agent-template-avatar';
import { DEFAULT_HERMES_APPEARANCE, type HermesAppearance } from '@/lib/hermes-appearance';
import { AgentDressupStudio, HermesAppearanceAvatar } from '@/pages/marketing/agent-dressup-studio';
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import type { BuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
  isSetupCommandSucceeded,
  runBuddySetupPlan,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import { BUDDY_DESCRIPTION_PLACEHOLDER } from "@/pages/marketing/agent-demo-templates";
import {
  buildHermesSoulContentReadCommand,
  parseHermesSoulContent,
} from "@/pages/marketing/agent-buddy-command";
import { getRecentChangelogEntries } from "@/pages/marketing/changelog-data";
import { ModelActionTooltip } from "@/pages/marketing/agent-model-config/model-action-tooltip";

/** 读 SOUL 原文的超时，与 agent-buddy-profile 保持一致 */
const SOUL_READ_TIMEOUT_MS = 30_000;

/** 统一卡片外观：对齐成就 / 自动任务面板 */
const CARD_CLASS =
  "rounded-[10px] border border-black/[0.06] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.04)]";

/** 板块小标题 + 副标题 */
const SectionTitle = ({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) => (
  <div className="mb-3 flex min-w-0 items-end justify-between gap-3">
    <div className="min-w-0">
      <h3 className="text-[15px] font-semibold leading-6 text-black/[0.88]">{title}</h3>
      {subtitle ? <p className="mt-0.5 text-[13px] font-medium leading-5 text-black/45">{subtitle}</p> : null}
    </div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
  </div>
);

/* ────────────────────────────── 0. 陪伴横幅 ────────────────────────────── */

/** 横幅数据：全部来自真实账户与实例状态 */
export interface HeroStats {
  /** 已服务天数（activePass.created_time 起算） */
  servedDays: number | null;
  /** 有效期至（已本地化的日期串） */
  expiresAt: string | null;
  /** 剩余 AI 积分（activePass.credit_available） */
  credits: number | null;
  /** 生效中的定时任务数 */
  automations: number | null;
  /** 工作台产出数（websites capability.used_sites） */
  sites: number | null;
}

/** 服务天数拉不到时显示占位符 —— 显示 0 天会让人以为套餐没生效 */
const formatDays = (value: number | null): string => (value === null ? "\u2014" : String(value));

/** 统计数字：拉不到按 0 显示（「还没有」本身就是有效信息） */
const formatCount = (value: number | null): string => String(value ?? 0);

export const HeroBanner = ({ stats, botCount, invitedFriends }: { stats: HeroStats; botCount?: number | null; invitedFriends?: number | null }) => {
  const t = useT();

  /* 每张卡都可点，跳到对应的管理入口 */
  const statItems = [
    {
      id: "credits",
      label: t("剩余 AI 积分"),
      value: formatCount(stats.credits),
      to: ACCOUNT_BILLING_PATH,
    },
    ...(botCount !== undefined ? [{
      id: "bots",
      label: t("Bot 数量"),
      value: botCount === null ? "—" : String(botCount),
      to: AGENT_SECTION_PATH_BY_ID.overview,
    }] : [{
      id: "automations",
      label: t("定时任务"),
      value: formatCount(stats.automations),
      to: AGENT_SECTION_PATH_BY_ID.automations,
    },
    {
      id: "sites",
      label: t("工作台"),
      value: formatCount(stats.sites),
      to: AGENT_SECTION_PATH_BY_ID.website,
    }]),
    ...(invitedFriends !== undefined ? [{
      id: "invited-friends",
      label: t("已邀请好友"),
      value: formatCount(invitedFriends),
      to: ACCOUNT_PATH,
    }] : []),
  ];

  return (
    <section
      className="relative overflow-hidden rounded-xl border border-black/[0.04]"
      style={{
        backgroundImage: `url(${assetUrl("/agent-overview/hero-bg.png")})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="grid gap-4 px-5 py-4 xl:grid-cols-[minmax(0,1fr)_minmax(336px,480px)] xl:items-center xl:gap-6">
        {/* 左：徽章 + 陪伴天数 */}
        <div className="flex min-w-0 items-center gap-4">
          <img
            src={assetUrl("/agent-overview/hero-badge.png")}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="h-[104px] w-[104px] shrink-0 object-contain"
          />
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-black/55">
              {t("LightVela 已经为你服务")}
            </p>
            {/* 数字与「天」之间留一点字距，避免 DIN 数字紧贴中文 */}
            <p className="lw-font-din-num my-2 text-[28px] leading-9 tracking-tight text-black/[0.88]">
              <span className="mr-1">{formatDays(stats.servedDays)}</span>
              <span className="text-[22px]">{t("天")}</span>
            </p>
            {stats.expiresAt ? (
              <p className="mt-0.5 text-xs text-black/40">
                {t("有效期至 {{date}}", { date: stats.expiresAt })}
              </p>
            ) : null}
          </div>
        </div>

        {/* 右：数据卡 */}
        <div className={cn("grid min-w-0 grid-cols-2 gap-3", statItems.length >= 3 && "sm:grid-cols-3")}>
          {statItems.map((stat, index) => (
            <AppLink
              key={stat.id}
              to={stat.to}
              className={cn(
                "min-w-0 rounded-[10px] bg-white/70 px-4 py-3 shadow-[0_2px_10px_rgba(15,23,42,0.04)] backdrop-blur-sm transition hover:bg-white/90 hover:shadow-[0_4px_16px_rgba(15,23,42,0.08)] sm:min-w-[104px]",
                statItems.length === 3 && index === 2 && "col-span-2 sm:col-span-1",
              )}
            >
              <p className="text-xs font-medium text-black/45">{stat.label}</p>
              <p className="lw-font-din-num mt-1 text-[32px] leading-10 tracking-tight text-black/[0.88]">
                {stat.value}
              </p>
            </AppLink>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ────────────────────────────── 2. 产品动态 ────────────────────────────── */

/*
 * 取更新日志（changelog-data.ts，国内站 / 国际站各自维护）的最近 5 条，
 * 只展示月份、标题与描述，不带配图。
 * 每屏 2 张卡片，每次向左滚动 1 张：5 条共 4 个停靠位，末位后回到开头。
 */
const NEWS_LIMIT = 5;
const NEWS_PER_VIEW = 2;
/** 卡片间距，与 gap-3 一致 */
const NEWS_GAP_PX = 12;

/** 自动轮播间隔（毫秒） */
const CAROUSEL_INTERVAL_MS = 5000;

/**
 * 动态描述最多两行，超出用省略号；仅在确实被截断时挂 hover tooltip 展示全文。
 * tooltip 走 Portal（DESIGN.md · Hover Tooltip），不会被轮播视口的 overflow-hidden 裁掉。
 */
const NewsDescription = ({ text }: { text: string }) => {
  const ref = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="mt-1.5 flex">
      <ModelActionTooltip content={truncated ? text : undefined} preserveWrapper>
        <p ref={ref} className="line-clamp-2 text-[13px] leading-5 text-black/50">{text}</p>
      </ModelActionTooltip>
    </div>
  );
};

export const LatestNewsSection = () => {
  const t = useT();
  const locale = useCurrentLocale();
  const [index, setIndex] = useState(0);
  /** 用户手动点过指示器后暂停自动轮播，避免和用户操作打架 */
  const [paused, setPaused] = useState(false);
  /** 鼠标停在动态区（含描述 tooltip）时暂停，避免读全文时卡片被滑走 */
  const [hovering, setHovering] = useState(false);
  /** 键盘焦点在卡片内（如截断描述的 tooltip 触发区）时暂停，否则卡片滑走后被设为 inert，焦点丢失 */
  const [focusWithin, setFocusWithin] = useState(false);
  const entries = getRecentChangelogEntries(t, locale, NEWS_LIMIT);
  const positions = Math.max(entries.length - NEWS_PER_VIEW + 1, 1);
  const activeIndex = index >= 0 && index < positions ? index : 0;

  useEffect(() => {
    if (paused || hovering || focusWithin || positions <= 1) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % positions);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, hovering, focusWithin, positions]);

  // An empty feed has no card to render; keep hooks unconditional.
  if (entries.length === 0) return null;

  return (
    <section>
      <SectionTitle
        title={t("产品动态")}
      />

      {/* 视口裁切 + 轨道平移；轨道宽 = 视口宽，所以 100% 即一屏 */}
      <div
        className="overflow-hidden"
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
        }}
      >
        <ul
          className="flex gap-3 transition-transform duration-500 ease-out motion-reduce:transition-none"
          style={{ transform: `translateX(calc(${-activeIndex} * (100% + ${NEWS_GAP_PX}px) / ${NEWS_PER_VIEW}))` }}
        >
          {entries.map((entry, entryIndex) => {
            const visible = entryIndex >= activeIndex && entryIndex < activeIndex + NEWS_PER_VIEW;
            return (
              <li
                key={entry.id}
                aria-hidden={!visible}
                inert={!visible}
                className={cn(CARD_CLASS, "flex w-[calc((100%-12px)/2)] shrink-0 flex-col p-4")}
              >
                <p className="text-xs font-medium text-black/40">{entry.month}</p>
                <p className="mt-1.5 text-[15px] font-semibold leading-6 text-black/[0.88]">{entry.title}</p>
                {entry.desc ? <NewsDescription text={entry.desc} /> : null}
              </li>
            );
          })}
        </ul>
      </div>

      {/* 轮播指示器：每个停靠位一个，名称为该屏两条标题 */}
      {positions > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-1.5">
          {Array.from({ length: positions }, (_, position) => (
            <button
              key={position}
              type="button"
              aria-label={entries.slice(position, position + NEWS_PER_VIEW).map((item) => item.title).join(" / ")}
              aria-current={position === activeIndex ? "true" : undefined}
              onClick={() => {
                setIndex(position);
                setPaused(true);
              }}
              className={cn(
                "h-1.5 cursor-pointer rounded-full transition-all",
                position === activeIndex ? "w-5 bg-black/45" : "w-1.5 bg-black/15 hover:bg-black/25",
              )}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
};

/* ─────────────────────── 1. 我的智能伙伴 ─────────────────────── */

/** 单 Bot 与多 Bot 总览共用原有资料编辑弹窗。 */
export const ProfileEditDialog = ({
  profile,
  onClose,
  onSave,
  errorMessage,
  saving = false,
  avatarOnly = false,
}: {
  profile: BuddyProfile;
  onClose: () => void;
  onSave: (next: BuddyProfile) => void;
  errorMessage?: string | null;
  saving?: boolean;
  avatarOnly?: boolean;
}) => {
  const t = useT();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [appearance, setAppearance] = useState<HermesAppearance | null>(profile.appearance ?? null);
  const [draftAppearance, setDraftAppearance] = useState<HermesAppearance>(profile.appearance ?? DEFAULT_HERMES_APPEARANCE);
  const [dressupOpen, setDressupOpen] = useState(avatarOnly);

  const canSave = name.trim().length > 0 && !saving;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={cn("max-h-[95dvh] overflow-y-auto rounded-[0.875rem]", dressupOpen ? "md:w-[min(64rem,calc(100vw-3rem))]" : "md:w-[35rem]")}>
        {dressupOpen && <DialogTitle className="sr-only">{t("修改资料")}</DialogTitle>}
        {dressupOpen && errorMessage && <p role="alert" className="text-sm text-red-700">{errorMessage}</p>}
        {dressupOpen ? <AgentDressupStudio
          value={draftAppearance}
          saving={saving}
          onChange={setDraftAppearance}
          onBack={() => avatarOnly ? onClose() : setDressupOpen(false)}
          onConfirm={(next) => { if (avatarOnly) onSave({ ...profile, appearance: next, legacyMascot: undefined }); else { setAppearance(next); setDressupOpen(false); } }}
          className="border-0 shadow-none"
        /> : <>
        <div className="pr-6">
          <DialogTitle className="text-lg font-semibold leading-7 text-black/[0.92]">{t("修改资料")}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] leading-5 text-black/50">
            {t("修改你的智能伙伴的头像、名字与描述")}
          </DialogDescription>
        </div>

        {/* 资料与创建页使用同一外观，名称和描述在切换舞台时保留。 */}
        <div className="mt-5 flex flex-col items-center">
          {appearance ? <HermesAppearanceAvatar appearance={appearance} size={96} alive /> : <GeometricAvatar shapeId={profile.shapeId} color={profile.color} size={96} alive />}
          <button type="button" onClick={() => { setDraftAppearance(appearance ?? DEFAULT_HERMES_APPEARANCE); setDressupOpen(true); }} className="mt-2 min-h-11 cursor-pointer rounded-lg px-3 text-sm font-medium text-violet-700 hover:bg-violet-50 focus-visible:outline-2 focus-visible:outline-violet-500">
            {t("更换头像")}
          </button>
        </div>

        <div className="mt-5">
          <label className="block text-[11px] font-medium text-black/40" htmlFor="lv-profile-name">
            {t("名字")}
          </label>
          <input
            id="lv-profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="mt-1 w-full rounded-md border border-black/[0.1] px-3 py-2 text-sm font-medium text-black/[0.88] outline-none transition focus:border-black/25"
          />
        </div>

        <div className="mt-4">
          <label className="block text-[11px] font-medium text-black/40" htmlFor="lv-profile-desc">
            {t("描述")}
            <span className="ml-1 text-black/30">{t("（可选）")}</span>
          </label>
          <textarea
            id="lv-profile-desc"
            value={description}
            rows={3}
            placeholder={t(BUDDY_DESCRIPTION_PLACEHOLDER)}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-1 w-full resize-none rounded-md border border-black/[0.1] px-3 py-2 text-[13px] leading-5 text-black/70 outline-none transition placeholder:text-black/30 focus:border-black/25"
          />
        </div>

        {errorMessage && <p role="alert" className="mt-3 text-sm text-red-700">{errorMessage}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-full border border-black/[0.1] px-4 py-2 text-sm font-medium text-black/65 transition hover:bg-black/[0.03]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => onSave({
              ...profile,
              name: name.trim(),
              description,
              appearance,
            })}
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition",
              canSave
                // 可用态要显式给 pointer：Tailwind v4 下 button 默认是 default
                ? "cursor-pointer bg-black text-white hover:bg-black/85"
                : "cursor-not-allowed bg-black/[0.06] text-black/30",
            )}
          >
            {t("保存")}
          </button>
        </div>
        </>}
      </DialogContent>
    </Dialog>
  );
};

/**
 * 智能伙伴资料卡：头像 + 名字 + 描述；点击整卡可编辑。
 *
 * 头像有两套来源，按用户是否配过头像切换：
 *   - 配过（profile.yaml 的 ui_meta 里有几何体）→ 渲染几何体
 *   - 没配过（存量用户）→ 回落 bot 插画，与侧边栏同源
 * 否则存量用户会看到资料卡显示默认几何体、侧边栏显示插画，两个头像不一致。
 */
export const BuddyProfileAvatar = ({ profile, hasCustomAvatar, fallbackAvatarUrl, size = 64 }: {
  profile: BuddyProfile;
  hasCustomAvatar: boolean;
  fallbackAvatarUrl: string;
  size?: number;
}) => profile.legacyMascot ? (
  <AgentHomepageAvatar mascot={profile.legacyMascot} size={size} />
) : profile.appearance ? (
  <HermesAppearanceAvatar appearance={profile.appearance} size={size} className="shrink-0" />
) : (hasCustomAvatar || !fallbackAvatarUrl ? (
  <GeometricAvatar shapeId={profile.shapeId} color={profile.color} size={size} className="shrink-0" />
) : (
  <img src={fallbackAvatarUrl} alt="" width={size} height={size} className="shrink-0 rounded-full object-contain" />
));

const BuddyProfileSection = ({
  profile,
  hasCustomAvatar,
  fallbackAvatarUrl,
  canEdit,
  onSave,
  errorMessage,
  saving,
}: {
  profile: BuddyProfile;
  /** 用户是否配过几何体头像 */
  hasCustomAvatar: boolean;
  /** 未配过时用的 bot 插画（与侧边栏同一张） */
  fallbackAvatarUrl: string;
  canEdit: boolean;
  onSave: (next: BuddyProfile) => void;
  errorMessage?: string | null;
  saving?: boolean;
}) => {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);

  return (
    <section>
      <SectionTitle
        title={t("我的 Bot")}
        subtitle={t("这是当前 Bot 的资料卡片")}
      />

      <button
        type="button"
        aria-label={t("修改资料")}
        disabled={!canEdit}
        title={canEdit ? undefined : t("正在加载...")}
        onClick={() => setEditOpen(true)}
        className={cn(
          CARD_CLASS,
          // 无描述时整体垂直居中，避免名字偏上；有描述时顶部对齐
          profile.description ? "items-start" : "items-center",
          // Tailwind v4 按钮需显式设置可用/等待状态的光标。
          "flex w-full cursor-pointer gap-4 p-4 text-left transition hover:border-black/[0.12] disabled:cursor-wait",
        )}
      >
        <BuddyProfileAvatar profile={profile} hasCustomAvatar={hasCustomAvatar} fallbackAvatarUrl={fallbackAvatarUrl} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-6 text-black/[0.88]">
            {profile.name}
          </span>

          {profile.description ? (
            <span className="mt-2 block text-[13px] leading-5 text-black/50">
              {profile.description}
            </span>
          ) : null}
        </span>
      </button>

      {editOpen ? (
        <ProfileEditDialog
          profile={profile}
          errorMessage={errorMessage}
          saving={saving}
          onClose={() => setEditOpen(false)}
          onSave={onSave}
        />
      ) : null}
    </section>
  );
};

/* ─────────────────────────── 3. 推荐自动化 ─────────────────────────── */

type RecommendedAutomation = {
  id: string;
  name: string;
  summary: string;
  /** 与自动任务页 AUTOMATION_TEMPLATE_TONES 对齐的图标颜色（不含底色） */
  iconClass: string;
  icon: ReactNode;
};

/**
 * TODO(demo): 接真实推荐自动化接口后替换。
 * 三个场景与「自动任务」tab 的任务模板保持同名同图标同配色：
 * stock-info-digest / calorie-fitness-checkin / news-digest。
 *
 * name / summary 是中文常量，渲染处走 t(...) 翻译。因为传给 t 的是**属性值**
 * 而非字面量，i18n-extract 的 T_CALL_RE 扫不到，词典里不会有对应 key，
 * 国际站会直出中文。__i18nExtractOnlyAutomations 补上字面量形式供扫描器收录。
 */
export const DEMO_AUTOMATIONS: RecommendedAutomation[] = [
  {
    id: "stock-info-digest",
    name: "股票信息速递",
    summary: "每天整理你关注的 A股、港股、美股公开信息；只做信息速递，不给买卖建议",
    iconClass: "text-[#8E4D58]",
    icon: <Wallet className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
  {
    id: "calorie-fitness-checkin",
    name: "卡路里与健身记录",
    summary: "每天主动询问饮食、运动、体重和身体感受，做轻量估算和复盘",
    iconClass: "text-[#4A7A5F]",
    icon: <Activity className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
  {
    id: "news-digest",
    name: "每日 AI 资讯摘要",
    summary: "每天整理 AI 领域的重要动态和关键进展",
    iconClass: "text-[#556F9A]",
    icon: <Newspaper className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
];

/*
 * 让 i18n-extract 收录上面的 name / summary（与 agent-demo-templates.ts 的
 * __i18nExtractOnly 同一手法）。该函数**永不调用**，导出仅为避开 TS6133。
 */
export function __i18nExtractOnlyAutomations(t: (zh: string) => string) {
  return [
    t("股票信息速递"),
    t("每天整理你关注的 A股、港股、美股公开信息；只做信息速递，不给买卖建议"),
    t("卡路里与健身记录"),
    t("每天主动询问饮食、运动、体重和身体感受，做轻量估算和复盘"),
    t("每日 AI 资讯摘要"),
    t("每天整理 AI 领域的重要动态和关键进展"),
  ];
}

export const RecommendedAutomationsSection = () => {
  const t = useT();

  return (
    <section>
      <SectionTitle
        title={t("定时任务推荐")}        actions={(
          <AppLink
            to={AGENT_SECTION_PATH_BY_ID.automations}
            className="group inline-flex items-center gap-0.5 text-[13px] font-medium text-black/50 transition hover:text-black/80"
          >
            {t("查看全部")}
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </AppLink>
        )}
      />

      {/* 内容沿用「定时任务」tab 的任务模板（同名同图标、裸图标）；
          外框按 DESIGN.md 与本页其他卡片统一为 CARD_CLASS（10px 圆角 + 浅边框 + 轻阴影）。
          整卡可点，点击跳到定时任务页并预选模板。 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {DEMO_AUTOMATIONS.map((automation) => (
          /* 跳到定时任务页并预选该模板（?template=<id>），由那边弹出创建表单 */
          <AppLink
            key={automation.id}
            to={`${AGENT_SECTION_PATH_BY_ID.automations}?template=${encodeURIComponent(automation.id)}`}
            aria-label={t("启用{{name}}", { name: t(automation.name) })}
            className={cn(CARD_CLASS, "flex min-h-[64px] items-start gap-2.5 p-3 text-left transition hover:border-black/[0.12] hover:bg-black/[0.015]")}
          >
            <span className={cn("mt-0.5 shrink-0", automation.iconClass)}>
              {automation.icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col self-stretch">
              <span className="min-w-0 truncate text-sm font-medium text-black/82">
                {t(automation.name)}
              </span>
              <span className="mt-0.5 block line-clamp-1 text-pretty text-xs leading-4 text-black/45">
                {t(automation.summary)}
              </span>
            </span>
          </AppLink>
        ))}
      </div>
    </section>
  );
};

/* ──────────────────────────────── 面板 ──────────────────────────────── */

export const useOverviewProfileEditor = ({ botId, profileId = "", execDebugCommand, onProfileChanged }: {
  botId: string;
  profileId?: string;
  execDebugCommand: SetupExec;
  onProfileChanged: () => void;
}) => {
  const t = useT();
  /** 写入中：复用「喂咖啡」动效 + 步骤进度 */
  const [steps, setSteps] = useState<SetupStepState[] | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [isReadingSoul, setIsReadingSoul] = useState(false);

  /**
   * 资料写入：名字 / 描述 / 头像。
   *
   * 关键是 preserveSoulContent —— 这是**编辑**而非新建，SOUL.md 的正文
   * 可能是用户在对话里调教出来的，只能改元数据行（Name / Summary），
   * 正文必须原样保留。头像与描述另有 profile.yaml 一份（见 buildBuddySetupPlan）。
   *
   * 所以要先把当前 SOUL 原文读回来，交给 updateSoulMetadataFields 做字段级替换。
   */
  const resolvedProfileId = profileId.trim();
  const canEditProfile = Boolean(botId && resolvedProfileId);
  const scopeRef = useRef<object | null>(null);
  useEffect(() => {
    scopeRef.current = {};
    setSteps(null);
    setWriteError(null);
    setIsReadingSoul(false);
    return () => { scopeRef.current = null; };
  }, [botId, resolvedProfileId]);
  const applyProfile = async (next: BuddyProfile) => {
    if (!canEditProfile || isReadingSoul || steps) return;
    const scope = scopeRef.current;
    const isCurrentScope = () => scope !== null && scopeRef.current === scope;
    setWriteError(null);
    setIsReadingSoul(true);

    let existingSoul = "";
    try {
      const read = await execDebugCommand(
        botId,
        buildHermesSoulContentReadCommand(resolvedProfileId),
        { timeoutMs: SOUL_READ_TIMEOUT_MS },
      );
      if (!isSetupCommandSucceeded(read)) throw new Error("Soul read failed");
      const parsed = parseHermesSoulContent(read.output || "");
      if (parsed.status !== "ready" && parsed.status !== "missing") {
        if (isCurrentScope()) setWriteError(parsed.status === "too_large"
          ? t("当前人设文件超过 20 KB，暂不支持在线编辑或下载")
          : t("无法读取人设文件，请重试"));
        return;
      }
      if (parsed.status === "ready") existingSoul = parsed.markdown;
    } catch {
      if (isCurrentScope()) setWriteError(t("无法读取人设文件，请重试"));
      return;
    } finally {
      if (isCurrentScope()) setIsReadingSoul(false);
    }

    // 读取期间切换目标或卸载后，不再启动旧目标的写入。
    if (!isCurrentScope()) return;
    const plan = buildBuddySetupPlan({
      profile: { name: next.name, description: next.description },
      profileId: resolvedProfileId,
      avatar: { shapeId: next.shapeId, color: next.color },
      appearance: next.appearance ?? undefined,
      timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
      // 仅成功读取到明确的 missing 状态时允许新建；其他读取失败均已中止。
      preserveSoulContent: Boolean(existingSoul),
      existingSoul,
      t,
    });
    setSteps(plan.map((step) => ({ step, status: "pending" as const })));

    try {
      await runBuddySetupPlan({
        botId,
        steps: plan,
        exec: (targetBotId, command, options) => {
          if (!isCurrentScope()) throw new Error("Profile edit target changed");
          return execDebugCommand(targetBotId, command, options);
        },
        onProgress: (progress) => { if (isCurrentScope()) setSteps(progress); },
      });
      if (!isCurrentScope()) return;
      onProfileChanged();
      setSteps(null);
    } catch (error) {
      if (isCurrentScope()) setWriteError(error instanceof Error ? error.message : String(error));
    }
  };

  return { steps, writeError, isReadingSoul, canEditProfile, resolvedProfileId, applyProfile };
};

export const AgentOverviewPanel = ({
  botId,
  profileId = "",
  profile,
  execDebugCommand,
  onProfileChanged,
  heroStats,
  hasCustomAvatar = false,
  fallbackAvatarUrl = "",
}: {
  botId: string;
  profileId?: string;
  /** 由页面从真实 SOUL.md 读出的资料 */
  profile: BuddyProfile;
  execDebugCommand: SetupExec;
  /** 写入成功后通知页面重新拉取 SOUL */
  onProfileChanged: () => void;
  /** 横幅数据（套餐 / 定时任务 / 站点），由页面注入真实值 */
  heroStats: HeroStats;
  /**
   * 用户是否配过几何体头像。
   * false（存量用户）时资料卡回落 bot 插画，与侧边栏保持一致。
   */
  hasCustomAvatar?: boolean;
  /** 未配过头像时使用的插画 URL（与侧边栏同一张） */
  fallbackAvatarUrl?: string;
}) => {
  const t = useT();
  const { steps, writeError, isReadingSoul, canEditProfile, resolvedProfileId, applyProfile } = useOverviewProfileEditor({
    botId, profileId, execDebugCommand, onProfileChanged,
  });

  if (steps) {
    return <CreatingLoadingView errorMessage={writeError} steps={steps} />;
  }

  return (
    /*
     * gap-10 管板块之间的间距（原先是 gap-6，各板块挤在一起、层次不清）。
     * 标题不跟着这个间距走 —— 它和下方 Hero 是同一组内容，拉到 40px 会
     * 显得断开，所以标题自己用 -mb 收回一部分。
     */
    <div className="flex min-w-0 flex-col gap-10">
      {/* 不用 AgentSectionHeader：它的 description 必填且会渲染空段落占位 */}
      <h2 className="-mb-4 text-[18px] font-semibold leading-6 tracking-normal text-black/[0.95]">
        {t("总览")}
      </h2>
      <HeroBanner stats={heroStats} />
      <BuddyProfileSection
        key={JSON.stringify([botId, resolvedProfileId])}
        canEdit={canEditProfile}
        errorMessage={writeError}
        saving={isReadingSoul}
        profile={profile}
        hasCustomAvatar={hasCustomAvatar}
        fallbackAvatarUrl={fallbackAvatarUrl}
        onSave={(next) => void applyProfile(next)}
      />
      <LatestNewsSection />
      <RecommendedAutomationsSection />
    </div>
  );
};
