import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, X } from "lucide-react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/t";
import type { CronRunRecord } from "@/lib/hermes-cron-client";
import type { ScenarioTaskPack } from "./scenario-packs";
import type { ScenarioTaskDraft } from "./scenario-task-builder";

export type ScenarioPreviewStatus =
  | "creating"
  | "waiting"
  | "succeeded"
  | "timeout"
  | "failed"
  | "enabling"
  | "enabled";

export function ScenarioRunPreview({
  pack,
  draft,
  status,
  run,
  errorMessage,
  onClose,
  onEdit,
  onRefresh,
  onEnable,
}: {
  pack: ScenarioTaskPack;
  draft: ScenarioTaskDraft;
  status: ScenarioPreviewStatus;
  run: CronRunRecord | null;
  errorMessage: string | null;
  onClose: () => void;
  onEdit: () => void;
  onRefresh: () => void;
  onEnable: () => void;
}) {
  const t = useT();
  const visual = getPreviewVisual(status, t);
  const StatusIcon = visual.Icon;
  const canEnable = status === "succeeded" || status === "timeout";
  const busy = status === "creating" || status === "waiting" || status === "enabling";

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="relative max-h-[calc(100vh-24px)] w-full max-w-[620px] overflow-y-auto rounded-lg bg-white p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5 pr-8">
          <p className="text-xs font-medium text-black/42">{pack.name}</p>
          <h2 className="mt-1 text-lg font-semibold text-black/90">{t("场景试跑")}</h2>
        </div>

        <section className="rounded-md border border-black/[0.08] bg-white p-4">
          <div className="flex items-start gap-3">
            <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${visual.iconClass}`}>
              <StatusIcon className={`h-5 w-5 ${visual.spin ? "animate-spin" : ""}`} />
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-black/86">{visual.title}</h3>
              <p className="mt-1 text-sm leading-6 text-black/55">{visual.description}</p>
              {errorMessage && (
                <p className="mt-2 break-words rounded-md border border-red-500/15 bg-red-500/[0.06] px-3 py-2 text-xs leading-5 text-red-700">
                  {errorMessage}
                </p>
              )}
            </div>
          </div>
        </section>

        <dl className="mt-4 overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <PreviewRow label={t("试跑任务")} value={draft.oneShotJobName} />
          <PreviewRow label={t("常态任务")} value={draft.generatedName} />
          <PreviewRow label={t("常态频率")} value={pack.defaultFrequencyLabel} />
          <PreviewRow label={t("回传位置")} value={draft.generatedDeliverLabel} />
          {run && <PreviewRow label={t("最近执行")} value={`${formatRunTime(run.run_at)} · ${run.status || t("已执行")}`} />}
        </dl>

        <div className="mt-4 rounded-md border border-black/[0.08] bg-black/[0.02] px-3 py-2">
          <p className="line-clamp-4 whitespace-pre-line text-xs leading-5 text-black/55">{draft.generatedPrompt}</p>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("修改后再跑一次")}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={status === "creating" || status === "enabling"}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/70 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${status === "waiting" ? "animate-spin" : ""}`} />
            {t("刷新")}
          </button>
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable || status === "enabling"}
            className="inline-flex h-9 min-w-[132px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "enabling" && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("添加为自动任务")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function getPreviewVisual(status: ScenarioPreviewStatus, t: ReturnType<typeof useT>) {
  if (status === "creating" || status === "waiting") {
    return {
      Icon: Loader2,
      spin: true,
      iconClass: "bg-[#EEF4FF] text-[#315FAD]",
      title: t("Hermes 正在试跑这个场景"),
      description: t("通常需要几十秒到几分钟。你可以留在此页，也可以稍后在最近执行中查看。"),
    };
  }
  if (status === "succeeded" || status === "enabled") {
    return {
      Icon: CheckCircle2,
      spin: false,
      iconClass: "bg-[#EAF7EF] text-[#167A3F]",
      title: status === "enabled" ? t("已添加为自动任务") : t("试跑已完成"),
      description: status === "enabled"
        ? t("同一份场景配置已经创建为常态任务。")
        : t("结果已按所选方式回传，并可在最近执行中查看记录。"),
    };
  }
  if (status === "timeout") {
    return {
      Icon: Clock,
      spin: false,
      iconClass: "bg-[#FFF5D6] text-[#9A6100]",
      title: t("任务可能仍在执行"),
      description: t("最近执行暂时还没有出现结果，可以刷新或稍后查看；如果这个配置没问题，也可以先添加为自动任务。"),
    };
  }
  return {
    Icon: AlertTriangle,
    spin: false,
    iconClass: "bg-red-500/[0.08] text-red-700",
    title: t("试跑创建失败"),
    description: t("请检查场景配置或稍后重试。"),
  };
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-3 py-2.5">
      <dt className="text-black/42">{label}</dt>
      <dd className="min-w-0 break-words text-black/76">{value}</dd>
    </div>
  );
}

function formatRunTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
