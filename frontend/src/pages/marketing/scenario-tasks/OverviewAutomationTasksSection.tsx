import {
  ArrowLeftRight,
  ArrowRight,
  Activity,
  CalendarDays,
  CreditCard,
  Pill,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { useT } from "@/i18n/t";

import type { ScenarioTaskPack } from "./scenario-packs";

const TASK_ICON_BY_ID: Record<string, LucideIcon> = {
  "medication-once": Pill,
  "rent-reminder": CreditCard,
  "country-fx-alert": ArrowLeftRight,
  "calorie-fitness-checkin": Activity,
  "global-holiday-reminder": CalendarDays,
  "stock-info-digest": Wallet,
};

type OverviewAutomationTasksSectionProps = {
  packs: readonly ScenarioTaskPack[];
  installedScenarioIds: ReadonlySet<string>;
  myTasksHref: string;
  onEnable: (pack: ScenarioTaskPack) => void;
};

export function OverviewAutomationTasksSection(props: OverviewAutomationTasksSectionProps) {
  const t = useT();
  const { packs, myTasksHref, onEnable } = props;

  return (
    <section id="automations" className="w-full scroll-mt-20 py-16 sm:py-20" aria-labelledby="overview-automation-title">
      <div className="mx-auto w-full max-w-[1440px] px-5 sm:px-8 lg:px-16">
        <div className="mb-10 flex flex-col items-center gap-4 text-center">
          <div className="relative inline-flex items-center">
            <svg
              aria-hidden="true"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              className="absolute -left-4 -top-0.5"
            >
              <rect x="4" width="4" height="4" fill="black" />
              <rect width="4" height="8" fill="black" />
            </svg>
            <h2
              id="overview-automation-title"
              className="lw-font-hyruiyisong text-center text-[28px] leading-[42px] text-black/90 sm:text-[32px] sm:leading-[48px]"
              style={{
                WebkitTextStrokeWidth: "0.6px",
                WebkitTextStrokeColor: "var(--color-text-primary, rgba(0, 0, 0, 0.90))",
              }}
            >
              {t("把常用的事交给 Hermes")}
            </h2>
            <svg
              aria-hidden="true"
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              className="absolute -bottom-0.5 -right-4 rotate-180"
            >
              <rect x="4" width="4" height="4" fill="black" />
              <rect width="4" height="8" fill="black" />
            </svg>
          </div>
          <p className="max-w-[680px] font-['PingFang_SC:Regular',sans-serif] text-sm leading-6 text-black/50 sm:text-base">
            {t("选择一个场景，确认任务内容后启用；结果会推送到你选择的通知通道。")}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {packs.map((pack) => {
            const Icon = TASK_ICON_BY_ID[pack.id] ?? CalendarDays;
            return (
              <article
                key={pack.id}
                className="group flex min-h-[196px] flex-col rounded-[24px] bg-[#F7F7F5] p-5 transition duration-300 hover:-translate-y-1 sm:p-6"
              >
                <div className="flex items-start">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/90 text-black/65">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
                <div className="mt-4 min-w-0">
                  <h3 className="lw-font-hyruiyisong text-xl leading-8 text-black/85">{pack.name}</h3>
                  <p className="mt-1 line-clamp-2 text-sm leading-6 text-black/50">{pack.valueProp}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onEnable(pack)}
                  aria-label={t("启用{{name}}", { name: pack.name })}
                  className="mt-auto inline-flex w-fit items-center gap-1.5 pt-4 text-sm font-semibold text-black/75 transition group-hover:text-black"
                >
                  {t("启用")}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </button>
              </article>
            );
          })}
        </div>

        <div className="mt-8 flex justify-center">
          <a
            href={myTasksHref}
            className="inline-flex items-center gap-2 text-sm font-medium text-black/55 transition hover:text-black"
          >
            {t("管理我的自动任务")}
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    </section>
  );
}
