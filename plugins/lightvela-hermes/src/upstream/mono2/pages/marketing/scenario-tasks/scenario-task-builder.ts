// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { CronRunRecord } from "../../../lib/hermes-cron-client";
import { formatScenarioChannelLabel } from "../scenario-task-cron";
import {
  isScenarioTaskFieldVisible,
  resolveScenarioTaskRunMode,
  type ScenarioTaskField,
  type ScenarioTaskId,
  type ScenarioTaskPack,
} from "./scenario-packs";
import {
  isScenarioFullPrompt,
  parseScenarioFullPrompt,
  type ScenarioFullPromptIssue,
} from "./scenario-full-prompt";

export interface ScenarioTaskDraft {
  scenarioId: ScenarioTaskId;
  values: Record<string, string>;
  userPrompt: string;
  generatedName: string;
  generatedPrompt: string;
  generatedDeliver: string;
  generatedDeliverLabel: string;
  runMode: "recurring" | "one-shot";
  oneShotSchedule: string;
  recurringSchedule: string;
  recurringDailyTimes: string[];
  effectiveStartAt: string | null;
  effectiveEndAt: string | null;
  oneShotJobName: string;
  skillIds: string[];
  promptScheduleIssue: ScenarioFullPromptIssue | null;
}

export type ScenarioDeliveryTarget = string;

export type ScenarioTaskValidationCode =
  | "required"
  | "invalid-one-shot-time"
  | "past-one-shot-time"
  | "invalid-date-range"
  | "invalid-time-range"
  | "past-effective-end"
  | "invalid-threshold"
  | "same-currency";

export interface ScenarioTaskValidationIssue {
  code: ScenarioTaskValidationCode;
  fieldKey: string;
}

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
  userPrompt = pack.quickPrompt,
  selectedSkill,
}: {
  pack: ScenarioTaskPack;
  values: Record<string, string>;
  now?: Date;
  deliver?: string;
  userPrompt?: string;
  selectedSkill?: string;
}): ScenarioTaskDraft {
  const normalizedValues = normalizeScenarioValues(pack, values);
  const normalizedUserPrompt = userPrompt.trim() || pack.quickPrompt;
  const usesFullPrompt = isScenarioFullPrompt(normalizedUserPrompt);
  const parsedPrompt = usesFullPrompt ? parseScenarioFullPrompt(normalizedUserPrompt, now) : null;
  const runMode = parsedPrompt?.runMode ?? resolveScenarioTaskRunMode(pack, normalizedValues);
  const oneShotSchedule = usesFullPrompt
    ? runMode === "one-shot" ? parsedPrompt?.schedule ?? "" : ""
    : buildScenarioOneShotSchedule(pack, normalizedValues, now, runMode);
  const recurringDailyTimes = usesFullPrompt
    ? runMode === "recurring" ? parsedPrompt?.dailyTimes ?? [] : []
    : runMode === "recurring" ? getScenarioDailyTimes(pack, normalizedValues) : [];
  const effectiveEndDate = runMode === "recurring" && pack.effectiveEndDateFieldKey
    ? getVisibleFieldValue(pack, normalizedValues, pack.effectiveEndDateFieldKey)
    : "";
  const effectiveEndAt = effectiveEndDate ? `${effectiveEndDate}T23:59:59` : null;
  const generatedName = parsedPrompt?.name || buildScenarioJobName(pack, normalizedValues);
  const skillIds = selectedSkill === undefined
    ? pack.skillIds ?? []
    : selectedSkill.trim() ? [selectedSkill.trim()] : [];
  return {
    scenarioId: pack.id,
    values: normalizedValues,
    userPrompt: normalizedUserPrompt,
    generatedName,
    generatedPrompt: usesFullPrompt
      ? normalizedUserPrompt
      : buildUserFacingScenarioPrompt(pack, normalizedValues, normalizedUserPrompt),
    generatedDeliver: normalizeScenarioDeliverTarget(deliver),
    generatedDeliverLabel: formatScenarioDeliverLabel(deliver),
    runMode,
    oneShotSchedule,
    recurringSchedule: usesFullPrompt
      ? runMode === "recurring" ? parsedPrompt?.schedule ?? "" : ""
      : buildScenarioRecurringSchedule(pack, recurringDailyTimes),
    recurringDailyTimes,
    effectiveStartAt: null,
    effectiveEndAt,
    oneShotJobName: `${generatedName} · ${
      pack.quickPromptLocale === "en-US"
        ? "one-time run"
        : pack.quickPromptLocale === "id-ID"
          ? "sekali jalan"
          : pack.quickPromptLocale === "es"
            ? "ejecución única"
            : pack.quickPromptLocale === "ja-JP"
              ? "1回のみ実行"
          : "单次执行"
    }`,
    skillIds,
    promptScheduleIssue: parsedPrompt?.issue ?? null,
  };
}

