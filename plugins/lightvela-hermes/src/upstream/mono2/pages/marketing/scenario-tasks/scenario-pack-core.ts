// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 场景任务 pack 的共享构造边界。
 *
 * 该模块只包含 pack 类型、构造器及 overview/full task library 都会使用的
 * 字段选项。不要从这里反向导入 scenario-packs.ts。
 */
import type { PublicSiteLocaleCode } from "../../../lib/public-site-routing";

export type ScenarioTaskId = string;

export type ScenarioTaskFieldType =
  | "text"
  | "number"
  | "textarea"
  | "select"
  | "dropdown"
  | "multi-dropdown"
  | "checkbox"
  | "date"
  | "datetime"
  | "time"
  | "times"
  | "multiselect";

export interface ScenarioTaskFieldOption {
  value: string;
  label: string;
}

export interface ScenarioTaskField {
  key: string;
  label: string;
  type: ScenarioTaskFieldType;
  defaultValue: string;
  required?: boolean;
  /** 快速启用时即使已有默认值也需要让用户确认。 */
  quickConfirm?: boolean;
  placeholder?: string;
  helpText?: string;
  maxLength?: number;
  maxItems?: number;
  min?: number;
  max?: number;
  step?: number;
  rows?: number;
  options?: ScenarioTaskFieldOption[];
  visibleWhen?: {
    fieldKey: string;
    values: string[];
  };
}

export interface ScenarioQuickPromptVisibility {
  fieldKey: string;
  values: string[];
}

export type ScenarioQuickPromptPart =
  | {
      type: "text";
      text: string;
      visibleWhen?: ScenarioQuickPromptVisibility;
    }
  | {
      type: "field";
      fieldKey: string;
      trueLabel?: string;
      falseLabel?: string;
      visibleWhen?: ScenarioQuickPromptVisibility;
    };

/** 卡片可用图标（在 ScenarioTaskGrid 里映射到 lucide 图标与配色） */
export type ScenarioIcon =
  | "trending-up"
  | "trophy"
  | "newspaper"
  | "brain-circuit"
  | "heart-pulse"
  | "pill"
  | "droplets"
  | "moon"
  | "activity"
  | "goal"
  | "user-round"
  | "radio"
  | "clipboard-list"
  | "repeat"
  | "calendar-clock"
  | "mail"
  | "languages"
  | "book-open"
  | "graduation-cap"
  | "users"
  | "baby"
  | "shopping-cart"
  | "bell"
  | "credit-card"
  | "wallet"
  | "arrow-left-right"
  | "piggy-bank"
  | "radar"
  | "search"
  | "megaphone"
  | "cloud-rain"
  | "train-front"
  | "plane"
  | "stamp"
  | "map-pin";

/** 一级分类 ID */
export type ScenarioCategoryId =
  | "health"
  | "sports"
  | "work"
  | "study"
  | "family"
  | "finance"
  | "content"
  | "travel";

export type ScenarioTriggerType = "cron" | "schedule" | "goal" | "webhook" | "team";

export interface ScenarioCategoryMeta {
  id: ScenarioCategoryId;
  label: string;
  description: string;
  icon: ScenarioIcon;
  /** 二级子类顺序 */
  subCategories: string[];
}

