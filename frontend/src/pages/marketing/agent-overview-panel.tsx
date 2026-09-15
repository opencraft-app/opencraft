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
  ArrowRight,
  ChevronRight,
  Newspaper,
  Wallet,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useT } from "@/i18n/t";
import { ACCOUNT_PATH, AGENT_SECTION_PATH_BY_ID } from "@/lib/agent-routes";
import { AppLink } from "@/lib/app-navigation";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";
import { CreatingLoadingView } from "@/pages/marketing/agent-creating-loading";
import type { BuddyProfile } from "@/pages/marketing/agent-buddy-profile";
import { buildBuddySetupPlan } from "@/pages/marketing/agent-buddy-setup";
import {
  runBuddySetupPlan,
  type SetupExec,
  type SetupStepState,
} from "@/pages/marketing/agent-buddy-setup-runner";
import {
  BUDDY_DESCRIPTION_PLACEHOLDER,
  BUDDY_TAGS_PLACEHOLDER,
} from "@/pages/marketing/agent-demo-templates";

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

type ChangelogEntry = { date: string; title: string; body: string; image: string; imageAlt: string };

/** TODO(demo): 接真实 changelog 数据源后替换 */
const DEMO_CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026年9月10日",
    title: "定时任务新增通知任务和脚本任务",
    body: "支持创建通知任务和脚本任务：按原文发送通知，或按计划运行预设脚本。两种任务均不调用模型，模型 Token 消耗为 0。",
    image: assetUrl("/agent-overview/changelog-task-types.jpg"),
    imageAlt: "定时任务新增通知任务和脚本任务",
  },
  {
    date: "2026年9月2日",
    title: "支持创建和发布工作台",
    body: "支持在 LightVela 中选择模板或从零开始创建个人工作台，并以静态网站的形式直接发布、预览、更新和管理自己的工作台。",
    image: assetUrl("/agent-overview/changelog-workbench.jpg"),
    imageAlt: "支持创建和发布工作台",
  },
  {
    date: "2026年8月28日",
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
              alt={entry.imageAlt}
              loading="lazy"
              decoding="async"
              width={900}
              height={506}
              className="h-full w-full object-cover"
            />
          </div>

          {/* 右：文案 */}
          <div className="flex min-w-0 flex-col justify-center p-4">
            <p className="text-xs font-medium text-black/40">{entry.date}</p>
            <p className="mt-1.5 text-[15px] font-semibold leading-6 text-black/[0.88]">
              {entry.title}
            </p>
            <p className="mt-1.5 text-[13px] leading-5 text-black/50">{entry.body}</p>
          </div>
        </div>
      </div>

      {/* 轮播指示器：移到卡片外，避免在卡片内引入下边距破坏配图铺满 */}
      <div className="mt-3 flex items-center justify-center gap-1.5">
        {DEMO_CHANGELOG.map((item, itemIndex) => (
          <button
            key={item.title}
            type="button"
            aria-label={item.title}
            aria-current={itemIndex === index ? "true" : undefined}
            onClick={() => {
              setIndex(itemIndex);
              setPaused(true);
            }}
            className={cn(
              "h-1.5 rounded-full transition-all",
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
  const [tags, setTags] = useState(profile.tags);
  const [description, setDescription] = useState(profile.description);

  const canSave = name.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="rounded-[0.875rem] md:w-[32rem]">
        <div className="pr-6">
          <h2 className="text-lg font-semibold leading-7 text-black/[0.92]">{t("编辑资料")}</h2>
          <p className="mt-1 text-[13px] leading-5 text-black/50">
            {t("修改你的智能伙伴的名字、标签与描述")}
          </p>
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
          <label className="block text-[11px] font-medium text-black/40" htmlFor="lv-profile-tags">
            {t("标签")}
            <span className="ml-1 text-black/30">{t("（可选）")}</span>
          </label>
          <input
            id="lv-profile-tags"
            value={tags}
            placeholder={BUDDY_TAGS_PLACEHOLDER}
            onChange={(event) => setTags(event.target.value)}
            className="mt-1 w-full rounded-[3px] border border-black/[0.1] px-3 py-2 text-sm text-black/[0.88] outline-none transition placeholder:text-black/30 focus:border-black/25"
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
            placeholder={BUDDY_DESCRIPTION_PLACEHOLDER}
            onChange={(event) => setDescription(event.target.value)}
            className="mt-1 w-full resize-none rounded-[3px] border border-black/[0.1] px-3 py-2 text-[13px] leading-5 text-black/70 outline-none transition placeholder:text-black/30 focus:border-black/25"
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-black/[0.1] px-4 py-2 text-sm font-medium text-black/65 transition hover:bg-black/[0.03]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => onSave({ ...profile, name: name.trim(), tags, description })}
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium transition",
              canSave
                ? "bg-black text-white hover:bg-black/85"
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

/** 智能伙伴资料卡：头像 + 名字（标签紧随右侧）+ 描述；点击整卡可编辑 */
const BuddyProfileSection = ({
  profile,
  onSave,
}: {
  profile: BuddyProfile;
  onSave: (next: BuddyProfile) => void;
}) => {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);

  /** 标签支持「、」「,」「，」三种分隔，去空后渲染成胶囊 */
  const tagList = profile.tags
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <section>
      <SectionTitle
        title={t("我的智能伙伴")}
        subtitle={t("这是你当前的智能伙伴资料卡片")}
      />

      <button
        type="button"
        aria-label={t("编辑资料")}
        onClick={() => setEditOpen(true)}
        className={cn(
          CARD_CLASS,
          // 无描述时整体垂直居中，避免名字偏上；有描述时顶部对齐
          profile.description ? "items-start" : "items-center",
          "flex w-full gap-4 p-4 text-left transition hover:border-black/[0.12] hover:shadow-[0_10px_32px_rgba(15,23,42,0.07)]",
        )}
      >
        <GeometricAvatar
          shapeId={profile.shapeId}
          color={profile.color}
          size={64}
          className="shrink-0"
        />
        <span className="min-w-0 flex-1">
          {/* 名字 + 标签同一行，标签用灰底胶囊 */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-[15px] font-semibold leading-6 text-black/[0.88]">
              {profile.name}
            </span>
            {tagList.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-medium leading-4 text-black/50"
              >
                {tag}
              </span>
            ))}
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
  /** 与自动任务页 AUTOMATION_TEMPLATE_TONES 对齐的图标底色 */
  iconClass: string;
  icon: ReactNode;
};

/**
 * TODO(demo): 接真实推荐自动化接口后替换。
 * 三个场景与「自动任务」tab 的任务模板保持同名同图标同配色：
 * stock-info-digest / calorie-fitness-checkin / news-digest。
 */
const DEMO_AUTOMATIONS: RecommendedAutomation[] = [
  {
    id: "stock-info-digest",
    name: "股票信息速递",
    summary: "每天整理你关注的 A股、港股、美股公开信息；只做信息速递，不给买卖建议",
    iconClass: "bg-[#F8EEF0] text-[#8E4D58]",
    icon: <Wallet className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
  {
    id: "calorie-fitness-checkin",
    name: "卡路里与健身记录",
    summary: "每天主动询问饮食、运动、体重和身体感受，做轻量估算和复盘",
    iconClass: "bg-[#EFF7F2] text-[#4A7A5F]",
    icon: <Activity className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
  {
    id: "news-digest",
    name: "每日 AI 资讯摘要",
    summary: "每天整理 AI 领域的重要动态和关键进展",
    iconClass: "bg-[#EEF2F8] text-[#556F9A]",
    icon: <Newspaper className="h-[18px] w-[18px]" aria-hidden="true" />,
  },
];

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

      {/* 卡片结构对齐自动任务页的「任务模板」（整卡可点、左侧色块图标、底部箭头式启用），
          但圆角与底色跟随本页其他板块：白底 + 4px 圆角。
          同行卡片由 grid 自动等高，卡内用 flex-col + mt-auto 把「启用」压到底部，
          描述行数多少都不影响按钮位置。 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {DEMO_AUTOMATIONS.map((automation) => (
          /* 跳到定时任务页并预选该模板（?template=<id>），由那边弹出创建表单 */
          <AppLink
            key={automation.id}
            to={`${AGENT_SECTION_PATH_BY_ID.automations}?template=${encodeURIComponent(automation.id)}`}
            aria-label={t("启用{{name}}", { name: automation.name })}
            className={cn(
              CARD_CLASS,
              "group flex min-h-[104px] items-stretch gap-3 p-3 text-left transition hover:border-black/[0.12] hover:shadow-[0_10px_32px_rgba(15,23,42,0.07)]",
            )}
          >
            <span
              className={cn(
                "inline-flex h-9 w-9 shrink-0 items-center justify-center self-start rounded-[4px] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)]",
                automation.iconClass,
              )}
            >
              {automation.icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="block truncate text-sm font-medium text-black/82">{automation.name}</span>
              {/* flex-1 吃掉描述与按钮之间的剩余空间，保证按钮贴底 */}
              <span className="mt-1 flex-1 line-clamp-2 text-xs leading-5 text-black/45">
                {automation.summary}
              </span>
              <span className="mt-2 inline-flex h-5 items-center gap-1 text-xs font-medium text-black/55 transition group-hover:text-black/80">
                {t("启用")}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
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
}) => {
  const t = useT();
  /** 写入中：复用「喂咖啡」动效 + 步骤进度 */
  const [steps, setSteps] = useState<SetupStepState[] | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  /** 资料写入：把名字 / 标签 / 描述 / 头像落回 SOUL.md */
  const applyProfile = async (next: BuddyProfile) => {
    setWriteError(null);
    const plan = buildBuddySetupPlan({
      profile: { name: next.name, tags: next.tags, description: next.description },
      profileId,
      avatar: { shapeId: next.shapeId, color: next.color },
      timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
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
    <div className="flex min-w-0 flex-col gap-6">
      {/* 不用 AgentSectionHeader：它的 description 必填且会渲染空段落占位 */}
      <h2 className="text-[18px] font-semibold leading-6 tracking-normal text-black/[0.95]">
        {t("总览")}
      </h2>
      <HeroBanner stats={heroStats} />
      <BuddyProfileSection profile={profile} onSave={(next) => void applyProfile(next)} />
      <LatestNewsSection />
      <RecommendedAutomationsSection />
    </div>
  );
};
