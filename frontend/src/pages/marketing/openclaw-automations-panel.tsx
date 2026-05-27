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
 * - 占位字段（工作空间 / 生效日期区间 / 推送 WorkBuddy）按截图渲染但 disabled
 */

import { AlertTriangle, ChevronDown, Clock, Eye, Loader2, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseHermesChannelList } from "@tencent/tea-sdk-lightclaw";
import { useT } from "@/i18n/t";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { readStoredAuthToken } from "@/repositories/http-repositories";
import {
  CronCommandError,
  createCronJob,
  editCronJob,
  listCronJobs,
  pauseCronJob,
  removeCronJob,
  resumeCronJob,
  type CronJob,
} from "@/lib/hermes-cron-client";

const PANEL_CARD_STYLE: React.CSSProperties = {
  border: "1px solid rgba(0,0,0,0.06)",
  background: "#ffffff",
  boxShadow: "0 4px 24px rgba(0,0,0,0.03), 0 1px 2px rgba(0,0,0,0.02)",
};
const MAX_CRON_JOBS_PER_BOT = 20;
const EXPIRED_CRON_JOB_HIDE_AFTER_MS = 2 * 60 * 1000;

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

export function AutomationsPanel({ botId }: { botId: string | null }) {
  const t = useT();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
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
          <h3 className="text-base font-semibold text-black/90">{t("定时任务")}</h3>
          <p className="mt-0.5 text-xs text-black/50">
            {t("让你的智能体伙伴按计划自动执行任务")}
          </p>
        </div>
        <div className="inline-flex">
          <button
            type="button"
            onClick={() => {
              if (jobLimitReached) {
                setConfirmCreateOverLimit(true);
                return;
              }
              setCreating(true);
            }}
            className="inline-flex min-w-[72px] items-center justify-center gap-1.5 rounded-lg bg-black px-3.5 py-1.5 text-white transition hover:bg-black/85"
          >
            <Plus className="h-4 w-4" />
            <span className="text-sm font-semibold leading-none">{t("添加")}</span>
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
            <p className="text-black/70">{t("加载定时任务失败")}</p>
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
            {t("还没有定时任务")}
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

      {confirmCreateOverLimit && (
        <ConfirmCreateOverLimitModal
          onCancel={() => setConfirmCreateOverLimit(false)}
          onConfirm={() => {
            setConfirmCreateOverLimit(false);
            setCreating(true);
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
  const fullName = job.name || t("未命名任务");
  // 卡片标题最多 12 个字符，超过用 … 省略；hover title 显示全名
  const displayName = fullName.length > 12 ? `${fullName.slice(0, 12)}…` : fullName;
  return (
    <div
      className="flex flex-col rounded-xl bg-white p-4 transition hover:shadow-md"
      style={{ ...PANEL_CARD_STYLE, minHeight: 178 }}
    >
      <div className="flex items-start justify-between gap-2 pb-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Clock className="h-4 w-4 shrink-0 text-black/40" />
          <span className="text-sm font-medium text-black/90" title={fullName}>
            {displayName}
          </span>
        </div>
        {(expired || paused) && (
          <div className="flex shrink-0 items-center gap-1">
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
        <span className="line-clamp-1 text-xs text-black/55">
          {formatScheduleFriendly(job, t)}
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
  if (!isOnce) return false;
  const d = parseOnceScheduleDate(display, job.next_run_at);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

function isCronJobExpiredBeyondGrace(job: CronJob): boolean {
  const kind = job.schedule.kind.toLowerCase();
  const display = (job.schedule.display || job.schedule.expr || "").trim();
  const isOnce = kind === "once" || display.toLowerCase().startsWith("once");
  if (!isOnce) return false;
  const d = parseOnceScheduleDate(display, job.next_run_at);
  return !Number.isNaN(d.getTime()) && Date.now() - d.getTime() > EXPIRED_CRON_JOB_HIDE_AFTER_MS;
}

/** 把 cron schedule + next_run_at 翻译成人话。
 *  - once：输出「单次 2026-05-26 09:00」，过期状态由卡片标签展示
 *  - interval：every 30m → 每 30 分钟；every 60m → 每 1 小时
 *  - cron：`0 9 * * *` → 每天 09:00；`0 9 * * 1` → 每周一 09:00；`0 9 1 * *` → 每月 1 日 09:00
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
    if (dom === "*" && mon === "*" && dow !== "*" && /^\d+$/.test(dow ?? "")) {
      const labels = [t("周日"), t("周一"), t("周二"), t("周三"), t("周四"), t("周五"), t("周六")];
      const w = Number(dow);
      if (w >= 0 && w <= 6) return t("每{{w}} {{at}}", { w: labels[w], at });
    }
    if (mon === "*" && dow === "*" && /^\d+$/.test(dom ?? "")) {
      return t("每月 {{d}} 日 {{at}}", { d: dom, at });
    }
  }

  return display || job.schedule.expr || "";
}

function parseOnceScheduleDate(display: string, nextRunAt: string | null): Date {
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

        <dl className="mt-4 space-y-3 text-sm">
          <DetailRow label={t("任务说明")} value={job.prompt || "—"} pre />
          <DetailRow label={t("执行时间")} value={formatScheduleFriendly(job, t)} />
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
        <dd className="mt-0.5 text-sm text-black/85 break-words">
          {formatDeliverFallback(deliver || "", t)}
        </dd>
      </div>
    );
  }

  return (
    <div>
      <dt className="text-xs text-black/50">{t("通知方式")}</dt>
      <dd className="mt-0.5 space-y-1 text-sm text-black/85 break-words">
        {parsed.platforms.map((platform) => {
          const label = getDeliverPlatformLabel(platform, t);
          const chatId = parsed.chatIds[platform];
          return (
            <div key={platform}>
              {chatId ? t("{{platform}}（Chat ID：{{chatId}}）", { platform: label, chatId }) : label}
            </div>
          );
        })}
      </dd>
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
  if (platform === "weixin") return t("微信");
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
    <code className="mx-1 inline-flex select-all align-baseline rounded-md border border-black/10 bg-[#D1D5DB] px-2 py-0.5 font-mono text-[11px] leading-[18px] text-black/80">
      {value}
    </code>
  );
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
        <h3 className="text-base font-semibold text-black/90">{t("删除定时任务")}</h3>
        <p className="mt-2 text-sm text-black/65">
          {t("确定要删除「{{name}}」吗？此操作无法恢复。", { name: jobName || t("未命名任务") })}
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-black/10 px-4 py-1.5 text-sm font-medium text-black/70 transition hover:bg-black/[0.04] disabled:opacity-40"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#B91C1C] px-4 py-1.5 text-sm font-medium text-white transition hover:bg-[#991B1B] disabled:opacity-40"
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

function parseCronDate(value: string): Date {
  // Hermes may return nanosecond-style fractional seconds; JS Date only needs milliseconds.
  return new Date(value.replace(/\.(\d{3})\d+(?=Z|[+-]\d{2}:?\d{2}$)/, ".$1"));
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

/* ─── Form Modal ─── */

type FrequencyKind = "recurring" | "interval" | "once";
type RecurringPeriod = "daily" | "weekly" | "monthly";

function AutomationFormModal({
  botId,
  mode,
  initialJob,
  onClose,
  onSaved,
  onError,
}: {
  botId: string;
  mode: "create" | "edit";
  initialJob?: CronJob;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialJob?.name ?? "");
  const [prompt, setPrompt] = useState(initialJob?.prompt ?? "");

  const initial = useMemo(() => parseInitialSchedule(initialJob?.schedule.display || initialJob?.schedule.expr || ""), [initialJob]);
  const defaultScheduleDate = useMemo(() => new Date(Date.now() + 60_000), []);
  const [kind, setKind] = useState<FrequencyKind>(initial?.kind ?? "recurring");
  // 周期态
  const [period, setPeriod] = useState<RecurringPeriod>(initial?.period ?? "daily");
  const [time, setTime] = useState(() => {
    if (initial?.time) return initial.time;
    // 默认取打开弹窗时的下一分钟（minute 精度，跟 cron 表达式粒度一致）
    const d = defaultScheduleDate;
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1); // 周一
  const [monthday, setMonthday] = useState(initial?.monthday ?? 1);
  // 按间隔态
  const [intervalNum, setIntervalNum] = useState(initial?.intervalNum ?? 1);
  const [intervalUnit, setIntervalUnit] = useState<"m" | "h" | "d">(initial?.intervalUnit ?? "h");
  // 单次态
  const [onceDate, setOnceDate] = useState(() => {
    if (initial?.onceDate) return initial.onceDate;
    // datetime-local 期望 "YYYY-MM-DDTHH:MM" 本地时间字符串。
    // 默认取打开弹窗时的下一分钟（与「周期」默认值一致）；submit 时才校验是否过期。
    const d = defaultScheduleDate;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  /** 通知方式多选：空数组 = 仅本地（不通知）；含值 = 该平台都推（home channel） */
  const initialDeliver = useMemo(() => parseInitialDeliver(initialJob?.deliver || ""), [initialJob]);
  const [deliverPlatforms, setDeliverPlatforms] = useState<string[]>(initialDeliver.platforms);
  /** 每个 platform 的可选 chat_id：填了 → 拼 `<platform>:<id>` 直送；留空 → 走 home */
  const [deliverChatIds, setDeliverChatIds] = useState<Record<string, string>>(initialDeliver.chatIds);
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
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const envelope = (await resp.json()) as { data?: { output?: string } };
        const output = envelope.data?.output ?? "";
        const entries = parseHermesChannelList(output);
        if (cancelled) return;
        setEnabledChannels(new Set(entries.filter((e) => e.enabled).map((e) => e.channel)));
      } catch {
        // 拉失败不阻塞表单；保留 null（视为未知 → 全部 enabled，让 hermes 自己报错）
        if (!cancelled) setEnabledChannels(new Set());
      }
    })();
    return () => { cancelled = true; };
  }, [botId]);

  const schedule = useMemo(() => buildScheduleString({
    kind, period, time, weekday, monthday, intervalNum, intervalUnit, onceDate,
  }), [kind, period, time, weekday, monthday, intervalNum, intervalUnit, onceDate]);
  const canSubmit = !submitting && name.trim().length > 0 && prompt.trim().length > 0 && schedule.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    // 单次任务必须晚于当前时间
    if (kind === "once") {
      const t0 = new Date(onceDate).getTime();
      if (!Number.isNaN(t0) && t0 <= Date.now()) {
        onError(t("不能选择早于当前的时间"));
        return;
      }
    }
    setSubmitting(true);
    try {
      const deliver = deliverPlatforms.length === 0
        ? "local"
        : deliverPlatforms
            .map((p) => {
              if (p !== "feishu") return p;
              const chatId = (deliverChatIds[p] || "").trim();
              return chatId ? `${p}:${chatId}` : p;
            })
            .join(",");
      if (mode === "create") {
        await createCronJob(botId, {
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          deliver,
        });
      } else if (initialJob) {
        await editCronJob(botId, initialJob.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          deliver,
        });
      }
      onSaved();
    } catch (err) {
      const message = err instanceof CronCommandError ? err.message : err instanceof Error ? err.message : String(err);
      onError(
        mode === "create"
          ? t("创建定时任务失败：{{message}}", { message })
          : t("编辑定时任务失败：{{message}}", { message }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [botId, canSubmit, mode, initialJob, name, prompt, schedule, kind, onceDate, deliverPlatforms, deliverChatIds, onSaved, onError, t]);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-8" role="dialog" aria-modal="true">
      <div className="relative max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-lg font-semibold text-black/90">
          {mode === "create" ? t("添加定时任务") : t("编辑定时任务")}
        </h2>

        {/* 名称 */}
        <div className="mt-5">
          <label className="block text-sm font-medium text-black/80">{t("名称")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 60))}
            maxLength={60}
            placeholder={t("请输入定时任务名称")}
            className="mt-1.5 w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
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
                onClick={() => setKind(k)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition ${
                  kind === k ? "bg-white text-black/90 shadow-sm" : "text-black/50 hover:text-black/80"
                }`}
              >
                {k === "recurring" ? t("周期") : k === "interval" ? t("按间隔") : t("单次")}
              </button>
            ))}
          </div>
          <div className="mt-3">
            {kind === "recurring" && (
              <RecurringPicker
                period={period}
                time={time}
                weekday={weekday}
                monthday={monthday}
                onPeriod={setPeriod}
                onTime={setTime}
                onWeekday={setWeekday}
                onMonthday={setMonthday}
              />
            )}
            {kind === "interval" && (
              <IntervalPicker
                num={intervalNum}
                unit={intervalUnit}
                onNum={setIntervalNum}
                onUnit={setIntervalUnit}
              />
            )}
            {kind === "once" && <OncePicker value={onceDate} onChange={setOnceDate} />}
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
            className="mt-3 w-full resize-none rounded-lg border border-black/10 bg-white px-3 py-2 text-sm placeholder:text-sm placeholder:text-black/35 focus:border-black/30 focus:outline-none"
            style={{ marginTop: 12 }}
          />
        </div>

        {/* 通知方式（多选；不勾任何 = 仅本地写日志） */}
        <div className="mt-4">
          <label className="block text-sm font-medium text-black/80">
            {t("通知方式")}<span className="ml-1 text-xs font-normal text-black/40">{t("（可选）")}</span>
          </label>
          <div className="mt-2 space-y-2">
            {(
              [
                { key: "weixin", label: t("微信") },
                { key: "qqbot", label: "QQ" },
                { key: "feishu", label: t("飞书") },
              ] as const
            ).map(({ key, label }) => {
              const configured = enabledChannels === null || enabledChannels.has(key);
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
                      onChange={() =>
                        setDeliverPlatforms((prev) =>
                          prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
                        )
                      }
                      className="h-4 w-4 cursor-pointer rounded border-black/20 accent-black disabled:cursor-not-allowed"
                    />
                    <span>
                      {label}
                      {!configured && <span className="ml-0.5 text-[10px]">{t("（未配置）")}</span>}
                    </span>
                    {selected && key === "qqbot" && (
                      <span className="text-xs text-black/40">
                        {t("QQ 需设置 home 对话才能发送通知（在 QQ 对话中发送")}
                        <InlineCopyText value="/set-home" />
                        {t("给机器人）")}
                      </span>
                    )}
                    {selected && key === "feishu" && (
                      <span className="text-xs text-black/40">{t("飞书支持通过 home 对话或指定 Chat ID发送通知")}</span>
                    )}
                  </label>

                  {selected && key === "qqbot" && (
                    <p className="mt-1.5 pl-5 text-xs leading-6 text-black/40">
                      {t("设置 home 对话：在 QQ 应用中，在对话中向智能体发送")}
                      <InlineCopyText value="/set-home" />
                      {t("。")}
                    </p>
                  )}

                  {selected && key === "feishu" && (
                    <div className="mt-1.5 space-y-1.5 pl-5">
                      <div className="flex items-center gap-1">
                        <span className="w-20 shrink-0 text-xs text-black/50">
                          {t("飞书对话 ID")}
                        </span>
                        <input
                          type="text"
                          value={deliverChatIds[key] ?? ""}
                          onChange={(e) =>
                            setDeliverChatIds((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder={t("选填，留空则在home对话(如已设置)中通知；也可指定Chat ID通知")}
                          className="flex-1 rounded-lg border border-black/10 bg-white px-3 py-1.5 text-xs placeholder:text-xs placeholder:text-black/35 focus:border-black/30 focus:outline-none"
                          style={{ fontSize: 12, lineHeight: "16px" }}
                        />
                      </div>
                      <div className="space-y-1 text-xs leading-6 text-black/40">
                        <p>
                          {t("1. 设置 home 对话：在飞书应用中，在对话中向智能体发送")}
                          <InlineCopyText value="/set-home" />
                          {t("。如未在上面输入框中指定 Chat ID，则默认通过 home 对话发送通知。")}
                        </p>
                        <p>
                          {t("2. 获取对话 ID：在飞书应用中，找到希望发送通知的对话，向智能体发送提示词")}
                          <InlineCopyText value={t("当前Chat ID是什么")} />
                          {t("，正常会回复前缀为oc_的一串字符。在上面输入框中输入Chat ID，指定该对话来通知。")}
                        </p>
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
            <p className="text-xs text-black/40">
              {t("如不选，则只会在后台执行任务，不发通知。")}
            </p>
          ) : null}
        </div>

        {/* 操作 */}
        <div className="mt-6 flex items-center justify-end gap-2">
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
  weekday,
  monthday,
  onPeriod,
  onTime,
  onWeekday,
  onMonthday,
}: {
  period: RecurringPeriod;
  time: string;
  weekday: number;
  monthday: number;
  onPeriod: (v: RecurringPeriod) => void;
  onTime: (v: string) => void;
  onWeekday: (v: number) => void;
  onMonthday: (v: number) => void;
}) {
  const t = useT();
  const weekdayLabels = [t("周日"), t("周一"), t("周二"), t("周三"), t("周四"), t("周五"), t("周六")];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-[112px]">
        <select
          value={period}
          onChange={(e) => onPeriod(e.target.value as RecurringPeriod)}
          className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 pr-10 text-sm focus:border-black/30 focus:outline-none"
        >
          <option value="daily">{t("每天")}</option>
          <option value="weekly">{t("每周")}</option>
          <option value="monthly">{t("每月")}</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-5 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
      </div>
      {period === "weekly" && (
        <div className="relative w-[112px]">
          <select
            value={weekday}
            onChange={(e) => onWeekday(Number(e.target.value))}
            className="w-full appearance-none rounded-lg border border-black/10 bg-white px-3 py-2 pr-10 text-sm focus:border-black/30 focus:outline-none"
          >
            {weekdayLabels.map((label, idx) => (
              <option key={idx} value={idx}>{label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-black/80" />
        </div>
      )}
      {period === "monthly" && (
        <div className="relative w-[112px]">
          <select
            value={monthday}
            onChange={(e) => onMonthday(Number(e.target.value))}
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
      <span className="text-sm text-black/60">{t("每")}</span>
      <input
        type="number"
        min={1}
        value={num}
        onChange={(e) => onNum(Math.max(1, Number(e.target.value) || 1))}
        className="w-20 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm focus:border-black/30 focus:outline-none"
      />
      <div className="relative w-[124px]">
        <select
          value={unit}
          onChange={(e) => onUnit(e.target.value as "m" | "h" | "d")}
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
  weekday: number;
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
  if (args.period === "weekly") return `${m} ${h} * * ${args.weekday}`;
  return `${m} ${h} ${args.monthday} * *`;
}

/**
 * 反向解析 schedule 字符串为表单初始值（编辑场景）。
 * 解析失败返回 null，调用方走默认值。
 */
function parseInitialSchedule(display: string): {
  kind: FrequencyKind;
  period?: RecurringPeriod;
  time?: string;
  weekday?: number;
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
    if (!/^\d+$/.test(mn ?? "") || !/^\d+$/.test(hr ?? "")) return { kind: "recurring" };
    const time = `${String(hr).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
    if (dom === "*" && mon === "*" && dow === "*") {
      return { kind: "recurring", period: "daily", time };
    }
    if (dom === "*" && mon === "*" && /^\d+$/.test(dow ?? "")) {
      return { kind: "recurring", period: "weekly", time, weekday: Number(dow) };
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
 */
function parseInitialDeliver(deliver: string): {
  platforms: string[];
  chatIds: Record<string, string>;
} {
  const empty = { platforms: [] as string[], chatIds: {} as Record<string, string> };
  if (!deliver || deliver === "local") return empty;
  const platforms: string[] = [];
  const chatIds: Record<string, string> = {};
  const known = new Set(["weixin", "qqbot", "feishu"]);
  for (const raw of deliver.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const idx = tok.indexOf(":");
    const platform = idx >= 0 ? tok.slice(0, idx) : tok;
    const chatId = idx >= 0 ? tok.slice(idx + 1) : "";
    if (!known.has(platform)) continue;
    if (!platforms.includes(platform)) platforms.push(platform);
    if (chatId) chatIds[platform] = chatId;
  }
  return { platforms, chatIds };
}