export interface ScenarioTaskPack {
  id: ScenarioTaskId;
  name: string;
  /** 一句话价值：卡片主推文案 */
  valueProp: string;
  /** 较完整的描述（用于弹窗/hover） */
  description: string;
  /** 快速启用时允许用户编辑的一句话任务要求。 */
  quickPrompt: string;
  /** 快速启用时展示的自然语言模板；field 片段与真实 Cron 参数双向绑定。 */
  quickPromptTemplate?: ScenarioQuickPromptPart[];
  /**
   * 仅控制快速任务句里的日期与列表显示，不参与 Cron 解析。
   *
   * 使用注册表的 `PublicSiteLocaleCode`，新增语种无需改此类型；
   * 未提供专属格式化规则的语种会走 `scenario-task-builder` 中的默认分支。
   */
  quickPromptLocale?: PublicSiteLocaleCode;
  category: ScenarioCategoryId;
  /** 二级子类（须属于所在分类的 subCategories） */
  subCategory: string;
  defaultFrequencyLabel: string;
  defaultSchedule: string;
  /** 预计耗时（单次执行/阅读） */
  durationLabel: string;
  /** 订阅人数（展示用） */
  subscriberCount: number;
  /** 评分 0-5 */
  rating: number;
  /** 任务运行方式：默认是循环任务；one-shot 用于赶飞机、一次性提醒等单次自动化。 */
  runMode?: "recurring" | "one-shot";
  /** always 每次都推送；only-when-needed 仅在满足条件时推送，其余运行静默留痕。 */
  notificationPolicy?: "always" | "only-when-needed";
  /** 触发机制：当前前台只暴露 Cron、一次性 Schedule 和 Goal。 */
  triggerType?: ScenarioTriggerType;
  /** one-shot 场景可从某个字段读取单次触发时间，格式由前端 builder 做宽松解析。 */
  oneShotScheduleFieldKey?: string;
  /** 允许一个模板根据用户选择在单次与周期任务间切换。 */
  runModeFieldKey?: string;
  oneShotRunModeValues?: string[];
  /** 每日多次提醒场景从该字段读取 HH:MM 时间点，并通过 Hermes 前置脚本精确触发。 */
  dailyTimesFieldKey?: string;
  /** 把开始时间、结束时间和小时间隔展开为每日精确执行节点。 */
  dailyIntervalSchedule?: {
    modeFieldKey: string;
    intervalModeValues: string[];
    intervalHoursFieldKey: string;
    startTimeFieldKey: string;
    endTimeFieldKey: string;
  };
  /** 周期任务的结束日期字段；创建 Cron 时会写入前置脚本。 */
  effectiveEndDateFieldKey?: string;
  defaultDeliverLabel: string;
  requiredInfoLabel: string;
  icon: ScenarioIcon;
  /** 今日必看：高频刚需，聚合到首页顶部 */
  featured?: boolean;
  /** 是否需要联网检索实时信息。 */
  needsRealtime?: boolean;
  fields: ScenarioTaskField[];
  safetyNote?: string;
  /** 给用户看的使用说明，解释这个模板如何工作。 */
  usageGuide?: string[];
  /** Cron 创建时挂载的 Hermes skill slug；对应官方 `--skill` / `skills=[...]`。 */
  skillIds?: string[];
  /** 场景 prompt 或工作流参考来源，用于卡片与详情页标注。 */
  skillSources?: ScenarioSkillSource[];
  promptBuilder: (values: Record<string, string>) => string;
}

export interface ScenarioSkillSource {
  slug: string;
  name: string;
  provider: string;
  source: string;
  url: string;
  description: string;
}

export const SCENARIO_MULTISELECT_SEPARATOR = "|";

export function isScenarioTaskFieldVisible(
  field: ScenarioTaskField,
  values: Record<string, string>,
): boolean {
  if (!field.visibleWhen) return true;
  return field.visibleWhen.values.includes(values[field.visibleWhen.fieldKey] ?? "");
}

function splitScenarioListValue(value: string): string[] {
  return value.split(/[|、,，]/).map((item) => item.trim()).filter(Boolean);
}

function formatMultiselectValue(value: string): string {
  return splitScenarioListValue(value)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" / ");
}

function valueOf(
  fields: readonly ScenarioTaskField[],
  values: Record<string, string>,
  key: string,
): string {
  const field = fields.find((item) => item.key === key);
  const configured = values[key]?.trim();
  const value = configured || field?.defaultValue || "";
  if (field?.type === "checkbox") return value === "true" ? "是" : "否";
  if (field?.type === "multi-dropdown") {
    const labelByValue = new Map((field.options ?? []).map((option) => [option.value, option.label]));
    return splitScenarioListValue(value)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => labelByValue.get(item) ?? item)
      .join(" / ");
  }
  return ["multiselect", "multi-dropdown", "times"].includes(field?.type ?? "")
    ? formatMultiselectValue(value)
    : value;
}

