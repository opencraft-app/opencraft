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
 * - 创建（截图三态频率：周期 / 按间隔 / 单次）
 * - 暂停 / 恢复 / 删除
 * - 生效日期区间通过 Hermes 官方 pre-run script gate 实现：区间外返回 wakeAgent=false
 */

import { AlertTriangle, ChevronDown, CircleHelp, Clock, Eraser, Eye, LayoutTemplate, Loader2, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  pauseCronJob,
  writeEffectiveWindowScript,
  removeCronJob,
  resumeCronJob,
  type CronEffectiveWindow,
  type CronJob,
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

function EffectiveWindowTooltip({ message }: { message: string }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

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

  return (
    <span className="group relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-black/35 transition hover:text-black/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/15"
        aria-label={message}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && createPortal(
        <span
          id={tooltipId}
          className="pointer-events-none fixed z-[260] w-[280px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-full rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium leading-relaxed text-[var(--text-primary)] opacity-100 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150"
          style={{ left: position.left, top: position.top }}
          role="tooltip"
        >
          {message}
          <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
        </span>,
        document.body,
      )}
    </span>
  );
}

export function AutomationsPanel({ botId }: { botId: string | null }) {
  const t = useT();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
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

  const refresh = useCallback(async () => {
    if (!botId) {
      setJobs([]);
      setListError(null);
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const list = await listCronJobs(botId);
      setJobs(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setListError(message);
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await refresh();
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
  }, [botId, refresh, showError, t]);

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

      <div className={loading || listError || visibleJobs.length === 0 ? "rounded-xl p-4" : ""} style={loading || listError || visibleJobs.length === 0 ? PANEL_CARD_STYLE : undefined}>
        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-black/50">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("加载中…")}
          </div>
        ) : listError ? (
          <div className="flex flex-col items-center justify-center py-10 text-sm">
            <AlertTriangle className="mb-2 h-6 w-6 text-[#B91C1C] opacity-80" />
            <p className="text-black/70">{t("加载自动任务失败")}</p>
            <p className="mt-1 max-w-md break-all px-4 text-center text-xs text-black/40">{listError}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-3 rounded-lg border border-black/10 px-3 py-1.5 text-xs font-medium text-black/70 transition hover:bg-black/[0.04]"
            >
              {t("重试")}
            </button>
          </div>
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
            await refresh();
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
            await refresh();
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
            await refresh();
          }}
          onError={showError}
        />
      )}

      {viewingJob && (
        <CronJobDetailModal job={viewingJob} onClose={() => setViewingJob(null)} />
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
  const fullName = job.name || t("未命名任务");
  const scheduleLabel = formatScheduleFriendly(job, t);
  return (
    <div
      className="flex flex-col rounded-xl bg-white p-4 transition hover:shadow-md"
      style={{ ...PANEL_CARD_STYLE, minHeight: 178 }}
    >
      <div className="flex items-start justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <Clock className="h-4 w-4 shrink-0 text-black/40" />
          <span className="min-w-0 truncate text-sm font-medium text-black/90" title={fullName}>
            {fullName}
          </span>
        </div>
        {(expired || paused || effectiveStatus !== "always") && (
          <div className="flex shrink-0 items-center gap-1">
            {effectiveStatus === "pending" && (
              <span className="rounded-full bg-[#EEF4FF] px-2 py-0.5 text-xs text-[#3156A3]">
                {t("未开始")}
              </span>
            )}
            {effectiveStatus === "active" && (
              <span className="rounded-full bg-[#ECFDF3] px-2 py-0.5 text-xs text-[#287A3E]">
                {t("生效中")}
              </span>
            )}
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
        <span className="line-clamp-1 text-xs text-black/55" title={scheduleLabel} aria-label={scheduleLabel}>
          {scheduleLabel}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onView}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
            aria-label={t("查看")}
            title={t("查看")}
          >
            <Eye className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t("编辑")}
            title={t("编辑")}
          >
            <Pencil className="h-3 w-3" />
          </button>
          {paused ? (
            <button
              type="button"
              onClick={onResume}
              disabled={busy}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("恢复")}
              title={t("恢复")}
            >
              <Play className="h-3 w-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onPause}
              disabled={busy}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={t("暂停")}
              title={t("暂停")}
            >
              <Pause className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={t("删除")}
            title={t("删除")}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
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
    if (unit === "m") {
      if (n % 1440 === 0) return t("每 {{n}} 天", { n: String(n / 1440) });
      if (n % 60 === 0) return t("每 {{n}} 小时", { n: String(n / 60) });
      return t("每 {{n}} 分钟", { n: String(n) });
    }
    if (unit === "h") return t("每 {{n}} 小时", { n });
    if (unit === "d") return t("每 {{n}} 天", { n });
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
    if (mon === "*" && dow === "*" && /^\d+$/.test(dom ?? "")) {
      return t("每月 {{d}} 日 {{at}}", { d: dom, at });
    }
  }

  return display || job.schedule.expr || "";
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

function CronJobDetailModal({ job, onClose }: { job: CronJob; onClose: () => void }) {
  const t = useT();
  const paused = !job.enabled || job.state === "paused";
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

        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-black/90">{job.name || t("未命名任务")}</h2>
          {paused && (
            <span className="rounded-full bg-black/[0.08] px-1.5 py-0.5 text-[10px] text-black/60">
              {t("已暂停")}
            </span>
          )}
        </div>

        <dl className="space-y-3 text-sm" style={{ marginTop: 16 }}>
          <DetailRow label={t("任务说明")} value={job.prompt || "—"} pre />
          <DetailRow label={t("执行时间")} value={formatScheduleFriendly(job, t)} />
          <DetailRow label={t("生效时间段")} value={formatEffectiveWindow(job.effective_window, t)} />
          {job.next_run_at && <DetailRow label={t("下次执行")} value={formatTime(job.next_run_at)} />}
          {job.last_run_at && (
            <DetailRow
              label={t("上次执行")}
              value={formatLastRun(job.last_run_at, job.last_status, t)}
            />
          )}
          <DeliverDetailRow deliver={job.deliver} />
          <DetailRow label={t("任务 ID")} value={job.id} />
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
      <div>
        <dt className="text-xs text-black/50">{t("通知方式")}</dt>
        <dd className="mt-1 text-sm text-black/85 break-words">
          <DetailBulletItem>{formatDeliverFallback(deliver || "", t)}</DetailBulletItem>
        </dd>
      </div>
    );
  }

  return (
    <div>
      <dt className="text-xs text-black/50">{t("通知方式")}</dt>
      <dd className="mt-1 space-y-1.5 text-sm text-black/85 break-words">
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
    <div className="flex items-start gap-2">
      <span className="mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full bg-black/35" aria-hidden="true" />
      <span>{children}</span>
    </div>
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
  return platform;
}

function DetailRow({ label, value, pre }: { label: string; value: string; pre?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-black/50">{label}</dt>
      <dd
        className={`mt-0.5 text-sm text-black/85 ${pre ? "whitespace-pre-wrap break-words" : "break-words"}`}
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
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => onSelect(template)}
              className="flex min-h-[100px] flex-col justify-start rounded-lg border border-black/10 bg-white p-4 text-left transition hover:border-black/20 hover:bg-black/[0.02]"
            >
              <div className="flex h-7 items-start justify-between gap-3">
                <div className="truncate text-sm font-semibold text-black/85">{template.name}</div>
                <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-black/55">
                  {formatTemplateSchedule(template, t)}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-black/55">
                {template.prompt}
              </p>
            </button>
          ))}
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
): CronEffectiveWindow | null {
  const start = normalizeEffectiveWindowInput(startAt);
  const end = normalizeEffectiveWindowInput(endAt);
  if (!start && !end) return null;
  return {
    start_at: start || null,
    end_at: end || null,
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
  return (a?.start_at ?? null) === (b?.start_at ?? null)
    && (a?.end_at ?? null) === (b?.end_at ?? null);
}

function isLightVelaEffectiveWindowScriptName(script: string): boolean {
  return /^lightvela-effective-window-[a-z0-9-]+\.py$/.test(script);
}

export function getEffectiveWindowStatus(window: CronEffectiveWindow | null, now = Date.now()): EffectiveWindowStatus {
  if (!window?.start_at && !window?.end_at) return "always";
  const start = window.start_at ? parseCronDate(window.start_at).getTime() : Number.NaN;
  const end = window.end_at ? parseCronDate(window.end_at).getTime() : Number.NaN;
  if (!Number.isNaN(start) && now < start) return "pending";
  if (!Number.isNaN(end) && now > end) return "ended";
  return "active";
}

function formatEffectiveWindow(
  window: CronEffectiveWindow | null,
  t: ReturnType<typeof useT>,
): string {
  if (!window?.start_at && !window?.end_at) return t("始终生效");
  const start = window.start_at ? formatEffectiveWindowDate(window.start_at) : t("不限开始时间");
  const end = window.end_at ? formatEffectiveWindowDate(window.end_at) : t("不限结束时间");
  const status = getEffectiveWindowStatus(window);
  const statusLabel = status === "pending"
    ? t("未开始")
    : status === "ended"
      ? t("已过生效期")
      : t("生效中");
  return `${start} - ${end} · ${statusLabel}`;
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
    intervalNum?: number;
    intervalUnit?: IntervalUnit;
  };
}

