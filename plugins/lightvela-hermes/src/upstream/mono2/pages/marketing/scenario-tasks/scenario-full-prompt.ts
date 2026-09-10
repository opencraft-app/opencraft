// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import {
  formatScenarioQuickPrompt,
  type ScenarioTaskPack,
} from "./scenario-packs";

const PROMPT_DETAIL_MARKER = "【完整任务说明】";
const LEGACY_RULES_MARKER = "【完整执行规则】";

const DEFAULT_EXECUTION_TIME_BY_ID: Record<string, string> = {
  "medication-once": "每天 08:00、20:00（可改为一个或多个时间；单次提醒请同时修改执行方式）",
  "rent-reminder": "每天 09:00（每天检查账期，只在提醒节点通知）",
  "country-fx-alert": "每天 10:00（每天检查一次，达到条件才通知）",
  "todo-focus-brief": "工作日 09:00（可改为每天或其他明确周期）",
  "global-holiday-reminder": "每天 09:00（每天检查假期节点，未到节点不通知）",
  "hydration-standup-reminder": "每天 09:00 到 18:00，每 1 小时（可改起止时间和间隔）",
  "stock-info-digest": "每天 09:00",
};

export function supportsScenarioFullPrompt(pack: ScenarioTaskPack): boolean {
  return Object.prototype.hasOwnProperty.call(DEFAULT_EXECUTION_TIME_BY_ID, pack.id);
}

const WEEKDAY_NUMBER_BY_LABEL: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

export type ScenarioFullPromptIssue =
  | "missing-mode"
  | "invalid-mode"
  | "missing-time"
  | "invalid-time"
  | "past-time";

export interface ParsedScenarioFullPrompt {
  issue: ScenarioFullPromptIssue | null;
  name: string;
  runMode: "recurring" | "one-shot";
  schedule: string;
  dailyTimes: string[];
}

export interface ScenarioFullPromptSections {
  primary: string;
  rules: string;
}

const DETAIL_HEADING = "完整 Prompt：";
const LEGACY_DETAIL_HEADING = "Prompt 写法约定：";

export function buildScenarioFullPrompt(
  pack: ScenarioTaskPack,
  taskRequestOverride?: string,
): string {
  const values = Object.fromEntries(pack.fields.map((field) => [field.key, field.defaultValue]));
  const defaultTaskRequest = pack.quickPromptTemplate?.length
    ? formatScenarioQuickPrompt(pack, values)
    : pack.quickPrompt;
  const taskRequest = taskRequestOverride?.trim() || defaultTaskRequest;
  const { executionMode, executionTime } = inferPromptExecution(pack, taskRequest);

  return [
    `【任务名称】${pack.name}（可改成方便你识别的名称）`,
    `【执行方式】${executionMode}（可改为“一次性推送”；一次性时请填写完整日期时间）`,
    `【执行时间】${executionTime}`,
    `【任务要求】${taskRequest}`,
    "",
    PROMPT_DETAIL_MARKER,
    DETAIL_HEADING,
    "1. 以用户在【任务要求】中写下的内容为最高优先级；括号里的提示也属于可修改内容，不要当作强制规则。",
    "2. 如果用户把执行方式改成一次性推送，只执行这一回，完成后不再循环；如果是长期推送，按执行时间持续检查。",
    "3. 如果任务要求里出现多个事项，先抽取任务名称、时间、地点、金额、对象、阈值和提醒节点，再生成执行计划。",
    "4. 不要要求用户二次填写表单；信息不足时按默认值执行，只有会影响安全或结论真实性时才提醒用户补充。",
    "",
    pack.promptBuilder(values),
    "",
    "通用输出要求：",
    "1. 直接输出可以发给用户的最终消息，不显示 Cronjob、job_id、HTTP 状态码、命令或调试过程。",
    "2. 用户可见消息尽量短：优先 1 个结论 + 1-3 条行动点；除非用户要求，不输出长篇解释。",
    "3. 有明确结论时优先在前两行说清；没有触发条件时按任务规则输出 [SILENT]。",
    "4. 外部来源无法访问时简短说明失败来源和下一步，不用内部错误代替用户文案。",
    "5. Cron 会自动把最终响应发送到通知方式，不要在正文中再次主动发消息。",
  ].join("\n").trim();
}

