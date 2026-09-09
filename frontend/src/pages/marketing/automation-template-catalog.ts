import type { HermesAutomationBlueprint } from "@/lib/hermes-cron-client";

export type AutomationTemplateCategory =
  | "daily"
  | "productivity"
  | "monitoring"
  | "wellbeing"
  | "learning";

export type AutomationTemplatePreviewKind =
  | "briefing"
  | "mail"
  | "reminder"
  | "review"
  | "monitor"
  | "learning"
  | "wellbeing";

export interface AutomationTemplateSchedule {
  kind: "recurring" | "interval" | "once";
  period?: "daily" | "weekly" | "monthly";
  time?: string;
  times?: string[];
  weekday?: number;
  weekdays?: number[];
  monthday?: number;
  monthdays?: number[];
  intervalNum?: number;
  intervalUnit?: "m" | "h" | "d";
}

export interface AutomationCatalogTemplate {
  id: string;
  source: "lightvela" | "hermes";
  name: string;
  description: string;
  category: AutomationTemplateCategory;
  tags: string[];
  prompt: string;
  executionRules?: string;
  schedule: AutomationTemplateSchedule;
  scheduleLabel: string;
  deliver?: string;
  skills: string[];
  notificationPolicy: "always" | "only-when-needed";
  previewKind: AutomationTemplatePreviewKind;
}

export interface AutomationTemplateInput {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: AutomationTemplateSchedule;
  skills?: string[];
}

export const HERMES_BLUEPRINT_OVERLAPS = new Set([
  "hydration-move",
  "weekly-review",
  "workday-start",
  "news-digest",
  "bill-renewal-watch",
  "habit-checkin",
]);

function baselineBlueprint(
  key: string,
  title: string,
  description: string,
  category: string,
  scheduleHuman: string,
  schedule: string,
  prompt: string,
  skills: string[] = [],
): HermesAutomationBlueprint {
  return {
    key,
    title,
    description,
    category,
    tags: [],
    fields: [],
    scheduleHuman,
    spec: { name: title, prompt, schedule, deliver: "origin", skills },
  };
}

/**
 * Hermes 官方 Blueprint Catalog 的可用基线。
 *
 * 旧版 Agent、本地预览或瞬时网络失败时仍展示完整模板；一旦运行时返回同名
 * blueprint，下面的基线会被真实 spec 覆盖，避免前端目录与 Agent 能力脱节。
 */
