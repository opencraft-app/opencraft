export type SeoRegion = "cn" | "global";

export interface SeoMeta {
  title: string;
  description: string;
  keywords: string;
}

/**
 * 完整 SEO 元数据：覆盖 title/description/keywords 之外的全部 head 字段，
 * 供 Next metadata、dev 中间件与客户端运行时同步共用同一份数据契约。
 *
 * 字段含义：
 *   - htmlLang：用于 `<html lang>`，影响搜索引擎语种判定 / 屏幕阅读器朗读语言。
 *   - canonical：完整 URL（含 origin），防止 query / 大小写 / 末尾斜杠造成的重复内容收录。
 *   - robots：`indexable=false` 时输出 `noindex,nofollow`，用于 /auth、/account 等私域路径。
 *   - og*：Open Graph 元数据（微信、Facebook、LinkedIn 等社交平台分享卡）。
 *   - twitterCard：Twitter Card 类型，固定 `summary_large_image`。
 *   - ogImage：分享卡缩略图绝对 URL（必须是绝对地址，社交爬虫不解析相对路径）。
 */
export interface FullSeoMeta extends SeoMeta {
  htmlLang: string;
  canonical: string;
  robots: "index,follow" | "noindex,nofollow";
  ogTitle: string;
  ogDescription: string;
  ogUrl: string;
  ogImage: string;
  ogLocale: string;
  ogSiteName: string;
  ogType: "website";
  twitterCard: "summary_large_image";
  twitterTitle: string;
  twitterDescription: string;
  twitterImage: string;
}

export interface FullSeoMetaOptions {
  /** 站点 origin（不含末尾 `/`），如 `https://lightvela.com`。 */
  siteUrl?: string;
  /** 是否允许搜索引擎收录；默认 true。私域路径（/auth/*、/account/*）应传 false。 */
  indexable?: boolean;
  /** 分享卡缩略图相对路径，默认 `/lightvela-social-preview.png`。 */
  ogImagePath?: string;
}

/**
 * 站点级常量：lang / locale / siteName / titleSuffix / 默认 origin / 默认分享图。
 * 站点级常量：lang / locale / siteName / titleSuffix / 默认 origin / 默认分享图。
 */
const SITE_BY_REGION = {
  cn: {
    htmlLang: "zh-CN",
    locale: "zh_CN",
    siteName: "LightVela",
    defaultUrl: "https://lightvela.com",
  },
  global: {
    htmlLang: "en-US",
    locale: "en_US",
    siteName: "LightVela",
    defaultUrl: "https://lightvela.ai",
  },
} as const;

/** 私域路径：默认 `noindex,nofollow`。匹配采用前缀匹配。 */
const NON_INDEXABLE_PREFIXES = [
  "/auth/",
  "/account",
  "/dashboard",
  "/settings",
  "/tat/",
  "/internal/",
  "/console",
  "/openclaw",
  "/subscribe",
  "/plans/",
  "/agents",
  "/bots/",
];

const DEFAULT_OG_IMAGE_PATH = "/lightvela-social-preview.png";

/* ──────────────────────────────────────────────────────────────
 * 区域差异（国内 cn / 国际 global）
 * ──────────────────────────────────────────────────────────────
 * 规范格式：
 *   - 首页：           `${DEFAULT_SEO_TITLE}`
 *   - 其余页面：       `${页面标题} | ${SEO_TITLE_SUFFIX}`
 *   - 国内站标题中文，国际站标题英文。
 *
 * 说明：本模块同时被两类上下文使用——
 *   1. 浏览器运行时（src/lib/seo.ts，编译期已知 region）
 *   2. Node 侧 SEO 校验/修正脚本（按参数显式传入 region）
 * 因此不在模块顶层依赖 `import.meta.env`，region 一律以参数显式传入，
 * 缺省回退到 "cn"，避免 config 加载阶段解析 `@/` alias / import.meta 失败。
 */

const DEFAULT_SEO_TITLE_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela｜云端专属个人 Agent",
  global: "LightVela | Your Personal Cloud AI Agent",
};

