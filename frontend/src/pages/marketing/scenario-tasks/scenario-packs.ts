export type ScenarioTaskId =
  | "stock-morning-brief"
  | "world-cup-daily"
  | "daily-news"
  | "ai-digest";

export type ScenarioTaskFieldType = "text" | "textarea" | "select" | "multiselect";

export interface ScenarioTaskFieldOption {
  value: string;
  label: string;
}

export interface ScenarioTaskField {
  key: string;
  label: string;
  type: ScenarioTaskFieldType;
  defaultValue: string;
  placeholder?: string;
  helpText?: string;
  options?: ScenarioTaskFieldOption[];
}

export interface ScenarioTaskPack {
  id: ScenarioTaskId;
  name: string;
  description: string;
  defaultFrequencyLabel: string;
  defaultSchedule: string;
  defaultDeliverLabel: string;
  requiredInfoLabel: string;
  icon: "trending-up" | "trophy" | "newspaper" | "brain-circuit";
  fields: ScenarioTaskField[];
  safetyNote?: string;
  promptBuilder: (values: Record<string, string>) => string;
}

function valueOf(
  fields: readonly ScenarioTaskField[],
  values: Record<string, string>,
  key: string,
): string {
  const configured = values[key]?.trim();
  if (configured) return configured;
  return fields.find((field) => field.key === key)?.defaultValue ?? "";
}

const realtimeToolInstruction = [
  "执行要求：先调用 datetime 确认当前日期和时区；实时信息必须优先调用 web_search 检索，必要时再用 web_fetch 打开 1-2 个权威来源核对。",
  "不要进行开放式长时间浏览；同一任务最多检索 3 组关键词、最多打开 4 个网页来源。信息不足时直接说明未确认，不要编造。",
  "输出时保留来源名称或链接，方便我回看。",
].join("\n");

const stockFields: ScenarioTaskField[] = [
  {
    key: "focusScope",
    label: "关注范围",
    type: "multiselect",
    defaultValue: "大盘 / 行业板块 / 热点题材",
    options: [
      { value: "大盘", label: "大盘" },
      { value: "自选股", label: "自选股" },
      { value: "行业板块", label: "行业板块" },
      { value: "热点题材", label: "热点题材" },
    ],
  },
  {
    key: "watchlist",
    label: "自选内容",
    type: "textarea",
    defaultValue: "沪深主要指数、AI 算力、半导体、新能源",
    placeholder: "股票代码、行业关键词或你关心的题材",
  },
  {
    key: "style",
    label: "输出风格",
    type: "select",
    defaultValue: "3 分钟速读",
    options: [
      { value: "3 分钟速读", label: "3 分钟速读" },
      { value: "详细版", label: "详细版" },
      { value: "偏风险提醒", label: "偏风险提醒" },
    ],
  },
];

const worldCupFields: ScenarioTaskField[] = [
  {
    key: "teams",
    label: "关注球队",
    type: "text",
    defaultValue: "全赛事",
    placeholder: "可留空，默认全赛事",
  },
  {
    key: "spoilerMode",
    label: "剧透模式",
    type: "select",
    defaultValue: "直接告诉我结果",
    options: [
      { value: "直接告诉我结果", label: "直接告诉我结果" },
      { value: "先显示赛程，点开看比分", label: "先显示赛程，点开看比分" },
    ],
  },
  {
    key: "reminderMode",
    label: "提醒模式",
    type: "select",
    defaultValue: "每日汇总",
    options: [
      { value: "每日汇总", label: "每日汇总" },
      { value: "赛前提醒", label: "赛前提醒" },
      { value: "赛后快报", label: "赛后快报" },
    ],
  },
];