const realtimeToolInstruction = [
  "执行要求：先调用 datetime 确认当前日期和时区；实时信息必须优先调用 web_search 检索，必要时再用 web_fetch 打开 1-2 个权威来源核对。",
  "不要进行开放式长时间浏览；同一任务最多检索 3 组关键词、最多打开 4 个网页来源。信息不足时直接说明未确认，不要编造。",
  "输出时保留来源名称或链接，方便我回看。",
].join("\n");

const quietDeliveryInstruction = [
  "低打扰投递规则：先执行检查和判断；只有满足用户设定的提醒条件、发现明确变化或出现需要行动的风险时，才输出完整消息。",
  "如果本次没有达到提醒条件，最终响应只能是 [SILENT]，不要发送“暂无变化”“一切正常”之类的占位消息。",
  "如果检查失败或关键来源无法访问，不要静默；简短说明失败来源和建议的下一步。",
].join("\n");

const userSourceInstruction = [
  "用户资料使用方式：如果用户提供了链接或粘贴资料，先把这些资料当作本任务的优先依据。",
  "对用户提供的链接，仅在需要时用 web_fetch 打开用户明确给出的链接；不要围绕链接做开放式搜索。",
  "如果资料和用户手填信息冲突，优先提醒用户核对，不要擅自改剂量、改医嘱或扩大结论。",
  "输出时说明哪些结论来自用户资料，哪些仍需要用户确认。",
].join("\n");

const entityExtractionFocusByCategory: Record<ScenarioCategoryId, string> = {
  health: "健康/用药重点抽取：药名、剂量、频次、时间、饭前饭后、禁忌、漏服处理、复诊或补提醒节点。",
  sports: "运动重点抽取：运动类型、频次、强度、时长、身体反馈和需要调整的节点。",
  work: "工作重点抽取：目标、负责人、截止时间、依赖、阻塞项、优先级和下一步动作。",
  study: "学习类重点抽取：书名、章节、篇目、知识点、薄弱项、已掌握状态和下一次复习间隔。",
  family: "家庭事项重点抽取：事项、对象、日期、金额、地点、分工和需要提前准备的节点。",
  finance: "财务重点抽取：币种、方向、金额、阈值、账期、支付对象、股票名称、代码、市场和需要提醒的条件。",
  content: "地点、预警类型、级别、影响时段、国家、日期、信息来源和需要行动的节点。",
  travel: "出行重点抽取：出发地、目的地、日期、航班、交通方式、证件和需要提前行动的节点。",
};

function buildEntityExtractionInstruction(config: Pick<MakePackConfig, "id" | "category">): string {
  const focus = config.id === "cbt-counseling"
    ? "心理类重点抽取：触发事件、情绪词、身体反应、自动想法、可能的认知偏差、用户希望的回应方式。"
    : entityExtractionFocusByCategory[config.category];
  return [
    "实体抽取方式：先从用户填写内容和用户资料中抽取关键实体，再生成任务计划，不要只照搬默认模板。",
    focus,
  ].join("\n");
}

/** 大多数提醒类卡片共用的轻量配置表单 */
const genericFields: ScenarioTaskField[] = [
  {
    key: "focus",
    label: "关注重点",
    type: "text",
    defaultValue: "",
    placeholder: "可选，补充你最在意的点",
  },
  {
    key: "reminderTime",
    label: "提醒时间偏好",
    type: "text",
    defaultValue: "",
    placeholder: "可选，例如 早 8:00 / 睡前 / 上班前",
  },
];