export const HERMES_AUTOMATION_BLUEPRINT_BASELINE: readonly HermesAutomationBlueprint[] = [
  baselineBlueprint(
    "morning-brief",
    "Morning briefing",
    "Start the day with weather, calendar, priorities, and one practical suggestion.",
    "daily",
    "daily at 08:00",
    "0 8 * * *",
    "Create today's morning briefing with Shanghai weather, three important events, two priorities, and one action.",
    ["google-workspace"],
  ),
  baselineBlueprint(
    "important-mail",
    "Important email monitor",
    "Check the inbox and alert only when a message genuinely needs attention.",
    "monitoring",
    "every 30 minutes",
    "*/30 * * * *",
    "Check new email and alert me only when something needs a reply, decision, or action today.",
    ["email-inbox-triage"],
  ),
  baselineBlueprint(
    "custom-reminder",
    "Custom reminder",
    "Turn a short instruction into a useful recurring reminder.",
    "productivity",
    "daily at 14:00",
    "0 14 * * *",
    "Remind me to stretch for five minutes and drink a glass of water before 2 PM.",
  ),
  baselineBlueprint(
    "evening-winddown",
    "Evening wind-down",
    "Review tomorrow's schedule and prepare the few things that matter tonight.",
    "daily",
    "daily at 21:00",
    "0 21 * * *",
    "Summarize tomorrow's schedule, what I should prepare tonight, and one closing suggestion.",
    [],
  ),
  baselineBlueprint(
    "price-watch",
    "Price and availability watch",
    "Track a product, flight, or hotel and alert only when the target condition is met.",
    "monitoring",
    "every 6 hours",
    "0 */6 * * *",
    "Watch AirPods Pro and alert me when the total price falls below CNY 1,500 or stock returns.",
    ["product-price-monitor"],
  ),
  baselineBlueprint(
    "competitor-watch",
    "Competitor watch",
    "Track meaningful product, pricing, funding, and business changes.",
    "monitoring",
    "weekdays at 10:00",
    "0 10 * * 1-5",
    "Watch Alibaba Cloud, Huawei Cloud, and DigitalOcean for important product, pricing, and business changes.",
    ["competitor-news-monitor"],
  ),
  baselineBlueprint(
    "meal-plan",
    "Weekly meal plan",
    "Plan simple meals around preferences and combine everything into one shopping list.",
    "wellbeing",
    "weekly on Sunday at 18:00",
    "0 18 * * 0",
    "Plan next week's dinners for two: light, low-oil, non-spicy, under 30 minutes, with one grocery list.",
  ),
  baselineBlueprint(
    "learn-daily",
    "Daily learning",
    "Build knowledge through one short lesson, a real example, and a review question.",
    "learning",
    "daily at 20:00",
    "0 20 * * *",
    "Teach me one 10-minute AI Agent lesson with a concept, real example, and review question.",
    [],
  ),
  baselineBlueprint(
    "gratitude-journal",
    "Gratitude journal",
    "Close the day with one gentle prompt for gratitude and reflection.",
    "wellbeing",
    "daily at 21:30",
    "30 21 * * *",
    "Ask me to note one thing that went well, one thing I appreciate, and one small win today.",
  ),
  baselineBlueprint(
    "on-this-day",
    "On this day",
    "Discover one memorable historical event, science fact, or word each day.",
    "learning",
    "daily at 09:00",
    "0 9 * * *",
    "Share one technology or internet event connected to today's date and briefly explain why it matters.",
    [],
  ),
];

const HERMES_ZH_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "晨间简报",
    description: "每天汇总日历、天气和需要优先处理的事项",
    prompt: "生成今日晨间简报，包含上海天气、3 个重要日程、2 项优先事项和一句行动建议。",
  },
  "important-mail": {
    name: "重要邮件监控",
    description: "定期检查收件箱，只提醒真正需要处理的邮件",
    prompt: "检查新邮件，只提醒今天需要回复、需要决策或有明确截止时间的内容。",
  },
  "custom-reminder": {
    name: "自定义提醒",
    description: "用自己的话设置一项可重复的日常提醒",
    prompt: "提醒我今天 14:00 前起身活动 5 分钟并喝一杯水。",
  },
  "evening-winddown": {
    name: "晚间收尾",
    description: "睡前回顾明日安排和今晚需要准备的事项",
    prompt: "整理明日安排、今晚需要准备的事项和一条收尾建议。",
  },
  "price-watch": {
    name: "价格与库存监控",
    description: "持续关注商品、航班或酒店，达到目标条件再提醒",
    prompt: "监控 AirPods Pro，到手价低于 1500 元或恢复库存时提醒。",
  },
  "competitor-watch": {
    name: "竞品动态监控",
    description: "跟踪竞品发布、定价、融资和重要经营变化",
    prompt: "监控阿里云、华为云和 DigitalOcean 的产品、价格及重要经营变化。",
  },
  "meal-plan": {
    name: "每周膳食计划",
    description: "按饮食偏好生成下周菜单和合并采购清单",
    prompt: "为 2 人规划下周晚餐：清淡、少油、不吃辣，每餐 30 分钟内，并生成采购清单。",
  },
  "learn-daily": {
    name: "每日学习",
    description: "每天推送一个循序渐进的短知识点",
    prompt: "每天用 10 分钟学习 AI Agent：一个知识点、一个真实例子和一道复习题。",
  },
  "gratitude-journal": {
    name: "感恩与复盘",
    description: "每天用一个温和问题记录收获和小进步",
    prompt: "提醒我记录今天一件顺利的事、一件感恩的事和一个小进步。",
  },
  "on-this-day": {
    name: "历史上的今天",
    description: "每天发现一个历史事件、科学事实或今日词汇",
    prompt: "分享一条与今天有关的科技或互联网历史事件，并简要说明意义。",
  },
};