export function buildScenarioTaskConfigSummary(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  maxItems = 3,
): string {
  const normalizedValues = normalizeScenarioValues(pack, values);
  return pack.fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, normalizedValues)) return "";
      if (isLowSignalScenarioField(field.key)) return "";
      const value = formatScenarioFieldDisplayValue(field, normalizedValues[field.key] || field.defaultValue);
      if (!value) return "";
      return `${field.label}：${value}`;
    })
    .filter(Boolean)
    .slice(0, maxItems)
    .join("；");
}

function buildScenarioJobName(pack: ScenarioTaskPack, values: Record<string, string>): string {
  const rawValue = buildScenarioJobNameValue(pack, values);
  const suffix = compactText(rawValue, 16);
  return suffix ? `${pack.name} · ${suffix}` : pack.name;
}

function buildScenarioJobNameValue(pack: ScenarioTaskPack, values: Record<string, string>): string {
  if (pack.id === "country-fx-alert") {
    return `${values.fromCurrency || ""}→${values.toCurrency || ""}`;
  }
  if (pack.id === "visa-document-deadline") {
    return `${values.documentName || values.documentType || "证件"} ${values.deadlineDate || ""}`.trim();
  }
  const preferredFieldKeyByPack: Record<string, string> = {
    "medication-once": "medicine",
    "flight-departure-once": "airport",
    "rent-reminder": "rentInfo",
    "weather-warning-alert": "region",
    "global-holiday-reminder": "holidayCountries",
    "calorie-fitness-checkin": "fitnessGoal",
  };
  const preferredField = pack.fields.find((field) => field.key === preferredFieldKeyByPack[pack.id]);
  const preferredValue = values[preferredField?.key ?? ""]?.trim();
  if (preferredValue && preferredField?.type === "multi-dropdown") {
    const labelByValue = new Map((preferredField.options ?? []).map((option) => [option.value, option.label]));
    return preferredValue
      .split("|")
      .map((item) => labelByValue.get(item.trim()) ?? item.trim())
      .filter(Boolean)
      .join(" / ");
  }
  if (preferredValue) return normalizeScenarioDisplayValue(preferredValue);
  const summary = buildScenarioTaskConfigSummary(pack, values, 1);
  if (!summary) return "";
  const [, summaryValue = summary] = summary.split("：");
  return summaryValue;
}

function isLowSignalScenarioField(key: string): boolean {
  return [
    "triggerAt",
    "sourceLinks",
    "sourceText",
    "materialLinks",
    "customMaterial",
    "backgroundNotes",
  ].includes(key);
}

function normalizeScenarioDisplayValue(value: string): string {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
}

function formatScenarioFieldDisplayValue(field: ScenarioTaskField, value: string): string {
  if (field.type === "checkbox") return value === "true" ? "是" : "否";
  if (field.key === "advanceDays") return `${value} 天`;
  return normalizeScenarioDisplayValue(value);
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

function buildScenarioOneShotSchedule(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  now: Date,
  runMode: "recurring" | "one-shot" = resolveScenarioTaskRunMode(pack, values),
): string {
  if (runMode !== "one-shot" || !pack.oneShotScheduleFieldKey) {
    return buildOneShotSchedule(now);
  }
  if (pack.id === "flight-departure-once") {
    const departureSchedule = parseOneShotSchedule(values.flightDepartureAt);
    if (!departureSchedule) return buildOneShotSchedule(now);
    const leadMinutes = [
      values.estimatedTravelMinutes,
      values.airportLeadMinutes,
      values.extraBufferMinutes,
    ].reduce((total, value) => total + parseNonNegativeMinutes(value), 0);
    return formatLocalSchedule(new Date(new Date(departureSchedule).getTime() - leadMinutes * 60_000));
  }
  return parseOneShotSchedule(values[pack.oneShotScheduleFieldKey]) ?? buildOneShotSchedule(now);
}

function getScenarioDailyTimes(pack: ScenarioTaskPack, values: Record<string, string>): string[] {
  const intervalSchedule = pack.dailyIntervalSchedule;
  if (
    intervalSchedule
    && intervalSchedule.intervalModeValues.includes(values[intervalSchedule.modeFieldKey] ?? "")
  ) {
    return expandDailyIntervalTimes(
      values[intervalSchedule.startTimeFieldKey] ?? "",
      values[intervalSchedule.endTimeFieldKey] ?? "",
      values[intervalSchedule.intervalHoursFieldKey] ?? "",
    );
  }
  if (!pack.dailyTimesFieldKey) return [];
  return (values[pack.dailyTimesFieldKey] ?? "")
    .split("|")
    .map((value) => value.trim())
    .filter((value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))
    .filter((value, index, items) => items.indexOf(value) === index)
    .sort();
}

function expandDailyIntervalTimes(startValue: string, endValue: string, intervalHoursValue: string): string[] {
  const start = parseTimeOfDayMinutes(startValue);
  const end = parseTimeOfDayMinutes(endValue);
  const intervalHours = Number(/\d+/.exec(intervalHoursValue)?.[0]);
  if (start === null || end === null || end <= start || !Number.isInteger(intervalHours) || intervalHours <= 0) {
    return [];
  }

  const intervalMinutes = intervalHours * 60;
  const times: string[] = [];
  for (let current = start; current <= end && times.length < 24; current += intervalMinutes) {
    times.push(formatTimeOfDayMinutes(current));
  }
  return times;
}

function parseTimeOfDayMinutes(value: string | undefined): number | null {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value ?? "");
  if (!match) return null;
  const [hour = 0, minute = 0] = (value ?? "").split(":").map(Number);
  return hour * 60 + minute;
}

