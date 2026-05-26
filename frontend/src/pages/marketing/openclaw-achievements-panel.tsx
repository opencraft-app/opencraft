import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Anvil,
  ArrowLeftRight,
  AudioWaveform,
  BrainCircuit,
  Braces,
  Bug,
  CalendarDays,
  ChevronDown,
  CheckCircle2,
  Clock,
  CodeXml,
  Compass,
  Container,
  Database,
  DraftingCompass,
  Eye,
  Flame,
  FolderSearch,
  Gem,
  GitBranch,
  Globe2,
  Hammer,
  HelpCircle,
  KeyRound,
  Landmark,
  LockKeyhole,
  Moon,
  MountainSnow,
  MousePointer2,
  Network,
  PackageX,
  Pencil,
  PlugZap,
  Puzzle,
  Quote,
  RadioTower,
  RefreshCcw,
  RefreshCw,
  Rocket,
  Router,
  Search,
  ScrollText,
  ShieldQuestion,
  Ship,
  Sparkles,
  TerminalSquare,
  Timer,
  Trophy,
  TriangleAlert,
  Undo2,
  Wand2,
  Wine,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import {
  type AchievementSnapshot,
  type AchievementState,
  type HermesAchievement,
  fetchHermesAchievements,
} from "@/pages/marketing/openclaw-achievements";

type VisibilityFilter = "all" | AchievementState;

interface AchievementsPanelProps {
  botId: string;
  botName: string;
}

export const isChineseAchievementLocale = (locale?: string) => (
  (locale || "").toLowerCase().startsWith("zh")
);

export const achievementDisplayName = (achievement: HermesAchievement, locale?: string) => (
  isChineseAchievementLocale(locale)
    ? achievementNameTranslations[achievement.id] ?? achievement.name
    : achievement.name
);

export const achievementDisplayDescription = (achievement: HermesAchievement, locale?: string) => (
  isChineseAchievementLocale(locale)
    ? achievementDescriptionTranslations[achievement.id] ?? achievement.description
    : achievement.description
);

const TIER_ORDER = ["Olympian", "Diamond", "Gold", "Silver", "Copper"];

const achievementGridStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
};

const achievementNameTranslations: Record<string, string> = {
  actually_read_the_logs: "真的去读日志了",
  autonomous_avalanche: "调用狂潮",
  background_process_enjoyer: "后台进程爱好者",
  browser_possession: "浏览器原住民",
  cache_hit_appreciator: "缓存命中达人",
  citation_goblin: "旁征博引",
  claude_confidant: "Claude 好基友",
  codex_conjurer: "Codex 召唤师",
  config_surgeon: "医术精湛",
  context_dragon: "上下文狂魔",
  cron_necromancer: "定时任务唤醒师",
  css_exorcist: "CSS 驱魔师",
  dependency_hell_tourist: "装不完，根本装不完",
  docker_name_collision: "容器名已存在",
  docs_archaeologist: "文档考古家",
  file_archaeologist: "文件考古学家",
  five_model_flight: "模型探索者",
  forgot_the_env_var: "变量失踪",
  full_send: "火力全开",
  gateway_dweller: "网关常驻者",
  gemini_cartographer: "Gemini 驾驶员",
  image_whisperer: "造图大师",
  let_him_cook: "甩手掌柜",
  marathon_operator: "永动机",
  memory_keeper: "记忆守望者",
  memory_palace: "记忆宫殿主",
  model_hopper: "模型跳跃者",
  model_sommelier: "模型品鉴师",
  multi_model_mage: "模型收藏家",
  night_shift_operator: "夜猫子",
  one_character_fix: "一字乾坤",
  one_more_small_change: "再改一个小地方",
  open_weights_pilgrim: "开源朝圣者",
  openrouter_enjoyer: "OpenRouter 达人",
  patch_wizard: "补丁法师",
  permission_denied_any_percent: "权限速通",
  pixel_goblin: "超绝强迫症",
  plugin_goblin: "插件小能手",
  port_3000_taken: "3000 端口又被占了",
  provider_polyglot: "大模型海王",
  rabbit_hole_certified: "深渊探险家",
  rebase_acrobat: "Rebase 杂技师",
  red_text_connoisseur: "报错鉴赏家",
  rollback_wizard: "回滚！回滚！",
  screenshot_hunter: "截图区 UP 主",
  ship_first_ask_later: "先发再说",
  skill_issue_skill_created: "遇事不决写技能",
  skillsmith: "墨家机关师",
  stack_trace_sommelier: "堆栈品鉴师",
  subagent_commander: "甩锅大师",
  supposed_to_be_quick: "再给我两分钟",
  terminal_goblin: "终端一开，谁也不爱",
  test_suite_tamer: "测试之王",
  the_fix_was_restarting: "重启大法好",
  toolchain_maxxer: "工具链拉满",
  toolset_cartographer: "工具集军师",
  vibe_architect: "氛围工程师",
  voice_of_the_machine: "机器之声",
  weekend_warrior: "加班是不可能加班的",
  yaml_colon_incident: "失之毫厘",
};

