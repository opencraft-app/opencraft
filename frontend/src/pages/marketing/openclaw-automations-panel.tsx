/**
 * 自动化任务（Hermes Cron）面板
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

import { AlertTriangle, Activity, BellRing, BriefcaseBusiness, CalendarRange, ChevronDown, CircleHelp, Clock, Droplets, Eraser, Eye, FolderKanban, LayoutTemplate, Loader2, Newspaper, Pause, Pencil, Play, Plus, RefreshCw, Sunrise, Trash2, TrendingUp, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseHermesChannelList } from "@tencent/tea-sdk-lightclaw";
import { useT } from "@/i18n/t";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { isGlobal } from "@/lib/region";
import {
  AUTH_UNAUTHORIZED_EVENT,
  readStoredAuthToken,
  writeStoredAuthToken,
} from "@/repositories/http-repositories";
import {
  CronCommandError,
  createCronJobWithScriptRollback,
  createEffectiveWindowScriptName,
  editCronJob,
  listCronJobs,
  listRecentCronRuns,
  pauseCronJob,
  writeEffectiveWindowScript,
  removeCronJob,
  resumeCronJob,
  type CronEffectiveWindow,
  type CronJob,
  type CronRunRecord,
} from "@/lib/hermes-cron-client";

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

/** 顶部红色 toast；与 settings 主页 SkillInstallToast 视觉一致 */
function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  const t = useT();
  return createPortal(
    <div className="fixed inset-x-0 top-4 z-[300] flex justify-center px-4" role="status" aria-live="polite">
      <div className="inline-flex max-w-[min(92vw,720px)] items-center gap-2 rounded-full bg-[#B91C1C] px-4 py-2 text-sm font-medium text-white shadow-lg">
        <AlertTriangle className="h-4 w-4 shrink-0" />
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
      className={`pointer-events-auto fixed z-[260] max-w-[min(360px,calc(100vw-32px))] -translate-x-1/2 -translate-y-full select-text rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] shadow-[0_8px_24px_rgba(15,23,42,0.12)] ${className}`}
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
          className="whitespace-nowrap"
          onMouseEnter={showTooltip}
          onMouseLeave={scheduleClose}
        >
          {message}
        </FloatingTooltip>
      )}
    </span>
  );
}