const SEO_TITLE_SUFFIX_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela 云端专属个人 Agent",
  global: "LightVela · Your Personal Cloud AI Agent",
};

const SEO_DESCRIPTION_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴——不是每次打开都要重新自我介绍的工具，而是认识你、记得你、越聊越懂你的长期存在。",
  global:
    "LightVela is a cloud Agent hosting product from the Tencent Lighthouse team. It is designed to let everyone own an AI companion that truly belongs to them—not a tool that asks you to introduce yourself every time, but a long-term presence that knows you, remembers you, and understands you better over time.",
};

const SEO_KEYWORDS_BY_REGION: Record<SeoRegion, string> = {
  cn: [
    "LightVela",
    "LightVela Agent",
    "云端 Agent",
    "个人 Agent",
    "AI 伙伴",
    "腾讯轻量云",
    "Agent 托管",
    "长期记忆",
    "个性化 AI",
    "Hermes Agent",
    "OpenClaw",
    "智能助手",
    "AI 助手",
    "自动任务",
    "多渠道接入",
    "QQ 机器人",
    "微信 Agent",
    "企业微信 Agent",
    "飞书 Agent",
    "AI 陪伴",
    "个人智能体",
  ].join(", "),
  global: [
    "LightVela",
    "LightVela Agent",
    "cloud AI agent",
    "personal AI agent",
    "AI companion",
    "Tencent Cloud",
    "agent hosting",
    "long-term memory",
    "personalized AI",
    "Hermes Agent",
    "OpenClaw",
    "AI assistant",
    "automations",
    "multi-channel",
    "WeChat agent",
    "Telegram bot",
    "WhatsApp bot",
    "Discord bot",
    "personal agent",
  ].join(", "),
};

/**
 * 页面级 description 覆盖表：仅列出需要"按页面内容定制 description"的路径。
 *
 * 设计原则：
 *   - 命中表中路径 → 使用页面级 description（更贴合页面主题，搜索引擎摘要更精准）
 *   - 未命中 → 回退到 SEO_DESCRIPTION_BY_REGION（全站默认）
 *   - keywords 不分页面，全站统一（SEO_KEYWORDS_BY_REGION）
 *
 * 字段长度约束：建议 120-180 字（中文）/ 140-180 chars（英文），太短信息量不
 * 足，太长会被搜索引擎截断。
 */
