/**
 * 文档侧边栏结构 + slug → markdown 文件映射。
 * 路由形态：
 *   /docs/:slug              例如 /docs/overview
 *   /docs/:category/:slug    例如 /docs/configuration/model
 *
 * 区域差异：
 *   按 AGENTS.md 第 252 行规范，国内 / 国际站 sidebar 用数组/常量驱动，按
 *   `isGlobal` 编译期切换数据源，terser 会消除未选中的一支为死代码。
 *   - 国内站（CN_SIDEBAR）：微信 / 飞书 / QQ
 *   - 国际站（GLOBAL_SIDEBAR）：Telegram / WhatsApp / Discord / WeChat / QQ / WeCom / Lark
 */

import { isGlobal } from "@/lib/region";

export interface DocItem {
  /**
   * 文档 slug。对应 `SLUG_TO_FILE` 的 key；点击后跳转 `/docs/:slug`。
   * 对于"仅作分组表头、不可点击"的条目，置为 `null`。
   * 对于"分组表头，点击后跳转到第一个子项"的条目，配合 `defaultChildSlug` 使用（slug 仍为 null）。
   */
  slug: string | null;
  title: string;
  titleEn?: string;
  /** 仅在指定国际站语言中显示；省略表示中英文均显示。 */
  availableLocales?: Array<"zh" | "en">;
  /**
   * 是否作为二级目录项（视觉上缩进）。
   * 用于在"配置通道"下挂具体通道（国内：微信/飞书/QQ；国际：Telegram/WhatsApp/...）。
   */
  indent?: boolean;
  /**
   * 当 slug 为 null 时，可选：指定点击表头要跳转到的子项 slug。
   * 设置后表头在视觉上仍是分组标题（无灰底激活态），但点击会导航到该 slug。
   */
  defaultChildSlug?: string;
}

export interface DocGroup {
  title: string;
  titleEn?: string;
  items: DocItem[];
}

/**
 * 国内站 sidebar：按用户任务组织（GEO 导航方案）。
 * 分组：产品入门 / 账号、套餐与开通 / 功能与配置 / 场景方案 / 对比与选型 /
 *       问题排查 / 安全、隐私与数据 / 进阶用法 / 联系与支持。
 * 通道具体项（微信 / 飞书 / QQ）挂在「配置通道」表头下作为二级项。
 * 注：部分新增页面为占位（仅标题骨架），正文内容后续逐步补齐。
 */
const CN_SIDEBAR: DocGroup[] = [
  {
    title: "产品入门",
    items: [
      { slug: "overview", title: "LightVela 是什么" },
      { slug: "quickstart", title: "快速开始" },
      { slug: "core-concepts", title: "核心概念" },
      { slug: "who-is-lightvela-for", title: "LightVela 适合哪些人使用？" },
    ],
  },
  {
    title: "账号、套餐与开通",
    items: [
      { slug: "account", title: "账号与实名认证" },
      { slug: "announcements/public-beta", title: "公测公告" },
      { slug: "plans", title: "套餐管理" },
      { slug: "credits", title: "AI 积分说明" },
      { slug: "create-first-hermes", title: "如何开通第一个 Hermes 智能体伙伴？" },
    ],
  },
  {
    title: "功能与配置",
    items: [
      { slug: "configuration", title: "配置总览" },
      { slug: "configuration/model", title: "配置模型" },
      // "配置通道" 作为一级分组表头，点击跳转到第一个子项（微信）；下面挂三个具体 channel 作为二级项
      { slug: null, title: "配置通道", defaultChildSlug: "configuration/channel-wechat" },
      { slug: "configuration/channel-wechat", title: "微信", indent: true },
      { slug: "configuration/channel-feishu", title: "飞书", indent: true },
      { slug: "configuration/channel-qq", title: "QQ", indent: true },
      { slug: "configuration/skill", title: "配置技能" },
    ],
  },
  {
    title: "问题排查",
    items: [
      { slug: "faq", title: "常见问题 FAQ" },
    ],
  },
  {
    title: "联系与支持",
    items: [
      { slug: "contact-us", title: "联系我们" },
    ],
  },
];

/**
 * 国际站 sidebar：按 GEO 导航方案组织为 9 大分组。
 * 通道顺序固定为 Telegram / WhatsApp / Discord / WeChat / QQ / WeCom / Lark。
 */
