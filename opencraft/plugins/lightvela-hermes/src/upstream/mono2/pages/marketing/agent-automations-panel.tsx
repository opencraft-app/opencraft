// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 定时任务（Hermes Cron）面板
 *
 * 在 Hermes 实例 Settings 内新增的「定时」tab，提供 cron 任务的浏览 / 创建 /
 * 暂停 / 恢复 / 删除。
 *
 * 后端通路：mono ctl `POST /v1/instances/:botId/debug/exec` 调 `hermes cron ...`
 * 命令；详见 `@/lib/hermes-cron-client`。
 *
 * v1 范围：
 * - 列表（带空态 + 加载态 + 失败 toast）
 * - 创建（截图三态频率：单次 / 周期 / 按间隔）
 * - 暂停 / 恢复 / 删除
 * - 生效日期区间通过 Hermes 官方 pre-run script gate 实现：区间外返回 wakeAgent=false
 */

import { AlertTriangle, Activity, ArrowLeftRight, ArrowRight, BellRing, BriefcaseBusiness, CalendarDays, CalendarRange, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleHelp, Clock, CreditCard, Droplets, Eraser, Eye, FolderKanban, Loader2, Newspaper, Pause, Pencil, Pill, Play, Plus, RefreshCw, Sunrise, Trash2, TrendingUp, Wallet, X, Zap } from "lucide-react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentSectionHeader } from "../../components/domain/agent-section-header";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { useT } from "../../i18n/t";
import { useZeroTokenAutomationsEnabled } from "../../contexts/runtime-config-context";
import { parseLocaleCode } from "../../i18n/locales.config";
import { DEFAULT_LOCALE, isGlobal } from "../../lib/region";
import { cn } from "../../lib/utils";
import type { PublicSiteLocaleCode } from "../../lib/public-site-routing";
import {
  listInstalledSkillSlugs,
  type InstalledSkillLoadState,
} from "../../lib/hermes-skills-client";
import {
  AutomationSkillBindingSummary,
  AutomationSkillPicker,
} from "./automation-skill-picker";
import { AutomationUpstreamPicker } from "./automation-upstream-picker";
import {
  composeAutomationExecutionPrompt,
  getAutomationVisiblePromptMaxLength,
  enrichLightVelaAutomationTemplates,
  mergeAutomationTemplateCatalog,
  splitAutomationExecutionPrompt,
  type AutomationCatalogTemplate,
  type AutomationTemplateCategory,
  type AutomationTemplateInput,
} from "./automation-template-catalog";
import { ScenarioEnableConfirmModal } from "./scenario-tasks/ScenarioEnableConfirmModal";
import { ScenarioInstallModal } from "./scenario-tasks/ScenarioInstallModal";
import { getScenarioCronJobPresentation, getScenarioRunPresentation } from "./scenario-tasks/scenario-job-presentation";
// 场景任务入口暂时下线，保留依赖便于后续恢复。
// import { ScenarioTaskGrid } from "./scenario-tasks/ScenarioTaskGrid";
// import { getScenarioTaskPack, SCENARIO_TASK_PACKS, type ScenarioTaskId, type ScenarioTaskPack } from "./scenario-tasks/scenario-packs";
import {
  SCENARIO_MULTISELECT_SEPARATOR,
  getOverviewScenarioTaskPacks,
  getScenarioTaskPack,
  type ScenarioTaskPack,
} from "./scenario-tasks/scenario-packs";
// import { buildScenarioTaskDraft, isScenarioRecurringJobName, type ScenarioTaskDraft } from "./scenario-tasks/scenario-task-builder";
import { buildScenarioTaskDraft, type ScenarioTaskDraft } from "./scenario-tasks/scenario-task-builder";
import {
  CronCommandError,
  createCronJobWithContextAndScriptRollback,
  createCronJobWithScriptRollback,
  createEffectiveWindowScriptName,
  createZeroTokenScriptName,
  detectCronContextFromCapability,
  editCronJob,
  editCronJobWithContext,
  execCommand,
  listAutomationBlueprints,
  listCronJobs,
  listRecentCronRuns,
  isLightVelaZeroTokenScriptName,
  isTestRunMarkerName,
  pauseCronJob,
  writeEffectiveWindowScript,
  writeZeroTokenScript,
  removeCronJob,
  removeManagedCronScriptIfUnreferenced,
  removeCronJobWithDependentRollback,
  resumeCronJob,
  sendHermesChatNotice,
  shellQuote,
  startCronTestRun,
  type CronDependentBinding,
  type CronEffectiveWindow,
  type CronContextCapability,
  type CronJob,
  type CronLightVelaScriptConfig,
  type CronZeroTokenScriptConfig,
  type CronScriptLanguage,
  type CronZeroTokenKind,
  type CronRunRecord,
  type HermesCronTarget,
  type HermesAutomationBlueprint,
} from "../../lib/hermes-cron-client";
import { DATONG_EVENTS, DATONG_PAGE_IDS } from "../../observability/datong";
import { trackDatongClick, trackDatongEvent } from "../../observability/datong-tracker";

const PANEL_CARD_STYLE: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.06)",
  background: "#ffffff",
  boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
};
const MAX_CRON_JOBS_PER_BOT = 20;
const MODAL_CONTROL_TEXT_STYLE: React.CSSProperties = { fontSize: 16, lineHeight: "24px" };
const MODAL_COMPACT_CONTROL_TEXT_STYLE: React.CSSProperties = { fontSize: 14, lineHeight: "20px" };
const MODAL_HELP_TEXT_STYLE: React.CSSProperties = { fontSize: 13, lineHeight: "20px" };
const EXPIRED_CRON_JOB_HIDE_AFTER_MS = 10 * 60 * 1000;
const AUTOMATION_PROMPT_MAX_LENGTH = 1000;
const FIXED_NOTIFICATION_MAX_LENGTH = 1000;
const AUTOMATION_SCRIPT_MAX_LENGTH = 20_000;
const PYTHON_SCRIPT_PLACEHOLDER = [
  "import shutil",
  'usage = shutil.disk_usage("/")',
  'if usage.used / usage.total > 0.8: print("Disk usage exceeds 80%")',
].join("\n");
const BASH_SCRIPT_PLACEHOLDER = [
  "usage=$(df / | awk 'NR==2 {print $5}')",
  "threshold=80",
  '[ "${usage%%%}" -gt "$threshold" ] && echo "Disk usage is high: $usage"',
].join("\n");
const CHAT_ID_MAX_LENGTH = 60;
const AUTOMATION_FORM_TEST_JOB_ID = "automation-form-test-run";
const CHINESE_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const CHINESE_TEXT_RE_GLOBAL = /[\u3400-\u9fff\uf900-\ufaff]/g;
type AutomationTestState = "idle" | "running" | "ok" | "fail";
type ActiveTaskFilter = "all" | "agent" | CronZeroTokenKind;
type CreateTaskKind = "agent" | CronZeroTokenKind;
/**
 * 定时任务展示所用的 locale，直接复用注册表类型。
 *
 * 此前本文件自持 `"zh-CN" | "zh-SG" | "en-US" | "id-ID"` 联合类型副本，
 * 与 `scenario-job-presentation.ts` 中的同名类型构成镜像，新增语种时
 * 两处都要改且漏改不报错。
 */
type AutomationDisplayLocale = PublicSiteLocaleCode;
type ScenarioMutationStatus = "creating" | "enabling";
type ScenarioReminderNotice = {
  draft: ScenarioTaskDraft;
  kind: "preview" | "recurring";
};

/**
 * 把 i18next 的运行时语言收敛为定时任务展示 locale。
 *
 * ⚠️ 刻意使用注册表白名单校验（`parseLocaleCode`）而非
 * `language?.startsWith("en")` 一类前缀猜测。前缀猜测的问题：
 *   - 新增语种时不会报错，只会静默落到最后的 `return "zh-CN"`，
 *     用户侧表现为「界面已切日语，定时任务区却仍是中文」；
 *   - `startsWith("en")` 会把任何以 en 开头的值都当成英文。
 *
 * 无法识别的语言（含被篡改的 localStorage 值）回退到区域默认语言。
 */
function getAutomationDisplayLocale(language: string | undefined): AutomationDisplayLocale {
  return parseLocaleCode(language) ?? DEFAULT_LOCALE;
}

export function toCreateCronSkills(selectedSkills: string[]): string[] | undefined {
  return selectedSkills.length > 0 ? selectedSkills : undefined;
}

export function toEditCronSkills(initialSkills: string[], selectedSkills: string[]): string[] | undefined {
  if (initialSkills.length === selectedSkills.length
    && initialSkills.every((slug, index) => slug === selectedSkills[index])) return undefined;
  return selectedSkills;
}

export function wouldCreateCronContextCycle(
  jobs: readonly CronJob[],
  downstreamId: string,
  upstreamId: string,
): boolean {
  if (downstreamId === upstreamId) return true;

  const upstreamsByJob = new Map(jobs.map((job) => [job.id, job.context_from ?? []]));
  const stack = [upstreamId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === downstreamId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(upstreamsByJob.get(id) ?? []));
  }

  return false;
}

export function getEligibleCronUpstreams(
  jobs: readonly CronJob[],
  currentJobId: string | null,
  now: number,
): CronJob[] {
  return jobs.filter((job) => {
    if (job.id === currentJobId) return false;
    if (isCronJobPaused(job) || isCronJobUnavailableAsUpstream(job, now)) return false;
    if (isTestRunMarkerName(job.name) || isScenarioTrialJob(job)) return false;
    return currentJobId === null
      || !wouldCreateCronContextCycle(jobs, currentJobId, job.id);
  });
}

function getDirectCronDependents(
  jobs: readonly CronJob[],
  targetId: string,
): CronDependentBinding[] {
  return jobs
    .filter((job) => job.context_from?.includes(targetId))
    .map((job) => ({
      id: job.id,
      name: job.name,
      contextFrom: job.context_from ?? [],
    }));
}

function haveSameCronDependents(
  current: readonly CronDependentBinding[],
  latest: readonly CronDependentBinding[],
): boolean {
  const signature = (bindings: readonly CronDependentBinding[]) => bindings
    .map((binding) => `${binding.id}:${[...binding.contextFrom].sort().join(",")}`)
    .sort()
    .join("|");
  return signature(current) === signature(latest);
}

export function toCronContextPatch(
  _initial: readonly string[] | null,
  selected: string,
  changed: boolean,
): undefined | string[] {
  if (!changed) return undefined;
  return selected ? [selected] : [];
}

export type AutomationSkillSelectionIssue = "unavailable" | "unverified";

export function getAutomationSkillSelectionIssue({
  mode,
  initialSkills,
  selectedSkills,
  verificationState,
}: {
  mode: "create" | "edit";
  initialSkills: string[];
  selectedSkills: string[];
  verificationState: InstalledSkillLoadState;
}): AutomationSkillSelectionIssue | null {
  const skillsToVerify = mode === "create"
    ? selectedSkills
    : selectedSkills.filter((slug) => !initialSkills.includes(slug));
  if (skillsToVerify.length === 0) return null;
  if (verificationState.status !== "ready") return "unverified";
  return skillsToVerify.every((slug) => verificationState.slugs.includes(slug)) ? null : "unavailable";
}