const HERMES_ZH_HANT_COPY: Record<string, { name: string; description: string; prompt: string }> = {
  "morning-brief": {
    name: "晨間簡報",
    description: "每天彙整日曆、天氣和需要優先處理的事項",
    prompt: "產生今日晨間簡報，包含上海天氣、3 個重要行程、2 項優先事項和一句行動建議。",
  },
  "important-mail": {
    name: "重要郵件監控",
    description: "定期檢查收件匣，只提醒真正需要處理的郵件",
    prompt: "檢查新郵件，只提醒今天需要回覆、需要決策或有明確截止時間的內容。",
  },
  "custom-reminder": {
    name: "自訂提醒",
    description: "用自己的話設定一項可重複的日常提醒",
    prompt: "提醒我今天 14:00 前起身活動 5 分鐘並喝一杯水。",
  },
  "evening-winddown": {
    name: "晚間收尾",
    description: "睡前回顧明日安排和今晚需要準備的事項",
    prompt: "整理明日安排、今晚需要準備的事項和一則收尾建議。",
  },
  "price-watch": {
    name: "價格與庫存監控",
    description: "持續關注商品、航班或飯店，達到目標條件再提醒",
    prompt: "監控 AirPods Pro，到手價低於 1500 元或恢復庫存時提醒。",
  },
  "competitor-watch": {
    name: "競品動態監控",
    description: "追蹤競品發布、定價、融資和重要營運變化",
    prompt: "監控阿里雲、華為雲和 DigitalOcean 的產品、價格及重要營運變化。",
  },
  "meal-plan": {
    name: "每週膳食計劃",
    description: "按飲食偏好產生下週菜單和合併採購清單",
    prompt: "為 2 人規劃下週晚餐：清淡、少油、不吃辣，每餐 30 分鐘內，並產生採購清單。",
  },
  "learn-daily": {
    name: "每日學習",
    description: "每天推送一個循序漸進的短知識點",
    prompt: "每天用 10 分鐘學習 AI Agent：一個知識點、一個真實例子和一道複習題。",
  },
  "gratitude-journal": {
    name: "感恩與回顧",
    description: "每天用一個溫和問題記錄收穫和小進步",
    prompt: "提醒我記錄今天一件順利的事、一件感恩的事和一個小進步。",
  },
  "on-this-day": {
    name: "歷史上的今天",
    description: "每天發現一個歷史事件、科學事實或今日詞彙",
    prompt: "分享一則與今天有關的科技或網際網路歷史事件，並簡要說明意義。",
  },
};

const HERMES_EXECUTION_RULES_BY_KEY: Record<string, string> = {
  "morning-brief": "Use connected sources when available. If calendar or email is unavailable, provide the date and local weather, then explain how to connect it.",
  "important-mail": "Check only messages received since the previous run. Include sender, subject, why it matters, and the next action. If no message qualifies, return exactly [SILENT]. If email is not connected, explain how to connect it.",
  "custom-reminder": "Return one friendly, actionable reminder without extra explanation.",
  "evening-winddown": "Use the connected calendar when available. If it is unavailable, provide tomorrow's local weather and a brief sign-off.",
  "price-watch": "On the first run, confirm the exact item and verify one live source. Compare normalized price and stock with the last known good state, deduplicate alerts, and include current price, difference, stock, and a source link. Never replace good state with a failed fetch. If the condition is unmet and nothing important changed, return exactly [SILENT].",
  "competitor-watch": "Collect changes incrementally and report only material new developments. Deduplicate the underlying event and include its date, impact, and source links. If nothing material is new, return exactly [SILENT].",
  "meal-plan": "List each day's meal with a short method and estimated time. Finish with one consolidated grocery list grouped by aisle.",
  "learn-daily": "Build on earlier lessons without repeating them. Include one concrete example, a short preview of tomorrow, and one question that checks understanding.",
  "gratitude-journal": "Ask one warm question. If the user replies, acknowledge it kindly.",
  "on-this-day": "Use a reliable source and keep the answer to one or two useful sentences without filler.",
};