export function AutomationsPanel({ botId }: { botId: string | null }) {
  const t = useT();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingRecentRuns, setLoadingRecentRuns] = useState(false);
  const [recentRuns, setRecentRuns] = useState<CronRunRecord[]>([]);
  const [activeView, setActiveView] = useState<"created" | "recent">("created");
  const [creating, setCreating] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingFromTemplate, setCreatingFromTemplate] = useState<AutomationTemplate | null>(null);
  const [pendingCreateMode, setPendingCreateMode] = useState<"blank" | "template" | null>(null);
  const [confirmCreateOverLimit, setConfirmCreateOverLimit] = useState(false);
  const [viewingJob, setViewingJob] = useState<CronJob | null>(null);
  /** 正在编辑的 job；非空时弹编辑表单 */
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  /** 待确认删除的 job；非空时弹确认弹窗 */
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<CronJob | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** 列表加载失败的 inline 错误（与 toast 分离：list 失败不 toast，避免首屏刷屏） */
  const [listError, setListError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const jobsRef = useRef<CronJob[]>([]);
  const visibleJobs = useMemo(() => jobs.filter((job) => !isCronJobExpiredBeyondGrace(job)), [jobs]);
  const jobLimitReached = visibleJobs.length >= MAX_CRON_JOBS_PER_BOT;
  const templates = useMemo(() => getAutomationTemplates(t), [t]);

  const requestCreate = useCallback((mode: "blank" | "template") => {
    if (jobLimitReached) {
      setPendingCreateMode(mode);
      setConfirmCreateOverLimit(true);
      return;
    }
    if (mode === "template") setTemplatePickerOpen(true);
    else setCreating(true);
  }, [jobLimitReached]);

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
      const list = await listCronJobs(botId);
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

  const refreshRecentRuns = useCallback(async (currentJobs?: CronJob[], manageLoading = true) => {
    if (!botId) {
      setRecentRuns([]);
      return;
    }
    if (manageLoading) setLoadingRecentRuns(true);
    try {
      const runs = await listRecentCronRuns(botId, currentJobs ?? jobsRef.current, 10);
      setRecentRuns(runs);
    } catch {
      setRecentRuns([]);
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

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const handleAction = useCallback(async (
    job: CronJob,
    action: "pause" | "resume" | "remove",
  ) => {
    if (!botId) return;
    setBusyId(job.id);
    try {
      if (action === "pause") await pauseCronJob(botId, job.id);
      else if (action === "resume") await resumeCronJob(botId, job.id);
      else await removeCronJob(botId, job.id);
      await refreshAll();
    } catch (err) {
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
  }, [botId, refreshAll, showError, t]);

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

      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-black/90">{t("自动任务")}</h3>
          <p className="mt-0.5 text-xs text-black/50">
            {t("让你的智能体伙伴按计划自动执行任务")}
          </p>
        </div>
        <div className="inline-flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => requestCreate("template")}
            className="inline-flex min-w-[96px] items-center justify-center gap-2 rounded-lg border border-black/10 bg-white px-4 py-2 text-black/75 transition hover:bg-black/[0.04]"
          >
            <LayoutTemplate className="h-5 w-5" />
            <span className="text-base font-semibold leading-none">{t("模板")}</span>
          </button>
          <button
            type="button"
            onClick={() => requestCreate("blank")}
            className="inline-flex min-w-[88px] items-center justify-center gap-2 rounded-lg bg-black px-4 py-2 text-white transition hover:bg-black/85"
          >
            <Plus className="h-5 w-5" />
            <span className="text-base font-semibold leading-none">{t("添加")}</span>
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="inline-flex rounded-lg bg-black/[0.04] p-1">
          <button
            type="button"
            onClick={() => setActiveView("created")}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${activeView === "created" ? "bg-white text-black shadow-sm" : "text-black/55 hover:text-black/80"}`}
            aria-pressed={activeView === "created"}
          >
            {t("已生效任务")}
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
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={loadingJobs || loadingRecentRuns}
          className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-black/35 transition hover:text-black/80 disabled:cursor-not-allowed disabled:text-black/20"
          aria-label={t("刷新")}
          title={t("刷新")}
        >
          <RefreshCw className={`h-4 w-4 ${loadingJobs || loadingRecentRuns ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className={(activeView === "created" && (loadingJobs || listError || visibleJobs.length === 0)) || (activeView === "recent" && loadingRecentRuns) ? "rounded-xl p-4" : ""} style={(activeView === "created" && (loadingJobs || listError || visibleJobs.length === 0)) || (activeView === "recent" && loadingRecentRuns) ? PANEL_CARD_STYLE : undefined}>
        {activeView === "created" && loadingJobs ? (
          <div className="flex items-center justify-center py-8 text-sm text-black/50">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("加载中…")}
          </div>
        ) : activeView === "created" && listError ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm">
            <AlertTriangle className="mb-2 h-6 w-6 text-[#B91C1C] opacity-80" />
            <p className="text-black/70">{t("加载自动任务失败")}</p>
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
          <RecentCronRunsPanel runs={recentRuns} />
        ) : visibleJobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm text-black/50">
            <Clock className="mb-2 h-6 w-6 opacity-50" />
            <p>
              {t("暂无自动任务，")}
              <button
                type="button"
                onClick={() => requestCreate("template")}
                className="font-medium text-black/80 underline decoration-black/30 underline-offset-4 transition hover:text-black"
              >
                {t("参考模板添加")}
              </button>
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[...visibleJobs]
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
                  busy={busyId === job.id}
                  onView={() => setViewingJob(job)}
                  onEdit={() => setEditingJob(job)}
                  onPause={() => handleAction(job, "pause")}
                  onResume={() => handleAction(job, "resume")}
                  onRemove={() => setConfirmDeleteJob(job)}
                />
              ))}
          </div>
        )}
      </div>

      {creating && (
        <AutomationFormModal
          botId={botId}
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await refreshAll();
          }}
          onError={showError}
        />
      )}

      {templatePickerOpen && (
        <AutomationTemplateModal
          templates={templates}
          onClose={() => setTemplatePickerOpen(false)}
          onSelect={(template) => {
            setTemplatePickerOpen(false);
            setCreatingFromTemplate(template);
          }}
        />
      )}

      {creatingFromTemplate && (
        <AutomationFormModal
          botId={botId}
          mode="create"
          template={creatingFromTemplate}
          onClose={() => setCreatingFromTemplate(null)}
          onSaved={async () => {
            setCreatingFromTemplate(null);
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
          }}
          onConfirm={() => {
            setConfirmCreateOverLimit(false);
            const mode = pendingCreateMode ?? "blank";
            setPendingCreateMode(null);
            if (mode === "template") setTemplatePickerOpen(true);
            else setCreating(true);
          }}
        />
      )}

      {editingJob && (
        <AutomationFormModal
          botId={botId}
          mode="edit"
          initialJob={editingJob}
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
          lastAgentRun={getLastAgentRunForJob(viewingJob, recentRuns)}
          onClose={() => setViewingJob(null)}
        />
      )}

      {confirmDeleteJob && (
        <ConfirmDeleteModal
          jobName={confirmDeleteJob.name}
          busy={busyId === confirmDeleteJob.id}
          onCancel={() => setConfirmDeleteJob(null)}
          onConfirm={async () => {
            const target = confirmDeleteJob;
            setConfirmDeleteJob(null);
            await handleAction(target, "remove");
          }}
        />
      )}
    </div>
  );
}