const dailyNewsFields: ScenarioTaskField[] = [
  {
    key: "categories",
    label: "关注地区/分类",
    type: "multiselect",
    defaultValue: "国内 / 国际 / 科技 / 财经",
    options: [
      { value: "国内", label: "国内" },
      { value: "国际", label: "国际" },
      { value: "科技", label: "科技" },
      { value: "财经", label: "财经" },
      { value: "本地", label: "本地" },
    ],
  },
  {
    key: "density",
    label: "信息密度",
    type: "select",
    defaultValue: "10 条标准",
    options: [
      { value: "5 条极简", label: "5 条极简" },
      { value: "10 条标准", label: "10 条标准" },
      { value: "深度版", label: "深度版" },
    ],
  },
  {
    key: "stance",
    label: "立场偏好",
    type: "select",
    defaultValue: "尽量中立",
    options: [
      { value: "尽量中立", label: "尽量中立" },
      { value: "偏商业影响", label: "偏商业影响" },
      { value: "偏政策影响", label: "偏政策影响" },
    ],
  },
  {
    key: "blockedTopics",
    label: "屏蔽话题",
    type: "text",
    defaultValue: "",
    placeholder: "可选，例如娱乐八卦、社会冲突",
  },
];

const aiDigestFields: ScenarioTaskField[] = [
  {
    key: "focusArea",
    label: "关注方向",
    type: "multiselect",
    defaultValue: "Agent / 模型 / 多模态 / 开源",
    options: [
      { value: "Agent", label: "Agent" },
      { value: "模型", label: "模型" },
      { value: "多模态", label: "多模态" },
      { value: "开源", label: "开源" },
      { value: "产品融资", label: "产品融资" },
      { value: "论文", label: "论文" },
    ],
  },
  {
    key: "purpose",
    label: "使用目的",
    type: "select",
    defaultValue: "产品判断",
    options: [
      { value: "产品判断", label: "产品判断" },
      { value: "技术学习", label: "技术学习" },
      { value: "投资观察", label: "投资观察" },
      { value: "内容创作", label: "内容创作" },
    ],
  },
  {
    key: "depth",
    label: "输出深度",
    type: "select",
    defaultValue: "快讯 + 影响说明",
    options: [
      { value: "快讯", label: "快讯" },
      { value: "快讯 + 影响说明", label: "快讯 + 影响说明" },
      { value: "可转发版本", label: "可转发版本" },
    ],
  },
];

