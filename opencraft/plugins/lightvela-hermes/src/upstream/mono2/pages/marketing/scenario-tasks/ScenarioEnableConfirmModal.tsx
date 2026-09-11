// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { useT } from "../../../i18n/t";
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

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !busy) onCancel();
    }}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[520px] rounded-lg bg-white p-6 shadow-2xl md:w-[520px]">
        <DialogHeader className="mb-5 pr-8">
          <p className="text-xs font-medium text-black/42">{pack.name}</p>
          <DialogTitle className="mt-1 text-lg font-semibold text-black/90">{t("添加为定时任务")}</DialogTitle>
          <DialogDescription className="mt-1 text-sm leading-6 text-black/55">
            {t("确认后会按这份任务说明创建定时任务。")}
          </DialogDescription>
        </DialogHeader>

        <dl className="overflow-hidden rounded-md border border-black/[0.08] bg-white text-sm divide-y divide-black/[0.06]">
          <ConfirmRow label={t("任务名称")} value={draft.generatedName} />
          <ConfirmRow label={t("执行时间")} value={pack.defaultFrequencyLabel} />
          <ConfirmRow label={t("通知方式")} value={draft.generatedDeliverLabel} />
          <ConfirmRow label={t("任务备注")} value={buildFocusSummary(draft.values)} />
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
      </DialogContent>
    </Dialog>
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