function formatTimeOfDayMinutes(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildScenarioRecurringSchedule(pack: ScenarioTaskPack, dailyTimes: string[]): string {
  if (dailyTimes.length === 0) return pack.defaultSchedule;
  if (dailyTimes.length > 1) return "* * * * *";
  const [hour = "0", minute = "0"] = (dailyTimes[0] ?? "").split(":");
  const defaultFields = pack.defaultSchedule.trim().split(/\s+/);
  const [, , dayOfMonth = "*", month = "*", dayOfWeek = "*"] = defaultFields;
  return `${Number(minute)} ${Number(hour)} ${dayOfMonth} ${month} ${dayOfWeek}`;
}

function parseNonNegativeMinutes(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function formatLocalSchedule(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

export function parseOneShotSchedule(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\//g, "-")
    .replace("T", " ")
    .replace(/[：]/g, ":");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw ?? "0");
  if (
    year < 2000 || year > 9999
    || month < 1 || month > 12
    || day < 1 || day > 31
    || hour < 0 || hour > 23
    || minute < 0 || minute > 59
    || second < 0 || second > 59
  ) {
    return null;
  }
  const parsed = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
    || parsed.getSeconds() !== second
  ) {
    return null;
  }
  const pad = (next: number) => String(next).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function getScenarioTaskValidationIssue(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  now = new Date(),
): ScenarioTaskValidationIssue | null {
  const normalizedValues = normalizeScenarioValues(pack, values);
  for (const field of pack.fields) {
    if (!isScenarioTaskFieldVisible(field, normalizedValues)) continue;
    const value = normalizedValues[field.key] ?? field.defaultValue;
    if (field.required && !value.trim()) {
      return { code: "required", fieldKey: field.key };
    }
  }

  const runMode = resolveScenarioTaskRunMode(pack, normalizedValues);
  if (runMode === "one-shot" && pack.oneShotScheduleFieldKey) {
    const rawSchedule = (values[pack.oneShotScheduleFieldKey]
      ?? pack.fields.find((field) => field.key === pack.oneShotScheduleFieldKey)?.defaultValue
      ?? "").trim();
    if (rawSchedule) {
      const schedule = parseOneShotSchedule(rawSchedule);
      if (!schedule) {
        return { code: "invalid-one-shot-time", fieldKey: pack.oneShotScheduleFieldKey };
      }
      if (new Date(schedule).getTime() <= now.getTime()) {
        return { code: "past-one-shot-time", fieldKey: pack.oneShotScheduleFieldKey };
      }
      if (pack.id === "flight-departure-once") {
        const derivedSchedule = buildScenarioOneShotSchedule(pack, normalizedValues, now, runMode);
        if (new Date(derivedSchedule).getTime() <= now.getTime()) {
          return { code: "past-one-shot-time", fieldKey: pack.oneShotScheduleFieldKey };
        }
      }
    }
  }

  const dateRange = getScenarioDateRange(pack, normalizedValues);
  if (dateRange && dateRange.end < dateRange.start) {
    return { code: "invalid-date-range", fieldKey: dateRange.endFieldKey };
  }

  if (runMode === "recurring" && pack.effectiveEndDateFieldKey) {
    const effectiveEndAt = getVisibleFieldValue(pack, normalizedValues, pack.effectiveEndDateFieldKey);
    if (effectiveEndAt && new Date(`${effectiveEndAt}T23:59:59`).getTime() < now.getTime()) {
      return { code: "past-effective-end", fieldKey: pack.effectiveEndDateFieldKey };
    }
  }

  const intervalSchedule = pack.dailyIntervalSchedule;
  if (
    runMode === "recurring"
    && intervalSchedule
    && intervalSchedule.intervalModeValues.includes(normalizedValues[intervalSchedule.modeFieldKey] ?? "")
  ) {
    const start = parseTimeOfDayMinutes(normalizedValues[intervalSchedule.startTimeFieldKey]);
    const end = parseTimeOfDayMinutes(normalizedValues[intervalSchedule.endTimeFieldKey]);
    if (start === null || end === null || end <= start) {
      return { code: "invalid-time-range", fieldKey: intervalSchedule.endTimeFieldKey };
    }
  }

  if (pack.id === "country-fx-alert") {
    const fromCurrency = (values.fromCurrency ?? getFieldDefault(pack, "fromCurrency")).trim();
    const toCurrency = (values.toCurrency ?? getFieldDefault(pack, "toCurrency")).trim();
    if (normalizeCurrencyIdentity(fromCurrency) === normalizeCurrencyIdentity(toCurrency)) {
      return { code: "same-currency", fieldKey: "toCurrency" };
    }
    const thresholdValue = Number(values.thresholdValue ?? getFieldDefault(pack, "thresholdValue"));
    if (!Number.isFinite(thresholdValue) || thresholdValue <= 0) {
      return { code: "invalid-threshold", fieldKey: "thresholdValue" };
    }
  }

  return null;
}

function getVisibleFieldValue(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  fieldKey: string,
): string {
  const field = pack.fields.find((item) => item.key === fieldKey);
  if (!field || !isScenarioTaskFieldVisible(field, values)) return "";
  return values[fieldKey]?.trim() ?? "";
}

function getScenarioDateRange(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): { start: string; end: string; endFieldKey: string } | null {
  if (pack.id !== "global-holiday-reminder" || values.periodMode !== "指定日期范围") return null;
  const start = values.periodStart?.trim();
  const end = values.periodEnd?.trim();
  return start && end ? { start, end, endFieldKey: "periodEnd" } : null;
}

function getFieldDefault(pack: ScenarioTaskPack, fieldKey: string): string {
  return pack.fields.find((field) => field.key === fieldKey)?.defaultValue ?? "";
}

function normalizeCurrencyIdentity(value: string): string {
  const isoCode = value.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  return isoCode ?? value.toLocaleLowerCase().replace(/[\s/_-]+/g, "");
}

function buildUserFacingScenarioPrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  userPrompt: string,
): string {
  if (pack.quickPromptLocale === "en-US") {
    return buildEnglishUserFacingScenarioPrompt(pack, values, userPrompt);
  }
  if (pack.quickPromptLocale === "id-ID") {
    return buildIndonesianUserFacingScenarioPrompt(pack, values, userPrompt);
  }
  if (pack.quickPromptLocale === "es") {
    return buildSpanishUserFacingScenarioPrompt(pack, values, userPrompt);
  }
  if (pack.quickPromptLocale === "ja-JP") {
    return buildJapaneseUserFacingScenarioPrompt(pack, values, userPrompt);
  }
  const scenarioPrompt = pack.promptBuilder(values);
  return [
    "你正在执行一个 LightVela 场景任务。请把输出写成可以直接发送给用户的最终消息。",
    [
      `任务名称：${pack.name}`,
      "输出要求：",
      "1. 开头用一句话说明本次任务结论或提醒重点。",
      "2. 最多 6 行，只保留结论、必要信息和下一步；优先使用短小项目符号。",
      "3. 不要输出 job_id、Cronjob、HTTP 状态码、堆栈、调试日志或内部执行过程。",
      "4. 如果外部信息不足，请明确说明你缺少什么，并给出下一步建议。",
      "5. 如果模型、工具或上游服务暂不可用，请用用户能理解的话说明：本次任务没有完成，建议稍后重试或检查模型设置。",
      "6. 把任务当成自动化工作流执行：先判断触发条件和当前状态，再输出结果、风险、下一步动作；不要在正文里要求 Agent 另行发送消息，cron deliver 会自动投递最终响应。",
      "7. 定时任务要优先准点触发，不主动添加随机抖动；解释时间异常前必须先用 cron list 核对 lastRunAtMs / nextRunAtMs / createdAtMs，读取配置不等于触发推送。",
    ].join("\n"),
    "场景任务要求如下：",
    `用户任务要求：${userPrompt}`,
    scenarioPrompt,
  ].join("\n\n");
}

function buildEnglishUserFacingScenarioPrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  userPrompt: string,
): string {
  const valueLines = buildEnglishScenarioValueLines(pack, values);
  return [
    "You are running a LightVela automation. Write the final result as a message that can be sent directly to the user.",
    [
      `Task name: ${pack.name}`,
      "Output requirements:",
      "1. Start with one clear sentence summarizing the result or reminder.",
      "2. Keep the user-visible message short: at most 6 lines with only the conclusion, key facts, and next step.",
      "3. Do not show job_id, Cronjob, HTTP status codes, stack traces, debug logs, or internal execution steps.",
      "4. If external information is missing, say briefly what could not be confirmed and what the user should check next.",
      "5. If the model, tool, or upstream service is unavailable, explain in plain language that this run did not complete and suggest retrying later or checking model settings.",
      "6. Treat this as an automation workflow: check the trigger condition and current state first, then output the result, risk, and next action. Do not ask another agent to send the message; cron delivery handles final delivery.",
      "7. Time-sensitive tasks should trigger predictably. Do not add random staggering. If trigger timing looks wrong, check cron list timestamps such as lastRunAtMs, nextRunAtMs, and createdAtMs before explaining it.",
    ].join("\n"),
    "Scenario request:",
    `User request: ${userPrompt}`,
    valueLines.length ? ["User-provided details:", ...valueLines].join("\n") : null,
    pack.needsRealtime
      ? [
          "Realtime lookup rules:",
          "Use bounded web_search, web_fetch, and datetime checks when current data is required.",
          "Use at most 3 focused search queries and at most 4 source pages unless the user explicitly asks for more.",
          "Keep source names or links when they matter for reliability.",
        ].join("\n")
      : null,
    pack.safetyNote ? `Safety note: ${pack.safetyNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildIndonesianUserFacingScenarioPrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  userPrompt: string,
): string {
  const valueLines = buildIndonesianScenarioValueLines(pack, values);
  return [
    "Anda sedang menjalankan otomatisasi LightVela. Tulis hasil akhir sebagai pesan yang bisa langsung dikirim ke pengguna.",
    [
      `Nama tugas: ${pack.name}`,
      "Ketentuan output:",
      "1. Mulai dengan satu kalimat jelas yang merangkum hasil atau pengingat utama.",
      "2. Buat pesan singkat: maksimal 6 baris, hanya berisi kesimpulan, fakta penting, dan langkah berikutnya.",
      "3. Jangan tampilkan job_id, Cronjob, kode status HTTP, stack trace, log debug, atau langkah internal.",
      "4. Jika informasi eksternal belum lengkap, sebutkan singkat apa yang belum bisa dikonfirmasi dan apa yang perlu dicek pengguna.",
      "5. Jika model, alat, atau layanan upstream tidak tersedia, jelaskan dengan bahasa sederhana bahwa tugas kali ini belum selesai dan sarankan mencoba lagi nanti atau memeriksa pengaturan model.",
      "6. Perlakukan ini sebagai workflow otomatisasi: cek kondisi pemicu dan status saat ini lebih dulu, lalu keluarkan hasil, risiko, dan tindakan berikutnya. Jangan meminta Agent lain mengirim pesan; cron deliver akan mengirim respons akhir.",
      "7. Untuk tugas berbasis waktu, pemicu harus berjalan prediktif. Jangan menambahkan jeda acak. Jika waktu pemicu terlihat salah, cek timestamp cron list seperti lastRunAtMs, nextRunAtMs, dan createdAtMs sebelum menjelaskannya.",
    ].join("\n"),
    "Permintaan skenario:",
    `Permintaan pengguna: ${userPrompt}`,
    valueLines.length ? ["Detail dari pengguna:", ...valueLines].join("\n") : null,
    pack.needsRealtime
      ? [
          "Aturan lookup realtime:",
          "Gunakan web_search, web_fetch, dan pemeriksaan waktu secara terbatas saat data terbaru dibutuhkan.",
          "Gunakan maksimal 3 query pencarian terfokus dan maksimal 4 halaman sumber kecuali pengguna meminta lebih.",
          "Cantumkan nama sumber atau tautan saat penting untuk keandalan.",
        ].join("\n")
      : null,
    pack.safetyNote ? `Catatan keamanan: ${pack.safetyNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildSpanishUserFacingScenarioPrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  userPrompt: string,
): string {
  const valueLines = buildSpanishScenarioValueLines(pack, values);
  return [
    "Estás ejecutando una automatización de LightVela. Escribe el resultado final como un mensaje listo para enviar directamente al usuario.",
    [
      `Nombre de la tarea: ${pack.name}`,
      "Requisitos de salida:",
      "1. Empieza con una frase clara que resuma el resultado o el recordatorio principal.",
      "2. Mantén el mensaje visible breve: como máximo 6 líneas con la conclusión, los datos esenciales y el siguiente paso.",
      "3. No muestres job_id, Cronjob, códigos de estado HTTP, trazas, registros de depuración ni pasos internos.",
      "4. Si falta información externa, indica brevemente qué no se pudo confirmar y qué debe revisar el usuario.",
      "5. Si el modelo, una herramienta o un servicio previo no está disponible, explica con claridad que la ejecución no se completó y sugiere intentarlo más tarde o revisar la configuración del modelo.",
      "6. Trátalo como un flujo de automatización: comprueba primero la condición de activación y el estado actual; después comunica el resultado, el riesgo y la siguiente acción. No pidas a otro Agent que envíe el mensaje; cron deliver gestiona la entrega final.",
      "7. Las tareas programadas deben activarse de forma predecible. No añadas retrasos aleatorios. Si el horario parece incorrecto, revisa en cron list lastRunAtMs, nextRunAtMs y createdAtMs antes de explicarlo.",
    ].join("\n"),
    "Solicitud del escenario:",
    `Solicitud del usuario: ${userPrompt}`,
    valueLines.length ? ["Detalles proporcionados por el usuario:", ...valueLines].join("\n") : null,
    pack.needsRealtime
      ? [
          "Reglas de consulta en tiempo real:",
          "Usa web_search, web_fetch y comprobaciones de fecha y hora de forma acotada cuando se necesiten datos actuales.",
          "Utiliza como máximo 3 búsquedas concretas y 4 páginas de fuentes, salvo que el usuario pida expresamente más.",
          "Conserva los nombres o enlaces de las fuentes cuando sean importantes para la fiabilidad.",
        ].join("\n")
      : null,
    pack.safetyNote ? `Nota de seguridad: ${pack.safetyNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildJapaneseUserFacingScenarioPrompt(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
  userPrompt: string,
): string {
  const valueLines = buildJapaneseScenarioValueLines(pack, values);
  return [
    "LightVelaの自動化を実行しています。ユーザーへそのまま送れる最終メッセージとして結果を書いてください。",
    [
      `タスク名：${pack.name}`,
      "出力要件：",
      "1. 結果またはリマインダーの要点を、最初の1文で明確に伝えてください。",
      "2. ユーザー向けの文章は最大6行とし、結論、重要な事実、次の行動だけを残してください。",
      "3. job_id、Cronjob、HTTPステータス、スタックトレース、デバッグログ、内部処理は表示しないでください。",
      "4. 外部情報が不足している場合は、確認できなかった内容と次に確認すべき点を短く示してください。",
      "5. モデル、ツール、上流サービスが利用できない場合は、今回の実行が完了しなかったことを平易に説明し、後で再試行するかモデル設定を確認するよう案内してください。",
      "6. 自動化ワークフローとして、最初に実行条件と現在の状態を確認し、その後に結果、リスク、次の行動を出力してください。別のAgentに送信を依頼せず、最終配信はcron deliverに任せます。",
      "7. 時刻に依存するタスクは予測可能な時刻に実行し、ランダムな遅延を加えないでください。時刻が不自然な場合は、説明前にcron listのlastRunAtMs、nextRunAtMs、createdAtMsを確認してください。",
    ].join("\n"),
    "シナリオの依頼：",
    `ユーザーの依頼：${userPrompt}`,
    valueLines.length ? ["ユーザーが指定した内容：", ...valueLines].join("\n") : null,
    pack.needsRealtime
      ? [
          "リアルタイム確認のルール：",
          "最新情報が必要な場合は、web_search、web_fetch、日時確認を必要な範囲だけ使用してください。",
          "ユーザーが明示的に求めない限り、検索は最大3件、参照ページは最大4件にしてください。",
          "信頼性に関わる場合は、情報源の名前またはリンクを残してください。",
        ].join("\n")
      : null,
    pack.safetyNote ? `安全上の注意：${pack.safetyNote}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const ENGLISH_SCENARIO_FIELD_LABELS: Record<string, string> = {
  actionMode: "mode",
  advanceDays: "advance reminder",
  alertLevel: "alert level",
  checkinTime: "check-in time",
  courseEndDate: "course end date",
  customRequest: "notes",
  dueDate: "due date",
  fitnessGoal: "goal",
  foodLog: "log content",
  fromCurrency: "from currency",
  holidayCountries: "countries or regions",
  holidayScope: "holiday scope",
  holidayWeatherPlan: "weather and alert tracking",
  includeDueDay: "due-day reminder",
  medicine: "medication instructions",
  recurringTimes: "reminder times",
  reminderMode: "reminder mode",
  reminderTime: "reminder time",
  reminderWindow: "reminder window",
  rentInfo: "billing details",
  reportStyle: "feedback style",
  stockFocus: "focus",
  stockList: "stocks",
  thresholdMode: "trigger condition",
  thresholdValue: "threshold",
  toCurrency: "to currency",
  triggerAt: "trigger time",
};

const INDONESIAN_SCENARIO_FIELD_LABELS: Record<string, string> = {
  actionMode: "mode",
  advanceDays: "pengingat lebih awal",
  alertLevel: "level peringatan",
  checkinTime: "waktu check-in",
  courseEndDate: "tanggal akhir",
  customRequest: "catatan",
  dueDate: "tanggal jatuh tempo",
  fitnessGoal: "target",
  foodLog: "isi catatan",
  fromCurrency: "mata uang asal",
  holidayCountries: "negara atau wilayah",
  holidayScope: "cakupan hari libur",
  holidayWeatherPlan: "pemantauan cuaca dan peringatan",
  includeDueDay: "pengingat hari jatuh tempo",
  medicine: "instruksi obat",
  recurringTimes: "waktu pengingat",
  reminderMode: "mode pengingat",
  reminderTime: "waktu pengingat",
  reminderWindow: "jendela pengingat",
  rentInfo: "detail tagihan",
  reportStyle: "gaya masukan",
  stockFocus: "fokus",
  stockList: "saham",
  thresholdMode: "kondisi pemicu",
  thresholdValue: "ambang",
  toCurrency: "mata uang tujuan",
  triggerAt: "waktu pemicu",
};

const SPANISH_SCENARIO_FIELD_LABELS: Record<string, string> = {
  actionMode: "modo",
  advanceDays: "aviso anticipado",
  alertLevel: "nivel de alerta",
  checkinTime: "hora del registro",
  courseEndDate: "fecha de finalización",
  customRequest: "notas",
  dueDate: "fecha de vencimiento",
  fitnessGoal: "objetivo",
  foodLog: "contenido del registro",
  fromCurrency: "moneda de origen",
  holidayCountries: "países o regiones",
  holidayScope: "cobertura de festivos",
  holidayWeatherPlan: "seguimiento del tiempo y las alertas",
  includeDueDay: "aviso el día del vencimiento",
  medicine: "indicaciones de la medicación",
  recurringTimes: "horas de aviso",
  reminderMode: "modo de recordatorio",
  reminderTime: "hora del recordatorio",
  reminderWindow: "ventana del recordatorio",
  rentInfo: "detalles de facturación",
  reportStyle: "estilo de respuesta",
  stockFocus: "enfoque",
  stockList: "acciones",
  thresholdMode: "condición de activación",
  thresholdValue: "umbral",
  toCurrency: "moneda de destino",
  triggerAt: "hora de activación",
};

const JAPANESE_SCENARIO_FIELD_LABELS: Record<string, string> = {
  actionMode: "実行方法",
  advanceDays: "事前通知",
  alertLevel: "警戒レベル",
  checkinTime: "記録時刻",
  courseEndDate: "終了日",
  customRequest: "補足",
  dueDate: "支払日",
  fitnessGoal: "目標",
  foodLog: "記録内容",
  fromCurrency: "基準通貨",
  holidayCountries: "国・地域",
  holidayScope: "祝日の範囲",
  holidayWeatherPlan: "天気・警報の確認",
  includeDueDay: "支払日当日の通知",
  medicine: "服薬内容",
  recurringTimes: "通知時刻",
  reminderMode: "リマインダー形式",
  reminderTime: "確認時刻",
  reminderWindow: "通知時期",
  rentInfo: "支払い内容",
  reportStyle: "フィードバック形式",
  stockFocus: "確認項目",
  stockList: "銘柄",
  thresholdMode: "通知条件",
  thresholdValue: "しきい値",
  toCurrency: "対象通貨",
  triggerAt: "通知日時",
};

function buildEnglishScenarioValueLines(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): string[] {
  return pack.fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, values)) return "";
      const value = getScenarioFieldValueForPrompt(field, values);
      if (!value) return "";
      const label = ENGLISH_SCENARIO_FIELD_LABELS[field.key] ?? englishizeFieldKey(field.key);
      return `${label}: ${formatEnglishScenarioFieldValue(field, value)}.`;
    })
    .filter((line): line is string => Boolean(line));
}

