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

/** 国内站 sidebar：微信 / 飞书 / QQ */
const CN_SIDEBAR: DocGroup[] = [
  {
    title: "产品公告",
    items: [
      { slug: "announcements/public-beta", title: "LightVela 付费版本公告" },
    ],
  },
  {
    title: "开始使用",
    items: [
      { slug: "overview", title: "LightVela 是什么" },
      { slug: "quickstart", title: "快速开始" },
      { slug: "account", title: "账号与实名认证" },
      { slug: "core-concepts", title: "核心概念" },
    ],
  },
  {
    title: "配置指南",
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
    title: "参考",
    items: [{ slug: "faq", title: "常见问题 FAQ" }],
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
  overview: "01-overview.md",
  quickstart: "02-quickstart.md",
  account: "03-account.md",
  "core-concepts": "04-core-concepts.md",
  configuration: "05-configuration.md",
  "configuration/model": "configuration/model.md",
  "configuration/channel-wechat": "configuration/channel-wechat.md",
  "configuration/channel-feishu": "configuration/channel-feishu.md",
  "configuration/channel-qq": "configuration/channel-qq.md",
  "configuration/skill": "configuration/skill.md",
  "announcements/public-beta": "announcements/public-beta.md",
  faq: "07-faq.md",
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