/** 顶部 toast；与 settings 主页 SkillInstallToast 视觉一致 */
function ErrorToast({ message, onClose, tone = "error" }: { message: string; onClose: () => void; tone?: "error" | "success" | "info" }) {
  const t = useT();
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? Loader2 : AlertTriangle;
  return createPortal(
    <div className="lightvela-agent-console-portal fixed inset-x-0 top-4 z-[300] flex justify-center px-4" role="status" aria-live="polite">
      <div
        className={
          "inline-flex max-w-[min(92vw,720px)] items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white shadow-lg " +
          (tone === "success" ? "bg-[#0F8A4B]" : tone === "info" ? "bg-black/80" : "bg-[#B91C1C]")
        }
      >
        <Icon className={"h-4 w-4 shrink-0" + (tone === "info" ? " animate-spin" : "")} />
        <span className="truncate">{message}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition hover:bg-white/15"
          aria-label={t("关闭")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}

function ScenarioReminderBanner({
  notice,
  pack,
  onDismiss,
  onViewCreated,
  onEnable,
}: {
  notice: ScenarioReminderNotice;
  pack: ScenarioTaskPack;
  onDismiss: () => void;
  onViewCreated: () => void;
  onEnable: () => void;
}) {
  const t = useT();
  const isPreview = notice.kind === "preview";

  return (
    <section className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-black/[0.08] bg-white px-4 py-3 text-sm shadow-[0_4px_24px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)]">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#EEF4FF] text-[#315FAD]">
          <BellRing className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-black/88" title={notice.draft.generatedName}>
            {isPreview
              ? t("已开始试跑：{{name}}", { name: notice.draft.generatedName })
              : t("已新建定时任务：{{name}}", { name: notice.draft.generatedName })}
          </h3>
          <p className="mt-1 text-xs leading-5 text-black/55">
            {isPreview
              ? t("Hermes Agent 已开始处理，结果会稍后推送到{{deliver}}，也会出现在最近执行。", { deliver: notice.draft.generatedDeliverLabel })
              : t("后续会按{{frequency}}自动提醒，也可以在已生效任务里管理。", { frequency: pack.defaultFrequencyLabel })}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {isPreview && (
          <button
            type="button"
            onClick={onEnable}
            className="inline-flex h-8 items-center justify-center rounded-md bg-black px-3 text-xs font-semibold text-white transition hover:bg-black/85"
          >
            {t("添加为定时任务")}
          </button>
        )}
        <button
          type="button"
          onClick={onViewCreated}
          className="inline-flex h-8 items-center justify-center rounded-md border border-black/[0.08] bg-white px-3 text-xs font-semibold text-black/65 transition hover:bg-black/[0.04]"
        >
          {t("查看已生效任务")}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-black/45 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}

const AUTOMATION_TEMPLATE_PAGE_SIZE = 6;
const AUTOMATION_TEMPLATES_COLLAPSED_STORAGE_KEY = "lightvela-automation-templates-collapsed-v1";

function getInitialAutomationTemplatesCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(AUTOMATION_TEMPLATES_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistAutomationTemplatesCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(AUTOMATION_TEMPLATES_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Browser storage can be disabled; the current session state still works.
  }
}

type AutomationScenarioTemplatesSectionProps = {
  templates: readonly AutomationTemplate[];
  onEnable: (template: AutomationTemplate) => void;
  loading?: boolean;
};

const AUTOMATION_TEMPLATE_CATEGORIES: ReadonlyArray<"all" | AutomationTemplateCategory> = [
  "all",
  "daily",
  "productivity",
  "monitoring",
  "wellbeing",
  "learning",
];

function getAutomationTemplateCategoryLabel(
  category: "all" | AutomationTemplateCategory,
  t: ReturnType<typeof useT>,
): string {
  if (category === "daily") return t("每日助理");
  if (category === "productivity") return t("效率工作");
  if (category === "monitoring") return t("监控提醒");
  if (category === "wellbeing") return t("健康生活");
  if (category === "learning") return t("学习成长");
  return t("全部");
}

const AUTOMATION_CATEGORY_TONES = {
  daily: { icon: Sunrise, iconClass: "bg-[var(--automation-tone-daily-bg)] text-[var(--automation-tone-daily-text)]" },
  productivity: { icon: BriefcaseBusiness, iconClass: "bg-[var(--automation-tone-productivity-bg)] text-[var(--automation-tone-productivity-text)]" },
  monitoring: { icon: TrendingUp, iconClass: "bg-[var(--automation-tone-monitoring-bg)] text-[var(--automation-tone-monitoring-text)]" },
  wellbeing: { icon: Activity, iconClass: "bg-[var(--automation-tone-wellbeing-bg)] text-[var(--automation-tone-wellbeing-text)]" },
  learning: { icon: Newspaper, iconClass: "bg-[var(--automation-tone-learning-bg)] text-[var(--automation-tone-learning-text)]" },
} satisfies Record<AutomationTemplateCategory, { icon: typeof Clock; iconClass: string }>;

export function AutomationScenarioTemplatesSection({
  templates,
  onEnable,
  loading = false,
}: AutomationScenarioTemplatesSectionProps) {
  const t = useT();
  const [page, setPage] = useState(0);
  const [category, setCategory] = useState<"all" | AutomationTemplateCategory>("all");
  const [templatesCollapsed, setTemplatesCollapsed] = useState(getInitialAutomationTemplatesCollapsed);
  const filteredTemplates = category === "all"
    ? templates
    : templates.filter((template) => template.category === category);
  const pageCount = Math.max(1, Math.ceil(filteredTemplates.length / AUTOMATION_TEMPLATE_PAGE_SIZE));
  const availableCategories = AUTOMATION_TEMPLATE_CATEGORIES.filter((item) => (
    item === "all" || templates.some((template) => template.category === item)
  ));
  const safePage = Math.min(page, pageCount - 1);
  const visibleTemplates = filteredTemplates.slice(
    safePage * AUTOMATION_TEMPLATE_PAGE_SIZE,
    safePage * AUTOMATION_TEMPLATE_PAGE_SIZE + AUTOMATION_TEMPLATE_PAGE_SIZE,
  );

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  useEffect(() => {
    if (category !== "all" && !templates.some((template) => template.category === category)) {
      setCategory("all");
      setPage(0);
    }
  }, [category, templates]);

  const toggleTemplatesCollapsed = useCallback(() => {
    setTemplatesCollapsed((current) => {
      const next = !current;
      persistAutomationTemplatesCollapsed(next);
      return next;
    });
  }, []);

  return (
    <section
      className="rounded-md border border-black/[0.08] bg-white p-4 shadow-none"
      aria-labelledby="automation-scenario-templates-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="inline-flex items-center gap-1.5">
          <h3 id="automation-scenario-templates-title" className="text-balance text-xs font-medium text-black/45">
            {t("任务模板")}
          </h3>
          {loading && <Loader2 className="size-3 text-black/35" aria-label={t("正在加载官方模板")} />}
          <button
            type="button"
            onClick={toggleTemplatesCollapsed}
            aria-expanded={!templatesCollapsed}
            aria-controls="automation-scenario-templates-grid"
            aria-label={templatesCollapsed ? t("展开任务模板") : t("收起任务模板")}
            className="inline-flex h-6 items-center justify-center gap-1 rounded-sm border-0 px-1 text-[11px] font-normal text-black/40 transition hover:text-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
          >
            {templatesCollapsed ? (
              <>
                <span>{t("展开")}</span>
                <ChevronDown className="size-3" aria-hidden="true" />
              </>
            ) : (
              <>
                <span>{t("收起")}</span>
                <ChevronUp className="size-3" aria-hidden="true" />
              </>
            )}
          </button>
        </div>
        {!templatesCollapsed && pageCount > 1 && (
          <div className="inline-flex items-center gap-2 text-xs text-black/45">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={safePage === 0}
              className="rounded-sm border border-black/[0.08] bg-white px-2 py-1 font-medium text-black/60 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:text-black/25"
            >
              {t("上一页")}
            </button>
            <span className="tabular-nums">{safePage + 1} / {pageCount}</span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-sm border border-black/[0.08] bg-white px-2 py-1 font-medium text-black/60 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:text-black/25"
            >
              {t("下一页")}
            </button>
          </div>
        )}
      </div>
      {!templatesCollapsed && (
        <>
          <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" aria-label={t("模板分类")}>
            {availableCategories.map((item) => {
              const selected = item === category;
              const label = getAutomationTemplateCategoryLabel(item, t);
              return (
                <button
                  key={item}
                  type="button"
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => {
                    setCategory(item);
                    setPage(0);
                  }}
                  className={`shrink-0 rounded-sm border px-2.5 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 ${selected ? "border-black/15 bg-black/[0.06] font-medium text-black/75" : "border-black/[0.06] bg-white text-black/45 hover:border-black/10 hover:text-black/70"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div id="automation-scenario-templates-grid" className="mt-2 grid min-h-[248px] content-start grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visibleTemplates.map((template) => {
            const tone = AUTOMATION_TEMPLATE_TONES[template.id as keyof typeof AUTOMATION_TEMPLATE_TONES];
            const categoryTone = AUTOMATION_CATEGORY_TONES[template.category];
            const Icon = tone?.icon ?? categoryTone.icon;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onEnable(template)}
                aria-label={t("启用{{name}}", { name: template.name })}
                className="group flex min-h-[120px] items-start gap-3 rounded-sm border border-black/[0.06] bg-white p-3 text-left transition hover:border-black/[0.12] hover:bg-white"
              >
                <span className={`inline-flex size-9 shrink-0 items-center justify-center rounded-sm shadow-[inset_0_0_0_1px_rgba(0,0,0,0.04)] ${tone?.iconClass ?? categoryTone.iconClass}`}>
                  <Icon className="size-[18px]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col self-stretch">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-black/82">{template.name}</span>
                    {template.source === "hermes" && (
                      <span className="shrink-0 rounded-sm border border-black/[0.06] px-1.5 py-0.5 text-[10px] font-medium leading-none text-black/35">Hermes</span>
                    )}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-pretty text-xs leading-5 text-black/45">{template.description}</span>
                  <span className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-2 text-[11px] text-black/42">
                    <span className="inline-flex items-center gap-1"><Clock className="size-3" />{template.scheduleLabel}</span>
                    {template.notificationPolicy === "only-when-needed" && (
                      <span className="inline-flex items-center gap-1"><BellRing className="size-3" />{t("有变化才提醒")}</span>
                    )}
                    {template.skills.length > 0 && (
                      <span className="inline-flex min-w-0 items-center gap-1" title={template.skills.join(", ")}>
                        <Zap className="size-3 shrink-0" />
                        <span className="max-w-28 truncate">{template.skills[0]}</span>
                        {template.skills.length > 1 && <span className="shrink-0">+{template.skills.length - 1}</span>}
                      </span>
                    )}
                    <span className="ml-auto inline-flex items-center gap-1 font-medium text-black/55 transition group-hover:text-black/80">
                      {t("启用")}
                      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
          </div>
        </>
      )}
    </section>
  );
}

async function sendScenarioStartNotice(
  botId: HermesCronTarget,
  draft: ScenarioTaskDraft,
  t: ReturnType<typeof useT>,
): Promise<void> {
  if (draft.generatedDeliver === "local") return;
  const message = t("{{name}} 已开始处理，结果会稍后推送到{{deliver}}。", {
    name: draft.generatedName,
    deliver: draft.generatedDeliverLabel,
  });
  try {
    await execCommand(botId, buildHermesSendCommand(draft.generatedDeliver, "", message));
  } catch {
    // 接单确认消息失败不影响试跑任务本身，结果仍会按 Cron deliver 回传。
  }
}

function useHoverTooltipPosition<T extends HTMLElement>() {
  const tooltipId = useId();
  const triggerRef = useRef<T | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const showTooltip = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  }, [cancelClose]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition({
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    return () => cancelClose();
  }, [cancelClose]);

  return {
    tooltipId,
    triggerRef,
    open,
    position,
    showTooltip,
    scheduleClose,
  };
}

function FloatingTooltip({
  id,
  position,
  children,
  className = "",
  onMouseEnter,
  onMouseLeave,
}: {
  id: string;
  position: { left: number; top: number };
  children: ReactNode;
  className?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return createPortal(
    <span
      id={id}
      className={`lightvela-agent-console-portal pointer-events-auto fixed z-[260] max-w-[min(360px,calc(100vw-32px))] -translate-x-1/2 -translate-y-full select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)] ${className}`}
      style={{ left: position.left, top: position.top }}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
    </span>,
    document.body,
  );
}

function EffectiveWindowBadge({ label, messages }: { label: string; messages: string[] }) {
  const { tooltipId, triggerRef, open, position, showTooltip, scheduleClose } = useHoverTooltipPosition<HTMLButtonElement>();

  return (
    <span className="relative inline-flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-[18px] w-[18px] cursor-default items-center justify-center rounded-full bg-black/[0.06] text-black/45 transition hover:bg-black/[0.08] hover:text-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/15"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleClose}
        onFocus={showTooltip}
        onBlur={scheduleClose}
      >
        <CalendarRange className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <FloatingTooltip
          id={tooltipId}
          position={position}
          className="whitespace-normal text-left"
          onMouseEnter={showTooltip}
          onMouseLeave={scheduleClose}
        >
          <span className="block space-y-0.5">
            {messages.map((line, index) => (
              <span key={`${line}-${index}`} className="block">
                {line}
              </span>
            ))}
          </span>
        </FloatingTooltip>
      )}
    </span>
  );
}

function ImmediateTooltipText({ label, message }: { label: string; message: string }) {
  const { tooltipId, triggerRef, open, position, showTooltip, scheduleClose } = useHoverTooltipPosition<HTMLSpanElement>();

  return (
    <span className="relative inline-flex min-w-0">
      <span
        ref={triggerRef}
        className="min-w-0 truncate text-xs text-black/55"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        tabIndex={0}
        onMouseEnter={showTooltip}
        onMouseLeave={scheduleClose}
        onFocus={showTooltip}
        onBlur={scheduleClose}
      >
        {label}
      </span>
      {open && (
        <FloatingTooltip
          id={tooltipId}
          position={position}
          className="whitespace-normal break-words text-left"
          onMouseEnter={showTooltip}
          onMouseLeave={scheduleClose}
        >
          {message}
        </FloatingTooltip>
      )}
    </span>
  );
}

export function HermesAgentAutomationsPanel({ botId: rawBotId, gatewayRunning, onRestartGateway }: {
  botId: HermesCronTarget | null;
  gatewayRunning?: boolean;
  onRestartGateway?: () => void;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const displayLocale = getAutomationDisplayLocale(i18n.language);
  const runtimeBotId = typeof rawBotId === "string" ? rawBotId : rawBotId?.instanceId ?? null;
  const profileId = typeof rawBotId === "string" ? "main" : rawBotId?.profileId ?? "main";
  const legacyBotTarget = typeof rawBotId === "string";
  const botId = useMemo<HermesCronTarget | null>(() => (
    runtimeBotId
      ? legacyBotTarget
        ? runtimeBotId
        : { instanceId: runtimeBotId, profileId }
      : null
  ), [legacyBotTarget, profileId, runtimeBotId]);
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [contextCapability, setContextCapability] = useState<"loading" | CronContextCapability>(
    "loading",
  );
  const [enabledChannels, setEnabledChannels] = useState<Set<string> | null>(null);
  const [channelStatus, setChannelStatus] = useState<"loading" | "ready">("loading");
  const [installedSkillLoadState, setInstalledSkillLoadState] = useState<InstalledSkillLoadState>({
    status: "idle",
    slugs: [],
    error: null,
  });
  const [runtimeBlueprints, setRuntimeBlueprints] = useState<HermesAutomationBlueprint[]>([]);
  const [loadingBlueprints, setLoadingBlueprints] = useState(false);
  const installedSkillSlugsRef = useRef<string[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingRecentRuns, setLoadingRecentRuns] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [recentRuns, setRecentRuns] = useState<CronRunRecord[]>([]);
  const [activeView, setActiveView] = useState<"created" | "ended" | "recent">("created");
  const [activeTaskFilter, setActiveTaskFilter] = useState<ActiveTaskFilter>("all");
  const [creating, setCreating] = useState(false);
  const [creatingFromTemplate, setCreatingFromTemplate] = useState<AutomationTemplate | null>(null);
  const [scenarioInstallPack, setScenarioInstallPack] = useState<ScenarioTaskPack | null>(null);
  const [scenarioDraft, setScenarioDraft] = useState<ScenarioTaskDraft | null>(null);
  const [scenarioPreviewStatus, setScenarioPreviewStatus] = useState<ScenarioMutationStatus | null>(null);
  const [scenarioReminderNotice, setScenarioReminderNotice] = useState<ScenarioReminderNotice | null>(null);
  const [scenarioEnableConfirmOpen, setScenarioEnableConfirmOpen] = useState(false);
  const [pendingCreateMode, setPendingCreateMode] = useState<"blank" | "template" | null>(null);
  const [pendingCreateTemplate, setPendingCreateTemplate] = useState<AutomationTemplate | null>(null);
  const [confirmCreateOverLimit, setConfirmCreateOverLimit] = useState(false);
  const [viewingJob, setViewingJob] = useState<CronJob | null>(null);
  /** 正在编辑的 job；非空时弹编辑表单 */
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  /** 待确认删除的 job；非空时弹确认弹窗 */
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<CronJob | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 每个任务的测试运行状态：running=运行中，ok/fail=短暂结果态（1.8s 后自动回到 idle） */
  const [testState, setTestState] = useState<Record<string, "running" | "ok" | "fail">>({});
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "error" | "info" } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const testTimersRef = useRef<Record<string, number>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 列表加载失败的 inline 错误（与 toast 分离：list 失败不 toast，避免首屏刷屏） */
  const [listError, setListError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const jobsRef = useRef<CronJob[]>([]);
  const contextCapabilityRequestRef = useRef(0);
  const confirmDeleteDependents = useMemo<CronDependentBinding[]>(
    () => confirmDeleteJob ? getDirectCronDependents(jobs, confirmDeleteJob.id) : [],
    [confirmDeleteJob, jobs],
  );
  const activeJobs = useMemo(
    () => jobs.filter((job) => !isCronJobEnded(job)),
    [jobs],
  );
  const endedJobs = useMemo(
    () => jobs.filter(isCronJobEnded),
    [jobs],
  );
  const filteredActiveJobs = useMemo(
    () => activeJobs.filter((job) => {
      if (activeTaskFilter === "all") return true;
      if (activeTaskFilter === "agent") {
        return job.inference_config?.no_agent !== true && !job.zero_token_config;
      }
      return job.zero_token_config?.kind === activeTaskFilter;
    }),
    [activeJobs, activeTaskFilter],
  );
  const displayedJobs = activeView === "ended"
    ? endedJobs
    : filteredActiveJobs;
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const jobLimitReached = activeJobs.length >= MAX_CRON_JOBS_PER_BOT;
  const lightVelaTemplates = useMemo(() => getUnifiedAutomationTemplates(t, displayLocale), [displayLocale, t]);
  const templates = useMemo(
    () => mergeAutomationTemplateCatalog(lightVelaTemplates, runtimeBlueprints, displayLocale),
    [displayLocale, lightVelaTemplates, runtimeBlueprints],
  );
  const scenarioTemplatePacks = useMemo(() => getOverviewScenarioTaskPacks(displayLocale), [displayLocale]);
  const resolveScenarioPackForDisplay = useCallback((scenarioId: string) => (
    scenarioTemplatePacks.find((pack) => pack.id === scenarioId) ?? getScenarioTaskPack(scenarioId)
  ), [scenarioTemplatePacks]);

  useEffect(() => {
    let cancelled = false;
    if (!botId) {
      setRuntimeBlueprints([]);
      setLoadingBlueprints(false);
      return undefined;
    }
    setLoadingBlueprints(true);
    setRuntimeBlueprints([]);
    void listAutomationBlueprints(botId)
      .then((blueprints) => {
        if (!cancelled) setRuntimeBlueprints(blueprints);
      })
      .catch(() => {
        if (!cancelled) setRuntimeBlueprints([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBlueprints(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);
  // const installedScenarioIds = useMemo(() => new Set(
  //   SCENARIO_TASK_PACKS
  //     .filter((pack) => activeJobs.some((job) => isScenarioRecurringJobName({ generatedName: pack.name }, job.name) && !isOnceCronJob(job)))
  //     .map((pack) => pack.id),
  // ), [activeJobs]);

  const refreshChannelStatus = useCallback(async () => {
    if (!botId) {
      // No bot selected means there is no Hermes instance to configure; unlike fetch failures, disable all channels.
      setEnabledChannels(new Set());
      setChannelStatus("ready");
      return;
    }
    setChannelStatus("loading");
    try {
      const result = await execCommand(botId, "acli channel status");
      setEnabledChannels(parseEnabledHermesChannels(result.output));
    } catch {
      setEnabledChannels(new Set());
    } finally {
      setChannelStatus("ready");
    }
  }, [botId]);

  const refreshInstalledSkills = useCallback(async (): Promise<InstalledSkillLoadState> => {
    if (!botId) {
      installedSkillSlugsRef.current = [];
      const nextState: InstalledSkillLoadState = { status: "ready", slugs: [], error: null };
      setInstalledSkillLoadState(nextState);
      return nextState;
    }

    setInstalledSkillLoadState({
      status: "loading",
      slugs: installedSkillSlugsRef.current,
      error: null,
    });
    try {
      const slugs = await listInstalledSkillSlugs(runtimeBotId ?? "", profileId);
      installedSkillSlugsRef.current = slugs;
      const nextState: InstalledSkillLoadState = { status: "ready", slugs, error: null };
      setInstalledSkillLoadState(nextState);
      return nextState;
    } catch (error) {
      const nextState: InstalledSkillLoadState = {
        status: "error",
        slugs: installedSkillSlugsRef.current,
        error: error instanceof Error ? error.message : String(error),
      };
      setInstalledSkillLoadState(nextState);
      return nextState;
    }
  }, [botId, profileId, runtimeBotId]);

  const requestCreate = useCallback(() => {
    if (jobLimitReached) {
      setPendingCreateMode("blank");
      setPendingCreateTemplate(null);
      setConfirmCreateOverLimit(true);
      return;
    }
    setCreating(true);
  }, [jobLimitReached]);

  const requestTemplateCreate = useCallback((template: AutomationTemplate) => {
    trackDatongClick("automation_template_card", {
      pgid: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
      params: {
        bot_id: runtimeBotId ?? "",
        template_id: template.id,
        template_source: template.source,
        template_category: template.category,
      },
    });
    if (jobLimitReached) {
      setPendingCreateMode("template");
      setPendingCreateTemplate(template);
      setConfirmCreateOverLimit(true);
      return;
    }
    setCreatingFromTemplate(template);
  }, [jobLimitReached, runtimeBotId]);

  const showError = useCallback((message: string) => {
    if (errorTimerRef.current) {
      window.clearTimeout(errorTimerRef.current);
    }
    setErrorMessage(message);
    errorTimerRef.current = window.setTimeout(() => {
      setErrorMessage(null);
      errorTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    Object.values(testTimersRef.current).forEach((tid) => window.clearTimeout(tid));
  }, []);

  const showNotice = useCallback((message: string, tone: "success" | "error" | "info", autoHideMs = 3000) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    setNotice({ message, tone });
    if (autoHideMs > 0) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, autoHideMs);
    }
  }, []);

  const flashTestResult = useCallback((id: string, result: "ok" | "fail") => {
    setTestState((s) => ({ ...s, [id]: result }));
    if (testTimersRef.current[id]) window.clearTimeout(testTimersRef.current[id]);
    testTimersRef.current[id] = window.setTimeout(() => {
      setTestState((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
      delete testTimersRef.current[id];
    }, 1800);
  }, []);

  const refreshCreatedJobs = useCallback(async (manageLoading = true) => {
    if (!botId) {
      jobsRef.current = [];
      setJobs([]);
      setListError(null);
      return [];
    }
    if (manageLoading) setLoadingJobs(true);
    setListError(null);
    try {
      const list = await listCronJobs(botId, { hydrateContextFrom: true });
      jobsRef.current = list;
      setJobs(list);
      return list;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(message);
      return null;
    } finally {
      if (manageLoading) setLoadingJobs(false);
    }
  }, [botId]);

  const refreshRecentRuns = useCallback(async (currentJobs?: CronJob[], manageLoading = true): Promise<CronRunRecord[]> => {
    if (!botId) {
      setRecentRuns([]);
      return [];
    }
    if (manageLoading) setLoadingRecentRuns(true);
    try {
      const runs = await listRecentCronRuns(botId, currentJobs ?? jobsRef.current, 10);
      setRecentRuns(runs);
      return runs;
    } catch {
      setRecentRuns([]);
      return [];
    } finally {
      if (manageLoading) setLoadingRecentRuns(false);
    }
  }, [botId]);

  const refreshAll = useCallback(async () => {
    if (!botId) {
      jobsRef.current = [];
      setJobs([]);
      setRecentRuns([]);
      setListError(null);
      return;
    }
    setLoadingJobs(true);
    setLoadingRecentRuns(true);
    try {
      const list = await refreshCreatedJobs(false);
      if (list) await refreshRecentRuns(list, false);
      else setRecentRuns([]);
    } finally {
      setLoadingJobs(false);
      setLoadingRecentRuns(false);
    }
  }, [botId, refreshCreatedJobs, refreshRecentRuns]);

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setManualRefreshing(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const refreshContextCapability = useCallback(async () => {
    const requestId = ++contextCapabilityRequestRef.current;
    if (!botId) {
      setContextCapability("unknown");
      return;
    }
    setContextCapability("loading");
    const capability = await detectCronContextFromCapability(botId);
    if (contextCapabilityRequestRef.current === requestId) {
      setContextCapability(capability);
    }
  }, [botId]);

  useEffect(() => {
    void refreshContextCapability();
    return () => {
      contextCapabilityRequestRef.current += 1;
    };
  }, [refreshContextCapability]);

  useEffect(() => {
    void refreshChannelStatus();
  }, [refreshChannelStatus]);

  useEffect(() => {
    installedSkillSlugsRef.current = [];
    setInstalledSkillLoadState({ status: "idle", slugs: [], error: null });
    void refreshInstalledSkills();
  }, [botId, refreshInstalledSkills]);

  // const openScenarioInstaller = useCallback((pack: ScenarioTaskPack) => {
  //   setScenarioInstallPack(pack);
  // }, []);

  const handleScenarioRunOnce = useCallback(async (draft: ScenarioTaskDraft) => {
    if (!botId) return;
    if (jobLimitReached) {
      showError(t("定时任务数量已达上限，请先删除不需要的任务后再试跑场景"));
      return;
    }
    const pack = getScenarioTaskPack(draft.scenarioId);
    const nextDraft = buildScenarioTaskDraft({
      pack,
      values: draft.values,
      now: new Date(),
      deliver: draft.generatedDeliver,
    });
    setScenarioDraft(nextDraft);
    setScenarioPreviewStatus("creating");
    try {
      await createCronJobWithScriptRollback(botId, {
        name: nextDraft.oneShotJobName,
        prompt: nextDraft.generatedPrompt,
        schedule: nextDraft.oneShotSchedule,
        deliver: nextDraft.generatedDeliver,
        pinCurrentModel: true,
      });
      void sendScenarioStartNotice(botId, nextDraft, t);
      const list = await refreshCreatedJobs(false);
      await refreshRecentRuns(list ?? jobsRef.current, false);
      setScenarioInstallPack(null);
      setScenarioPreviewStatus(null);
      setScenarioReminderNotice({ draft: nextDraft, kind: "preview" });
      setActiveView("created");
      showNotice(t("已开始试跑，结果会稍后推送"), "success");
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      setScenarioPreviewStatus(null);
      showError(t("创建场景试跑失败：{{message}}", { message }));
    }
  }, [botId, jobLimitReached, refreshCreatedJobs, refreshRecentRuns, showError, showNotice, t]);

  const handleScenarioEnableDirect = useCallback((draft: ScenarioTaskDraft) => {
    setScenarioInstallPack(null);
    setScenarioDraft(draft);
    setScenarioEnableConfirmOpen(true);
    setScenarioReminderNotice(null);
  }, []);

  const handleScenarioEnableConfirm = useCallback(async () => {
    if (!botId || !scenarioDraft) return;
    const scenarioTrialJob = jobsRef.current.find((job) => job.name === scenarioDraft.oneShotJobName && isOnceCronJob(job));
    if (jobLimitReached && !scenarioTrialJob) {
      showError(t("定时任务数量已达上限，请先删除不需要的任务后再启用场景"));
      return;
    }
    setScenarioPreviewStatus("enabling");
    try {
      if (jobLimitReached && scenarioTrialJob) {
        await removeCronJob(botId, scenarioTrialJob.id);
      }
      await createCronJobWithScriptRollback(botId, {
        name: scenarioDraft.generatedName,
        prompt: scenarioDraft.generatedPrompt,
        schedule: scenarioDraft.recurringSchedule,
        deliver: scenarioDraft.generatedDeliver,
        pinCurrentModel: true,
      });
      setScenarioEnableConfirmOpen(false);
      await refreshAll();
      setScenarioPreviewStatus(null);
      setScenarioReminderNotice({ draft: scenarioDraft, kind: "recurring" });
      showNotice(t("已添加为定时任务，后续会按设置频率提醒"), "success");
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      setScenarioPreviewStatus(null);
      showError(t("添加场景定时任务失败：{{message}}", { message }));
    }
  }, [botId, jobLimitReached, refreshAll, scenarioDraft, showError, showNotice, t]);

  const handleAction = useCallback(async (
    job: CronJob,
    action: "pause" | "resume" | "remove",
    dependents: readonly CronDependentBinding[] = [],
  ) => {
    if (!botId) return;
    setBusyId(job.id);
    try {
      if (action === "pause") await pauseCronJob(botId, job.id);
      else if (action === "resume") await resumeCronJob(botId, job.id);
      else if (dependents.length > 0) await removeCronJobWithDependentRollback(botId, job.id, dependents);
      else await removeCronJob(botId, job.id);
      let scriptCleanupFailed = false;
      if (action === "remove") {
        try {
          await removeManagedCronScriptIfUnreferenced(botId, job, jobs);
        } catch {
          scriptCleanupFailed = true;
        }
      }
      await refreshAll();
      if (action === "remove") {
        setDeleteError(null);
        setConfirmDeleteJob(null);
        if (scriptCleanupFailed) {
          showError(t("任务已删除，但关联脚本未能清理；不会影响其他任务，请稍后重试。"));
        }
      }
    } catch (err) {
      if (action === "remove" && dependents.length > 0) {
        setDeleteError(formatCronDependentRemovalError(err, job, dependents, t));
        return;
      }
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      const labels: Record<typeof action, string> = {
        pause: t("暂停"),
        resume: t("恢复"),
        remove: t("删除"),
      };
      showError(t("{{action}}失败：{{message}}", { action: labels[action], message }));
    } finally {
      setBusyId(null);
    }
  }, [botId, jobs, refreshAll, showError, t]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!botId || !confirmDeleteJob) return;
    const previewDependents = confirmDeleteDependents;
    setBusyId(confirmDeleteJob.id);
    setDeleteError(null);
    const latestJobs = await refreshCreatedJobs(false);
    if (!latestJobs || latestJobs.some((job) => job.context_from_hydrated !== true)) {
      setDeleteError(t("暂时无法确认最新依赖关系，请重试"));
      setBusyId(null);
      return;
    }
    const latestTarget = latestJobs.find((job) => job.id === confirmDeleteJob.id);
    if (!latestTarget) {
      setDeleteError(t("暂时无法确认最新依赖关系，请重试"));
      setBusyId(null);
      return;
    }
    const latestDependents = getDirectCronDependents(latestJobs, latestTarget.id);
    if (!haveSameCronDependents(previewDependents, latestDependents)) {
      setDeleteError(t("任务依赖关系已变化，请确认最新受影响任务后再次删除"));
      setBusyId(null);
      return;
    }
    trackDatongEvent(DATONG_EVENTS.AUTOMATION_DELETE, {
      pgid: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
      params: { bot_id: runtimeBotId ?? "", task_id: latestTarget.id },
    });
    await handleAction(latestTarget, "remove", latestDependents);
  }, [botId, confirmDeleteDependents, confirmDeleteJob, handleAction, refreshCreatedJobs, runtimeBotId, t]);

  /**
   * 测试运行：立即真实执行一次（`startCronTestRun`）。
   *
   * 不直接对原 job 调用 `hermes cron run <job.id>`——那样会真正推进原任务的
   * 调度状态（一次性任务会被直接标记完成+禁用，永远不会在原定时间再触发）。
   * 而是克隆一个用完即焚的临时任务代理执行，原任务的状态完全不受影响。
   *
   * 交互上分两段，避免让用户对着转圈盲等两三分钟：
   * 1. 前置阶段（`startCronTestRun` await 完成）：即时回执已发到 IM、临时任务已挂上。
   *    这几步是秒级的，完成即撤掉「正在测试运行」的转圈，提示用户「已在后台执行、去 IM 看结果」。
   * 2. 后台阶段（`completion`，fire-and-forget）：等临时任务真正被调度器执行完，读取真实投递
   *    结果。这里仍要检查 `deliveryError`：Agent 跑成功只代表 `last_status` 正常，不代表通知
   *    真投出去了——投递失败会单独记录在 `last_delivery_error`。后台拿到结果后再补一个短暂的
   *    成功/失败角标 + toast，但不再阻塞用户。
   */
  const handleTestRun = useCallback(async (job: CronJob) => {
    if (!botId || testState[job.id] === "running") return;
    setTestState((s) => ({ ...s, [job.id]: "running" }));
    showNotice(t("正在唤起测试运行…"), "info", 0);
    let started: Awaited<ReturnType<typeof startCronTestRun>>;
    try {
      // 前置阶段：发完即时回执、挂上临时任务就返回（秒级）。
      started = await startCronTestRun(botId, job);
    } catch (err) {
      // 连回执/临时任务都没挂上，才算前置失败——如实报错并撤转圈。
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      flashTestResult(job.id, "fail");
      showNotice(t("测试运行失败：{{message}}", { message }), "error");
      return;
    }
    // 前置成功：即时回执已发出、任务已在后台跑。立刻撤转圈，不再让用户盲等真正执行完。
    flashTestResult(job.id, "ok");
    showNotice(t("已在后台执行，请在你的 IM 软件中查看运行结果"), "success");
    // 后台阶段 fire-and-forget：等真正执行完后给用户一个明确交代——不再阻塞 UI，但也
    // 不再「全静默」。三种结局分别提示：
    //   1. 执行成功且投递成功 → 静默（用户已从 IM 收到结果，无需再打扰）。
    //   2. 执行了但投递失败（last_delivery_error 有值）→ error toast。
    //   3. 后台等待超时/异常（调度器迟迟没执行、清理失败等）→ 一条非阻塞的提示 toast，
    //      避免用户像之前那样「等半天没结果也没任何提示」蒙在鼓里。
    void started.completion
      .then((result) => {
        if (result.deliveryError) {
          showNotice(t("任务已执行，但通知投递失败：{{message}}", { message: result.deliveryError }), "error");
        }
        void refreshRecentRuns(undefined, false);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showNotice(
          t("后台执行未能确认结果：{{message}}。即时回执已发出，任务可能仍在后台运行，请稍后在 IM 中确认。", { message }),
          "info",
        );
      });
  }, [botId, testState, showNotice, flashTestResult, refreshRecentRuns, t]);

  if (!botId) {
    return (
      <div className="rounded-xl p-8 text-center text-sm text-black/60" style={PANEL_CARD_STYLE}>
        {t("请先选中一个智能体实例")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMessage && <ErrorToast message={errorMessage} onClose={() => setErrorMessage(null)} />}
      {notice && <ErrorToast message={notice.message} tone={notice.tone} onClose={() => setNotice(null)} />}

      <AgentSectionHeader
        title={t("定时任务")}
        description={t("让你的智能体伙伴按计划自动执行任务")}
        actions={(
          <div className="inline-flex items-center gap-2.5">
            <button
              type="button"
              onClick={requestCreate}
              className="lv-button lv-button--primary inline-flex min-w-[88px] items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-white transition hover:bg-black/85"
            >
              <Plus className="h-5 w-5" />
              <span className="text-base font-semibold leading-none">{t("新建")}</span>
            </button>
          </div>
        )}
      />

      {gatewayRunning === false && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#F5D9A8] bg-[#FFFBF3] px-4 py-3 text-sm">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#FDF0DC] text-[#A86108]">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            </span>
            <p className="min-w-0 text-black/70">{t("网关未运行，此 Bot 的定时任务不会执行。")}</p>
          </div>
          {onRestartGateway && (
            <button
              type="button"
              onClick={onRestartGateway}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[#F5D9A8] bg-white px-3 py-1.5 font-medium text-[#A86108] transition hover:bg-[#FFF7EA]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t("重启网关")}
            </button>
          )}
        </section>
      )}

      <AutomationScenarioTemplatesSection
        templates={templates}
        onEnable={requestTemplateCreate}
        loading={loadingBlueprints}
      />

      {!isGlobal && scenarioReminderNotice && (
        <ScenarioReminderBanner
          notice={scenarioReminderNotice}
          pack={resolveScenarioPackForDisplay(scenarioReminderNotice.draft.scenarioId)}
          onDismiss={() => setScenarioReminderNotice(null)}
          onViewCreated={() => setActiveView("created")}
          onEnable={() => {
            setScenarioDraft(scenarioReminderNotice.draft);
            setScenarioReminderNotice(null);
            setScenarioEnableConfirmOpen(true);
          }}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-black/[0.04] p-1">
          <button
            type="button"
            onClick={() => setActiveView("created")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeView === "created" ? "bg-white text-black shadow-sm" : "text-black/55 hover:text-black/80"}`}
            aria-pressed={activeView === "created"}
          >
            {t("当前任务")}
          </button>
          <button
            type="button"
            onClick={() => setActiveView("ended")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeView === "ended" ? "bg-white text-black shadow-sm" : "text-black/55 hover:text-black/80"}`}
            aria-pressed={activeView === "ended"}
          >
            {t("已结束任务")}
          </button>
          <button
            type="button"
            onClick={() => setActiveView("recent")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeView === "recent" ? "bg-white text-black shadow-sm" : "text-black/55 hover:text-black/80"}`}
            aria-pressed={activeView === "recent"}
          >
            {t("最近执行")}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {activeView === "created" && (
            <Select
              value={activeTaskFilter}
              onValueChange={(value) => setActiveTaskFilter(value as ActiveTaskFilter)}
            >
              <SelectTrigger
                aria-label={t("任务类型")}
                className="h-8 w-auto justify-start gap-1.5 rounded-md border-black/10 bg-white px-2.5 py-1.5 text-xs font-medium text-black/65 shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                sideOffset={6}
                align="end"
                className="min-w-[120px] rounded-md border-black/10 bg-white shadow-lg"
              >
                <SelectItem value="all" className="rounded-sm py-2 pl-7 pr-3 text-xs">{t("全部")}</SelectItem>
                <SelectItem value="agent" className="rounded-sm py-2 pl-7 pr-3 text-xs">{t("智能任务")}</SelectItem>
                <SelectItem value="fixed_notification" className="rounded-sm py-2 pl-7 pr-3 text-xs">{t("通知任务")}</SelectItem>
                <SelectItem value="script" className="rounded-sm py-2 pl-7 pr-3 text-xs">{t("脚本任务")}</SelectItem>
              </SelectContent>
            </Select>
          )}
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={loadingJobs || loadingRecentRuns || manualRefreshing}
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center text-black/35 transition hover:text-black/80 disabled:cursor-not-allowed disabled:text-black/20"
            aria-label={t("刷新")}
            title={t("刷新")}
          >
            <RefreshCw className={`size-4 ${manualRefreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      <div className={(activeView !== "recent" && (loadingJobs || listError || displayedJobs.length === 0)) || (activeView === "recent" && loadingRecentRuns) ? "rounded-xl p-4" : ""} style={(activeView !== "recent" && (loadingJobs || listError || displayedJobs.length === 0)) || (activeView === "recent" && loadingRecentRuns) ? PANEL_CARD_STYLE : undefined}>
        {activeView !== "recent" && loadingJobs ? (
          <div className="flex items-center justify-center py-8 text-sm text-black/50">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("加载中…")}
          </div>
        ) : activeView !== "recent" && listError ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm">
            <AlertTriangle className="mb-2 h-6 w-6 text-[#B91C1C] opacity-80" />
            <p className="text-black/70">{t("加载定时任务失败")}</p>
            <p className="mt-1 max-w-md break-all px-4 text-center text-xs text-black/40">{listError}</p>
            <button
              type="button"
              onClick={() => void refreshCreatedJobs()}
              className="mt-3 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-black/70 transition hover:bg-black/[0.04]"
            >
              {t("重试")}
            </button>
          </div>
        ) : activeView === "recent" && loadingRecentRuns ? (
          <div className="flex items-center justify-center py-8 text-sm text-black/50">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("加载中…")}
          </div>
        ) : activeView === "recent" ? (
          <RecentCronRunsPanel
            runs={recentRuns}
            jobs={jobs}
            skillLoadState={installedSkillLoadState}
          />
        ) : displayedJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm text-black/50">
            <Clock className="mb-2 h-6 w-6 opacity-50" />
            {activeView === "ended" ? (
              <p>{t("暂无已结束任务")}</p>
            ) : activeTaskFilter !== "all" ? (
              <p>{t("暂无符合条件的任务")}</p>
            ) : (
              <p>
                {t("暂无定时任务，")}
                <span>{t("可从上方任务模板快速启用")}</span>
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[...displayedJobs]
              .sort((a, b) => {
                // 最新创建在前；缺 created_at 的丢到末尾
                const ta = a.created_at ? Date.parse(a.created_at) : 0;
                const tb = b.created_at ? Date.parse(b.created_at) : 0;
                return tb - ta;
              })
              .map((job) => (
                <CronJobCard
                  key={job.id}
                  job={job}
                  upstream={job.context_from?.length === 1 ? jobsById.get(job.context_from[0]!) ?? null : null}
                  upstreamMissing={job.context_from?.length === 1 && !jobsById.has(job.context_from[0]!)}
                  busy={busyId === job.id}
                  testState={testState[job.id] ?? "idle"}
                  onTestRun={() => handleTestRun(job)}
                  onView={() => setViewingJob(job)}
                  onEdit={() => setEditingJob(job)}
                  onPause={() => handleAction(job, "pause")}
                  onResume={() => handleAction(job, "resume")}
                  onRemove={() => {
                    setDeleteError(null);
                    setConfirmDeleteJob(job);
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {creating && (
        <AutomationFormModal
          botId={botId}
          mode="create"
          jobs={jobs}
          contextCapability={contextCapability}
          onRetryContextCapability={refreshContextCapability}
          enabledChannels={enabledChannels}
          channelStatus={channelStatus}
          skillLoadState={installedSkillLoadState}
          onRefreshSkills={refreshInstalledSkills}
          onRefreshJobs={refreshCreatedJobs}
          testState={testState[AUTOMATION_FORM_TEST_JOB_ID] ?? "idle"}
          onTestRun={(job) => void handleTestRun(job)}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            trackDatongEvent(DATONG_EVENTS.AUTOMATION_CREATE_SUCCESS, {
              pgid: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
              params: { bot_id: runtimeBotId ?? "" },
            });
            setCreating(false);
            setActiveView("created");
            await refreshAll();
          }}
          onError={showError}
        />
      )}

      {!isGlobal && scenarioInstallPack && (
        <ScenarioInstallModal
          pack={scenarioInstallPack}
          botId={runtimeBotId ?? ""}
          submitting={scenarioPreviewStatus === "creating" || scenarioPreviewStatus === "enabling"}
          initialValues={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.values : undefined}
          initialDeliver={scenarioDraft?.scenarioId === scenarioInstallPack.id ? scenarioDraft.generatedDeliver : undefined}
          enabledChannels={enabledChannels}
          channelStatus={channelStatus}
          onRefreshChannels={refreshChannelStatus}
          onClose={() => setScenarioInstallPack(null)}
          onRunOnce={handleScenarioRunOnce}
          onEnableDirect={handleScenarioEnableDirect}
        />
      )}

      {!isGlobal && scenarioEnableConfirmOpen && scenarioDraft && (
        <ScenarioEnableConfirmModal
          pack={resolveScenarioPackForDisplay(scenarioDraft.scenarioId)}
          draft={scenarioDraft}
          busy={scenarioPreviewStatus === "enabling"}
          onCancel={() => setScenarioEnableConfirmOpen(false)}
          onConfirm={handleScenarioEnableConfirm}
        />
      )}

      {creatingFromTemplate && (
        <AutomationFormModal
          botId={botId}
          mode="create"
          template={creatingFromTemplate}
          jobs={jobs}
          contextCapability={contextCapability}
          onRetryContextCapability={refreshContextCapability}
          enabledChannels={enabledChannels}
          channelStatus={channelStatus}
          skillLoadState={installedSkillLoadState}
          onRefreshSkills={refreshInstalledSkills}
          onRefreshJobs={refreshCreatedJobs}
          testState={testState[AUTOMATION_FORM_TEST_JOB_ID] ?? "idle"}
          onTestRun={(job) => void handleTestRun(job)}
          onClose={() => setCreatingFromTemplate(null)}
          onSaved={async () => {
            trackDatongEvent(DATONG_EVENTS.AUTOMATION_CREATE_SUCCESS, {
              pgid: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
              params: {
                bot_id: runtimeBotId ?? "",
                template_id: creatingFromTemplate.id,
                template_source: creatingFromTemplate.source,
                template_category: creatingFromTemplate.category,
              },
            });
            setCreatingFromTemplate(null);
            setActiveView("created");
            await refreshAll();
          }}
          onError={showError}
        />
      )}

      {confirmCreateOverLimit && (
        <ConfirmCreateOverLimitModal
          onCancel={() => {
            setConfirmCreateOverLimit(false);
            setPendingCreateMode(null);
            setPendingCreateTemplate(null);
          }}
          onConfirm={() => {
            setConfirmCreateOverLimit(false);
            const mode = pendingCreateMode ?? "blank";
            const template = pendingCreateTemplate;
            setPendingCreateMode(null);
            setPendingCreateTemplate(null);
            if (mode === "template" && template) setCreatingFromTemplate(template);
            else setCreating(true);
          }}
        />
      )}

      {editingJob && (
        <AutomationFormModal
          botId={botId}
          mode="edit"
          initialJob={editingJob}
          jobs={jobs}
          contextCapability={contextCapability}
          onRetryContextCapability={refreshContextCapability}
          enabledChannels={enabledChannels}
          channelStatus={channelStatus}
          skillLoadState={installedSkillLoadState}
          onRefreshSkills={refreshInstalledSkills}
          onRefreshJobs={refreshCreatedJobs}
          testState={testState[editingJob.id] ?? "idle"}
          onTestRun={(job) => void handleTestRun(job)}
          onClose={() => setEditingJob(null)}
          onSaved={async () => {
            setEditingJob(null);
            await refreshAll();
          }}
          onError={showError}
        />
      )}

      {viewingJob && (
        <CronJobDetailModal
          job={viewingJob}
          jobsById={jobsById}
          lastAgentRun={getLastAgentRunForJob(viewingJob, recentRuns)}
          skillLoadState={installedSkillLoadState}
          onClose={() => setViewingJob(null)}
        />
      )}

      {confirmDeleteJob && (
        <ConfirmDeleteModal
          jobName={confirmDeleteJob.name}
          dependents={confirmDeleteDependents}
          error={deleteError}
          busy={busyId === confirmDeleteJob.id}
          onCancel={() => {
            setDeleteError(null);
            setConfirmDeleteJob(null);
          }}
          onConfirm={async () => {
            await handleDeleteConfirm();
          }}
        />
      )}
    </div>
  );
}

export function shouldShowRecentRunsLimitHint(runCount: number): boolean {
  return runCount >= 10;
}

function getVisibleAutomationPrompt(prompt: string): string {
  return splitAutomationExecutionPrompt(prompt).visiblePrompt;
}

export function RecentCronRunsPanel({
  runs,
  jobs = [],
  skillLoadState,
}: {
  runs: CronRunRecord[];
  jobs?: CronJob[];
  skillLoadState: InstalledSkillLoadState;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const displayLocale = getAutomationDisplayLocale(i18n.language);
  const [viewingRun, setViewingRun] = useState<CronRunRecord | null>(null);
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);
  const viewingJob = viewingRun ? jobsById.get(viewingRun.job_id) : undefined;
  const viewingUpstream = viewingJob?.context_from?.length === 1
    ? jobsById.get(viewingJob.context_from[0]!)
    : undefined;
  return (
    <div>
      <section className="overflow-hidden rounded-md bg-white" style={PANEL_CARD_STYLE}>
        {runs.length === 0 ? (
          <div className="m-4 flex items-center gap-2 px-3 py-2 text-xs text-black/45">
            <Clock className="h-3.5 w-3.5" />
            {t("暂无执行记录")}
          </div>
        ) : (
          <div className="divide-y divide-black/[0.06] px-4">
            {runs.map((run) => {
              const presentation = getScenarioRunPresentation(run, displayLocale);
              const taskTypeLabel = run.zero_token_config
                ? run.zero_token_config.kind === "fixed_notification"
                  ? t("0 Token · 固定通知")
                  : t("0 Token · 脚本任务")
                : t("智能任务");
              const summary = run.zero_token_config?.kind === "fixed_notification"
                ? run.zero_token_config.content || ""
                : getVisibleAutomationPrompt(presentation.prompt);
              return (
                <div key={run.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-black/85" title={presentation.name}>
                        {presentation.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => setViewingRun(run)}
                        className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-black/45 transition hover:bg-black/[0.04] hover:text-black/75"
                        aria-label={t("查看任务详情")}
                        title={t("查看任务详情")}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {summary && (
                      <p className="mt-1 line-clamp-2 text-pretty text-xs leading-relaxed text-black/55" title={summary}>
                        {summary}
                      </p>
                    )}
                    {run.skip_reason === "model_changed" && (
                      <p className="mt-1 text-xs leading-relaxed text-black/45">
                        {t("问题原因：模型切换导致任务未执行")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${run.zero_token_config
                      ? "bg-emerald-500/10 text-emerald-800"
                      : "bg-sky-500/10 text-sky-800"}`}
                    >
                      {taskTypeLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => setViewingRun(run)}
                      className="rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] text-black/55 transition hover:bg-black/[0.1] hover:text-black/75"
                      aria-label={t("查看任务详情")}
                      title={t("查看任务详情")}
                    >
                      {run.status ? formatLastStatus(run.status, t) : t("已执行")}
                    </button>
                    <time className="text-right text-xs text-black/55" dateTime={run.run_at}>
                      {formatTime(run.run_at)}
                    </time>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {viewingRun && (
          <RecentCronRunDetailModal
            run={viewingRun}
            currentUpstream={viewingUpstream ?? null}
            skillLoadState={skillLoadState}
            onClose={() => setViewingRun(null)}
          />
        )}
      </section>
      {shouldShowRecentRunsLimitHint(runs.length) && (
        <div className="flex justify-center pt-1">
          <p className="text-center text-[11px] leading-4 text-black/35">
            {t("最多展示最近 10 条执行记录")}
          </p>
        </div>
      )}
    </div>
  );
}

function runToCronJob(run: CronRunRecord): CronJob {
  return {
    id: run.job_id,
    name: run.job_name,
    prompt: run.job_prompt,
    schedule: run.schedule ?? { kind: "", expr: "", display: "" },
    skills: run.skills,
    enabled: true,
    state: "",
    deliver: run.deliver,
    next_run_at: null,
    last_run_at: run.run_at,
    last_status: run.status,
    created_at: null,
    script: "",
    effective_window: null,
    lightvela_schedule: null,
    context_from: null,
    inference_config: run.zero_token_config
      ? { provider: null, model: null, no_agent: true }
      : null,
    zero_token_config: run.zero_token_config ?? null,
  };
}

function RecentCronRunDetailModal({
  run,
  currentUpstream,
  skillLoadState,
  onClose,
}: {
  run: CronRunRecord;
  currentUpstream: CronJob | null;
  skillLoadState: InstalledSkillLoadState;
  onClose: () => void;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const presentation = getScenarioRunPresentation(run, getAutomationDisplayLocale(i18n.language));
  const visiblePrompt = getVisibleAutomationPrompt(presentation.prompt);
  const zeroTokenConfig = run.zero_token_config;
  return createPortal(
    <div
      className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-[520px] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="lv-icon-button absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <h2 className="truncate text-balance text-lg font-semibold text-black/90">{presentation.name || t("未命名任务")}</h2>
          <span className="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] text-black/55">
            {run.status ? formatLastStatus(run.status, t) : t("已执行")}
          </span>
        </div>

        <dl className="mt-5 overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <DetailRow
            label={t("任务类型")}
            value={zeroTokenConfig
              ? zeroTokenConfig.kind === "fixed_notification"
                ? t("0 Token · 固定通知")
                : t("0 Token · 脚本任务")
              : t("智能任务")}
          />
          {zeroTokenConfig ? (
            <DetailRow
              label={zeroTokenConfig.kind === "fixed_notification" ? t("通知内容") : t("脚本语言")}
              value={zeroTokenConfig.kind === "fixed_notification"
                ? zeroTokenConfig.content || t("内容仅可在创建它的工具中查看")
                : zeroTokenConfig.language === "bash" ? "Bash" : "Python"}
              pre={zeroTokenConfig.kind === "fixed_notification"}
            />
          ) : (
            <>
              <DetailRow label={t("任务说明")} value={visiblePrompt || "—"} pre />
              <DetailRow
                label={t("调用技能")}
                value={(
                  <AutomationSkillBindingSummary
                    value={run.skills}
                    loadState={skillLoadState}
                  />
                )}
              />
            </>
          )}
          <DetailRow label={t("执行时间")} value={run.schedule ? formatScheduleFriendly(runToCronJob(run), t) : "—"} />
          <DetailRow label={t("本次执行")} value={formatTime(run.run_at)} />
          {currentUpstream && (
            <DetailRow
              label={t("当前关联上游")}
              value={<UpstreamCurrentState job={currentUpstream} />}
            />
          )}
          <DeliverDetailRow deliver={run.deliver} />
          <DetailRow label={t("任务 ID")} value={run.job_id} />
        </dl>
      </div>
    </div>,
    document.body,
  );
}

function CronJobCard({
  job,
  upstream,
  upstreamMissing,
  busy,
  testState,
  onTestRun,
  onView,
  onEdit,
  onPause,
  onResume,
  onRemove,
}: {
  job: CronJob;
  upstream: CronJob | null;
  upstreamMissing: boolean;
  busy: boolean;
  testState: "idle" | "running" | "ok" | "fail";
  onTestRun: () => void;
  onView: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const terminal = isCronJobEnded(job);
  const paused = isCronJobPaused(job);
  const running = isCronJobRunning(job);
  const disabled = job.state.trim().toLowerCase() === "disabled";
  const endedLabel = terminal ? getCronJobEndedLabel(job, t) : null;
  const expired = !running && !terminal && isCronJobExpired(job);
  const expiredLabel = expired
    ? (isCronJobExecutionFailed(job) ? t("执行失败") : t("已执行"))
    : null;
  const effectiveStatus = getEffectiveWindowStatus(job.effective_window);
  const hasEffectiveWindow = effectiveStatus !== "always";
  const presentation = getScenarioCronJobPresentation(job, getAutomationDisplayLocale(i18n.language));
  const visiblePrompt = getVisibleAutomationPrompt(presentation.prompt);
  const fullName = presentation.name || t("未命名任务");
  const zeroTokenConfig = job.zero_token_config;
  const taskSummary = zeroTokenConfig
    ? zeroTokenConfig.kind === "fixed_notification"
      ? zeroTokenConfig.content || t("固定通知")
      : t("{{language}} 脚本；标准输出非空时原样通知", {
          language: zeroTokenConfig.language === "bash" ? "Bash" : "Python",
        })
    : visiblePrompt;
  const scheduleLabel = formatScheduleFriendly(job, t);
  const scheduleTooltipLabel = formatScheduleTooltip(job, t);
  return (
    <div
      className="flex flex-col rounded-md bg-white p-4 transition hover:shadow-md"
      style={{ ...PANEL_CARD_STYLE, minHeight: 178 }}
    >
      <div className="flex items-start justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Clock className="h-4 w-4 shrink-0 text-black/40" />
          <span className="min-w-0 truncate text-sm font-medium text-black/90" title={fullName}>
            {fullName}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            {running && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("执行中")}
              </span>
            )}
            {effectiveStatus === "ended" && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已过生效期")}
              </span>
            )}
            {expiredLabel && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {expiredLabel}
              </span>
            )}
            {endedLabel && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {endedLabel}
              </span>
            )}
            {disabled && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已停用")}
              </span>
            )}
            {paused && !disabled && (
              <span className="rounded-full bg-[#FFF1D6] px-2 py-0.5 text-xs text-[#9A5A00]">
                {t("已暂停")}
              </span>
            )}
        </div>
      </div>

      <p className="line-clamp-4 min-h-[6.5em] flex-1 text-xs leading-relaxed text-black/55">{taskSummary}</p>

      {job.context_from?.length === 1 && (
        <p className="mt-2 truncate text-xs text-black/45">
          {upstream
            ? isGlobal
              ? t("来自：{{name}}", { name: upstream.name })
              : t("上游任务：{{name}}", { name: upstream.name })
            : upstreamMissing
              ? isGlobal
                ? t("来自：上游任务已不可用")
                : t("上游任务：已不可用")
              : null}
          {upstream && isCronJobPaused(upstream) ? t("（已暂停）") : ""}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-black/[0.04] pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <ImmediateTooltipText label={scheduleLabel} message={scheduleTooltipLabel} />
          {hasEffectiveWindow && (
            <EffectiveWindowBadge
              label={t("有效期")}
              messages={formatEffectiveWindowTooltipLines(job.effective_window, t)}
            />
          )}
        </div>
        <div className="flex shrink-0 items-center">
          <CronActionButton label={t("测试运行")} onClick={onTestRun} disabled={busy || testState === "running"}>
            {testState === "running" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : testState === "ok" ? (
              <CheckCircle2 className="h-3 w-3 text-[#0F8A4B]" />
            ) : testState === "fail" ? (
              <X className="h-3 w-3 text-[#B91C1C]" />
            ) : (
              <Zap className="h-3 w-3" />
            )}
          </CronActionButton>
          <CronActionButton label={t("查看")} onClick={onView}>
            <Eye className="h-3 w-3" />
          </CronActionButton>
          <CronActionButton label={t("编辑")} onClick={onEdit} disabled={busy}>
            <Pencil className="h-3 w-3" />
          </CronActionButton>
          {!terminal && (paused ? (
            <CronActionButton label={t("恢复")} onClick={onResume} disabled={busy}>
              <Play className="h-3 w-3" />
            </CronActionButton>
          ) : (
            <CronActionButton label={t("暂停")} onClick={onPause} disabled={busy}>
              <Pause className="h-3 w-3" />
            </CronActionButton>
          ))}
          <CronActionButton label={t("删除")} onClick={onRemove} disabled={busy}>
            <Trash2 className="h-3 w-3" />
          </CronActionButton>
        </div>
      </div>
    </div>
  );
}

function CronActionButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/15 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={label}
      >
        {children}
      </button>
      <span className="pointer-events-auto absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 select-text whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-2.5 py-1 text-[11px] font-medium leading-4 text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-75 group-hover:opacity-100 group-focus-within:opacity-100">
        {label}
        <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
      </span>
    </span>
  );
}