const GLOBAL_SIDEBAR: DocGroup[] = [
  {
    title: "开始使用",
    titleEn: "Getting Started",
    items: [
      { slug: "overview", title: "LightVela 是什么", titleEn: "What is LightVela" },
      { slug: "quickstart", title: "快速开始", titleEn: "Quickstart" },
      { slug: "core-concepts", title: "核心概念", titleEn: "Core Concepts" },
      { slug: "who-is-lightvela-for", title: "LightVela 适合哪些人使用？", titleEn: "Who Is LightVela For?" },
    ],
  },
  {
    title: "套餐与开通",
    titleEn: "Plans & Activation",
    items: [
      { slug: "plans", title: "套餐说明", titleEn: "Plans" },
      { slug: "credits", title: "AI 积分说明", titleEn: "Credits" },
      {
        slug: "create-first-hermes",
        title: "如何开通第一个 Hermes 实例？",
        titleEn: "How Do I Activate My First Hermes Instance?",
      },
    ],
  },
  {
    title: "功能与配置",
    titleEn: "Features & Configuration",
    items: [
      { slug: "configuration", title: "配置总览", titleEn: "Configuration Overview" },
      { slug: "configuration/model", title: "配置模型", titleEn: "Configure Models" },
      { slug: null, title: "配置通道", titleEn: "Configure Channels", defaultChildSlug: "configuration/channel-telegram" },
      { slug: "configuration/channel-telegram", title: "Telegram", titleEn: "Telegram", indent: true },
      { slug: "configuration/channel-whatsapp", title: "WhatsApp", titleEn: "WhatsApp", indent: true },
      { slug: "configuration/channel-discord", title: "Discord", titleEn: "Discord", indent: true },
      { slug: "configuration/channel-wechat", title: "WeChat", titleEn: "WeChat", indent: true },
      { slug: "configuration/channel-qq", title: "QQ", titleEn: "QQ", indent: true },
      { slug: "configuration/channel-wecom", title: "企业微信", titleEn: "WeCom", indent: true },
      { slug: "configuration/channel-feishu", title: "飞书", titleEn: "Lark", indent: true },
      { slug: "configuration/channel-slack", title: "Slack", titleEn: "Slack", indent: true },
      { slug: "configuration/skill", title: "配置技能", titleEn: "Configure Skills" },
      { slug: "configuration/memory", title: "记忆管理", titleEn: "Memory Management" },
      { slug: "configuration/automation", title: "自动任务", titleEn: "Automations" },
      { slug: "configuration/files", title: "云存储", titleEn: "Cloud Storage" },
      { slug: "configuration/agent-chat", title: "对话", titleEn: "Chat" },
      { slug: "configuration/diagnostics", title: "诊断中心", titleEn: "Diagnostics" },
      {
        slug: "configuration/multiple-models",
        title: "模型切换",
        titleEn: "Model Switching",
      },
    ],
  },
  {
    title: "场景方案",
    titleEn: "Use Cases",
    items: [
      {
        slug: "use-cases/personal-ai-assistant",
        title: "如何用 LightVela 搭建个人 AI 助手？",
        titleEn: "How to Build a Personal AI Assistant with LightVela",
      },
      {
        slug: "use-cases/chinese-messaging-channels",
        title: "如何把 AI Agent 接入消息平台？",
        titleEn: "How to Connect an AI Agent to Messaging Platforms",
      },
      {
        slug: "use-cases/daily-summary",
        title: "如何用 Hermes Agent 做每日信息总结？",
        titleEn: "How to Create Daily Summaries with Hermes Agent",
      },
      {
        slug: "use-cases/hermes-agent-24-7",
        title: "如何让 Hermes Agent 7×24 小时在线？",
        titleEn: "How to Keep a Hermes Agent Online 24/7",
      },
      {
        slug: "use-cases/memory-and-knowledge",
        title: "如何用 Agent 管理长期记忆和个人知识？",
        titleEn: "How to Manage Long-Term Memory and Personal Knowledge with an Agent",
      },
    ],
  },
  {
    title: "对比与选型",
    titleEn: "Compare & Choose",
    items: [
      { slug: "compare/lightvela-vs-manus", title: "LightVela vs Manus", titleEn: "LightVela vs Manus" },
      { slug: "compare/lightvela-vs-hostinger", title: "LightVela vs Hostinger", titleEn: "LightVela vs Hostinger" },
      { slug: "compare/lightvela-vs-localhost-ai-agent", title: "LightVela vs 本地部署 Agent", titleEn: "LightVela vs Selfhost Agent" },
      { slug: "compare/lightvela-vs-chatgpt", title: "LightVela vs ChatGPT", titleEn: "LightVela vs ChatGPT" },
      { slug: "compare/lightvela-vs-genspark", title: "LightVela vs Genspark", titleEn: "LightVela vs Genspark" },
    ],
  },
  {
    title: "安全、隐私与数据",
    titleEn: "Security, Privacy & Data",
    items: [
      {
        slug: "faq/using-lightvela-safely",
        title: "安全使用 LightVela",
        titleEn: "Using LightVela Safely",
      },
    ],
  },
  {
    title: "联系与支持",
    titleEn: "Support",
    items: [
      { slug: "contact-us", title: "联系我们", titleEn: "Contact Us" },
    ],
  },
];

