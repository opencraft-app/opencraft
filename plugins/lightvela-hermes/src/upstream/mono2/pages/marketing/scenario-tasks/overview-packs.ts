// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * 官网首页使用的 6 个精选场景 pack。
 *
 * 这里是这 6 个 pack 的唯一事实来源；完整任务库只负责把它们聚合回原有顺序。
 * 本模块不得导入 scenario-packs.ts，避免首页重新拉入完整场景库。
 */
import type { PublicSiteLocaleCode } from "../../../lib/public-site-routing";

import {
  currencyOptions,
  customRequestField,
  defaultYearEndDate,
  makePack,
  regionOptions,
  type ScenarioQuickPromptPart,
  type ScenarioTaskField,
  type ScenarioTaskPack,
} from "./scenario-pack-core";

export const OVERVIEW_SCENARIO_TASK_IDS = [
  "medication-once",
  "rent-reminder",
  "country-fx-alert",
  "calorie-fitness-checkin",
  "global-holiday-reminder",
  "stock-info-digest",
] as const;

const medicationAutomationFields: ScenarioTaskField[] = [
  {
    key: "reminderMode",
    label: "提醒方式",
    type: "select",
    defaultValue: "按疗程重复",
    quickConfirm: true,
    options: [
      { value: "仅这一次", label: "仅这一次" },
      { value: "按疗程重复", label: "按疗程重复" },
      { value: "长期重复", label: "长期重复" },
    ],
    helpText: "按疗程会在结束日期后自动停止；长期重复会持续运行，之后可在定时任务里暂停或删除。",
  },
  {
    key: "triggerAt",
    label: "提醒时间",
    type: "datetime",
    defaultValue: "",
    required: true,
    helpText: "仅在这个时间提醒一次。",
    visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] },
  },
  {
    key: "recurringTimes",
    label: "每日提醒时间",
    type: "times",
    defaultValue: "08:00|20:00",
    required: true,
    maxItems: 4,
    helpText: "可添加最多 4 个明确时间点；任务会分别在这些时间提醒。",
    visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] },
  },
  {
    key: "courseEndDate",
    label: "疗程结束日期",
    type: "date",
    defaultValue: defaultYearEndDate,
    required: true,
    placeholder: "请选择疗程结束日期",
    helpText: "从启用当天开始执行，到这一天结束后自动停止提醒。",
    visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] },
  },
  {
    key: "medicineType",
    label: "提醒类型",
    type: "select",
    defaultValue: "口服药",
    options: [
      { value: "口服药", label: "口服药" },
      { value: "外用药/贴剂", label: "外用药/贴剂" },
      { value: "滴眼液/喷剂", label: "滴眼液/喷剂" },
      { value: "术后/临时医嘱", label: "术后/临时医嘱" },
      { value: "复诊/检查前准备", label: "复诊/检查前准备" },
    ],
  },
  {
    key: "medicine",
    label: "药品与剂量",
    type: "textarea",
    defaultValue: "按医嘱服用我的常用药，剂量按原医嘱",
    required: true,
    placeholder: "药名、剂量、饭前/饭后、注意事项",
    rows: 3,
  },
  {
    key: "sourceLinks",
    label: "说明书/用药指南链接",
    type: "textarea",
    defaultValue: "",
    placeholder: "可选：粘贴药品说明书、医院用药指南、医生发来的链接，一行一个",
    helpText: "Agent 会优先按你提供的资料提取用药时间和注意事项；不会替代医生医嘱。",
    maxLength: 1000,
    rows: 3,
  },
  {
    key: "sourceText",
    label: "粘贴说明书重点",
    type: "textarea",
    defaultValue: "",
    placeholder: "可选：粘贴用法用量、禁忌、饭前饭后、漏服处理等原文",
    maxLength: 1600,
    rows: 4,
  },
  customRequestField(
    "喝水只做轻提醒；用药严格按医嘱和我补充的说明书/链接提醒",
    "例如 饭后提醒、顺便站立 1 分钟、复诊前一天也提醒",
  ),
];

const calorieFitnessAutomationFields: ScenarioTaskField[] = [
  {
    key: "checkinTime",
    label: "记录时间",
    type: "times",
    defaultValue: "21:30",
    required: true,
    maxItems: 5,
    helpText: "可设置 1-5 个提醒时间，比如早餐后、午饭后、睡前。",
  },
  {
    key: "fitnessGoal",
    label: "目标",
    type: "text",
    defaultValue: "减脂并保持力量训练",
    required: true,
    placeholder: "例如 减脂、增肌、维持体重、备赛、恢复训练",
    maxLength: 120,
  },
  {
    key: "bodyProfile",
    label: "身体数据（可选）",
    type: "text",
    defaultValue: "",
    placeholder: "例如 168cm，62kg，目标 58kg，每周练 3 次",
    helpText: "可不填；填写后只用于估算和趋势记录，不做医疗或营养诊断。",
    maxLength: 160,
  },
  {
    key: "foodLog",
    label: "记录内容",
    type: "text",
    defaultValue: "让我记录今天吃了什么、运动了什么和体重变化",
    required: true,
    placeholder: "例如 晚上问我三餐、饮料、运动和体重",
    maxLength: 160,
  },
  {
    key: "reportStyle",
    label: "反馈方式",
    type: "select",
    defaultValue: "估算热量 + 给明天一个小调整",
    options: [
      { value: "估算热量 + 给明天一个小调整", label: "热量估算 + 明天建议" },
      { value: "只做记录和趋势，不评价", label: "只记录趋势" },
      { value: "重点看蛋白质、饮水和运动完成度", label: "看蛋白质/饮水/运动" },
    ],
  },
  customRequestField(
    "身体数据（可选）：可补充身高、体重、年龄、性别、目标体重和运动基础；如果我没记录完整，先问我缺少的餐次或运动信息",
    "例如 素食、控糖、夜宵多、希望鼓励式反馈",
  ),
];

const rentAutomationFields: ScenarioTaskField[] = [
  {
    key: "reminderTime",
    label: "提醒时间",
    type: "time",
    defaultValue: "09:00",
    required: true,
    helpText: "任务会在这个时间检查账期，只有进入提醒窗口时才通知。",
  },
  {
    key: "dueDate",
    label: "本期到期日",
    type: "date",
    defaultValue: defaultYearEndDate,
    required: true,
    helpText: "用这一天确定每月账期；后续每月同日到期，没有该日期的月份按当月最后一天处理。",
  },
  {
    key: "rentInfo",
    label: "租金/账单信息",
    type: "textarea",
    defaultValue: "房租 5000 元，付给房东，通过银行转账",
    required: true,
    placeholder: "例如 房租 5000 元，付给房东，通过银行转账",
    rows: 3,
  },
  {
    key: "advanceDays",
    label: "提前几天提醒",
    type: "dropdown",
    defaultValue: "3",
    options: Array.from({ length: 31 }, (_, days) => ({
      value: String(days),
      label: days === 0 ? "不提前提醒" : `提前 ${days} 天`,
    })),
  },
  {
    key: "includeDueDay",
    label: "到期当天也提醒",
    type: "checkbox",
    defaultValue: "true",
    helpText: "关闭后只在提前日期提醒，到期当天不重复推送。",
  },
  customRequestField(
    "如果我补充了水电、车位费、付款备注或房东信息，也一起写进提醒",
    "例如 房东微信名、转账卡号备注、水电一起交",
  ),
];

const fxAutomationFields: ScenarioTaskField[] = [
  {
    key: "reminderTime",
    label: "提醒时间",
    type: "time",
    defaultValue: "10:00",
    required: true,
    helpText: "任务会在这个时间检查汇率，达到条件时才通知。",
  },
  {
    key: "fromCurrency",
    label: "换出币种",
    type: "dropdown",
    defaultValue: "CNY",
    quickConfirm: true,
    options: currencyOptions,
  },
  {
    key: "toCurrency",
    label: "换入币种",
    type: "dropdown",
    defaultValue: "USD",
    quickConfirm: true,
    options: currencyOptions,
  },
  {
    key: "thresholdMode",
    label: "触发条件",
    type: "dropdown",
    defaultValue: "相较前一自然日同源参考值，涨跌幅达到",
    quickConfirm: true,
    options: [
      { value: "相较前一自然日同源参考值，涨跌幅达到", label: "较前一日涨跌幅达到（%）" },
      { value: "当前汇率高于", label: "当前汇率高于" },
      { value: "当前汇率低于", label: "当前汇率低于" },
    ],
  },
  {
    key: "thresholdValue",
    label: "阈值数值",
    type: "number",
    defaultValue: "1",
    required: true,
    min: 0.0001,
    step: 0.0001,
    placeholder: "例如 1，表示涨跌 1%；或填写目标汇率",
    helpText: "选择涨跌幅时，1 表示 1%；选择高于/低于时，填写目标货币对的目标汇率。",
  },
  {
    key: "actionMode",
    label: "触发后动作",
    type: "select",
    defaultValue: "只提醒，不给交易建议",
    options: [
      { value: "只提醒，不给交易建议", label: "只提醒，不给交易建议" },
      { value: "提醒并解释可能原因", label: "提醒并解释可能原因" },
      { value: "提醒并给我需要核对的信息", label: "提醒并给我需要核对的信息" },
    ],
  },
  customRequestField(
    "用于旅行/留学/跨境收付款时提醒我需要核对的信息",
    "例如 准备去日本旅行、每次换 3000 元、只看银行现汇卖出价",
  ),
];

const stockInfoAutomationFields: ScenarioTaskField[] = [
  {
    key: "reminderTime",
    label: "提醒时间",
    type: "time",
    defaultValue: "09:00",
    required: true,
    helpText: "任务会在这个时间整理当天可获取的公开信息。",
  },
  {
    key: "stockList",
    label: "关注股票",
    type: "textarea",
    defaultValue: "腾讯控股 00700、英伟达 NVDA、贵州茅台 600519",
    required: true,
    placeholder: "股票名称、代码、市场；也可以只写公司名",
    rows: 3,
  },
  {
    key: "stockFocus",
    label: "关注重点",
    type: "text",
    defaultValue: "最新价格、涨跌幅、重要公告、财报/业绩预告、明显异动原因",
    placeholder: "例如 价格变化、公告、财报、异动原因、行业新闻",
  },
  customRequestField(
    "只做公开信息整理，不给买入、卖出、加仓或减仓建议",
    "例如 只看港股和美股；重点看财报；有公告才提醒",
  ),
];

const globalHolidayAutomationFields: ScenarioTaskField[] = [
  {
    key: "reminderTime",
    label: "提醒时间",
    type: "time",
    defaultValue: "09:00",
    required: true,
    helpText: "任务会在这个时间检查假期、天气和预警信息。",
  },
  {
    key: "holidayCountries",
    label: "关注国家/地区",
    type: "multi-dropdown",
    defaultValue: "TH|ID",
    required: true,
    maxItems: 12,
    options: regionOptions,
    helpText: "可连续选择多个国家或地区，已选择项会显示在下方。",
  },
  {
    key: "holidayScope",
    label: "假期范围",
    type: "select",
    defaultValue: "公共假期 + 调休日 + 银行假日",
    options: [
      { value: "公共假期 + 调休日 + 银行假日", label: "公共假期 + 调休日" },
      { value: "只看法定公共假期", label: "只看法定公共假期" },
      { value: "加上当地大型节庆/交通高峰", label: "含大型节庆" },
    ],
  },
  {
    key: "reminderWindow",
    label: "提醒窗口",
    type: "select",
    defaultValue: "提前 7 天 + 提前 1 天",
    quickConfirm: true,
    options: [
      { value: "提前 7 天 + 提前 1 天", label: "提前 7 天 + 1 天" },
      { value: "提前 3 天 + 当天早上", label: "提前 3 天 + 当天" },
      { value: "仅在假期当天早上提醒", label: "仅当天" },
    ],
  },
  {
    key: "periodMode",
    label: "关注时间",
    type: "select",
    defaultValue: "持续关注",
    options: [
      { value: "持续关注", label: "持续关注" },
      { value: "指定日期范围", label: "指定日期范围" },
    ],
  },
  {
    key: "periodStart",
    label: "关注开始日期",
    type: "date",
    defaultValue: "",
    required: true,
    placeholder: "请选择关注开始日期",
    visibleWhen: { fieldKey: "periodMode", values: ["指定日期范围"] },
  },
  {
    key: "periodEnd",
    label: "关注结束日期",
    type: "date",
    defaultValue: "",
    required: true,
    placeholder: "请选择关注结束日期",
    visibleWhen: { fieldKey: "periodMode", values: ["指定日期范围"] },
  },
  {
    key: "holidayWeatherPlan",
    label: "天气和预警",
    type: "text",
    defaultValue: "同时关注曼谷、雅加达未来 7 天天气预报和暴雨、台风、高温官方预警",
    placeholder: "例如 同时关注曼谷 8 月 1-7 日天气和蓝色/红色暴雨预警；不需要天气也可以删掉",
    maxLength: 180,
  },
  customRequestField(
    "如果我补充旅行、发货、客户沟通或会议日期，请按这些真实安排提醒",
    "例如 8 月去曼谷、给印尼客户排期、避开当地长假发货",
  ),
];

