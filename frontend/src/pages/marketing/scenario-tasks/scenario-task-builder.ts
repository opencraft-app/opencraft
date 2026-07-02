import type { CronRunRecord } from "@/lib/hermes-cron-client";
import type { ScenarioTaskId, ScenarioTaskPack } from "./scenario-packs";

export interface ScenarioTaskDraft {
  scenarioId: ScenarioTaskId;
  values: Record<string, string>;
  generatedName: string;
  generatedPrompt: string;
  generatedDeliver: string;
  generatedDeliverLabel: string;
  oneShotSchedule: string;
  recurringSchedule: string;
  oneShotJobName: string;
}

export type ScenarioDeliveryTarget = "local" | "weixin" | "qqbot";

const SCENARIO_DELIVER_LABELS: Record<ScenarioDeliveryTarget, string> = {
  local: "网页 / 最近执行",
  weixin: "微信",
  qqbot: "QQ",
};

export function buildOneShotSchedule(now = new Date(), delayMs = 5_000): string {
  const next = new Date(now.getTime() + delayMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    next.getFullYear(),
    "-",
    pad(next.getMonth() + 1),
    "-",
    pad(next.getDate()),
    "T",
    pad(next.getHours()),
    ":",
    pad(next.getMinutes()),
    ":",
    pad(next.getSeconds()),
  ].join("");
}

export function buildScenarioTaskDraft({
  pack,
  values,
  now = new Date(),
  deliver = "local",
}: {
  pack: ScenarioTaskPack;
  values: Record<string, string>;
  now?: Date;
  deliver?: string;
}): ScenarioTaskDraft {
  const normalizedValues = normalizeScenarioValues(pack, values);
  return {
    scenarioId: pack.id,
    values: normalizedValues,
    generatedName: pack.name,
    generatedPrompt: pack.promptBuilder(normalizedValues),
    generatedDeliver: normalizeScenarioDeliverTarget(deliver),
    generatedDeliverLabel: formatScenarioDeliverLabel(deliver),
    oneShotSchedule: buildOneShotSchedule(now),
    recurringSchedule: pack.defaultSchedule,
    oneShotJobName: `试跑 - ${pack.name}`,
  };
}

export function normalizeScenarioDeliverTarget(deliver: string): ScenarioDeliveryTarget {
  if (deliver === "weixin" || deliver === "qqbot") return deliver;
  return "local";
}

export function formatScenarioDeliverLabel(deliver: string): string {
  return SCENARIO_DELIVER_LABELS[normalizeScenarioDeliverTarget(deliver)];
}

export function normalizeScenarioValues(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    pack.fields.map((field) => {
      const raw = values[field.key]?.trim();
      return [field.key, raw || field.defaultValue];
    }),
  );
}

export function findScenarioPreviewRun(
  draft: ScenarioTaskDraft,
  runs: CronRunRecord[],
  startedAtMs: number,
): CronRunRecord | null {
  const candidates = runs
    .filter((run) => {
      const runAtMs = Date.parse(run.run_at);
      return Number.isNaN(runAtMs) || runAtMs >= startedAtMs;
    })
    .sort((a, b) => Date.parse(b.run_at) - Date.parse(a.run_at));

  return candidates.find((run) => run.job_name === draft.oneShotJobName)
    ?? candidates.find((run) => run.job_prompt === draft.generatedPrompt)
    ?? candidates.find((run) => run.job_name.includes(draft.generatedName))
    ?? null;
}

export function isScenarioRecurringJobName(
  draft: Pick<ScenarioTaskDraft, "generatedName">,
  jobName: string,
): boolean {
  return jobName === draft.generatedName;
}