function isCronJobPaused(job: CronJob): boolean {
  return !isCronJobEnded(job)
    && (!job.enabled || job.state.trim().toLowerCase() === "paused");
}

export function isCronJobRunning(job: CronJob): boolean {
  return job.execution_status?.trim().toLowerCase() === "running";
}

function isCronJobTerminalState(job: CronJob): boolean {
  return ["completed", "error", "done", "expired", "cancelled", "canceled"]
    .includes(job.state.trim().toLowerCase());
}

function isCronJobEnded(job: CronJob): boolean {
  return isCronJobTerminalState(job)
    || (!isCronJobRunning(job) && isCronJobExpiredBeyondGrace(job));
}

function isCronJobExecutionFailed(job: CronJob): boolean {
  const state = job.state.trim().toLowerCase();
  const executionStatus = job.execution_status?.trim().toLowerCase();
  return state === "error"
    || executionStatus === "failed"
    || executionStatus === "failure"
    || executionStatus === "error";
}

function getCronJobEndedLabel(job: CronJob, t: ReturnType<typeof useT>): string {
  const state = job.state.trim().toLowerCase();
  if (isCronJobExecutionFailed(job)) return t("执行失败");
  if (state === "expired" || (!isCronJobTerminalState(job) && isCronJobExpiredBeyondGrace(job))) {
    return t("已过期");
  }
  if (state === "cancelled" || state === "canceled") return t("已取消");
  return t("已完成");
}

function isOnceCronJob(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim();
  return kind === "once" || display.toLowerCase().startsWith("once");
}