const achievementDescriptionTranslations: Record<string, string> = {
  actually_read_the_logs: "多次查看日志，而不是直接猜测问题原因。",
  autonomous_avalanche: "在多个会话中累计大量 Hermes 工具调用。",
  background_process_enjoyer: "启动或控制了足够多的长时间运行进程。",
  browser_possession: "多次通过自动化方式操作浏览器。",
  cache_hit_appreciator: "注意到或受益于提示词缓存相关行为。",
  citation_goblin: "提取了足够多的网页内容。",
  claude_confidant: "多次在工作流中使用 Claude 相关能力。",
  codex_conjurer: "多次在工作流中使用 Codex 相关能力。",
  config_surgeon: "处理过真实的配置文件、manifest、环境变量文件或控制台设置。",
  context_dragon: "多次遇到上下文压缩、大上下文或 token 压力。",
  cron_necromancer: "多次使用计划任务或自主定时任务。",
  css_exorcist: "持续处理 CSS 或界面样式相关问题。",
  dependency_hell_tourist: "遇到过包安装失败，也完成过包安装恢复。",
  docker_name_collision: "多次遇到 Docker 容器名称冲突。",
  docs_archaeologist: "多次查阅或检索文档资料。",
  file_archaeologist: "多次读取、搜索或梳理文件系统内容。",
  five_model_flight: "使用过至少五种不同的大模型。",
  forgot_the_env_var: "因缺少环境变量导致过认证或配置失败。",
  full_send: "在一次任务中同时使用终端、文件和网页或浏览器能力。",
  gateway_dweller: "多次使用与网关连接相关的 Hermes 工作流。",
  gemini_cartographer: "多次使用 Gemini 相关工作流。",
  image_whisperer: "多次使用图像生成或视觉理解工具。",
  let_him_cook: "让 Hermes 在一次会话中自主完成一条完整工具链。",
  marathon_operator: "累计了大量 Hermes 会话。",
  memory_keeper: "使用 memory 或 Mnemosyne 保存长期知识。",
  memory_palace: "持续写入并沉淀长期记忆。",
  model_hopper: "多次切换、查看或配置模型与供应商。",
  model_sommelier: "多次使用不同模型或供应商，逐步形成使用偏好。",
  multi_model_mage: "在 Hermes 历史中使用过多种不同模型。",
  night_shift_operator: "多次在深夜时段运行 Hermes 会话。",
  one_character_fix: "在多次错误之后，通过很小的修改完成修复。",
  one_more_small_change: "在一次会话中进行了大量文件修改。",
  open_weights_pilgrim: "通过 Hermes 会话使用过本地模型或开源权重模型。",
  openrouter_enjoyer: "多次通过 OpenRouter 路由模型任务。",
  patch_wizard: "多次使用精准补丁修改文件。",
  permission_denied_any_percent: "多次遇到权限不足或访问被拒绝的问题。",
  pixel_goblin: "持续进行前端、CSS、SVG 或视觉细节调整。",
  plugin_goblin: "多次使用或开发插件相关能力。",
  port_3000_taken: "多次遇到开发服务器端口冲突。",
  provider_polyglot: "在 Hermes 历史中使用过多个模型供应商。",
  rabbit_hole_certified: "搜索或提取了大量网页内容用于研究。",
  rebase_acrobat: "处理过 rebase、冲突、合并、拉取或推送等 Git 历史操作。",
  red_text_connoisseur: "累计遇到过大量错误信息。",
  rollback_wizard: "使用过回滚或检查点恢复能力。",
  screenshot_hunter: "多次截图、检查并打磨视觉效果。",
  ship_first_ask_later: "在一次较复杂工具链之后进行了 Git 相关操作。",
  skill_issue_skill_created: "创建或修改可复用技能，减少重复操作。",
  skillsmith: "多次使用或维护 Hermes Skills。",
  stack_trace_sommelier: "多次遇到并处理堆栈追踪信息。",
  subagent_commander: "多次协调委派给其他 Agent 的工作。",
  supposed_to_be_quick: "一次原本很小的需求发展成了长会话。",
  terminal_goblin: "大量使用终端或 shell 命令。",
  test_suite_tamer: "多次运行测试、检查或验证命令。",
  the_fix_was_restarting: "在多次错误之后通过重启完成恢复。",
  toolchain_maxxer: "在一次会话中使用了多种不同的 Hermes 工具。",
  toolset_cartographer: "多次有意识地使用和切换 Hermes 工具集。",
  vibe_architect: "在一次项目会话中修改或触达了较多文件与模块。",
  voice_of_the_machine: "多次使用文本转语音或语音相关工具。",
  weekend_warrior: "多次在周末运行 Hermes 会话。",
  yaml_colon_incident: "多次遇到 YAML 或配置语法问题。",
};