const QUIET_MONITOR_EXECUTION_RULES = "Treat this as a stateful monitor. Alert only when the condition is met or a meaningful new change appears, include essential evidence, and deduplicate equivalent results. If nothing needs attention, return exactly [SILENT].";
export const AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH = 1000;
const INTERNAL_RULES_OPEN_PREFIX = '<lightvela_internal_rules version="1" checksum="';
const INTERNAL_RULES_CLOSE = "</lightvela_internal_rules>";

function internalRulesChecksum(visiblePrompt: string, executionRules: string): string {
  let hash = 0x811c9dc5;
  const value = `${visiblePrompt}\u0000${executionRules}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function composeAutomationExecutionPrompt(visiblePrompt: string, executionRules?: string): string {
  const visible = visiblePrompt.trim();
  const rules = executionRules?.trim();
  const opening = rules
    ? `${INTERNAL_RULES_OPEN_PREFIX}${internalRulesChecksum(visible, rules)}">`
    : "";
  return rules
    ? `${visible}\n\n${opening}\n${rules}\n${INTERNAL_RULES_CLOSE}`
    : visible;
}

export function getAutomationVisiblePromptMaxLength(executionRules?: string): number {
  const rules = executionRules?.trim();
  if (!rules) return AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH;
  const envelopeLength = composeAutomationExecutionPrompt("", rules).length;
  return Math.max(0, AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH - envelopeLength);
}

export function splitAutomationExecutionPrompt(prompt: string): {
  visiblePrompt: string;
  executionRules?: string;
} {
  const normalizedPrompt = prompt.trimEnd();
  const opening = `\n\n${INTERNAL_RULES_OPEN_PREFIX}`;
  const openingEnd = `">\n`;
  const closing = `\n${INTERNAL_RULES_CLOSE}`;
  const openIndex = normalizedPrompt.lastIndexOf(opening);
  if (openIndex < 0 || !normalizedPrompt.endsWith(closing)) return { visiblePrompt: prompt };
  const checksumStart = openIndex + opening.length;
  const checksumEnd = normalizedPrompt.indexOf(openingEnd, checksumStart);
  if (checksumEnd < 0) return { visiblePrompt: prompt };
  const checksum = normalizedPrompt.slice(checksumStart, checksumEnd);
  const rulesStart = checksumEnd + openingEnd.length;
  const executionRules = normalizedPrompt.slice(rulesStart, -closing.length).trim();
  if (!executionRules) return { visiblePrompt: prompt };
  const visiblePrompt = normalizedPrompt.slice(0, openIndex).trim();
  if (checksum !== internalRulesChecksum(visiblePrompt, executionRules)) return { visiblePrompt: prompt };
  return {
    visiblePrompt,
    executionRules,
  };
}

const QUIET_BLUEPRINTS = new Set(["important-mail", "price-watch", "competitor-watch"]);
const FEATURED_RESULT_BLUEPRINTS = ["morning-brief", "price-watch", "learn-daily", "meal-plan"] as const;
const LEGACY_SKILL_ALIASES_BY_BLUEPRINT: Readonly<Record<string, Readonly<Record<string, string | null>>>> = {
  "morning-brief": {
    weather: null,
    calendar: "google-workspace",
    "web-search": null,
    web_search: null,
  },
  "evening-winddown": { weather: null, calendar: null, "web-search": null, web_search: null },
  "price-watch": { "web-search": null, web_search: null },
  "competitor-watch": { "web-search": null, web_search: null },
  "learn-daily": { "web-search": null, web_search: null },
  "on-this-day": { "web-search": null, web_search: null },
};

function normalizeBlueprintSkills(blueprintKey: string, skills: readonly string[]): string[] {
  const aliases = LEGACY_SKILL_ALIASES_BY_BLUEPRINT[blueprintKey];
  const normalized = skills.flatMap((slug) => {
    const trimmed = slug.trim();
    const alias = aliases?.[trimmed.toLocaleLowerCase()];
    if (alias === null) return [];
    return [alias ?? trimmed];
  });
  return [...new Set(normalized)];
}