function inferPromptExecution(
  pack: ScenarioTaskPack,
  taskRequest: string,
): { executionMode: "长期推送" | "一次性推送"; executionTime: string } {
  if (/(?:仅这一次|一次性|单次)/.test(taskRequest)) {
    const oneShotTime = extractOneShotDateTime(taskRequest);
    return {
      executionMode: "一次性推送",
      executionTime: oneShotTime || "请填写完整日期、时间和时区",
    };
  }

  const explicitTimes = [...taskRequest.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)/g)]
    .map((match) => `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`)
    .filter((time, index, times) => times.indexOf(time) === index);
  const canUseTypedTimes = pack.id === "medication-once"
    || pack.id === "calorie-fitness-checkin"
    || pack.id === "hydration-standup-reminder";

  return {
    executionMode: "长期推送",
    executionTime: canUseTypedTimes && explicitTimes.length
      ? `每天 ${explicitTimes.join("、")}`
      : DEFAULT_EXECUTION_TIME_BY_ID[pack.id]
        ?? `${pack.defaultFrequencyLabel}（请改成明确时间）`,
  };
}

function extractOneShotDateTime(value: string): string {
  const isoMatch = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!isoMatch) return "";
  const [, year = "", month = "", day = "", hour = "", minute = "", second = ""] = isoMatch;
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${hour.padStart(2, "0")}:${minute}`;
  return second ? `${normalized}:${second}` : normalized;
}

export function highlightScenarioPromptPrimaryHtml(primary: string): string {
  return primary
    .split("\n")
    .map((line) => {
      const match = /^(【[^】]+】)(.*)$/.exec(line);
      if (!match) return escapeHtml(line);
      const [, label = "", rest = ""] = match;
      const { value, hint } = splitEditablePromptValue(rest);
      return [
        escapeHtml(label),
        `<span style="color:#B91C1C;font-weight:600">${escapeHtml(value)}</span>`,
        escapeHtml(hint),
      ].join("");
    })
    .join("\n");
}

export function formatScenarioPromptEditorText(prompt: string): string {
  const sections = splitScenarioFullPrompt(prompt);
  return sections.rules ? `${sections.primary}\n\n${sections.rules}` : sections.primary;
}

export function parseScenarioPromptEditorText(text: string): ScenarioFullPromptSections {
  const detailIndex = findPromptDetailHeadingIndex(text);
  if (detailIndex < 0) return { primary: text.trim(), rules: "" };
  return {
    primary: text.slice(0, detailIndex).trimEnd(),
    rules: text.slice(detailIndex).trim(),
  };
}

export function highlightScenarioPromptEditorHtml(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^(【[^】]+】)(.*)$/.exec(line);
      if (!match) return escapeHtml(line);
      const [, label = "", rest = ""] = match;
      const { value, hint } = splitEditablePromptValue(rest);
      return [
        escapeHtml(label),
        `<span style="color:#B91C1C;font-weight:600">${escapeHtml(value)}</span>`,
        escapeHtml(hint),
      ].join("");
    })
    .join("\n");
}

function findPromptDetailHeadingIndex(text: string): number {
  const detailIndex = text.indexOf(DETAIL_HEADING);
  if (detailIndex >= 0) return detailIndex;
  return text.indexOf(LEGACY_DETAIL_HEADING);
}

export function isScenarioFullPrompt(prompt: string): boolean {
  return prompt.includes("【执行方式】")
    || prompt.includes("【执行时间】")
    || prompt.includes(PROMPT_DETAIL_MARKER)
    || prompt.includes(LEGACY_RULES_MARKER);
}

export function splitScenarioFullPrompt(prompt: string): ScenarioFullPromptSections {
  const marker = prompt.includes(PROMPT_DETAIL_MARKER) ? PROMPT_DETAIL_MARKER : LEGACY_RULES_MARKER;
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex < 0) return { primary: prompt.trim(), rules: "" };
  return {
    primary: prompt.slice(0, markerIndex).trimEnd(),
    rules: prompt.slice(markerIndex + marker.length).trim(),
  };
}

export function combineScenarioFullPrompt(sections: ScenarioFullPromptSections): string {
  const primary = sections.primary.trim();
  const rules = sections.rules.trim();
  return rules ? `${primary}\n\n${PROMPT_DETAIL_MARKER}\n${rules}` : primary;
}

export function parseScenarioFullPrompt(
  prompt: string,
  now = new Date(),
): ParsedScenarioFullPrompt {
  const name = stripPromptHint(readPromptDirective(prompt, "任务名称"));
  const modeText = stripPromptHint(readPromptDirective(prompt, "执行方式"));
  const timeText = stripPromptHint(readPromptDirective(prompt, "执行时间"));

  if (!modeText) return invalidResult("missing-mode", name);
  const runMode = parseRunMode(modeText);
  if (!runMode) return invalidResult("invalid-mode", name);
  if (!timeText) return invalidResult("missing-time", name, runMode);

  if (runMode === "one-shot") {
    const schedule = parseLocalDateTime(timeText);
    if (!schedule) return invalidResult("invalid-time", name, runMode);
    if (new Date(schedule).getTime() <= now.getTime()) {
      return invalidResult("past-time", name, runMode);
    }
    return { issue: null, name, runMode, schedule, dailyTimes: [] };
  }

  const recurring = parseRecurringSchedule(timeText);
  if (!recurring) return invalidResult("invalid-time", name, runMode);
  return { issue: null, name, runMode, ...recurring };
}

function invalidResult(
  issue: ScenarioFullPromptIssue,
  name: string,
  runMode: "recurring" | "one-shot" = "recurring",
): ParsedScenarioFullPrompt {
  return { issue, name, runMode, schedule: "", dailyTimes: [] };
}

function readPromptDirective(prompt: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^【${escapedLabel}】\\s*(.+)$`, "m").exec(prompt)?.[1]?.trim() ?? "";
}