export const OVERVIEW_SCENARIO_TASK_PACK_BY_ID = {
  "medication-once": makePack({
    id: "medication-once",
    category: "health",
    subCategory: "用药提醒",
    name: "喝水与吃药提醒",
    valueProp: "轻提醒喝水，也可按医嘱提醒吃药",
    description: "把喝水、站立等生活提醒和用药提醒放在一个任务里；用药部分始终按医嘱和说明书处理",
    frequencyLabel: "可单次 / 按疗程",
    schedule: "0 8 * * *",
    durationLabel: "约 1 分钟",
    subscriberCount: 11860,
    rating: 4.8,
    icon: "pill",
    runMode: "recurring",
    runModeFieldKey: "reminderMode",
    oneShotRunModeValues: ["仅这一次"],
    oneShotScheduleFieldKey: "triggerAt",
    dailyTimesFieldKey: "recurringTimes",
    effectiveEndDateFieldKey: "courseEndDate",
    featured: true,
    fields: medicationAutomationFields,
    quickPromptTemplate: [
      { type: "text", text: "请用" },
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: "的方式提醒我喝水，并按医嘱服药：" },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: "。" },
      { type: "text", text: "提醒时间是", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: "。", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "每天在", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: "提醒。", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "疗程持续到", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: "。", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "提醒方式、喝水/用药时间、药品剂量、说明书/用药指南（可选）",
    usageGuide: [
      "喝水、站立或拉伸是轻提醒；用药提醒会按你填写的医嘱、说明书或链接执行，二者不会互相改规则。",
      "选择仅这一次、按疗程重复或长期重复；按疗程会在结束日期后自动停止，长期任务可在定时任务里管理。",
      "任务执行时才会尝试打开你提供的公开链接；登录、付费墙或验证码页面可能无法读取，无法读取时会明确告诉你。",
      "任务不会自动判断你是否已经服药，也不会根据回复自行加量或补服；用药请始终以医生医嘱为准。",
    ],
    useEntityExtraction: true,
    promptIntro: "请按用户选择的提醒方式生成可直接执行的喝水与用药提醒。",
    automationProtocol: [
      "喝水、站立或拉伸只作为生活提醒，不做医疗化判断，也不与药品剂量混在一起",
      "先读取用户填写的药品剂量、说明书链接和粘贴原文；如果有链接，只打开用户明确提供的链接",
      "从资料中提取与提醒有关的信息：服用时间、饭前/饭后、漏服处理、禁忌和需要核对的风险点",
      "只根据用户资料和医嘱文本整理提醒，不新增药品建议、不改剂量、不替代医生判断",
    ],
    promptStructure: [
      "明确本次该做什么：药品/类型、剂量、时间、饭前饭后或操作步骤",
      "如果是喝水或站立提醒，只输出一句轻提醒，不延伸成健康诊断",
      "列出 1-3 条来自说明书/用药指南的关键注意事项；没有资料则说明仅按用户填写内容提醒",
      "标注需要用户自行核对的点，例如剂量不清、资料冲突、禁忌不确定",
      "提醒用户服药后自行确认完成；本任务不会监听确认状态或自行更改下一次剂量",
    ],
    safetyNote: "用药请遵医嘱，本提醒不构成用药建议。",
  }),
  "rent-reminder": makePack({
    id: "rent-reminder",
    notificationPolicy: "only-when-needed",
    category: "family",
    subCategory: "居家账务",
    name: "交租提醒",
    valueProp: "房租前置提醒，避免逾期",
    description: "根据账期自动提醒交租，并在临近时提示金额、支付方式和备注信息",
    frequencyLabel: "每日 09:00 检查，按账期提醒",
    schedule: "0 9 * * *",
    durationLabel: "约 1 分钟",
    subscriberCount: 6240,
    rating: 4.7,
    icon: "credit-card",
    fields: rentAutomationFields,
    dailyTimesFieldKey: "reminderTime",
    quickPromptTemplate: [
      { type: "text", text: "请每天在" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "检查账期；从" },
      { type: "field", fieldKey: "dueDate" },
      { type: "text", text: "开始，每月提醒我支付" },
      { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: "。提醒窗口是" },
      { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: "，" },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "到期当天再提醒一次", falseLabel: "到期当天不重复提醒" },
      { type: "text", text: "。" },
      { type: "text", text: "补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "本期到期日、租金/账单信息、提前天数、是否当天提醒",
    usageGuide: [
      "同一个模板可以开多次：例如房租、水电、车位费分别开启，列表里会显示你填写的账期和备注。",
      "选择本期真实到期日，并填写金额、付款对象和支付方式；此后按月循环，只在提前 N 天和可选的到期当天推送。",
    ],
    automationProtocol: [
      "从用户选择的本期到期日开始按月循环；每月同日到期，若该月没有这一天则使用当月最后一天",
      "每天检查当前日期，计算距离本月或下一个账期还剩多少天",
      "在距离到期 advanceDays 天时提醒；includeDueDay 为是时到期当天再提醒一次，否则当天不重复推送；其他日期只输出 [SILENT]",
      "到达提醒节点时带上用户填写的金额、付款对象、支付方式和备注，不猜测缺失信息",
    ],
    promptIntro: "请提醒我处理本月交租事项。",
    promptStructure: [
      "提示距离到期还有几天",
      "给出本次应付金额和支付备注",
      "严格按用户选择的提前提醒节点推送，其余日期保持静默",
    ],
  }),
  "country-fx-alert": makePack({
    id: "country-fx-alert",
    category: "finance",
    subCategory: "汇率关注",
    name: "汇率到价提醒",
    valueProp: "选择换出和换入币种，到价再提醒",
    description: "按换出币种、换入币种和目标阈值监控汇率，触达条件时提醒",
    frequencyLabel: "每日 10:00",
    schedule: "0 10 * * *",
    durationLabel: "约 1 分钟",
    subscriberCount: 7920,
    rating: 4.8,
    icon: "arrow-left-right",
    featured: true,
    needsRealtime: true,
    notificationPolicy: "only-when-needed",
    fields: fxAutomationFields,
    dailyTimesFieldKey: "reminderTime",
    quickPromptTemplate: [
      { type: "text", text: "请每天在" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "检查" },
      { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: " 到 " },
      { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: " 的汇率；触发条件是 " },
      { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " },
      { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: " 时提醒我。" },
      { type: "text", text: "补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "换出币种、目标币种、触发阈值",
    usageGuide: [
      "分别从下拉框选择换出和换入币种；支持浏览器当前识别的 ISO 4217 币种代码。",
      "涨跌幅按（本次汇率 - 前一自然日同来源参考值）÷ 前一自然日参考值 × 100% 计算；来源未提供可比前日值时不会猜测或触发。",
      "任务只做汇率信息和到价提醒，不给交易建议；适合旅行、留学、跨境采购和收付款结算。",
    ],
    useEntityExtraction: true,
    automationProtocol: [
      "先按 ISO 4217 代码规范化用户下拉选择的换出和换入币种",
      "查询实时汇率时确认币种代码、报价方向和更新时间，避免把反向汇率当成目标汇率",
      "若触发条件是涨跌幅，必须使用同一来源的本次汇率和前一自然日参考值，按（本次 - 前日）/ 前日 × 100% 计算；缺少可比前日值时说明未确认并且不触发",
      "只做价格提醒和原因解释，不给买入、卖出、换汇时机等投资建议",
    ],
    promptIntro: "请查询我关注的货币兑换方向并判断是否触发提醒。",
    promptStructure: [
      "给出换出币种到目标币种的当前汇率与 7 日变化",
      "判断是否触及我设定阈值",
      "按用户选择的触发后动作解释波动或列出需要核对的信息，并保留来源",
    ],
    safetyNote: "仅做汇率信息提醒，不构成投资建议。",
  }),
  "calorie-fitness-checkin": makePack({
    id: "calorie-fitness-checkin",
    category: "health",
    subCategory: "运动作息",
    name: "卡路里与健身记录",
    valueProp: "每天记录饮食、运动和体重趋势",
    description: "每天主动询问饮食、运动、体重和身体感受，按用户选择提供的身高体重等信息做轻量估算和复盘",
    frequencyLabel: "每日 21:30",
    schedule: "30 21 * * *",
    durationLabel: "约 2 分钟",
    subscriberCount: 9650,
    rating: 4.8,
    icon: "activity",
    featured: true,
    dailyTimesFieldKey: "checkinTime",
    fields: calorieFitnessAutomationFields,
    quickPromptTemplate: [
      { type: "text", text: "请每天在" },
      { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: "提醒我记录：" },
      { type: "field", fieldKey: "foodLog" },
      { type: "text", text: "。我的目标是" },
      { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: "，反馈方式：" },
      { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: "。补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "记录时间、目标、饮食运动记录、可选身体数据",
    usageGuide: [
      "身高、体重、目标体重和运动基础均为可选；不填也能先按日记方式记录。",
      "热量和消耗只能做粗略估算，不能替代医生、营养师或教练建议；涉及疾病、孕期、青少年或极端节食时提醒寻求专业意见。",
    ],
    useEntityExtraction: true,
    automationProtocol: [
      "按用户填写的时间主动询问今天吃了什么、喝了什么、运动了什么、体重和身体感受；不要假装已经知道用户记录",
      "如果用户提供身高、体重、目标体重、训练基础或饮食限制，就用于估算和趋势判断；未提供时不要强迫补充",
      "用常识做热量、蛋白质、饮水和运动完成度的轻量估算，并明确这是估算，不把估算热量当成医疗或营养诊断",
      "用户记录不完整时先问缺少的餐次或运动信息；避免评价式、焦虑式表达",
    ],
    promptIntro: "请帮我做今天的饮食和健身记录，并给出轻量复盘。",
    promptStructure: [
      "先询问或整理今天的饮食、运动、体重和身体感受",
      "基于用户提供的身体数据做粗略趋势判断，不输出医疗诊断",
      "给出明天一个最小可执行调整，例如补蛋白、少喝含糖饮料、完成一次散步或力量训练",
    ],
    safetyNote: "热量和运动消耗为粗略估算，不构成医疗、营养或训练处方。",
  }),
  "global-holiday-reminder": makePack({
    id: "global-holiday-reminder",
    category: "content",
    subCategory: "全球节假日",
    name: "节假日与天气",
    valueProp: "同时关注公共假期、目的地天气和官方预警",
    description: "按国家或地区关注公共假期、调休日、目的地天气和官方预警，适合跨境协作、旅行和海外运营排期",
    frequencyLabel: "每日 09:00 检查",
    schedule: "0 9 * * *",
    durationLabel: "约 2 分钟",
    subscriberCount: 6840,
    rating: 4.8,
    icon: "stamp",
    featured: true,
    needsRealtime: true,
    notificationPolicy: "only-when-needed",
    fields: globalHolidayAutomationFields,
    dailyTimesFieldKey: "reminderTime",
    quickPromptTemplate: [
      { type: "text", text: "请每天在" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "持续关注" },
      { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: "的" },
      { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: "，按" },
      { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: "提醒我。" },
      { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: "。" },
      { type: "text", text: "补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "关注国家、假期范围、提醒窗口、可选目的地天气/预警",
    usageGuide: [
      "可以一次订阅多个国家，例如泰国和印尼；任务会分别查询公共假期、调休日和银行假日。",
      "默认持续关注近期假期；有明确旅行、发货或项目周期时，直接在任务要求里写日期范围即可。",
      "需要目的地天气时直接写城市和日期；暴雨、台风、高温等预警会优先核对当地官方或权威天气来源。",
    ],
    useEntityExtraction: true,
    automationProtocol: [
      "先从用户填写内容里整理国家、地区、城市、日期范围、假期类型、天气预报和预警关键词，每个国家或地区分别查询，不混成单一假期表",
      "优先使用政府、使领馆、官方旅游局、银行或权威日历来源核对假期和调休日",
      "如果用户写明指定日期范围，只保留与开始日期到结束日期重叠的假期；持续关注时按滚动窗口查询近期假期",
      "如果用户写了目的地天气、某个日期或未来天数，查询对应地点的天气预报，并把降雨、高温、台风等风险合并到假期提醒里",
      "如果用户写了暴雨、台风、高温、雷电等预警类型和颜色级别，优先核对当地官方气象部门或权威天气来源；无法确认时短说明来源问题",
      "严格按用户写明的提醒窗口判断今天是否为提醒节点；不是提醒节点且无新预警时只输出 [SILENT]",
      "根据假期和天气事实简要提示可能涉及的客户响应、物流、会议、出行或户外安排影响",
    ],
    promptIntro: "请检查我关注国家/地区接下来的公共假期、目的地天气和官方预警，并生成提前提醒。",
    promptStructure: [
      "按国家列出即将到来的假期、日期、是否调休/银行假日和来源",
      "如果用户写了目的地天气，补充日期、地点、天气结论和权威来源",
      "说明假期与天气可能造成的客户响应、物流、会议、出行或户外安排影响",
      "给出下一步提醒建议：是否需要避开会议/发货/出行，或提前准备雨具、防晒、改签等动作",
    ],
  }),
  "stock-info-digest": makePack({
    id: "stock-info-digest",
    category: "finance",
    subCategory: "股票信息",
    name: "股票信息速递",
    valueProp: "整理关注股票价格、公告和财报变化",
    description: "每天整理你关注的 A股、港股、美股公开信息；只做信息速递，不给买卖建议",
    frequencyLabel: "每日 09:00",
    schedule: "0 9 * * *",
    durationLabel: "约 3 分钟",
    subscriberCount: 0,
    rating: 0,
    icon: "wallet",
    featured: true,
    needsRealtime: true,
    notificationPolicy: "always",
    fields: stockInfoAutomationFields,
    dailyTimesFieldKey: "reminderTime",
    quickPromptTemplate: [
      { type: "text", text: "请每天在" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "整理我关注的股票信息：" },
      { type: "field", fieldKey: "stockList" },
      { type: "text", text: "。重点看" },
      { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: "。" },
      { type: "text", text: "补充：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    requiredInfoLabel: "股票名称/代码、市场、关注重点",
    usageGuide: [
      "支持 A股、港股、美股；如果只写公司名，Agent 会尽量匹配常见代码，并标注是否确定。",
      "只整理公开市场信息、公告、财报和新闻，不输出买卖、加仓、减仓等交易建议。",
    ],
    useEntityExtraction: true,
    automationProtocol: [
      "先抽取股票名称、代码和市场；用户只写公司名时尽量匹配常见股票代码，并标注匹配是否确定",
      "优先整理用户关注股票的最新信息，不扩展成泛泛的市场长文",
      "如果数据源无法访问、代码无法确认或不同来源冲突，简短说明，并提示用户核对",
      "只做公开信息整理和风险提示，不输出买入、卖出、加仓、减仓等交易建议",
    ],
    promptIntro: "请整理我关注股票的公开市场信息。",
    promptStructure: [
      "每只股票最多 3-5 行：价格变化、关键事件、需要关注的下一步",
      "涉及财务数据时标注报告期或发布时间",
      "结尾固定加一句：以上仅为公开信息整理，不构成投资建议",
    ],
    safetyNote: "以上仅为公开信息整理，不构成投资建议。",
  }),
} satisfies Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], ScenarioTaskPack>;

export const OVERVIEW_SCENARIO_TASK_PACKS: readonly ScenarioTaskPack[] =
  OVERVIEW_SCENARIO_TASK_IDS.map((id) => OVERVIEW_SCENARIO_TASK_PACK_BY_ID[id]);

type OverviewFieldCopy = Pick<ScenarioTaskField, "label"> &
  Partial<Pick<ScenarioTaskField, "defaultValue" | "placeholder" | "helpText">> & {
    optionLabels?: Record<string, string>;
  };

type OverviewEnglishPackCopy = Pick<
  ScenarioTaskPack,
  "name" | "valueProp" | "description" | "quickPrompt" | "defaultFrequencyLabel"
> & Partial<Pick<
  ScenarioTaskPack,
  "durationLabel" | "defaultDeliverLabel" | "requiredInfoLabel"
>> & {
  quickPromptTemplate: ScenarioQuickPromptPart[];
  usageGuide?: string[];
  fieldDefaults?: Record<string, string>;
  optionLabels?: Record<string, Record<string, string>>;
  fieldCopy?: Record<string, OverviewFieldCopy>;
  safetyNote?: string;
};

const OVERVIEW_ENGLISH_COPY: Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], OverviewEnglishPackCopy> = {
  "medication-once": {
    name: "Water & medication reminders",
    valueProp: "Gentle hydration nudges and medication reminders based on your instructions",
    description: "Keep hydration and medication in one task while medication guidance stays aligned with your prescription or instructions.",
    quickPrompt: "Remind me to drink water and take medication as instructed.",
    defaultFrequencyLabel: "One-time or treatment course",
    quickPromptTemplate: [
      { type: "text", text: "Use a " },
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: " reminder for hydration and medication: " },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: ". " },
      { type: "text", text: "Remind me at ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "Remind me every day at ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "Continue through ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      medicine: "Follow my existing prescription and dosage instructions",
      customRequest: "Keep hydration reminders brief; follow my prescription and any instructions or links I provide for medication",
    },
    optionLabels: {
      reminderMode: {
        "仅这一次": "one-time",
        "按疗程重复": "treatment-course",
        "长期重复": "ongoing",
      },
    },
    safetyNote: "Follow medical advice. This reminder does not provide medication advice.",
  },
  "rent-reminder": {
    name: "Rent reminder",
    valueProp: "Get an advance reminder before rent is due",
    description: "Track your monthly due date and include the amount, recipient, payment method, and notes when the reminder is due.",
    quickPrompt: "Remind me before my monthly rent is due.",
    defaultFrequencyLabel: "Monthly billing reminder",
    quickPromptTemplate: [
      { type: "text", text: "Every day at " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", check the billing cycle. Starting " },
      { type: "field", fieldKey: "dueDate" },
      { type: "text", text: ", remind me every month to pay " },
      { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: ". Remind me " },
      { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: ", and " },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "again on the due date", falseLabel: "do not repeat on the due date" },
      { type: "text", text: ". Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      rentInfo: "rent of 5,000 CNY to my landlord by bank transfer",
      customRequest: "Include utilities, parking fees, payment references, or landlord details if I add them",
    },
    optionLabels: {
      advanceDays: Object.fromEntries(
        Array.from({ length: 31 }, (_, days) => [
          String(days),
          days === 0 ? "on the due date" : `${days} day${days === 1 ? "" : "s"} in advance`,
        ]),
      ),
    },
  },
  "country-fx-alert": {
    name: "Exchange-rate alert",
    valueProp: "Choose a currency pair and get notified when your condition is met",
    description: "Monitor a currency pair against a target rate or daily movement threshold and alert only when the condition is met.",
    quickPrompt: "Monitor my selected currency pair and alert me when the threshold is met.",
    defaultFrequencyLabel: "Daily at 10:00",
    quickPromptTemplate: [
      { type: "text", text: "Every day at " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", check the " },
      { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: " to " },
      { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: " exchange rate every day. Alert me when " },
      { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " },
      { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: ". Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      customRequest: "Use this for travel, study abroad, or cross-border payments and tell me what I should verify",
    },
    optionLabels: {
      thresholdMode: {
        "相较前一自然日同源参考值，涨跌幅达到": "the absolute move from the previous valid same-source reference reaches (%)",
        "当前汇率高于": "the current rate is above",
        "当前汇率低于": "the current rate is below",
      },
    },
    safetyNote: "Exchange-rate information only. This is not investment advice.",
  },
  "calorie-fitness-checkin": {
    name: "Calorie & fitness log",
    valueProp: "Log meals, workouts, and weight trends each day",
    description: "Prompt for meals, exercise, weight, and how you feel, then provide clearly labeled estimates and a lightweight review.",
    quickPrompt: "Help me log today's meals and workouts.",
    defaultFrequencyLabel: "Daily at 21:30",
    quickPromptTemplate: [
      { type: "text", text: "Every day at " },
      { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: ", remind me to log " },
      { type: "field", fieldKey: "foodLog" },
      { type: "text", text: ". My goal is " },
      { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: ". Feedback: " },
      { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: ". Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      foodLog: "what I ate and drank, my exercise, and any weight change",
      fitnessGoal: "lose fat while maintaining strength training",
      customRequest: "Optional body data: height, weight, age, sex, target weight, and training background; ask about missing meals or exercise if my log is incomplete",
    },
    optionLabels: {
      reportStyle: {
        "估算热量 + 给明天一个小调整": "estimate calories and suggest one small adjustment for tomorrow",
        "只做记录和趋势，不评价": "record trends without judging",
        "重点看蛋白质、饮水和运动完成度": "focus on protein, hydration, and workout completion",
      },
    },
    safetyNote: "Calories and activity burn are estimates, not medical, nutrition, or training advice.",
  },
  "global-holiday-reminder": {
    name: "Holidays & weather",
    valueProp: "Track public holidays, destination weather, and official alerts together",
    description: "Follow holidays, adjusted workdays, destination forecasts, and official weather alerts for travel and cross-border planning.",
    quickPrompt: "Track holidays, destination weather, and official alerts for the places I care about.",
    defaultFrequencyLabel: "Daily at 09:00",
    quickPromptTemplate: [
      { type: "text", text: "Every day at " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", keep track of " },
      { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: " for " },
      { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: ". Remind me " },
      { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: ". " },
      { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: ". Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      holidayWeatherPlan: "Also track the next 7 days of weather in Bangkok and Jakarta, plus official heavy-rain, typhoon, and heat alerts",
      customRequest: "Use any travel, shipping, customer, or meeting dates I add to make the reminders relevant",
    },
    optionLabels: {
      holidayScope: {
        "公共假期 + 调休日 + 银行假日": "public holidays, adjusted workdays, and bank holidays",
        "只看法定公共假期": "statutory public holidays only",
        "加上当地大型节庆/交通高峰": "public holidays plus major local festivals",
      },
      reminderWindow: {
        "提前 7 天 + 提前 1 天": "7 days and 1 day in advance",
        "提前 3 天 + 当天早上": "3 days in advance and again that morning",
        "仅在假期当天早上提醒": "on the holiday morning only",
      },
    },
  },
  "stock-info-digest": {
    name: "Stock update digest",
    valueProp: "Summarize prices, announcements, and earnings updates for selected stocks",
    description: "Organize public information for A-shares, Hong Kong stocks, and US stocks without giving trading advice.",
    quickPrompt: "Summarize public market information for the stocks I follow.",
    defaultFrequencyLabel: "Daily at 09:00",
    quickPromptTemplate: [
      { type: "text", text: "Every day at " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", summarize updates for these stocks: " },
      { type: "field", fieldKey: "stockList" },
      { type: "text", text: ". Focus on " },
      { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: ". Notes: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      stockList: "Tencent Holdings 00700, NVIDIA NVDA, Kweichow Moutai 600519",
      stockFocus: "latest price, percentage move, major announcements, earnings updates, and likely public causes of unusual moves",
      customRequest: "Use public information only and do not provide buy, sell, add, or reduce-position advice",
    },
    safetyNote: "Public information only. This is not investment advice.",
  },
};

const OVERVIEW_SPANISH_COPY: Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], OverviewEnglishPackCopy> = {
  "medication-once": {
    name: "Recordatorios de agua y medicación",
    valueProp: "Avisos suaves para hidratarte y tomar la medicación según tus indicaciones",
    description: "Reúne la hidratación y la medicación en una sola tarea, respetando siempre tu receta o las instrucciones que proporciones.",
    quickPrompt: "Recuérdame beber agua y tomar la medicación según las indicaciones.",
    defaultFrequencyLabel: "Una vez o durante el tratamiento",
    durationLabel: "Aprox. 1 minuto",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Tipo de recordatorio, horario de hidratación/medicación, dosis y guía de uso opcional",
    usageGuide: [
      "La hidratación, ponerse de pie o estirar son avisos suaves; la medicación sigue las indicaciones, el prospecto o los enlaces que facilites, sin mezclar las reglas.",
      "Elige una sola vez, durante el tratamiento o de forma continua; el tratamiento se detiene al llegar la fecha final y las tareas continuas se gestionan desde Tareas programadas.",
      "La tarea intentará abrir los enlaces públicos que facilites solo al ejecutarse; si requieren inicio de sesión, pago o verificación, indicará que no puede leerlos.",
      "La tarea no determina si ya tomaste la medicación ni cambia dosis según tus respuestas; sigue siempre las indicaciones médicas.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Usa un recordatorio " },
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: " para la hidratación y la medicación: " },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: ". " },
      { type: "text", text: "Recuérdamelo a las ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "Recuérdamelo cada día a las ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "Continúa hasta el ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      medicine: "Sigue mi receta y las instrucciones de dosis que ya tengo",
      customRequest: "Mantén breves los avisos de hidratación; para la medicación, sigue mi receta y las instrucciones o enlaces que proporcione",
    },
    optionLabels: {
      reminderMode: {
        "仅这一次": "de una sola vez",
        "按疗程重复": "durante el tratamiento",
        "长期重复": "continuo",
      },
    },
    fieldCopy: {
      reminderMode: {
        label: "Tipo de recordatorio",
        helpText: "Durante el tratamiento se detiene tras la fecha final; el modo continuo sigue activo hasta que lo pauses o elimines.",
      },
      triggerAt: {
        label: "Fecha y hora del recordatorio",
        helpText: "Envía un único aviso en este momento.",
      },
      recurringTimes: {
        label: "Horas diarias del recordatorio",
        helpText: "Añade hasta 4 horas concretas; la tarea avisará por separado en cada una.",
      },
      courseEndDate: {
        label: "Fecha de fin del tratamiento",
        placeholder: "Selecciona la fecha de fin del tratamiento",
        helpText: "Empieza el día de activación y deja de enviar avisos cuando termine esta fecha.",
      },
      medicineType: {
        label: "Tipo de medicación",
        optionLabels: {
          "口服药": "Medicación oral",
          "外用药/贴剂": "Medicación tópica o parches",
          "滴眼液/喷剂": "Colirios o aerosoles",
          "术后/临时医嘱": "Indicaciones posoperatorias o temporales",
          "复诊/检查前准备": "Preparación para revisión o prueba",
        },
      },
      medicine: {
        label: "Medicamento y dosis",
        placeholder: "Nombre, dosis, antes/después de comer y precauciones",
      },
      sourceLinks: {
        label: "Enlaces al prospecto o guía de medicación",
        placeholder: "Opcional: pega prospectos, guías del hospital o enlaces del médico, uno por línea",
        helpText: "El Agent prioriza tus fuentes para extraer horarios y precauciones; no sustituye las indicaciones médicas.",
      },
      sourceText: {
        label: "Extractos importantes del prospecto",
        placeholder: "Opcional: pega la posología, contraindicaciones, relación con comidas o instrucciones ante una dosis olvidada",
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: avisar después de comer, levantarse un minuto o recordar la revisión el día anterior",
      },
    },
    safetyNote: "Sigue las indicaciones médicas. Este recordatorio no ofrece asesoramiento sobre medicación.",
  },
  "rent-reminder": {
    name: "Recordatorio del alquiler",
    valueProp: "Recibe un aviso antes del vencimiento del alquiler",
    description: "Controla la fecha de vencimiento mensual e incluye el importe, el destinatario, el método de pago y las notas en el aviso.",
    quickPrompt: "Recuérdame pagar el alquiler antes de su vencimiento mensual.",
    defaultFrequencyLabel: "Recordatorio mensual de pago",
    durationLabel: "Aprox. 1 minuto",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Fecha de vencimiento, datos del alquiler o factura, días de antelación y aviso el mismo día",
    usageGuide: [
      "Puedes activar la plantilla varias veces, por ejemplo para alquiler, suministros y aparcamiento; cada tarea mostrará su ciclo y sus notas.",
      "Indica la fecha real de este vencimiento, el importe, el destinatario y el método de pago; después se repetirá mensualmente y solo avisará con la antelación elegida y, si lo activas, el día de vencimiento.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Cada día a las " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", comprueba el ciclo de pago. A partir del " },
      { type: "field", fieldKey: "dueDate" },
      { type: "text", text: ", recuérdame cada mes pagar " },
      { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: ". Avísame " },
      { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: " y " },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "repite el aviso el día del vencimiento", falseLabel: "no repitas el aviso el día del vencimiento" },
      { type: "text", text: ". Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      rentInfo: "5.000 CNY de alquiler al propietario mediante transferencia bancaria",
      customRequest: "Incluye suministros, aparcamiento, referencias de pago o datos del propietario si los añado",
    },
    optionLabels: {
      advanceDays: Object.fromEntries(
        Array.from({ length: 31 }, (_, days) => [
          String(days),
          days === 0 ? "el día del vencimiento" : `${days} día${days === 1 ? "" : "s"} antes`,
        ]),
      ),
    },
    fieldCopy: {
      reminderTime: {
        label: "Hora del recordatorio",
        helpText: "La tarea comprueba el ciclo a esta hora y solo avisa al entrar en la ventana configurada.",
      },
      dueDate: {
        label: "Fecha de vencimiento actual",
        helpText: "Esta fecha define el ciclo mensual; si un mes no tiene ese día, se usa el último día del mes.",
      },
      rentInfo: {
        label: "Datos del alquiler o factura",
        placeholder: "Por ejemplo: 5.000 CNY de alquiler al propietario mediante transferencia bancaria",
      },
      advanceDays: {
        label: "Días de antelación",
      },
      includeDueDay: {
        label: "Avisar también el día del vencimiento",
        helpText: "Si lo desactivas, solo avisa en la fecha anticipada y no repite el aviso el día de vencimiento.",
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: alias del propietario, referencia de transferencia o suministros incluidos",
      },
    },
  },
  "country-fx-alert": {
    name: "Alerta de tipo de cambio",
    valueProp: "Elige un par de divisas y recibe un aviso cuando se cumpla tu condición",
    description: "Controla un par de divisas según un tipo objetivo o un umbral de variación diaria y avisa solo cuando se cumpla la condición.",
    quickPrompt: "Controla el par de divisas que elija y avísame cuando se alcance el umbral.",
    defaultFrequencyLabel: "Cada día a las 10:00",
    durationLabel: "Aprox. 1 minuto",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Divisa de origen, divisa de destino y umbral de activación",
    usageGuide: [
      "Selecciona las divisas de origen y destino; se admiten los códigos ISO 4217 reconocidos por el navegador.",
      "La variación se calcula con valores comparables de la misma fuente entre el dato actual y la referencia del día natural anterior; si falta una referencia válida, no se estima ni se activa la alerta.",
      "La tarea solo ofrece información y alertas de tipo de cambio, no recomendaciones de inversión; puede usarse para viajes, estudios, compras o pagos internacionales.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Cada día a las " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", comprueba el tipo de cambio de " },
      { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: " a " },
      { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: ". Avísame cuando " },
      { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " },
      { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: ". Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      customRequest: "Úsalo para viajes, estudios en el extranjero o pagos internacionales e indícame qué debo verificar",
    },
    optionLabels: {
      thresholdMode: {
        "相较前一自然日同源参考值，涨跌幅达到": "la variación absoluta frente a la referencia válida del día anterior alcanza (%)",
        "当前汇率高于": "el tipo actual supera",
        "当前汇率低于": "el tipo actual es inferior a",
      },
    },
    fieldCopy: {
      reminderTime: {
        label: "Hora de comprobación",
        helpText: "La tarea consulta el tipo de cambio a esta hora y solo avisa cuando se cumple la condición.",
      },
      fromCurrency: {
        label: "Divisa de origen",
      },
      toCurrency: {
        label: "Divisa de destino",
      },
      thresholdMode: {
        label: "Condición de activación",
      },
      thresholdValue: {
        label: "Valor del umbral",
        placeholder: "Por ejemplo: 1 para una variación del 1 %, o el tipo objetivo",
        helpText: "Con variación porcentual, 1 significa 1 %; con superior/inferior, indica el tipo objetivo del par.",
      },
      actionMode: {
        label: "Acción al activarse",
        optionLabels: {
          "只提醒，不给交易建议": "Solo avisar, sin recomendaciones de inversión",
          "提醒并解释可能原因": "Avisar y explicar posibles causas",
          "提醒并给我需要核对的信息": "Avisar e indicar qué información debo verificar",
        },
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: viaje a Japón, convertir 3.000 CNY cada vez o usar el tipo vendedor del banco",
      },
    },
    safetyNote: "Solo información sobre tipos de cambio. No constituye asesoramiento de inversión.",
  },
  "calorie-fitness-checkin": {
    name: "Registro de calorías y ejercicio",
    valueProp: "Registra cada día comidas, ejercicio y tendencias de peso",
    description: "Solicita datos de comidas, ejercicio, peso y estado físico, y ofrece estimaciones claramente identificadas y un resumen breve.",
    quickPrompt: "Ayúdame a registrar las comidas y el ejercicio de hoy.",
    defaultFrequencyLabel: "Cada día a las 21:30",
    durationLabel: "Aprox. 2 minutos",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Hora de registro, objetivo, alimentación y ejercicio, con datos corporales opcionales",
    usageGuide: [
      "La altura, el peso, el peso objetivo y la experiencia deportiva son opcionales; sin ellos, la tarea puede funcionar como diario.",
      "Las calorías y el gasto son estimaciones aproximadas, no sustituyen a profesionales médicos, de nutrición o entrenamiento; ante enfermedades, embarazo, menores o dietas extremas, se recomienda ayuda profesional.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Cada día a las " },
      { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: ", recuérdame registrar " },
      { type: "field", fieldKey: "foodLog" },
      { type: "text", text: ". Mi objetivo es " },
      { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: ". Comentarios: " },
      { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: ". Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      foodLog: "lo que he comido y bebido, el ejercicio realizado y cualquier cambio de peso",
      fitnessGoal: "perder grasa manteniendo el entrenamiento de fuerza",
      customRequest: "Datos corporales opcionales: altura, peso, edad, sexo, peso objetivo y experiencia de entrenamiento; pregunta por comidas o ejercicio que falten si el registro está incompleto",
    },
    optionLabels: {
      reportStyle: {
        "估算热量 + 给明天一个小调整": "estima las calorías y sugiere un pequeño ajuste para mañana",
        "只做记录和趋势，不评价": "registra las tendencias sin juzgar",
        "重点看蛋白质、饮水和运动完成度": "céntrate en proteínas, hidratación y cumplimiento del ejercicio",
      },
    },
    fieldCopy: {
      checkinTime: {
        label: "Horas de registro",
        helpText: "Configura de 1 a 5 avisos, por ejemplo después del desayuno, después de comer o antes de dormir.",
      },
      fitnessGoal: {
        label: "Objetivo",
        placeholder: "Por ejemplo: perder grasa, ganar músculo, mantener peso, competir o retomar el ejercicio",
      },
      bodyProfile: {
        label: "Datos corporales (opcional)",
        placeholder: "Por ejemplo: 168 cm, 62 kg, objetivo 58 kg y 3 entrenamientos por semana",
        helpText: "Es opcional; solo se usa para estimaciones y tendencias, no para diagnósticos médicos o nutricionales.",
      },
      foodLog: {
        label: "Contenido del registro",
        placeholder: "Por ejemplo: preguntar por comidas, bebidas, ejercicio y peso al final del día",
      },
      reportStyle: {
        label: "Tipo de comentarios",
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: dieta vegetariana, control de azúcar, cenas tardías o comentarios motivadores",
      },
    },
    safetyNote: "Las calorías y el gasto de actividad son estimaciones, no asesoramiento médico, nutricional ni de entrenamiento.",
  },
  "global-holiday-reminder": {
    name: "Festivos y clima",
    valueProp: "Controla juntos los festivos, el clima del destino y las alertas oficiales",
    description: "Sigue festivos, días laborables ajustados, previsiones del destino y alertas meteorológicas oficiales para viajes y planificación internacional.",
    quickPrompt: "Controla los festivos, el clima del destino y las alertas oficiales de los lugares que me interesan.",
    defaultFrequencyLabel: "Cada día a las 09:00",
    durationLabel: "Aprox. 2 minutos",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Países, alcance de festivos, ventana de aviso y clima o alertas opcionales del destino",
    usageGuide: [
      "Puedes seguir varios países a la vez, como Tailandia e Indonesia; la tarea consulta por separado festivos públicos, días ajustados y festivos bancarios.",
      "De forma predeterminada sigue los próximos festivos; si tienes un viaje, envío o proyecto concreto, indica directamente el intervalo de fechas.",
      "Para consultar el clima del destino, indica la ciudad y las fechas; las alertas por lluvia intensa, tifones o calor se contrastan primero con fuentes oficiales o autorizadas.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Cada día a las " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", controla " },
      { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: " para " },
      { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: ". Avísame " },
      { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: ". " },
      { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: ". Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      holidayWeatherPlan: "Controla también el clima de los próximos 7 días en Bangkok y Yakarta, además de las alertas oficiales por lluvias intensas, tifones y calor",
      customRequest: "Usa las fechas de viaje, envío, clientes o reuniones que añada para que los avisos sean relevantes",
    },
    optionLabels: {
      holidayScope: {
        "公共假期 + 调休日 + 银行假日": "festivos públicos, días laborables ajustados y festivos bancarios",
        "只看法定公共假期": "solo festivos públicos oficiales",
        "加上当地大型节庆/交通高峰": "festivos públicos y grandes celebraciones locales",
      },
      reminderWindow: {
        "提前 7 天 + 提前 1 天": "7 días y 1 día antes",
        "提前 3 天 + 当天早上": "3 días antes y de nuevo esa mañana",
        "仅在假期当天早上提醒": "solo la mañana del festivo",
      },
    },
    fieldCopy: {
      reminderTime: {
        label: "Hora de comprobación",
        helpText: "La tarea comprueba a esta hora los festivos, el clima y las alertas.",
      },
      holidayCountries: {
        label: "Países o regiones",
        helpText: "Selecciona varios países o regiones; las opciones elegidas aparecen debajo.",
      },
      holidayScope: {
        label: "Alcance de los festivos",
      },
      reminderWindow: {
        label: "Ventana de aviso",
      },
      periodMode: {
        label: "Periodo de seguimiento",
        optionLabels: {
          "持续关注": "Seguimiento continuo",
          "指定日期范围": "Intervalo de fechas",
        },
      },
      periodStart: {
        label: "Fecha de inicio",
        placeholder: "Selecciona la fecha de inicio",
      },
      periodEnd: {
        label: "Fecha de fin",
        placeholder: "Selecciona la fecha de fin",
      },
      holidayWeatherPlan: {
        label: "Clima y alertas",
        placeholder: "Por ejemplo: clima de Bangkok del 1 al 7 de agosto y alertas oficiales por lluvia; elimina este dato si no necesitas clima",
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: viaje a Bangkok en agosto, calendario con clientes de Indonesia o evitar envíos durante festivos largos",
      },
    },
  },
  "stock-info-digest": {
    name: "Resumen bursátil",
    valueProp: "Resume precios, anuncios y resultados de las acciones seleccionadas",
    description: "Organiza información pública sobre acciones de China continental, Hong Kong y Estados Unidos sin ofrecer recomendaciones de inversión.",
    quickPrompt: "Resume la información pública del mercado sobre las acciones que sigo.",
    defaultFrequencyLabel: "Cada día a las 09:00",
    durationLabel: "Aprox. 3 minutos",
    defaultDeliverLabel: "Web / ejecución reciente",
    requiredInfoLabel: "Nombre o código de las acciones, mercado y aspectos de interés",
    usageGuide: [
      "Admite acciones de China continental, Hong Kong y Estados Unidos; si solo indicas la empresa, el Agent intentará asociar un código habitual y marcará si no es seguro.",
      "Solo organiza información pública del mercado, anuncios, resultados y noticias; no ofrece recomendaciones de compra, venta, aumento o reducción de posiciones.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "Cada día a las " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", resume las novedades de estas acciones: " },
      { type: "field", fieldKey: "stockList" },
      { type: "text", text: ". Céntrate en " },
      { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: ". Notas: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      stockList: "Tencent Holdings 00700, NVIDIA NVDA, Kweichow Moutai 600519",
      stockFocus: "último precio, variación porcentual, anuncios relevantes, resultados y posibles causas públicas de movimientos inusuales",
      customRequest: "Usa solo información pública y no recomiendes comprar, vender, aumentar ni reducir posiciones",
    },
    fieldCopy: {
      reminderTime: {
        label: "Hora del resumen",
        helpText: "La tarea organiza a esta hora la información pública disponible del día.",
      },
      stockList: {
        label: "Acciones seguidas",
        placeholder: "Nombre, código y mercado; también puedes indicar solo la empresa",
      },
      stockFocus: {
        label: "Aspectos de interés",
        placeholder: "Por ejemplo: variación de precio, anuncios, resultados, movimientos inusuales o noticias sectoriales",
      },
      customRequest: {
        label: "Indicaciones adicionales",
        placeholder: "Por ejemplo: solo Hong Kong y Estados Unidos, priorizar resultados o avisar solo cuando haya anuncios",
      },
    },
    safetyNote: "Solo información pública. No constituye asesoramiento de inversión.",
  },
};

const OVERVIEW_KOREAN_GENERATED_COPY: Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], OverviewEnglishPackCopy> = {
  "medication-once": {
    name: "물과 약물 치료의 상기제",
    valueProp: "수분을 섭취하고, 당신의 의사표시에 따라 약을 복용하기 위한 부드러운 경고",
    description: "수분과 약을 한 작업으로 묶어 주며 항상 당신의 처방전이나 당신이 제공하는 지침을 준수하십시오.",
    quickPrompt: "물을 마시고, 지시대로 약을 먹도록 상기시켜 주십시오.",
    defaultFrequencyLabel: "치료 중 한 번 또는 그 동안",
    durationLabel: "1분 정도",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "상기기 유형, 수분/약 복용 시간, 복용량 및 선택적 사용 안내서",
    usageGuide: [
      "수분을 공급하거나, 일어서거나, 길게 뻗는 것은 부드러운 경고입니다. 약은 당신이 제시한 지표, 안내서, 또는 링크를 따르고, 규칙을 섞지 않고 있습니다.",
      "처리 중 또는 연속적으로 한 번만 선택하세요. 처리 기간이 끝나면 처리 종료되며, 연속적인 작업은 자동화에서 관리됩니다.",
      "작업은 실행에 옮기면만 공개 링크를 열려고 노력할 것이고, 로그인, 결제 또는 확인을 필요로 한다면, 읽을 수 없다는 것을 표시할 것입니다.",
      "과제는 이미 약을 복용했는지 여부를 결정하거나 응답에 따라 복용량을 변경하는 것이 아니라 항상 의사의 지시를 따르십시오.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "상기기 사용하세요" },
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: "수분 및 약물치료에 필요한 경우:" },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: ". " },
      { type: "text", text: "기억하세요", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "매일 매일 기억해 주세요", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "계속해", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "참고:" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      medicine: "제 처방과 이미 가지고 있는 복용량 지침을 따르세요",
      customRequest: "수분을 알리는 것을 간략하게 유지하세요. 제 처방전과",
    },
    optionLabels: {
      reminderMode: {
        "仅这一次": "한 번만",
        "按疗程重复": "치료 중에",
        "长期重复": "계속",
      },
    },
    fieldCopy: {
      reminderMode: {
        label: "상기기 유형",
        helpText: "치료 기간은 종료 후 중단되며, 중단 또는 제거할 때까지 계속된 모드가 계속 작동합니다.",
      },
      triggerAt: {
        label: "상기 시점과 날짜",
        helpText: "지금 당장 단 한 번만 통보를 보내세요.",
      },
      recurringTimes: {
        label: "매일의 상기시간",
        helpText: "4시간까지 추가하고, 각 시간마다 별도로 알릴 수 있습니다.",
      },
      courseEndDate: {
        label: "치료 종료 날짜",
        placeholder: "치료 종료 날짜를 선택하세요",
        helpText: "활성화 날 시작하고 이 날짜가 끝나면 알림을 보내지 마세요.",
      },
      medicineType: {
        label: "약물 복용 유형",
        optionLabels: {
          "口服药": "입술의 약",
          "外用药/贴剂": "토픽 약물이나 패치",
          "滴眼液/喷剂": "콜리리 또는 에어로솔",
          "术后/临时医嘱": "수술 후 또는 일시적인 표시",
          "复诊/检查前准备": "검토 또는 시험 준비",
        },
      },
      medicine: {
        label: "약품 및 복용량",
        placeholder: "이름, 복용량, 식사 전/후 및 예방 사항",
      },
      sourceLinks: {
        label: "약물의 안내서 또는 약물의 안내서 링크",
        placeholder: "선택적: 안내서, 병원 안내서 또는 의사 링크를 붙여넣어, 한 줄로",
        helpText: "에이전트는 시간표와 예방 조치를 취하기 위해 여러분의 자료를 우선시하고 의료 지시를 대체하지 않습니다.",
      },
      sourceText: {
        label: "이 부문에서 중요한 단편소",
        placeholder: "선택 사항: 복용량, უკუჩვენებები, 식사와 연관성 또는 잊혀진 복용량에 대한 지침을 붙여넣어",
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어, 식사 후 경고, 잠시 일어나거나 전날의 점검을 상기시켜",
      },
    },
    safetyNote: "의사의 지시를 따르세요. 이 예고서는 약물치료에 대한 조언을 제공하지 않습니다.",
  },
  "rent-reminder": {
    name: "임대기록",
    valueProp: "임대료가 만료되기 전에 알림을 받으세요",
    description: "월화 날짜를 확인하고 통보에 금액, 수신자, 지불 방법 및 메모를 포함합니다.",
    quickPrompt: "월가 정해진 전에 임대료를 지불하라고 상기시켜주십시오.",
    defaultFrequencyLabel: "월간 결제 통보",
    durationLabel: "1분 정도",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "임대일, 임대 또는 청구서 데이터, 그 날 미리 알림 및 알림",
    usageGuide: [
      "예를 들어, 임대, 물품, 주차장 등 여러 번 템플릿을 활성화할 수 있습니다. 각 작업은 주기 및 점수를 표시합니다.",
      "실제 날짜, 금액, 대상자 및 지불 방법 등을 표시하고, 그 다음으로 매달 반복되며 선택된 사전 통지일 뿐이며, 활성화하면 결제일만 표시합니다.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "매일 밤" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", 결제 주기를 확인합니다." },
      { type: "field", fieldKey: "dueDate" },
      { type: "text", text: "매월 지불하라고 상기시켜줘" },
      { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: "- 알리세요" },
      { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: "그리고" },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "그 날 다시 경고하라", falseLabel: "결말날에 경고를 반복하지 말라" },
      { type: "text", text: "." },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      rentInfo: "은행 송금으로 주인에게 5,000만원 규모의 임대",
      customRequest: "물품, 주차장, 지불 통지 또는 소유자의 데이터를 추가하면 포함됩니다.",
    },
    optionLabels: {
      advanceDays: Object.fromEntries(
        Array.from({ length: 31 }, (_, days) => [
          String(days),
          days === 0 ? "결속일" : `${days} día${days === 1 ? "" : "s"} antes`,
        ]),
      ),
    },
    fieldCopy: {
      reminderTime: {
        label: "상기 시기는",
        helpText: "이 작업은 이 시간에 순환을 확인하고 설정된 창에 들어가면 알릴 것입니다.",
      },
      dueDate: {
        label: "현재 유효기간",
        helpText: "이 날짜는 월순환을 정의합니다. 달이 그 날을 가지고 있지 않다면, 달의 마지막 날입니다.",
      },
      rentInfo: {
        label: "임대 또는 청구서 데이터",
        placeholder: "예를 들어, 은행 송금으로 주인에게 5,000만원 규모의 임대",
      },
      advanceDays: {
        label: "사전에 몇일",
      },
      includeDueDay: {
        label: "또한 결말일을 알리는",
        helpText: "만약 당신이 그것을 비활성화한다면, 미리 알리고, 그 날에는 다시 알리지 마십시오.",
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어: 소유자의 일명, 전송 참조 또는 공급이 포함된",
      },
    },
  },
  "country-fx-alert": {
    name: "환율 경보",
    valueProp: "몇 개의 화폐를 선택하고 조건이 충족되면 알림을 받게됩니다.",
    description: "목표형 또는 매일 변동률에 따라 통화쌍을 통제하고 조건이 충족되면만 통보합니다.",
    quickPrompt: "당신이 선택한 통화쌍을 확인하고, 그 열을 도달하면 알려주세요.",
    defaultFrequencyLabel: "매일 10시",
    durationLabel: "1분 정도",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "출산과 목적지 통화 및 활성화 열대",
    usageGuide: [
      "출처와 목적지 화폐를 선택하고 브라우저에서 인정된 ISO 4217 코드가 지원됩니다.",
      "변이는 현재 데이터와 이전 천연일 기준 사이의 같은 소스의 비교값으로 계산되며 유효한 기준이 없으면 추정되지 않으며 경고가 활성화되지 않습니다.",
      "이 작업은 환율 정보와 경고만을 제공하지만 투자 추천은 제공하지 않습니다. 여행, 연구, 쇼핑 또는 국제 결제에서 사용할 수 있습니다.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "매일 밤" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", 의 환율을 확인합니다" },
      { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: "a" },
      { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: "언제인지 알려줘" },
      { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " },
      { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: "." },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      customRequest: "여행이나 해외연수나 국제 결제 등에 사용해서 확인해야 할 것을 알려주세요",
    },
    optionLabels: {
      thresholdMode: {
        "相较前一自然日同源参考值，涨跌幅达到": "전날의 유효한 기준에 대한 절대적인 변수는 (%)",
        "当前汇率高于": "현재는",
        "当前汇率低于": "현재는",
      },
    },
    fieldCopy: {
      reminderTime: {
        label: "확인 시간",
        helpText: "이 작업은 이 시간에 환율을 확인하고 조건이 충족되면만 알립니다.",
      },
      fromCurrency: {
        label: "출처 통화",
      },
      toCurrency: {
        label: "목적지 통화는",
      },
      thresholdMode: {
        label: "활성화 조건",
      },
      thresholdValue: {
        label: "그라운드 값",
        placeholder: "예를 들어: 1%의 변동에 대해 1 또는 목표형",
        helpText: "비율 변수에서 1은 1%이고, 상위/하위에서 이쌍의 목표 유형을 나타냅니다.",
      },
      actionMode: {
        label: "활성화 시행",
        optionLabels: {
          "只提醒，不给交易建议": "투자 추천 없이 경고만",
          "提醒并解释可能原因": "가능한 원인을 알리고 설명하는",
          "提醒并给我需要核对的信息": "어떤 정보를 확인해야 하는지 알려주고",
        },
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어 일본으로 여행을 하거나 한 번에 3,000조원을 전환하거나 은행의 판매자를 사용하거나",
      },
    },
    safetyNote: "환율 정보만요, 투자 자문도 아닙니다.",
  },
  "calorie-fitness-checkin": {
    name: "칼로리 기록과 운동",
    valueProp: "매일 식사, 운동, 체중 트렌드를 기록합니다",
    description: "식사, 운동, 체중, 체력 데이터를 요청하고 명확하게 식별된 추정과 짧은 요약을 제공합니다.",
    quickPrompt: "오늘 식사와 운동을 기록하는 데 도움이 되세요",
    defaultFrequencyLabel: "매일 9시 30분",
    durationLabel: "약 2분",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "선택적 신체 데이터를 가진 기록 시간, 목표, 먹거리 및 운동",
    usageGuide: [
      "키, 체중, 목표물 무게, 스포츠 경험은 선택 사항입니다. 이것 없이는 작업은 일상의 방식으로 작동 할 수 있습니다.",
      "칼로리와 지출은 대략적인 추정치이며, 의료, 영양 및 훈련 전문가의 대상이 아닙니다. 질병, 임신, 청소년 또는 극단적인 식단에서 전문적인 도움이 좋습니다.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "매일 밤" },
      { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: ", 기록해 주세요" },
      { type: "field", fieldKey: "foodLog" },
      { type: "text", text: "- 제 목표는" },
      { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: ". 댓글:" },
      { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: "." },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      foodLog: "제가 먹거나 마시는 것, 제가 운동한 것, 그리고 체중의 변화",
      fitnessGoal: "체력 훈련을 통해 지방을 잃게 됩니다.",
      customRequest: "선택적 신체 데이터는: 키, 체중, 나이, 성별, 목표 체중 및 훈련 경험; 기록이 불완전하다면 부족한 식사 또는 운동에 대한 질문",
    },
    optionLabels: {
      reportStyle: {
        "估算热量 + 给明天一个小调整": "칼로리를 계산하고 내일의 작은 조정을 제안합니다.",
        "只做记录和趋势，不评价": "추세를 판단하지 않고 기록합니다.",
        "重点看蛋白质、饮水和运动完成度": "단백질, 수분, 운동에 집중하세요",
      },
    },
    fieldCopy: {
      checkinTime: {
        label: "등록시간",
        helpText: "1~5개의 경고를 설정하세요. 예를 들어, 아침 식사 후, 식사 후, 또는 잠들기 전에 말이죠.",
      },
      fitnessGoal: {
        label: "목표",
        placeholder: "예를 들어: 지방을 잃거나 근육을 얻거나 체중을 유지하거나, 경쟁하거나, 다시 운동을 시작하십시오.",
      },
      bodyProfile: {
        label: "신체 데이터 (선택)",
        placeholder: "예를 들어: 168cm, 62kg, 58kg의 목표, 일주일에 3번 훈련",
        helpText: "선택적입니다. 추정과 추세에만 사용됩니다. 의학이나 영양 진단에 사용되지 않습니다.",
      },
      foodLog: {
        label: "등록 내용",
        placeholder: "예를 들어, 식사, 음료, 운동, 그리고 하루가 끝날 때 체중에 대해 물어보세요.",
      },
      reportStyle: {
        label: "댓글의 종류",
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어 채식주의 식단, 설탕 조절, 늦은 저녁 식사, 동기부여 의견",
      },
    },
    safetyNote: "칼로리와 운동 지출은 추정치입니다. 의료, 영양, 훈련의 조언이 아닙니다.",
  },
  "global-holiday-reminder": {
    name: "축제와 날씨",
    valueProp: "함께 축제, 운명 날씨, 공식 알림 등을 통제합니다",
    description: "휴일, 일일 정규, 목적지 예측 및 국제 여행 및 계획에 대한 공식 기상 경보가 계속됩니다.",
    quickPrompt: "제 관심 있는 장소의 공무원 경보와 명절, 기상 등을 통제합니다.",
    defaultFrequencyLabel: "매일 9시",
    durationLabel: "약 2분",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "국가, 휴가 기간, 경고 창 및 날씨 또는 선택적 목적지 알림",
    usageGuide: [
      "태국과 인도네시아와 같은 여러 나라를 동시에 추적할 수 있습니다. 공휴일, 일정한 날, 은행의 휴일을 별도로 확인하는 작업입니다.",
      "기본적으로 다음의 축제를 따라가며, 여행이나 배송 또는 특정 프로젝트를 가지고 있다면 날짜 간격을 직접 표시하십시오.",
      "목적지의 날씨를 확인하려면 도시와 날짜를 표시하고 강수, 태풍 또는 열에 대한 경고는 먼저 공식 또는 허가된 소스로 대조됩니다.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "매일 밤" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", 통제합니다" },
      { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: " para " },
      { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: "- 알리세요" },
      { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: ". " },
      { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: "." },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      holidayWeatherPlan: "또한 방콕과 자카르타에서 7일간의 기상과 함께 강수, 태풍, 열에 대한 공식 경보도 확인합니다.",
      customRequest: "통지사항을 관련성 있게 하기 위해 추가한 여행, 배송, 고객 또는 회의 날짜를 사용하세요",
    },
    optionLabels: {
      holidayScope: {
        "公共假期 + 调休日 + 银行假日": "공휴일, 일일 정규 및 은행휴일",
        "只看法定公共假期": "공적인 공휴일만",
        "加上当地大型节庆/交通高峰": "공중 축제와 큰 지역 기념식",
      },
      reminderWindow: {
        "提前 7 天 + 提前 1 天": "7일 1일 전",
        "提前 3 天 + 当天早上": "3일 전과 그 아침 다시",
        "仅在假期当天早上提醒": "축제 아침일 뿐",
      },
    },
    fieldCopy: {
      reminderTime: {
        label: "확인 시간",
        helpText: "숙제는 지금부터 휴일, 날씨, 경보를 확인합니다.",
      },
      holidayCountries: {
        label: "국가 또는 지역",
        helpText: "여러 국가나 지역을 선택하고, 선택된 옵션은 아래에서 표시됩니다.",
      },
      holidayScope: {
        label: "축제의 범위",
      },
      reminderWindow: {
        label: "경고 창",
      },
      periodMode: {
        label: "추적 기간",
        optionLabels: {
          "持续关注": "지속적인 추적",
          "指定日期范围": "날짜 간격",
        },
      },
      periodStart: {
        label: "시작 날짜",
        placeholder: "시작 날짜를 선택",
      },
      periodEnd: {
        label: "종료 날짜",
        placeholder: "종료 날짜를 선택",
      },
      holidayWeatherPlan: {
        label: "기후와 경고",
        placeholder: "예를 들어 8월 1일부터 7일까지 방콕의 날씨와 공식적인 비가 오는 경고를 삭제합니다. 날씨가 필요하지 않으면 데이터를 삭제합니다.",
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어, 8월에 방콕으로 여행하거나 인도네시아 고객들과 일정을 나눌 수 있고, 긴 휴가 기간 동안 배송을 피할 수 있습니다.",
      },
    },
  },
  "stock-info-digest": {
    name: "거래소 요약",
    valueProp: "선택된 주식 가격, 발표 및 성과 요약",
    description: "중국 본토, 홍콩, 미국 주식회사들에 대한 공공 정보를 제공하지만 투자 추천을 하지 않습니다.",
    quickPrompt: "제가 추구하는 주식들에 대한 시장의 공공 정보를 요약합니다.",
    defaultFrequencyLabel: "매일 9시",
    durationLabel: "약 3분",
    defaultDeliverLabel: "웹 / 최근 실행",
    requiredInfoLabel: "주식 이름 또는 코드, 시장 및 관심 사항",
    usageGuide: [
      "중국 본토, 홍콩, 미국 주식을 인정하고, 회사를 표시하면 에이전트가 일반적인 코드를 연결하려고 노력하고 안전하지 않은지 표시합니다.",
      "시장 정보, 광고, 결과 및 뉴스만 공개하고 있으며, 구매, 판매, 승화 또는 저하의 추천을 하지 않습니다.",
    ],
    quickPromptTemplate: [
      { type: "text", text: "매일 밤" },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", 이 같은 행동의 신화를 요약합니다:" },
      { type: "field", fieldKey: "stockList" },
      { type: "text", text: "집중해 보세요" },
      { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: "." },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      stockList: "텐센트 홀딩스 00700, NVIDIA NVDA, Kweichow Moutai 600519",
      stockFocus: "마지막 가격, 비율 변동, 관련 발표, 결과 및 비정상적인 이동의 가능한 공공 원인은",
      customRequest: "공개적인 정보를 사용해서 구매, 판매, 증대, 감소할 것을 권장하지 않습니다.",
    },
    fieldCopy: {
      reminderTime: {
        label: "요약 시간",
        helpText: "이 시간에는 공중적으로 사용할 수 있는 정보들을 정리합니다.",
      },
      stockList: {
        label: "계속되는 행위",
        placeholder: "이름, 코드, 시장; 또한 회사만 표시할 수 있습니다",
      },
      stockFocus: {
        label: "관심의 사항",
        placeholder: "예를 들어: 가격 변화, 발표, 결과, 특이한 움직임 또는 산업 뉴스",
      },
      customRequest: {
        label: "추가적인 지표",
        placeholder: "예를 들어, 홍콩과 미국만, 결과를 우선시하거나 발표가 있을 때만 알리는",
      },
    },
    safetyNote: "공공 정보만 제공해주는 것이 아니라 투자 자문입니다.",
  },
};

const OVERVIEW_INDONESIAN_COPY: Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], OverviewEnglishPackCopy> = {
  "medication-once": {
    name: "Pengingat minum air & obat",
    valueProp: "Pengingat ringan untuk minum air dan obat sesuai instruksi Anda",
    description: "Gabungkan pengingat minum air dan obat dalam satu tugas, dengan aturan obat tetap mengikuti resep atau instruksi yang Anda berikan.",
    quickPrompt: "Ingatkan saya untuk minum air dan minum obat sesuai instruksi.",
    defaultFrequencyLabel: "Sekali saja atau sesuai masa pengobatan",
    quickPromptTemplate: [
      { type: "text", text: "Gunakan mode pengingat " },
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: " untuk minum air dan obat: " },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: ". " },
      { type: "text", text: "Ingatkan saya pada ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "Ingatkan setiap hari pada ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "Lanjutkan sampai ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: ". ", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      medicine: "Ikuti resep dan instruksi dosis yang sudah saya miliki",
      customRequest: "Buat pengingat minum air tetap singkat; untuk obat, ikuti resep serta instruksi atau tautan yang saya berikan",
    },
    optionLabels: {
      reminderMode: {
        "仅这一次": "sekali saja",
        "按疗程重复": "sesuai masa pengobatan",
        "长期重复": "berulang jangka panjang",
      },
    },
    safetyNote: "Ikuti anjuran medis. Pengingat ini bukan saran penggunaan obat.",
  },
  "rent-reminder": {
    name: "Pengingat sewa",
    valueProp: "Dapatkan pengingat sebelum jatuh tempo sewa",
    description: "Pantau tanggal jatuh tempo bulanan, beserta jumlah, penerima, metode pembayaran, dan catatan saat pengingat dikirim.",
    quickPrompt: "Ingatkan saya sebelum sewa bulanan jatuh tempo.",
    defaultFrequencyLabel: "Pengingat tagihan bulanan",
    quickPromptTemplate: [
      { type: "text", text: "Setiap hari pada " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", periksa siklus tagihan. Mulai " },
      { type: "field", fieldKey: "dueDate" },
      { type: "text", text: ", ingatkan saya setiap bulan untuk membayar " },
      { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: ". Ingatkan " },
      { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: ", dan " },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "ingatkan lagi pada tanggal jatuh tempo", falseLabel: "jangan ulangi pada tanggal jatuh tempo" },
      { type: "text", text: ". Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      rentInfo: "sewa 5.000 CNY ke pemilik rumah melalui transfer bank",
      customRequest: "Tambahkan utilitas, parkir, referensi pembayaran, atau detail pemilik rumah jika saya mengisinya",
    },
    optionLabels: {
      advanceDays: Object.fromEntries(
        Array.from({ length: 31 }, (_, days) => [
          String(days),
          days === 0 ? "pada tanggal jatuh tempo" : `${days} hari sebelumnya`,
        ]),
      ),
    },
  },
  "country-fx-alert": {
    name: "Pengingat kurs target",
    valueProp: "Pilih pasangan mata uang dan dapatkan notifikasi saat kondisi terpenuhi",
    description: "Pantau pasangan mata uang berdasarkan kurs target atau ambang perubahan harian, lalu kirim notifikasi hanya saat kondisi terpenuhi.",
    quickPrompt: "Pantau pasangan mata uang pilihan saya dan beri tahu saat ambang tercapai.",
    defaultFrequencyLabel: "Setiap hari pukul 10:00",
    quickPromptTemplate: [
      { type: "text", text: "Setiap hari pada " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", periksa kurs " },
      { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: " ke " },
      { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: ". Beri tahu saya saat " },
      { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " },
      { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: ". Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      customRequest: "Gunakan untuk perjalanan, studi luar negeri, atau pembayaran lintas negara, dan beri tahu hal yang perlu saya cek",
    },
    optionLabels: {
      thresholdMode: {
        "相较前一自然日同源参考值，涨跌幅达到": "perubahan absolut dari referensi valid hari sebelumnya mencapai (%)",
        "当前汇率高于": "kurs saat ini lebih tinggi dari",
        "当前汇率低于": "kurs saat ini lebih rendah dari",
      },
    },
    safetyNote: "Informasi kurs saja. Ini bukan saran investasi.",
  },
  "calorie-fitness-checkin": {
    name: "Catatan kalori & kebugaran",
    valueProp: "Catat makanan, olahraga, dan tren berat badan setiap hari",
    description: "Minta catatan makan, olahraga, berat badan, dan kondisi tubuh, lalu berikan estimasi yang jelas serta ringkasan ringan.",
    quickPrompt: "Bantu saya mencatat makanan dan olahraga hari ini.",
    defaultFrequencyLabel: "Setiap hari pukul 21:30",
    quickPromptTemplate: [
      { type: "text", text: "Setiap hari pada " },
      { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: ", ingatkan saya untuk mencatat " },
      { type: "field", fieldKey: "foodLog" },
      { type: "text", text: ". Target saya adalah " },
      { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: ". Gaya masukan: " },
      { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: ". Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      foodLog: "apa yang saya makan dan minum, olahraga saya, serta perubahan berat badan",
      fitnessGoal: "mengurangi lemak sambil tetap latihan kekuatan",
      customRequest: "Data tubuh opsional: tinggi, berat, usia, jenis kelamin, target berat, dan latar latihan; tanyakan bagian yang kurang jika catatan saya belum lengkap",
    },
    optionLabels: {
      reportStyle: {
        "估算热量 + 给明天一个小调整": "estimasi kalori dan sarankan satu penyesuaian kecil untuk besok",
        "只做记录和趋势，不评价": "catat tren tanpa menghakimi",
        "重点看蛋白质、饮水和运动完成度": "fokus pada protein, hidrasi, dan penyelesaian olahraga",
      },
    },
    safetyNote: "Kalori dan pembakaran aktivitas adalah estimasi, bukan saran medis, nutrisi, atau latihan.",
  },
  "global-holiday-reminder": {
    name: "Hari libur & cuaca",
    valueProp: "Pantau hari libur publik, cuaca tujuan, dan peringatan resmi sekaligus",
    description: "Ikuti hari libur, hari kerja pengganti, prakiraan cuaca tujuan, dan peringatan cuaca resmi untuk perjalanan dan perencanaan lintas negara.",
    quickPrompt: "Pantau hari libur, cuaca tujuan, dan peringatan resmi untuk tempat yang saya perhatikan.",
    defaultFrequencyLabel: "Setiap hari pukul 09:00",
    quickPromptTemplate: [
      { type: "text", text: "Setiap hari pada " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", pantau " },
      { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: " untuk " },
      { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: ". Ingatkan saya " },
      { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: ". " },
      { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: ". Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      holidayWeatherPlan: "Pantau juga cuaca 7 hari ke depan di Bangkok dan Jakarta, plus peringatan resmi untuk hujan lebat, topan, dan panas ekstrem",
      customRequest: "Gunakan tanggal perjalanan, pengiriman, pelanggan, atau rapat yang saya tambahkan agar pengingat lebih relevan",
    },
    optionLabels: {
      holidayScope: {
        "公共假期 + 调休日 + 银行假日": "hari libur publik, hari kerja pengganti, dan hari libur bank",
        "只看法定公共假期": "hanya hari libur publik resmi",
        "加上当地大型节庆/交通高峰": "hari libur publik plus festival besar lokal",
      },
      reminderWindow: {
        "提前 7 天 + 提前 1 天": "7 hari dan 1 hari sebelumnya",
        "提前 3 天 + 当天早上": "3 hari sebelumnya dan pagi hari H",
        "仅在假期当天早上提醒": "hanya pagi hari saat libur",
      },
    },
  },
  "stock-info-digest": {
    name: "Ringkasan info saham",
    valueProp: "Ringkas harga, pengumuman, dan pembaruan laporan untuk saham pilihan",
    description: "Susun informasi publik untuk saham A-share, Hong Kong, dan AS tanpa memberi saran transaksi.",
    quickPrompt: "Ringkas informasi pasar publik untuk saham yang saya pantau.",
    defaultFrequencyLabel: "Setiap hari pukul 09:00",
    quickPromptTemplate: [
      { type: "text", text: "Setiap hari pada " },
      { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: ", ringkas pembaruan untuk saham berikut: " },
      { type: "field", fieldKey: "stockList" },
      { type: "text", text: ". Fokus pada " },
      { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: ". Catatan: " },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "." },
    ],
    fieldDefaults: {
      stockList: "Tencent Holdings 00700, NVIDIA NVDA, Kweichow Moutai 600519",
      stockFocus: "harga terbaru, persentase perubahan, pengumuman penting, pembaruan laporan, dan kemungkinan penyebab publik dari pergerakan tidak biasa",
      customRequest: "Gunakan informasi publik saja dan jangan memberi saran beli, jual, tambah, atau kurangi posisi",
    },
    safetyNote: "Informasi publik saja. Ini bukan saran investasi.",
  },
};

const OVERVIEW_JAPANESE_COPY: Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], OverviewEnglishPackCopy> = {
  "medication-once": {
    name: "水分補給・服薬リマインダー",
    valueProp: "指定した内容に沿って、水分補給と服薬をやさしくお知らせ",
    description: "水分補給と服薬を一つのタスクで管理し、服薬内容は処方や入力した指示に従います。",
    quickPrompt: "指示に沿って、水分補給と服薬を知らせてください。",
    defaultFrequencyLabel: "1回のみ、または服用期間中",
    durationLabel: "約1分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "リマインダー形式、時刻、薬と用量、必要に応じて参考情報",
    usageGuide: [
      "水分補給やストレッチは軽い通知として扱い、服薬は入力した処方・説明書・参考リンクに従います。",
      "1回のみ、服用期間中、継続のいずれかを選べます。服用期間中は終了日を過ぎると停止します。",
      "服薬済みかどうかの診断や用量の変更は行いません。必ず医療専門家の指示を優先してください。",
    ],
    quickPromptTemplate: [
      { type: "field", fieldKey: "reminderMode" },
      { type: "text", text: "のリマインダーで、水分補給と服薬を知らせてください。内容：" },
      { type: "field", fieldKey: "medicine" },
      { type: "text", text: "。" },
      { type: "text", text: "通知日時は", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "field", fieldKey: "triggerAt" },
      { type: "text", text: "。", visibleWhen: { fieldKey: "reminderMode", values: ["仅这一次"] } },
      { type: "text", text: "毎日の通知時刻は", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "field", fieldKey: "recurringTimes" },
      { type: "text", text: "。", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复", "长期重复"] } },
      { type: "text", text: "終了日は", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "field", fieldKey: "courseEndDate" },
      { type: "text", text: "。", visibleWhen: { fieldKey: "reminderMode", values: ["按疗程重复"] } },
      { type: "text", text: "補足：" },
      { type: "field", fieldKey: "customRequest" },
      { type: "text", text: "。" },
    ],
    fieldDefaults: {
      medicine: "現在の処方と用量の指示に従う",
      customRequest: "水分補給の通知は短くし、服薬は入力した処方、説明、リンクに従う",
    },
    optionLabels: {
      reminderMode: { "仅这一次": "1回のみ", "按疗程重复": "服用期間中", "长期重复": "継続" },
    },
    fieldCopy: {
      reminderMode: { label: "リマインダー形式", helpText: "服用期間中は終了日まで、継続は一時停止または削除するまで有効です。" },
      triggerAt: { label: "通知日時", helpText: "指定した日時に1回だけ通知します。" },
      recurringTimes: { label: "毎日の通知時刻", helpText: "最大4つまで指定でき、それぞれの時刻に通知します。" },
      courseEndDate: { label: "服用終了日", placeholder: "服用終了日を選択", helpText: "有効化した日から、この日の終了まで通知します。" },
      medicineType: {
        label: "薬の種類",
        optionLabels: {
          "口服药": "内服薬", "外用药/贴剂": "外用薬・貼付薬", "滴眼液/喷剂": "点眼薬・スプレー",
          "术后/临时医嘱": "術後・一時的な指示", "复诊/检查前准备": "再診・検査前の準備",
        },
      },
      medicine: { label: "薬と用量", placeholder: "薬の名前、用量、食前・食後、注意事項" },
      sourceLinks: { label: "説明書・服薬ガイドのリンク", placeholder: "任意：説明書、病院の案内、医師からのリンクを1行ずつ入力", helpText: "入力した情報源を優先しますが、医療専門家の指示には代わりません。" },
      sourceText: { label: "説明書の重要な抜粋", placeholder: "任意：用法、禁忌、食事との関係、飲み忘れ時の対応など" },
      customRequest: { label: "追加の要望", placeholder: "例：食後に通知する、1分立ち上がる、再診の前日に知らせる" },
    },
    safetyNote: "医療専門家の指示に従ってください。このリマインダーは服薬に関する助言を行いません。",
  },
  "rent-reminder": {
    name: "家賃リマインダー",
    valueProp: "家賃の支払期限より前に通知を受け取る",
    description: "毎月の支払日を確認し、金額、支払先、支払方法、補足をリマインダーに含めます。",
    quickPrompt: "毎月の家賃支払期限より前に知らせてください。",
    defaultFrequencyLabel: "毎月の支払い通知",
    durationLabel: "約1分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "支払日、家賃・請求内容、事前通知日数、当日の再通知",
    usageGuide: [
      "家賃、光熱費、駐車場代など、用途ごとにこのテンプレートを複数作成できます。",
      "現在の支払日、金額、支払先、支払方法を入力すると、選んだ日数前と必要に応じて当日に通知します。",
    ],
    quickPromptTemplate: [
      { type: "text", text: "毎日" }, { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "に支払い周期を確認してください。" }, { type: "field", fieldKey: "dueDate" },
      { type: "text", text: "から毎月、次の支払いを知らせてください：" }, { type: "field", fieldKey: "rentInfo" },
      { type: "text", text: "。通知は" }, { type: "field", fieldKey: "advanceDays" },
      { type: "text", text: "、支払日当日は" },
      { type: "field", fieldKey: "includeDueDay", trueLabel: "もう一度通知する", falseLabel: "再通知しない" },
      { type: "text", text: "。補足：" }, { type: "field", fieldKey: "customRequest" }, { type: "text", text: "。" },
    ],
    fieldDefaults: {
      rentInfo: "家主へ家賃5,000 CNYを銀行振込で支払う",
      customRequest: "入力した場合は、光熱費、駐車場代、振込番号、家主の情報も含める",
    },
    optionLabels: {
      advanceDays: Object.fromEntries(Array.from({ length: 31 }, (_, days) => [String(days), days === 0 ? "支払日当日" : `${days}日前`])),
    },
    fieldCopy: {
      reminderTime: { label: "確認時刻", helpText: "毎日この時刻に周期を確認し、設定した通知期間に入った場合だけ知らせます。" },
      dueDate: { label: "現在の支払日", helpText: "この日付を基準に毎月繰り返します。その日がない月は月末を使います。" },
      rentInfo: { label: "支払い内容", placeholder: "例：家主へ家賃5,000 CNYを銀行振込で支払う" },
      advanceDays: { label: "何日前に知らせるか" },
      includeDueDay: { label: "支払日当日も通知", helpText: "オフの場合は事前通知のみで、当日は繰り返しません。" },
      customRequest: { label: "追加の要望", placeholder: "例：家主の口座名、振込番号、含まれる光熱費" },
    },
  },
  "country-fx-alert": {
    name: "為替レートアラート",
    valueProp: "通貨ペアを選び、指定条件に達したときだけ通知",
    description: "目標レートまたは前日比のしきい値で通貨ペアを監視し、条件を満たした場合に通知します。",
    quickPrompt: "選んだ通貨ペアを監視し、しきい値に達したら知らせてください。",
    defaultFrequencyLabel: "毎日10:00",
    durationLabel: "約1分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "基準通貨、対象通貨、通知条件",
    usageGuide: [
      "基準通貨と対象通貨を選び、目標レートまたは前日比の条件を設定します。",
      "為替情報と通知のみを提供し、投資判断の助言は行いません。旅行、留学、海外送金などに利用できます。",
    ],
    quickPromptTemplate: [
      { type: "text", text: "毎日" }, { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "に" }, { type: "field", fieldKey: "fromCurrency" },
      { type: "text", text: "から" }, { type: "field", fieldKey: "toCurrency" },
      { type: "text", text: "への為替レートを確認し、" }, { type: "field", fieldKey: "thresholdMode" },
      { type: "text", text: " " }, { type: "field", fieldKey: "thresholdValue" },
      { type: "text", text: "になったら知らせてください。補足：" }, { type: "field", fieldKey: "customRequest" }, { type: "text", text: "。" },
    ],
    fieldDefaults: { customRequest: "旅行、留学、海外送金に使い、確認すべき点も知らせる" },
    optionLabels: {
      thresholdMode: {
        "相较前一自然日同源参考值，涨跌幅达到": "前日の同一情報源の有効値からの変動率が（%）に達する",
        "当前汇率高于": "現在のレートが次を上回る",
        "当前汇率低于": "現在のレートが次を下回る",
      },
    },
    fieldCopy: {
      reminderTime: { label: "確認時刻", helpText: "この時刻に為替レートを確認し、条件を満たした場合だけ通知します。" },
      fromCurrency: { label: "基準通貨" },
      toCurrency: { label: "対象通貨" },
      thresholdMode: { label: "通知条件" },
      thresholdValue: { label: "しきい値", placeholder: "例：1%の変動なら1、または目標レート", helpText: "変動率では1が1%を表し、上回る・下回る条件では目標レートを入力します。" },
      actionMode: {
        label: "条件成立時の動作",
        optionLabels: {
          "只提醒，不给交易建议": "通知のみ（投資助言なし）",
          "提醒并解释可能原因": "通知して、考えられる理由も説明",
          "提醒并给我需要核对的信息": "通知して、確認すべき情報も提示",
        },
      },
      customRequest: { label: "追加の要望", placeholder: "例：日本旅行用、毎回3,000 CNYを両替、銀行の売値を参照" },
    },
    safetyNote: "為替レート情報のみを提供します。投資助言ではありません。",
  },
  "calorie-fitness-checkin": {
    name: "カロリー・運動記録",
    valueProp: "食事、運動、体重の変化を毎日記録",
    description: "食事、運動、体重、体調を確認し、推定値であることを明示した簡潔な振り返りを作ります。",
    quickPrompt: "今日の食事と運動を記録するのを手伝ってください。",
    defaultFrequencyLabel: "毎日21:30",
    durationLabel: "約2分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "記録時刻、目標、食事・運動内容、任意の身体情報",
    usageGuide: [
      "身長、体重、目標体重、運動経験は任意です。入力しなくても日記として利用できます。",
      "カロリーや消費量は概算であり、医療・栄養・トレーニングの専門的助言には代わりません。",
    ],
    quickPromptTemplate: [
      { type: "text", text: "毎日" }, { type: "field", fieldKey: "checkinTime" },
      { type: "text", text: "に次の内容を記録するよう知らせてください：" }, { type: "field", fieldKey: "foodLog" },
      { type: "text", text: "。目標：" }, { type: "field", fieldKey: "fitnessGoal" },
      { type: "text", text: "。フィードバック：" }, { type: "field", fieldKey: "reportStyle" },
      { type: "text", text: "。補足：" }, { type: "field", fieldKey: "customRequest" }, { type: "text", text: "。" },
    ],
    fieldDefaults: {
      foodLog: "食べた物と飲み物、運動、体重の変化",
      fitnessGoal: "筋力トレーニングを続けながら体脂肪を減らす",
      customRequest: "任意の身体情報：身長、体重、年齢、性別、目標体重、運動経験。記録が不完全なら不足した食事や運動を確認する",
    },
    optionLabels: {
      reportStyle: {
        "估算热量 + 给明天一个小调整": "カロリーを推定し、明日に向けた小さな改善を1つ提案",
        "只做记录和趋势，不评价": "評価せず、記録と傾向だけを整理",
        "重点看蛋白质、饮水和运动完成度": "たんぱく質、水分補給、運動の達成度を重視",
      },
    },
    fieldCopy: {
      checkinTime: { label: "記録時刻", helpText: "朝食後、昼食後、就寝前など、1〜5件の通知を設定できます。" },
      fitnessGoal: { label: "目標", placeholder: "例：減量、筋肉増加、体重維持、大会、運動再開" },
      bodyProfile: { label: "身体情報（任意）", placeholder: "例：168cm、62kg、目標58kg、週3回の運動", helpText: "推定と傾向のためだけに使い、医療・栄養診断には使用しません。" },
      foodLog: { label: "記録する内容", placeholder: "例：1日の終わりに食事、飲み物、運動、体重を確認" },
      reportStyle: { label: "フィードバック形式" },
      customRequest: { label: "追加の要望", placeholder: "例：菜食、糖質管理、遅い夕食、励ますトーン" },
    },
    safetyNote: "カロリーと活動消費量は推定値であり、医療・栄養・トレーニング上の助言ではありません。",
  },
  "global-holiday-reminder": {
    name: "祝日・天気チェック",
    valueProp: "各国の祝日、目的地の天気、公式警報をまとめて確認",
    description: "海外旅行や国際業務のために、祝日、振替出勤日、目的地の予報、公式気象警報を追跡します。",
    quickPrompt: "気になる地域の祝日、目的地の天気、公式警報を確認してください。",
    defaultFrequencyLabel: "毎日09:00",
    durationLabel: "約2分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "国・地域、祝日の範囲、通知時期、任意の天気・警報条件",
    usageGuide: [
      "複数の国・地域を選び、祝日、振替出勤日、銀行休業日を分けて確認できます。",
      "目的地の都市と日付を入力すると、天気と大雨・台風・猛暑などの公式警報も確認します。",
    ],
    quickPromptTemplate: [
      { type: "text", text: "毎日" }, { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "に" }, { type: "field", fieldKey: "holidayCountries" },
      { type: "text", text: "の" }, { type: "field", fieldKey: "holidayScope" },
      { type: "text", text: "を確認し、" }, { type: "field", fieldKey: "reminderWindow" },
      { type: "text", text: "に知らせてください。" }, { type: "field", fieldKey: "holidayWeatherPlan" },
      { type: "text", text: "。補足：" }, { type: "field", fieldKey: "customRequest" }, { type: "text", text: "。" },
    ],
    fieldDefaults: {
      holidayWeatherPlan: "バンコクとジャカルタの今後7日間の天気、および大雨、台風、猛暑の公式警報も確認する",
      customRequest: "入力した旅行、配送、顧客、会議の日程を使い、関連性の高い通知にする",
    },
    optionLabels: {
      holidayScope: {
        "公共假期 + 调休日 + 银行假日": "祝日、振替出勤日、銀行休業日",
        "只看法定公共假期": "法定祝日のみ",
        "加上当地大型节庆/交通高峰": "祝日と主要な地域行事・交通混雑",
      },
      reminderWindow: {
        "提前 7 天 + 提前 1 天": "7日前と1日前",
        "提前 3 天 + 当天早上": "3日前と当日の朝",
        "仅在假期当天早上提醒": "祝日当日の朝のみ",
      },
    },
    fieldCopy: {
      reminderTime: { label: "確認時刻", helpText: "この時刻に祝日、天気、警報を確認します。" },
      holidayCountries: { label: "国・地域", helpText: "複数選択できます。選択した項目は下に表示されます。" },
      holidayScope: { label: "祝日の範囲" },
      reminderWindow: { label: "通知する時期" },
      periodMode: { label: "追跡期間", optionLabels: { "持续关注": "継続して追跡", "指定日期范围": "日付範囲を指定" } },
      periodStart: { label: "開始日", placeholder: "開始日を選択" },
      periodEnd: { label: "終了日", placeholder: "終了日を選択" },
      holidayWeatherPlan: { label: "天気と警報", placeholder: "例：8月1日〜7日のバンコクの天気と公式大雨警報。天気が不要なら削除" },
      customRequest: { label: "追加の要望", placeholder: "例：8月のバンコク旅行、インドネシアの顧客予定、長期休暇中の配送回避" },
    },
  },
  "stock-info-digest": {
    name: "株式情報ダイジェスト",
    valueProp: "選んだ銘柄の株価、発表、決算情報を要約",
    description: "中国本土、香港、米国株の公開情報を整理し、売買の推奨は行いません。",
    quickPrompt: "フォローしている銘柄の公開市場情報をまとめてください。",
    defaultFrequencyLabel: "毎日09:00",
    durationLabel: "約3分",
    defaultDeliverLabel: "Web／最近の実行",
    requiredInfoLabel: "銘柄名またはコード、市場、確認したい項目",
    usageGuide: [
      "中国本土、香港、米国の銘柄に対応します。企業名だけの場合は一般的なコードを照合し、不確かな場合は明示します。",
      "公開されている市場情報、発表、決算、ニュースだけを整理し、売買や保有比率の助言は行いません。",
    ],
    quickPromptTemplate: [
      { type: "text", text: "毎日" }, { type: "field", fieldKey: "reminderTime" },
      { type: "text", text: "に次の銘柄の更新をまとめてください：" }, { type: "field", fieldKey: "stockList" },
      { type: "text", text: "。確認項目：" }, { type: "field", fieldKey: "stockFocus" },
      { type: "text", text: "。補足：" }, { type: "field", fieldKey: "customRequest" }, { type: "text", text: "。" },
    ],
    fieldDefaults: {
      stockList: "Tencent Holdings 00700、NVIDIA NVDA、Kweichow Moutai 600519",
      stockFocus: "最新価格、変動率、重要な発表、決算、異常な値動きの公開情報上の要因",
      customRequest: "公開情報だけを使い、売買や保有比率の増減を推奨しない",
    },
    fieldCopy: {
      reminderTime: { label: "要約時刻", helpText: "この時刻に、その日に確認できる公開情報を整理します。" },
      stockList: { label: "フォローする銘柄", placeholder: "銘柄名、コード、市場。企業名だけでも入力できます" },
      stockFocus: { label: "確認したい項目", placeholder: "例：価格変動、発表、決算、異常な値動き、業界ニュース" },
      customRequest: { label: "追加の要望", placeholder: "例：香港・米国株のみ、決算を優先、発表があるときだけ通知" },
    },
    safetyNote: "公開情報のみを扱います。投資助言ではありません。",
  },
};

function localizeOverviewField(
  field: ScenarioTaskField,
  copy: OverviewEnglishPackCopy,
  locale: PublicSiteLocaleCode,
): ScenarioTaskField {
  const localizedField = copy.fieldCopy?.[field.key];
  const defaultValue = localizedField?.defaultValue
    ?? copy.fieldDefaults?.[field.key]
    ?? field.defaultValue;
  const optionLabels = localizedField?.optionLabels ?? copy.optionLabels?.[field.key];
  const localizedMetadata: Partial<ScenarioTaskField> = localizedField
    ? {
        label: localizedField.label,
        ...(localizedField.placeholder !== undefined
          ? { placeholder: localizedField.placeholder }
          : {}),
        ...(localizedField.helpText !== undefined
          ? { helpText: localizedField.helpText }
          : {}),
      }
    : {};
  let options = field.options?.map((option) => ({
    ...option,
    label: optionLabels?.[option.value] ?? option.label,
  }));

  if (field.key === "fromCurrency" || field.key === "toCurrency") {
    const displayNames = typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames([locale], { type: "currency" })
      : null;
    options = field.options?.map((option) => {
      const name = displayNames?.of(option.value);
      return { ...option, label: name && name !== option.value ? `${name} ${option.value}` : option.value };
    });
  }
  if (field.key === "holidayCountries") {
    const displayNames = typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames([locale], { type: "region" })
      : null;
    options = field.options?.map((option) => ({
      ...option,
      label: displayNames?.of(option.value) ?? option.value,
    }));
  }

  return {
    ...field,
    ...localizedMetadata,
    defaultValue,
    options,
  };
}

const KOREAN_OVERVIEW_TEXT = {
  "medication-once": ["물 섭취 및 복약 알림", "물 섭취는 가볍게, 복약은 의사의 지시에 따라 알림", "물 섭취와 복약을 하나의 작업으로 관리하되 복약 내용은 처방과 안내를 기준으로 합니다.", "1회 또는 복약 기간"],
  "rent-reminder": ["임대료 납부 알림", "납부일 전에 알려 연체 방지", "매월 임대료 납부일을 확인하고 금액, 지불 방법, 메모와 함께 알려 줍니다.", "매일 09:00에 확인"],
  "country-fx-alert": ["환율 도달 알림", "원하는 환율에 도달했을 때만 알림", "통화 쌍과 기준값을 확인하고 조건을 충족할 때 알려 줍니다.", "매일 10:00"],
  "calorie-fitness-checkin": ["칼로리 및 운동 기록", "매일 식사, 운동, 체중 추세 기록", "매일 식사와 운동을 묻고 제공한 신체 정보를 기준으로 가벼운 회고를 제공합니다.", "매일 21:30"],
  "global-holiday-reminder": ["공휴일 및 날씨 확인", "공휴일, 날씨, 공식 특보를 함께 확인", "국가별 공휴일과 대체 휴일, 목적지 날씨, 공식 특보를 확인합니다.", "매일 09:00에 확인"],
  "stock-info-digest": ["주식 정보 요약", "관심 주식의 가격, 공시, 실적 변화 정리", "관심 주식의 공개 시장 정보와 공시, 실적, 뉴스를 정리하며 매매 조언은 제공하지 않습니다.", "매일 09:00"],
} satisfies Record<(typeof OVERVIEW_SCENARIO_TASK_IDS)[number], readonly [string, string, string, string]>;

function koreanQuickPromptTemplate(id: (typeof OVERVIEW_SCENARIO_TASK_IDS)[number]): ScenarioQuickPromptPart[] {
  if (id === "medication-once") return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "recurringTimes" }, { type: "text", text: "에 물 섭취와 복약을 알려 주세요: " }, { type: "field", fieldKey: "medicine" }];
  if (id === "calorie-fitness-checkin") return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "checkinTime" }, { type: "text", text: "에 식사와 운동을 기록해 주세요: " }, { type: "field", fieldKey: "foodLog" }];
  if (id === "rent-reminder") return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "reminderTime" }, { type: "text", text: "에 확인하고 임대료 납부를 알려 주세요: " }, { type: "field", fieldKey: "rentInfo" }];
  if (id === "country-fx-alert") return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "reminderTime" }, { type: "text", text: "에 환율을 확인하고 기준에 도달하면 알려 주세요: " }, { type: "field", fieldKey: "thresholdValue" }];
  if (id === "global-holiday-reminder") return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "reminderTime" }, { type: "text", text: "에 다음 국가의 공휴일과 날씨를 확인해 주세요: " }, { type: "field", fieldKey: "holidayCountries" }];
  return [{ type: "text", text: "매일 " }, { type: "field", fieldKey: "reminderTime" }, { type: "text", text: "에 다음 주식 정보를 정리해 주세요: " }, { type: "field", fieldKey: "stockList" }];
}