const achievementIconMap: Record<string, LucideIcon> = {
  antenna: RadioTower,
  anvil: Anvil,
  avalanche: MountainSnow,
  blueprint: DraftingCompass,
  branch: GitBranch,
  browser: Globe2,
  cache: Database,
  clock: Clock,
  codex: CodeXml,
  colon: Braces,
  compass: Compass,
  container: Container,
  crystal: Gem,
  daemon: RefreshCcw,
  dragon: Flame,
  eye: Eye,
  flame: Flame,
  folder: FolderSearch,
  hammer_scroll: Hammer,
  key: KeyRound,
  lock: LockKeyhole,
  marathon: Timer,
  melting_clock: Timer,
  moon: Moon,
  needle: MousePointer2,
  nodes: Network,
  package_skull: PackageX,
  palace: Landmark,
  pencil: Pencil,
  pixel: Workflow,
  plug: PlugZap,
  prism: Gem,
  puzzle: Puzzle,
  quote: Quote,
  restart: RefreshCcw,
  rewind: Undo2,
  rocket: Rocket,
  router: Router,
  scroll: ScrollText,
  secret: ShieldQuestion,
  ship: Ship,
  spark_cursor: Sparkles,
  spiral: Search,
  swap: ArrowLeftRight,
  terminal: TerminalSquare,
  wand: Wand2,
  warning: TriangleAlert,
  wave: AudioWaveform,
  wine: Wine,
};

const tierStyles: Record<string, string> = {
  Copper: "border-[#B87333]/35 bg-[#B87333]/10 text-[#8B4A22]",
  Silver: "border-slate-300 bg-slate-100 text-slate-600",
  Gold: "border-[#D4AF37]/35 bg-[#D4AF37]/12 text-[#876414]",
  Diamond: "border-cyan-300 bg-cyan-50 text-cyan-700",
  Olympian: "border-violet-300 bg-violet-50 text-violet-700",
};

const tierLabel = (tier: string, t: ReturnType<typeof useT>) => {
  switch (tier) {
    case "Copper":
      return t("铜");
    case "Silver":
      return t("银");
    case "Gold":
      return t("金");
    case "Diamond":
      return t("钻石");
    case "Olympian":
      return t("大师");
    default:
      return tier;
  }
};

const categoryIcon = (category: string) => {
  const normalized = category.toLowerCase();
  if (normalized.includes("autonomy")) return Flame;
  if (normalized.includes("debug")) return Bug;
  if (normalized.includes("coding")) return Wand2;
  if (normalized.includes("native")) return Sparkles;
  if (normalized.includes("research") || normalized.includes("web")) return Globe2;
  if (normalized.includes("tool")) return TerminalSquare;
  if (normalized.includes("model")) return BrainCircuit;
  if (normalized.includes("lifestyle")) return CalendarDays;
  return Trophy;
};

