/**
 * 文档侧边栏结构 + slug → markdown 文件映射。
 * 路由形态：
 *   /docs/:slug              例如 /docs/overview
 *   /docs/:category/:slug    例如 /docs/configuration/model
 *
 * 区域差异：
 *   按 AGENTS.md 第 252 行规范，国内 / 国际站 sidebar 用数组/常量驱动，按
 *   `isGlobal` 编译期切换数据源，terser 会消除未选中的一支为死代码。
 *   - 国内站（CN_SIDEBAR）：微信 / QQ / 企业微信 / 飞书 / 钉钉
 *   - 国际站（GLOBAL_SIDEBAR）：Telegram / WhatsApp / Discord / Slack / WeChat / QQ / WeCom / Lark
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
   * 用于在"配置通道"下挂具体通道（国内：微信/QQ/企业微信/飞书/钉钉；国际：Telegram/WhatsApp/...）。
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
 * 国内站 sidebar：优先展示从开通到使用、排障的任务路径。
 * 通道具体项挂在「配置通道」表头下作为二级项；原理与场景长文保留独立分类。
 */
const CN_SIDEBAR: DocGroup[] = [
  {
    title: "开始使用",
    items: [
      { slug: "overview", title: "LightVela 是什么" },
      { slug: "quickstart", title: "快速开始" },
      { slug: "create-first-hermes", title: "开通第一个 Hermes Agent" },
      { slug: "core-concepts", title: "核心概念" },
      { slug: "who-is-lightvela-for", title: "LightVela 适合哪些人使用？" },
      { slug: "account", title: "账号与实名认证" },
      { slug: "plans", title: "套餐管理" },
      { slug: "credits", title: "AI 积分说明" },
    ],
  },
  {
    title: "Bot 与模型",
    items: [
      { slug: "configuration", title: "配置总览" },
      { slug: "configuration/bots-switching", title: "管理与切换 Bot" },
      { slug: "configuration/agent-chat", title: "网页对话" },
      { slug: "configuration/model", title: "配置模型" },
      { slug: "configuration/multiple-models", title: "模型切换" },
    ],
  },
  {
    title: "成长",
    items: [
      { slug: "configuration/personality", title: "人设" },
      { slug: "configuration/memory", title: "记忆管理" },
      { slug: "configuration/achievements", title: "成就" },
    ],
  },
  {
    title: "通道与技能",
    items: [
      // "配置通道" 作为一级分组表头，点击跳转到第一个子项（微信）
      { slug: null, title: "配置通道", defaultChildSlug: "configuration/channel-wechat" },
      { slug: "configuration/channel-wechat", title: "微信", indent: true },
      { slug: "configuration/channel-qq", title: "QQ", indent: true },
      { slug: "configuration/channel-wecom", title: "企业微信", indent: true },
      { slug: "configuration/channel-feishu", title: "飞书", indent: true },
      { slug: "configuration/channel-dingtalk", title: "钉钉", indent: true },
      { slug: "configuration/skill", title: "配置技能" },
    ],
  },
  {
    title: "自动化与资料",
    items: [
      { slug: "configuration/automation", title: "定时任务" },
      { slug: "configuration/files", title: "云存储" },
    ],
  },
  {
    title: "管理与排障",
    items: [
      { slug: "configuration/diagnostics", title: "诊断中心" },
      { slug: "configuration/advanced-settings", title: "高级设置" },
      { slug: "faq", title: "常见问题 FAQ" },
      { slug: "contact-us", title: "联系我们" },
    ],
  },
  {
    title: "实验功能",
    items: [
      { slug: "configuration/deepseek-harness", title: "DeepSeek Harness" },
      { slug: "configuration/workbench", title: "我的工作台" },
    ],
  },
  {
    title: "场景方案",
    items: [
      { slug: "use-cases/scheduled-task-agent", title: "使用 LightVela 自动化 Agent 任务" },
      { slug: "use-cases/scheduled-task-notifications", title: "在 LightVela 中设置通知任务" },
      { slug: "use-cases/scheduled-task-script", title: "在 LightVela 中运行脚本任务" },
    ],
  },
  {
    title: "对比与选型",
    items: [
      { slug: "compare/lightvela-vs-manus", title: "LightVela vs Manus" },
      { slug: "compare/lightvela-vs-localhost-ai-agent", title: "LightVela vs 本地部署 Agent" },
      { slug: "compare/lightvela-vs-ai-chatbot", title: "LightVela vs AI Chatbot" },
    ],
  },
  {
    title: "Hermes Agent 解读",
    items: [
      { slug: "hermes-agent/hermes-vs-openclaw", title: "Hermes Agent 与 OpenClaw 有什么不同？" },
      { slug: "hermes-agent/why-hermes-remembers-you", title: "Hermes Agent 为什么能记住你？" },
      { slug: "hermes-agent/user-md-vs-memory-md", title: "为什么 Hermes Agent 要把记忆分成两类？" },
      { slug: "hermes-agent/hermes-memory-curation", title: "记忆不是越多越好" },
      { slug: "hermes-agent/memory-vs-skill", title: "Memory 不是 Skill" },
      { slug: "hermes-agent/model-vs-agent-layer", title: "模型层与 Agent 层如何分工" },
      { slug: "hermes-agent/message-gateway", title: "一个 Agent 如何同时出现在多个聊天软件里？" },
      { slug: "hermes-agent/automation-scheduling", title: "Hermes Agent 如何按时主动找你？" },
      { slug: "hermes-agent/model-switching-memory", title: "切换模型会让 Agent 失忆吗？" },
      { slug: "hermes-agent/persona-user-memory", title: "Hermes Agent 的性格从哪里来？" },
      { slug: "hermes-agent/workspace-context-storage", title: "Hermes Agent 把文件放在哪里？" },
      { slug: "hermes-agent/skills-self-improvement", title: "Agent 为什么会越用越顺手？" },
    ],
  },
];