const OVERVIEW_KOREAN_COPY: typeof OVERVIEW_ENGLISH_COPY = Object.fromEntries(
  OVERVIEW_SCENARIO_TASK_IDS.map((id) => {
    const [name, valueProp, description, defaultFrequencyLabel] = KOREAN_OVERVIEW_TEXT[id];
    return [id, {
      ...OVERVIEW_KOREAN_GENERATED_COPY[id],
      name,
      valueProp,
      description,
      quickPrompt: description,
      defaultFrequencyLabel,
      quickPromptTemplate: koreanQuickPromptTemplate(id),
    }];
  }),
) as typeof OVERVIEW_ENGLISH_COPY;

/**
 * 场景任务卡片的本地化文案表。
 *
 * `null` 表示该语种尚未提供独立文案，将回退到中文原稿
 * （`OVERVIEW_SCENARIO_TASK_PACKS`）。
 *
 * ⚠️ 刻意使用 `Record<PublicSiteLocaleCode, …>` 而非
 * `locale !== 'en-US' && locale !== 'id-ID'` 的排除式判断：排除式判断在
 * 新增语种时**不会报错**，会让新语种静默显示中文；改为全量查表后，
 * 注册表新增语种而此处未声明时 `tsc` 直接失败，迫使开发者显式决定
 * 「提供翻译」还是「明确标记为回退」。
 */
