export interface SeoMeta {
  title: string;
  description: string;
  keywords: string;
}

export const DEFAULT_SEO_TITLE = "LightVela | 越用越懂你的云端智能伙伴";
export const SEO_TITLE_SUFFIX = "LightVela 云端专属个人 Agent";
export const SEO_DESCRIPTION =
  "LightVela 是腾讯轻量云团队推出的云端 Agent 托管产品，致力于让每个人都能拥有一个真正属于自己的 AI 伙伴——不是每次打开都要重新自我介绍的工具，而是认识你、记得你、越聊越懂你的长期存在。";
export const SEO_KEYWORDS = [
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
].join(", ");

const STATIC_PAGE_TITLES: Record<string, string> = {
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
};

const AGENT_SECTION_TITLES: Record<string, string> = {
  channels: "通道配置",
  models: "模型配置",
  skills: "技能配置",
  persona: "人设配置",
  automations: "自动任务",
  memory: "记忆管理",
  achievements: "成就",
  files: "文件管理",
  chat: "对话",
};

const DOC_PAGE_TITLES: Record<string, string> = {
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
  "/docs/configuration/channel-telegram": "Telegram",
  "/docs/configuration/channel-whatsapp": "WhatsApp",
  "/docs/configuration/channel-discord": "Discord",
  "/docs/configuration/channel-wecom": "企业微信",
  "/docs/configuration/skill": "配置技能",
  "/docs/configuration/automation": "自动任务",
  "/docs/configuration/agent-chat": "对话",
  "/docs/faq": "常见问题 FAQ",
  "/docs/faq/using-lightvela-safely": "安全使用 LightVela",
};

export const SEO_STATIC_PATHS = [
  ...Object.keys(STATIC_PAGE_TITLES),
  ...Object.keys(DOC_PAGE_TITLES),
  "/agents",
  ...Object.keys(AGENT_SECTION_TITLES).map((section) => `/agents/${section}`),
  "/bots/example/workspace",
  "/bots/example/settings",
  "/bots/example/terminal",
];

function normalizePathname(pathname: string): string {
  if (pathname === "/" || pathname === "/index.html") {
    return "/";
  }

  return pathname.replace(/\/+$/, "");
}

function getAgentsPageTitle(pathname: string): string | null {
  if (pathname === "/agents") {
    return "Agent 控制台";
  }

  const match = pathname.match(/^\/agents\/([^/]+)$/);
  if (!match) {
    return null;
  }

  const section = decodeURIComponent(match[1] ?? "");
  return AGENT_SECTION_TITLES[section] ?? "Agent 控制台";
}

function getAppPageTitle(pathname: string): string | null {
  if (/^\/bots\/[^/]+\/workspace$/.test(pathname)) {
    return "工作台";
  }

  if (/^\/bots\/[^/]+\/settings$/.test(pathname)) {
    return "Agent 设置";
  }

  if (/^\/bots\/[^/]+\/terminal$/.test(pathname)) {
    return "终端";
  }

  return null;
}

export function getSeoMeta(pathname: string): SeoMeta {
  const normalizedPathname = normalizePathname(pathname);
  const pageTitle =
    normalizedPathname === "/"
      ? null
      : STATIC_PAGE_TITLES[normalizedPathname] ??
        DOC_PAGE_TITLES[normalizedPathname] ??
        getAgentsPageTitle(normalizedPathname) ??
        getAppPageTitle(normalizedPathname) ??
        "页面不存在";

  return {
    title: pageTitle ? `${pageTitle} | ${SEO_TITLE_SUFFIX}` : DEFAULT_SEO_TITLE,
    description: SEO_DESCRIPTION,
    keywords: SEO_KEYWORDS,
  };
}