/**
 * 当前区域生效的 sidebar。
 * 编译期常量 `isGlobal` 决定使用哪一份；未选中的一支会被 terser 消除为死代码。
 */
export const SIDEBAR: DocGroup[] = isGlobal ? GLOBAL_SIDEBAR : CN_SIDEBAR;

/** slug 到 markdown 文件路径（相对于 `@/content/docs/`）的映射 */
const CN_SLUG_TO_FILE: Record<string, string> = {
  // 产品入门
  overview: "01-overview.md",
  quickstart: "02-quickstart.md",
  "core-concepts": "04-core-concepts.md",
  "who-is-lightvela-for": "who-is-lightvela-for.md",
  // 账号、套餐与开通
  account: "03-account.md",
  "announcements/public-beta": "announcements/public-beta.md",
  plans: "plans.md",
  credits: "credits.md",
  "create-first-hermes": "create-first-hermes.md",
  // 功能与配置
  configuration: "05-configuration.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/channel-slack": "configuration/channel-slack.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/skill": "configuration/skill.md",
  // 问题排查
  faq: "07-faq.md",
  // 联系与支持
  "contact-us": "contact-us.md",
};

const GLOBAL_SLUG_TO_FILE: Record<string, string> = {
  overview: "01-overview.md",
  quickstart: "02-quickstart.md",
  "core-concepts": "04-core-concepts.md",
  "who-is-lightvela-for": "who-is-lightvela-for.md",
  plans: "plans.md",
  credits: "credits.md",
  "create-first-hermes": "create-first-hermes.md",
  configuration: "05-configuration.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-telegram": "configuration/channel-telegram.md",
  "configuration/channel-whatsapp": "configuration/channel-whatsapp.md",
  "configuration/channel-discord": "configuration/channel-discord.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/channel-wecom": "configuration/channel-wecom.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/skill": "configuration/skill.md",
  "configuration/memory": "configuration/memory.md",
  "configuration/files": "configuration/files.md",
  "configuration/automation": "configuration/automation.md",
  "configuration/diagnostics": "configuration/diagnostics.md",
  "configuration/multiple-models": "configuration/multiple-models.md",
  "configuration/agent-chat": "configuration/agent-chat.md",
  "use-cases/personal-ai-assistant": "use-cases/personal-ai-assistant.md",
  "use-cases/chinese-messaging-channels": "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary": "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7": "use-cases/hermes-agent-24-7.md",
  "use-cases/memory-and-knowledge": "use-cases/memory-and-knowledge.md",
  "faq/using-lightvela-safely": "faq/using-lightvela-safely.md",
  "compare/lightvela-vs-manus": "compare/lightvela-vs-manus.md",
  "compare/lightvela-vs-hostinger": "compare/lightvela-vs-hostinger.md",
  "compare/lightvela-vs-localhost-ai-agent": "compare/lightvela-vs-localhost-ai-agent.md",
  "compare/lightvela-vs-chatgpt": "compare/lightvela-vs-chatgpt.md",
  "compare/lightvela-vs-genspark": "compare/lightvela-vs-genspark.md",
  "contact-us": "contact-us.md",
};

export const SLUG_TO_FILE: Record<string, string> = isGlobal
  ? GLOBAL_SLUG_TO_FILE
  : CN_SLUG_TO_FILE;

export const isEnglishLocale = (locale?: string): boolean =>
  locale?.toLowerCase().startsWith("en") ?? false;

export function getLocalizedSidebar(locale?: string): DocGroup[] {
  const useEnglish = isEnglishLocale(locale);
  const currentLocale: "zh" | "en" = useEnglish ? "en" : "zh";
  return SIDEBAR.map((group) => ({
    ...group,
    title: useEnglish && group.titleEn ? group.titleEn : group.title,
    items: group.items
      .filter((item) => !item.availableLocales || item.availableLocales.includes(currentLocale))
      .map((item) => ({
        ...item,
        title: useEnglish && item.titleEn ? item.titleEn : item.title,
      })),
  })).filter((group) => group.items.length > 0);
}

/** 按侧栏顺序展平所有可点击 slug，用于上一篇 / 下一篇导航 */
export const FLAT_SLUGS: Array<{ slug: string; title: string }> = SIDEBAR.flatMap(
  (group) =>
    group.items
      .filter((item): item is DocItem & { slug: string } => item.slug !== null)
      .map((item) => ({ slug: item.slug, title: item.title })),
);

export function getLocalizedFlatSlugs(locale?: string): Array<{ slug: string; title: string }> {
  return getLocalizedSidebar(locale).flatMap((group) =>
    group.items
      .filter((item): item is DocItem & { slug: string } => item.slug !== null)
      .map((item) => ({ slug: item.slug, title: item.title })),
  );
}

export const DEFAULT_SLUG = "overview";