const PAGE_DESCRIPTIONS_BY_REGION: Record<SeoRegion, Record<string, string>> = {
  cn: {
    "/about":
      "LightVela 由腾讯轻量云团队打造，源于对「AI 该长成什么样」的反复思考——我们相信 AI 不应只是冷冰冰的工具，而应是认识你、记得你、越聊越懂你的长期伙伴。",
    "/changelog":
      "记录 LightVela 的产品更新、能力上线与体验改进，了解云存储、成就模块、网页对话、记忆查看与自动任务等最新迭代。",

    // 文档首页与综述页
    "/docs":
      "LightVela 产品文档：包含快速开始、核心概念、模型 / 通道 / 技能配置指南，以及常见问题 FAQ。",
    "/docs/overview":
      "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，主打 Hermes Agent，让每个人都能拥有真正属于自己、长期在线、越聊越懂你的 AI 伙伴。",
    "/docs/quickstart":
      "5 分钟从登录、实名认证、开通启航套餐、创建 Hermes 实例到接入微信通道，完成第一次 AI 对话的完整教程。",
    "/docs/account":
      "了解 LightVela 的账号体系、登录方式（QQ / 微信）、实名认证流程、账号信息页结构，以及退出登录与注销说明。",
    "/docs/plans":
      "LightVela 套餐管理文档：查看启航 Launch、巡游 Cruise、启航 Launch AI、巡游 Cruise AI 的权益与标准原价，了解续费流程、套餐生命周期和腾讯云智能客服退款规则。",
    "/docs/credits":
      "LightVela AI 积分（Credits）是计量 Hermes Agent 模型调用消耗的额度单位，随套餐按月发放、按 Token 消耗。本页说明积分定义、换算、发放、消耗方式及与套餐的关系。",
    "/docs/create-first-hermes":
      "开通第一个 Hermes 实例的完整流程：登录账号、完成实名认证、选择并开通套餐、平台自动创建实例，再配置模型与通道，让你的云端 AI Agent 7×24 小时在线运行。",
    "/docs/core-concepts":
      "LightVela 的四大核心概念：Hermes、模型、通道、技能。本页解释四者关系，以及一次完整 AI 对话的内部流程。",
    "/docs/who-is-lightvela-for":
      "LightVela 适合想拥有长期在线、越聊越懂你的专属 AI 伙伴，却不想碰服务器、容器和 API 鉴权的用户。本页梳理目标用户画像、典型使用场景与前置条件。",
    "/docs/configuration":
      "Hermes 管理台配置总览：模型 / 通道 / 技能三大配置卡片的功能与入口，以及切换模型、接入多个通道、重建 Hermes 等常用操作。",
    "/docs/configuration/model":
      "为 Hermes 配置大语言模型：Coding Plan / API / 自定义模型三种方式的差异，API Key 获取，支持的模型列表与选型建议。",
    "/docs/configuration/channel-wechat":
      "微信通道接入指南：在 LightVela 生成二维码 → 手机微信扫码授权 → 在微信中与 Hermes 对话。所有通道中配置最简单的一种。",
    "/docs/configuration/channel-feishu":
      "飞书通道接入指南：扫码授权方式接入，适用于办公场景，支持富文本消息与群聊 @机器人。",
    "/docs/configuration/channel-qq":
      "QQ 通道接入指南：在 QQ 开放平台创建机器人、获取 AppID 与 AppSecret、填入 LightVela 完成接入，约 5–10 分钟。",
    "/docs/configuration/skill":
      "为 Hermes 配置技能（Skills）：基于腾讯 SkillHub 的可调用能力包，覆盖待办整理、日报、网页浏览、新闻搜索、图像生成等，支持管理台与对话两种安装方式。",
    "/docs/faq":
      "LightVela 使用过程中的常见问题汇总：账号登录、实名认证、套餐积分、模型与通道配置、对话与记忆机制等。",
  },
  global: {
    "/about":
      "Built by the Tencent Lighthouse team, LightVela was born from a question: what should AI become? We believe AI should not be just a cold tool, but a long-term presence that knows you, remembers you, and grows with you.",
    "/changelog":
      "Track LightVela product updates, new capabilities, and experience improvements, including cloud storage, achievements, web chat, memory views, and automations.",

    // Docs index & overview
    "/docs":
      "LightVela product documentation: quickstart, core concepts, model / channel / skill configuration guides, and FAQ.",
    "/docs/overview":
      "LightVela is a cloud Agent hosting product from the Tencent Lighthouse team, built around Hermes Agent — a personal AI companion that stays online 24/7, knows you, remembers you, and understands you better over time.",
    "/docs/quickstart":
      "A 5-minute walkthrough: sign in, activate the starter plan, create your Hermes instance, connect a channel (WeChat / Telegram / WhatsApp / Discord) and have your first AI conversation.",
    "/docs/plans":
      "Compare LightVela's Launch and Cruise plans for isolated Hermes runtime resources, storage, monthly credits, paid plan availability, and the new-user 14-day Launch trial.",
    "/docs/announcements/public-beta":
      "LightVela plans to enter public beta and start billing on August 18, 2026 (Singapore Time). Beta users get one additional month on their existing plan, and new users can try Launch free for 14 days after public beta and billing start.",
    "/docs/credits":
      "Learn how LightVela model credits measure Hermes usage across conversations, automations, skills, and supported messaging channels. Credits are included with plans; check Subscribe for current availability and the latest options.",
    "/docs/create-first-hermes":
      "Activate your first Hermes instance: sign in with Google or GitHub, choose an available plan on Subscribe, and let LightVela provision it. International beta access is limited and free while available, with no China real-name verification required.",
    "/docs/core-concepts":
      "LightVela's four core concepts: Hermes, Models, Channels, and Skills. This page explains how they relate and what happens inside a single conversation.",
    "/docs/who-is-lightvela-for":
      "Discover whether LightVela is right for you: a cloud-hosted personal AI Agent with long-term memory and channels including Telegram, WhatsApp, Discord, and WeChat. Sign in with Google or GitHub; no China real-name verification is required.",
    "/docs/configuration":
      "Overview of the Hermes admin console: the three configuration cards (Models / Channels / Skills), their entry points, and common operations like switching models, connecting multiple channels, and rebuilding Hermes.",
    "/docs/configuration/model":
      "Configure a large language model for Hermes: differences between Coding Plan / API / Custom Model, how to obtain API keys, the list of supported models, and selection guidance.",
    "/docs/configuration/channel-wechat":
      "WeChat channel setup guide: generate a QR code in LightVela, scan it with WeChat to authorize, and start chatting with Hermes — the simplest channel to onboard.",
    "/docs/configuration/channel-telegram":
      "Telegram channel setup guide: create a Telegram bot via BotFather, paste the token into LightVela, and start chatting with Hermes inside Telegram.",
    "/docs/configuration/channel-whatsapp":
      "WhatsApp channel setup guide: connect Hermes to WhatsApp, complete authorization, and start a conversation through your WhatsApp account.",
    "/docs/configuration/channel-discord":
      "Discord channel setup guide: register a bot in the Discord Developer Portal, paste the token into LightVela, invite the bot to your server, and chat with Hermes.",
    "/docs/configuration/channel-qq":
      "QQ channel setup guide: register a bot on the QQ Open Platform, obtain AppID and AppSecret, fill them into LightVela — total time around 5–10 minutes.",
    "/docs/configuration/channel-wecom":
      "WeCom (Enterprise WeChat) channel setup guide: configure a WeCom application, fill in the credentials in LightVela, and connect Hermes to your WeCom workspace.",
    "/docs/configuration/channel-feishu":
      "Lark (Feishu) channel setup guide: scan-to-authorize onboarding for office scenarios, with rich-text messages and group @mentions of the bot.",
    "/docs/configuration/skill":
      "Configure Skills for Hermes: callable capability packs from Tencent SkillHub, covering to-do management, daily reports, web browsing, news search, image generation and more — installable from the admin console or directly inside chat.",
    "/docs/configuration/memory":
      "Learn how Hermes stores persistent memory and user profile information, reviews memory usage, and keeps context available across conversations.",
    "/docs/configuration/files":
      "Use Cloud Storage in LightVela to browse, upload, download, rename, and delete files in your Hermes workspace.",
    "/docs/configuration/diagnostics":
      "Use Diagnostics to query Hermes logs and run maintenance actions such as resetting model configuration or reinstalling the Agent while preserving data.",
    "/docs/configuration/multiple-models":
      "Switch between configured models in LightVela when you need a different balance of capability, speed, cost, or provider availability.",
    "/docs/configuration/automation":
      "Set up Hermes automations: schedule recurring tasks (reminders, daily reports, news tracking, content publishing) by time or trigger, with templates and lifecycle management.",
    "/docs/configuration/agent-chat":
      "Talk to Hermes in the Chat page: long-term memory accumulation, MEMORY.md / USER.md split, and how Hermes evolves with every conversation.",
    "/docs/faq":
      "Common questions about using LightVela: sign-in, identity verification, plan credits, model and channel configuration, conversation and memory mechanics.",
  },
};