function buildIndonesianScenarioValueLines(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): string[] {
  return pack.fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, values)) return "";
      const value = getScenarioFieldValueForPrompt(field, values);
      if (!value) return "";
      const label = INDONESIAN_SCENARIO_FIELD_LABELS[field.key] ?? englishizeFieldKey(field.key);
      return `${label}: ${formatEnglishScenarioFieldValue(field, value)}.`;
    })
    .filter((line): line is string => Boolean(line));
}

function buildSpanishScenarioValueLines(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): string[] {
  return pack.fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, values)) return "";
      const value = getScenarioFieldValueForPrompt(field, values);
      if (!value) return "";
      const label = SPANISH_SCENARIO_FIELD_LABELS[field.key] ?? englishizeFieldKey(field.key);
      return `${label}: ${formatSpanishScenarioFieldValue(field, value)}.`;
    })
    .filter((line): line is string => Boolean(line));
}

function buildJapaneseScenarioValueLines(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): string[] {
  return pack.fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, values)) return "";
      const value = getScenarioFieldValueForPrompt(field, values);
      if (!value) return "";
      const label = JAPANESE_SCENARIO_FIELD_LABELS[field.key] ?? englishizeFieldKey(field.key);
      return `${label}：${formatJapaneseScenarioFieldValue(field, value)}。`;
    })
    .filter((line): line is string => Boolean(line));
}