const achievementIcon = (achievement: HermesAchievement): LucideIcon => {
  if (achievement.state === "secret") {
    return achievementIconMap.secret ?? ShieldQuestion;
  }
  if (achievement.icon && achievementIconMap[achievement.icon]) {
    return achievementIconMap[achievement.icon] ?? Trophy;
  }
  return categoryIcon(achievement.category);
};

const categoryLabel = (category: string, t: ReturnType<typeof useT>) => {
  switch (category) {
    case "Agent Autonomy":
      return t("Agent 自主性");
    case "Debugging Chaos":
      return t("调试与恢复");
    case "Vibe Coding":
      return t("开发工作流");
    case "Hermes Native":
      return t("Hermes 原生能力");
    case "Research/Web":
      return t("研究与网页");
    case "Tool Mastery":
      return t("工具使用");
    case "Model Lore":
      return t("模型与配置");
    case "Lifestyle":
      return t("使用习惯");
    default:
      return category || t("其他");
  }
};

const formatTimestamp = (seconds: number | null | undefined) => {
  if (!seconds) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(seconds * 1000));
};

const highestTier = (achievements: HermesAchievement[]) => (
  TIER_ORDER.find((tier) => achievements.some((achievement) => achievement.tier === tier)) ?? null
);

const stateLabel = (state: AchievementState, t: ReturnType<typeof useT>) => {
  switch (state) {
    case "unlocked":
      return t("已解锁");
    case "secret":
      return t("隐藏");
    case "discovered":
    default:
      return t("已发现");
  }
};

const stateBadgeClass = (state: AchievementState) => {
  switch (state) {
    case "unlocked":
      return "bg-black text-white";
    case "secret":
      return "border border-black/[0.12] bg-black/[0.03] text-black/45";
    case "discovered":
    default:
      return "bg-black/[0.06] text-black/65";
  }
};

const progressText = (achievement: HermesAchievement, t: ReturnType<typeof useT>) => {
  if (achievement.state === "secret") {
    return t("条件隐藏");
  }
  const progress = achievement.progress ?? 0;
  const threshold = achievement.next_threshold;
  if (typeof threshold === "number" && threshold > 0 && achievement.state !== "unlocked") {
    return `${progress.toLocaleString()} / ${threshold.toLocaleString()}`;
  }
  if (achievement.tier) {
    return achievement.tier;
  }
  return progress.toLocaleString();
};

const normalizeProgress = (achievement: HermesAchievement) => {
  if (achievement.state === "secret") {
    return 0;
  }
  if (achievement.state === "unlocked") {
    return 100;
  }

  const pct = Math.min(100, achievement.progress_pct ?? 0);
  if (pct <= 0 || (achievement.progress ?? 0) <= 0) {
    return 0;
  }
  return Math.max(4, pct);
};

const StatTile = ({ label, value, hint }: { label: string; value: string | number; hint: string }) => (
  <div className="rounded-lg border border-black/[0.06] bg-white px-4 py-3 shadow-[0_8px_28px_rgba(15,23,42,0.035)]">
    <p className="text-xs font-medium text-black/40">{label}</p>
    <p className="mt-1 text-xl font-semibold text-black/90">{value}</p>
    <p className="mt-1 truncate text-xs text-black/38">{hint}</p>
  </div>
);

const LoadingGrid = () => (
  <div style={achievementGridStyle}>
    {Array.from({ length: 6 }, (_, index) => (
      <div key={index} className="min-h-[220px] rounded-lg border border-black/[0.06] bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.035)]">
        <div className="h-10 w-10 rounded-md bg-black/[0.05]" />
        <div className="mt-5 h-4 w-3/5 rounded bg-black/[0.05]" />
        <div className="mt-3 h-3 w-full rounded bg-black/[0.04]" />
        <div className="mt-2 h-3 w-4/5 rounded bg-black/[0.04]" />
        <div className="mt-6 h-2 rounded bg-black/[0.04]" />
      </div>
    ))}
  </div>
);