const OVERVIEW_COPY_BY_LOCALE: Record<
  PublicSiteLocaleCode,
  typeof OVERVIEW_ENGLISH_COPY | null
> = {
  "zh-CN": null,
  "zh-SG": null,
  "zh-Hant": null,
  "en-US": OVERVIEW_ENGLISH_COPY,
  "id-ID": OVERVIEW_INDONESIAN_COPY,
  es: OVERVIEW_SPANISH_COPY,
  "ja-JP": OVERVIEW_JAPANESE_COPY,
  "ko-KR": OVERVIEW_KOREAN_COPY,
};

/**
 * 该语种是否提供了独立的场景任务文案。
 *
 * 供 `scenario-job-presentation` 等消费方判断「是否走本地化分支」，
 * 避免在多处重复写 `locale !== 'en-US' && locale !== 'id-ID'` 这类
 * 排除式条件——排除式条件新增语种时不报错，会让新语种静默走错分支。
 */
export function hasLocalizedOverviewCopy(locale: PublicSiteLocaleCode): boolean {
  return OVERVIEW_COPY_BY_LOCALE[locale] !== null;
}

export function getOverviewScenarioTaskPacks(
  locale: PublicSiteLocaleCode,
): readonly ScenarioTaskPack[] {
  const localizedCopy = OVERVIEW_COPY_BY_LOCALE[locale];
  if (!localizedCopy) return OVERVIEW_SCENARIO_TASK_PACKS;

  return OVERVIEW_SCENARIO_TASK_PACKS.map((pack) => {
    const copy = localizedCopy[pack.id as (typeof OVERVIEW_SCENARIO_TASK_IDS)[number]];
    return {
      ...pack,
      ...copy,
      quickPromptLocale: locale,
      fields: pack.fields.map((field) => localizeOverviewField(field, copy, locale)),
    };
  });
}