function getScenarioFieldValueForPrompt(
  field: ScenarioTaskField,
  values: Record<string, string>,
): string {
  const configured = values[field.key]?.trim();
  if (field.type === "checkbox") return (configured || field.defaultValue) === "true" ? "yes" : "no";
  return configured || field.defaultValue || "";
}

function formatEnglishScenarioFieldValue(field: ScenarioTaskField, value: string): string {
  const labelByValue = new Map((field.options ?? []).map((option) => [option.value, option.label]));
  return value
    .split("|")
    .map((part) => labelByValue.get(part.trim()) ?? part.trim())
    .filter(Boolean)
    .join(", ");
}

function formatSpanishScenarioFieldValue(field: ScenarioTaskField, value: string): string {
  if (field.type === "checkbox") return value === "yes" ? "sí" : "no";
  return formatEnglishScenarioFieldValue(field, value);
}

function formatJapaneseScenarioFieldValue(field: ScenarioTaskField, value: string): string {
  if (field.type === "checkbox") return value === "yes" ? "はい" : "いいえ";
  return formatEnglishScenarioFieldValue(field, value);
}

function englishizeFieldKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

export function normalizeScenarioDeliverTarget(deliver: string): ScenarioDeliveryTarget {
  const targets = deliver
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target && target !== "local" && isSafeScenarioDeliverTarget(target));
  const uniqueTargets = [...new Set(targets)];
  return uniqueTargets.length ? uniqueTargets.join(",") : "local";
}