const AchievementCard = ({ achievement }: { achievement: HermesAchievement }) => {
  const t = useT();
  const { i18n } = useTranslation();
  const Icon = achievementIcon(achievement);
  const pct = normalizeProgress(achievement);
  const tier = achievement.tier || achievement.next_tier || "";
  const unlockedAt = formatTimestamp(achievement.unlocked_at);
  const displayedTier = tier ? tierLabel(tier, t) : "";
  const displayName = achievementDisplayName(achievement, i18n.language);
  const displayDescription = achievementDisplayDescription(achievement, i18n.language);

  return (
    <article
      className={cn(
        "flex min-h-[238px] flex-col rounded-lg border bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.035)] transition-colors",
        achievement.state === "secret" ? "border-dashed border-black/[0.10]" : "border-black/[0.06]",
      )}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border border-black/[0.06] bg-black/[0.03] text-black/70">
          <Icon className="h-5 w-5" />
        </span>
        <h3 className="min-w-0 flex-1 truncate text-lg font-semibold leading-snug text-black/90">
          {achievement.state === "secret" ? t("隐藏成就") : displayName}
        </h3>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
          <span className={cn("rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none", stateBadgeClass(achievement.state))}>
            {stateLabel(achievement.state, t)}
          </span>
          {tier ? (
            <span className={cn("rounded-full border px-2.5 py-1.5 text-[11px] font-semibold leading-none", tierStyles[tier] ?? "border-black/[0.08] bg-black/[0.03] text-black/50")}>
              {achievement.tier ? displayedTier : t("目标 {{tier}}", { tier: displayedTier })}
            </span>
          ) : null}
        </div>
      </div>

      <p className="mt-4 line-clamp-2 min-h-[44px] text-sm leading-6 text-black/55">
        {achievement.state === "secret"
          ? t("继续使用 Hermes，相关行为出现后会揭示条件。")
          : displayDescription}
      </p>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-black/42">
          <span>{progressText(achievement, t)}</span>
          <span>{Math.round(pct)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-black/[0.05]">
          <div className="h-full rounded-full bg-black/75 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <details className="mt-4 border-t border-black/[0.06] pt-3 text-xs text-black/50">
        <summary className="cursor-pointer select-none font-medium text-black/55">{t("计数规则")}</summary>
        <p className="mt-2 leading-5">
          {achievement.criteria || t("当前成就暂未返回计数规则。")}
        </p>
        {achievement.evidence?.title ? (
          <p className="mt-2 leading-5">
            {t("来源会话：{{title}}", { title: achievement.evidence.title })}
          </p>
        ) : null}
      </details>

      {unlockedAt ? (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-black/38">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t("解锁于 {{time}}", { time: unlockedAt })}
        </p>
      ) : null}
    </article>
  );
};

export const AchievementsPanel = ({ botId, botName }: AchievementsPanelProps) => {
  const t = useT();
  const repositories = useRepositories();
  const botsRepository = repositories.bots;
  const [snapshot, setSnapshot] = useState<AchievementSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<VisibilityFilter>("all");
  const [category, setCategory] = useState("all");

  const load = useCallback(async (forceRescan = false) => {
    if (!botId) {
      return;
    }

    setError(null);
    if (forceRescan) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const next = await fetchHermesAchievements(botsRepository, botId, { forceRescan });
      setSnapshot(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "成就数据读取失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [botId, botsRepository]);

  useEffect(() => {
    setSnapshot(null);
    setVisibility("all");
    setCategory("all");
    void load(false);
  }, [botId, load]);

  const achievements = snapshot?.achievements ?? [];
  const categories = useMemo(() => Array.from(new Set(achievements.map((item) => item.category))).filter(Boolean), [achievements]);
  const topTier = highestTier(achievements);
  const generatedAt = formatTimestamp(snapshot?.generated_at);
  const scanState = snapshot?.scan_meta?.status?.state;
  const scanRunning = scanState === "running" || snapshot?.scan_meta?.mode === "in_progress";

  const visibleAchievements = useMemo(() => achievements.filter((achievement) => {
    if (visibility !== "all" && achievement.state !== visibility) {
      return false;
    }
    if (category !== "all" && achievement.category !== category) {
      return false;
    }
    return true;
  }), [achievements, category, visibility]);

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-black/[0.06] bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-normal text-black/90">{t("{{name}} 的成就", { name: botName })}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-black/52">
              {t("谨以此向 Hermes Agent 项目致以诚挚谢意。和你的 Hermes Agent 一起，解锁更多成就吧！")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing || loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-black/[0.08] bg-white px-3 text-sm font-medium text-black/70 transition-colors hover:bg-black/[0.035] disabled:cursor-not-allowed disabled:opacity-45"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            {refreshing ? t("扫描中") : t("重新扫描")}
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label={t("已解锁")} value={`${snapshot?.unlocked_count ?? 0} / ${snapshot?.total_count ?? 0}`} hint={t("获得的成就")} />
          <StatTile label={t("已发现")} value={snapshot?.discovered_count ?? 0} hint={t("已有进度但未解锁")} />
          <StatTile label={t("隐藏成就")} value={snapshot?.secret_count ?? 0} hint={t("等待相关行为揭示")} />
          <StatTile label={t("最高等级")} value={topTier ? tierLabel(topTier, t) : t("暂无")} hint={t("铜 → 银 → 金 → 钻石 → 大师")} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-black/45">
          {scanRunning ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-black/[0.04] px-2.5 py-1">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t("正在读取 Hermes 历史")}
            </span>
          ) : null}
          {snapshot?.is_stale ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("数据可能不是最新")}
            </span>
          ) : null}
          {generatedAt ? <span>{t("最近生成于 {{time}}", { time: generatedAt })}</span> : null}
        </div>
      </section>

      <section className="rounded-lg border border-black/[0.06] bg-white p-3 shadow-[0_8px_28px_rgba(15,23,42,0.035)]">
        <div className="flex flex-wrap items-center justify-start gap-2">
          <div className="relative">
            <select
              aria-label="Achievement status filter"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as VisibilityFilter)}
              className="h-9 w-[132px] appearance-none rounded-md border border-black/[0.08] bg-white px-3 pr-8 text-sm font-medium text-black/70 outline-none transition-colors hover:bg-black/[0.025] focus:border-black/20"
            >
              <option value="all">{t("全部")}</option>
              <option value="unlocked">{t("已解锁")}</option>
              <option value="discovered">{t("已发现")}</option>
              <option value="secret">{t("隐藏")}</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35" />
          </div>
          <div className="relative">
            <select
              aria-label="Achievement category filter"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="h-9 w-[176px] appearance-none rounded-md border border-black/[0.08] bg-white px-3 pr-8 text-sm font-medium text-black/70 outline-none transition-colors hover:bg-black/[0.025] focus:border-black/20"
            >
              <option value="all">{t("全部分类")}</option>
              {categories.map((item) => (
                <option key={item} value={item}>
                  {categoryLabel(item, t)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35" />
          </div>
        </div>
      </section>

      {error ? (
        <section className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div>
              <h3 className="font-semibold">{t("成就数据读取失败")}</h3>
              <p className="mt-1 leading-6">{error}</p>
              <button
                type="button"
                onClick={() => void load(false)}
                className="mt-3 inline-flex h-8 items-center rounded-md border border-red-200 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50"
              >
                {t("重试")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {loading ? <LoadingGrid /> : null}

      {!loading && !error && visibleAchievements.length === 0 ? (
        <section className="rounded-lg border border-dashed border-black/[0.12] bg-white p-8 text-center">
          <HelpCircle className="mx-auto h-8 w-8 text-black/28" />
          <h3 className="mt-3 text-base font-semibold text-black/75">{t("暂无匹配的成就")}</h3>
          <p className="mt-2 text-sm text-black/45">{t("可以切换筛选条件，或重新扫描当前 Hermes 的历史数据。")}</p>
        </section>
      ) : null}

      {!loading && !error && visibleAchievements.length > 0 ? (
        <section style={achievementGridStyle}>
          {visibleAchievements.map((achievement) => (
            <AchievementCard key={achievement.id} achievement={achievement} />
          ))}
        </section>
      ) : null}

      {!loading && !error && snapshot?.error ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <Search className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <p>{snapshot.error}</p>
          </div>
        </section>
      ) : null}
    </div>
  );
};
