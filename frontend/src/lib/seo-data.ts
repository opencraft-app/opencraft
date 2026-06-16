export type SeoRegion = "cn" | "global";

export interface SeoMeta {
  title: string;
  description: string;
  keywords: string;
}

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
 *   2. vite.config.ts 的 dev SEO 中间件（按 mode 显式传入 region）
 * 因此不在模块顶层依赖 `import.meta.env`，region 一律以参数显式传入，
 * 缺省回退到 "cn"，避免 config 加载阶段解析 `@/` alias / import.meta 失败。
 */

const DEFAULT_SEO_TITLE_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela | 越用越懂你的云端智能伙伴",
  global: "LightVela | Your Personal Cloud AI Agent",
};

const SEO_TITLE_SUFFIX_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela 云端专属个人 Agent",
  global: "LightVela · Your Personal Cloud AI Agent",
};

const SEO_DESCRIPTION_BY_REGION: Record<SeoRegion, string> = {
  cn: "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴——不是每次打开都要重新自我介绍的工具，而是认识你、记得你、越聊越懂你的长期存在。",
  global:
    "LightVela is a cloud-hosted AI Agent product from Tencent Cloud Lightweight team, giving everyone a personal AI companion that remembers you and grows with you over time — always online in the cloud.",
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
    "/auth/sign-up-code": "登录",
    "/auth/invite": "邀请码",
    "/auth/forgot-password": "登录",
    "/plans/select": "选择套餐",
    "/settings/account": "账号设置",
    "/internal/style-lab": "设计系统",
  },
  global: {
    "/about": "About",
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
    "/auth/sign-up-code": "Sign In",
    "/auth/invite": "Invite Code",
    "/auth/forgot-password": "Sign In",
    "/plans/select": "Select Plan",
    "/settings/account": "Account Settings",
    "/internal/style-lab": "Design System",
  },
};

const AGENT_SECTION_TITLES_BY_REGION: Record<SeoRegion, Record<string, string>> = {
  cn: {
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
 * vite.config.ts（node 加载上下文）引入时触发 `@/` alias 解析失败。
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
    "/docs/faq": "常见问题 FAQ",
  },
  global: {
    "/docs": "Docs",
    "/docs/overview": "What is LightVela",
    "/docs/quickstart": "Quickstart",
    "/docs/core-concepts": "Core Concepts",
    "/docs/configuration": "Configuration Overview",
    "/docs/configuration/model": "Configure Models",
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
    "/docs/faq/using-lightvela-safely": "Using LightVela Safely",
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

function getAgentsPageTitle(pathname: string, region: SeoRegion): string | null {
  if (pathname === "/agents") {
    return AGENTS_HOME_TITLE_BY_REGION[region];
  }

  const match = pathname.match(/^\/agents\/([^/]+)$/);
  if (!match) {
    return null;
  }

  const section = decodeURIComponent(match[1] ?? "");
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

export function getSeoMeta(pathname: string, region?: SeoRegion): SeoMeta {
  const r = normalizeRegion(region);
  const normalizedPathname = normalizePathname(pathname);
  const pageTitle =
    normalizedPathname === "/"
      ? null
      : STATIC_PAGE_TITLES_BY_REGION[r][normalizedPathname] ??
        DOC_PAGE_TITLES_BY_REGION[r][normalizedPathname] ??
        getAgentsPageTitle(normalizedPathname, r) ??
        getAppPageTitle(normalizedPathname, r) ??
        NOT_FOUND_TITLE_BY_REGION[r];

  return {
    title: pageTitle
      ? `${pageTitle} | ${SEO_TITLE_SUFFIX_BY_REGION[r]}`
      : DEFAULT_SEO_TITLE_BY_REGION[r],
    description: SEO_DESCRIPTION_BY_REGION[r],
    keywords: SEO_KEYWORDS_BY_REGION[r],
  };
}