export function isCronJobExpired(job: CronJob, now = Date.now()): boolean {
  if (!isOnceCronJob(job) || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && d.getTime() < now;
}

function isCronJobUnavailableAsUpstream(job: CronJob, now = Date.now()): boolean {
  return isCronJobExpired(job, now)
    || isCronJobTerminalState(job)
    || getEffectiveWindowStatus(job.effective_window, now) === "ended";
}

export function isCronJobExpiredBeyondGrace(job: CronJob): boolean {
  if (!isOnceCronJob(job) || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && Date.now() - d.getTime() > EXPIRED_CRON_JOB_HIDE_AFTER_MS;
}

function isScenarioTrialJob(job: CronJob): boolean {
  return isOnceCronJob(job) && job.name.startsWith("试跑 - ");
}

/** 把 cron schedule + next_run_at 翻译成人话。
 *  - once：输出「单次 2026-05-26 09:00」，过期状态由卡片标签展示
 *  - interval：every 30m → 每 30 分钟；every 60m → 每 1 小时
 *  - cron：`0 9 * * *` → 每天 09:00；`0 9 * * 1,3` → 每周一、周三 09:00；`0 9 1 * *` → 每月 1 日 09:00
 *  - 其它复杂 cron 表达式：原样返回
 */
function formatScheduleFriendly(
  job: CronJob,
  t: (s: string, vars?: Record<string, unknown>) => string,
): string {
  if (job.lightvela_schedule?.kind === "daily_times") {
    const times = normalizeDailyTimes(job.lightvela_schedule.times);
    return t("每天 {{at}}", { at: times.join("、") });
  }

  if (isScenarioTrialJob(job)) {
    return t("立即开始");
  }

  const display = (job.schedule.display || job.schedule.expr || "").trim();
  const lower = display.toLowerCase();

  // once
  if (lower.startsWith("once")) {
    const d = parseOnceScheduleDate(display, job.next_run_at);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const md = `${yyyy}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return t("单次 {{md}} {{hm}}", { md, hm });
    }
  }

  // interval：every Nm / Nh / Nd
  const intervalMatch = /^every\s+(\d+)\s*([mhd])$/.exec(lower);
  if (intervalMatch) {
    const n = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    const weekdaySuffix = job.effective_window?.weekdays?.length
      ? ` · ${formatWeekdays(job.effective_window.weekdays, t)}`
      : "";
    if (unit === "m") {
      if (n % 1440 === 0) return t("每 {{n}} 天", { n: String(n / 1440) }) + weekdaySuffix;
      if (n % 60 === 0) return t("每 {{n}} 小时", { n: String(n / 60) }) + weekdaySuffix;
      return t("每 {{n}} 分钟", { n: String(n) }) + weekdaySuffix;
    }
    if (unit === "h") return t("每 {{n}} 小时", { n }) + weekdaySuffix;
    if (unit === "d") return t("每 {{n}} 天", { n }) + weekdaySuffix;
  }

  // cron: min hour DOM MON DOW
  const cronMatch = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(display);
  if (cronMatch) {
    const [, mn, hr, dom, mon, dow] = cronMatch;
    const hh = String(hr).padStart(2, "0");
    const mm = String(mn).padStart(2, "0");
    const at = `${hh}:${mm}`;
    if (dom === "*" && mon === "*" && dow === "*") return t("每天 {{at}}", { at });
    if (dom === "*" && mon === "*" && dow !== "*") {
      const weekdays = parseCronWeekdays(dow ?? "");
      if (weekdays.length > 0) {
        return t("每{{w}} {{at}}", { w: formatWeekdays(weekdays, t), at });
      }
    }
    if (mon === "*" && dow === "*") {
      const monthdays = parseCronMonthdays(dom ?? "");
      if (monthdays.length > 0) {
        return t("每月 {{d}} 日 {{at}}", { d: monthdays.join("、"), at });
      }
    }
  }

  return display || job.schedule.expr || "";
}

export function formatScheduleTooltip(
  job: CronJob,
  t: (s: string, vars?: Record<string, unknown>) => string,
): string {
  const scheduleLabel = formatScheduleFriendly(job, t);
  const display = (job.schedule.display || job.schedule.expr || "").trim().toLowerCase();

  if (job.lightvela_schedule?.kind === "daily_times") {
    return `${t("周期")} · ${scheduleLabel}`;
  }

  if (/^every\s+\d+\s*[mhd]$/.test(display)) {
    return `${t("按间隔")} · ${scheduleLabel}`;
  }

  if (/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.test(display)) {
    return `${t("周期")} · ${scheduleLabel}`;
  }

  return scheduleLabel;
}

function formatScheduleDetailValue(
  job: CronJob,
  t: (s: string, vars?: Record<string, unknown>) => string,
): React.ReactNode {
  const display = (job.schedule.display || job.schedule.expr || "").trim().toLowerCase();
  const weekdays = job.effective_window?.weekdays;
  const intervalLabel = formatIntervalScheduleLabel(display, t);

  if (intervalLabel && weekdays?.length) {
    return (
      <div className="space-y-1">
        <div>{`${t("按间隔")} · ${intervalLabel}`}</div>
        <div>{`${t("执行日")}：${formatWeekdays(weekdays, t)}`}</div>
      </div>
    );
  }

  return formatScheduleTooltip(job, t);
}

function formatIntervalScheduleLabel(
  display: string,
  t: (s: string, vars?: Record<string, unknown>) => string,
): string | null {
  const intervalMatch = /^every\s+(\d+)\s*([mhd])$/.exec(display);
  if (!intervalMatch) return null;
  const n = Number(intervalMatch[1]);
  const unit = intervalMatch[2];
  if (unit === "m") {
    if (n % 1440 === 0) return t("每 {{n}} 天", { n: String(n / 1440) });
    if (n % 60 === 0) return t("每 {{n}} 小时", { n: String(n / 60) });
    return t("每 {{n}} 分钟", { n: String(n) });
  }
  if (unit === "h") return t("每 {{n}} 小时", { n });
  if (unit === "d") return t("每 {{n}} 天", { n });
  return null;
}

export function parseOnceScheduleDate(display: string, nextRunAt: string | null): Date {
  if (nextRunAt) {
    const d = parseCronDate(nextRunAt);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const normalized = display
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");
  const onceMatch = /^once\s+at\s+(\d{4})-(\d{1,2})-(\d{1,2})[ tT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/i.exec(normalized);
  if (onceMatch) {
    const [, year, month, day, hour, minute, second] = onceMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      second ? Number(second) : 0,
    );
  }
  return new Date(Number.NaN);
}

function CronJobDetailModal({
  job,
  jobsById,
  lastAgentRun,
  skillLoadState,
  onClose,
}: {
  job: CronJob;
  jobsById: ReadonlyMap<string, CronJob>;
  lastAgentRun: CronRunRecord | null;
  skillLoadState: InstalledSkillLoadState;
  onClose: () => void;
}) {
  const t = useT();
  const { i18n } = useTranslation();
  const paused = isCronJobPaused(job);
  const isOnceJob = isOnceCronJob(job);
  const nextRunAt = getEffectiveWindowStatus(job.effective_window) === "ended" ? null : job.next_run_at;
  const presentation = getScenarioCronJobPresentation(job, getAutomationDisplayLocale(i18n.language));
  const visiblePrompt = getVisibleAutomationPrompt(presentation.prompt);
  const name = presentation.name || t("未命名任务");
  const showEffectiveWindow = !isOnceJob;
  const nextRunLabel = isOnceJob ? "—" : nextRunAt ? formatTime(nextRunAt) : "—";
  const upstreamIds = job.context_from ?? [];
  const upstreamJobs = upstreamIds.map((id) => jobsById.get(id) ?? null);
  return createPortal(
    <div
      className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-lg bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="lv-icon-button absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 pr-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-xl font-semibold text-black/90">{t("定时任务详情")}</h2>
            {paused && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已暂停")}
              </span>
            )}
          </div>
        </div>

        <dl className="overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <NameIdDetailRow name={name} id={job.id} />
          <DetailRow
            label={t("任务类型")}
            value={job.zero_token_config
              ? job.zero_token_config.kind === "fixed_notification"
                ? t("通知任务")
                : t("脚本任务")
              : t("智能任务")}
          />
          {job.zero_token_config ? (
            <>
              <DetailRow
                label={job.zero_token_config.kind === "fixed_notification" ? t("通知内容") : t("脚本语言")}
                value={job.zero_token_config.kind === "fixed_notification"
                  ? job.zero_token_config.content || t("内容仅可在创建它的工具中查看")
                  : job.zero_token_config.language === "bash" ? "Bash" : "Python"}
                pre={job.zero_token_config.kind === "fixed_notification"}
              />
            </>
          ) : (
            <>
              <DetailRow label={t("任务说明")} value={visiblePrompt || "—"} pre />
              <DetailRow
                label={t("调用技能")}
                value={(
                  <AutomationSkillBindingSummary
                    value={job.skills}
                    loadState={skillLoadState}
                  />
                )}
              />
              <DetailRow
                label={t("上游任务")}
                value={upstreamIds.length === 0 ? t("未配置") : (
                  <div className="space-y-2">
                    {upstreamJobs.map((upstream, index) => (
                      <div key={upstreamIds[index]}>
                        {upstream ? <UpstreamCurrentState job={upstream} /> : t("上游任务已不可用")}
                      </div>
                    ))}
                    <p className="text-pretty text-xs text-black/45">
                      {t("本任务执行时，将使用上游任务最近一次的输出作为上下文。")}
                    </p>
                  </div>
                )}
              />
            </>
          )}
          <DetailRow label={t("执行时间")} value={formatScheduleDetailValue(job, t)} />
          {lastAgentRun && (
            <DetailRow
              label={t("上次执行")}
              value={formatLastRun(lastAgentRun.run_at, lastAgentRun.status, t)}
            />
          )}
          <DetailRow label={t("下次执行")} value={nextRunLabel} />
          {showEffectiveWindow && (
            <DetailRow
              label={t("生效时间段")}
              value={formatEffectiveWindowPeriod(job.effective_window, t)}
            />
          )}
          <DeliverDetailRow deliver={job.deliver} />
        </dl>
      </div>
    </div>,
    document.body,
  );
}

function UpstreamCurrentState({ job }: { job: CronJob }) {
  const t = useT();
  const paused = isCronJobPaused(job);
  const latestFailed = isFailedCronStatus(job.last_status);
  return (
    <div className="space-y-1">
      <div>
        <span>{job.name}</span>
        {paused && <span className="ml-1 text-black/45">{t("（已暂停）")}</span>}
      </div>
      <div className="text-xs text-black/45">
        <span>{t("状态")}：{paused ? t("已暂停") : t("正常")}</span>
        <span className="mx-1.5">·</span>
        <span>{t("最近完成时间")}：{job.last_run_at ? formatTime(job.last_run_at) : t("暂无")}</span>
      </div>
      {latestFailed && (
        <p className="text-pretty text-xs text-amber-700">
          {t("最近完成状态为失败，Hermes 不会回退到更早的成功输出")}
        </p>
      )}
      {paused && job.last_run_at && (
        <p className="text-pretty text-xs text-black/55">
          {t("任务已暂停，但仍可能使用最近一次完成输出")}
        </p>
      )}
      {!job.last_run_at && (
        <p className="text-pretty text-xs text-black/55">
          {t("暂无完成记录，下游任务会在无上游上下文的情况下继续执行")}
        </p>
      )}
    </div>
  );
}

function isFailedCronStatus(status: string | null): boolean {
  return ["failed", "failure", "error"].includes((status ?? "").trim().toLowerCase());
}

function DeliverDetailRow({ deliver }: { deliver: string | undefined }) {
  const t = useT();
  const parsed = parseInitialDeliver(deliver || "");
  if (parsed.platforms.length === 0) {
    return (
      <div className="grid gap-2 px-4 py-3 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-start">
        <dt className="text-xs font-medium leading-6 text-black/45">{t("通知方式")}</dt>
        <dd className="break-words text-sm leading-6 text-black/85 sm:text-right">
          <DetailBulletItem>{formatDeliverFallback(deliver || "", t)}</DetailBulletItem>
        </dd>
      </div>
    );
  }

  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-start">
      <dt className="text-xs font-medium leading-6 text-black/45">{t("通知方式")}</dt>
      <dd className="space-y-1.5 break-words text-sm leading-6 text-black/85 sm:text-right">
        {parsed.platforms.map((platform) => {
          const label = getDeliverPlatformLabel(platform, t);
          const chatId = parsed.chatIds[platform];
          return (
            <DetailBulletItem key={platform}>
              {chatId ? t("{{platform}}（Chat ID：{{chatId}}）", { platform: label, chatId }) : label}
            </DetailBulletItem>
          );
        })}
      </dd>
    </div>
  );
}

function DetailBulletItem({ children }: { children: React.ReactNode }) {
  return (
    <div>{children}</div>
  );
}

function formatDeliverFallback(deliver: string, t: ReturnType<typeof useT>): string {
  const trimmed = deliver.trim();
  if (!trimmed || trimmed === "local") return t("不通知，仅写日志");
  if (trimmed === "origin") return t("原对话（创建任务的聊天通道）");
  if (trimmed.startsWith("origin:")) {
    const chatId = trimmed.slice("origin:".length).trim();
    if (chatId) return t("{{platform}}（Chat ID：{{chatId}}）", { platform: t("原对话"), chatId });
    return t("原对话（创建任务的聊天通道）");
  }
  return trimmed;
}

function getDeliverPlatformLabel(platform: string, t: ReturnType<typeof useT>): string {
  if (platform === "qqbot") return "QQ";
  if (platform === "wecom") return t("企业微信");
  if (platform === "dingtalk") return t("钉钉");
  if (platform === "feishu") return t("飞书");
  if (platform === "weixin") return isGlobal ? "WeChat" : t("微信");
  if (platform === "telegram") return "Telegram";
  if (platform === "whatsapp") return "WhatsApp";
  if (platform === "discord") return "Discord";
  if (platform === "slack") return "Slack";
  if (platform === "origin") return t("原对话（创建任务的聊天通道）");
  return platform;
}

function NameIdDetailRow({ name, id }: { name: string; id: string }) {
  const t = useT();
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-start">
      <dt className="text-xs font-medium leading-6 text-black/45">{t("任务名称与ID")}</dt>
      <dd className="min-w-0 text-sm text-black/85 sm:text-right">
        <div className="break-words leading-5">{name}</div>
        <div className="mt-0.5 break-all font-mono text-xs leading-4 text-black/45">{id}</div>
      </dd>
    </div>
  );
}

function DetailRow({ label, value, pre, mono }: { label: string; value: React.ReactNode; pre?: boolean; mono?: boolean }) {
  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[112px_minmax(0,1fr)] sm:items-start">
      <dt className="text-xs font-medium leading-6 text-black/45">{label}</dt>
      <dd
        className={`break-words text-sm leading-6 text-black/85 sm:text-right ${pre ? "whitespace-pre-wrap" : ""} ${mono ? "font-mono" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

function InlineCopyText({ value }: { value: string }) {
  return (
    <code className="mx-1 inline-flex select-all align-baseline rounded-md bg-[#E5E7EB] px-2 py-0.5 font-mono text-[11px] leading-[18px] text-black/80">
      {value}
    </code>
  );
}

function formatCronDependentRemovalError(
  error: unknown,
  target: CronJob,
  dependents: readonly CronDependentBinding[],
  t: ReturnType<typeof useT>,
): string {
  const safeDetails = error instanceof CronCommandError
    ? error.output
    : error instanceof Error
      ? error.message
      : "";
  const affectedIds = new Set<string>();
  for (const match of safeDetails.matchAll(/(?:update_failed|remove_failed|rollback_failed):([^;\s]+)/g)) {
    match[1]?.split(",").filter(Boolean).forEach((id) => affectedIds.add(id));
  }
  const affectedNames = [target, ...dependents]
    .filter((job) => affectedIds.has(job.id))
    .map((job) => job.name || t("未命名任务"));

  if (affectedNames.length === 0) return t("删除失败，请稍后重试。");
  return t("删除失败，请检查以下任务：{{names}}", { names: affectedNames.join("、") });
}

function ConfirmDeleteModal({
  jobName,
  dependents,
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  jobName: string;
  dependents: readonly CronDependentBinding[];
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return createPortal(
    <div
      className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[210] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="relative w-full max-w-[400px] rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-balance text-base font-semibold text-black/90">{t("删除定时任务")}</h3>
        <p className="mt-2 text-pretty text-sm text-black/65">
          {t("确定要删除「{{name}}」吗？此操作无法恢复。", { name: jobName || t("未命名任务") })}
        </p>
        {dependents.length > 0 && (
          <div className="mt-4 rounded-md border border-black/[0.08] bg-black/[0.02] p-3">
            <p className="text-pretty text-xs font-medium text-black/65">{t("受影响的直接下游任务")}</p>
            <ul className="mt-2 space-y-1 text-sm text-black/80">
              {dependents.map((dependent) => <li key={dependent.id}>{dependent.name || t("未命名任务")}</li>)}
            </ul>
            <p className="mt-2 text-pretty text-xs leading-5 text-black/55">
              {t("删除后将解除上游绑定并继续独立执行")}
            </p>
          </div>
        )}
        {error && (
          <p className="mt-3 text-pretty text-xs leading-5 text-[#B91C1C]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-black/10 px-4 py-1.5 font-medium text-black/70 transition hover:bg-black/[0.04] disabled:opacity-40"
            style={MODAL_CONTROL_TEXT_STYLE}
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#B91C1C] px-4 py-1.5 font-medium text-white transition hover:bg-[#991B1B] disabled:opacity-40"
            style={MODAL_CONTROL_TEXT_STYLE}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t("删除")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmCreateOverLimitModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return createPortal(
    <div
      className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[210] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-black/90">{t("定时任务数量提醒")}</h3>
        <p className="mt-2 text-sm leading-relaxed text-black/65">
          {t("当前生效中的定时任务数量已经达到 20 个以上，建议你删除不需要的任务后再继续。")}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-black/10 px-4 py-1.5 text-sm font-medium text-black/70 transition hover:bg-black/[0.04]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-black px-4 py-1.5 text-sm font-medium text-white transition hover:bg-black/85"
          >
            {t("继续新建")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatTime(iso: string): string {
  const d = parseCronDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function parseCronDate(value: string): Date {
  // Hermes may return nanosecond-style fractional seconds; JS Date only needs milliseconds.
  const normalized = value
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\.(\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, ".$1");
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    return new Date(normalized);
  }

  const localMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ tT]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(normalized);
  if (localMatch) {
    const [, year, month, day, hour = "0", minute = "0", second = "0", ms = "0"] = localMatch;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(ms.padEnd(3, "0")),
    );
  }

  return new Date(normalized);
}

function formatLastRun(iso: string, status: string | null, t: ReturnType<typeof useT>): string {
  const friendlyStatus = formatLastStatus(status, t);
  return friendlyStatus ? `${formatTime(iso)} · ${friendlyStatus}` : formatTime(iso);
}

export function getLastAgentRunForJob(job: CronJob, recentRuns: CronRunRecord[]): CronRunRecord | null {
  let latest: CronRunRecord | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const run of recentRuns) {
    if (run.job_id !== job.id) continue;
    const time = parseCronDate(run.run_at).getTime();
    const comparableTime = Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
    if (!latest || comparableTime > latestTime) {
      latest = run;
      latestTime = comparableTime;
    }
  }
  return latest;
}

function formatLastStatus(status: string | null, t: ReturnType<typeof useT>): string {
  const normalized = (status || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("the requested model is not available in your current plan")) {
    return t("执行失败：当前模型暂不可用，请稍后重试或切换模型。");
  }
  if (["ok", "success", "succeeded", "done", "completed"].includes(normalized)) return t("执行成功");
  if (["failed", "failure", "error"].includes(normalized)) return t("执行失败");
  if (normalized === "not_executed") return t("未执行");
  if (["running", "pending"].includes(normalized)) return t("执行中");
  return status || "";
}

type EffectiveWindowStatus = "always" | "pending" | "active" | "ended";

export function normalizeEffectiveWindowInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const isoMatch = /^(\d{4}-\d{2}-\d{2})[ tT](\d{2}:\d{2})/.exec(trimmed);
  if (isoMatch) return `${isoMatch[1]}T${isoMatch[2]}`;
  return trimmed;
}

export function buildEffectiveWindowFromInputs(
  startAt: string,
  endAt: string,
  weekdays?: readonly number[],
): CronEffectiveWindow | null {
  const start = normalizeEffectiveWindowInput(startAt);
  const end = normalizeEffectiveWindowInput(endAt);
  const selectedWeekdays = hasWeekdayFilter(weekdays) ? normalizeIntervalWeekdays(weekdays) : null;
  if (!start && !end && !selectedWeekdays) return null;
  return {
    start_at: start || null,
    end_at: end || null,
    ...(selectedWeekdays ? { weekdays: selectedWeekdays } : {}),
  };
}

export function isEffectiveWindowRangeInvalid(window: CronEffectiveWindow): boolean {
  if (!window.start_at || !window.end_at) return false;
  const start = parseCronDate(window.start_at).getTime();
  const end = parseCronDate(window.end_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return end < start;
}

function areEffectiveWindowsEqual(
  a: CronEffectiveWindow | null,
  b: CronEffectiveWindow | null,
): boolean {
  const aWeekdays = a?.weekdays?.length ? normalizeIntervalWeekdays(a.weekdays) : null;
  const bWeekdays = b?.weekdays?.length ? normalizeIntervalWeekdays(b.weekdays) : null;
  return (a?.start_at ?? null) === (b?.start_at ?? null)
    && (a?.end_at ?? null) === (b?.end_at ?? null)
    && JSON.stringify(aWeekdays) === JSON.stringify(bWeekdays);
}

function isLightVelaEffectiveWindowScriptName(script: string): boolean {
  return /^lightvela-effective-window-[a-z0-9-]+\.py$/.test(script);
}

export function getEffectiveWindowStatus(window: CronEffectiveWindow | null, now = Date.now()): EffectiveWindowStatus {
  if (!window?.start_at && !window?.end_at && !window?.weekdays?.length) return "always";
  const start = window.start_at ? parseCronDate(window.start_at).getTime() : Number.NaN;
  const end = window.end_at ? parseCronDate(window.end_at).getTime() : Number.NaN;
  if (!Number.isNaN(start) && now < start) return "pending";
  if (!Number.isNaN(end) && now > end) return "ended";
  return "active";
}

export function formatEffectiveWindow(
  window: CronEffectiveWindow | null,
  t: ReturnType<typeof useT>,
): string {
  const { dateAndStatusLabel, weekdayLabel } = getEffectiveWindowLabelParts(window, t);
  return [dateAndStatusLabel, weekdayLabel].filter((line): line is string => Boolean(line)).join(" · ");
}

export function formatEffectiveWindowPeriod(
  window: CronEffectiveWindow | null,
  t: ReturnType<typeof useT>,
): string {
  if (!window?.start_at && !window?.end_at && !window?.weekdays?.length) {
    return t("未配置（即始终生效）");
  }
  return getEffectiveWindowLabelParts(window, t).dateAndStatusLabel;
}

export function formatEffectiveWindowTooltipLines(
  window: CronEffectiveWindow | null,
  t: ReturnType<typeof useT>,
): string[] {
  const { dateAndStatusLabel, weekdayLabel } = getEffectiveWindowLabelParts(window, t);
  const effectivePeriodLabel = dateAndStatusLabel === t("始终生效")
    ? dateAndStatusLabel
    : `${t("生效期")}：${dateAndStatusLabel}`;
  return [weekdayLabel, effectivePeriodLabel].filter((line): line is string => Boolean(line));
}

function getEffectiveWindowLabelParts(
  window: CronEffectiveWindow | null,
  t: ReturnType<typeof useT>,
): {
  dateAndStatusLabel: string;
  weekdayLabel: string | null;
} {
  if (!window?.start_at && !window?.end_at && !window?.weekdays?.length) {
    return { dateAndStatusLabel: t("始终生效"), weekdayLabel: null };
  }
  const dateLabel = window.start_at && window.end_at
    ? `${formatEffectiveWindowDate(window.start_at)} - ${formatEffectiveWindowDate(window.end_at)}`
    : window.start_at
      ? formatEffectiveWindowDate(window.start_at)
      : window.end_at
        ? formatEffectiveWindowDate(window.end_at)
        : null;
  const status = getEffectiveWindowStatus(window);
  const statusLabel = status === "pending"
    ? t("未开始")
    : status === "ended"
      ? t("已过生效期")
      : t("生效中");
  const weekdayLabel = window.weekdays?.length
    ? `${t("执行日")}：${formatWeekdays(window.weekdays, t)}`
    : null;
  const dateAndStatusLabel = [dateLabel, statusLabel].filter(Boolean).join(" · ");
  return { dateAndStatusLabel, weekdayLabel };
}

function formatEffectiveWindowDate(value: string): string {
  const d = parseCronDate(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ─── Form Modal ─── */

type FrequencyKind = "recurring" | "interval" | "once";
type RecurringPeriod = "daily" | "weekly" | "monthly";
type IntervalUnit = "m" | "h" | "d";

const WEEKDAY_VALUES = [1, 2, 3, 4, 5, 6, 0] as const;
const MONTHDAY_VALUES = Array.from({ length: 31 }, (_, i) => i + 1);
const MAX_DAILY_TIME_POINTS = 18;
const WEIXIN_MIN_INTERVAL_MINUTES = 150;
const CLOCK_HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const CLOCK_MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
const GLOBAL_NOTIFICATION_CHANNELS = [
  { key: "telegram", label: "Telegram", comingSoon: false },
  { key: "whatsapp", label: "WhatsApp", comingSoon: false },
  { key: "discord", label: "Discord", comingSoon: false },
  { key: "slack", label: "Slack", comingSoon: false },
  { key: "weixin", label: "WeChat", comingSoon: false },
  { key: "qqbot", label: "QQ", comingSoon: false },
  { key: "wecom", labelKey: "企业微信", comingSoon: false },
  { key: "feishu", labelKey: "飞书", comingSoon: false },
] as const;
const DOMESTIC_NOTIFICATION_CHANNELS = [
  { key: "weixin", labelKey: "微信", comingSoon: false },
  { key: "qqbot", label: "QQ", comingSoon: false },
  { key: "wecom", labelKey: "企业微信", comingSoon: false },
  { key: "feishu", labelKey: "飞书", comingSoon: false },
  { key: "dingtalk", labelKey: "钉钉", comingSoon: false },
] as const;

function getWeekdayLabels(t: ReturnType<typeof useT>): Record<number, string> {
  return {
    0: t("周日"),
    1: t("周一"),
    2: t("周二"),
    3: t("周三"),
    4: t("周四"),
    5: t("周五"),
    6: t("周六"),
  };
}

function normalizeWeekdays(values: readonly number[] | undefined): number[] {
  const unique = Array.from(new Set((values ?? []).filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)));
  const sorted = WEEKDAY_VALUES.filter((v) => unique.includes(v));
  return sorted.length > 0 ? sorted : [1];
}

function normalizeIntervalWeekdays(values: readonly number[] | undefined): number[] {
  if (!values || values.length === 0) return [...WEEKDAY_VALUES];
  return normalizeWeekdays(values);
}

function isValidClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function sanitizeClockTimeDraft(value: string): string {
  return value.replace(/[^\d:]/g, "").slice(0, 5);
}

function clampClockPart(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function splitClockTimeDraft(value: string, fallback = "09:00"): { hour: string; minute: string } {
  const fallbackTime = isValidClockTime(fallback) ? fallback : "09:00";
  const [fallbackHour = "09", fallbackMinute = "00"] = fallbackTime.split(":");
  const [rawHour = "", rawMinute = ""] = sanitizeClockTimeDraft(value).split(":");
  const hourNumber = Number(rawHour);
  const minuteNumber = Number(rawMinute);
  return {
    hour: rawHour.length > 0 && Number.isInteger(hourNumber)
      ? String(clampClockPart(hourNumber, 23)).padStart(2, "0")
      : fallbackHour,
    minute: rawMinute.length > 0 && Number.isInteger(minuteNumber)
      ? String(clampClockPart(minuteNumber, 59)).padStart(2, "0")
      : fallbackMinute,
  };
}

function normalizeDailyTimes(values: readonly string[] | undefined, fallback = "09:00"): string[] {
  const source = values && values.length > 0 ? values : [fallback];
  const normalized = Array.from(new Set(
    source
      .map((value) => value.trim())
      .filter(isValidClockTime),
  )).sort((a, b) => a.localeCompare(b));
  if (normalized.length > 0) return normalized.slice(0, MAX_DAILY_TIME_POINTS);
  return isValidClockTime(fallback) ? [fallback] : ["09:00"];
}

export function normalizeDailyTimesForForm(values: readonly string[] | undefined, fallback = "09:00"): string[] {
  const source = values && values.length > 0 ? values : [fallback];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawValue of source) {
    const value = rawValue.trim();
    if (!isValidClockTime(value) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_DAILY_TIME_POINTS) break;
  }
  if (normalized.length > 0) return normalized;
  return isValidClockTime(fallback) ? [fallback] : ["09:00"];
}

export function normalizeDailyTimesForEditing(values: readonly string[] | undefined, fallback = "09:00"): string[] {
  const fallbackTime = isValidClockTime(fallback) ? fallback : "09:00";
  const source = values && values.length > 0 ? values : [fallbackTime];
  return source.slice(0, MAX_DAILY_TIME_POINTS).map((rawValue) => {
    const value = rawValue.trim();
    if (isValidClockTime(value)) return value;
    const { hour, minute } = splitClockTimeDraft(value, fallbackTime);
    return `${hour}:${minute}`;
  });
}

function areDailyTimesEqual(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  const left = a && a.length > 0 ? normalizeDailyTimes(a) : [];
  const right = b && b.length > 0 ? normalizeDailyTimes(b) : [];
  return JSON.stringify(left) === JSON.stringify(right);
}

function getIntervalMinutes(num: number, unit: IntervalUnit): number {
  const safeNum = Math.max(1, Math.floor(num) || 1);
  if (unit === "m") return safeNum;
  if (unit === "h") return safeNum * 60;
  return safeNum * 24 * 60;
}

function hasWeekdayFilter(values: readonly number[] | undefined): boolean {
  const selected = normalizeIntervalWeekdays(values);
  return selected.length !== WEEKDAY_VALUES.length;
}

function parseCronWeekdays(value: string): number[] {
  if (!/^\d+(,\d+)*$/.test(value)) return [];
  // cron 标准里 0 和 7 都代表周日，统一归一为 0
  const days = value.split(",").map((v) => {
    const n = Number(v);
    return n === 7 ? 0 : n;
  });
  if (days.some((v) => !Number.isInteger(v) || v < 0 || v > 6)) return [];
  return normalizeWeekdays(days);
}

function normalizeMonthdays(values: readonly number[] | undefined): number[] {
  const unique = Array.from(new Set((values ?? []).filter((v) => Number.isInteger(v) && v >= 1 && v <= 31)));
  const sorted = unique.sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : [1];
}

function parseCronMonthdays(value: string): number[] {
  if (!/^\d+(,\d+)*$/.test(value)) return [];
  const days = value.split(",").map((v) => Number(v));
  if (days.some((v) => !Number.isInteger(v) || v < 1 || v > 31)) return [];
  return normalizeMonthdays(days);
}

function formatWeekdays(values: readonly number[], t: ReturnType<typeof useT>): string {
  const labels = getWeekdayLabels(t);
  return normalizeWeekdays(values).map((v) => labels[v]).join("、");
}

type AutomationTemplate = AutomationCatalogTemplate;

const AUTOMATION_TEMPLATE_TONES = {
  "daily-summary": {
    icon: BriefcaseBusiness,
    iconClass: "bg-[#F7F4EE] text-[#8A6A2B]",
    accentClass: "border-l-[#D8C7A3] hover:border-[#D8C7A3]",
  },
  "water-break": {
    icon: Droplets,
    iconClass: "bg-[#EEF6F8] text-[#3F7A8A]",
    accentClass: "border-l-[#B7D5DD] hover:border-[#B7D5DD]",
  },
  "morning-start": {
    icon: Sunrise,
    iconClass: "bg-[#F8F1ED] text-[#9A604A]",
    accentClass: "border-l-[#D7B6A8] hover:border-[#D7B6A8]",
  },
  "weekly-review": {
    icon: BellRing,
    iconClass: "bg-[#F2F0F7] text-[#6A5B8C]",
    accentClass: "border-l-[#C5BDD8] hover:border-[#C5BDD8]",
  },
  "task-tidy": {
    icon: FolderKanban,
    iconClass: "bg-[#EFF7F2] text-[#4A7A5F]",
    accentClass: "border-l-[#BBD8C6] hover:border-[#BBD8C6]",
  },
  stretch: {
    icon: Activity,
    iconClass: "bg-[#F7F4E8] text-[#7D6A2A]",
    accentClass: "border-l-[#D6C98E] hover:border-[#D6C98E]",
  },
  "stock-watch": {
    icon: TrendingUp,
    iconClass: "bg-[#F8EEF0] text-[#8E4D58]",
    accentClass: "border-l-[#D4B0B6] hover:border-[#D4B0B6]",
  },
  "news-digest": {
    icon: Newspaper,
    iconClass: "bg-[#EEF2F8] text-[#556F9A]",
    accentClass: "border-l-[#BAC8DF] hover:border-[#BAC8DF]",
  },
  "medication-once": {
    icon: Pill,
    iconClass: "bg-[#EEF6F8] text-[#3F7A8A]",
    accentClass: "border-l-[#B7D5DD] hover:border-[#B7D5DD]",
  },
  "rent-reminder": {
    icon: CreditCard,
    iconClass: "bg-[#F7F4EE] text-[#8A6A2B]",
    accentClass: "border-l-[#D8C7A3] hover:border-[#D8C7A3]",
  },
  "country-fx-alert": {
    icon: ArrowLeftRight,
    iconClass: "bg-[#EFF4F7] text-[#55708A]",
    accentClass: "border-l-[#BACBDD] hover:border-[#BACBDD]",
  },
  "calorie-fitness-checkin": {
    icon: Activity,
    iconClass: "bg-[#EFF7F2] text-[#4A7A5F]",
    accentClass: "border-l-[#BBD8C6] hover:border-[#BBD8C6]",
  },
  "global-holiday-reminder": {
    icon: CalendarDays,
    iconClass: "bg-[#F7F4E8] text-[#7D6A2A]",
    accentClass: "border-l-[#D6C98E] hover:border-[#D6C98E]",
  },
  "stock-info-digest": {
    icon: Wallet,
    iconClass: "bg-[#F8EEF0] text-[#8E4D58]",
    accentClass: "border-l-[#D4B0B6] hover:border-[#D4B0B6]",
  },
} satisfies Record<string, {
  icon: typeof Clock;
  iconClass: string;
  accentClass: string;
}>;

function getAutomationTemplates(t: ReturnType<typeof useT>): AutomationTemplateInput[] {
  return [
    {
      id: "daily-summary",
      name: t("每日工作小结"),
      description: t("每天晚上回顾工作进展，整理明天优先级"),
      prompt: t("请帮我回顾今天的工作进展，整理已完成事项、遗留问题，并列出明天优先处理的 3 件事。"),
      schedule: { kind: "recurring", period: "daily", time: "21:30" },
    },
    {
      id: "water-break",
      name: t("喝水休息提醒"),
      description: t("每隔一段时间提醒补水和短暂休息"),
      prompt: t("提醒我喝水，并用一句轻松的话鼓励我保持状态。"),
      schedule: { kind: "interval", intervalNum: 1, intervalUnit: "h" },
    },
    {
      id: "morning-start",
      name: t("起床提醒"),
      description: t("每天早上给一个温和的启动提醒"),
      prompt: t("提醒我起床，简单说一下今天可以先做的一件小事。"),
      schedule: { kind: "recurring", period: "daily", time: "07:30" },
    },
    {
      id: "weekly-review",
      name: t("周五工作复盘"),
      description: t("每周五下班前回顾本周事项"),
      prompt: t("帮我复盘本周工作：整理已完成事项、遗留问题、下周建议，并列出需要继续跟进的任务。"),
      schedule: { kind: "recurring", period: "weekly", weekday: 5, time: "18:00" },
    },
    {
      id: "task-tidy",
      name: t("每日待办整理"),
      description: t("每天提醒整理待办、文档和消息"),
      prompt: t("提醒我整理今天的待办、文档和消息，归纳需要跟进的事项，并按优先级列出下一步行动。"),
      schedule: { kind: "recurring", period: "daily", time: "10:00" },
    },
    {
      id: "stretch",
      name: t("久坐活动提醒"),
      description: t("定时提醒站起来活动，放松肩颈和眼睛"),
      prompt: t("提醒我不要久坐，站起来活动一下，放松肩颈和眼睛。"),
      schedule: { kind: "interval", intervalNum: 1, intervalUnit: "h" },
    },
    {
      id: "stock-watch",
      name: t("股票盯盘"),
      description: t("交易时段定时关注自选股行情变化"),
      prompt: t("提醒我关注自选股行情变化，整理涨跌幅、成交量和需要留意的市场消息。"),
      schedule: { kind: "recurring", period: "daily", time: "10:00" },
    },
    {
      id: "news-digest",
      name: t("每日 AI 资讯摘要"),
      description: t("每天整理 AI 领域的重要动态和关键进展"),
      prompt: t("提醒我查看今天的 AI 资讯，整理 3 条值得关注的动态，并简要说明影响。"),
      schedule: { kind: "recurring", period: "daily", time: "08:30" },
    },
  ];
}

const SCENARIO_TEMPLATE_FALLBACK_TEMPLATE_IDS: Record<string, string> = {
  "medication-once": "water-break",
  "stock-info-digest": "stock-watch",
};

const SCENARIO_TEMPLATE_PROMPT_VALUE_OVERRIDES: Record<string, Partial<Record<AutomationDisplayLocale, Record<string, string>>>> = {
  "rent-reminder": {
    "zh-CN": {
      rentInfo: "房租 2000 元，物业费 800 元，付给房东/物业，通过银行转账",
    },
    "zh-SG": {
      rentInfo: "房租 2000 元，物业费 800 元，付给房东/物业，通过银行转账",
    },
    "zh-Hant": {
      rentInfo: "房租 2000 元，物业费 800 元，付给房东/物业，通过银行转账",
    },
    "en-US": {
      rentInfo: "rent of 2,000 CNY plus an 800 CNY property-management fee, paid to my landlord or property manager by bank transfer",
    },
    es: {
      rentInfo: "alquiler de 2000 CNY y cuota de comunidad de 800 CNY, pagados al casero o a la administración por transferencia bancaria",
    },
    "id-ID": {
      rentInfo: "sewa 2.000 CNY ditambah biaya pengelolaan properti 800 CNY, dibayar ke pemilik atau pengelola properti melalui transfer bank",
    },
  },
  "country-fx-alert": {
    "zh-CN": {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
    "zh-SG": {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
    "zh-Hant": {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
    "en-US": {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
    es: {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
    "id-ID": {
      fromCurrency: "USD",
      toCurrency: "CNY",
    },
  },
  "calorie-fitness-checkin": {
    "zh-CN": {
      bodyProfile: "168cm，62kg，目标 58kg，每周力量训练 3 次",
    },
    "zh-SG": {
      bodyProfile: "168cm，62kg，目标 58kg，每周力量训练 3 次",
    },
    "zh-Hant": {
      bodyProfile: "168cm，62kg，目标 58kg，每周力量训练 3 次",
    },
    "en-US": {
      bodyProfile: "168 cm, 62 kg, target 58 kg, strength training 3 times per week",
    },
    es: {
      bodyProfile: "168 cm, 62 kg, objetivo 58 kg, entrenamiento de fuerza 3 veces por semana",
    },
    "id-ID": {
      bodyProfile: "168 cm, 62 kg, target 58 kg, latihan kekuatan 3 kali per minggu",
    },
  },
};

const SCENARIO_TEMPLATE_PROMPT_FIELD_KEYS: Record<string, string[]> = {
  "medication-once": ["medicine", "customRequest"],
  "rent-reminder": ["rentInfo", "advanceDays", "includeDueDay"],
  "country-fx-alert": ["fromCurrency", "toCurrency", "thresholdMode", "thresholdValue", "customRequest"],
  "calorie-fitness-checkin": ["fitnessGoal", "bodyProfile", "foodLog", "reportStyle"],
  "global-holiday-reminder": ["holidayCountries", "holidayScope", "reminderWindow", "holidayWeatherPlan"],
  "stock-info-digest": ["stockList", "stockFocus", "customRequest"],
};

const SCENARIO_TEMPLATE_PROMPT_LABELS: Record<AutomationDisplayLocale, {
  config: string;
  yes: string;
  no: string;
}> = {
  "zh-CN": {
    config: "例子可删可改，写了新的就以新的为准",
    yes: "是",
    no: "否",
  },
  "zh-SG": {
    config: "例子可删可改，写了新的就以新的为准",
    yes: "是",
    no: "否",
  },
  "zh-Hant": {
    config: "例子可刪可改，寫了新的就以新的為準",
    yes: "是",
    no: "否",
  },
  "en-US": {
    config: "This example can be deleted or edited; if I write new details, use the new ones",
    yes: "yes",
    no: "no",
  },
  es: {
    config: "Este ejemplo se puede borrar o editar; si escribo detalles nuevos, usa los nuevos",
    yes: "sí",
    no: "no",
  },
  "ja-JP": {
    config: "この例は削除または編集できます。新しい内容を書いたら、それを優先してください",
    yes: "はい",
    no: "いいえ",
  },
  "ko-KR": {
    config: "이 예시는 삭제하거나 수정할 수 있습니다. 새 내용을 쓰면 새 내용을 기준으로 해 주세요",
    yes: "예",
    no: "아니요",
  },
  "id-ID": {
    config: "Contoh ini boleh dihapus atau diubah; jika saya menulis detail baru, pakai yang baru",
    yes: "ya",
    no: "tidak",
  },
};

const SCENARIO_TEMPLATE_NATURAL_PROMPTS: Record<string, Partial<Record<AutomationDisplayLocale, string[]>>> = {
  "medication-once": {
    "zh-CN": ["请提醒我喝水，并按医嘱服用常用药。"],
    "zh-SG": ["请提醒我喝水，并按医嘱服用常用药。"],
    "zh-Hant": ["請提醒我喝水，並按醫囑服用常用藥。"],
    "en-US": ["Remind me to drink water and take my regular medication exactly as prescribed."],
    es: ["Recuérdame beber agua y tomar mi medicación habitual según la receta."],
    "id-ID": ["Ingatkan saya minum air dan obat rutin sesuai resep."],
  },
  "rent-reminder": {
    "zh-CN": ["请在账期临近时提醒我支付房租 2000 元和物业费 800 元。"],
    "zh-SG": ["请在账期临近时提醒我支付房租 2000 元和物业费 800 元。"],
    "zh-Hant": ["請在帳期臨近時提醒我支付房租 2000 元和物業費 800 元。"],
    "en-US": ["Remind me when rent of CNY 2,000 and a CNY 800 property fee are due."],
    es: ["Recuérdame pagar 2000 CNY de alquiler y 800 CNY de comunidad cuando se acerque la fecha."],
    "id-ID": ["Ingatkan saya saat sewa CNY 2.000 dan biaya pengelolaan CNY 800 mendekati jatuh tempo."],
  },
  "country-fx-alert": {
    "zh-CN": ["请关注 USD/CNY，较前一日涨跌达到 1% 时提醒我。"],
    "zh-SG": ["请关注 USD/CNY，较前一日涨跌达到 1% 时提醒我。"],
    "zh-Hant": ["請關注 USD/CNY，較前一日漲跌達到 1% 時提醒我。"],
    "en-US": ["Watch USD/CNY and alert me when it moves 1% from the previous day."],
    es: ["Vigila USD/CNY y avísame cuando cambie un 1 % frente al día anterior."],
    "id-ID": ["Pantau USD/CNY dan beri tahu saat berubah 1% dari hari sebelumnya."],
  },
  "calorie-fitness-checkin": {
    "zh-CN": ["请记录今天的饮食、运动和体重；目标减脂并保持力量训练，168cm、62kg、目标 58kg。"],
    "zh-SG": ["请记录今天的饮食、运动和体重；目标减脂并保持力量训练，168cm、62kg、目标 58kg。"],
    "zh-Hant": ["請記錄今天的飲食、運動和體重；目標減脂並保持力量訓練，168cm、62kg、目標 58kg。"],
    "en-US": ["Track today's food, exercise, and weight for a 58 kg fat-loss goal while keeping strength training."],
    es: ["Registra la comida, el ejercicio y el peso de hoy para llegar a 58 kg manteniendo la fuerza."],
    "id-ID": ["Catat makanan, olahraga, dan berat hari ini untuk target 58 kg sambil menjaga latihan kekuatan."],
  },
  "global-holiday-reminder": {
    "zh-CN": ["请关注泰国、印尼的公共假期和天气预警，旅行、发货或会议前提醒我。"],
    "zh-SG": ["请关注泰国、印尼的公共假期和天气预警，旅行、发货或会议前提醒我。"],
    "zh-Hant": ["請關注泰國、印尼的公共假期和天氣預警，旅行、發貨或會議前提醒我。"],
    "en-US": ["Watch holidays and weather alerts in Thailand and Indonesia before travel, shipping, or meetings."],
    es: ["Vigila festivos y alertas del tiempo en Tailandia e Indonesia antes de viajes, envíos o reuniones."],
    "id-ID": ["Pantau hari libur dan peringatan cuaca di Thailand dan Indonesia sebelum perjalanan, pengiriman, atau rapat."],
  },
  "stock-info-digest": {
    "zh-CN": ["请整理腾讯控股 00700、NVIDIA NVDA 和贵州茅台 600519 的价格、公告及财报动态。"],
    "zh-SG": ["请整理腾讯控股 00700、NVIDIA NVDA 和贵州茅台 600519 的价格、公告及财报动态。"],
    "zh-Hant": ["請整理騰訊控股 00700、NVIDIA NVDA 和貴州茅台 600519 的價格、公告及財報動態。"],
    "en-US": ["Summarize price, announcement, and earnings updates for Tencent 00700, NVIDIA NVDA, and Kweichow Moutai 600519."],
    es: ["Resume precios, anuncios y resultados de Tencent 00700, NVIDIA NVDA y Kweichow Moutai 600519."],
    "id-ID": ["Rangkum harga, pengumuman, dan laporan keuangan Tencent 00700, NVIDIA NVDA, dan Kweichow Moutai 600519."],
  },
};

function getScenarioDefaultValues(pack: ScenarioTaskPack): Record<string, string> {
  return Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue]));
}

function getScenarioTemplatePromptValues(
  pack: ScenarioTaskPack,
  displayLocale: AutomationDisplayLocale,
): Record<string, string> {
  return {
    ...getScenarioDefaultValues(pack),
    ...(SCENARIO_TEMPLATE_PROMPT_VALUE_OVERRIDES[pack.id]?.[displayLocale] ?? {}),
  };
}

function splitScenarioTemplateTimes(value: string): string[] {
  return value
    .split(/[|,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getScenarioTemplateSchedule(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  fallback?: AutomationTemplateInput,
): AutomationTemplate["schedule"] {
  const parsed = parseInitialSchedule(pack.defaultSchedule);
  if (parsed?.kind === "recurring" && parsed.period === "daily" && pack.dailyTimesFieldKey) {
    const times = normalizeDailyTimes(splitScenarioTemplateTimes(values[pack.dailyTimesFieldKey] ?? ""), parsed.time ?? "09:00");
    return { kind: "recurring", period: "daily", time: times[0], times };
  }
  if (parsed) return parsed;
  return fallback?.schedule ?? { kind: "recurring", period: "daily", time: "09:00" };
}

function isScenarioTemplateScheduleField(pack: ScenarioTaskPack, field: ScenarioTaskPack["fields"][number]): boolean {
  return field.type === "time"
    || field.type === "times"
    || field.key === pack.dailyTimesFieldKey
    || field.key === pack.oneShotScheduleFieldKey;
}

function formatScenarioTemplateFieldValue(
  field: ScenarioTaskPack["fields"][number],
  value: string,
  displayLocale: AutomationDisplayLocale,
): string {
  if (field.type === "checkbox") {
    return value === "true"
      ? SCENARIO_TEMPLATE_PROMPT_LABELS[displayLocale].yes
      : SCENARIO_TEMPLATE_PROMPT_LABELS[displayLocale].no;
  }
  if (field.type === "multi-dropdown" || field.type === "multiselect") {
    const optionLabelByValue = new Map((field.options ?? []).map((option) => [option.value, option.label]));
    return value
      .split(SCENARIO_MULTISELECT_SEPARATOR)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => optionLabelByValue.get(item) ?? item)
      .join(" / ");
  }
  const selectedOption = field.options?.find((option) => option.value === value);
  return selectedOption?.label ?? value;
}

function getScenarioTemplatePromptFields(pack: ScenarioTaskPack): Array<ScenarioTaskPack["fields"][number]> {
  const fieldByKey = new Map(pack.fields.map((field) => [field.key, field]));
  const configuredFields = (SCENARIO_TEMPLATE_PROMPT_FIELD_KEYS[pack.id] ?? [])
    .map((key) => fieldByKey.get(key))
    .filter((field): field is ScenarioTaskPack["fields"][number] => Boolean(field));
  if (configuredFields.length) return configuredFields;
  return pack.fields.filter((field) => !isScenarioTemplateScheduleField(pack, field)).slice(0, 4);
}

function buildScenarioTemplateConfigLine(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  displayLocale: AutomationDisplayLocale,
): string {
  const labels = SCENARIO_TEMPLATE_PROMPT_LABELS[displayLocale];
  const items = getScenarioTemplatePromptFields(pack)
    .filter((field) => !isScenarioTemplateScheduleField(pack, field))
    .map((field) => {
      const rawValue = values[field.key]?.trim() || field.defaultValue.trim();
      if (!rawValue) return "";
      return `${field.label}: ${formatScenarioTemplateFieldValue(field, rawValue, displayLocale)}.`;
    })
    .filter(Boolean);
  return items.length ? `${labels.config}: ${items.join(" ")}` : "";
}

function getScenarioTemplatePrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  displayLocale: AutomationDisplayLocale,
  fallback?: AutomationTemplateInput,
): string {
  const naturalPrompt = SCENARIO_TEMPLATE_NATURAL_PROMPTS[pack.id]?.[displayLocale];
  if (naturalPrompt?.length) {
    const prompt = naturalPrompt.join("\n");
    return prompt.length > AUTOMATION_PROMPT_MAX_LENGTH
      ? prompt.slice(0, AUTOMATION_PROMPT_MAX_LENGTH)
      : prompt;
  }

  const prompt = [
    pack.quickPrompt.trim() || fallback?.prompt.trim(),
    buildScenarioTemplateConfigLine(pack, values, displayLocale),
  ].filter(Boolean).join("\n");
  return prompt.length > AUTOMATION_PROMPT_MAX_LENGTH
    ? prompt.slice(0, AUTOMATION_PROMPT_MAX_LENGTH)
    : prompt;
}

function scenarioPackToAutomationTemplate(
  pack: ScenarioTaskPack,
  displayLocale: AutomationDisplayLocale,
  fallback?: AutomationTemplateInput,
): AutomationTemplateInput {
  const values = getScenarioTemplatePromptValues(pack, displayLocale);
  return {
    id: pack.id,
    name: pack.name,
    description: pack.valueProp || fallback?.description || pack.description,
    prompt: getScenarioTemplatePrompt(pack, values, displayLocale, fallback),
    schedule: getScenarioTemplateSchedule(pack, values, fallback),
    skills: pack.skillIds,
  };
}

export function getUnifiedAutomationTemplates(
  t: ReturnType<typeof useT>,
  displayLocale: AutomationDisplayLocale = DEFAULT_LOCALE,
): AutomationTemplate[] {
  const legacyTemplates = getAutomationTemplates(t);
  const legacyById = new Map(legacyTemplates.map((template) => [template.id, template]));
  const usedLegacyIds = new Set<string>();
  const scenarioTemplates = getOverviewScenarioTaskPacks(displayLocale).map((pack) => {
    const fallbackId = SCENARIO_TEMPLATE_FALLBACK_TEMPLATE_IDS[pack.id];
    if (fallbackId) usedLegacyIds.add(fallbackId);
    return scenarioPackToAutomationTemplate(pack, displayLocale, fallbackId ? legacyById.get(fallbackId) : undefined);
  });
  return enrichLightVelaAutomationTemplates([
    ...scenarioTemplates,
    ...legacyTemplates.filter((template) => !usedLegacyIds.has(template.id)),
  ], displayLocale);
}

interface ScheduleChangeCheck {
  mode: "create" | "edit";
  scheduleUneditable: boolean;
  kind: FrequencyKind;
  onceDate: string;
  initialOnceDate?: string;
  schedule: string;
  originalSchedule: string;
}

export function AutomationFormModal({
  botId,
  mode,
  initialJob,
  template,
  jobs,
  contextCapability,
  onRetryContextCapability,
  enabledChannels,
  channelStatus,
  skillLoadState,
  onRefreshSkills,
  onRefreshJobs,
  testState,
  onTestRun,
  onClose,
  onSaved,
  onError,
}: {
  botId: HermesCronTarget;
  mode: "create" | "edit";
  initialJob?: CronJob;
  template?: AutomationTemplate;
  jobs: CronJob[];
  contextCapability: "loading" | CronContextCapability;
  onRetryContextCapability: () => void;
  enabledChannels: Set<string> | null;
  channelStatus: "loading" | "ready";
  skillLoadState: InstalledSkillLoadState;
  onRefreshSkills: () => Promise<InstalledSkillLoadState>;
  onRefreshJobs: () => Promise<CronJob[] | null>;
  testState: AutomationTestState;
  onTestRun: (job: CronJob) => void;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const runtimeBotId = typeof botId === "string" ? botId : botId.instanceId;
  const zeroTokenAutomationsEnabled = useZeroTokenAutomationsEnabled();
  const testRunHintId = useId();
  const notificationHelpTooltip = useHoverTooltipPosition<HTMLButtonElement>();
  const templateSchedule = mode === "create" ? template?.schedule : undefined;
  const initialPromptParts = splitAutomationExecutionPrompt(initialJob?.prompt ?? template?.prompt ?? "");
  const executionRules = mode === "create" ? template?.executionRules : initialPromptParts.executionRules;
  const promptMaxLength = getAutomationVisiblePromptMaxLength(executionRules);
  const [name, setName] = useState(initialJob?.name ?? template?.name ?? "");
  const [prompt, setPrompt] = useState(initialPromptParts.visiblePrompt);
  const initialIsZeroToken = initialJob?.inference_config?.no_agent === true
    || Boolean(initialJob?.zero_token_config);
  const [executionMode, setExecutionMode] = useState<"agent" | "zero_token">(
    initialIsZeroToken ? "zero_token" : "agent",
  );
  const [zeroTokenKind, setZeroTokenKind] = useState<CronZeroTokenKind>(
    initialJob?.zero_token_config?.kind ?? "fixed_notification",
  );
  const selectedCreateTaskKind: CreateTaskKind = executionMode === "agent"
    ? "agent"
    : zeroTokenKind;
  const [scriptLanguage, setScriptLanguage] = useState<CronScriptLanguage>(
    initialJob?.zero_token_config?.language ?? "python",
  );
  const [zeroTokenContent, setZeroTokenContent] = useState(
    initialJob?.zero_token_config?.content ?? "",
  );
  const [scriptSafetyConfirmed, setScriptSafetyConfirmed] = useState(false);
  const canSelectZeroToken = mode === "create" && !template && zeroTokenAutomationsEnabled;
  const zeroTokenScriptEditable = mode === "create" || initialJob?.zero_token_config?.editable === true;
  const initialContextFrom = initialJob?.context_from ?? null;
  const initialSelectedUpstream = initialContextFrom?.[0] ?? "";
  const [selectedUpstream, setSelectedUpstream] = useState(initialSelectedUpstream);
  const [upstreamChanged, setUpstreamChanged] = useState(false);
  const [upstreamError, setUpstreamError] = useState<string | null>(null);
  const initialSelectedSkills = initialJob?.skills ?? (
    skillLoadState.status === "ready"
      ? (template?.skills ?? []).filter((slug) => skillLoadState.slugs.includes(slug))
      : []
  );
  const [selectedSkills, setSelectedSkills] = useState(initialSelectedSkills);
  const templateSkillsHydratedRef = useRef(
    mode !== "create" || !template || skillLoadState.status === "ready",
  );

  useEffect(() => {
    if (templateSkillsHydratedRef.current || skillLoadState.status !== "ready") return;
    templateSkillsHydratedRef.current = true;
    const installedTemplateSkills = (template?.skills ?? [])
      .filter((slug) => skillLoadState.slugs.includes(slug));
    if (installedTemplateSkills.length === 0) return;
    setSelectedSkills((current) => [...new Set([...current, ...installedTemplateSkills])]);
  }, [skillLoadState, template]);

  const initialScheduleSource = useMemo(
    () => (initialJob?.schedule.display || initialJob?.schedule.expr || "").trim(),
    [initialJob],
  );
  const originalSchedule = useMemo(
    () => (initialJob?.schedule.expr || initialJob?.schedule.display || "").trim(),
    [initialJob],
  );
  const initial = useMemo(() => {
    if (initialJob?.lightvela_schedule?.kind === "daily_times") {
      const times = normalizeDailyTimes(initialJob.lightvela_schedule.times);
      return { kind: "recurring" as const, period: "daily" as const, time: times[0], times };
    }
    return parseInitialSchedule(initialScheduleSource);
  }, [initialJob, initialScheduleSource]);
  const scheduleUneditable = mode === "edit" && !!initialJob && initial === null && initialScheduleSource.length > 0;
  const defaultScheduleDate = useMemo(() => new Date(Date.now() + 2 * 60_000), []);
  const defaultTime = useMemo(() => {
    const d = defaultScheduleDate;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, [defaultScheduleDate]);
  const [kind, setKind] = useState<FrequencyKind>(initial?.kind ?? templateSchedule?.kind ?? "once");
  // 周期态
  const [period, setPeriod] = useState<RecurringPeriod>(initial?.period ?? templateSchedule?.period ?? "daily");
  const [time, setTime] = useState(() => {
    if (initial?.time) return initial.time;
    if (templateSchedule?.time) return templateSchedule.time;
    return defaultTime;
  });
  const [dailyTimes, setDailyTimes] = useState(() => normalizeDailyTimes(
    initial?.times ?? templateSchedule?.times,
    initial?.time ?? templateSchedule?.time ?? defaultTime,
  ));
  const [weekdays, setWeekdays] = useState(() => normalizeWeekdays(
    initial?.weekdays
    ?? templateSchedule?.weekdays
    ?? [initial?.weekday ?? templateSchedule?.weekday ?? 1],
  ));
  const [monthdays, setMonthdays] = useState(() => normalizeMonthdays(
    initial?.monthdays
    ?? templateSchedule?.monthdays
    ?? [initial?.monthday ?? templateSchedule?.monthday ?? 1],
  ));
  // 按间隔态
  const [intervalNum, setIntervalNum] = useState(initial?.intervalNum ?? templateSchedule?.intervalNum ?? 1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initial?.intervalUnit ?? templateSchedule?.intervalUnit ?? "h");
  const [intervalWeekdays, setIntervalWeekdays] = useState(() => normalizeIntervalWeekdays(initialJob?.effective_window?.weekdays ?? WEEKDAY_VALUES));
  // 单次态
  const [onceDate, setOnceDate] = useState(() => {
    if (initial?.onceDate) return initial.onceDate;
    // datetime-local 期望 "YYYY-MM-DDTHH:MM" 本地时间字符串。
    // 默认取打开弹窗时的两分钟后（与「周期」默认值一致）；submit 时才校验是否过期。
    const d = defaultScheduleDate;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  /** 通知方式多选：空数组 = 仅本地（不通知）；含值 = 该平台都推（home channel） */
  const initialDeliver = useMemo(
    () => parseInitialDeliver(initialJob?.deliver || template?.deliver || ""),
    [initialJob, template?.deliver],
  );
  const [deliverPlatforms, setDeliverPlatforms] = useState<string[]>(initialDeliver.platforms);
  /** 每个 platform 的可选 chat_id：填了 → 拼 `<platform>:<id>` 直送；留空 → 走 home */
  const [deliverChatIds, setDeliverChatIds] = useState<Record<string, string>>(initialDeliver.chatIds);
  const [effectiveStartAt, setEffectiveStartAt] = useState(() => normalizeEffectiveWindowInput(initialJob?.effective_window?.start_at ?? ""));
  const [effectiveEndAt, setEffectiveEndAt] = useState(() => normalizeEffectiveWindowInput(initialJob?.effective_window?.end_at ?? ""));
  const [effectiveWindowEnabled, setEffectiveWindowEnabled] = useState(() => Boolean(initialJob?.effective_window?.start_at || initialJob?.effective_window?.end_at));
  const canEditEffectiveWindow = !initialJob?.script
    || isLightVelaEffectiveWindowScriptName(initialJob.script)
    || initialJob.zero_token_config?.managed === true;
  const shouldShowEffectiveWindow = kind !== "once";
  const [chatIdErrors, setChatIdErrors] = useState<Record<string, string>>({});
  const [testSendResults, setTestSendResults] = useState<Record<string, { status: "sending" }>>({});
  const [testSendToast, setTestSendToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const testSendToastTimerRef = useRef<number | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const eligibleUpstreams = useMemo(
    () => getEligibleCronUpstreams(jobs, initialJob?.id ?? null, Date.now()),
    [initialJob?.id, jobs],
  );
  const pickerUpstreams = useMemo(() => {
    const optionsById = new Map(eligibleUpstreams.map((job) => [job.id, job]));
    for (const upstreamId of initialContextFrom ?? []) {
      const existing = jobs.find((job) => job.id === upstreamId);
      if (existing) optionsById.set(existing.id, existing);
    }
    return [...optionsById.values()];
  }, [eligibleUpstreams, initialContextFrom, jobs]);
  const externalMultipleUpstreams = useMemo(
    () => (initialContextFrom?.length ?? 0) > 1
      ? initialContextFrom!.map((id) => jobs.find((job) => job.id === id) ?? null)
      : null,
    [initialContextFrom, jobs],
  );

  const showTestSendToast = useCallback((tone: "success" | "error", message: string) => {
    if (testSendToastTimerRef.current) {
      window.clearTimeout(testSendToastTimerRef.current);
    }
    setTestSendToast({ tone, message });
    testSendToastTimerRef.current = window.setTimeout(() => {
      setTestSendToast(null);
      testSendToastTimerRef.current = null;
    }, 5000);
  }, []);

  useEffect(() => () => {
    if (testSendToastTimerRef.current) window.clearTimeout(testSendToastTimerRef.current);
  }, []);

  const normalizedDailyTimes = useMemo(() => normalizeDailyTimes(dailyTimes, time), [dailyTimes, time]);
  const dailyTimesForScript = kind === "recurring" && period === "daily" && normalizedDailyTimes.length > 1
    ? normalizedDailyTimes
    : null;
  const intervalMinutes = useMemo(() => getIntervalMinutes(intervalNum, intervalUnit), [intervalNum, intervalUnit]);
  const weixinBlockedByFrequency = kind === "interval"
    && intervalMinutes < WEIXIN_MIN_INTERVAL_MINUTES
    && isHermesNotificationChannelConfigured(enabledChannels, "weixin");
  const availableNotificationChannels = (isGlobal
    ? GLOBAL_NOTIFICATION_CHANNELS
    : DOMESTIC_NOTIFICATION_CHANNELS
  ).map((channel) => ({
    key: channel.key,
    label: "label" in channel ? channel.label : t(channel.labelKey),
    comingSoon: channel.comingSoon,
  })).filter(({ key, comingSoon }) => (
    isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon)
  ));
  const hasAvailableNotificationChannel = availableNotificationChannels.length > 0;

  useEffect(() => {
    if (!weixinBlockedByFrequency) return;
    setDeliverPlatforms((prev) => prev.includes("weixin") ? prev.filter((platform) => platform !== "weixin") : prev);
    setDeliverChatIds((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, "weixin")) return prev;
      const { weixin: _removed, ...rest } = prev;
      return rest;
    });
  }, [weixinBlockedByFrequency]);

  useEffect(() => {
    if (channelStatus !== "ready") return;
    setDeliverPlatforms((prev) => (
      prev.filter((platform) => isHermesNotificationChannelConfigured(enabledChannels, platform))
    ));
  }, [channelStatus, enabledChannels]);

  const schedule = useMemo(() => buildScheduleString({
    kind,
    period,
    time: dailyTimesForScript ? normalizedDailyTimes[0] ?? time : time,
    dailyTimes: dailyTimesForScript ?? undefined,
    weekdays,
    monthdays,
    intervalNum,
    intervalUnit,
    onceDate,
  }), [kind, period, dailyTimesForScript, normalizedDailyTimes, time, weekdays, monthdays, intervalNum, intervalUnit, onceDate]);
  const scheduleChanged = useMemo(() => isScheduleEffectivelyChanged({
    mode,
    scheduleUneditable,
    kind,
    onceDate,
    initialOnceDate: initial?.onceDate,
    schedule,
    originalSchedule,
  }), [mode, scheduleUneditable, kind, onceDate, initial?.onceDate, schedule, originalSchedule]);
  const taskContentReady = executionMode === "agent"
    ? prompt.trim().length > 0 || (mode === "edit" && !(initialJob?.prompt ?? "").trim())
    : zeroTokenScriptEditable
      ? zeroTokenContent.trim().length > 0
      : Boolean(initialJob?.script);
  const testContentReady = executionMode === "agent"
    ? prompt.trim().length > 0
    : taskContentReady;
  const scriptSafetyReady = executionMode !== "zero_token"
    || zeroTokenKind !== "script"
    || !zeroTokenScriptEditable
    || scriptSafetyConfirmed;
  const canSubmit = !submitting
    && name.trim().length > 0
    && taskContentReady
    && scriptSafetyReady
    && (scheduleUneditable || schedule.length > 0);
  const canTestRun = !submitting
    && testState !== "running"
    && name.trim().length > 0
    && testContentReady
    && scriptSafetyReady;
  const testRunDisabledReason = !name.trim() || !testContentReady
    ? executionMode === "agent"
      ? t("请先填写名称和任务说明")
      : t("请先填写名称和任务内容")
    : !scriptSafetyReady
      ? t("请先确认脚本运行安全提示")
      : null;

  const handleTestRun = useCallback(() => {
    if (!canTestRun) return;
    const deliver = buildDeliverString(deliverPlatforms, deliverChatIds);
    const baseJob: CronJob = initialJob ?? {
      id: AUTOMATION_FORM_TEST_JOB_ID,
      name: "",
      prompt: "",
      schedule: { kind: "", expr: "", display: "" },
      skills: [],
      enabled: true,
      state: "",
      deliver: "local",
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      created_at: null,
      script: "",
      effective_window: null,
      lightvela_schedule: null,
      context_from: null,
      context_from_hydrated: true,
      inference_config: null,
      zero_token_config: null,
    };
    onTestRun({
      ...baseJob,
      id: initialJob?.id ?? AUTOMATION_FORM_TEST_JOB_ID,
      name: name.trim(),
      prompt: executionMode === "agent"
        ? composeAutomationExecutionPrompt(prompt, executionRules)
        : "",
      schedule: initialJob?.schedule ?? { kind: "", expr: schedule, display: schedule },
      skills: executionMode === "agent" ? selectedSkills : [],
      deliver,
      // 测试运行忽略正式任务的生效窗口脚本，保证当前表单内容可以立即执行。
      script: executionMode === "zero_token" ? initialJob?.script ?? "" : "",
      effective_window: null,
      lightvela_schedule: null,
      context_from: executionMode === "agent"
        ? externalMultipleUpstreams
          ? initialContextFrom
          : selectedUpstream ? [selectedUpstream] : null
        : null,
      context_from_hydrated: true,
      inference_config: executionMode === "zero_token"
        ? { provider: null, model: null, no_agent: true }
        : baseJob.inference_config,
      zero_token_config: executionMode === "zero_token"
        ? {
            kind: zeroTokenKind,
            language: zeroTokenKind === "fixed_notification" ? "python" : scriptLanguage,
            content: zeroTokenScriptEditable ? zeroTokenContent : null,
            managed: zeroTokenScriptEditable,
            editable: zeroTokenScriptEditable,
          }
        : null,
    });
  }, [canTestRun, deliverChatIds, deliverPlatforms, executionMode, executionRules, externalMultipleUpstreams, initialContextFrom, initialJob, name, onTestRun, prompt, schedule, scriptLanguage, selectedSkills, selectedUpstream, zeroTokenContent, zeroTokenKind, zeroTokenScriptEditable]);

  const handleChatIdChange = useCallback((channel: string, value: string) => {
    const nextValue = value.slice(0, CHAT_ID_MAX_LENGTH);
    setTestSendResults((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, channel)) return prev;
      const { [channel]: _removed, ...rest } = prev;
      return rest;
    });
    if (CHINESE_TEXT_RE.test(value)) {
      setChatIdErrors((prev) => ({ ...prev, [channel]: t("Chat ID 不支持输入中文") }));
      setDeliverChatIds((prev) => ({ ...prev, [channel]: nextValue.replace(CHINESE_TEXT_RE_GLOBAL, "") }));
      return;
    }
    setChatIdErrors((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, channel)) return prev;
      const { [channel]: _removed, ...rest } = prev;
      return rest;
    });
    setDeliverChatIds((prev) => ({ ...prev, [channel]: nextValue }));
  }, [t]);

  const handleSendTestMessage = useCallback(async (channel: string) => {
    if (chatIdErrors[channel]) return;
    setTestSendResults((prev) => ({
      ...prev,
      [channel]: { status: "sending" },
    }));
    try {
      await execCommand(
        botId,
        buildHermesSendTestCommand(channel, deliverChatIds[channel] ?? "", t("LightVela 定时任务测试消息：通知通道已连接。")),
      );
      setTestSendResults((prev) => {
        const { [channel]: _removed, ...rest } = prev;
        return rest;
      });
      showTestSendToast("success", t("测试消息已发送"));
    } catch (error) {
      setTestSendResults((prev) => {
        const { [channel]: _removed, ...rest } = prev;
        return rest;
      });
      showTestSendToast("error", formatTestSendError(error, getTestSendFailureFallback(
        channel,
        t("发送失败，请检查通道配置或稍后重试"),
        t("发送失败，请先在微信中向 Hermes Agent 发送任意消息，或稍后重试"),
        t("发送失败，请先在企业微信对话中向 Hermes Agent 发送 /sethome，将该对话设为 home 对话后重试"),
      ), t));
    }
  }, [botId, chatIdErrors, deliverChatIds, showTestSendToast, t]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    if (mode === "create") {
      trackDatongClick("automation_create_btn", {
        pgid: DATONG_PAGE_IDS.AGENT_AUTOMATIONS,
        params: { bot_id: runtimeBotId },
      });
    }
    const effectiveWindow = shouldShowEffectiveWindow
      ? buildEffectiveWindowFromInputs(
        effectiveWindowEnabled ? effectiveStartAt : "",
        effectiveWindowEnabled ? effectiveEndAt : "",
        kind === "interval" ? intervalWeekdays : WEEKDAY_VALUES,
      )
      : null;
    if (effectiveWindow && isEffectiveWindowRangeInvalid(effectiveWindow)) {
      onError(t("生效结束时间不能早于开始时间"));
      return;
    }
    if (dailyTimesForScript && !canEditEffectiveWindow) {
      onError(t("当前任务包含自定义脚本，暂不支持在 UI 配置多个时间点"));
      return;
    }
    // 单次任务必须晚于当前时间；编辑已过期单次任务但未改时间时不阻断其它字段保存。
    if (shouldRejectPastOnceSchedule({
      mode,
      scheduleUneditable,
      kind,
      onceDate,
      initialOnceDate: initial?.onceDate,
      schedule,
      originalSchedule,
      now: Date.now(),
    })) {
      onError(t("不能选择早于当前的时间"));
      return;
    }
    let zeroTokenRollback: { script: string; config: CronZeroTokenScriptConfig } | null = null;
    setSubmitting(true);
    try {
      const contextPatch = executionMode === "agent"
        ? externalMultipleUpstreams
          ? undefined
          : toCronContextPatch(initialContextFrom, selectedUpstream, upstreamChanged)
        : undefined;
      setUpstreamError(null);
      if (executionMode === "agent"
        && selectedUpstream
        && !externalMultipleUpstreams
        && (mode === "create" || upstreamChanged)) {
        const latestJobs = await onRefreshJobs();
        if (!latestJobs) {
          setUpstreamError(t("暂时无法刷新上游任务，请重试"));
          return;
        }
        if (latestJobs.some((job) => job.context_from_hydrated !== true)) {
          setUpstreamError(t("暂时无法确认最新依赖关系，请重试"));
          return;
        }
        const latestUpstream = latestJobs.find((job) => job.id === selectedUpstream);
        if (!latestUpstream || isCronJobUnavailableAsUpstream(latestUpstream)) {
          setUpstreamError(t("所选上游任务已删除或过期，请重新选择或解除关联"));
          return;
        }
        if (isCronJobPaused(latestUpstream)) {
          setUpstreamError(t("所选上游任务已暂停，请重新选择或解除关联"));
          return;
        }
        if (initialJob && wouldCreateCronContextCycle(latestJobs, initialJob.id, selectedUpstream)) {
          setUpstreamError(t("所选上游任务会形成循环，请重新选择或解除关联"));
          return;
        }
      }

      const initialSkills = initialJob?.skills ?? [];
      const skillsToVerify = mode === "create"
        ? selectedSkills
        : selectedSkills.filter((slug) => !initialSkills.includes(slug));
      let verificationState = skillLoadState;
      if (executionMode === "agent"
        && skillsToVerify.length > 0) {
        verificationState = await onRefreshSkills();
      }
      const skillSelectionIssue = executionMode === "agent" ? getAutomationSkillSelectionIssue({
        mode,
        initialSkills,
        selectedSkills,
        verificationState,
      }) : null;
      if (skillSelectionIssue === "unavailable") {
        onError(t("所选 Skill 已不可用，请重新选择或取消绑定"));
        return;
      }
      if (skillSelectionIssue === "unverified") {
        onError(t("暂时无法确认所选 Skill 是否可用，请重试"));
        return;
      }

      const deliver = buildDeliverString(deliverPlatforms, deliverChatIds);
      const scriptConfig: CronLightVelaScriptConfig | null = effectiveWindow || dailyTimesForScript
        ? {
          start_at: effectiveWindow?.start_at ?? null,
          end_at: effectiveWindow?.end_at ?? null,
          ...(effectiveWindow?.weekdays?.length ? { weekdays: effectiveWindow.weekdays } : {}),
          ...(dailyTimesForScript ? { daily_times: dailyTimesForScript } : {}),
        }
        : null;
      if (mode === "create") {
        if (executionMode === "zero_token") {
          const script = createZeroTokenScriptName(
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          );
          await writeZeroTokenScript(botId, script, {
            kind: zeroTokenKind,
            language: zeroTokenKind === "fixed_notification" ? "python" : scriptLanguage,
            content: zeroTokenContent,
            start_at: scriptConfig?.start_at ?? null,
            end_at: scriptConfig?.end_at ?? null,
            ...(scriptConfig?.weekdays?.length ? { weekdays: scriptConfig.weekdays } : {}),
            ...(scriptConfig?.daily_times?.length ? { daily_times: scriptConfig.daily_times } : {}),
          });
          const createInput = {
            name: name.trim(),
            schedule,
            deliver,
            script,
            noAgent: true,
          };
          await createCronJobWithScriptRollback(botId, createInput, script);
          onSaved();
          if (deliver !== "local") {
            const deliveryWarning = t("定时任务已新建，但部分通知通道发送确认消息失败。");
            void sendHermesChatNotice(botId, deliver, t("LightVela 已新建定时任务「{{name}}」。", {
              name: createInput.name,
            }))
              .then(({ failed }) => {
                if (failed > 0) onError(deliveryWarning);
              })
              .catch(() => onError(deliveryWarning));
          }
          return;
        }
        const script = scriptConfig
          ? createEffectiveWindowScriptName(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
          : undefined;
        if (script && scriptConfig) {
          await writeEffectiveWindowScript(botId, script, scriptConfig);
        }
        const createInput = {
          name: name.trim(),
          prompt: composeAutomationExecutionPrompt(prompt, executionRules),
          schedule,
          deliver,
          script,
          skills: toCreateCronSkills(selectedSkills),
          pinCurrentModel: true,
        };
        if (selectedUpstream) {
          await createCronJobWithContextAndScriptRollback(botId, createInput, selectedUpstream, script);
        } else {
          await createCronJobWithScriptRollback(botId, createInput, script);
        }
        onSaved();
        if (deliver !== "local") {
          const deliveryWarning = t("定时任务已新建，但部分通知通道发送确认消息失败。");
          void sendHermesChatNotice(botId, deliver, t("LightVela 已新建定时任务「{{name}}」。", {
            name: createInput.name,
          }))
            .then(({ failed }) => {
              if (failed > 0) {
                onError(deliveryWarning);
              }
            })
            .catch(() => onError(deliveryWarning));
        }
        return;
      } else if (initialJob && executionMode === "zero_token") {
        const patch: Parameters<typeof editCronJob>[2] = {};
        const nextName = name.trim();
        if (nextName !== initialJob.name) patch.name = nextName;
        if (!scheduleUneditable && scheduleChanged) patch.schedule = schedule;
        if (deliver !== (initialJob.deliver || "")) patch.deliver = deliver;
        const originalConfig = initialJob.zero_token_config;
        if (originalConfig?.managed
          && originalConfig.content !== null
          && isLightVelaZeroTokenScriptName(initialJob.script)) {
          const nextLanguage = zeroTokenKind === "fixed_notification" ? "python" : scriptLanguage;
          const originalDailyTimes = initialJob.lightvela_schedule?.kind === "daily_times"
            ? initialJob.lightvela_schedule.times
            : null;
          const scriptChanged = originalConfig.kind !== zeroTokenKind
            || originalConfig.language !== nextLanguage
            || originalConfig.content !== zeroTokenContent
            || !areEffectiveWindowsEqual(effectiveWindow, initialJob.effective_window)
            || !areDailyTimesEqual(dailyTimesForScript, originalDailyTimes);
          if (scriptChanged) {
            zeroTokenRollback = {
              script: initialJob.script,
              config: {
                kind: originalConfig.kind,
                language: originalConfig.language,
                content: originalConfig.content,
                start_at: initialJob.effective_window?.start_at ?? null,
                end_at: initialJob.effective_window?.end_at ?? null,
                ...(initialJob.effective_window?.weekdays?.length
                  ? { weekdays: initialJob.effective_window.weekdays }
                  : {}),
                ...(originalDailyTimes?.length ? { daily_times: originalDailyTimes } : {}),
              },
            };
            await writeZeroTokenScript(botId, initialJob.script, {
              kind: zeroTokenKind,
              language: nextLanguage,
              content: zeroTokenContent,
              start_at: scriptConfig?.start_at ?? null,
              end_at: scriptConfig?.end_at ?? null,
              ...(scriptConfig?.weekdays?.length ? { weekdays: scriptConfig.weekdays } : {}),
              ...(scriptConfig?.daily_times?.length ? { daily_times: scriptConfig.daily_times } : {}),
            });
          }
        }
        if (Object.keys(patch).length > 0) await editCronJob(botId, initialJob.id, patch);
      } else if (initialJob) {
        const patch: Parameters<typeof editCronJob>[2] = {};
        const nextName = name.trim();
        const nextPrompt = composeAutomationExecutionPrompt(prompt, executionRules);
        if (nextName !== initialJob.name) patch.name = nextName;
        if (nextPrompt !== (initialJob.prompt ?? "")) patch.prompt = nextPrompt;
        if (!scheduleUneditable && scheduleChanged) patch.schedule = schedule;
        if (deliver !== (initialJob.deliver || "")) patch.deliver = deliver;
        const nextSkills = toEditCronSkills(initialJob.skills, selectedSkills);
        if (nextSkills !== undefined) patch.skills = nextSkills;
        if (canEditEffectiveWindow) {
          const originalWindow = initialJob.effective_window;
          const windowChanged = !areEffectiveWindowsEqual(effectiveWindow, originalWindow);
          const originalDailyTimes = initialJob.lightvela_schedule?.kind === "daily_times"
            ? initialJob.lightvela_schedule.times
            : null;
          const dailyTimesChanged = !areDailyTimesEqual(dailyTimesForScript, originalDailyTimes);
          if (windowChanged || dailyTimesChanged) {
            if (scriptConfig) {
              const script = isLightVelaEffectiveWindowScriptName(initialJob.script)
                ? initialJob.script
                : createEffectiveWindowScriptName(initialJob.id);
              await writeEffectiveWindowScript(botId, script, scriptConfig);
              patch.script = script;
            } else if (isLightVelaEffectiveWindowScriptName(initialJob.script)) {
              patch.script = "";
            }
          }
        }
        if (contextPatch !== undefined) {
          await editCronJobWithContext(botId, initialJob.id, patch, contextPatch);
        } else if (Object.keys(patch).length > 0) {
          await editCronJob(botId, initialJob.id, patch);
        }
      }
      onSaved();
    } catch (err) {
      if (zeroTokenRollback) {
        await writeZeroTokenScript(botId, zeroTokenRollback.script, zeroTokenRollback.config).catch(() => {
          /* 保留原始编辑错误；刷新后由服务端真实状态兜底。 */
        });
      }
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      onError(
        mode === "create"
          ? t("创建定时任务失败：{{message}}", { message })
          : t("编辑定时任务失败：{{message}}", { message }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [botId, runtimeBotId, canSubmit, mode, initialJob, initialContextFrom, externalMultipleUpstreams, selectedUpstream, upstreamChanged, name, prompt, executionRules, selectedSkills, skillLoadState, onRefreshSkills, onRefreshJobs, schedule, scheduleUneditable, originalSchedule, kind, onceDate, initial, scheduleChanged, deliverPlatforms, deliverChatIds, effectiveStartAt, effectiveEndAt, effectiveWindowEnabled, intervalWeekdays, canEditEffectiveWindow, shouldShowEffectiveWindow, dailyTimesForScript, onSaved, onError, t, executionMode, scriptLanguage, zeroTokenContent, zeroTokenKind]);

  return createPortal(
    <div className="lightvela-agent-console-portal lv-dialog-backdrop fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true">
      {testSendToast && (
        <ErrorToast
          message={testSendToast.message}
          tone={testSendToast.tone}
          onClose={() => setTestSendToast(null)}
        />
      )}
      <div
        className="lv-dialog-surface relative min-w-0 w-full max-w-[800px] overflow-y-auto rounded-lg bg-white p-5 shadow-2xl"
        style={{ boxSizing: "border-box", width: "min(760px, calc(100vw - 32px))", maxHeight: "min(860px, calc(100dvh - 32px))" }}
      >
        <button
          type="button"
          onClick={onClose}
          className="lv-icon-button absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-balance text-lg font-semibold text-black/90">
          {mode === "create" ? t("新建定时任务") : t("编辑定时任务")}
        </h2>

        {canSelectZeroToken ? (
          <fieldset className="mt-4">
            <legend className="text-sm font-medium text-black/80">{t("任务类型")}</legend>
            <div className="mt-2 grid grid-cols-1 items-stretch gap-2 sm:grid-cols-3">
              {([
                ["agent", t("智能任务"), t("由 AI 理解你的需求并自动完成任务"), t("AI 驱动"), "bg-indigo-600 text-white"],
                ["fixed_notification", t("通知任务"), t("按原文发送通知，不调用模型"), "0 Token", "bg-blue-50 text-blue-700"],
                ["script", t("脚本任务"), t("运行预设脚本，适合开发者"), "0 Token", "bg-blue-50 text-blue-700"],
              ] as const).map(([value, label, description, tokenLabel, tokenLabelClassName]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={selectedCreateTaskKind === value}
                  onClick={() => {
                    if (value === "agent") {
                      setExecutionMode("agent");
                      return;
                    }
                    setExecutionMode("zero_token");
                    setZeroTokenKind(value);
                    setScriptSafetyConfirmed(false);
                  }}
                  className={`flex flex-col justify-start rounded-md border px-3 py-2 text-left transition ${selectedCreateTaskKind === value
                    ? "border-blue-300 bg-blue-50"
                    : "border-black/10 hover:border-black/20"}`}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-balance text-sm font-semibold text-black/85">{label}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-4 ${tokenLabelClassName}`}>
                      {tokenLabel}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-pretty text-xs leading-4 text-black/45">
                    {description}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        ) : mode === "edit" && executionMode === "zero_token" ? (
          <div className="mt-4 rounded-md border border-black/10 bg-black/[0.025] px-3 py-2">
            <p className="text-sm font-semibold text-black/80">{t("0 Token 任务")}</p>
            <p className="mt-0.5 text-pretty text-xs leading-4 text-black/50">
              {t("不调用模型，执行不消耗模型 Token，但仍会使用运行资源")}
            </p>
          </div>
        ) : null}

        {mode === "edit" && executionMode === "zero_token" && (
          <div className="mt-3">
            <p className="text-sm text-black/65">
              {zeroTokenKind === "fixed_notification" ? t("通知任务") : t("脚本任务")}
              <span className="ml-2 text-xs text-black/40">{t("创建后不可更改类型")}</span>
            </p>
          </div>
        )}

        {/* 名称 */}
        <div className={canSelectZeroToken || executionMode === "zero_token" ? "mt-3" : "mt-4"}>
          <label className="block text-sm font-medium text-black/80">{t("名称")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            maxLength={60}
            placeholder={t("请输入定时任务名称")}
            className="mt-1.5 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_COMPACT_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
        </div>

        {/* 执行时间 */}
        <div className="mt-3">
          <label className="block text-sm font-medium text-black/80">{t("执行时间")}</label>
          <div className="lv-segmented-control mt-1.5 inline-flex rounded-md bg-black/[0.04] p-1">
            {(["once", "recurring", "interval"] as FrequencyKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  if (!scheduleUneditable) setKind(k);
                }}
                disabled={scheduleUneditable}
                style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                className={`lv-segmented-control__item rounded-md px-3 py-1 text-sm font-medium transition ${kind === k ? "bg-white text-black/90 shadow-sm" : "text-black/50 hover:text-black/80"
                  } ${scheduleUneditable ? "cursor-not-allowed opacity-60" : ""}`}
              >
                {k === "recurring" ? t("周期") : k === "interval" ? t("按间隔") : t("单次")}
              </button>
            ))}
          </div>
          <div className="mt-2">
            {scheduleUneditable ? (
              <div className="rounded-md bg-[#FFF7E6] px-3 py-2 text-xs leading-relaxed text-[#8A5A00]">
                {t("当前调度表达式 {{expr}} 暂不支持在 UI 编辑，如需修改请使用 hermes CLI", { expr: initialScheduleSource })}
              </div>
            ) : kind === "recurring" && (
              <RecurringPicker
                period={period}
                time={time}
                dailyTimes={dailyTimes}
                weekdays={weekdays}
                monthdays={monthdays}
                onPeriod={(nextPeriod) => {
                  if (nextPeriod === "daily") {
                    setDailyTimes((values) => normalizeDailyTimes(values, time));
                  } else {
                    setTime(normalizedDailyTimes[0] ?? time);
                  }
                  setPeriod(nextPeriod);
                }}
                onTime={setTime}
                onDailyTimes={setDailyTimes}
                onWeekdays={setWeekdays}
                onMonthdays={setMonthdays}
              />
            )}
            {!scheduleUneditable && kind === "interval" && (
              <IntervalPicker
                num={intervalNum}
                unit={intervalUnit}
                weekdays={intervalWeekdays}
                weekdaysDisabled={!canEditEffectiveWindow}
                onNum={setIntervalNum}
                onUnit={setIntervalUnit}
                onWeekdays={setIntervalWeekdays}
              />
            )}
            {!scheduleUneditable && kind === "once" && <OncePicker value={onceDate} onChange={setOnceDate} />}
          </div>
        </div>

        {executionMode === "agent" ? (
          <>
          {/* 任务说明 */}
          <div className="mt-3">
          <div className="flex items-baseline justify-between">
            <label className="block text-sm font-medium text-black/80">{t("任务说明")}</label>
            <span className="text-[11px] text-black/40">{prompt.length}/{promptMaxLength}</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, promptMaxLength))}
            rows={3}
            maxLength={promptMaxLength}
            placeholder={t("请描述需要智能体理解并执行的任务，例如：整理每日 AI 资讯并总结关键进展")}
            className="mt-1.5 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_COMPACT_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
          </div>

          <AutomationSkillPicker
            value={selectedSkills}
            loadState={skillLoadState}
            onChange={setSelectedSkills}
            onRetry={() => void onRefreshSkills()}
          />
          </>
        ) : (
          <div className="mt-3">
            <div className="flex items-baseline justify-between">
              <label className="block text-sm font-medium text-black/80">
                {zeroTokenKind === "fixed_notification" ? t("通知内容") : t("脚本内容")}
              </label>
              {zeroTokenScriptEditable && zeroTokenKind === "fixed_notification" ? (
                <span className="tabular-nums text-[11px] text-black/40">
                  {zeroTokenContent.length}/{FIXED_NOTIFICATION_MAX_LENGTH}
                </span>
              ) : null}
            </div>
            {zeroTokenKind === "script" && zeroTokenScriptEditable ? (
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <div className="inline-flex rounded-md bg-black/[0.04] p-1">
                  {(["python", "bash"] as CronScriptLanguage[]).map((language) => (
                    <button
                      key={language}
                      type="button"
                      aria-pressed={scriptLanguage === language}
                      onClick={() => setScriptLanguage(language)}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition ${scriptLanguage === language
                        ? "bg-white text-black/90 shadow-sm"
                        : "text-black/50 hover:text-black/80"}`}
                    >
                      {language === "python" ? "Python" : "Bash"}
                    </button>
                  ))}
                </div>
                <span className="tabular-nums text-[11px] text-black/40">
                  {zeroTokenContent.length}/{AUTOMATION_SCRIPT_MAX_LENGTH}
                </span>
              </div>
            ) : null}
            {zeroTokenScriptEditable ? (
              <textarea
                value={zeroTokenContent}
                onChange={(event) => setZeroTokenContent(event.target.value.slice(
                  0,
                  zeroTokenKind === "fixed_notification"
                    ? FIXED_NOTIFICATION_MAX_LENGTH
                    : AUTOMATION_SCRIPT_MAX_LENGTH,
                ))}
                rows={zeroTokenKind === "fixed_notification" ? 3 : 6}
                spellCheck={zeroTokenKind === "fixed_notification"}
                maxLength={zeroTokenKind === "fixed_notification"
                  ? FIXED_NOTIFICATION_MAX_LENGTH
                  : AUTOMATION_SCRIPT_MAX_LENGTH}
                placeholder={zeroTokenKind === "fixed_notification"
                  ? t("例如：该喝水啦，休息一下再继续吧")
                  : `${t("示例脚本：")}\n${scriptLanguage === "python"
                    ? PYTHON_SCRIPT_PLACEHOLDER
                    : BASH_SCRIPT_PLACEHOLDER}`}
                className={`mt-1.5 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none ${zeroTokenKind === "script" ? "font-mono" : ""}`}
                style={{ ...MODAL_COMPACT_CONTROL_TEXT_STYLE, marginTop: 6 }}
              />
            ) : (
              <div className="mt-1.5 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2.5 text-pretty text-xs leading-5 text-amber-900/75">
                {t("该任务由 Hermes CLI 或其他工具创建。LightVela 无法确认脚本归属，因此不会读取、覆盖或删除脚本内容。你仍可修改名称、时间和通知方式。")}
              </div>
            )}
            {zeroTokenKind === "fixed_notification" ? (
              <p className="mt-1.5 text-pretty text-xs leading-5 text-black/40">
                {t("通知内容会按原文发送，不经过模型改写。没有模型调用，但仍会使用 Agent 运行资源。")}
              </p>
            ) : zeroTokenScriptEditable ? (
              <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-pretty text-xs leading-4 text-amber-900/80">
                <input
                  type="checkbox"
                  checked={scriptSafetyConfirmed}
                  onChange={(event) => setScriptSafetyConfirmed(event.target.checked)}
                  className="lv-checkbox mt-0.5 h-4 w-4 shrink-0 rounded border-amber-700/30 accent-black"
                />
                <span>{t("我已了解风险：脚本会直接在云端 Agent 环境中运行，并非独立安全沙箱；请仅运行你信任的脚本。")}</span>
              </label>
            ) : null}
          </div>
        )}

        {/* 生效时间段 */}
        {shouldShowEffectiveWindow && (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="block text-sm font-medium text-black/80">{t("生效时间段")}</label>
              <button
                type="button"
                role="switch"
                aria-checked={effectiveWindowEnabled}
                disabled={!canEditEffectiveWindow}
                onClick={() => {
                  if (!canEditEffectiveWindow) return;
                  setEffectiveWindowEnabled((enabled) => !enabled);
                }}
                style={{ marginLeft: 10 }}
                className={`lv-switch relative inline-flex h-5 w-9 items-center rounded-full transition ${effectiveWindowEnabled ? "bg-black" : "bg-black/15"
                  } ${canEditEffectiveWindow ? "" : "cursor-not-allowed opacity-50"}`}
                aria-label={t("生效时间段")}
              >
                <span
                  className={`lv-switch__thumb inline-block h-4 w-4 rounded-full bg-white shadow-sm transition ${effectiveWindowEnabled ? "translate-x-4" : "translate-x-0.5"
                    }`}
                />
              </button>
              {!effectiveWindowEnabled && (
                <span className="text-xs font-normal text-black/40">{t("可选，不配置代表任务一直生效")}</span>
              )}
              {effectiveWindowEnabled && (
                <span className="text-xs font-normal text-black/40">{t("超出生效时间段时，任务不会执行")}</span>
              )}
            </div>
            {effectiveWindowEnabled && (
              <div className="mt-1.5 grid grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,11.25rem)_1.25rem_minmax(0,11.25rem)_auto] sm:items-center sm:gap-x-0">
                <input
                  type="datetime-local"
                  value={effectiveStartAt}
                  onChange={(e) => setEffectiveStartAt(e.target.value)}
                  disabled={!canEditEffectiveWindow}
                  style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                  className="min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35 sm:w-full"
                  aria-label={t("生效开始时间")}
                />
                <span className="hidden text-center text-sm text-black/35 sm:block">—</span>
                <input
                  type="datetime-local"
                  value={effectiveEndAt}
                  onChange={(e) => setEffectiveEndAt(e.target.value)}
                  disabled={!canEditEffectiveWindow}
                  style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                  className="min-w-0 rounded-md border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35 sm:w-full"
                  aria-label={t("生效结束时间")}
                />
                <span className="group relative -ml-1 inline-flex h-10 w-8 items-center justify-center">
                  <button
                    type="button"
                    onClick={() => {
                      setEffectiveStartAt("");
                      setEffectiveEndAt("");
                    }}
                    disabled={!canEditEffectiveWindow || (!effectiveStartAt && !effectiveEndAt)}
                    className="inline-flex h-10 w-8 items-center justify-center text-black/50 transition hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-35"
                    aria-label={t("清空")}
                  >
                    <Eraser className="h-4 w-4" />
                  </button>
                  <span className="pointer-events-auto absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 select-text whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                    {t("清空")}
                    <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        {/* 通知方式（多选；不勾任何 = 仅本地写日志）
         *
         * 区域可见性：
         *   - 国内站（isCN）：weixin / qqbot / wecom / feishu / dingtalk
         *   - 国际站（isGlobal）：telegram / whatsapp / discord / slack / weixin / qqbot / wecom / feishu
        */}
        <div className="mt-3">
          <div className="flex items-center gap-1 text-sm font-medium text-black/80">
            <span>{t("通知方式")}</span>
            <span className="relative inline-flex">
              <button
                ref={notificationHelpTooltip.triggerRef}
                type="button"
                aria-label={t("通知方式")}
                aria-describedby={notificationHelpTooltip.open ? notificationHelpTooltip.tooltipId : undefined}
                onMouseEnter={notificationHelpTooltip.showTooltip}
                onMouseLeave={notificationHelpTooltip.scheduleClose}
                onFocus={notificationHelpTooltip.showTooltip}
                onBlur={notificationHelpTooltip.scheduleClose}
                className="inline-flex size-4 items-center justify-center rounded-full text-black/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black/30"
              >
                <CircleHelp className="size-3.5" aria-hidden="true" />
              </button>
              {notificationHelpTooltip.open && (
                <FloatingTooltip
                  id={notificationHelpTooltip.tooltipId}
                  position={notificationHelpTooltip.position}
                  className="w-72 whitespace-normal text-pretty text-left"
                  onMouseEnter={notificationHelpTooltip.showTooltip}
                  onMouseLeave={notificationHelpTooltip.scheduleClose}
                >
                  {executionMode === "zero_token"
                    ? t("如未勾选通知方式，任务只会在后台执行并写入日志，不发通知。")
                    : t("如不选，智能体只会在后台执行任务，不发通知。")}
                </FloatingTooltip>
              )}
            </span>
            <span className="text-xs font-normal text-black/40">{t("（可选）")}</span>
          </div>
          {channelStatus === "loading" ? (
            <div className="mt-2 inline-flex min-h-6 items-center gap-1.5 text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("加载中...")}
            </div>
          ) : (
            <div className="mt-2 space-y-1">
              {!hasAvailableNotificationChannel ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-black/45" style={MODAL_HELP_TEXT_STYLE}>
                  <span>{t("暂无已配置的通知通道。")}</span>
                  <a
                    href="/agents/channels/"
                    className="inline-flex items-center rounded-md border border-black/10 px-2 py-1 text-[12px] font-medium text-black/70 transition hover:bg-black/[0.04]"
                  >
                    {t("前往通道配置")}
                  </a>
                </div>
              ) : availableNotificationChannels.map(({ key, label, comingSoon }) => {
              // comingSoon 通道一律强制为「不可配置」，无论 acli channel status 怎么报
              const configured = isHermesNotificationChannelConfigured(enabledChannels, key, comingSoon);
              const blockedByFrequency = key === "weixin" && weixinBlockedByFrequency;
              const selected = deliverPlatforms.includes(key);
              const showRateLimitWarning = blockedByFrequency || (selected && key === "weixin");
              const checkboxDisabled = !configured || blockedByFrequency;
              return (
                <div key={key}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <label
                      className={
                        "inline-flex min-h-6 items-center gap-1.5 text-sm " +
                        (!checkboxDisabled ? "cursor-pointer text-black/80" : "cursor-not-allowed text-black/30")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        disabled={checkboxDisabled}
                        onChange={() => {
                          setDeliverPlatforms((prev) => {
                            if (!prev.includes(key)) return [...prev, key];
                            setDeliverChatIds((ids) => {
                              const { [key]: _removed, ...rest } = ids;
                              return rest;
                            });
                            setChatIdErrors((errors) => {
                              const { [key]: _removed, ...rest } = errors;
                              return rest;
                            });
                            setTestSendResults((results) => {
                              const { [key]: _removed, ...rest } = results;
                              return rest;
                            });
                            return prev.filter((p) => p !== key);
                          });
                        }}
                        className="lv-checkbox h-4 w-4 cursor-pointer rounded border-black/20 accent-black disabled:cursor-not-allowed"
                      />
                      <span className="text-sm leading-5">
                        {label}
                        {comingSoon ? (
                          <span className="ml-1 text-xs">{t("（即将推出）")}</span>
                        ) : (
                          !configured && <span className="ml-1 text-xs">{t("（未配置）")}</span>
                        )}
                      </span>
                    </label>
                    {showRateLimitWarning && (
                      <span className="text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        {t("微信不建议频繁通知，否则可能会被限流")}
                      </span>
                    )}
                    {selected && key === "qqbot" && (
                      <span className="inline-flex items-center text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        {t("如未生效，可尝试向绑定的QQ机器人发送")}
                        <InlineCopyText value="/sethome" />
                      </span>
                    )}
                    {selected && key === "feishu" && (
                      <span className="text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>{t("支持通过默认的 home 对话或指定 Chat ID 发送通知")}</span>
                    )}
                    {selected && key === "wecom" && (
                      <span className="text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>{t("通过默认的 home 对话发送通知")}</span>
                    )}
                    {selected && (key === "telegram" || key === "discord" || key === "slack") && (
                      <span className="inline-flex items-center text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        {t("请先在")}
                        {label}
                        {t("对话中发送")}
                        <InlineCopyText value="/sethome" />
                        {t("给机器人")}
                      </span>
                    )}
                    {selected && !comingSoon && (
                      <button
                        type="button"
                        onClick={() => void handleSendTestMessage(key)}
                        disabled={testSendResults[key]?.status === "sending" || Boolean(chatIdErrors[key])}
                        className="inline-flex h-[26px] items-center justify-center gap-1 rounded-md border border-black/10 bg-white px-2 text-[12px] font-medium text-black/70 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {testSendResults[key]?.status === "sending" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : null}
                        {t("发送测试消息")}
                      </button>
                    )}
                  </div>

                  {selected && key === "feishu" && (
                    <div className="mt-1.5 space-y-1.5 pl-5">
                      <div className="flex items-center gap-1">
                        <span className="w-[104px] shrink-0 whitespace-nowrap text-sm text-black/50" style={MODAL_HELP_TEXT_STYLE}>{t("Chat ID（可选）")}</span>
                        <input
                          type="text"
                          value={deliverChatIds[key] ?? ""}
                          maxLength={CHAT_ID_MAX_LENGTH}
                          onChange={(e) => handleChatIdChange(key, e.target.value)}
                          placeholder={t("可留空，即通过默认的 home 对话通知；也可指定 Chat ID 通知")}
                          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-1.5 text-[12px] placeholder:text-[12px] placeholder:text-black/35 focus:border-black/30 focus:outline-none"
                          style={{ fontSize: 12, lineHeight: "18px" }}
                        />
                      </div>
                      {chatIdErrors[key] ? (
                        <div
                          className="rounded-md border border-red-500/20 bg-red-500/[0.06] px-2.5 py-1.5 text-[12px] text-red-600"
                          style={{ lineHeight: "18px" }}
                        >
                          {chatIdErrors[key]}
                        </div>
                      ) : null}
                      <div className="space-y-2 text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <CircleHelp className="h-3.5 w-3.5 shrink-0 text-black/35" />
                            <span>{t("什么是 home 对话？")}</span>
                          </div>
                          <p className="mt-1 pl-5">
                            {t("扫码连接飞书后，默认的对话即为home对话。如需切换，可在其他对话中发送")}
                            <InlineCopyText value="/sethome" />
                            {t("。")}
                          </p>
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <CircleHelp className="h-3.5 w-3.5 shrink-0 text-black/35" />
                            <span>{t("如何获取 Chat ID？")}</span>
                          </div>
                          <p className="mt-1 pl-5">
                            {t("进入飞书应用，在希望发送通知的私聊或群聊中，向 Hermes Agent 发送提示词")}
                            <InlineCopyText value={t("查一下当前对话的oc_ chat ID")} />
                            {t("，正常会回复前缀为oc_的一长串字符。")}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {selected && key === "wecom" && (
                    <div className="mt-1.5 space-y-1.5 pl-5">
                      <div className="space-y-2 text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <CircleHelp className="h-3.5 w-3.5 shrink-0 text-black/35" />
                            <span>{t("什么是 home 对话？")}</span>
                          </div>
                          <p className="mt-1 pl-5">
                            {t("在企业微信目标对话中向 Hermes Agent 发送")}
                            <InlineCopyText value="/sethome" />
                            {t("即可将该对话设为 home 对话，之后的通知都会发到这个对话里。若发送后仍提示未设置，请稍后重试。")}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              );
              })}
            </div>
          )}
        </div>

        {executionMode === "agent" && (
          <details className="group mt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1.5 text-sm font-medium text-black/70 hover:text-black/90 [&::-webkit-details-marker]:hidden">
              <span>{t("高级设置")}</span>
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-black/40 group-open:rotate-180" />
            </summary>
            <div className="pt-3">
              <label className="block text-sm font-medium text-black/80">
                {t("上游任务")}<span className="ml-1 text-xs font-normal text-black/40">{t("（可选）")}</span>
              </label>
              <div className="mt-2">
                {externalMultipleUpstreams ? (
                  <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.05] px-3 py-2 text-pretty text-xs text-amber-800">
                    <p className="font-medium">{t("当前任务配置了多个上游，暂不支持在 LightVela 中编辑")}</p>
                    <ul className="mt-1 space-y-1 text-amber-800/75">
                      {externalMultipleUpstreams.map((job, index) => (
                        <li key={index} className="break-words">
                          {job?.name ?? t("上游任务已不可用")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <AutomationUpstreamPicker
                    value={selectedUpstream}
                    options={pickerUpstreams}
                    state={contextCapability}
                    onRetry={onRetryContextCapability}
                    onChange={(jobId) => {
                      setSelectedUpstream(jobId);
                      setUpstreamChanged(true);
                      setUpstreamError(null);
                    }}
                  />
                )}
              </div>
              {upstreamError && (
                <p role="alert" className="mt-2 text-pretty text-xs leading-5 text-[#B91C1C]">
                  {upstreamError}
                </p>
              )}
            </div>
          </details>
        )}

        {/* 操作 */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <span className="inline-flex" title={testRunDisabledReason ?? undefined}>
            <button
              type="button"
              disabled={!canTestRun}
              onClick={handleTestRun}
              aria-describedby={testRunDisabledReason ? testRunHintId : undefined}
              className="inline-flex min-w-[104px] items-center justify-center gap-1.5 rounded-lg border border-black/10 bg-white px-4 py-2 text-sm font-medium text-black/70 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {testState === "running" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : testState === "ok" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-[#0F8A4B]" />
              ) : testState === "fail" ? (
                <X className="h-3.5 w-3.5 text-[#B91C1C]" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              {t("测试运行")}
            </button>
            {testRunDisabledReason ? (
              <span id={testRunHintId} className="sr-only">{testRunDisabledReason}</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-black/10 px-4 py-2 text-sm font-medium text-black/70 transition hover:bg-black/[0.04]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            className="inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "create" ? t("新建") : t("保存")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RecurringPicker({
  period,
  time,
  dailyTimes,
  weekdays,
  monthdays,
  onPeriod,
  onTime,
  onDailyTimes,
  onWeekdays,
  onMonthdays,
}: {
  period: RecurringPeriod;
  time: string;
  dailyTimes: string[];
  weekdays: number[];
  monthdays: number[];
  onPeriod: (v: RecurringPeriod) => void;
  onTime: (v: string) => void;
  onDailyTimes: (v: string[]) => void;
  onWeekdays: (v: number[]) => void;
  onMonthdays: (v: number[]) => void;
}) {
  const t = useT();
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const [weekdayPickerOpen, setWeekdayPickerOpen] = useState(false);
  const [monthdayPickerOpen, setMonthdayPickerOpen] = useState(false);
  const [activeDailyTimePickerIndex, setActiveDailyTimePickerIndex] = useState<number | null>(null);
  const periodPickerRef = useRef<HTMLDivElement | null>(null);
  const weekdayPickerRef = useRef<HTMLDivElement | null>(null);
  const monthdayPickerRef = useRef<HTMLDivElement | null>(null);
  const dailyTimePickerRef = useRef<HTMLSpanElement | null>(null);
  const periodOptions: Array<{ value: RecurringPeriod; label: string }> = [
    { value: "daily", label: t("每天") },
    { value: "weekly", label: t("每周") },
    { value: "monthly", label: t("每月") },
  ];
  const periodLabel = periodOptions.find((option) => option.value === period)?.label ?? t("每天");
  const weekdayLabels = getWeekdayLabels(t);
  const editingDailyTimes = normalizeDailyTimesForEditing(dailyTimes, time);
  const normalizedDailyTimes = normalizeDailyTimesForForm(editingDailyTimes, time);
  const selectedWeekdays = normalizeWeekdays(weekdays);
  const selectedMonthdays = normalizeMonthdays(monthdays);
  const addDailyTimeTooltip = useHoverTooltipPosition<HTMLSpanElement>();
  useEffect(() => {
    if (!periodPickerOpen && !weekdayPickerOpen && !monthdayPickerOpen && activeDailyTimePickerIndex == null) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (periodPickerRef.current?.contains(target)) return;
      if (weekdayPickerRef.current?.contains(target)) return;
      if (monthdayPickerRef.current?.contains(target)) return;
      if (dailyTimePickerRef.current?.contains(target)) return;
      setPeriodPickerOpen(false);
      setWeekdayPickerOpen(false);
      setMonthdayPickerOpen(false);
      setActiveDailyTimePickerIndex(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeDailyTimePickerIndex, monthdayPickerOpen, periodPickerOpen, weekdayPickerOpen]);
  useEffect(() => {
    if (period !== "daily") setActiveDailyTimePickerIndex(null);
  }, [period]);
  useLayoutEffect(() => {
    if (activeDailyTimePickerIndex == null) return;
    const picker = dailyTimePickerRef.current;
    if (!picker) return;
    const scrollSelected = (part: "hour" | "minute") => {
      const selected = picker.querySelector<HTMLElement>(`[data-clock-part="${part}"][data-clock-selected="true"]`);
      const scrollParent = selected?.parentElement;
      if (!selected || !scrollParent) return;
      scrollParent.scrollTop = selected.offsetTop - (scrollParent.clientHeight - selected.offsetHeight) / 2;
    };
    scrollSelected("hour");
    scrollSelected("minute");
  }, [activeDailyTimePickerIndex, editingDailyTimes, time]);
  const toggleWeekday = useCallback((day: number) => {
    // 至少保留 1 天：取消最后一个选中项时直接忽略，避免 normalizeWeekdays 静默兜底为周一
    if (selectedWeekdays.length === 1 && selectedWeekdays[0] === day) return;
    const next = selectedWeekdays.includes(day)
      ? selectedWeekdays.filter((v) => v !== day)
      : [...selectedWeekdays, day];
    onWeekdays(normalizeWeekdays(next));
  }, [onWeekdays, selectedWeekdays]);
  const toggleMonthday = useCallback((day: number) => {
    // 至少保留 1 天：取消最后一个选中项时直接忽略，避免 normalizeMonthdays 静默兜底为 1 日
    if (selectedMonthdays.length === 1 && selectedMonthdays[0] === day) return;
    const next = selectedMonthdays.includes(day)
      ? selectedMonthdays.filter((v) => v !== day)
      : [...selectedMonthdays, day];
    onMonthdays(normalizeMonthdays(next));
  }, [onMonthdays, selectedMonthdays]);
  const selectDailyTimePart = useCallback((index: number, part: "hour" | "minute", value: string) => {
    const current = editingDailyTimes[index] ?? time;
    const { hour, minute } = splitClockTimeDraft(current, time);
    const nextTime = part === "hour" ? `${value}:${minute}` : `${hour}:${value}`;
    const next = editingDailyTimes.map((item, itemIndex) => itemIndex === index ? nextTime : item);
    onDailyTimes(next);
    if (index === 0) onTime(nextTime);
  }, [editingDailyTimes, onDailyTimes, onTime, time]);
  const removeDailyTime = useCallback((index: number) => {
    const next = editingDailyTimes.filter((_, itemIndex) => itemIndex !== index);
    const normalized = normalizeDailyTimesForForm(next, time);
    onDailyTimes(normalized);
    onTime(normalized[0] ?? time);
    setActiveDailyTimePickerIndex((current) => {
      if (current == null) return null;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  }, [editingDailyTimes, onDailyTimes, onTime, time]);
  const addDailyTime = useCallback(() => {
    const existing = new Set(normalizedDailyTimes);
    const [hh = "9", mm = "0"] = (normalizedDailyTimes[normalizedDailyTimes.length - 1] ?? time).split(":");
    const baseMinutes = Math.max(0, Math.min(23, Number(hh) || 0)) * 60 + Math.max(0, Math.min(59, Number(mm) || 0));
    let nextTime = "";
    for (let step = 60; step <= 24 * 60; step += 60) {
      const minutes = (baseMinutes + step) % (24 * 60);
      const candidate = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      if (!existing.has(candidate)) {
        nextTime = candidate;
        break;
      }
    }
    const normalized = normalizeDailyTimesForForm([...normalizedDailyTimes, nextTime || time], time);
    onDailyTimes(normalized);
    onTime(normalized[0] ?? time);
  }, [normalizedDailyTimes, onDailyTimes, onTime, time]);
  const isDailyTimeLimitReached = editingDailyTimes.length >= MAX_DAILY_TIME_POINTS;
  const addDailyTimeButton = (
    <span
      ref={addDailyTimeTooltip.triggerRef}
      className={`inline-flex ${isDailyTimeLimitReached ? "cursor-not-allowed" : ""}`}
      aria-describedby={isDailyTimeLimitReached && addDailyTimeTooltip.open ? addDailyTimeTooltip.tooltipId : undefined}
      tabIndex={isDailyTimeLimitReached ? 0 : -1}
      onMouseEnter={isDailyTimeLimitReached ? addDailyTimeTooltip.showTooltip : undefined}
      onMouseLeave={isDailyTimeLimitReached ? addDailyTimeTooltip.scheduleClose : undefined}
      onFocus={isDailyTimeLimitReached ? addDailyTimeTooltip.showTooltip : undefined}
      onBlur={isDailyTimeLimitReached ? addDailyTimeTooltip.scheduleClose : undefined}
    >
      <button
        type="button"
        onClick={() => {
          if (isDailyTimeLimitReached) return;
          addDailyTime();
        }}
        aria-disabled={isDailyTimeLimitReached}
        className={
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition " +
          (isDailyTimeLimitReached
            ? "cursor-not-allowed border-black/5 bg-black/[0.03] text-black/25"
            : "border-black/10 bg-white text-black/65 hover:bg-black/[0.04] hover:text-black/85")
        }
        aria-label={isDailyTimeLimitReached ? t("最多支持18个时间点") : t("添加时间")}
      >
        <Plus className="h-3 w-3" />
      </button>
      {isDailyTimeLimitReached && addDailyTimeTooltip.open && (
        <FloatingTooltip
          id={addDailyTimeTooltip.tooltipId}
          position={addDailyTimeTooltip.position}
          className="whitespace-nowrap"
          onMouseEnter={addDailyTimeTooltip.showTooltip}
          onMouseLeave={addDailyTimeTooltip.scheduleClose}
        >
          {t("最多支持18个时间点")}
        </FloatingTooltip>
      )}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={periodPickerRef} className="relative w-[100px]">
        <button
          type="button"
          onClick={() => setPeriodPickerOpen((open) => !open)}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="flex h-8 w-full items-center justify-between rounded-lg border border-black/10 bg-white px-3 py-1.5 text-left text-sm focus:border-black/30 focus:outline-none"
          aria-haspopup="listbox"
          aria-expanded={periodPickerOpen}
        >
          <span>{periodLabel}</span>
          <ChevronDown className="h-4 w-4 text-black/80" />
        </button>
        {periodPickerOpen && (
          <div
            className="absolute left-0 top-[calc(100%+6px)] z-10 w-[132px] rounded-xl border border-black/10 bg-white p-1.5 shadow-xl"
            role="listbox"
          >
            {periodOptions.map((option) => {
              const checked = option.value === period;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onPeriod(option.value);
                    setPeriodPickerOpen(false);
                  }}
                  style={{ fontSize: "14px", lineHeight: "22px" }}
                  className={
                    "flex w-full items-center justify-between rounded-lg px-3 py-2 transition " +
                    (checked
                      ? "bg-black text-white"
                      : "text-black/70 hover:bg-black/[0.04] hover:text-black")
                  }
                  role="option"
                  aria-selected={checked}
                >
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {period === "daily" && (
        <div className="relative flex w-[588px] max-w-full flex-wrap items-center gap-1">
          {editingDailyTimes.map((dailyTime, index) => (
            <Fragment key={index}>
              <span
                className="relative inline-flex h-8 w-[90px] shrink-0 items-center rounded-lg border border-black/10 bg-white focus-within:border-black/25"
                ref={activeDailyTimePickerIndex === index ? dailyTimePickerRef : undefined}
              >
                <button
                  type="button"
                  onClick={() => setActiveDailyTimePickerIndex((current) => current === index ? null : index)}
                  style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                  className="flex h-full min-w-0 flex-1 items-center px-2 text-left text-sm focus:outline-none"
                  aria-haspopup="listbox"
                  aria-expanded={activeDailyTimePickerIndex === index}
                  aria-label={t("执行时间")}
                >
                  <span className="truncate">{dailyTime}</span>
                </button>
                {editingDailyTimes.length > 1 && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeDailyTime(index);
                    }}
                    className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-black/35 transition hover:bg-black/[0.04] hover:text-black/65"
                    aria-label={t("移除时间点")}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
                {activeDailyTimePickerIndex === index && (() => {
                  const selected = splitClockTimeDraft(dailyTime, time);
                  return (
                    <div className="absolute left-0 top-[calc(100%+6px)] z-30 grid w-[112px] grid-cols-2 gap-0.5 rounded-md border border-black/10 bg-white p-1 shadow-[0_10px_28px_rgba(15,23,42,0.16)]">
                      <div className="max-h-[224px] overflow-y-auto pr-0.5" role="listbox" aria-label="hour">
                        {CLOCK_HOUR_OPTIONS.map((hour) => {
                          const selectedHour = hour === selected.hour;
                          return (
                            <button
                              key={hour}
                              type="button"
                              data-clock-part="hour"
                              data-clock-selected={selectedHour ? "true" : undefined}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => selectDailyTimePart(index, "hour", hour)}
                              className={
                                "flex h-8 w-full items-center justify-center rounded-md text-sm font-medium transition " +
                                (selectedHour
                                  ? "bg-[#2F7BFF] text-white"
                                  : "text-black/85 hover:bg-black/[0.04]")
                              }
                              aria-pressed={selectedHour}
                              role="option"
                              aria-selected={selectedHour}
                            >
                              {hour}
                            </button>
                          );
                        })}
                      </div>
                      <div className="max-h-[224px] overflow-y-auto pl-0.5" role="listbox" aria-label="minute">
                        {CLOCK_MINUTE_OPTIONS.map((minute) => {
                          const selectedMinute = minute === selected.minute;
                          return (
                            <button
                              key={minute}
                              type="button"
                              data-clock-part="minute"
                              data-clock-selected={selectedMinute ? "true" : undefined}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => selectDailyTimePart(index, "minute", minute)}
                              className={
                                "flex h-8 w-full items-center justify-center rounded-md text-sm font-medium transition " +
                                (selectedMinute
                                  ? "bg-[#2F7BFF] text-white"
                                  : "text-black/85 hover:bg-black/[0.04]")
                              }
                              aria-pressed={selectedMinute}
                              role="option"
                              aria-selected={selectedMinute}
                            >
                              {minute}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </span>
            </Fragment>
          ))}
          {addDailyTimeButton}
        </div>
      )}
      {period === "weekly" && (
        <div ref={weekdayPickerRef} className="relative w-[360px] max-w-full">
          <div
            onClick={() => setWeekdayPickerOpen((open) => !open)}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-md border border-black/10 bg-white px-2.5 py-1 pr-9 text-left text-sm focus-within:border-black/30"
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          >
            <div
              role="button"
              tabIndex={0}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left focus:outline-none"
              aria-haspopup="listbox"
              aria-expanded={weekdayPickerOpen}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setWeekdayPickerOpen((open) => !open);
              }}
            >
              {selectedWeekdays.map((day) => (
                <span
                  key={day}
                  className="inline-flex h-6 items-center gap-1 rounded-full bg-black px-2.5 text-xs font-medium leading-none text-white"
                >
                  {weekdayLabels[day]}
                  {selectedWeekdays.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="-mr-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
                      aria-label={`${weekdayLabels[day]} ×`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleWeekday(day);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        toggleWeekday(day);
                      }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
          <ChevronDown className="pointer-events-none absolute right-3 top-4 h-4 w-4 -translate-y-1/2 text-black/80" />
          {weekdayPickerOpen && (
            <div
              className="absolute left-0 top-[calc(100%+6px)] z-10 w-[260px] rounded-xl border border-black/10 bg-white p-2 shadow-xl"
              role="listbox"
              aria-multiselectable="true"
            >
              {WEEKDAY_VALUES.map((day) => {
                const checked = selectedWeekdays.includes(day);
                // 唯一选中项不允许取消，按钮置灰提示「至少保留 1 天」
                const isLastSelected = checked && selectedWeekdays.length === 1;
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    disabled={isLastSelected}
                    className={
                      "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition " +
                      (isLastSelected
                        ? "cursor-not-allowed text-black/40"
                        : "text-black/80 hover:bg-black/[0.04]")
                    }
                    role="option"
                    aria-selected={checked}
                    title={isLastSelected ? t("至少保留 1 天") : undefined}
                  >
                    <span>{weekdayLabels[day]}</span>
                    <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-black bg-black" : "border-black/20 bg-white"
                      }`}>
                      {checked && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {period === "monthly" && (
        <div ref={monthdayPickerRef} className="relative w-[360px] max-w-full">
          <div
            onClick={() => setMonthdayPickerOpen((open) => !open)}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-black/10 bg-white px-2.5 py-1 pr-9 text-left text-sm focus-within:border-black/30"
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          >
            <div
              role="button"
              tabIndex={0}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left focus:outline-none"
              aria-haspopup="listbox"
              aria-expanded={monthdayPickerOpen}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setMonthdayPickerOpen((open) => !open);
              }}
            >
              {selectedMonthdays.map((day) => (
                <span
                  key={day}
                  className="inline-flex h-6 items-center gap-1 rounded-full bg-black px-2.5 text-xs font-medium leading-none text-white"
                >
                  {t("{{n}}日", { n: day })}
                  {selectedMonthdays.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      className="-mr-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
                      aria-label={t("移除 {{n}} 日", { n: day })}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleMonthday(day);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        toggleMonthday(day);
                      }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </span>
                  )}
                </span>
              ))}
            </div>
            {selectedMonthdays.length > 1 && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onMonthdays([selectedMonthdays[0] ?? 1]);
                }}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-black/45 transition hover:bg-black/[0.04] hover:text-black/70"
                aria-label={t("清空")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <ChevronDown className="pointer-events-none absolute right-3 top-4 h-4 w-4 -translate-y-1/2 text-black/80" />
          {monthdayPickerOpen && (
            <div
              className="absolute left-0 top-[calc(100%+6px)] z-10 max-h-[204px] w-[276px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-xl border border-black/10 bg-white p-2 shadow-xl"
              role="listbox"
              aria-multiselectable="true"
            >
              <div className="grid grid-cols-4 gap-1.5">
                {MONTHDAY_VALUES.map((day) => {
                  const checked = selectedMonthdays.includes(day);
                  const isLastSelected = checked && selectedMonthdays.length === 1;
                  return (
                    <button
                      key={day}
                      type="button"
                      onClick={() => toggleMonthday(day)}
                      disabled={isLastSelected}
                      className={
                        "flex h-8 items-center justify-center rounded-md border text-xs font-medium transition " +
                        (checked
                          ? "border-black bg-black text-white"
                          : isLastSelected
                            ? "cursor-not-allowed border-black/10 bg-black/[0.02] text-black/35"
                            : "border-black/10 bg-white text-black/60 hover:border-black/20 hover:bg-black/[0.03] hover:text-black/80")
                      }
                      role="option"
                      aria-selected={checked}
                      title={isLastSelected ? t("至少保留 1 天") : undefined}
                    >
                      {t("{{n}}日", { n: day })}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {period !== "daily" && (
        <input
          type="time"
          value={time}
          onChange={(e) => onTime(e.target.value)}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="h-8 w-[100px] rounded-md border border-black/10 bg-white px-3 py-1.5 text-sm focus:border-black/30 focus:outline-none"
        />
      )}
    </div>
  );
}

function IntervalPicker({
  num,
  unit,
  weekdays,
  weekdaysDisabled,
  onNum,
  onUnit,
  onWeekdays,
}: {
  num: number;
  unit: "m" | "h" | "d";
  weekdays: number[];
  weekdaysDisabled?: boolean;
  onNum: (v: number) => void;
  onUnit: (v: "m" | "h" | "d") => void;
  onWeekdays: (v: number[]) => void;
}) {
  const t = useT();
  const weekdayLabels = getWeekdayLabels(t);
  const selectedWeekdays = normalizeIntervalWeekdays(weekdays);
  const [unitPickerOpen, setUnitPickerOpen] = useState(false);
  const [hoveredInactiveTooltipDay, setHoveredInactiveTooltipDay] = useState<number | null>(null);
  const [suppressedInactiveTooltipDay, setSuppressedInactiveTooltipDay] = useState<number | null>(null);
  const unitPickerRef = useRef<HTMLDivElement | null>(null);
  const unitOptions: Array<{ value: IntervalUnit; label: string }> = [
    { value: "m", label: t("分钟") },
    { value: "h", label: t("小时") },
    { value: "d", label: t("天") },
  ];
  const unitLabel = unitOptions.find((option) => option.value === unit)?.label ?? t("小时");
  useEffect(() => {
    if (!unitPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (unitPickerRef.current?.contains(target)) return;
      setUnitPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [unitPickerOpen]);
  const toggleWeekday = useCallback((day: number) => {
    if (weekdaysDisabled) return;
    if (selectedWeekdays.length === 1 && selectedWeekdays[0] === day) return;
    const isCurrentlySelected = selectedWeekdays.includes(day);
    const next = selectedWeekdays.includes(day)
      ? selectedWeekdays.filter((v) => v !== day)
      : [...selectedWeekdays, day];
    setSuppressedInactiveTooltipDay(isCurrentlySelected ? day : null);
    setHoveredInactiveTooltipDay(null);
    onWeekdays(normalizeIntervalWeekdays(next));
  }, [onWeekdays, selectedWeekdays, weekdaysDisabled]);
  const weekdayButtons = (
    <div
      className={`ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left text-sm ${weekdaysDisabled ? "opacity-50" : ""
        }`}
      style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
    >
      {WEEKDAY_VALUES.map((day) => {
        const checked = selectedWeekdays.includes(day);
        const isLastSelected = checked && selectedWeekdays.length === 1;
        const suppressInactiveTooltip = suppressedInactiveTooltipDay === day;
        const showInactiveTooltip = !checked && !weekdaysDisabled && !suppressInactiveTooltip && hoveredInactiveTooltipDay === day;
        const inactiveTooltip = t("{{weekday}}不执行", { weekday: weekdayLabels[day] });
        return (
          <span
            key={day}
            className="group relative inline-flex"
            onMouseEnter={() => {
              if (!checked && !weekdaysDisabled && !suppressInactiveTooltip) setHoveredInactiveTooltipDay(day);
            }}
            onMouseLeave={() => {
              if (hoveredInactiveTooltipDay === day) setHoveredInactiveTooltipDay(null);
              if (suppressedInactiveTooltipDay === day) setSuppressedInactiveTooltipDay(null);
            }}
          >
            <button
              type="button"
              disabled={weekdaysDisabled || isLastSelected}
              onClick={() => toggleWeekday(day)}
              style={{ fontSize: "13px", lineHeight: "17px" }}
              className={
                "group inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-normal leading-none transition " +
                (checked
                  ? "bg-black text-white"
                  : "border border-black/10 bg-black/[0.04] text-black/45 hover:bg-black/[0.08] hover:text-black/65") +
                (isLastSelected ? " cursor-not-allowed" : "")
              }
              title={isLastSelected ? t("至少保留 1 天") : undefined}
            >
              {weekdayLabels[day]}
              {checked && selectedWeekdays.length > 1 && !weekdaysDisabled && (
                <X className="h-2.5 w-0 overflow-hidden text-white/80 opacity-0 transition-all group-hover:-mr-1 group-hover:w-2.5 group-hover:opacity-100 group-focus-visible:-mr-1 group-focus-visible:w-2.5 group-focus-visible:opacity-100" />
              )}
            </button>
            {showInactiveTooltip && (
              <span
                className="pointer-events-auto absolute left-1/2 top-[calc(100%+6px)] z-[30] inline-flex -translate-x-1/2 select-text whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-2 py-1 text-[11px] font-medium leading-none text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)]"
                role="tooltip"
              >
                {inactiveTooltip}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-black/60" style={MODAL_COMPACT_CONTROL_TEXT_STYLE}>{t("每")}</span>
        <input
          type="number"
          min={1}
          value={num}
          onChange={(e) => onNum(Math.max(1, Number(e.target.value) || 1))}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="h-8 w-16 rounded-md border border-black/10 bg-white px-3 py-1.5 text-sm focus:border-black/30 focus:outline-none"
        />
        <div ref={unitPickerRef} className="relative w-[76px]">
          <button
            type="button"
            onClick={() => setUnitPickerOpen((open) => !open)}
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
            className="flex h-8 w-full items-center justify-between rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-left text-sm focus:border-black/30 focus:outline-none"
            aria-haspopup="listbox"
            aria-expanded={unitPickerOpen}
          >
            <span>{unitLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 text-black/80" />
          </button>
          {unitPickerOpen && (
            <div
              className="absolute left-0 top-[calc(100%+6px)] z-10 w-[92px] rounded-xl border border-black/10 bg-white p-1.5 shadow-xl"
              role="listbox"
            >
              {unitOptions.map((option) => {
                const checked = option.value === unit;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onUnit(option.value);
                      setUnitPickerOpen(false);
                    }}
                    style={{ fontSize: "14px", lineHeight: "22px" }}
                    className={
                      "flex w-full items-center justify-between rounded-lg px-3 py-2 transition " +
                      (checked
                        ? "bg-black text-white"
                        : "text-black/70 hover:bg-black/[0.04] hover:text-black")
                    }
                    role="option"
                    aria-selected={checked}
                  >
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {weekdayButtons}
      </div>
    </div>
  );
}

type OncePickerDraft = {
  date: string;
  hour: string;
  minute: string;
  month: Date;
};

function formatLocalDateInputValue(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseOncePickerDraft(value: string): OncePickerDraft {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  const fallback = new Date();
  const year = match ? Number(match[1]) : fallback.getFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : fallback.getMonth();
  const day = match ? Number(match[3]) : fallback.getDate();
  const candidate = new Date(year, monthIndex, day);
  const validDate = candidate.getFullYear() === year
    && candidate.getMonth() === monthIndex
    && candidate.getDate() === day;
  const date = validDate ? candidate : fallback;
  const hour = match && CLOCK_HOUR_OPTIONS.includes(match[4] ?? "")
    ? match[4]!
    : String(fallback.getHours()).padStart(2, "0");
  const minute = match && CLOCK_MINUTE_OPTIONS.includes(match[5] ?? "")
    ? match[5]!
    : String(fallback.getMinutes()).padStart(2, "0");

  return {
    date: formatLocalDateInputValue(date),
    hour,
    minute,
    month: new Date(date.getFullYear(), date.getMonth(), 1),
  };
}

function getCalendarGridDays(month: Date): Date[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(firstDay.getFullYear(), firstDay.getMonth(), 1 - firstDay.getDay());
  return Array.from({ length: 42 }, (_, index) => (
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
  ));
}

type OncePickerInputSegments = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
};

function getOncePickerInputSegments(value: string): OncePickerInputSegments {
  const draft = parseOncePickerDraft(value);
  const [year, month, day] = draft.date.split("-");
  return {
    year: year ?? "",
    month: month ?? "",
    day: day ?? "",
    hour: draft.hour,
    minute: draft.minute,
  };
}

function parseOncePickerInputSegments(segments: OncePickerInputSegments): string | null {
  const year = Number(segments.year);
  const monthIndex = Number(segments.month) - 1;
  const day = Number(segments.day);
  const hour = Number(segments.hour);
  const minute = Number(segments.minute);
  const candidate = new Date(year, monthIndex, day);
  const validDate = segments.year.length === 4
    && segments.month.length > 0
    && segments.day.length > 0
    && candidate.getFullYear() === year
    && candidate.getMonth() === monthIndex
    && candidate.getDate() === day;
  if (
    !validDate
    || segments.hour.length === 0
    || segments.minute.length === 0
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
  ) return null;

  return `${formatLocalDateInputValue(candidate)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function OncePickerInputSegment({
  label,
  value,
  maxLength,
  className,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  className: string;
  onChange: (value: string) => void;
}) {
  const replaceOnNextDigitRef = useRef(false);

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={value}
      maxLength={maxLength}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, maxLength))}
      onFocus={(event) => {
        replaceOnNextDigitRef.current = true;
        event.currentTarget.select();
      }}
      onClick={(event) => {
        replaceOnNextDigitRef.current = true;
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (!replaceOnNextDigitRef.current || !/^\d$/.test(event.key)) return;
        event.preventDefault();
        replaceOnNextDigitRef.current = false;
        onChange(event.key);
      }}
      spellCheck={false}
      className={cn(
        "h-7 rounded px-0.5 text-center text-sm tabular-nums outline-none focus:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-500/25",
        className,
      )}
    />
  );
}

function OncePickerTimeColumn({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedOptionRef = useRef<HTMLButtonElement | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    const selectedOption = selectedOptionRef.current;
    if (!list || !selectedOption) return;
    const listRect = list.getBoundingClientRect();
    const optionRect = selectedOption.getBoundingClientRect();
    list.scrollTop += optionRect.top - listRect.top - (list.clientHeight - optionRect.height) / 2;
  }, [value]);

  const moveSelection = useCallback((nextIndex: number) => {
    const boundedIndex = Math.max(0, Math.min(options.length - 1, nextIndex));
    const nextValue = options[boundedIndex];
    if (!nextValue) return;
    onChange(nextValue);
    const focusNextOption = () => {
      const nextOption = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-time-option-index="${boundedIndex}"]`,
      );
      nextOption?.focus();
    };
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(focusNextOption);
    } else {
      window.setTimeout(focusNextOption, 0);
    }
  }, [onChange, options]);

  return (
    <div className="min-w-0">
      <div className="mb-1.5 text-center text-xs font-medium text-black/45">{label}</div>
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="h-52 overscroll-contain overflow-y-auto rounded-lg pr-1"
      >
        {options.map((option, index) => {
          const isSelected = option === value;
          return (
            <button
              key={option}
              ref={isSelected ? selectedOptionRef : undefined}
              type="button"
              role="option"
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              data-time-option-index={index}
              onClick={() => onChange(option)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveSelection(index + 1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(index - 1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  moveSelection(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  moveSelection(options.length - 1);
                }
              }}
              className={cn(
                "flex h-8 w-full items-center justify-center rounded-md text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30",
                isSelected
                  ? "bg-black/[0.06] text-black"
                  : "text-black/80 hover:bg-black/[0.035]",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OncePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT();
  const { i18n } = useTranslation();
  const selectedDayRef = useRef<HTMLButtonElement | null>(null);
  const initialDraft = useMemo(() => parseOncePickerDraft(value), [value]);
  const [inputSegments, setInputSegments] = useState(() => getOncePickerInputSegments(value));
  const [open, setOpen] = useState(false);
  const [draftDate, setDraftDate] = useState(initialDraft.date);
  const [draftHour, setDraftHour] = useState(initialDraft.hour);
  const [draftMinute, setDraftMinute] = useState(initialDraft.minute);
  const [visibleMonth, setVisibleMonth] = useState(initialDraft.month);
  const displayLocale = getAutomationDisplayLocale(i18n.language);
  const calendarDays = useMemo(() => getCalendarGridDays(visibleMonth), [visibleMonth]);
  const monthLabel = useMemo(() => new Intl.DateTimeFormat(displayLocale, {
    year: "numeric",
    month: "long",
  }).format(visibleMonth), [displayLocale, visibleMonth]);
  const fullDateFormatter = useMemo(() => new Intl.DateTimeFormat(displayLocale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }), [displayLocale]);
  const weekdayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(displayLocale, { weekday: "narrow" });
    return Array.from({ length: 7 }, (_, index) => formatter.format(new Date(2024, 0, 7 + index)));
  }, [displayLocale]);

  useEffect(() => {
    setInputSegments(getOncePickerInputSegments(value));
  }, [value]);

  const resetDraft = useCallback((nextValue = value) => {
    const next = parseOncePickerDraft(nextValue);
    setDraftDate(next.date);
    setDraftHour(next.hour);
    setDraftMinute(next.minute);
    setVisibleMonth(next.month);
  }, [value]);

  const commitInputSegments = useCallback(() => {
    const nextValue = parseOncePickerInputSegments(inputSegments);
    if (!nextValue) {
      setInputSegments(getOncePickerInputSegments(value));
      return value;
    }
    setInputSegments(getOncePickerInputSegments(nextValue));
    if (nextValue !== value) onChange(nextValue);
    return nextValue;
  }, [inputSegments, onChange, value]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) resetDraft(commitInputSegments());
    setOpen(nextOpen);
  }, [commitInputSegments, resetDraft]);

  const updateInputSegment = useCallback((segment: keyof OncePickerInputSegments, nextValue: string) => {
    setInputSegments((current) => ({ ...current, [segment]: nextValue }));
  }, []);

  const changeMonth = useCallback((offset: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }, []);

  const todayValue = formatLocalDateInputValue(new Date());

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverAnchor asChild>
        <div
          role="group"
          aria-label={t("执行时间")}
          onBlur={(event) => {
            const inputGroup = event.currentTarget;
            window.setTimeout(() => {
              if (!inputGroup.contains(document.activeElement)) commitInputSegments();
            }, 0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.target.blur();
            }
          }}
          tabIndex={-1}
          className="flex h-9 w-[220px] max-w-full items-center rounded-md border border-black/10 bg-white transition hover:border-black/20 focus-within:border-black/30 focus-within:ring-2 focus-within:ring-blue-500/20"
        >
          <div className="flex min-w-0 flex-1 items-center px-2">
            <OncePickerInputSegment
              label={`${t("执行时间")} YYYY`}
              value={inputSegments.year}
              maxLength={4}
              className="w-10"
              onChange={(nextValue) => updateInputSegment("year", nextValue)}
            />
            <span aria-hidden="true" className="text-sm text-black/55">/</span>
            <OncePickerInputSegment
              label={`${t("执行时间")} MM`}
              value={inputSegments.month}
              maxLength={2}
              className="w-7"
              onChange={(nextValue) => updateInputSegment("month", nextValue)}
            />
            <span aria-hidden="true" className="text-sm text-black/55">/</span>
            <OncePickerInputSegment
              label={`${t("执行时间")} DD`}
              value={inputSegments.day}
              maxLength={2}
              className="w-7"
              onChange={(nextValue) => updateInputSegment("day", nextValue)}
            />
            <span aria-hidden="true" className="w-2" />
            <OncePickerInputSegment
              label={`${t("执行时间")} HH`}
              value={inputSegments.hour}
              maxLength={2}
              className="w-7"
              onChange={(nextValue) => updateInputSegment("hour", nextValue)}
            />
            <span aria-hidden="true" className="text-sm text-black/55">:</span>
            <OncePickerInputSegment
              label={`${t("执行时间")} mm`}
              value={inputSegments.minute}
              maxLength={2}
              className="w-7"
              onChange={(nextValue) => updateInputSegment("minute", nextValue)}
            />
          </div>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={t("选择")}
              className="mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-black/75 transition hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
            >
              <CalendarDays className="size-4" aria-hidden="true" />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        role="dialog"
        aria-label={t("执行时间")}
        className="z-[210] max-h-[var(--radix-popover-content-available-height)] w-[420px] max-w-[calc(100vw-32px)] overscroll-contain overflow-y-auto p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          selectedDayRef.current?.focus();
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_144px]">
          <div className="p-2">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-sm font-semibold text-black/85">{monthLabel}</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={t("上一页")}
                  onClick={() => changeMonth(-1)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-black/60 transition hover:bg-black/[0.05] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={t("下一页")}
                  onClick={() => changeMonth(1)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-black/60 transition hover:bg-black/[0.05] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 gap-0.5" aria-hidden="true">
              {weekdayLabels.map((label, index) => (
                <span key={`${label}-${index}`} className="flex h-6 items-center justify-center text-xs text-black/45">
                  {label}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {calendarDays.map((date) => {
                const dateValue = formatLocalDateInputValue(date);
                const isSelected = dateValue === draftDate;
                const isCurrentMonth = date.getMonth() === visibleMonth.getMonth();
                const isToday = dateValue === todayValue;
                return (
                  <button
                    key={dateValue}
                    ref={isSelected ? selectedDayRef : undefined}
                    type="button"
                    aria-label={fullDateFormatter.format(date)}
                    aria-pressed={isSelected}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => {
                      setDraftDate(dateValue);
                      if (!isCurrentMonth) {
                        setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1));
                      }
                    }}
                    className={cn(
                      "inline-flex size-8 items-center justify-center rounded-md text-sm tabular-nums transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/35",
                      isSelected
                        ? "bg-[#2F7BFF] font-semibold text-white hover:bg-[#276FE8]"
                        : isCurrentMonth
                          ? "text-black/80 hover:bg-black/[0.05]"
                          : "text-black/30 hover:bg-black/[0.04]",
                      isToday && !isSelected ? "font-semibold text-[#245FCE]" : "",
                    )}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 border-t border-black/[0.06] p-2 sm:border-l sm:border-t-0">
            <OncePickerTimeColumn
              label={t("小时")}
              options={CLOCK_HOUR_OPTIONS}
              value={draftHour}
              onChange={setDraftHour}
            />
            <OncePickerTimeColumn
              label={t("分钟")}
              options={CLOCK_MINUTE_OPTIONS}
              value={draftMinute}
              onChange={setDraftMinute}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] p-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm font-medium text-black/75 transition hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={() => {
              onChange(`${draftDate}T${draftHour}:${draftMinute}`);
              setOpen(false);
            }}
            className="inline-flex h-8 items-center justify-center rounded-md bg-black px-3 text-sm font-medium text-white transition hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 focus-visible:ring-offset-2"
          >
            {t("确认")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 把表单状态拼成 hermes cron 接受的 schedule 字符串。
 *
 * - recurring → cron 表达式：`min hour [DOM] [MON] [DOW]`
 * - interval  → `every Nm` / `every Nh` / `every Nd`
 * - once      → ISO 8601 时间戳（不带时区，hermes 按本地时间解析）
 */
export function buildScheduleString(args: {
  kind: FrequencyKind;
  period: RecurringPeriod;
  time: string;
  dailyTimes?: string[];
  weekdays?: number[];
  weekday?: number;
  monthday?: number;
  monthdays?: number[];
  intervalNum: number;
  intervalUnit: "m" | "h" | "d";
  onceDate: string;
}): string {
  if (args.kind === "interval") {
    return `every ${Math.max(1, args.intervalNum)}${args.intervalUnit}`;
  }
  if (args.kind === "once") {
    return args.onceDate;
  }
  const [hh = "0", mm = "0"] = args.time.split(":");
  const h = Number(hh);
  const m = Number(mm);
  if (args.period === "daily") {
    const dailyTimes = normalizeDailyTimes(args.dailyTimes, args.time);
    // 多时间点（dailyTimes.length > 1）只能让 cron 每分钟唤一次，再由
    // lightvela-effective-window-*.py 这个 pre-run 脚本里的 ALLOWED_DAILY_TIMES
    // 按 now.strftime("%H:%M") 精确匹配过滤——cron 表达式本身只能表达
    // "m h * * *" 这种单维分钟+单维小时，无法表达 "{09:00, 12:30, 18:45}"
    // 这种任意 H:M 集合（用 "0,30 9,12,18 * * *" 笛卡尔积会触发非期望
    // 的 09:30 / 12:00 等组合）。所以多时间点必须 cron + 脚本 gate 联动，
    // 后端不需要任何改动；脚本性能契约见 buildEffectiveWindowScript 头注释。
    if (dailyTimes.length > 1) return "* * * * *";
    return `${m} ${h} * * *`;
  }
  if (args.period === "weekly") {
    const weekdays = normalizeWeekdays(args.weekdays ?? [args.weekday ?? 1]);
    // cron 输出走升序（0~6），UI 顺序（周一开头）跟 cron 字符串顺序解耦，
    // 避免老式 cron 解析器对 "1,0" 这种非升序逗号列表的兼容问题
    const sortedForCron = [...weekdays].sort((a, b) => a - b);
    return `${m} ${h} * * ${sortedForCron.join(",")}`;
  }
  const monthdays = normalizeMonthdays(args.monthdays ?? [args.monthday ?? 1]);
  return `${m} ${h} ${monthdays.join(",")} * *`;
}

export function isScheduleEffectivelyChanged(args: ScheduleChangeCheck): boolean {
  if (args.mode === "create") return true;
  if (args.scheduleUneditable) return false;
  if (args.kind === "once") {
    if (args.initialOnceDate) return args.onceDate !== args.initialOnceDate;
    return args.schedule !== args.originalSchedule;
  }
  return args.schedule !== args.originalSchedule;
}

export function shouldRejectPastOnceSchedule(args: ScheduleChangeCheck & { now: number }): boolean {
  if (args.scheduleUneditable || args.kind !== "once") return false;
  if (!isScheduleEffectivelyChanged(args)) return false;
  const t0 = parseCronDate(args.onceDate).getTime();
  return !Number.isNaN(t0) && t0 <= args.now;
}

/**
 * 反向解析 schedule 字符串为表单初始值（编辑场景）。
 * 解析失败返回 null，调用方走默认值。
 */
export function parseInitialSchedule(display: string): {
  kind: FrequencyKind;
  period?: RecurringPeriod;
  time?: string;
  times?: string[];
  weekday?: number;
  weekdays?: number[];
  monthday?: number;
  monthdays?: number[];
  intervalNum?: number;
  intervalUnit?: "m" | "h" | "d";
  onceDate?: string;
} | null {
  if (!display) return null;
  const lower = display.toLowerCase().trim();

  // interval
  const intervalMatch = /^every\s+(\d+)\s*([mhd])$/.exec(lower);
  if (intervalMatch) {
    return {
      kind: "interval",
      intervalNum: Number(intervalMatch[1]),
      intervalUnit: intervalMatch[2] as "m" | "h" | "d",
    };
  }

  // once：'once at YYYY-MM-DD HH:MM' 或 ISO timestamp
  const onceMatch = /^once\s+at\s+(\d{4}-\d{2}-\d{2})[ tT](\d{2}:\d{2})/.exec(display.trim());
  if (onceMatch) {
    return { kind: "once", onceDate: `${onceMatch[1]}T${onceMatch[2]}` };
  }
  const isoMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(display.trim());
  if (isoMatch) {
    return { kind: "once", onceDate: `${isoMatch[1]}T${isoMatch[2]}` };
  }

  // cron: min hour DOM MON DOW
  const cronMatch = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(display.trim());
  if (cronMatch) {
    const [, mn, hr, dom, mon, dow] = cronMatch;
    if (!/^\d+$/.test(mn ?? "") || !/^\d+$/.test(hr ?? "")) return null;
    const time = `${String(hr).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
    if (dom === "*" && mon === "*" && dow === "*") {
      return { kind: "recurring", period: "daily", time };
    }
    if (dom === "*" && mon === "*") {
      const weekdays = parseCronWeekdays(dow ?? "");
      if (weekdays.length > 0) {
        return { kind: "recurring", period: "weekly", time, weekday: weekdays[0], weekdays };
      }
    }
    if (mon === "*" && dow === "*") {
      const monthdays = parseCronMonthdays(dom ?? "");
      if (monthdays.length > 0) {
        return { kind: "recurring", period: "monthly", time, monthday: monthdays[0], monthdays };
      }
    }
  }

  return null;
}

/**
 * 反向解析 deliver 字符串。
 * - "local" / "" → 不通知
 * - "feishu" → 平台多选含 feishu
 * - "feishu:oc_xxx,weixin" → 平台 + chat_id 解析
 * - "origin:xxx" / 未知平台 → 原样保留，避免编辑时丢失 CLI 创建任务的通知目标
 */
export function parseInitialDeliver(deliver: string): {
  platforms: string[];
  chatIds: Record<string, string>;
} {
  const empty = { platforms: [] as string[], chatIds: {} as Record<string, string> };
  if (!deliver || deliver === "local") return empty;
  const platforms: string[] = [];
  const chatIds: Record<string, string> = {};
  for (const raw of deliver.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const idx = tok.indexOf(":");
    const platform = (idx >= 0 ? tok.slice(0, idx) : tok).trim();
    const chatId = idx >= 0 ? tok.slice(idx + 1).trim() : "";
    if (!platform || platform === "local") continue;
    if (!platforms.includes(platform)) platforms.push(platform);
    if (chatId) chatIds[platform] = chatId;
  }
  return { platforms, chatIds };
}

export function buildDeliverString(platforms: string[], chatIds: Record<string, string>): string {
  if (platforms.length === 0) return "local";
  return platforms
    .map((platform) => {
      const chatId = (chatIds[platform] || "").trim();
      return chatId ? `${platform}:${chatId}` : platform;
    })
    .join(",");
}

export function buildHermesSendTarget(platform: string, chatId: string): string {
  const normalizedPlatform = platform.trim();
  const normalizedChatId = chatId.trim();
  return normalizedChatId ? `${normalizedPlatform}:${normalizedChatId}` : normalizedPlatform;
}

export function buildHermesSendCommand(platform: string, chatId: string, message: string): string {
  const target = shellQuote(buildHermesSendTarget(platform, chatId));
  const payload = shellQuote(message);
  const directSend = `${["hermes", "send", "--to", target, payload].join(" ")} 2>&1`;
  const directCommand = [
    `output=$(${directSend})`,
    "status=$?",
    "printf '%s\\n' \"$output\"",
    "if [ $status -ne 0 ]; then exit $status; fi",
  ].join("; ");
  const legacyPayload = JSON.stringify({ action: "send", target: buildHermesSendTarget(platform, chatId), message });
  const legacyScript = [
    "import json, os, sys",
    "from pathlib import Path",
    "from dotenv import load_dotenv",
    "home = Path(os.environ.get('HERMES_HOME') or (Path.home() / '.hermes'))",
    "load_dotenv(str(home / '.env'), override=True)",
    "from tools.send_message_tool import send_message_tool",
    `result = send_message_tool(${legacyPayload})`,
    "print(result)",
    "payload = json.loads(result) if isinstance(result, str) else result",
    "sys.exit(1 if isinstance(payload, dict) and payload.get('error') else 0)",
  ].join("; ");
  const legacyCommand = [
    "cd \"$HOME/.hermes/hermes-agent\"",
    "&&",
    "\"$HOME/.hermes/hermes-agent/venv/bin/python\"",
    "-c",
    shellQuote(legacyScript),
  ].join(" ");
  return `if hermes send --help >/dev/null 2>&1; then ${directCommand}; else ${legacyCommand}; fi`;
}

export function buildHermesSendTestCommand(platform: string, chatId: string, message: string): string {
  return buildHermesSendCommand(platform, chatId, message);
}

type HermesChannelStatusEntry = {
  channel?: string;
  enabled: boolean;
  value?: string;
};

function parseJsonObjectFromCommandOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function parseHermesChannelStatusEntries(output: string): HermesChannelStatusEntry[] {
  const payload = parseJsonObjectFromCommandOutput(output);
  if (!payload || typeof payload !== "object") return [];

  const root = payload as {
    channels?: unknown;
    data?: {
      channels?: unknown;
      platforms?: unknown;
    };
    platforms?: unknown;
  };
  const rawEntries = normalizeHermesChannelStatusCollection(
    root.data?.platforms ?? root.data?.channels ?? root.platforms ?? root.channels,
  );

  return rawEntries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      channel?: unknown;
      enabled?: unknown;
      name?: unknown;
      status?: unknown;
      value?: unknown;
    };
    const channel = typeof item.channel === "string"
      ? item.channel
      : typeof item.name === "string"
        ? item.name
        : typeof item.value === "string"
          ? item.value
          : "";
    if (!channel) return [];

    const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
    const enabled = item.enabled === true || ["connected", "enabled", "running", "ready"].includes(status);
    return [{ channel, enabled, value: typeof item.value === "string" ? item.value : channel }];
  });
}

function normalizeHermesChannelStatusCollection(collection: unknown): unknown[] {
  if (Array.isArray(collection)) return collection;
  if (!collection || typeof collection !== "object") return [];
  return Object.entries(collection as Record<string, unknown>).map(([name, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { name, ...(value as Record<string, unknown>) };
    }
    return {
      name,
      enabled: value === true,
      status: typeof value === "string" ? value : undefined,
      value: typeof value === "string" ? value : name,
    };
  });
}

export function parseEnabledHermesChannels(output: string): Set<string> {
  const entries = parseHermesChannelStatusEntries(output);
  return new Set(
    entries
      .filter((entry) => entry.enabled)
      .map((entry) => normalizeHermesChannelKey(entry.channel ?? entry.value ?? "")),
  );
}

export function isHermesNotificationChannelConfigured(
  enabledChannels: Set<string> | null,
  key: string,
  comingSoon = false,
): boolean {
  if (comingSoon) return false;
  if (enabledChannels === null) return true;
  return enabledChannels.has(key);
}

export function formatTestSendError(
  error: unknown,
  fallback: string,
  t?: (s: string, vars?: Record<string, unknown>) => string,
): string {
  const raw = error instanceof CronCommandError
    ? error.output || error.message
    : error instanceof Error
      ? error.message
      : String(error);
  const message = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join("；");
  if (!message) return fallback;
  const formatted = formatKnownTestSendError(message, t);
  return formatted ? joinTestSendError(fallback, formatted) : fallback;
}

export function getTestSendFailureFallback(
  platform: string,
  fallback: string,
  weixinFallback: string,
  wecomFallback: string = fallback,
): string {
  const key = normalizeHermesChannelKey(platform);
  if (key === "weixin") return weixinFallback;
  if (key === "wecom") return wecomFallback;
  return fallback;
}

function formatKnownTestSendError(message: string, t?: (s: string, vars?: Record<string, unknown>) => string): string {
  const stderr = extractCommandFailureField(message, "stderr");
  if (stderr) return formatKnownTestSendError(stderr, t);
  const error = extractCommandFailureField(message, "error");
  if (error) return formatKnownTestSendError(error, t);
  const stdout = extractCommandFailureField(message, "stdout");
  if (stdout) return formatKnownTestSendError(stdout, t);
  if (/command\s+timed\s+out/i.test(message)) return t ? t("命令执行超时") : "命令执行超时";
  const unknownPlatform = message.match(/unknown platform:?\s*(.+)$/i);
  if (unknownPlatform?.[1]) {
    const platform = unknownPlatform[1].trim();
    return t ? t("未知通知通道：{{platform}}", { platform }) : `未知通知通道：${platform}`;
  }
  if (/command\s+not\s+found|not found/i.test(message)) return "";
  if (/permission denied/i.test(message)) return t ? t("实例内命令执行权限不足") : "实例内命令执行权限不足";
  return "";
}

function extractCommandFailureField(message: string, field: "stderr" | "stdout" | "error"): string {
  const match = new RegExp(`${field}=([\\s\\S]+?)(?=\\s+(?:stdout|stderr|error)=|$)`, "i").exec(message);
  return match?.[1]?.trim() ?? "";
}

function joinTestSendError(fallback: string, detail: string): string {
  const separator = getTestSendErrorSeparator(fallback, detail);
  const normalizedFallback = separator === ": " ? fallback.replace(/[.。]\s*$/, "") : fallback;
  return `${normalizedFallback}${separator}${detail}`;
}

function getTestSendErrorSeparator(fallback: string, detail: string): string {
  return CHINESE_TEXT_RE.test(fallback) || CHINESE_TEXT_RE.test(detail) ? "：" : ": ";
}

function normalizeHermesChannelKey(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (["wechat", "weixin", "openclaw-weixin", "openclaw-wechat"].includes(normalized)) return "weixin";
  if (["qq", "qqbot", "qq-bot", "qqbotplugin", "openclaw-qqbot", "openclaw-qq"].includes(normalized)) return "qqbot";
  if (["wecom", "wework", "work-weixin", "work-wechat", "openclaw-wecom"].includes(normalized)) return "wecom";
  if (["dingtalk", "openclaw-dingtalk"].includes(normalized)) return "dingtalk";
  if (["feishu", "lark", "larksuite", "openclaw-feishu", "openclaw-lark"].includes(normalized)) return "feishu";
  if (["telegram", "tg", "openclaw-telegram", "openclaw-tg"].includes(normalized)) return "telegram";
  if (["whatsapp", "whats-app", "whatsapp-business", "whatsapp_business", "openclaw-whatsapp"].includes(normalized)) return "whatsapp";
  if (["discord", "openclaw-discord"].includes(normalized)) return "discord";
  if (["slack", "openclaw-slack"].includes(normalized)) return "slack";
  return normalized;
}
