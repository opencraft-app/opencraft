/**
 * 工作台「启动模板」提示词与跨页面暂存。
 *
 * 交互链路：
 *   工作台卡片点击 → savePendingWorkbenchPrompt(templateId) → 跳转 /agents/chat
 *   → chat 面板挂载后 readPendingWorkbenchPrompt() → 自动填入输入框并发送 → clear。
 *
 * 为什么用 sessionStorage 而非 URL query：
 *   agent-routes.ts 的 getAgentSectionHref 会按 AGENT_SECTION_PERSISTENT_QUERY_KEYS
 *   白名单过滤跨 section 的查询参数（当前白名单为空），URL 上的 prompt 会在跳转时被丢弃。
 *   项目既有的 scenario-pending-install 也采用同样的 sessionStorage 暂存 + resume 模式。
 *
 * prompt 语言策略：
 *   与站点区域（cn/global）解耦，直接按「运行时当前语言」判断——仅简体中文
 *   （zh-CN，zh-SG 已在 i18n 层映射到 zh-CN）发送中文，其余语言（en-US / zh-Hant /
 *   id-ID / es / ja-JP / ko-KR 等）一律发送英文。国内站固定 zh-CN 自然发中文。
 */

import i18n from "@/i18n";

export type WorkbenchTemplateId = "tool" | "dashboard" | "campaign" | "profile" | "blank";

/**
 * 是否使用中文 prompt。
 *
 * 仅简体中文（zh-CN）使用中文；zh-SG 无独立字典、i18n 层已映射到 zh-CN，
 * 因此这里只判断 "zh-CN" 即可。传入值应为 i18n.language（字典 key）。
 */
export const isChinesePromptLocale = (language: string): boolean => language === "zh-CN";

/**
 * 所有工作台构建请求共享的技术栈与约束（中 / 英两版）。
 *
 * 设计要点：这段约束**不写死进模板文案**，而是在「发送那一刻」由 withSharedTechStack
 * 统一追加到最终 prompt 末尾。这样无论来源是预设模板，还是用户自定义输入的内容，
 * 都会带上同一份技术栈约束，避免四处重复、也便于后续统一调整。
 */
const SHARED_TECH_STACK_ZH = [
  "技术栈：React + TypeScript + Tailwind CSS；组件库优先使用 shadcn/ui；图标使用 lucide-react；如需图表可使用 Recharts。",
  "不要预置任何模拟业务数据；内容需要可编辑；数据可暂存至浏览器本地存储（localStorage）。",
  "代码生成完后，使用 website-builder Skill 进行部署。",
].join("\n");

const SHARED_TECH_STACK_EN = [
  "Tech stack: React + TypeScript + Tailwind CSS; prefer shadcn/ui for components; use lucide-react for icons; use Recharts for charts if needed.",
  "Do not preset any mock business data; content should be editable; data can be temporarily stored in browser local storage (localStorage).",
  "After generating the code, deploy it using the website-builder Skill.",
].join("\n");

/**
 * 在任意 prompt 末尾追加共享技术栈约束（按当前语言选择中 / 英）。
 *
 * 适用于所有发往 Agent 的工作台构建请求（预设模板 / 用户自定义输入）。
 * 空白或纯空白 prompt 原样返回，不追加（例如「创建空白工作台」入口不应带约束）。
 */
export function withSharedTechStack(prompt: string): string {
  if (!prompt.trim()) return prompt;
  const stack = isChinesePromptLocale(i18n.language) ? SHARED_TECH_STACK_ZH : SHARED_TECH_STACK_EN;
  return `${prompt}\n${stack}`;
}

/**
 * 每个启动模板对应的场景提示词（仅含场景与风格描述，不含技术栈约束）。
 *
 * 技术栈约束与「开始前先确认」的引导由 withSharedTechStack 在发送时统一追加，
 * 因此这里只保留每个模板的个性化定位。
 */
export const WORKBENCH_TEMPLATE_PROMPTS: Record<WorkbenchTemplateId, string> = {
  tool: [
    "我想做一个「清爽工具台」类型的网页工作台，用于表单收集、信息查询或轻量内部小工具。",
    "整体风格要简洁清爽、以功能为主，操作路径尽量短。",
    "开始前请先问我：这个工具具体解决什么场景、需要哪些字段/功能、给谁用。",
  ].join("\n"),
  dashboard: [
    "我想做一个「数据看板台」类型的网页工作台，用于展示核心指标、趋势和业务数据总览，适合做日报或数据汇总。",
    "整体风格要专业、信息密度合理，关键指标一眼可见。",
    "开始前请先问我：要展示哪些指标、数据从哪里来、更新频率如何、给谁看。",
  ].join("\n"),
  campaign: [
    "我想做一个「运营活动台」类型的网页工作台，用于活动落地页、报名页或兑换入口，适合增长和活动运营。",
    "整体风格要有活力、有号召力，突出行动引导（报名/参与/兑换）。",
    "开始前请先问我：这次活动的主题和目标、需要哪些模块（报名表单/规则/奖品等）、投放渠道。",
  ].join("\n"),
  profile: [
    "我想做一个「个人展示台」类型的网页工作台，用于作品集、个人主页或服务介绍，适合对外展示。",
    "整体风格要自然、有个人特色，内容层次清晰、便于访客快速了解我。",
    "开始前请先问我：展示给谁看、想突出哪些内容（作品/经历/服务/联系方式等）、有没有偏好的风格。",
  ].join("\n"),
  blank: [
    "我想创建一个网页工作台。",
    "请先主动问我：这个工作台想用来做什么、面向谁、需要哪些核心功能，帮我一步步理清需求后再开始搭建。",
  ].join("\n"),
};