export const SCENARIO_TASK_PACKS: ScenarioTaskPack[] = [
  {
    id: "stock-morning-brief",
    name: "A股财经早报",
    description: "交易日前开盘前，整理大盘、板块和自选关注点",
    defaultFrequencyLabel: "交易日 08:30",
    defaultSchedule: "30 8 * * 1,2,3,4,5",
    defaultDeliverLabel: "网页 / 最近执行",
    requiredInfoLabel: "关注范围、自选内容、输出风格",
    icon: "trending-up",
    fields: stockFields,
    safetyNote: "仅做信息整理，非投资建议。",
    promptBuilder: (values) => {
      const focusScope = valueOf(stockFields, values, "focusScope");
      const watchlist = valueOf(stockFields, values, "watchlist");
      const style = valueOf(stockFields, values, "style");
      return [
        "请生成一份 A 股财经早报，供我在开盘前快速了解市场信息。",
        realtimeToolInstruction,
        "优先搜索交易所公告、主流财经媒体、指数/板块公开行情和公司公告；如果某个来源无法打开，换一个权威来源即可，不要反复重试。",
        `关注范围：${focusScope}。`,
        `自选内容：${watchlist || "无特别自选内容"}。`,
        `输出风格：${style}。`,
        "请按以下结构输出：昨日市场回顾、今日开盘前重点、关注板块变化、自选内容风险或公告、外围市场和政策因素。",
        "请尽量保留来源链接或来源说明。",
        "必须明确说明：以下内容仅做公开信息整理和风险提醒，非投资建议；不要输出任何交易指令或确定性涨跌判断。",
      ].join("\n");
    },
  },
  {
    id: "world-cup-daily",
    name: "世界杯今日赛况",
    description: "每天汇总昨晚赛果、今日赛程和关注球队动态",
    defaultFrequencyLabel: "每日 09:00",
    defaultSchedule: "0 9 * * *",
    defaultDeliverLabel: "网页 / 最近执行",
    requiredInfoLabel: "关注球队、剧透模式、提醒模式",
    icon: "trophy",
    fields: worldCupFields,
    promptBuilder: (values) => {
      const teams = valueOf(worldCupFields, values, "teams");
      const spoilerMode = valueOf(worldCupFields, values, "spoilerMode");
      const reminderMode = valueOf(worldCupFields, values, "reminderMode");
      return [
        "请生成一份世界杯今日赛况简报。",
        realtimeToolInstruction,
        "优先搜索 FIFA/赛事官网、主流体育媒体或比分平台；先确认当前是否处于世界杯比赛期，若赛事已结束或当天无赛程，直接说明并给出暂停任务建议。",
        `关注球队：${teams || "全赛事"}。`,
        `剧透模式：${spoilerMode}。`,
        `提醒模式：${reminderMode}。`,
        "请按以下结构输出：昨日赛果、今日赛程和本地时间、小组或淘汰赛形势、关注球队动态、一句话看点。",
        "如果赛事已经结束，请直接说明赛事已结束，并建议我暂停任务或改为体育周报。",
      ].join("\n");
    },
  },
  {
    id: "daily-news",
    name: "每日新闻",
    description: "每天早上整理一份清爽、带来源的新闻摘要",
    defaultFrequencyLabel: "每日 08:00",
    defaultSchedule: "0 8 * * *",
    defaultDeliverLabel: "网页 / 最近执行",
    requiredInfoLabel: "地区/分类、信息密度、立场偏好",
    icon: "newspaper",
    fields: dailyNewsFields,
    promptBuilder: (values) => {
      const categories = valueOf(dailyNewsFields, values, "categories");
      const density = valueOf(dailyNewsFields, values, "density");
      const stance = valueOf(dailyNewsFields, values, "stance");
      const blockedTopics = valueOf(dailyNewsFields, values, "blockedTopics");
      return [
        "请生成一份每日新闻摘要，信息要清爽、准确，并尽量带来源。",
        realtimeToolInstruction,
        "优先搜索权威媒体、政府/机构公告和主流新闻源；每条重要新闻只需核对 1-2 个来源，不要做深度长文采集。",
        `关注地区/分类：${categories}。`,
        `信息密度：${density}。`,
        `立场偏好：${stance}。`,
        blockedTopics ? `请减少或跳过这些话题：${blockedTopics}。` : "没有特别屏蔽的话题。",
        "请按以下结构输出：今日最重要的 5 件事、分区摘要、每条新闻的一句话摘要、为什么重要、来源链接或来源说明、需要继续关注的事件。",
      ].join("\n");
    },
  },
  {
    id: "ai-digest",
    name: "AI 发展动态",
    description: "追踪 AI 产品、模型、论文、开源和行业动态",
    defaultFrequencyLabel: "工作日 09:30",
    defaultSchedule: "30 9 * * 1,2,3,4,5",
    defaultDeliverLabel: "网页 / 最近执行",
    requiredInfoLabel: "关注方向、使用目的、输出深度",
    icon: "brain-circuit",
    fields: aiDigestFields,
    promptBuilder: (values) => {
      const focusArea = valueOf(aiDigestFields, values, "focusArea");
      const purpose = valueOf(aiDigestFields, values, "purpose");
      const depth = valueOf(aiDigestFields, values, "depth");
      return [
        "请生成一份 AI 行业发展动态摘要。",
        realtimeToolInstruction,
        "优先搜索模型/产品官方博客、论文页面、GitHub 项目、主流科技媒体和研究机构公告；每条动态用最短路径确认发布日期与核心事实。",
        `关注方向：${focusArea}。`,
        `使用目的：${purpose}。`,
        `输出深度：${depth}。`,
        "请按以下结构输出：今日 AI 大事、新模型或新产品、值得关注的论文或开源项目、Agent 方向动态、对我关注方向的影响、可继续深挖的链接。",
        "请保持事实与观点分离，尽量保留来源链接或来源说明。",
      ].join("\n");
    },
  },
];

export function getScenarioTaskPack(id: ScenarioTaskId): ScenarioTaskPack {
  const pack = SCENARIO_TASK_PACKS.find((item) => item.id === id);
  if (!pack) {
    throw new Error(`Unknown scenario task pack: ${id}`);
  }
  return pack;
}