function getDefaultYearEndDate(now = new Date()): string {
  const year = new Intl.DateTimeFormat("en", {
    year: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(now);
  return `${year}-12-31`;
}

export const defaultYearEndDate = getDefaultYearEndDate();

export function customRequestField(defaultValue: string, placeholder = "也可以写你自己的补充要求"): ScenarioTaskField {
  return {
    key: "customRequest",
    label: "补充要求",
    type: "text",
    defaultValue,
    placeholder,
    maxLength: 240,
  };
}

const currencyFallbackCodes = [
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWL",
];

function buildCurrencyOptions(): ScenarioTaskFieldOption[] {
  let codes = currencyFallbackCodes;
  try {
    const supportedValuesOf = (Intl as typeof Intl & {
      supportedValuesOf?: (key: "currency") => string[];
    }).supportedValuesOf;
    if (supportedValuesOf) codes = supportedValuesOf("currency");
  } catch {
    // Older browsers use the comprehensive fallback list above.
  }

  const priority = ["CNY", "USD", "HKD", "EUR", "GBP", "JPY", "KRW", "SGD", "THB", "IDR", "AUD"];
  const uniqueCodes = Array.from(new Set([...priority, ...codes]));
  const prioritySet = new Set(priority);
  const displayNames = typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["zh-CN"], { type: "currency" })
    : null;

  return uniqueCodes
    .sort((left, right) => {
      const leftPriority = priority.indexOf(left);
      const rightPriority = priority.indexOf(right);
      if (leftPriority >= 0 || rightPriority >= 0) {
        return (leftPriority >= 0 ? leftPriority : Number.MAX_SAFE_INTEGER)
          - (rightPriority >= 0 ? rightPriority : Number.MAX_SAFE_INTEGER);
      }
      return left.localeCompare(right);
    })
    .map((code) => {
      const name = displayNames?.of(code);
      return {
        value: code,
        label: name && name !== code ? `${name} ${code}` : code,
      };
    })
    .filter((option) => prioritySet.has(option.value) || /^[A-Z]{3}$/.test(option.value));
}

export const currencyOptions = buildCurrencyOptions();

const GLOBAL_REGION_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(" ");

function buildRegionOptions(): ScenarioTaskFieldOption[] {
  const preferred = ["CN", "HK", "MO", "TW", "TH", "ID", "SG", "MY", "JP", "KR", "VN", "US", "GB", "AU", "CA", "DE", "FR"];
  const preferredIndex = new Map(preferred.map((code, index) => [code, index]));
  const displayNames = typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["zh-CN"], { type: "region" })
    : null;
  return GLOBAL_REGION_CODES
    .map((code) => ({
      value: code,
      label: displayNames?.of(code) ?? code,
    }))
    .sort((left, right) => {
      const leftIndex = preferredIndex.get(left.value);
      const rightIndex = preferredIndex.get(right.value);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return left.label.localeCompare(right.label, "zh-CN");
    });
}

export const regionOptions = buildRegionOptions();

export interface MakePackConfig {
  id: string;
  category: ScenarioCategoryId;
  subCategory: string;
  name: string;
  valueProp: string;
  description: string;
  frequencyLabel: string;
  schedule: string;
  durationLabel: string;
  subscriberCount: number;
  rating: number;
  icon: ScenarioIcon;
  runMode?: "recurring" | "one-shot";
  notificationPolicy?: "always" | "only-when-needed";
  triggerType?: ScenarioTriggerType;
  oneShotScheduleFieldKey?: string;
  runModeFieldKey?: string;
  oneShotRunModeValues?: string[];
  dailyTimesFieldKey?: string;
  dailyIntervalSchedule?: ScenarioTaskPack["dailyIntervalSchedule"];
  effectiveEndDateFieldKey?: string;
  featured?: boolean;
  /** 任务目标（prompt 首句） */
  promptIntro: string;
  /** 快速启用时展示的一句话任务要求；默认复用任务目标。 */
  quickPrompt?: string;
  /** 把关键参数嵌进可直接运行的自然语言任务要求。 */
  quickPromptTemplate?: ScenarioQuickPromptPart[];
  /** 输出结构（编号列表） */
  promptStructure: string[];
  fields?: ScenarioTaskField[];
  /** 是否需要联网检索实时信息 */
  needsRealtime?: boolean;
  requiredInfoLabel?: string;
  safetyNote?: string;
  usageGuide?: string[];
  skillIds?: string[];
  skillSources?: ScenarioSkillSource[];
  automationProtocol?: string[];
  useEntityExtraction?: boolean;
}