/**
 * 国际站 sidebar：按 GEO 导航方案组织为 9 大分组。
 * 通道顺序固定为 Telegram / WhatsApp / Discord / Slack / WeChat / QQ / WeCom / Lark。
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
      { slug: "credits", title: "体验积分说明", titleEn: "Credits" },
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
      { slug: "configuration/bots", title: "管理 Bots", titleEn: "Manage Bots" },
      { slug: "configuration/model", title: "配置模型", titleEn: "Configure Models" },
      { slug: null, title: "配置通道", titleEn: "Configure Channels", defaultChildSlug: "configuration/channel-telegram" },
      { slug: "configuration/channel-telegram", title: "Telegram", titleEn: "Telegram", indent: true },
      { slug: "configuration/channel-whatsapp", title: "WhatsApp", titleEn: "WhatsApp", indent: true },
      { slug: "configuration/channel-discord", title: "Discord", titleEn: "Discord", indent: true },
      { slug: "configuration/channel-slack", title: "Slack", titleEn: "Slack", indent: true },
      { slug: "configuration/channel-wechat", title: "WeChat", titleEn: "WeChat", indent: true },
      { slug: "configuration/channel-qq", title: "QQ", titleEn: "QQ", indent: true },
      { slug: "configuration/channel-wecom", title: "企业微信", titleEn: "WeCom", indent: true },
      { slug: "configuration/channel-feishu", title: "飞书", titleEn: "Lark", indent: true },
      { slug: "configuration/skill", title: "配置技能", titleEn: "Configure Skills" },
      { slug: "configuration/personality", title: "人设", titleEn: "Souls" },
      { slug: "configuration/achievements", title: "成就", titleEn: "Achievements" },
      { slug: "configuration/memory", title: "记忆管理", titleEn: "Memory Management" },
      { slug: "configuration/automation", title: "定时任务", titleEn: "Scheduled Tasks" },
      { slug: "configuration/files", title: "云存储", titleEn: "Cloud Storage" },
      { slug: "configuration/agent-chat", title: "对话", titleEn: "Chat" },
      { slug: "configuration/diagnostics", title: "诊断中心", titleEn: "Diagnostics" },
      { slug: "configuration/advanced-settings", title: "高级设置", titleEn: "Advanced Settings" },
      {
        slug: "configuration/multiple-models",
        title: "模型切换",
        titleEn: "Model Switching",
      },
      {
        slug: "configuration/bots-switching",
        title: "Bot 切换",
        titleEn: "Bots Switching",
      },
      {
        slug: "configuration/deepseek-harness",
        title: "DeepSeek Harness",
        titleEn: "DeepSeek Harness",
      },
      {
        slug: "configuration/workbench",
        title: "工作台",
        titleEn: "Workbench",
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
        slug: "use-cases/telegram-persona-agent",
        title: "如何在 Telegram 中配置一个具有独立人格的 Hermes Agent？",
        titleEn: "How to Configure a Hermes Agent with a Distinct Personality in Telegram",
      },
      {
        slug: "use-cases/whatsapp-persona-agent",
        title: "如何在 WhatsApp 中配置一个具有独立人格的 Hermes Agent？",
        titleEn: "How to Configure a Hermes Agent with a Distinct Personality in WhatsApp",
      },
      {
        slug: "use-cases/im-agent-persona-soul-md",
        title: "如何通过 SOUL.md 设定 IM Agent 的角色、性格与说话方式？",
        titleEn: "How to Define an IM Agent's Role, Personality, and Voice with SOUL.md",
      },
      {
        slug: "use-cases/multi-channel-personality-memory",
        title: "如何让一个 Agent 同时接入 Telegram 和 WhatsApp，并保持统一人格与长期记忆？",
        titleEn: "How to Connect One Agent to Telegram and WhatsApp While Keeping One Personality and Long-Term Memory",
      },
      {
        slug: "use-cases/telegram-group-community-assistant",
        title: "如何使用 Telegram 群组 AI 社群助手：问答、摘要与提醒？",
        titleEn: "How to Use a Telegram Group AI Community Assistant: Q&A, Summaries, and Reminders",
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
      {
        slug: "use-cases/discord-community-agent",
        title: "Meet LightVela for Discord：服务你所在频道的 AI Agent Discord Bot",
        titleEn: "Meet LightVela for Discord: Your AI Agent Discord Bot Serving Your Channel",
      },
      {
        slug: "use-cases/discord-event-agent",
        title: "如何用 AI Agent 能力增强 Discord 活动机器人？",
        titleEn: "Empower your Discord Event Bot with AI-Agentic Capabilities",
        indent: true,
      },
      {
        slug: "use-cases/scheduled-task-agent",
        title: "使用 LightVela 自动化 Agent 任务",
        titleEn: "Automating Agent Task with LightVela",
      },
      {
        slug: "use-cases/scheduled-task-notifications",
        title: "在 LightVela 中设置通知任务",
        titleEn: "Setting Notification Task in LightVela",
      },
      {
        slug: "use-cases/scheduled-task-script",
        title: "在 LightVela 中运行脚本任务",
        titleEn: "Running Script Task in LightVela",
      },
    ],
  },
  {
    title: "Hermes Agent 深度解读",
    titleEn: "Hermes Agent Deep Dive",
    items: [
      { slug: "hermes-agent/hermes-vs-openclaw", title: "Hermes Agent 与 OpenClaw 有什么不同？", titleEn: "How Hermes Agent Differs from OpenClaw" },
      { slug: "hermes-agent/why-hermes-remembers-you", title: "Hermes Agent 为什么能记住你？", titleEn: "Why Hermes Agent Remembers You" },
      { slug: "hermes-agent/user-md-vs-memory-md", title: "为什么 Hermes Agent 要把记忆分成两类？", titleEn: "Why Hermes Agent Splits Memory in Two" },
      { slug: "hermes-agent/hermes-memory-curation", title: "记忆不是越多越好", titleEn: "Why More Memory Is Not Better" },
      { slug: "hermes-agent/memory-vs-skill", title: "Memory 不是 Skill", titleEn: "Memory Is Not a Skill" },
      { slug: "hermes-agent/model-vs-agent-layer", title: "模型层与 Agent 层如何分工", titleEn: "Model Layer vs Agent Layer" },
      { slug: "hermes-agent/message-gateway", title: "一个 Agent 如何同时出现在多个聊天软件里？", titleEn: "One Agent Across Messaging Apps" },
      { slug: "hermes-agent/automation-scheduling", title: "Hermes Agent 如何按时主动找你？", titleEn: "How Hermes Agent Reaches You on Schedule" },
      { slug: "hermes-agent/model-switching-memory", title: "切换模型会让 Agent 失忆吗？", titleEn: "Will Switching Models Make an Agent Forget?" },
      { slug: "hermes-agent/persona-user-memory", title: "Hermes Agent 的性格从哪里来？", titleEn: "Where Hermes Agent's Personality Comes From" },
      { slug: "hermes-agent/workspace-context-storage", title: "Hermes Agent 把文件放在哪里？", titleEn: "Where Hermes Agent Puts Files" },
      { slug: "hermes-agent/skills-self-improvement", title: "Agent 为什么会越用越顺手？", titleEn: "Why an Agent Gets Better with Use" },
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
      { slug: "compare/lightvela-vs-grok-bot", title: "LightVela vs Grok Bot", titleEn: "LightVela vs Grok Bot" },
      { slug: "compare/lightvela-vs-mira", title: "LightVela vs Mira", titleEn: "LightVela vs Mira" },
      { slug: "compare/lightvela-vs-viktor", title: "LightVela vs Viktor.com", titleEn: "LightVela vs Viktor.com" },
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
  // 开始使用
  overview: "01-overview.md",
  quickstart: "02-quickstart.md",
  "core-concepts": "04-core-concepts.md",
  "who-is-lightvela-for": "who-is-lightvela-for.md",
  // 开始使用：账号与开通
  account: "03-account.md",
  plans: "plans.md",
  credits: "credits.md",
  "create-first-hermes": "create-first-hermes.md",
  // Bot 与模型、通道与技能、自动化与资料、管理与排障、实验功能
  configuration: "05-configuration.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/channel-wecom": "configuration/channel-wecom.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/channel-dingtalk": "configuration/channel-dingtalk.md",
  "configuration/skill": "configuration/skill.md",
  "configuration/personality": "configuration/personality.md",
  "configuration/memory": "configuration/memory.md",
  "configuration/automation": "configuration/automation.md",
  "configuration/files": "configuration/files.md",
  "configuration/agent-chat": "configuration/agent-chat.md",
  "configuration/diagnostics": "configuration/diagnostics.md",
  "configuration/advanced-settings": "configuration/advanced-settings.md",
  "configuration/multiple-models": "configuration/multiple-models.md",
  "configuration/bots-switching": "configuration/bots-switching.md",
  "configuration/achievements": "configuration/achievements.md",
  "configuration/deepseek-harness": "configuration/deepseek-harness.md",
  "configuration/workbench": "configuration/workbench.md",
  "use-cases/scheduled-task-agent": "use-cases/scheduled-task-agent.md",
  "use-cases/scheduled-task-notifications": "use-cases/scheduled-task-notifications.md",
  "use-cases/scheduled-task-script": "use-cases/scheduled-task-script.md",
  // 管理与排障
  faq: "07-faq.md",
  // 管理与排障：支持
  "contact-us": "contact-us.md",
  // 对比与选型
  "compare/lightvela-vs-manus": "compare/lightvela-vs-manus.md",
  "compare/lightvela-vs-localhost-ai-agent": "compare/lightvela-vs-localhost-ai-agent.md",
  "compare/lightvela-vs-ai-chatbot": "compare/lightvela-vs-ai-chatbot.md",
  // Hermes Agent 解读
  "hermes-agent/hermes-vs-openclaw": "hermes-agent/01-hermes-vs-openclaw.md",
  "hermes-agent/why-hermes-remembers-you": "hermes-agent/02-why-hermes-remembers-you.md",
  "hermes-agent/user-md-vs-memory-md": "hermes-agent/03-user-md-vs-memory-md.md",
  "hermes-agent/hermes-memory-curation": "hermes-agent/04-hermes-memory-curation.md",
  "hermes-agent/memory-vs-skill": "hermes-agent/05-memory-vs-skill.md",
  "hermes-agent/model-vs-agent-layer": "hermes-agent/06-model-vs-agent-layer.md",
  "hermes-agent/message-gateway": "hermes-agent/07-message-gateway.md",
  "hermes-agent/automation-scheduling": "hermes-agent/08-automation-scheduling.md",
  "hermes-agent/model-switching-memory": "hermes-agent/09-model-switching-memory.md",
  "hermes-agent/persona-user-memory": "hermes-agent/10-persona-user-memory.md",
  "hermes-agent/workspace-context-storage": "hermes-agent/11-workspace-context-storage.md",
  "hermes-agent/skills-self-improvement": "hermes-agent/12-skills-self-improvement.md",
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
  "configuration/bots": "configuration/bots.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-telegram": "configuration/channel-telegram.md",
  "configuration/channel-whatsapp": "configuration/channel-whatsapp.md",
  "configuration/channel-discord": "configuration/channel-discord.md",
  "configuration/channel-slack": "configuration/channel-slack.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/channel-wecom": "configuration/channel-wecom.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/skill": "configuration/skill.md",
  "configuration/personality": "configuration/personality.md",
  "configuration/memory": "configuration/memory.md",
  "configuration/files": "configuration/files.md",
  "configuration/automation": "configuration/automation.md",
  "configuration/diagnostics": "configuration/diagnostics.md",
  "configuration/advanced-settings": "configuration/advanced-settings.md",
  "configuration/multiple-models": "configuration/multiple-models.md",
  "configuration/bots-switching": "configuration/bots-switching.md",
  "configuration/achievements": "configuration/achievements.md",
  "configuration/deepseek-harness": "configuration/deepseek-harness.md",
  "configuration/workbench": "configuration/workbench.md",
  "configuration/agent-chat": "configuration/agent-chat.md",
  "use-cases/personal-ai-assistant": "use-cases/personal-ai-assistant.md",
  "use-cases/chinese-messaging-channels": "use-cases/chinese-messaging-channels.md",
  "use-cases/telegram-persona-agent": "use-cases/telegram-persona-agent.md",
  "use-cases/whatsapp-persona-agent": "use-cases/whatsapp-persona-agent.md",
  "use-cases/im-agent-persona-soul-md": "use-cases/im-agent-persona-soul-md.md",
  "use-cases/multi-channel-personality-memory": "use-cases/multi-channel-personality-memory.md",
  "use-cases/telegram-group-community-assistant": "use-cases/telegram-group-community-assistant.md",
  "use-cases/daily-summary": "use-cases/daily-summary.md",
  "use-cases/hermes-agent-24-7": "use-cases/hermes-agent-24-7.md",
  "use-cases/memory-and-knowledge": "use-cases/memory-and-knowledge.md",
  "use-cases/discord-community-agent": "use-cases/discord-community-agent.md",
  "use-cases/discord-event-agent": "use-cases/discord-event-agent.md",
  "use-cases/scheduled-task-agent": "use-cases/scheduled-task-agent.md",
  "use-cases/scheduled-task-notifications": "use-cases/scheduled-task-notifications.md",
  "use-cases/scheduled-task-script": "use-cases/scheduled-task-script.md",
  "hermes-agent/hermes-vs-openclaw": "hermes-agent/01-hermes-vs-openclaw.md",
  "hermes-agent/why-hermes-remembers-you": "hermes-agent/02-why-hermes-remembers-you.md",
  "hermes-agent/user-md-vs-memory-md": "hermes-agent/03-user-md-vs-memory-md.md",
  "hermes-agent/hermes-memory-curation": "hermes-agent/04-hermes-memory-curation.md",
  "hermes-agent/memory-vs-skill": "hermes-agent/05-memory-vs-skill.md",
  "hermes-agent/model-vs-agent-layer": "hermes-agent/06-model-vs-agent-layer.md",
  "hermes-agent/message-gateway": "hermes-agent/07-message-gateway.md",
  "hermes-agent/automation-scheduling": "hermes-agent/08-automation-scheduling.md",
  "hermes-agent/model-switching-memory": "hermes-agent/09-model-switching-memory.md",
  "hermes-agent/persona-user-memory": "hermes-agent/10-persona-user-memory.md",
  "hermes-agent/workspace-context-storage": "hermes-agent/11-workspace-context-storage.md",
  "hermes-agent/skills-self-improvement": "hermes-agent/12-skills-self-improvement.md",
  "compare/lightvela-vs-manus": "compare/lightvela-vs-manus.md",
  "compare/lightvela-vs-hostinger": "compare/lightvela-vs-hostinger.md",
  "compare/lightvela-vs-localhost-ai-agent": "compare/lightvela-vs-localhost-ai-agent.md",
  "compare/lightvela-vs-chatgpt": "compare/lightvela-vs-chatgpt.md",
  "compare/lightvela-vs-genspark": "compare/lightvela-vs-genspark.md",
  "compare/lightvela-vs-grok-bot": "compare/lightvela-vs-grok-bot.md",
  "compare/lightvela-vs-mira": "compare/lightvela-vs-mira.md",
  "compare/lightvela-vs-viktor": "compare/lightvela-vs-viktor.md",
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
