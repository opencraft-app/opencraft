/**
 * 文档侧边栏结构 + slug → markdown 文件映射。
 * 路由形态：
 *   /docs/:slug              例如 /docs/overview
 *   /docs/:category/:slug    例如 /docs/configuration/model
 */

export interface DocItem {
  /**
   * 文档 slug。对应 `SLUG_TO_FILE` 的 key；点击后跳转 `/docs/:slug`。
   * 对于"仅作分组表头、不可点击"的条目，置为 `null`。
   * 对于"分组表头，点击后跳转到第一个子项"的条目，配合 `defaultChildSlug` 使用（slug 仍为 null）。
   */
  slug: string | null;
  title: string;
  /**
   * 是否作为二级目录项（视觉上缩进）。
   * 用于在"配置通道"下挂三个具体通道（微信/飞书/QQ）。
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
  items: DocItem[];
}

export const SIDEBAR: DocGroup[] = [
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

/** slug 到 markdown 文件路径（相对于 `@/content/docs/`）的映射 */
export const SLUG_TO_FILE: Record<string, string> = {
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
  faq: "07-faq.md",
};

/** 按侧栏顺序展平所有可点击 slug，用于上一篇 / 下一篇导航 */
export const FLAT_SLUGS: Array<{ slug: string; title: string }> = SIDEBAR.flatMap(
  (group) =>
    group.items
      .filter((item): item is DocItem & { slug: string } => item.slug !== null)
      .map((item) => ({ slug: item.slug, title: item.title })),
);

export const DEFAULT_SLUG = "overview";