function stripPromptHint(value: string): string {
  return value.replace(/\s*（[^）]*）\s*$/, "").trim();
}

function splitEditablePromptValue(value: string): { value: string; hint: string } {
  const normalized = value.replace(/^\s+/, "");
  const hintIndex = normalized.indexOf("（");
  if (hintIndex < 0) return { value: normalized, hint: "" };
  return {
    value: normalized.slice(0, hintIndex).trimEnd(),
    hint: normalized.slice(hintIndex),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseRunMode(value: string): "recurring" | "one-shot" | null {
  if (/(?:一次性|单次)/.test(value)) return "one-shot";
  if (/(?:长期|周期|重复|持续)/.test(value)) return "recurring";
  return null;
}

function parseRecurringSchedule(value: string): Pick<ParsedScenarioFullPrompt, "schedule" | "dailyTimes"> | null {
  const normalized = value
    .replace(/[：]/g, ":")
    .replace(/[，,]/g, "、")
    .replace(/\s+/g, " ")
    .trim();

  const windowMatch = /^每天\s*(\d{1,2}:\d{2})\s*(?:到|至|-)\s*(\d{1,2}:\d{2})\s*、?\s*每\s*(\d+)\s*小时/.exec(normalized);
  if (windowMatch) {
    const [, start = "", end = "", intervalRaw = ""] = windowMatch;
    const dailyTimes = expandTimeWindow(start, end, Number(intervalRaw));
    return dailyTimes.length > 0 ? { schedule: "* * * * *", dailyTimes } : null;
  }

  const workdayMatch = /^工作日\s*(\d{1,2}:\d{2})$/.exec(normalized);
  if (workdayMatch) return buildCronAtTime(workdayMatch[1] ?? "", "*", "1-5");

  const weeklyMatch = /^每周([一二三四五六日天])\s*(\d{1,2}:\d{2})$/.exec(normalized);
  if (weeklyMatch) {
    const weekday = WEEKDAY_NUMBER_BY_LABEL[weeklyMatch[1] ?? ""];
    return weekday === undefined ? null : buildCronAtTime(weeklyMatch[2] ?? "", "*", String(weekday));
  }

  const monthlyMatch = /^每月\s*(\d{1,2})\s*日\s*(\d{1,2}:\d{2})$/.exec(normalized);
  if (monthlyMatch) {
    const day = Number(monthlyMatch[1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return buildCronAtTime(monthlyMatch[2] ?? "", String(day), "*");
  }

  const minuteIntervalMatch = /^每\s*(\d+)\s*分钟$/.exec(normalized);
  if (minuteIntervalMatch) {
    const minutes = Number(minuteIntervalMatch[1]);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) return null;
    return { schedule: `*/${minutes} * * * *`, dailyTimes: [] };
  }

  const hourIntervalMatch = /^每\s*(\d+)\s*小时$/.exec(normalized);
  if (hourIntervalMatch) {
    const hours = Number(hourIntervalMatch[1]);
    if (!Number.isInteger(hours) || hours < 1 || hours > 23) return null;
    return { schedule: `0 */${hours} * * *`, dailyTimes: [] };
  }

  const dailyMatch = /^每天\s*(.+)$/.exec(normalized);
  if (dailyMatch) {
    const times = Array.from(dailyMatch[1]?.matchAll(/(?:^|、)\s*(\d{1,2}:\d{2})/g) ?? [])
      .map((match) => normalizeTime(match[1] ?? ""))
      .filter((time): time is string => Boolean(time));
    const dailyTimes = Array.from(new Set(times)).sort();
    if (dailyTimes.length === 0) return null;
    if (dailyTimes.length > 1) return { schedule: "* * * * *", dailyTimes };
    return buildCronAtTime(dailyTimes[0] ?? "", "*", "*");
  }

  if (/^(?:\S+\s+){4}\S+$/.test(normalized)) {
    return { schedule: normalized, dailyTimes: [] };
  }
  return null;
}

function buildCronAtTime(
  value: string,
  dayOfMonth: string,
  dayOfWeek: string,
): Pick<ParsedScenarioFullPrompt, "schedule" | "dailyTimes"> | null {
  const time = normalizeTime(value);
  if (!time) return null;
  const [hour = "", minute = ""] = time.split(":");
  return { schedule: `${Number(minute)} ${Number(hour)} ${dayOfMonth} * ${dayOfWeek}`, dailyTimes: [] };
}

function expandTimeWindow(startValue: string, endValue: string, intervalHours: number): string[] {
  const start = parseTimeMinutes(startValue);
  const end = parseTimeMinutes(endValue);
  if (start === null || end === null || end < start || !Number.isInteger(intervalHours) || intervalHours < 1) return [];
  const times: string[] = [];
  for (let current = start; current <= end && times.length < 24; current += intervalHours * 60) {
    times.push(formatTimeMinutes(current));
  }
  return times;
}

function normalizeTime(value: string): string | null {
  const minutes = parseTimeMinutes(value);
  return minutes === null ? null : formatTimeMinutes(minutes);
}

function parseTimeMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatTimeMinutes(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseLocalDateTime(value: string): string | null {
  const normalized = value.replace(/\//g, "-").replace("T", " ").replace(/[：]/g, ":");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!match) return null;
  const [, yearRaw = "", monthRaw = "", dayRaw = "", hourRaw = "", minuteRaw = "", secondRaw = "0"] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    year < 2000
    || month < 1
    || month > 12
    || day < 1
    || day > 31
    || hour < 0
    || hour > 23
    || minute < 0
    || minute > 59
    || second < 0
    || second > 59
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
    || parsed.getSeconds() !== second
  ) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