const STATIC_PAGE_TITLES_BY_REGION: Record<SeoRegion, Record<string, string>> = {
  cn: {
    "/about": "关于我们",
    "/changelog": "更新日志",
    "/privacy-policy": "隐私政策",
    "/cookie-policy": "Cookies 政策",
    "/open-source-licenses": "开源声明",
    "/dashboard/create": "创建 Agent",
    "/subscribe": "订阅套餐",
    "/dashboard/setup": "初始化设置",
    "/dashboard/success": "创建成功",
    "/account": "个人中心",
    "/account/orders": "订单列表",
    "/tat/device-bind": "设备绑定",
    "/auth/wechat-pay": "微信支付",
    "/auth/email-bind-result": "邮箱绑定结果",
    "/auth/sign-in": "登录",
    "/auth/sign-up": "注册",
    "/auth/sign-up-code": "输入验证码",
    "/auth/invite": "邀请码",
    "/auth/forgot-password": "找回密码",
    "/plans/select": "选择套餐",
    "/settings/account": "账号设置",
    "/internal/style-lab": "设计系统",
  },
  global: {
    "/about": "About LightVela",
    "/changelog": "Changelog",
    "/privacy-policy": "Privacy Policy",
    "/cookie-policy": "Cookie Policy",
    "/open-source-licenses": "Open Source Licenses",
    "/dashboard/create": "Create Agent",
    "/subscribe": "Subscribe",
    "/dashboard/setup": "Setup",
    "/dashboard/success": "Created",
    "/account": "Account",
    "/account/orders": "Orders",
    "/tat/device-bind": "Device Binding",
    "/auth/wechat-pay": "WeChat Pay",
    "/auth/email-bind-result": "Email Binding Result",
    "/auth/sign-in": "Sign In",
    "/auth/sign-up": "Sign Up",
    "/auth/sign-up-code": "Verify Code",
    "/auth/invite": "Invite Code",
    "/auth/forgot-password": "Forgot Password",
    "/plans/select": "Select Plan",
    "/settings/account": "Account Settings",
    "/internal/style-lab": "Design System",
  },
};