function RecentCronRunsPanel({ runs }: { runs: CronRunRecord[] }) {
  const t = useT();
  const [viewingRun, setViewingRun] = useState<CronRunRecord | null>(null);
  return (
    <div>
      <section className="overflow-hidden rounded-md bg-white" style={PANEL_CARD_STYLE}>
        {runs.length === 0 ? (
          <div className="m-4 flex items-center gap-2 rounded-lg bg-black/[0.02] px-3 py-2 text-xs text-black/45">
            <Clock className="h-3.5 w-3.5" />
            {t("暂无执行记录")}
          </div>
        ) : (
          <div className="divide-y divide-black/[0.06] px-4">
            {runs.map((run) => (
              <div key={run.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-black/85" title={run.job_name}>
                      {run.job_name}
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
                  {run.job_prompt && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-black/55" title={run.job_prompt}>
                      {run.job_prompt}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
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
            ))}
          </div>
        )}
        {viewingRun && (
          <RecentCronRunDetailModal
            run={viewingRun}
            onClose={() => setViewingRun(null)}
          />
        )}
      </section>
      <div className="flex justify-center pt-1">
        <p className="text-center text-[11px] leading-4 text-black/35">
          {t("最多展示最近 10 条执行记录")}
        </p>
      </div>
    </div>
  );
}

function runToCronJob(run: CronRunRecord): CronJob {
  return {
    id: run.job_id,
    name: run.job_name,
    prompt: run.job_prompt,
    schedule: run.schedule ?? { kind: "", expr: "", display: "" },
    skills: [],
    enabled: true,
    state: "",
    deliver: run.deliver,
    next_run_at: null,
    last_run_at: run.run_at,
    last_status: run.status,
    created_at: null,
    script: "",
    effective_window: null,
  };
}

function RecentCronRunDetailModal({ run, onClose }: { run: CronRunRecord; onClose: () => void }) {
  const t = useT();
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8"
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
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-8">
          <h2 className="truncate text-lg font-semibold text-black/90">{run.job_name || t("未命名任务")}</h2>
          <span className="shrink-0 rounded-full bg-black/[0.06] px-2 py-0.5 text-[11px] text-black/55">
            {run.status ? formatLastStatus(run.status, t) : t("已执行")}
          </span>
        </div>

        <dl className="mt-5 overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <DetailRow label={t("任务说明")} value={run.job_prompt || "—"} pre />
          <DetailRow label={t("执行时间")} value={run.schedule ? formatScheduleFriendly(runToCronJob(run), t) : "—"} />
          <DetailRow label={t("本次执行")} value={formatTime(run.run_at)} />
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
  busy,
  onView,
  onEdit,
  onPause,
  onResume,
  onRemove,
}: {
  job: CronJob;
  busy: boolean;
  onView: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const paused = isCronJobPaused(job);
  const expired = isCronJobExpired(job);
  const effectiveStatus = getEffectiveWindowStatus(job.effective_window);
  const hasEffectiveWindow = effectiveStatus !== "always";
  const fullName = job.name || t("未命名任务");
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
        {(expired || paused || effectiveStatus === "ended") && (
          <div className="flex shrink-0 items-center gap-1">
            {effectiveStatus === "ended" && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已过生效期")}
              </span>
            )}
            {expired && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已过期")}
              </span>
            )}
            {paused && (
              <span className="rounded-full bg-[#FFF1D6] px-2 py-0.5 text-xs text-[#9A5A00]">
                {t("已暂停")}
              </span>
            )}
          </div>
        )}
      </div>

      <p className="line-clamp-4 min-h-[6.5em] flex-1 text-xs leading-relaxed text-black/55">{job.prompt}</p>

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
          <CronActionButton label={t("查看")} onClick={onView}>
            <Eye className="h-3 w-3" />
          </CronActionButton>
          <CronActionButton label={t("编辑")} onClick={onEdit} disabled={busy}>
            <Pencil className="h-3 w-3" />
          </CronActionButton>
          {paused ? (
            <CronActionButton label={t("恢复")} onClick={onResume} disabled={busy}>
              <Play className="h-3 w-3" />
            </CronActionButton>
          ) : (
            <CronActionButton label={t("暂停")} onClick={onPause} disabled={busy}>
              <Pause className="h-3 w-3" />
            </CronActionButton>
          )}
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
  return !job.enabled || job.state === "paused";
}

