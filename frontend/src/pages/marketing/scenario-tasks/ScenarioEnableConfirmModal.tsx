import { Loader2, X } from "lucide-react";
import { createPortal } from "react-dom";

import { useT } from "@/i18n/t";
import type { ScenarioTaskPack } from "./scenario-packs";
import type { ScenarioTaskDraft } from "./scenario-task-builder";

export function ScenarioEnableConfirmModal({
  pack,
  draft,
  busy,
  onCancel,
  onConfirm,
}: {
  pack: ScenarioTaskPack;
  draft: ScenarioTaskDraft;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();

  return createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40 px-4 py-3" role="dialog" aria-modal="true" onClick={onCancel}>
      <div
        className="relative w-full max-w-[520px] rounded-lg bg-white p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-full text-black/50 transition hover:bg-black/[0.04] hover:text-black/80 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t("关闭")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5 pr-8">
          <p className="text-xs font-medium text-black/42">{pack.name}</p>
          <h2 className="mt-1 text-lg font-semibold text-black/90">{t("添加为自动任务")}</h2>
          <p className="mt-1 text-sm leading-6 text-black/55">
            {t("确认后会使用同一份场景配置创建周期任务。")}
          </p>
        </div>

        <dl className="overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <ConfirmRow label={t("任务名称")} value={draft.generatedName} />
          <ConfirmRow label={t("执行频率")} value={pack.defaultFrequencyLabel} />
          <ConfirmRow label={t("回传位置")} value={draft.generatedDeliverLabel} />
          <ConfirmRow label={t("关注内容")} value={buildFocusSummary(draft.values)} />
        </dl>

        {pack.safetyNote && (
          <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-[#8A5A00]">
            {pack.safetyNote}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/[0.08] bg-white px-4 text-sm font-semibold text-black/65 transition hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("取消")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-9 min-w-[104px] items-center justify-center gap-2 rounded-md bg-black px-4 text-sm font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("确认启用")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ConfirmRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-3 py-2.5">
      <dt className="text-black/42">{label}</dt>
      <dd className="min-w-0 break-words text-black/76">{value || "—"}</dd>
    </div>
  );
}

function buildFocusSummary(values: Record<string, string>): string {
  return Object.values(values)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("；");
}
