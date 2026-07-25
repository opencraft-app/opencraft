import type { CronJob, CronRunRecord } from "@/lib/hermes-cron-client";
import { buildScenarioTaskDraft } from "./scenario-task-builder";
import { getOverviewScenarioTaskPacks, type ScenarioTaskId, type ScenarioTaskPack } from "./scenario-packs";

type AutomationDisplayLocale = "zh-CN" | "zh-SG" | "en-US";

export interface ScenarioJobPresentation {
  name: string;
  prompt: string;
}

const CJK_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

const SCENARIO_NAME_ALIASES: Partial<Record<ScenarioTaskId, readonly string[]>> = {
  "medication-once": ["用药提醒", "喝水提醒", "喝水与吃药提醒", "Water & medication reminders"],
  "rent-reminder": ["交租提醒", "房租提醒", "Rent reminder"],
  "country-fx-alert": ["汇率到价提醒", "汇率提醒", "Exchange-rate alert"],
  "calorie-fitness-checkin": ["卡路里与健身记录", "健身记录", "Calorie & fitness log"],
  "global-holiday-reminder": ["全球节假日提醒", "节假日与天气", "Holidays & weather"],
  "stock-info-digest": ["股票信息速递", "股票信息", "Stock update digest"],
};

export function getScenarioCronJobPresentation(
  job: Pick<CronJob, "name" | "prompt">,
  locale: AutomationDisplayLocale,
): ScenarioJobPresentation {
  return getScenarioRecordPresentation(job.name, job.prompt, locale);
}

export function getScenarioRunPresentation(
  run: Pick<CronRunRecord, "job_name" | "job_prompt">,
  locale: AutomationDisplayLocale,
): ScenarioJobPresentation {
  return getScenarioRecordPresentation(run.job_name, run.job_prompt, locale);
}

function getScenarioRecordPresentation(
  rawName: string,
  rawPrompt: string,
  locale: AutomationDisplayLocale,
): ScenarioJobPresentation {
  if (locale !== "en-US") return { name: rawName, prompt: rawPrompt };

  const match = findOverviewScenarioPack(rawName, rawPrompt);
  if (!match) return { name: rawName, prompt: rawPrompt };

  const englishName = buildEnglishScenarioJobName(match.englishPack, rawName, match.aliases);
  const englishPrompt = buildScenarioTaskDraft({
    pack: match.englishPack,
    values: {},
    userPrompt: match.englishPack.quickPrompt,
  }).generatedPrompt;

  return {
    name: englishName,
    prompt: englishPrompt,
  };
}

function findOverviewScenarioPack(
  rawName: string,
  rawPrompt: string,
): { englishPack: ScenarioTaskPack; aliases: readonly string[] } | null {
  const haystack = `${rawName}\n${rawPrompt}`;
  const zhPacks = getOverviewScenarioTaskPacks("zh-CN");
  const enPacks = getOverviewScenarioTaskPacks("en-US");

  for (const [index, zhPack] of zhPacks.entries()) {
    const englishPack = enPacks[index];
    if (!englishPack) continue;
    const aliases = [
      zhPack.name,
      englishPack.name,
      ...(SCENARIO_NAME_ALIASES[zhPack.id] ?? []),
    ];
    if (aliases.some((alias) => alias && haystack.includes(alias))) {
      return { englishPack, aliases };
    }
  }
  return null;
}

function buildEnglishScenarioJobName(
  englishPack: ScenarioTaskPack,
  rawName: string,
  aliases: readonly string[],
): string {
  const suffix = extractScenarioJobSuffix(rawName, aliases);
  if (!suffix || CJK_TEXT_RE.test(suffix)) return englishPack.name;
  return `${englishPack.name} · ${suffix}`;
}

function extractScenarioJobSuffix(rawName: string, aliases: readonly string[]): string {
  const normalizedName = rawName.trim();
  for (const alias of aliases) {
    if (!alias || !normalizedName.startsWith(alias)) continue;
    const suffix = normalizedName.slice(alias.length).replace(/^\s*[·:-]\s*/, "").trim();
    return suffix;
  }
  return "";
}
