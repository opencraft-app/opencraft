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
 *   - 国际站（GLOBAL_SIDEBAR）：WeChat / Telegram / WhatsApp / Discord / QQ / WeCom / Lark
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
  /**
   * 是否作为二级目录项（视觉上缩进）。
   * 用于在"配置通道"下挂具体通道（国内：微信/飞书/QQ；国际：WeChat/Telegram/...）。
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
      { slug: "plans", title: "套餐说明" },
      { slug: "credits", title: "体验积分说明" },
      { slug: "create-first-hermes", title: "如何开通第一个 Hermes 实例？" },
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
      { slug: "configuration/memory", title: "记忆管理" },
      { slug: "configuration/files", title: "云端文件管理" },
      { slug: "configuration/automation", title: "自动任务" },
      { slug: "configuration/diagnostics", title: "诊断中心" },
      { slug: "configuration/multiple-models", title: "多模型配置与切换" },
    ],
  },
  {
    title: "场景方案",
    items: [
      { slug: "use-cases/personal-ai-assistant", title: "如何用 LightVela 搭建个人 AI 助手？" },
      { slug: "use-cases/hermes-agent-24-7", title: "如何让 Hermes Agent 7x24 小时在线？" },
      { slug: "use-cases/chinese-messaging-channels", title: "如何把 AI Agent 接入微信 / QQ / 飞书？" },
      { slug: "use-cases/daily-summary", title: "如何用 Hermes Agent 做每日信息总结？" },
      { slug: "use-cases/memory-and-knowledge", title: "如何用 Agent 管理长期记忆和个人知识？" },
      { slug: "use-cases/work-assistant", title: "如何搭建一个工作助手？" },
    ],
  },
  {
    title: "对比与选型",
    items: [
      { slug: "compare/lightvela-vs-self-hosting-hermes", title: "LightVela 和自托管 Hermes Agent 有什么区别？" },
      { slug: "compare/cloud-vs-local-agent", title: "LightVela 和本地运行 Agent 有什么区别？" },
      { slug: "compare/ai-agent-vs-chatbot", title: "LightVela 和普通聊天机器人有什么区别？" },
      { slug: "compare/lightvela-vs-server-hosting", title: "使用 LightVela 还是自己买服务器部署？" },
      { slug: "compare/model-selection", title: "如何为 Hermes Agent 选择合适的模型？" },
    ],
  },
  {
    title: "问题排查",
    items: [
      { slug: "faq", title: "常见问题 FAQ" },
      { slug: "troubleshooting/agent-not-responding", title: "Agent 无响应怎么办？" },
      { slug: "troubleshooting/model-errors", title: "模型调用失败怎么办？" },
      { slug: "troubleshooting/channel-connection-failed", title: "微信 / QQ / 飞书通道连接失败怎么办？" },
      { slug: "troubleshooting/automation-not-running", title: "自动任务没有执行怎么办？" },
      { slug: "troubleshooting/skill-installation-failed", title: "技能安装失败怎么办？" },
      { slug: "troubleshooting/rebuild-hermes", title: "如何重建 Hermes？" },
    ],
  },
  {
    title: "进阶用法",
    items: [
      { slug: "advanced/models-skills-automation", title: "如何组合模型、技能和自动任务？" },
      { slug: "advanced/agent-workflow-design", title: "如何设计一个稳定的个人 Agent 工作流？" },
      { slug: "advanced/reduce-model-cost", title: "如何降低 Agent 的模型调用成本？" },
      { slug: "advanced/automation-fit", title: "如何判断一个任务适不适合交给 Agent 自动执行？" },
      { slug: "advanced/multi-channel-hermes", title: "多通道接入时如何管理同一个 Hermes？" },
    ],
  },
  {
    title: "联系与支持",
    items: [
      { slug: "contact-us", title: "联系我们" },
      { slug: "support/report-an-issue", title: "反馈问题时需要提供哪些信息？" },
    ],
  },
];

/** 国际站 sidebar：WeChat / Telegram / WhatsApp / Discord */
const GLOBAL_SIDEBAR: DocGroup[] = [
  {
    title: "开始使用",
    titleEn: "Getting Started",
    items: [
      { slug: "overview", title: "LightVela 是什么", titleEn: "What is LightVela" },
      { slug: "quickstart", title: "快速开始", titleEn: "Quickstart" },
      { slug: "core-concepts", title: "核心概念", titleEn: "Core Concepts" },
    ],
  },
  {
    title: "配置指南",
    titleEn: "Configuration Guide",
    items: [
      { slug: "configuration", title: "配置总览", titleEn: "Configuration Overview" },
      { slug: "configuration/model", title: "配置模型", titleEn: "Configure Models" },
      { slug: null, title: "配置通道", titleEn: "Configure Channels", defaultChildSlug: "configuration/channel-wechat" },
      { slug: "configuration/channel-wechat", title: "WeChat", indent: true },
      { slug: "configuration/channel-telegram", title: "Telegram", indent: true },
      { slug: "configuration/channel-whatsapp", title: "WhatsApp", indent: true },
      { slug: "configuration/channel-discord", title: "Discord", indent: true },
      { slug: "configuration/channel-qq", title: "QQ", indent: true },
      { slug: "configuration/channel-wecom", title: "企业微信", titleEn: "WeCom", indent: true },
      { slug: "configuration/channel-feishu", title: "飞书", titleEn: "Lark", indent: true },
      { slug: "configuration/skill", title: "配置技能", titleEn: "Configure Skills" },
      { slug: "configuration/automation", title: "自动任务", titleEn: "Automations" },
      { slug: "configuration/agent-chat", title: "对话", titleEn: "Chat" },
    ],
  },
  {
    title: "参考",
    titleEn: "Reference",
    items: [
      { slug: "faq", title: "常见问题 FAQ", titleEn: "FAQ" },
      {
        slug: "faq/using-lightvela-safely",
        title: "安全使用 LightVela",
        titleEn: "Using LightVela Safely",
      },
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
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/skill": "configuration/skill.md",
  "configuration/memory": "configuration/memory.md",
  "configuration/files": "configuration/files.md",
  "configuration/automation": "configuration/automation.md",
  "configuration/diagnostics": "configuration/diagnostics.md",
  "configuration/multiple-models": "configuration/multiple-models.md",
  // 场景方案
  "use-cases/personal-ai-assistant": "use-cases/personal-ai-assistant.md",
  "use-cases/hermes-agent-24-7": "use-cases/hermes-agent-24-7.md",
  "use-cases/chinese-messaging-channels": "use-cases/chinese-messaging-channels.md",
  "use-cases/daily-summary": "use-cases/daily-summary.md",
  "use-cases/memory-and-knowledge": "use-cases/memory-and-knowledge.md",
  "use-cases/work-assistant": "use-cases/work-assistant.md",
  // 对比与选型
  "compare/lightvela-vs-self-hosting-hermes": "compare/lightvela-vs-self-hosting-hermes.md",
  "compare/cloud-vs-local-agent": "compare/cloud-vs-local-agent.md",
  "compare/ai-agent-vs-chatbot": "compare/ai-agent-vs-chatbot.md",
  "compare/lightvela-vs-server-hosting": "compare/lightvela-vs-server-hosting.md",
  "compare/model-selection": "compare/model-selection.md",
  // 问题排查
  faq: "07-faq.md",
  "troubleshooting/agent-not-responding": "troubleshooting/agent-not-responding.md",
  "troubleshooting/model-errors": "troubleshooting/model-errors.md",
  "troubleshooting/channel-connection-failed": "troubleshooting/channel-connection-failed.md",
  "troubleshooting/automation-not-running": "troubleshooting/automation-not-running.md",
  "troubleshooting/skill-installation-failed": "troubleshooting/skill-installation-failed.md",
  "troubleshooting/rebuild-hermes": "troubleshooting/rebuild-hermes.md",
  // 进阶用法
  "advanced/models-skills-automation": "advanced/models-skills-automation.md",
  "advanced/agent-workflow-design": "advanced/agent-workflow-design.md",
  "advanced/reduce-model-cost": "advanced/reduce-model-cost.md",
  "advanced/automation-fit": "advanced/automation-fit.md",
  "advanced/multi-channel-hermes": "advanced/multi-channel-hermes.md",
  // 联系与支持
  "contact-us": "contact-us.md",
  "support/report-an-issue": "support/report-an-issue.md",
};

const GLOBAL_SLUG_TO_FILE: Record<string, string> = {
  overview: "01-overview.md",
  quickstart: "02-quickstart.md",
  "core-concepts": "04-core-concepts.md",
  configuration: "05-configuration.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-telegram": "configuration/channel-telegram.md",
  "configuration/channel-whatsapp": "configuration/channel-whatsapp.md",
  "configuration/channel-discord": "configuration/channel-discord.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/channel-wecom": "configuration/channel-wecom.md",
  "configuration/skill": "configuration/skill.md",
  "configuration/automation": "configuration/automation.md",
  "configuration/agent-chat": "configuration/agent-chat.md",
  faq: "07-faq.md",
  "faq/using-lightvela-safely": "faq/using-lightvela-safely.md",
  "contact-us": "contact-us.md",
};

export const SLUG_TO_FILE: Record<string, string> = isGlobal
  ? GLOBAL_SLUG_TO_FILE
  : CN_SLUG_TO_FILE;

export const isEnglishLocale = (locale?: string): boolean =>
  locale?.toLowerCase().startsWith("en") ?? false;

export function getLocalizedSidebar(locale?: string): DocGroup[] {
  const useEnglish = isEnglishLocale(locale);
  return SIDEBAR.map((group) => ({
    ...group,
    title: useEnglish && group.titleEn ? group.titleEn : group.title,
    items: group.items.map((item) => ({
      ...item,
      title: useEnglish && item.titleEn ? item.titleEn : item.title,
    })),
  }));
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