const CATEGORY_BY_KEY: Record<string, AutomationTemplateCategory> = {
  "morning-brief": "daily",
  "important-mail": "monitoring",
  "custom-reminder": "productivity",
  "evening-winddown": "daily",
  "price-watch": "monitoring",
  "competitor-watch": "monitoring",
  "meal-plan": "wellbeing",
  "learn-daily": "learning",
  "gratitude-journal": "wellbeing",
  "on-this-day": "learning",
};

const PREVIEW_BY_KEY: Record<string, AutomationTemplatePreviewKind> = {
  "morning-brief": "briefing",
  "important-mail": "mail",
  "custom-reminder": "reminder",
  "evening-winddown": "review",
  "price-watch": "monitor",
  "competitor-watch": "monitor",
  "meal-plan": "wellbeing",
  "learn-daily": "learning",
  "gratitude-journal": "wellbeing",
  "on-this-day": "learning",
};

const LIGHTVELA_CATEGORY_BY_ID: Record<string, AutomationTemplateCategory> = {
  "daily-summary": "productivity",
  "morning-start": "daily",
  "weekly-review": "productivity",
  "task-tidy": "productivity",
  stretch: "wellbeing",
  "news-digest": "daily",
  "medication-once": "wellbeing",
  "rent-reminder": "productivity",
  "country-fx-alert": "monitoring",
  "calorie-fitness-checkin": "wellbeing",
  "global-holiday-reminder": "monitoring",
  "stock-info-digest": "monitoring",
};

const LIGHTVELA_PREVIEW_BY_ID: Record<string, AutomationTemplatePreviewKind> = {
  "daily-summary": "review",
  "morning-start": "briefing",
  "weekly-review": "review",
  "task-tidy": "reminder",
  stretch: "wellbeing",
  "news-digest": "briefing",
  "medication-once": "wellbeing",
  "rent-reminder": "reminder",
  "country-fx-alert": "monitor",
  "calorie-fitness-checkin": "wellbeing",
  "global-holiday-reminder": "monitor",
  "stock-info-digest": "monitor",
};

const LIGHTVELA_QUIET_IDS = new Set([
  "country-fx-alert",
  "global-holiday-reminder",
  "stock-info-digest",
]);

function parseWeekdays(value: string): number[] {
  const values = new Set<number>();
  for (const part of value.split(",")) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let day = start; day <= end; day += 1) values.add(day);
    } else if (/^\d$/.test(part)) {
      values.add(Number(part));
    }
  }
  return [...values].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
}

export function toAutomationTemplateSchedule(schedule: string): AutomationTemplateSchedule | null {
  const normalized = schedule.trim();
  const minuteInterval = /^\*\/(\d+) \* \* \* \*$/.exec(normalized);
  if (minuteInterval) {
    return { kind: "interval", intervalNum: Number(minuteInterval[1]), intervalUnit: "m" };
  }
  const hourInterval = /^0 \*\/(\d+) \* \* \*$/.exec(normalized);
  if (hourInterval) {
    return { kind: "interval", intervalNum: Number(hourInterval[1]), intervalUnit: "h" };
  }
  const cron = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}(?:,\d{1,2})*) \* (\*|[0-6](?:[-,][0-6])*)$/.exec(normalized);
  if (!cron) return null;
  const minute = Number(cron[1]);
  const hour = Number(cron[2]);
  if (minute > 59 || hour > 23) return null;
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const monthdays = cron[3];
  const weekdays = cron[4];
  if (!monthdays || !weekdays) return null;
  if (monthdays === "*" && weekdays === "*") {
    return { kind: "recurring", period: "daily", time };
  }
  if (monthdays === "*") {
    const parsedWeekdays = parseWeekdays(weekdays);
    if (parsedWeekdays.length === 0) return null;
    return {
      kind: "recurring",
      period: "weekly",
      time,
      weekday: parsedWeekdays[0],
      weekdays: parsedWeekdays,
    };
  }
  if (weekdays === "*") {
    const parsedMonthdays = monthdays.split(",").map(Number).filter((day) => day >= 1 && day <= 31);
    if (parsedMonthdays.length === 0) return null;
    return {
      kind: "recurring",
      period: "monthly",
      time,
      monthday: parsedMonthdays[0],
      monthdays: parsedMonthdays,
    };
  }
  return null;
}

function zhScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "分钟" : schedule.intervalUnit === "d" ? "天" : "小时";
    return `每 ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `每天 ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `每周定时 · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `每月定时 · ${schedule.time ?? ""}`.trim();
  return "按计划执行";
}

function zhHantScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "分鐘" : schedule.intervalUnit === "d" ? "天" : "小時";
    return `每 ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `每天 ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `每週定時 · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `每月定時 · ${schedule.time ?? ""}`.trim();
  return "按計劃執行";
}

function enScheduleLabel(schedule: AutomationTemplateSchedule): string {
  if (schedule.kind === "interval") {
    const unit = schedule.intervalUnit === "m" ? "minutes" : schedule.intervalUnit === "d" ? "days" : "hours";
    return `Every ${schedule.intervalNum ?? 1} ${unit}`;
  }
  if (schedule.period === "daily") return `Daily at ${schedule.time ?? ""}`.trim();
  if (schedule.period === "weekly") return `Weekly · ${schedule.time ?? ""}`.trim();
  if (schedule.period === "monthly") return `Monthly · ${schedule.time ?? ""}`.trim();
  return "Runs on schedule";
}

function localizedScheduleLabel(schedule: AutomationTemplateSchedule, locale: string): string {
  const normalizedLocale = locale.toLowerCase();
  if (normalizedLocale.startsWith("zh-hant")) return zhHantScheduleLabel(schedule);
  if (normalizedLocale.startsWith("zh")) return zhScheduleLabel(schedule);
  const amount = schedule.intervalNum ?? 1;
  if (normalizedLocale.startsWith("es")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "minutos" : schedule.intervalUnit === "d" ? "días" : "horas";
      return `Cada ${amount} ${unit}`;
    }
    if (schedule.period === "daily") return `Cada día a las ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `Cada semana · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `Cada mes · ${schedule.time ?? ""}`.trim();
    return "Se ejecuta según lo programado";
  }
  if (normalizedLocale.startsWith("id")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "menit" : schedule.intervalUnit === "d" ? "hari" : "jam";
      return `Setiap ${amount} ${unit}`;
    }
    if (schedule.period === "daily") return `Setiap hari pukul ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `Setiap minggu · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `Setiap bulan · ${schedule.time ?? ""}`.trim();
    return "Berjalan sesuai jadwal";
  }
  if (normalizedLocale.startsWith("ja")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "分" : schedule.intervalUnit === "d" ? "日" : "時間";
      return `${amount}${unit}ごと`;
    }
    if (schedule.period === "daily") return `毎日 ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `毎週 · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `毎月 · ${schedule.time ?? ""}`.trim();
    return "スケジュールどおりに実行";
  }
  if (normalizedLocale.startsWith("ko")) {
    if (schedule.kind === "interval") {
      const unit = schedule.intervalUnit === "m" ? "분" : schedule.intervalUnit === "d" ? "일" : "시간";
      return `${amount}${unit}마다`;
    }
    if (schedule.period === "daily") return `매일 ${schedule.time ?? ""}`.trim();
    if (schedule.period === "weekly") return `매주 · ${schedule.time ?? ""}`.trim();
    if (schedule.period === "monthly") return `매월 · ${schedule.time ?? ""}`.trim();
    return "예약대로 실행";
  }
  return enScheduleLabel(schedule);
}