/** 每个启动模板对应的英文场景提示词（与 WORKBENCH_TEMPLATE_PROMPTS 一一对应）。 */
export const WORKBENCH_TEMPLATE_PROMPTS_EN: Record<WorkbenchTemplateId, string> = {
  tool: [
    'I want to build a "clean utility dashboard" type web workbench for form collection, information lookup, or lightweight internal tools.',
    "Keep the overall style clean and functional, with short user journeys.",
    "Before starting, please ask me: what scenario this tool solves, what fields/functions are needed, and who it is for.",
  ].join("\n"),
  dashboard: [
    'I want to build a "data dashboard" type web workbench for displaying core metrics, trends, and a business data overview, suitable for daily reports or data summaries.',
    "Keep the style professional with reasonable information density, so key metrics are visible at a glance.",
    "Before starting, please ask me: which metrics to show, where the data comes from, how often it updates, and who it is for.",
  ].join("\n"),
  campaign: [
    'I want to build a "campaign landing" type web workbench for activity landing pages, sign-up pages, or redemption entries, suitable for growth and campaign operations.',
    "Keep the style energetic and persuasive, emphasizing calls to action (sign up / join / redeem).",
    "Before starting, please ask me: the campaign theme and goals, which modules are needed (sign-up form / rules / prizes, etc.), and the distribution channels.",
  ].join("\n"),
  profile: [
    'I want to build a "personal showcase" type web workbench for a portfolio, personal homepage, or service introduction, suitable for public display.',
    "Keep the style natural and personal, with clear content hierarchy so visitors can quickly understand me.",
    "Before starting, please ask me: who the audience is, what content to highlight (works / experience / services / contact info, etc.), and any preferred style.",
  ].join("\n"),
  blank: [
    "I want to create a web workbench.",
    "Please proactively ask me: what this workbench is for, who it is aimed at, and what core features are needed. Help me clarify the requirements step by step before starting.",
  ].join("\n"),
};

/** 按当前语言返回模板 prompt（简体中文返回中文，其余返回英文）。 */
const resolveTemplatePrompt = (templateId: WorkbenchTemplateId): string =>
  (isChinesePromptLocale(i18n.language)
    ? WORKBENCH_TEMPLATE_PROMPTS
    : WORKBENCH_TEMPLATE_PROMPTS_EN)[templateId];

const PENDING_WORKBENCH_PROMPT_KEY = "lightvela-pending-workbench-prompt-v1";
const PENDING_WORKBENCH_PROMPT_TTL_MS = 10 * 60 * 1000;

export interface PendingWorkbenchPrompt {
  /** 模板标识，用于埋点与来源追踪 */
  templateId: WorkbenchTemplateId;
  /** 待自动填入并发送的提示词 */
  prompt: string;
  /** 写入时间，用于 TTL 过期判断 */
  createdAt: string;
}

function getWorkbenchPromptStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

/**
 * 保存待发送的工作台提示词（点击卡片时调用）。
 * 按当前语言写入对应中文 / 英文 prompt。
 * @returns 是否成功写入（无 storage 或未知模板返回 false）
 */
export function savePendingWorkbenchPrompt(
  templateId: WorkbenchTemplateId,
  now = new Date(),
): boolean {
  const prompt = resolveTemplatePrompt(templateId);
  if (!prompt) return false;
  const storage = getWorkbenchPromptStorage();
  if (!storage) return false;
  const pending: PendingWorkbenchPrompt = {
    templateId,
    prompt,
    createdAt: now.toISOString(),
  };
  try {
    storage.setItem(PENDING_WORKBENCH_PROMPT_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取待发送的工作台提示词（chat 面板挂载后调用）。
 * 过期、损坏或非法数据会被清除并返回 null。
 */
export function readPendingWorkbenchPrompt(now = new Date()): PendingWorkbenchPrompt | null {
  const storage = getWorkbenchPromptStorage();
  const raw = storage?.getItem(PENDING_WORKBENCH_PROMPT_KEY);
  if (!raw) return null;
  try {
    const candidate = JSON.parse(raw) as Partial<PendingWorkbenchPrompt>;
    const createdAtMs = Date.parse(candidate.createdAt ?? "");
    const valid = typeof candidate.templateId === "string"
      && candidate.templateId in WORKBENCH_TEMPLATE_PROMPTS
      && typeof candidate.prompt === "string"
      && candidate.prompt.trim().length > 0
      && Number.isFinite(createdAtMs)
      && now.getTime() - createdAtMs <= PENDING_WORKBENCH_PROMPT_TTL_MS;
    if (!valid) {
      storage?.removeItem(PENDING_WORKBENCH_PROMPT_KEY);
      return null;
    }
    return candidate as PendingWorkbenchPrompt;
  } catch {
    storage?.removeItem(PENDING_WORKBENCH_PROMPT_KEY);
    return null;
  }
}

/** 清除待发送的工作台提示词（发送后调用）。 */
export function clearPendingWorkbenchPrompt(): void {
  getWorkbenchPromptStorage()?.removeItem(PENDING_WORKBENCH_PROMPT_KEY);
}