const AGENT_SECTION_TITLES_BY_REGION: Record<SeoRegion, Record<string, string>> = {
  cn: {
    workbench: "工作台",
    channels: "通道配置",
    models: "模型配置",
    skills: "技能配置",
    persona: "人设配置",
    automations: "自动任务",
    memory: "记忆管理",
    achievements: "成就",
    files: "文件管理",
    chat: "对话",
  },
  global: {
    workbench: "Workbench",
    channels: "Channels",
    models: "Models",
    skills: "Skills",
    persona: "Persona",
    automations: "Automations",
    memory: "Memory",
    achievements: "Achievements",
    files: "Files",
    chat: "Chat",
  },
};

const AGENTS_HOME_TITLE_BY_REGION: Record<SeoRegion, string> = {
  cn: "Agent 控制台",
  global: "Agent Console",
};

const APP_PAGE_TITLES_BY_REGION: Record<
  SeoRegion,
  { workspace: string; settings: string; terminal: string }
> = {
  cn: { workspace: "工作台", settings: "Agent 设置", terminal: "终端" },
  global: { workspace: "Workspace", settings: "Agent Settings", terminal: "Terminal" },
};

const NOT_FOUND_TITLE_BY_REGION: Record<SeoRegion, string> = {
  cn: "页面不存在",
  global: "Page Not Found",
};

/**
 * 文档页标题映射（含 /docs 文档首页）。
 *   - 国内站（cn）：中文 title
 *   - 国际站（global）：英文标题
 * 与 docs-sidebar.ts 保持一致；此处独立维护一份，避免该模块被
 * Node 脚本直接引入时触发 `@/` alias 解析失败。
 */