function getAutomationTemplates(t: ReturnType<typeof useT>): AutomationTemplate[] {
  return [
    {
      id: "daily-summary",
      name: t("每日总结"),
      description: t("每天晚上整理今天的进展和明天优先级"),
      prompt: t("请回顾今天的重要事项，帮我整理一份简短总结，并提醒我明天优先处理的 3 件事。"),
      schedule: { kind: "recurring", period: "daily", time: "21:30" },
    },
    {
      id: "water-break",
      name: t("喝水提醒"),
      description: t("每隔一段时间提醒补水和短暂休息"),
      prompt: t("提醒我喝水，并用一句轻松的话鼓励我保持状态。"),
      schedule: { kind: "interval", intervalNum: 2, intervalUnit: "h" },
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
      name: t("周五复盘"),
      description: t("每周五下班前回顾本周事项"),
      prompt: t("帮我做一次本周复盘：总结完成事项、遗留问题和下周建议。"),
      schedule: { kind: "recurring", period: "weekly", weekday: 5, time: "18:00" },
    },
    {
      id: "task-tidy",
      name: t("资料整理"),
      description: t("每天提醒整理待办、文档和消息"),
      prompt: t("提醒我整理最近的待办、文档和消息，把需要跟进的事项列出来。"),
      schedule: { kind: "recurring", period: "daily", time: "10:00" },
    },
    {
      id: "stretch",
      name: t("活动一下"),
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
      name: t("AI 新闻推送"),
      description: t("每天推送关心领域的重要新闻摘要"),
      prompt: t("提醒我查看今天的重要新闻，按科技、财经和本地资讯各总结 3 条要点。"),
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
  const [kind, setKind] = useState<FrequencyKind>(initial?.kind ?? templateSchedule?.kind ?? "recurring");
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
  const [monthday, setMonthday] = useState(initial?.monthday ?? 1);
  // 按间隔态
  const [intervalNum, setIntervalNum] = useState(initial?.intervalNum ?? templateSchedule?.intervalNum ?? 1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(initial?.intervalUnit ?? templateSchedule?.intervalUnit ?? "h");
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
  const canEditEffectiveWindow = !initialJob?.script || isLightVelaEffectiveWindowScriptName(initialJob.script);
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
    kind, period, time, weekdays, monthday, intervalNum, intervalUnit, onceDate,
  }), [kind, period, time, weekdays, monthday, intervalNum, intervalUnit, onceDate]);
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
    const effectiveWindow = buildEffectiveWindowFromInputs(effectiveStartAt, effectiveEndAt);
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
  }, [botId, canSubmit, mode, initialJob, name, prompt, schedule, scheduleUneditable, originalSchedule, kind, onceDate, initial, scheduleChanged, deliverPlatforms, deliverChatIds, effectiveStartAt, effectiveEndAt, canEditEffectiveWindow, onSaved, onError, t]);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true">
      <div className="relative max-h-[calc(100vh-24px)] w-full max-w-[560px] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
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
            className="mt-1.5 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-base placeholder:text-base placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
        </div>

        {/* 执行时间 */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-black/80">{t("执行时间")}</label>
          <div className="mt-1.5 inline-flex rounded-lg bg-black/[0.04] p-1">
            {(["recurring", "interval", "once"] as FrequencyKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  if (!scheduleUneditable) setKind(k);
                }}
                disabled={scheduleUneditable}
                style={MODAL_CONTROL_TEXT_STYLE}
                className={`rounded-md px-3 py-1 text-base font-medium transition ${
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
                monthday={monthday}
                onPeriod={setPeriod}
                onTime={setTime}
                onWeekdays={setWeekdays}
                onMonthday={setMonthday}
              />
            )}
            {!scheduleUneditable && kind === "interval" && (
              <IntervalPicker
                num={intervalNum}
                unit={intervalUnit}
                onNum={setIntervalNum}
                onUnit={setIntervalUnit}
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
            className="mt-1.5 w-full resize-none rounded-lg border border-black/10 bg-white px-3 py-2 text-base placeholder:text-base placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ ...MODAL_CONTROL_TEXT_STYLE, marginTop: 6 }}
          />
        </div>

        {/* 生效时间段 */}
        <div className="mt-4">
          <div className="flex items-center gap-1.5">
            <label className="block text-sm font-medium text-black/80">{t("生效时间段")}</label>
            <EffectiveWindowTooltip
              message={canEditEffectiveWindow
                ? t("超出该时间段时，任务仍保留在列表中，但不会唤醒 Agent 执行。")
                : t("当前任务使用了自定义 pre-run 脚本，暂不支持在这里修改生效时间段。")}
            />
            <span className="text-xs font-normal text-black/40">{t("（可选，留空代表一直生效）")}</span>
          </div>
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
              <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--border-subtle)] bg-white px-3 py-1.5 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                {t("清空")}
                <span className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-[var(--border-subtle)] bg-white" />
              </span>
            </span>
          </div>
        </div>

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
                    <span className="text-base leading-6">
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
                        {t("如未生效，可在 QQ 对话中发送")}
                        <InlineCopyText value="/set-home" />
                        {t("给机器人")}
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
                          placeholder={t("如已设置home对话，可留空，默认走home对话通知；也可指定Chat ID通知")}
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
                            {t("在飞书应用中，在对话中向机器人发送")}
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
                            {t("在飞书应用中，找到希望发送通知的对话，向机器人发送提示词")}
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
          <div aria-hidden="true" style={{ height: 10 }} />
          {deliverPlatforms.length === 0 ? (
            <p className="text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
              {t("如不选，则只会在后台执行任务，不发通知。")}
            </p>
          ) : null}
          {isGlobal ? (
            <p className="mt-1 text-xs text-black/40" style={MODAL_HELP_TEXT_STYLE}>
              {t("备注：如果连接 Telegram 或 WhatsApp，请在机器人对话中输入 /set-home，即可开启自动通知功能")}
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
  monthday,
  onPeriod,
  onTime,
  onWeekdays,
  onMonthday,
}: {
  period: RecurringPeriod;
  time: string;
  weekdays: number[];
  monthday: number;
  onPeriod: (v: RecurringPeriod) => void;
  onTime: (v: string) => void;
  onWeekdays: (v: number[]) => void;
  onMonthday: (v: number) => void;
}) {
  const t = useT();
  const [weekdayPickerOpen, setWeekdayPickerOpen] = useState(false);
  const weekdayPickerRef = useRef<HTMLDivElement | null>(null);
  const weekdayLabels = getWeekdayLabels(t);
  const selectedWeekdays = normalizeWeekdays(weekdays);
  useEffect(() => {
    if (!weekdayPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (weekdayPickerRef.current?.contains(target)) return;
      setWeekdayPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [weekdayPickerOpen]);
  const toggleWeekday = useCallback((day: number) => {
    // 至少保留 1 天：取消最后一个选中项时直接忽略，避免 normalizeWeekdays 静默兜底为周一
    if (selectedWeekdays.length === 1 && selectedWeekdays[0] === day) return;
    const next = selectedWeekdays.includes(day)
      ? selectedWeekdays.filter((v) => v !== day)
      : [...selectedWeekdays, day];
    onWeekdays(normalizeWeekdays(next));
  }, [onWeekdays, selectedWeekdays]);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-[112px]">
        <select
          value={period}
          onChange={(e) => onPeriod(e.target.value as RecurringPeriod)}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 pr-10 text-sm focus:border-black/30 focus:outline-none"
        >
          <option value="daily">{t("每天")}</option>
          <option value="weekly">{t("每周")}</option>
          <option value="monthly">{t("每月")}</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
      </div>
      {period === "weekly" && (
        <div ref={weekdayPickerRef} className="relative min-w-[220px] max-w-full">
          <button
            type="button"
            onClick={() => setWeekdayPickerOpen((open) => !open)}
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
            className="flex min-h-[42px] w-full items-center gap-1.5 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 pr-9 text-left text-sm focus:border-black/30 focus:outline-none"
            aria-haspopup="listbox"
            aria-expanded={weekdayPickerOpen}
          >
            <span className="flex flex-wrap items-center gap-1.5">
              {selectedWeekdays.map((day) => (
                <span
                  key={day}
                  className="inline-flex h-7 items-center rounded-full bg-black px-3 text-sm font-medium leading-none text-white"
                >
                  {weekdayLabels[day]}
                </span>
              ))}
            </span>
          </button>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
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
        <div className="relative w-[112px]">
          <select
            value={monthday}
            onChange={(e) => onMonthday(Number(e.target.value))}
            style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
            className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 pr-10 text-sm focus:border-black/30 focus:outline-none"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{t("{{n}} 日", { n: d })}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
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
  onNum,
  onUnit,
}: {
  num: number;
  unit: "m" | "h" | "d";
  onNum: (v: number) => void;
  onUnit: (v: "m" | "h" | "d") => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="text-base text-black/60" style={MODAL_CONTROL_TEXT_STYLE}>{t("每")}</span>
      <input
        type="number"
        min={1}
        value={num}
        onChange={(e) => onNum(Math.max(1, Number(e.target.value) || 1))}
        style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
        className="w-20 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none"
      />
      <div className="relative w-[124px]">
        <select
          value={unit}
          onChange={(e) => onUnit(e.target.value as "m" | "h" | "d")}
          style={MODAL_COMPACT_CONTROL_TEXT_STYLE}
          className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 pr-10 text-sm focus:border-black/30 focus:outline-none"
        >
          <option value="m">{t("分钟")}</option>
          <option value="h">{t("小时")}</option>
          <option value="d">{t("天")}</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
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
      style={MODAL_CONTROL_TEXT_STYLE}
      className="rounded-lg border border-black/10 bg-white px-3 py-2 text-base focus:border-black/30 focus:outline-none"
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
  monthday: number;
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
  return `${m} ${h} ${args.monthday} * *`;
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
    if (mon === "*" && dow === "*" && /^\d+$/.test(dom ?? "")) {
      return { kind: "recurring", period: "monthly", time, monthday: Number(dom) };
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
