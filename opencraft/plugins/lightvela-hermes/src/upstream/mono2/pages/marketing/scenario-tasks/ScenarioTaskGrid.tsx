// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { BrainCircuit, CheckCircle2, Newspaper, Play, TrendingUp, Trophy } from "lucide-react";

import { useT } from "../../../i18n/t";
import type { ScenarioTaskId, ScenarioTaskPack } from "./scenario-packs";

const ICONS = {
  "trending-up": TrendingUp,
  trophy: Trophy,
  newspaper: Newspaper,
  "brain-circuit": BrainCircuit,
} as const;

const ICON_STYLES = {
  "trending-up": "bg-[#EAF7EF] text-[#167A3F]",
  trophy: "bg-[#FFF5D6] text-[#9A6100]",
  newspaper: "bg-[#EEF4FF] text-[#315FAD]",
  "brain-circuit": "bg-[#F0EDFF] text-[#6650B6]",
} as const;

export function ScenarioTaskGrid({
  packs,
  installedScenarioIds,
  compact = false,
  onRunOnce,
  onSchedule,
}: {
  packs: ScenarioTaskPack[];
  installedScenarioIds: Set<ScenarioTaskId>;
  compact?: boolean;
  onRunOnce: (pack: ScenarioTaskPack) => void;
  onSchedule: (pack: ScenarioTaskPack) => void;
}) {
  const t = useT();

  return (
    <section className="rounded-md border border-black/[0.06] bg-white p-4 shadow-[0_4px_24px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-black/90">{t("场景任务")}</h3>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-black/50">
            {t("先让 Hermes Agent 替你长期盯一件事；选一个场景先跑一次，结果有用后再添加为定时任务。")}
          </p>
        </div>
      </div>

      <div className={`mt-3 grid grid-cols-1 gap-3 ${compact ? "lg:grid-cols-4" : "sm:grid-cols-2 xl:grid-cols-4"}`}>
        {packs.map((pack) => {
          const Icon = ICONS[pack.icon];
          const installed = installedScenarioIds.has(pack.id);
          return (
            <article
              key={pack.id}
              className="flex min-h-[190px] flex-col rounded-md border border-black/[0.06] bg-white p-3 transition hover:border-black/[0.12] hover:shadow-[0_10px_28px_rgba(15,23,42,0.055)]"
            >
              <div className="flex items-start justify-between gap-2">
                <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${ICON_STYLES[pack.icon]}`}>
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                {installed && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#EAF7EF] px-2 py-0.5 text-[11px] font-medium text-[#167A3F]">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("已启用")}
                  </span>
                )}
              </div>
              <div className="mt-3 min-w-0">
                <h4 className="truncate text-sm font-semibold text-black/88" title={pack.name}>{pack.name}</h4>
                <p className="mt-1 line-clamp-2 min-h-[40px] text-xs leading-5 text-black/55">{pack.description}</p>
              </div>
              <dl className="mt-3 grid gap-1.5 text-[11px] leading-4 text-black/45">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <dt>{t("默认频率")}</dt>
                  <dd className="truncate text-black/62" title={pack.defaultFrequencyLabel}>{pack.defaultFrequencyLabel}</dd>
                </div>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <dt>{t("需要信息")}</dt>
                  <dd className="truncate text-black/62" title={pack.requiredInfoLabel}>{pack.requiredInfoLabel}</dd>
                </div>
              </dl>
              <div className="mt-auto flex items-center gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => onRunOnce(pack)}
                  className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-black px-2.5 text-xs font-semibold text-white transition hover:bg-black/85"
                >
                  <Play className="h-3.5 w-3.5" />
                  {t("先跑一次")}
                </button>
                <button
                  type="button"
                  onClick={() => onSchedule(pack)}
                  className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-black/[0.08] bg-white px-2.5 text-xs font-semibold text-black/68 transition hover:bg-black/[0.04] hover:text-black/85"
                >
                  {t("设置后定时")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