const DOC_PAGE_TITLES_BY_REGION: Record<SeoRegion, Record<string, string>> = {
  cn: {
    "/docs": "产品文档",
    "/docs/overview": "LightVela 是什么",
    "/docs/quickstart": "快速开始",
    "/docs/account": "账号与实名认证",
    "/docs/core-concepts": "核心概念",
    "/docs/configuration": "配置总览",
    "/docs/configuration/model": "配置模型",
    "/docs/configuration/channel-wechat": "微信",
    "/docs/configuration/channel-feishu": "飞书",
    "/docs/configuration/channel-qq": "QQ",
    "/docs/configuration/skill": "配置技能",
    "/docs/plans": "套餐管理",
    "/docs/announcements/public-beta": "LightVela 付费版本公告",
    "/docs/faq": "常见问题 FAQ",
  },
  global: {
    "/docs": "Docs",
    "/docs/overview": "What is LightVela",
    "/docs/quickstart": "Quickstart",
    "/docs/core-concepts": "Core Concepts",
    "/docs/configuration": "Configuration Overview",
    "/docs/configuration/model": "Configure Models",
    "/docs/configuration/memory": "Memory Management",
    "/docs/configuration/files": "Cloud Storage",
    "/docs/configuration/diagnostics": "Diagnostics",
    "/docs/configuration/multiple-models": "Model Switching",
    "/docs/configuration/channel-wechat": "WeChat",
    "/docs/configuration/channel-telegram": "Telegram",
    "/docs/configuration/channel-whatsapp": "WhatsApp",
    "/docs/configuration/channel-discord": "Discord",
    "/docs/configuration/channel-qq": "QQ",
    "/docs/configuration/channel-wecom": "WeCom",
    "/docs/configuration/channel-feishu": "Lark",
    "/docs/configuration/skill": "Configure Skills",
    "/docs/configuration/automation": "Automations",
    "/docs/configuration/agent-chat": "Chat",
    "/docs/faq": "FAQ",
    "/docs/plans": "Plans",
    "/docs/announcements/public-beta": "LightVela Paid Version Announcement",
    "/docs/credits": "Credits",
    "/docs/create-first-hermes": "How Do I Activate My First Hermes Instance?",
    "/docs/who-is-lightvela-for": "Who Is LightVela For?",
  },
};

function normalizeRegion(region?: SeoRegion): SeoRegion {
  return region === "global" ? "global" : "cn";
}

/* 兼容旧用法：默认导出仍以国内站为基准（运行时入口会显式传 region）。 */
export const DEFAULT_SEO_TITLE = DEFAULT_SEO_TITLE_BY_REGION.cn;
export const SEO_TITLE_SUFFIX = SEO_TITLE_SUFFIX_BY_REGION.cn;
export const SEO_DESCRIPTION = SEO_DESCRIPTION_BY_REGION.cn;
export const SEO_KEYWORDS = SEO_KEYWORDS_BY_REGION.cn;

export function getSeoStaticPaths(region?: SeoRegion): string[] {
  const r = normalizeRegion(region);
  return [
    ...Object.keys(STATIC_PAGE_TITLES_BY_REGION[r]),
    ...Object.keys(DOC_PAGE_TITLES_BY_REGION[r]),
    "/agents",
    ...Object.keys(AGENT_SECTION_TITLES_BY_REGION[r]).map((section) => `/agents/${section}`),
    "/bots/example/workspace",
    "/bots/example/settings",
    "/bots/example/terminal",
  ];
}

/** 兼容旧引用：默认国内站静态路径。 */
export const SEO_STATIC_PATHS = getSeoStaticPaths("cn");

function normalizePathname(pathname: string): string {
  if (pathname === "/" || pathname === "/index.html") {
    return "/";
  }

  return pathname.replace(/\/+$/, "");
}

/**
 * 国际站 multi-URL i18n：剥掉 locale-first 前缀，返回逻辑路径 + URL 语言。
 * 用于让 SEO 表（按裸路径建索引）能命中带前缀的实际访问路径，并让
 * `<html lang>` / `og:locale` 跟随 URL 前缀切换中英文（与 Next 静态输出一致）。
 *
 * - `/en-us/about`        → { bare: "/about", urlLang: "en-us" }
 * - `/zh-sg/docs/overview`→ { bare: "/docs/overview", urlLang: "zh-sg" }
 * - `/en-us/`             → { bare: "/", urlLang: "en-us" }
 * - `/about` （裸）    → { bare: "/about", urlLang: null }
 */
type UrlLang = "en" | "zh" | "en-us" | "zh-cn" | "zh-sg" | "zh-hant";

function stripUrlLangPrefix(pathname: string): { bare: string; urlLang: UrlLang | null } {
  const m = pathname.match(/^\/(en-us|zh-cn|zh-sg|zh-hant|en|zh)(?:\/(.*))?$/);
  if (!m) return { bare: pathname, urlLang: null };
  const rest = m[2] ?? "";
  return {
    bare: rest === "" ? "/" : `/${rest}`,
    urlLang: m[1] as UrlLang,
  };
}