function isCronJobExpired(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim();
  const isOnce = kind === "once" || display.toLowerCase().startsWith("once");
  if (!isOnce || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

export function isCronJobExpiredBeyondGrace(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim();
  const isOnce = kind === "once" || display.toLowerCase().startsWith("once");
  if (!isOnce || !job.next_run_at) return false;
  const d = parseCronDate(job.next_run_at);
  return !Number.isNaN(d.getTime()) && Date.now() - d.getTime() > EXPIRED_CRON_JOB_HIDE_AFTER_MS;
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

  if (/^every\s+\d+\s*[mhd]$/.test(display)) {
    return `${t("按间隔")} · ${scheduleLabel}`;
  }

  if (/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/.test(display)) {
    return `${t("周期")} · ${scheduleLabel}`;
  }

  return scheduleLabel;
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
  lastAgentRun,
  onClose,
}: {
  job: CronJob;
  lastAgentRun: CronRunRecord | null;
  onClose: () => void;
}) {
  const t = useT();
  const paused = !job.enabled || job.state === "paused";
  const nextRunAt = getEffectiveWindowStatus(job.effective_window) === "ended" ? null : job.next_run_at;
  const name = job.name || t("未命名任务");
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8"
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
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="pr-10">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-xl font-semibold text-black/90">{t("自动任务详情")}</h2>
            {paused && (
              <span className="rounded-full bg-black/[0.08] px-2 py-0.5 text-xs text-black/60">
                {t("已暂停")}
              </span>
            )}
          </div>
        </div>

        <dl className="mt-7 overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <DetailRow label={t("任务名称")} value={name} />
          <DetailRow label={t("任务说明")} value={job.prompt || "—"} pre />
          <DetailRow label={t("执行时间")} value={formatScheduleFriendly(job, t)} />
          {lastAgentRun && (
            <DetailRow
              label={t("上次执行")}
              value={formatLastRun(lastAgentRun.run_at, lastAgentRun.status, t)}
            />
          )}
          {nextRunAt && (
            <DetailRow label={t("下次执行")} value={formatTime(nextRunAt)} />
          )}
          <DetailRow
            label={t("生效时间段")}
            value={formatEffectiveWindowPeriod(job.effective_window, t)}
          />
          <DeliverDetailRow deliver={job.deliver} />
          <DetailRow label={t("任务 ID")} value={job.id} mono />
        </dl>
      </div>
    </div>,
    document.body,
  );
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
  if (platform === "feishu") return t("飞书");
  if (platform === "weixin") return isGlobal ? "WeChat" : t("微信");
  if (platform === "telegram") return "Telegram";
  if (platform === "whatsapp") return "WhatsApp";
  if (platform === "discord") return "Discord";
  if (platform === "origin") return t("原对话（创建任务的聊天通道）");
  return platform;
}