export function enrichLightVelaAutomationTemplates(
  templates: readonly AutomationTemplateInput[],
  locale: string,
): AutomationCatalogTemplate[] {
  return templates.map((template) => ({
    ...template,
    source: "lightvela",
    category: LIGHTVELA_CATEGORY_BY_ID[template.id] ?? "productivity",
    tags: [],
    scheduleLabel: localizedScheduleLabel(template.schedule, locale),
    deliver: "local",
    skills: template.skills ?? [],
    ...(LIGHTVELA_QUIET_IDS.has(template.id) ? { executionRules: QUIET_MONITOR_EXECUTION_RULES } : {}),
    notificationPolicy: LIGHTVELA_QUIET_IDS.has(template.id) ? "only-when-needed" : "always",
    previewKind: LIGHTVELA_PREVIEW_BY_ID[template.id] ?? "reminder",
  }));
}

export function mergeAutomationTemplateCatalog(
  lightvelaTemplates: readonly AutomationCatalogTemplate[],
  blueprints: readonly HermesAutomationBlueprint[],
  locale: string,
): AutomationCatalogTemplate[] {
  const isChinese = locale.startsWith("zh");
  const isTraditionalChinese = locale.toLowerCase().startsWith("zh-hant");
  const runtimeBlueprintsByKey = new Map(blueprints.map((blueprint) => [blueprint.key, blueprint]));
  const blueprintsByKey = new Map(HERMES_AUTOMATION_BLUEPRINT_BASELINE.map((blueprint) => [blueprint.key, blueprint]));
  for (const blueprint of blueprints) blueprintsByKey.set(blueprint.key, blueprint);
  const hermesTemplates = [...blueprintsByKey.values()].flatMap((blueprint): AutomationCatalogTemplate[] => {
    if (HERMES_BLUEPRINT_OVERLAPS.has(blueprint.key)) return [];
    const schedule = toAutomationTemplateSchedule(blueprint.spec.schedule);
    if (!schedule) return [];
    const localized = isTraditionalChinese
      ? HERMES_ZH_HANT_COPY[blueprint.key]
      : isChinese ? HERMES_ZH_COPY[blueprint.key] : undefined;
    const curatedBaseline = HERMES_AUTOMATION_BLUEPRINT_BASELINE.find((item) => item.key === blueprint.key);
    const prompt = (localized?.prompt ?? curatedBaseline?.spec.prompt ?? blueprint.spec.prompt)
      .slice(0, AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH);
    const runtimePrompt = runtimeBlueprintsByKey.get(blueprint.key)?.spec.prompt.trim();
    const curatedExecutionRules = HERMES_EXECUTION_RULES_BY_KEY[blueprint.key];
    const combinedExecutionRules = [runtimePrompt, curatedExecutionRules]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const executionRules = composeAutomationExecutionPrompt(prompt, combinedExecutionRules).length
      <= AUTOMATION_EXECUTION_PROMPT_MAX_LENGTH
      ? combinedExecutionRules
      : curatedExecutionRules;
    return [{
      id: blueprint.key,
      source: "hermes",
      name: localized?.name ?? blueprint.title,
      description: localized?.description ?? blueprint.description,
      category: CATEGORY_BY_KEY[blueprint.key] ?? "productivity",
      tags: blueprint.tags,
      prompt,
      ...(curatedBaseline && executionRules ? { executionRules } : {}),
      schedule,
      scheduleLabel: isTraditionalChinese
        ? zhHantScheduleLabel(schedule)
        : isChinese ? zhScheduleLabel(schedule) : blueprint.scheduleHuman,
      deliver: blueprint.spec.deliver,
      skills: normalizeBlueprintSkills(blueprint.key, blueprint.spec.skills),
      notificationPolicy: QUIET_BLUEPRINTS.has(blueprint.key) ? "only-when-needed" : "always",
      previewKind: PREVIEW_BY_KEY[blueprint.key] ?? "reminder",
    }];
  });
  const featuredTemplates = FEATURED_RESULT_BLUEPRINTS.flatMap((id) => {
    const template = hermesTemplates.find((item) => item.id === id);
    return template ? [template] : [];
  });
  const featuredIds = new Set(featuredTemplates.map((template) => template.id));
  return [
    ...featuredTemplates,
    ...lightvelaTemplates,
    ...hermesTemplates.filter((template) => !featuredIds.has(template.id)),
  ];
}
