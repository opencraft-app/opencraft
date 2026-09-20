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
 * 2. 最新动态   —— 左图右文，自动轮播
 * 3. 推荐自动化 —— 3 张任务卡 + 「查看全部」跳转自动任务页
 */

import {
  Activity,
  ChevronRight,
  Newspaper,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useCurrentLocale, useT } from "@/i18n/t";
import { ACCOUNT_PATH, AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import { AppLink } from "@/lib/app-navigation";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import {
  AVATAR_SHAPES,
  GeometricAvatar,
  randomizeAvatarBatch,
} from "@/pages/marketing/agent-avatar-shapes";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import type { BuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
  runBuddySetupPlan,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import { BUDDY_DESCRIPTION_PLACEHOLDER } from "@/pages/marketing/agent-demo-templates";
import {
  buildHermesSoulContentReadCommand,
  parseHermesSoulContent,
} from "@/pages/marketing/agent-buddy-command";

/** 读 SOUL 原文的超时，与 agent-buddy-profile 保持一致 */
const SOUL_READ_TIMEOUT_MS = 30_000;

/** 统一卡片外观：对齐成就 / 自动任务面板 */
const CARD_CLASS =
  "rounded-[4px] border border-black/[0.06] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.04)]";

/** 板块小标题 + 副标题 */
const SectionTitle = ({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) => (
  <div className="mb-3 flex min-w-0 items-end justify-between gap-3">
    <div className="min-w-0">
      <h3 className="text-[15px] font-semibold leading-6 text-black/[0.88]">{title}</h3>
      <p className="mt-0.5 text-[13px] font-medium leading-5 text-black/45">{subtitle}</p>
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
  /** 剩余积分（activePass.credit_available） */
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

const HeroBanner = ({ stats }: { stats: HeroStats }) => {
  const t = useT();

  /* 每张卡都可点，跳到对应的管理入口 */
  const statItems = [
    {
      id: "credits",
      label: t("剩余积分"),
      value: formatCount(stats.credits),
      to: ACCOUNT_PATH,
    },
    {
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
    },
  ];

  return (
    <section
      className="relative overflow-hidden rounded-[4px] border border-black/[0.04]"
      style={{
        backgroundImage: `url(${assetUrl("/agent-overview/hero-bg.png")})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
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

        {/* 右：三张数据卡 */}
        <div className="grid shrink-0 grid-cols-3 gap-3">
          {statItems.map((stat) => (
            <AppLink
              key={stat.id}
              to={stat.to}
              className="min-w-[104px] rounded-[10px] bg-white/70 px-4 py-3 shadow-[0_2px_10px_rgba(15,23,42,0.04)] backdrop-blur-sm transition hover:bg-white/90 hover:shadow-[0_4px_16px_rgba(15,23,42,0.08)]"
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

/* ────────────────────────────── 2. 最新动态 ────────────────────────────── */

/*
 * changelog 条目。
 *
 * date 用结构化的 y/m/d 而不是「2026年9月10日」整串：
 * 日期格式各语言不同（en 是 "September 10, 2026"、ja 是「2026年9月10日」），
 * 整串进词典等于每加一条动态都要翻 8 个语种。这里存数字，渲染时用
 * Intl.DateTimeFormat 按当前 locale 格式化。
 *
 * title / body / imageAlt 仍是中文原文 —— 它们是 t() 的 key，
 * 在渲染时翻译（模块级常量拿不到 hook）。
 */
type ChangelogEntry = {
  date: { y: number; m: number; d: number };
  title: string;
  body: string;
  image: string;
  imageAlt: string;
};

/** TODO(demo): 接真实 changelog 数据源后替换 */
const DEMO_CHANGELOG: ChangelogEntry[] = [
  {
    date: { y: 2026, m: 9, d: 10 },
    title: "定时任务新增通知任务和脚本任务",
    body: "支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。",
    image: assetUrl("/agent-overview/changelog-task-types.jpg"),
    imageAlt: "定时任务新增通知任务和脚本任务",
  },
  {
    date: { y: 2026, m: 9, d: 2 },
    title: "支持创建和发布工作台",
    body: "支持在 LightVela 中选择模板或从零开始创建个人工作台，并以静态网站的形式直接发布、预览、更新和管理自己的工作台。",
    image: assetUrl("/agent-overview/changelog-workbench.jpg"),
    imageAlt: "支持创建和发布工作台",
  },
  {
    date: { y: 2026, m: 8, d: 28 },
    title: "实验室新增 DeepSeek Harness",
    body: "在 Hermes Agent 之外安装和管理 DeepSeek Harness，使用专属 WebUI、模型提供商配置、插件管理、工作区和独立服务控制。",
    image: assetUrl("/agent-overview/changelog-deepseek-harness.jpg"),
    imageAlt: "实验室新增 DeepSeek Harness",
  },
];

/** 自动轮播间隔（毫秒） */
const CAROUSEL_INTERVAL_MS = 5000;

const LatestNewsSection = () => {
  const t = useT();
  const locale = useCurrentLocale();
  const [index, setIndex] = useState(0);
  /** 用户手动点过指示器后暂停自动轮播，避免和用户操作打架 */
  const [paused, setPaused] = useState(false);
  const total = DEMO_CHANGELOG.length;
  const entry = DEMO_CHANGELOG[index]!;

  useEffect(() => {
    if (paused || total <= 1) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % total);
    }, CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, total]);

  return (
    <section>
      <SectionTitle
        title={t("最新动态")}
        subtitle={t("LightVela 的新功能、改进和修复更新")}
      />

      {/* 卡片本身不留内边距：配图紧贴卡片左边与上下边框铺满，文案侧单独给 padding */}
      <div className={cn(CARD_CLASS, "overflow-hidden")}>
        <div className="grid items-stretch sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          {/*
            左：功能配图（撑满左侧，无左/上/下留白）。
            比例跟随素材的 16:9 —— 这些信息图四周分布着卡片与连线元素，
            用 16/10 容器配 object-cover 会把上下各裁掉约 5%，正好切到内容。
          */}
          <div className="aspect-[16/9] overflow-hidden bg-black/[0.015]">
            <img
              src={entry.image}
              alt={t(entry.imageAlt)}
              loading="lazy"
              decoding="async"
              width={900}
              height={506}
              className="h-full w-full object-cover"
            />
          </div>

          {/* 右：文案 */}
          <div className="flex min-w-0 flex-col justify-center p-4">
            {/*
              日期按当前 locale 格式化，不进词典。
              月份用 long 而不是数字：en 得到 "September 10, 2026"，
              ja/zh 得到「2026年9月10日」，都是各自的习惯写法。
            */}
            <p className="text-xs font-medium text-black/40">
              {new Intl.DateTimeFormat(locale, {
                year: "numeric", month: "long", day: "numeric",
              }).format(new Date(entry.date.y, entry.date.m - 1, entry.date.d))}
            </p>
            <p className="mt-1.5 text-[15px] font-semibold leading-6 text-black/[0.88]">
              {t(entry.title)}
            </p>
            <p className="mt-1.5 text-[13px] leading-5 text-black/50">{t(entry.body)}</p>
          </div>
        </div>
      </div>

      {/* 轮播指示器：移到卡片外，避免在卡片内引入下边距破坏配图铺满 */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {DEMO_CHANGELOG.map((item, itemIndex) => (
          <button
            key={item.title}
            type="button"
            aria-label={t(item.title)}
            aria-current={itemIndex === index ? "true" : undefined}
            onClick={() => {
              setIndex(itemIndex);
              setPaused(true);
            }}
            className={cn(
              "h-1.5 cursor-pointer rounded-full transition-all",
              itemIndex === index ? "w-5 bg-black/45" : "w-1.5 bg-black/15 hover:bg-black/25",
            )}
          />
        ))}
      </div>
    </section>
  );
};

/* ─────────────────────── 1. 我的智能伙伴 ─────────────────────── */

/** 编辑资料的弹窗：名字 / 标签 / 描述 */
const ProfileEditDialog = ({
  profile,
  onClose,
  onSave,
}: {
  profile: BuddyProfile;
  onClose: () => void;
  onSave: (next: BuddyProfile) => void;
}) => {
  const t = useT();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  /* 头像：与创建引导同一套交互（形状候选 + 换一批） */
  const [shapeId, setShapeId] = useState(profile.shapeId);
  const [color, setColor] = useState(profile.color);
  const [shapeBatch, setShapeBatch] = useState(() => AVATAR_SHAPES.slice(0, 8));

  const canSave = name.trim().length > 0;

  /** 换一批：重抽候选形状 + 换配色；当前形状不在新批次时顺延第一个 */
  const handleRandomize = () => {
    const next = randomizeAvatarBatch({ currentColor: color });
    setShapeBatch(next.shapes);
    setColor(next.color);
    if (!next.shapes.some((item) => item.id === shapeId)) {
      setShapeId(next.shapes[0]!.id);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="rounded-[0.875rem] md:w-[32rem]">
        <div className="pr-6">
          <h2 className="text-lg font-semibold leading-7 text-black/[0.92]">{t("编辑资料")}</h2>
          <p className="mt-1 text-[13px] leading-5 text-black/50">
            {t("修改你的智能伙伴的头像、名字与描述")}
          </p>
        </div>

        {/* ── 头像：大预览 + 形状候选 + 换一批 ── */}
        <div className="mt-5 flex flex-col items-center">
          <GeometricAvatar shapeId={shapeId} color={color} size={72} alive />
          <div className="mt-3 flex flex-nowrap justify-center gap-2">
            {shapeBatch.map((shape) => (
              <button
                key={shape.id}
                type="button"
                aria-label={shape.id}
                aria-pressed={shape.id === shapeId}
                onClick={() => setShapeId(shape.id)}
                className={cn(
                  // 无边框：几何体本身有形状与配色，方框反而抢视线
                  "inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-[4px] transition",
                  shape.id === shapeId
                    ? "bg-black/[0.06]"
                    : "hover:bg-black/[0.03]",
                )}
              >
                <GeometricAvatar shapeId={shape.id} color={color} size={24} />
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={handleRandomize}
            className="mt-2.5 inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] px-2.5 py-1 text-[13px] font-medium text-black/55 transition hover:bg-black/[0.03] hover:text-black/80"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t("换一批")}
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
            className="mt-1 w-full rounded-[3px] border border-black/[0.1] px-3 py-2 text-sm font-medium text-black/[0.88] outline-none transition focus:border-black/25"
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
            className="mt-1 w-full resize-none rounded-[3px] border border-black/[0.1] px-3 py-2 text-[13px] leading-5 text-black/70 outline-none transition placeholder:text-black/30 focus:border-black/25"
          />
        </div>

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
              shapeId,
              color,
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
const BuddyProfileSection = ({
  profile,
  hasCustomAvatar,
  fallbackAvatarUrl,
  onSave,
}: {
  profile: BuddyProfile;
  /** 用户是否配过几何体头像 */
  hasCustomAvatar: boolean;
  /** 未配过时用的 bot 插画（与侧边栏同一张） */
  fallbackAvatarUrl: string;
  onSave: (next: BuddyProfile) => void;
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
        aria-label={t("编辑资料")}
        onClick={() => setEditOpen(true)}
        className={cn(
          CARD_CLASS,
          // 无描述时整体垂直居中，避免名字偏上；有描述时顶部对齐
          profile.description ? "items-start" : "items-center",
          /*
           * cursor-pointer 必须显式写：Tailwind v4 的 Preflight 把 button 的
           * 光标改成了 default（v3 是 pointer），不加就只有 hover 变边框、
           * 光标还是箭头，整张卡看起来不像能点。项目里其他按钮同样是显式加的。
           */
          "flex w-full cursor-pointer gap-4 p-4 text-left transition hover:border-black/[0.12]",
        )}
      >
        {hasCustomAvatar || !fallbackAvatarUrl ? (
          <GeometricAvatar
            shapeId={profile.shapeId}
            color={profile.color}
            size={64}
            className="shrink-0"
          />
        ) : (
          <img
            src={fallbackAvatarUrl}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 shrink-0 rounded-full object-contain"
          />
        )}
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
          onClose={() => setEditOpen(false)}
          onSave={(next) => {
            setEditOpen(false);
            onSave(next);
          }}
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
const DEMO_AUTOMATIONS: RecommendedAutomation[] = [
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

const RecommendedAutomationsSection = () => {
  const t = useT();

  return (
    <section>
      <SectionTitle
        title={t("定时任务推荐")}
        subtitle={t("按计划运行可重复任务，LightVela 帮你搞定一切")}
        actions={(
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

      {/* 卡片样式对齐「定时任务」tab 的任务模板：无边框、裸图标、hover 变底色。
          那边已经从「色块图标 + 箭头页脚」改成了这套更轻的写法，两处同名同图标，
          视觉不该再有差异。整卡可点，点击跳到定时任务页并预选模板。 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {DEMO_AUTOMATIONS.map((automation) => (
          /* 跳到定时任务页并预选该模板（?template=<id>），由那边弹出创建表单 */
          <AppLink
            key={automation.id}
            to={`${AGENT_SECTION_PATH_BY_ID.automations}?template=${encodeURIComponent(automation.id)}`}
            aria-label={t("启用{{name}}", { name: t(automation.name) })}
            className="flex min-h-[64px] items-start gap-2.5 rounded-sm border-0 bg-white p-3 text-left transition hover:bg-black/[0.03]"
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

export const AgentOverviewPanel = ({
  botId,
  profileId = "main",
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
  /** 写入中：复用「喂咖啡」动效 + 步骤进度 */
  const [steps, setSteps] = useState<SetupStepState[] | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  /**
   * 资料写入：名字 / 描述 / 头像。
   *
   * 关键是 preserveSoulContent —— 这是**编辑**而非新建，SOUL.md 的正文
   * 可能是用户在对话里调教出来的，只能改元数据行（Name / Summary），
   * 正文必须原样保留。头像与描述另有 profile.yaml 一份（见 buildBuddySetupPlan）。
   *
   * 所以要先把当前 SOUL 原文读回来，交给 updateSoulMetadataFields 做字段级替换。
   */
  const applyProfile = async (next: BuddyProfile) => {
    setWriteError(null);

    let existingSoul = "";
    try {
      const read = await execDebugCommand(
        botId,
        buildHermesSoulContentReadCommand(profileId),
        { timeoutMs: SOUL_READ_TIMEOUT_MS },
      );
      const parsed = parseHermesSoulContent(read.output || "");
      if (parsed.status === "ready") existingSoul = parsed.markdown;
    } catch {
      /* 读不到就退回新建语义 —— 见下方 preserveSoulContent 的判断 */
    }

    const plan = buildBuddySetupPlan({
      profile: { name: next.name, description: next.description },
      profileId,
      avatar: { shapeId: next.shapeId, color: next.color },
      timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
      // 只有真的读到了现有 SOUL 才走保留模式；读失败时宁可用新建语义
      // 生成一份完整文件，也不要写出半截内容
      preserveSoulContent: Boolean(existingSoul),
      existingSoul,
      t,
    });
    setSteps(plan.map((step) => ({ step, status: "pending" as const })));

    try {
      await runBuddySetupPlan({
        botId,
        steps: plan,
        exec: execDebugCommand,
        onProgress: setSteps,
      });
      onProfileChanged();
      setSteps(null);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    }
  };

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