function DetailRow({ label, value, pre, mono }: { label: string; value: string; pre?: boolean; mono?: boolean }) {
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

function AutomationTemplateModal({
  templates,
  onClose,
  onSelect,
}: {
  templates: AutomationTemplate[];
  onClose: () => void;
  onSelect: (template: AutomationTemplate) => void;
}) {
  const t = useT();
  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 px-4 py-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[680px] rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>
        <div className="pr-8">
          <h3 className="text-lg font-semibold leading-10 text-black/90">{t("自动任务示例模板")}</h3>
        </div>
        <div className="mt-5 grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
          {templates.map((template) => {
            const tone = AUTOMATION_TEMPLATE_TONES[template.id as keyof typeof AUTOMATION_TEMPLATE_TONES] ?? AUTOMATION_TEMPLATE_TONES["daily-summary"];
            const TemplateIcon = tone.icon;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onSelect(template)}
                className={`group flex min-h-[132px] flex-col rounded-xl border border-l-[3px] border-black/10 ${tone.accentClass} bg-white p-4 text-left shadow-[0_8px_18px_rgba(15,23,42,0.04)] transition-all duration-200 hover:bg-black/[0.015] hover:shadow-[0_12px_24px_rgba(15,23,42,0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${tone.iconClass}`}>
                        <TemplateIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-black/90">{template.name}</div>
                      </div>
                    </div>
                    <span className="shrink-0 rounded-full border border-black/[0.04] bg-black/[0.035] px-2 py-0.5 text-[11px] font-medium text-black/55 transition-colors group-hover:bg-black/[0.055]">
                      {formatTemplateSchedule(template, t)}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-black/60">
                    {template.prompt}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatTemplateSchedule(template: AutomationTemplate, t: ReturnType<typeof useT>): string {
  const schedule = template.schedule;
  if (schedule.kind === "interval") {
    const unitLabel = schedule.intervalUnit === "m" ? t("分钟") : schedule.intervalUnit === "d" ? t("天") : t("小时");
    return t("每 {{num}} {{unit}}", { num: String(schedule.intervalNum ?? 1), unit: unitLabel });
  }
  if (schedule.kind === "recurring") {
    if (schedule.period === "weekly") {
      return t("每{{weekday}} {{time}}", {
        weekday: formatWeekdays(schedule.weekdays ?? [schedule.weekday ?? 1], t),
        time: schedule.time ?? "09:00",
      });
    }
    return t("每天 {{time}}", { time: schedule.time ?? "09:00" });
  }
  return t("单次");
}

function ConfirmDeleteModal({
  jobName,
  busy,
  onCancel,
  onConfirm,
}: {
  jobName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-[400px] rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-black/90">{t("删除自动任务")}</h3>
        <p className="mt-2 text-sm text-black/65">
          {t("确定要删除「{{name}}」吗？此操作无法恢复。", { name: jobName || t("未命名任务") })}
        </p>
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
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40 px-4 py-8"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="relative w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-black/90">{t("自动任务数量提醒")}</h3>
        <p className="mt-2 text-sm leading-relaxed text-black/65">
          {t("当前生效中的自动任务数量已经达到 20 个以上，建议你删除不需要的任务后再继续。")}
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
            {t("继续添加")}
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
  if (["ok", "success", "succeeded", "done", "completed"].includes(normalized)) return t("执行成功");
  if (["failed", "failure", "error"].includes(normalized)) return t("执行失败");
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

interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: {
    kind: FrequencyKind;
    period?: RecurringPeriod;
    time?: string;
    weekday?: number;
    weekdays?: number[];
    monthday?: number;
    monthdays?: number[];
    intervalNum?: number;
    intervalUnit?: IntervalUnit;
  };
}

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
} satisfies Record<string, {
  icon: typeof Clock;
  iconClass: string;
  accentClass: string;
}>;

function getAutomationTemplates(t: ReturnType<typeof useT>): AutomationTemplate[] {
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

interface ScheduleChangeCheck {
  mode: "create" | "edit";
  scheduleUneditable: boolean;
  kind: FrequencyKind;
  onceDate: string;
  initialOnceDate?: string;
  schedule: string;
  originalSchedule: string;
}

function AutomationFormModal({
  botId,
  mode,
  initialJob,
  template,
  onClose,
  onSaved,
  onError,
}: {
  botId: string;
  mode: "create" | "edit";
  initialJob?: CronJob;
  template?: AutomationTemplate;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const templateSchedule = mode === "create" ? template?.schedule : undefined;
  const [name, setName] = useState(initialJob?.name ?? template?.name ?? "");
  const [prompt, setPrompt] = useState(initialJob?.prompt ?? template?.prompt ?? "");

  const initialScheduleSource = useMemo(
    () => (initialJob?.schedule.display || initialJob?.schedule.expr || "").trim(),
    [initialJob],
  );
  const originalSchedule = useMemo(
    () => (initialJob?.schedule.expr || initialJob?.schedule.display || "").trim(),
    [initialJob],
  );
  const initial = useMemo(() => parseInitialSchedule(initialScheduleSource), [initialScheduleSource]);
  const scheduleUneditable = mode === "edit" && !!initialJob && initial === null && initialScheduleSource.length > 0;
  const defaultScheduleDate = useMemo(() => new Date(Date.now() + 2 * 60_000), []);
  const [kind, setKind] = useState<FrequencyKind>(initial?.kind ?? templateSchedule?.kind ?? "once");
  // 周期态
  const [period, setPeriod] = useState<RecurringPeriod>(initial?.period ?? templateSchedule?.period ?? "daily");
  const [time, setTime] = useState(() => {
    if (initial?.time) return initial.time;
    if (templateSchedule?.time) return templateSchedule.time;
    // 默认取打开弹窗时的两分钟后（minute 精度，跟 cron 表达式粒度一致）
    const d = defaultScheduleDate;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
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
  const initialDeliver = useMemo(() => parseInitialDeliver(initialJob?.deliver || ""), [initialJob]);
  const [deliverPlatforms, setDeliverPlatforms] = useState<string[]>(initialDeliver.platforms);
  /** 每个 platform 的可选 chat_id：填了 → 拼 `<platform>:<id>` 直送；留空 → 走 home */
  const [deliverChatIds, setDeliverChatIds] = useState<Record<string, string>>(initialDeliver.chatIds);
  const [effectiveStartAt, setEffectiveStartAt] = useState(() => normalizeEffectiveWindowInput(initialJob?.effective_window?.start_at ?? ""));
  const [effectiveEndAt, setEffectiveEndAt] = useState(() => normalizeEffectiveWindowInput(initialJob?.effective_window?.end_at ?? ""));
  const [effectiveWindowEnabled, setEffectiveWindowEnabled] = useState(() => Boolean(initialJob?.effective_window?.start_at || initialJob?.effective_window?.end_at));
  const canEditEffectiveWindow = !initialJob?.script || isLightVelaEffectiveWindowScriptName(initialJob.script);
  const shouldShowEffectiveWindow = kind !== "once";
  /** 已配置的 channel key 集合（weixin/qqbot/feishu/...）；null = 还没拉 */
  const [enabledChannels, setEnabledChannels] = useState<Set<string> | null>(null);

  const [submitting, setSubmitting] = useState(false);

  // 表单打开时拉一次 channel 列表，决定哪些 deliver 选项可用
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const baseUrl = resolveConfiguredAuthApiBaseUrl();
        if (baseUrl === null) throw new Error("auth API base URL not configured");
        const headers = new Headers({ "Content-Type": "application/json" });
        const token = readStoredAuthToken();
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const resp = await fetch(
          `${baseUrl.replace(/\/+$/, "")}/v1/instances/${encodeURIComponent(botId)}/debug/exec`,
          {
            method: "POST",
            credentials: "include",
            headers,
            body: JSON.stringify({ command: "acli channel status", run_as_user: "agentuser" }),
          },
        );
        if (!resp.ok) {
          if (resp.status === 401 || resp.status === 403) {
            writeStoredAuthToken(null);
            window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
          }
          throw new Error(`HTTP ${resp.status}`);
        }
        const envelope = (await resp.json()) as { data?: { output?: string } };
        const output = envelope.data?.output ?? "";
        const entries = parseHermesChannelList(output);
        if (cancelled) return;
        setEnabledChannels(new Set(entries.filter((e) => e.enabled).map((e) => e.channel)));
      } catch {
        // 拉失败不阻塞表单；保留 null（视为未知 → 全部 enabled，让 hermes 自己报错）
        if (!cancelled) setEnabledChannels(null);
      }
    })();
    return () => { cancelled = true; };
  }, [botId]);

  const schedule = useMemo(() => buildScheduleString({
    kind, period, time, weekdays, monthdays, intervalNum, intervalUnit, onceDate,
  }), [kind, period, time, weekdays, monthdays, intervalNum, intervalUnit, onceDate]);
  const scheduleChanged = useMemo(() => isScheduleEffectivelyChanged({
    mode,
    scheduleUneditable,
    kind,
    onceDate,
    initialOnceDate: initial?.onceDate,
    schedule,
    originalSchedule,
  }), [mode, scheduleUneditable, kind, onceDate, initial?.onceDate, schedule, originalSchedule]);
  const canSubmit = !submitting
    && name.trim().length > 0
    && (mode === "edit" || prompt.trim().length > 0)
    && (scheduleUneditable || schedule.length > 0);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
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
    setSubmitting(true);
    try {
      const deliver = buildDeliverString(deliverPlatforms, deliverChatIds);
      if (mode === "create") {
        const script = effectiveWindow
          ? createEffectiveWindowScriptName(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
          : undefined;
        if (script && effectiveWindow) {
          await writeEffectiveWindowScript(botId, script, effectiveWindow);
        }
        await createCronJobWithScriptRollback(botId, {
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          deliver,
          script,
        }, script);
      } else if (initialJob) {
        const patch: Parameters<typeof editCronJob>[2] = {};
        const nextName = name.trim();
        const nextPrompt = prompt.trim();
        if (nextName !== initialJob.name) patch.name = nextName;
        if (nextPrompt !== (initialJob.prompt ?? "")) patch.prompt = nextPrompt;
        if (!scheduleUneditable && scheduleChanged) patch.schedule = schedule;
        if (deliver !== (initialJob.deliver || "")) patch.deliver = deliver;
        if (canEditEffectiveWindow) {
          const originalWindow = initialJob.effective_window;
          const windowChanged = !areEffectiveWindowsEqual(effectiveWindow, originalWindow);
          if (windowChanged) {
            if (effectiveWindow) {
              const script = isLightVelaEffectiveWindowScriptName(initialJob.script)
                ? initialJob.script
                : createEffectiveWindowScriptName(initialJob.id);
              await writeEffectiveWindowScript(botId, script, effectiveWindow);
              patch.script = script;
            } else if (isLightVelaEffectiveWindowScriptName(initialJob.script)) {
              patch.script = "";
            }
          }
        }
        if (Object.keys(patch).length > 0) {
          await editCronJob(botId, initialJob.id, patch);
        }
      }
      onSaved();
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      onError(
        mode === "create"
          ? t("创建自动任务失败：{{message}}", { message })
          : t("编辑自动任务失败：{{message}}", { message }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [botId, canSubmit, mode, initialJob, name, prompt, schedule, scheduleUneditable, originalSchedule, kind, onceDate, initial, scheduleChanged, deliverPlatforms, deliverChatIds, effectiveStartAt, effectiveEndAt, effectiveWindowEnabled, intervalWeekdays, canEditEffectiveWindow, shouldShowEffectiveWindow, onSaved, onError, t]);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true">
      <div className="relative max-h-[calc(100vh-24px)] w-full max-w-[635px] overflow-y-auto rounded-lg bg-white p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-lg font-semibold text-black/90">
          {mode === "create" ? t("添加自动任务") : t("编辑自动任务")}
        </h2>

        {/* 名称 */}
        <div className="mt-5">
          <label className="block text-sm font-medium text-black/80">{t("名称")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            maxLength={60}
            placeholder={t("请输入自动任务名称")}
            className="mt-1.5 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_COMPACT_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
        </div>

        {/* 执行时间 */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-black/80">{t("执行时间")}</label>
          <div className="mt-1.5 inline-flex rounded-lg bg-black/[0.04] p-1">
            {(["once", "recurring", "interval"] as FrequencyKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  if (!scheduleUneditable) setKind(k);
                }}
                disabled={scheduleUneditable}
                style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                  kind === k ? "bg-white text-black/90 shadow-sm" : "text-black/50 hover:text-black/80"
                } ${scheduleUneditable ? "cursor-not-allowed opacity-60" : ""}`}
              >
                {k === "recurring" ? t("周期") : k === "interval" ? t("按间隔") : t("单次")}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {scheduleUneditable ? (
              <div className="rounded-lg bg-[#FFF7E6] px-3 py-2 text-xs leading-relaxed text-[#8A5A00]">
                {t("当前调度表达式 {{expr}} 暂不支持在 UI 编辑，如需修改请使用 hermes CLI", { expr: initialScheduleSource })}
              </div>
            ) : kind === "recurring" && (
              <RecurringPicker
                period={period}
                time={time}
                weekdays={weekdays}
                monthdays={monthdays}
                onPeriod={setPeriod}
                onTime={setTime}
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

        {/* 任务说明 */}
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <label className="block text-sm font-medium text-black/80">{t("任务说明")}</label>
            <span className="text-[11px] text-black/40">{prompt.length}/800</span>
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value.slice(0, 800))}
            rows={5}
            maxLength={800}
            placeholder={t("请用提示词的形式描述需要执行的任务，比如：提醒我喝水")}
            className="mt-1.5 w-full resize-none rounded-md border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_COMPACT_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
        </div>

        {/* 生效时间段 */}
        {shouldShowEffectiveWindow && (
        <div className="mt-4">
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
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                effectiveWindowEnabled ? "bg-black" : "bg-black/15"
              } ${canEditEffectiveWindow ? "" : "cursor-not-allowed opacity-50"}`}
              aria-label={t("生效时间段")}
            >
              <span
                className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition ${
                  effectiveWindowEnabled ? "translate-x-4" : "translate-x-0.5"
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
                className="min-w-0 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35 sm:w-full"
                aria-label={t("生效开始时间")}
              />
              <span className="hidden text-center text-sm text-black/35 sm:block">—</span>
              <input
                type="datetime-local"
                value={effectiveEndAt}
                onChange={(e) => setEffectiveEndAt(e.target.value)}
                disabled={!canEditEffectiveWindow}
                style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
                className="min-w-0 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none disabled:cursor-not-allowed disabled:bg-black/[0.03] disabled:text-black/35 sm:w-full"
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
         *   - 国内站（isCN）：weixin / qqbot / feishu
         *   - 国际站（isGlobal）：weixin / telegram / whatsapp / discord(coming soon)
         *
         * Discord 在 Hermes runtime 还没有可用的 deliver 通路，先以「即将推出 /
         * To be released」灰显占位，不允许勾选；后续 runtime 支持后改为可选即可。
         */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-black/80">
            {t("通知方式")}<span className="ml-1 text-xs font-normal text-black/40">{t("（可选）")}</span>
          </label>
          <div className="mt-2 space-y-2">
            {(
              isGlobal
                ? ([
                    { key: "telegram", label: "Telegram", comingSoon: false },
                    { key: "whatsapp", label: "WhatsApp", comingSoon: false },
                    { key: "discord", label: "Discord", comingSoon: true },
                    { key: "weixin", label: "WeChat", comingSoon: false },
                  ] as const)
                : ([
                    { key: "weixin", label: t("微信"), comingSoon: false },
                    { key: "qqbot", label: "QQ", comingSoon: false },
                    { key: "feishu", label: t("飞书"), comingSoon: false },
                  ] as const)
            ).map(({ key, label, comingSoon }) => {
              // comingSoon 通道一律强制为「不可配置」，无论 acli channel status 怎么报
              const configured = !comingSoon && (enabledChannels === null || enabledChannels.has(key));
              const selected = deliverPlatforms.includes(key);
              return (
                <div key={key}>
                  <label
                    className={
                      "inline-flex items-center gap-1.5 text-sm " +
                      (configured ? "cursor-pointer text-black/80" : "cursor-not-allowed text-black/30")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={!configured}
                      onChange={() => {
                        setDeliverPlatforms((prev) => {
                          if (!prev.includes(key)) return [...prev, key];
                          setDeliverChatIds((ids) => {
                            const { [key]: _removed, ...rest } = ids;
                            return rest;
                          });
                          return prev.filter((p) => p !== key);
                        });
                      }}
                      className="h-4 w-4 cursor-pointer rounded border-black/20 accent-black disabled:cursor-not-allowed"
                    />
                    <span className="text-sm leading-5">
                      {label}
                      {comingSoon ? (
                        <span className="ml-1 text-xs">{t("（即将推出）")}</span>
                      ) : (
                        !configured && <span className="ml-1 text-xs">{t("（未配置）")}</span>
                      )}
                    </span>
                    {selected && key === "weixin" && (
                      <span className="text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        {t("注意：请避免设置太频繁的提醒，否则可能会被微信限流，无法接收通知")}
                      </span>
                    )}
                    {selected && key === "qqbot" && (
                      <span className="inline-flex items-center text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        {t("如未生效，可尝试在 QQ 对话中发送")}
                        <InlineCopyText value="/set-home" />
                        {t("给 QQ 机器人")}
                      </span>
                    )}
                    {selected && key === "feishu" && (
                      <span className="text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>{t("支持通过 home 对话或指定 Chat ID 发送通知")}</span>
                    )}
                  </label>

                  {selected && key === "feishu" && (
                    <div className="mt-1.5 space-y-1.5 pl-5">
                      <div className="flex items-center gap-1">
                        <span className="w-14 shrink-0 text-sm text-black/50" style={MODAL_HELP_TEXT_STYLE}>{t("Chat ID")}</span>
                        <input
                          type="text"
                          value={deliverChatIds[key] ?? ""}
                          onChange={(e) =>
                            setDeliverChatIds((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder={t("可留空，默认通过 home 对话通知；也可指定 Chat ID 通知")}
                          className="min-w-0 flex-[1.1] rounded-lg border border-black/10 bg-white px-3 py-1.5 text-[12px] placeholder:text-[12px] placeholder:text-black/35 focus:border-black/30 focus:outline-none"
                          style={{ fontSize: 12, lineHeight: "18px" }}
                        />
                      </div>
                      <div className="space-y-2 text-sm text-black/40" style={MODAL_HELP_TEXT_STYLE}>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <CircleHelp className="h-3.5 w-3.5 shrink-0 text-black/35" />
                            <span>{t("如何设置 home 对话？")}</span>
                          </div>
                          <p className="mt-1 pl-5">
                            {t("扫码连接飞书后，默认的对话即为home对话。如需切换，可在其他对话中发送")}
                            <InlineCopyText value="/set-home" />
                            {t("。")}
                          </p>
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <CircleHelp className="h-3.5 w-3.5 shrink-0 text-black/35" />
                            <span>{t("如何获取 Chat ID？")}</span>
                          </div>
                          <p className="mt-1 pl-5">
                            {t("在飞书应用中，找到希望发送通知的对话，向 Agent 发送提示词")}
                            <InlineCopyText value={t("当前Chat ID是什么")} />
                            {t("，正常会回复前缀为oc_的一长串字符。")}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              );
            })}
          </div>
          {/* 间距用 div 显式 spacer 拉开，避免 mt-* 被 layout 影响 */}
          <div aria-hidden="true" style={{ height: 4 }} />
          {deliverPlatforms.length === 0 ? (
            <p className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
              {t("如不选，智能体只会在后台执行任务，不发通知。")}
            </p>
          ) : null}
        </div>

        {/* 操作 */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            style={MODAL_CONTROL_TEXT_STYLE}
            className="rounded-lg border border-black/10 px-4 py-2 text-base font-medium text-black/70 transition hover:bg-black/[0.04]"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={handleSubmit}
            style={MODAL_CONTROL_TEXT_STYLE}
            className="inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-black px-4 py-2 text-base font-medium text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {mode === "create" ? t("添加") : t("保存")}
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
  weekdays,
  monthdays,
  onPeriod,
  onTime,
  onWeekdays,
  onMonthdays,
}: {
  period: RecurringPeriod;
  time: string;
  weekdays: number[];
  monthdays: number[];
  onPeriod: (v: RecurringPeriod) => void;
  onTime: (v: string) => void;
  onWeekdays: (v: number[]) => void;
  onMonthdays: (v: number[]) => void;
}) {
  const t = useT();
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const [weekdayPickerOpen, setWeekdayPickerOpen] = useState(false);
  const [monthdayPickerOpen, setMonthdayPickerOpen] = useState(false);
  const periodPickerRef = useRef<HTMLDivElement | null>(null);
  const weekdayPickerRef = useRef<HTMLDivElement | null>(null);
  const monthdayPickerRef = useRef<HTMLDivElement | null>(null);
  const periodOptions: Array<{ value: RecurringPeriod; label: string }> = [
    { value: "daily", label: t("每天") },
    { value: "weekly", label: t("每周") },
    { value: "monthly", label: t("每月") },
  ];
  const periodLabel = periodOptions.find((option) => option.value === period)?.label ?? t("每天");
  const weekdayLabels = getWeekdayLabels(t);
  const selectedWeekdays = normalizeWeekdays(weekdays);
  const selectedMonthdays = normalizeMonthdays(monthdays);
  useEffect(() => {
    if (!periodPickerOpen && !weekdayPickerOpen && !monthdayPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (periodPickerRef.current?.contains(target)) return;
      if (weekdayPickerRef.current?.contains(target)) return;
      if (monthdayPickerRef.current?.contains(target)) return;
      setPeriodPickerOpen(false);
      setWeekdayPickerOpen(false);
      setMonthdayPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [monthdayPickerOpen, periodPickerOpen, weekdayPickerOpen]);
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={periodPickerRef} className="relative w-[112px]">
        <button
          type="button"
          onClick={() => setPeriodPickerOpen((open) => !open)}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="flex min-h-[39px] w-full items-center justify-between rounded-lg border border-black/10 bg-white px-3 py-2 text-left text-sm focus:border-black/30 focus:outline-none"
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
      {period === "weekly" && (
        <div ref={weekdayPickerRef} className="relative w-[360px] max-w-full">
          <div
            onClick={() => setWeekdayPickerOpen((open) => !open)}
            className="flex min-h-[42px] w-full items-center gap-1.5 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 pr-9 text-left text-sm focus-within:border-black/30"
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
          <ChevronDown className="pointer-events-none absolute right-3 top-[21px] h-4 w-4 -translate-y-1/2 text-black/80" />
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
                    <span className={`inline-flex h-4 w-4 items-center justify-center rounded border ${
                      checked ? "border-black bg-black" : "border-black/20 bg-white"
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
            className="flex min-h-[42px] w-full items-center gap-1.5 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 pr-9 text-left text-sm focus-within:border-black/30"
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
          <ChevronDown className="pointer-events-none absolute right-3 top-[21px] h-4 w-4 -translate-y-1/2 text-black/80" />
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
      <input
        type="time"
        value={time}
        onChange={(e) => onTime(e.target.value)}
        style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
        className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none"
      />
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
      className={`ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left text-sm ${
        weekdaysDisabled ? "opacity-50" : ""
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
          className="h-9 w-16 rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm focus:border-black/30 focus:outline-none"
        />
        <div ref={unitPickerRef} className="relative w-[76px]">
          <button
            type="button"
            onClick={() => setUnitPickerOpen((open) => !open)}
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
            className="flex min-h-9 w-full items-center justify-between rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-left text-sm focus:border-black/30 focus:outline-none"
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

function OncePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="datetime-local"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
      className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none"
    />
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
  if (args.period === "daily") return `${m} ${h} * * *`;
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