/** URL 语言前缀 → htmlLang / ogLocale 映射（仅国际站使用） */
const URL_LANG_TO_HTML_LANG: Record<UrlLang, string> = {
  en: "en-US",
  "en-us": "en-US",
  zh: "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-SG",
  "zh-hant": "zh-Hant",
};
const URL_LANG_TO_OG_LOCALE: Record<UrlLang, string> = {
  en: "en_US",
  "en-us": "en_US",
  zh: "zh_CN",
  "zh-cn": "zh_CN",
  "zh-sg": "zh_SG",
  // OpenGraph 无 `zh_Hant` 泛区标准；繁体站采用香港用语（OpenCC cn→hk），故用 `zh_HK`。
  "zh-hant": "zh_HK",
};

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getAgentsPageTitle(pathname: string, region: SeoRegion): string | null {
  if (pathname === "/agents") {
    return AGENTS_HOME_TITLE_BY_REGION[region];
  }

  const match = pathname.match(/^\/agents\/([^/]+)$/);
  if (!match) {
    return null;
  }

  const section = safeDecodeURIComponent(match[1] ?? "");
  return AGENT_SECTION_TITLES_BY_REGION[region][section] ?? AGENTS_HOME_TITLE_BY_REGION[region];
}

function getAppPageTitle(pathname: string, region: SeoRegion): string | null {
  const appTitles = APP_PAGE_TITLES_BY_REGION[region];

  if (/^\/bots\/[^/]+\/workspace$/.test(pathname)) {
    return appTitles.workspace;
  }

  if (/^\/bots\/[^/]+\/settings$/.test(pathname)) {
    return appTitles.settings;
  }

  if (/^\/bots\/[^/]+\/terminal$/.test(pathname)) {
    return appTitles.terminal;
  }

  return null;
}

/**
 * 把 (region, urlLang) 映射成「查表用的 effective region」：
 *   - region=cn                       → "cn"（国内站不开多语言）
 *   - region=global + urlLang=null    → "global"（裸路径，默认英文）
 *   - region=global + urlLang="en"    → "global"（英文）
 *   - region=global + urlLang="zh"    → "cn"（复用国内站的中文表，避免给 global 多
 *                                        维护一份中文 title / description 镜像）
 *
 * 为何复用 cn 表：所有 `/zh/...` 想看到的 title / description 文案都已经在
 *   cn 表里维护好了（"关于我们"、"LightVela 是什么" 等）。复用避免双源漂移。
 */
function effectiveRegionForLookup(region: SeoRegion, urlLang: UrlLang | null): SeoRegion {
  if (region !== "global") return region;
  // 中文语系（含短前缀 "zh" / 简体 / 新加坡简体 / 港澳繁体）都复用 cn 查表。
  const ZH_URL_LANGS: readonly UrlLang[] = ["zh", "zh-cn", "zh-sg", "zh-hant"];
  return urlLang !== null && (ZH_URL_LANGS as readonly string[]).includes(urlLang) ? "cn" : "global";
}

export function getSeoMeta(pathname: string, region?: SeoRegion): SeoMeta {
  const r = normalizeRegion(region);
  /* 国际站剥掉 /en /zh URL 前缀后查表；国内站 stripUrlLangPrefix 对裸路径返回
     { bare: pathname, urlLang: null }，行为与改造前等价。 */
  const { bare, urlLang } = stripUrlLangPrefix(normalizePathname(pathname));
  const lookupRegion = effectiveRegionForLookup(r, urlLang);
  const pageTitle =
    bare === "/"
      ? null
      : STATIC_PAGE_TITLES_BY_REGION[lookupRegion][bare] ??
        DOC_PAGE_TITLES_BY_REGION[lookupRegion][bare] ??
        getAgentsPageTitle(bare, lookupRegion) ??
        getAppPageTitle(bare, lookupRegion) ??
        NOT_FOUND_TITLE_BY_REGION[lookupRegion];

  // description 优先取页面级覆盖，缺失才回退到全站默认。
  // keywords 不分页面，全站统一（按 SEO 规范，keywords 字段权重已极低，
  // 不值得为每页维护一份，集中维护一套即可）。
  const pageDescription = PAGE_DESCRIPTIONS_BY_REGION[lookupRegion][bare];

  return {
    title: pageTitle
      ? `${pageTitle} | ${SEO_TITLE_SUFFIX_BY_REGION[lookupRegion]}`
      : DEFAULT_SEO_TITLE_BY_REGION[lookupRegion],
    description: pageDescription ?? SEO_DESCRIPTION_BY_REGION[lookupRegion],
    /* keywords 始终用 region 自身（与原行为一致）：国际站 keywords 是英文站
       SEO 关键词，不随 URL 前缀切换——/zh/ 也想被英文关键词命中。 */
    keywords: SEO_KEYWORDS_BY_REGION[r],
  };
}

