import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
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
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useRepositories } from "@/contexts/repository-context";
import { useT } from "@/i18n/t";
import {
  AchievementPayloadError,
  type AchievementPayloadErrorCode,
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

export interface AchievementPanelError {
  code: AchievementPayloadErrorCode | "unknown";
  detail?: string;
}

type Translate = ReturnType<typeof useT>;
type AchievementCopyTranslator = (t: Translate) => string;

export const achievementDisplayName = (achievement: HermesAchievement, t: Translate) => (
  achievementNameTranslations[achievement.id]?.(t) ?? achievement.name
);

export const achievementDisplayDescription = (achievement: HermesAchievement, t: Translate) => (
  achievementDescriptionTranslations[achievement.id]?.(t) ?? achievement.description
);

export const achievementErrorMessage = (error: AchievementPanelError, t: Translate) => {
  switch (error.code) {
    case "json_block_missing":
    case "json_parse_failed":
    case "payload_invalid":
      return t("成就数据解析失败，请稍后重试。");
    case "command_failed":
      return t("成就命令执行失败，请检查 Hermes 服务状态。");
    case "unknown":
    default:
      return t("成就数据读取失败");
  }
};

const achievementPanelErrorFromUnknown = (error: unknown): AchievementPanelError => {
  if (error instanceof AchievementPayloadError) {
    return { code: error.code, detail: error.message };
  }
  if (error instanceof Error) {
    return { code: "command_failed", detail: error.message };
  }
  return { code: "unknown" };
};

export const achievementTimestampLocale = (language?: string) => (
  (language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"
);

const TIER_ORDER = ["Olympian", "Diamond", "Gold", "Silver", "Copper"];

const achievementGridStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
};

const achievementNameTranslations: Record<string, AchievementCopyTranslator> = {
  actually_read_the_logs: (t) => t("真的去读日志了"),
  autonomous_avalanche: (t) => t("调用狂潮"),
  background_process_enjoyer: (t) => t("后台进程爱好者"),
  browser_possession: (t) => t("浏览器原住民"),
  cache_hit_appreciator: (t) => t("缓存命中达人"),
  citation_goblin: (t) => t("旁征博引"),
  claude_confidant: (t) => t("Claude 好基友"),
  codex_conjurer: (t) => t("Codex 召唤师"),
  config_surgeon: (t) => t("医术精湛"),
  context_dragon: (t) => t("上下文狂魔"),
  cron_necromancer: (t) => t("定时任务唤醒师"),
  css_exorcist: (t) => t("CSS 驱魔师"),
  dependency_hell_tourist: (t) => t("装不完，根本装不完"),
  docker_name_collision: (t) => t("容器名已存在"),
  docs_archaeologist: (t) => t("文档考古家"),
  file_archaeologist: (t) => t("文件考古学家"),
  five_model_flight: (t) => t("模型探索者"),
  forgot_the_env_var: (t) => t("变量失踪"),
  full_send: (t) => t("火力全开"),
  gateway_dweller: (t) => t("网关常驻者"),
  gemini_cartographer: (t) => t("Gemini 驾驶员"),
  image_whisperer: (t) => t("造图大师"),
  let_him_cook: (t) => t("甩手掌柜"),
  marathon_operator: (t) => t("永动机"),
  memory_keeper: (t) => t("记忆守望者"),
  memory_palace: (t) => t("记忆宫殿主"),
  model_hopper: (t) => t("模型跳跃者"),
  model_sommelier: (t) => t("模型品鉴师"),
  multi_model_mage: (t) => t("模型收藏家"),
  night_shift_operator: (t) => t("夜猫子"),
  one_character_fix: (t) => t("一字乾坤"),
  one_more_small_change: (t) => t("再改一个小地方"),
  open_weights_pilgrim: (t) => t("开源朝圣者"),
  openrouter_enjoyer: (t) => t("OpenRouter 达人"),
  patch_wizard: (t) => t("补丁法师"),
  permission_denied_any_percent: (t) => t("权限速通"),
  pixel_goblin: (t) => t("超绝强迫症"),
  plugin_goblin: (t) => t("插件小能手"),
  port_3000_taken: (t) => t("3000 端口又被占了"),
  provider_polyglot: (t) => t("大模型海王"),
  rabbit_hole_certified: (t) => t("深渊探险家"),
  rebase_acrobat: (t) => t("Rebase 杂技师"),
  red_text_connoisseur: (t) => t("报错鉴赏家"),
  rollback_wizard: (t) => t("回滚！回滚！"),
  screenshot_hunter: (t) => t("截图区 UP 主"),
  ship_first_ask_later: (t) => t("先发再说"),
  skill_issue_skill_created: (t) => t("遇事不决写技能"),
  skillsmith: (t) => t("墨家机关师"),
  stack_trace_sommelier: (t) => t("堆栈品鉴师"),
  subagent_commander: (t) => t("甩锅大师"),
  supposed_to_be_quick: (t) => t("再给我两分钟"),
  terminal_goblin: (t) => t("终端一开，谁也不爱"),
  test_suite_tamer: (t) => t("测试之王"),
  the_fix_was_restarting: (t) => t("重启大法好"),
  toolchain_maxxer: (t) => t("工具链拉满"),
  toolset_cartographer: (t) => t("工具集军师"),
  vibe_architect: (t) => t("氛围工程师"),
  voice_of_the_machine: (t) => t("机器之声"),
  weekend_warrior: (t) => t("加班是不可能加班的"),
  yaml_colon_incident: (t) => t("失之毫厘"),
};

const achievementDescriptionTranslations: Record<string, AchievementCopyTranslator> = {
  actually_read_the_logs: (t) => t("多次查看日志，而不是直接猜测问题原因。"),
  autonomous_avalanche: (t) => t("在多个会话中累计大量 Hermes 工具调用。"),
  background_process_enjoyer: (t) => t("启动或控制了足够多的长时间运行进程。"),
  browser_possession: (t) => t("多次通过自动化方式操作浏览器。"),
  cache_hit_appreciator: (t) => t("注意到或受益于提示词缓存相关行为。"),
  citation_goblin: (t) => t("提取了足够多的网页内容。"),
  claude_confidant: (t) => t("多次在工作流中使用 Claude 相关能力。"),
  codex_conjurer: (t) => t("多次在工作流中使用 Codex 相关能力。"),
  config_surgeon: (t) => t("处理过真实的配置文件、manifest、环境变量文件或控制台设置。"),
  context_dragon: (t) => t("多次遇到上下文压缩、大上下文或 token 压力。"),
  cron_necromancer: (t) => t("多次使用计划任务或自主定时任务。"),
  css_exorcist: (t) => t("持续处理 CSS 或界面样式相关问题。"),
  dependency_hell_tourist: (t) => t("遇到过包安装失败，也完成过包安装恢复。"),
  docker_name_collision: (t) => t("多次遇到 Docker 容器名称冲突。"),
  docs_archaeologist: (t) => t("多次查阅或检索文档资料。"),
  file_archaeologist: (t) => t("多次读取、搜索或梳理文件系统内容。"),
  five_model_flight: (t) => t("使用过至少五种不同的大模型。"),
  forgot_the_env_var: (t) => t("因缺少环境变量导致过认证或配置失败。"),
  full_send: (t) => t("在一次任务中同时使用终端、文件和网页或浏览器能力。"),
  gateway_dweller: (t) => t("多次使用与网关连接相关的 Hermes 工作流。"),
  gemini_cartographer: (t) => t("多次使用 Gemini 相关工作流。"),
  image_whisperer: (t) => t("多次使用图像生成或视觉理解工具。"),
  let_him_cook: (t) => t("让 Hermes 在一次会话中自主完成一条完整工具链。"),
  marathon_operator: (t) => t("累计了大量 Hermes 会话。"),
  memory_keeper: (t) => t("使用 memory 或 Mnemosyne 保存长期知识。"),
  memory_palace: (t) => t("持续写入并沉淀长期记忆。"),
  model_hopper: (t) => t("多次切换、查看或配置模型与供应商。"),
  model_sommelier: (t) => t("多次使用不同模型或供应商，逐步形成使用偏好。"),
  multi_model_mage: (t) => t("在 Hermes 历史中使用过多种不同模型。"),
  night_shift_operator: (t) => t("多次在深夜时段运行 Hermes 会话。"),
  one_character_fix: (t) => t("在多次错误之后，通过很小的修改完成修复。"),
  one_more_small_change: (t) => t("在一次会话中进行了大量文件修改。"),
  open_weights_pilgrim: (t) => t("通过 Hermes 会话使用过本地模型或开源权重模型。"),
  openrouter_enjoyer: (t) => t("多次通过 OpenRouter 路由模型任务。"),
  patch_wizard: (t) => t("多次使用精准补丁修改文件。"),
  permission_denied_any_percent: (t) => t("多次遇到权限不足或访问被拒绝的问题。"),
  pixel_goblin: (t) => t("持续进行前端、CSS、SVG 或视觉细节调整。"),
  plugin_goblin: (t) => t("多次使用或开发插件相关能力。"),
  port_3000_taken: (t) => t("多次遇到开发服务器端口冲突。"),
  provider_polyglot: (t) => t("在 Hermes 历史中使用过多个模型供应商。"),
  rabbit_hole_certified: (t) => t("搜索或提取了大量网页内容用于研究。"),
  rebase_acrobat: (t) => t("处理过 rebase、冲突、合并、拉取或推送等 Git 历史操作。"),
  red_text_connoisseur: (t) => t("累计遇到过大量错误信息。"),
  rollback_wizard: (t) => t("使用过回滚或检查点恢复能力。"),
  screenshot_hunter: (t) => t("多次截图、检查并打磨视觉效果。"),
  ship_first_ask_later: (t) => t("在一次较复杂工具链之后进行了 Git 相关操作。"),
  skill_issue_skill_created: (t) => t("创建或修改可复用技能，减少重复操作。"),
  skillsmith: (t) => t("多次使用或维护 Hermes Skills。"),
  stack_trace_sommelier: (t) => t("多次遇到并处理堆栈追踪信息。"),
  subagent_commander: (t) => t("多次协调委派给其他 Agent 的工作。"),
  supposed_to_be_quick: (t) => t("一次原本很小的需求发展成了长会话。"),
  terminal_goblin: (t) => t("大量使用终端或 shell 命令。"),
  test_suite_tamer: (t) => t("多次运行测试、检查或验证命令。"),
  the_fix_was_restarting: (t) => t("在多次错误之后通过重启完成恢复。"),
  toolchain_maxxer: (t) => t("在一次会话中使用了多种不同的 Hermes 工具。"),
  toolset_cartographer: (t) => t("多次有意识地使用和切换 Hermes 工具集。"),
  vibe_architect: (t) => t("在一次项目会话中修改或触达了较多文件与模块。"),
  voice_of_the_machine: (t) => t("多次使用文本转语音或语音相关工具。"),
  weekend_warrior: (t) => t("多次在周末运行 Hermes 会话。"),
  yaml_colon_incident: (t) => t("多次遇到 YAML 或配置语法问题。"),
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

export const formatAchievementTimestamp = (seconds: number | null | undefined, locale: string) => {
  if (!seconds) {
    return "";
  }
  return new Intl.DateTimeFormat(locale, {
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
    return tierLabel(achievement.tier, t);
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
  const tier = achievement.state === "unlocked" ? achievement.tier || "" : "";
  const unlockedAt = formatAchievementTimestamp(achievement.unlocked_at, achievementTimestampLocale(i18n.language));
  const displayedTier = tier ? tierLabel(tier, t) : "";
  const displayName = achievementDisplayName(achievement, t);
  const displayDescription = achievementDisplayDescription(achievement, t);

  return (
    <article
      className={cn(
        "flex min-h-[238px] flex-col rounded-lg border bg-white p-5 shadow-[0_8px_28px_rgba(15,23,42,0.035)] transition-colors",
        achievement.state === "secret" ? "border-dashed border-black/[0.10]" : "border-black/[0.06]",
      )}
    >
      <div className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-3">
        <span className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg border border-black/[0.06] bg-black/[0.03] text-black/70">
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="min-w-0 flex-1 truncate text-lg font-semibold leading-snug text-black/90">
              {achievement.state === "secret" ? t("隐藏成就") : displayName}
            </h3>
            <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
              <span className={cn("rounded-full px-2.5 py-1.5 text-[11px] font-semibold leading-none", stateBadgeClass(achievement.state))}>
                {stateLabel(achievement.state, t)}
              </span>
              {tier ? (
                <span className={cn("rounded-full border px-2.5 py-1.5 text-[11px] font-semibold leading-none", tierStyles[tier] ?? "border-black/[0.08] bg-black/[0.03] text-black/50")}>
                  {displayedTier}
                </span>
              ) : null}
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-black/55">
            {achievement.state === "secret"
              ? t("继续使用 Hermes，相关行为出现后会揭示条件。")
              : displayDescription}
          </p>
        </div>
      </div>

      <div className="mt-8">
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
  const { i18n } = useTranslation();
  const repositories = useRepositories();
  const botsRepository = repositories.bots;
  const [snapshot, setSnapshot] = useState<AchievementSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<AchievementPanelError | null>(null);
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
      const nextError = achievementPanelErrorFromUnknown(loadError);
      console.warn("Failed to load Hermes achievements", loadError);
      setError(nextError);
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
  const timestampLocale = achievementTimestampLocale(i18n.language);
  const generatedAt = formatAchievementTimestamp(snapshot?.generated_at, timestampLocale);
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
              <p className="mt-1 leading-6">{achievementErrorMessage(error, t)}</p>
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