export function makePack(config: MakePackConfig): ScenarioTaskPack {
  const fields = config.fields ?? genericFields;
  return {
    id: config.id,
    name: config.name,
    valueProp: config.valueProp,
    description: config.description,
    quickPrompt: config.quickPrompt ?? config.promptIntro,
    quickPromptTemplate: config.quickPromptTemplate,
    category: config.category,
    subCategory: config.subCategory,
    defaultFrequencyLabel: config.frequencyLabel,
    defaultSchedule: config.schedule,
    durationLabel: config.durationLabel,
    subscriberCount: config.subscriberCount,
    rating: config.rating,
    runMode: config.runMode,
    notificationPolicy: config.notificationPolicy,
    triggerType: config.triggerType ?? (config.runMode === "one-shot" ? "schedule" : "cron"),
    oneShotScheduleFieldKey: config.oneShotScheduleFieldKey,
    runModeFieldKey: config.runModeFieldKey,
    oneShotRunModeValues: config.oneShotRunModeValues,
    dailyTimesFieldKey: config.dailyTimesFieldKey,
    dailyIntervalSchedule: config.dailyIntervalSchedule,
    effectiveEndDateFieldKey: config.effectiveEndDateFieldKey,
    defaultDeliverLabel: "网页 / 最近执行",
    requiredInfoLabel: config.requiredInfoLabel ?? "关注重点、提醒时间（均可选）",
    icon: config.icon,
    featured: config.featured,
    needsRealtime: config.needsRealtime,
    fields,
    safetyNote: config.safetyNote,
    usageGuide: config.usageGuide,
    skillIds: config.skillIds,
    skillSources: config.skillSources,
    promptBuilder: (values) => {
      const valueLines = formatScenarioFieldValueLines(fields, values);
      const hasUserSourceValue = hasFilledUserSourceField(fields, values);
      return [
        config.promptIntro,
        config.skillSources?.length ? `能力参考：${formatSkillSourcePromptLabel(config.skillSources)}。` : null,
        config.needsRealtime ? realtimeToolInstruction : null,
        config.notificationPolicy === "only-when-needed" ? quietDeliveryInstruction : null,
        hasUserSourceValue ? userSourceInstruction : null,
        config.useEntityExtraction ? buildEntityExtractionInstruction(config) : null,
        config.automationProtocol?.length
          ? [
              "自动化执行方式：",
              ...config.automationProtocol.map((line, index) => `${index + 1}. ${line}`),
            ].join("\n")
          : null,
        valueLines.length ? ["用户配置：", ...valueLines].join("\n") : null,
        "请按以下结构输出：",
        ...config.promptStructure.map((line, index) => `${index + 1}. ${line}`),
        config.safetyNote ? `注意：${config.safetyNote}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

function isUserSourceField(field: ScenarioTaskField): boolean {
  return /(?:source|material|link|url|guide)/i.test(field.key);
}

function hasFilledUserSourceField(
  fields: readonly ScenarioTaskField[],
  values: Record<string, string>,
): boolean {
  return fields.some((field) => isUserSourceField(field) && valueOf(fields, values, field.key).trim());
}

function formatScenarioFieldValueLines(
  fields: readonly ScenarioTaskField[],
  values: Record<string, string>,
): string[] {
  return fields
    .map((field) => {
      if (!isScenarioTaskFieldVisible(field, values)) return "";
      const value = valueOf(fields, values, field.key);
      return value ? `${field.label}：${value}。` : "";
    })
    .filter((line): line is string => Boolean(line));
}

function formatSkillSourcePromptLabel(sources: ScenarioSkillSource[]): string {
  return sources
    .map((source) => `${source.source} / ${source.name}（${source.provider}）`)
    .join("；");
}