/** 获取 region 站点级常量（lang/locale/siteName/defaultUrl）。 */
export function getSiteConfig(region?: SeoRegion): {
  htmlLang: string;
  locale: string;
  siteName: string;
  defaultUrl: string;
} {
  return SITE_BY_REGION[normalizeRegion(region)];
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(origin: string, path: string): string {
  const o = trimTrailingSlash(origin);
  if (path === "/" || path === "") return o || "/";
  return `${o}${path.startsWith("/") ? "" : "/"}${path}`;
}

/** 路径是否默认应被搜索引擎索引。 */
export function isPathIndexable(pathname: string): boolean {
  const p = normalizePathname(pathname);
  return !NON_INDEXABLE_PREFIXES.some(
    (prefix) => p === trimTrailingSlash(prefix) || p.startsWith(prefix),
  );
}

/**
 * 完整 SEO 元数据：包含 OG / Twitter / canonical / robots / `<html lang>`。
 *
 * 设计意图：dev 中间件与客户端运行时同步共用此函数，避免字段在不同管线之间漂移。
 *
 * 安全：函数内部只做拼接，不做 HTML 转义。属性值的 `&` / `"` / `<` / `>` 转义
 * 由消费方（seo-html.ts、Next metadata）负责，避免双重转义。
 */
export function getFullSeoMeta(
  pathname: string,
  region?: SeoRegion,
  options: FullSeoMetaOptions = {},
): FullSeoMeta {
  const r = normalizeRegion(region);
  const site = SITE_BY_REGION[r];
  const base = getSeoMeta(pathname, r);
  const normalizedPathname = normalizePathname(pathname);
  /* 国际站从 URL 前缀解析 htmlLang / ogLocale；国内站 / 裸路径退化到 site 默认。
     这样 Next 写入 /zh-cn/...html 的 <html lang="zh-CN"> 不会在 SPA
     hydration 时被 useRouteSeoMeta 覆盖回 en-US（P0-B 回归）。 */
  const { urlLang } = stripUrlLangPrefix(normalizedPathname);
  const htmlLang = urlLang && r === "global" ? URL_LANG_TO_HTML_LANG[urlLang] : site.htmlLang;
  const ogLocale = urlLang && r === "global" ? URL_LANG_TO_OG_LOCALE[urlLang] : site.locale;
  const siteUrl = trimTrailingSlash(options.siteUrl ?? site.defaultUrl);
  /* canonical 保留带前缀的完整 pathname：国际站 `/zh/about` canonical 就是 `/zh/about`，
     与 Next sitemap/hreflang 集群对齐（每个 URL canonical 指向自己）。 */
  const canonical = joinUrl(siteUrl, normalizedPathname);
  const indexable = options.indexable ?? isPathIndexable(normalizedPathname);
  const ogImage = joinUrl(siteUrl, options.ogImagePath ?? DEFAULT_OG_IMAGE_PATH);

  return {
    ...base,
    htmlLang,
    canonical,
    robots: indexable ? "index,follow" : "noindex,nofollow",
    ogTitle: base.title,
    ogDescription: base.description,
    ogUrl: canonical,
    ogImage,
    ogLocale,
    ogSiteName: site.siteName,
    ogType: "website",
    twitterCard: "summary_large_image",
    twitterTitle: base.title,
    twitterDescription: base.description,
    twitterImage: ogImage,
  };
}