export function formatScenarioDeliverLabel(deliver: string): string {
  const normalized = normalizeScenarioDeliverTarget(deliver);
  if (normalized === "local") return "网页 / 最近执行";
  return normalized
    .split(",")
    .map((target) => formatScenarioChannelLabel(target))
    .join("、");
}

function isSafeScenarioDeliverTarget(target: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9._:@/+~-]+)?$/i.test(target);
}

export function normalizeScenarioValues(
  pack: ScenarioTaskPack,
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    pack.fields.map((field) => {
      const raw = values[field.key];
      return [field.key, raw === undefined ? field.defaultValue : raw.trim()];
    }),
  );
}

export function formatScenarioTaskDraftFrequency(
  pack: ScenarioTaskPack,
  draft: Pick<ScenarioTaskDraft, "runMode" | "oneShotSchedule" | "recurringDailyTimes" | "effectiveEndAt" | "values">,
): string {
  if (draft.runMode === "one-shot") return draft.oneShotSchedule;
  const intervalSchedule = pack.dailyIntervalSchedule;
  const isIntervalSchedule = intervalSchedule
    && intervalSchedule.intervalModeValues.includes(draft.values[intervalSchedule.modeFieldKey] ?? "");
  const intervalLabel = isIntervalSchedule
    ? draft.values[intervalSchedule.intervalHoursFieldKey]
    : "";
  const recurringDayLabel = /\s1-5$/.test(pack.defaultSchedule.trim()) ? "工作日" : "每天";
  const base = isIntervalSchedule
    ? `每天 ${draft.values[intervalSchedule.startTimeFieldKey]}-${draft.values[intervalSchedule.endTimeFieldKey]}，${intervalLabel}`
    : draft.recurringDailyTimes.length > 0
    ? `${recurringDayLabel} ${draft.recurringDailyTimes.join("、")}`
    : pack.defaultFrequencyLabel;
  return draft.effectiveEndAt ? `${base}，至 ${draft.effectiveEndAt.slice(0, 10)}` : base;
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

  return candidates.find((run) => isScenarioPreviewJobName(draft, run.job_name))
    ?? candidates.find((run) => run.job_prompt === draft.generatedPrompt)
    ?? candidates.find((run) => run.job_name.includes(draft.generatedName))
    ?? null;
}

export function isScenarioPreviewJobName(
  draft: Pick<ScenarioTaskDraft, "generatedName" | "oneShotJobName">,
  jobName: string,
): boolean {
  return jobName === draft.oneShotJobName
    || jobName === `${draft.generatedName} · 试跑`
    || jobName === `试跑 - ${draft.generatedName}`;
}

export function isScenarioRecurringJobName(
  draft: Pick<ScenarioTaskDraft, "generatedName">,
  jobName: string,
): boolean {
  return jobName === draft.generatedName || jobName.startsWith(`${draft.generatedName} ·`);
}
