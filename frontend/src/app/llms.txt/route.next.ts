import { isGlobal } from '@/lib/region';
import { getDocsPage } from '@next-site/docs-page';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';
import { DOCS_ROUTE_SLUGS, docsLastUpdated, type DocsRouteLocale } from '@next-site/docs-route-manifest';
import { absoluteUrl } from '@next-site/seo';
import { BLOG_POSTS } from '@/pages/marketing/blog-content';

export const dynamic = 'force-static';

type DocLink = {
  title: string;
  url: string;
  slug: readonly string[];
};

/**
 * llms.txt —— 面向 AI / Agent 的站点导览页。
 * 与 sitemap.xml 一样在构建期动态生成，按 NEXT_PUBLIC_REGION 区分国内 / 国际站，
 * 所有链接都指向当前 region 自己的域名（absoluteUrl 基于 siteUrl()）。
 *
 * 官方入口硬编码（页面数量少且稳定），文档区遍历默认语言的
 * DOCS_ROUTE_SLUGS，通过 source.getPage 取每篇文档真实标题，
 * 再按 slug 语义分组（文档 / 渠道配置 / 支持），生成可读的 Markdown 列表。
 */

const COPY = {
  cn: {
    tagline:
      'LightVela 是面向个人 AI Agent 的云端托管与管理平台，支持 Hermes Agent 长期在线运行。',
    intro:
      'LightVela 帮助用户配置模型、接入微信/QQ/企业微信/飞书/钉钉等渠道、安装技能、设置定时任务，并管理 Agent 的记忆与云端文件。',
    entryHeading: '官方入口',
    factsHeading: '关键事实',
    docsHeading: '文档',
    channelHeading: '渠道配置',
    supportHeading: '支持',
    entries: [
      { title: '首页', path: '/' },
      { title: '产品介绍', path: '/about' },
      { title: '更新日志', path: '/changelog' },
    ],
    /**
     * 面向 AI 检索的结构化事实摘要。
     * 事实来源：`wiki/product-state/geo-fact-table.md`（唯一来源＝订阅后台 / 产品配置 / 运营规则）。
     * ⚠️ 价格与试用条件调整时，须与 docs/plans.md、公告页、subscribe-page.tsx 静态价表同步。
     */
    facts: [
      { label: '当前状态', value: '公测中，已开启计费（2026 年 8 月 18 日起）' },
      {
        label: '套餐与价格',
        value:
          '启航 Launch ¥45/月（¥135/季）；巡游 Cruise ¥95/月（¥285/季）；启航 Launch AI ¥68/月（¥204/季）；巡游 Cruise AI ¥158/月（¥474/季）。以上为月付/季付标准原价。',
      },
      {
        label: '免费试用',
        value:
          '公测阶段首次注册用户可免费体验启航版 14 天，到期不自动扣款、需手动续费；巡游首月 5 折，AI 版首月 6 折，季付标准版 8.5 折、AI 版 9 折。',
      },
      { label: '支持渠道', value: '微信、QQ、企业微信、飞书、钉钉（国内站）' },
      { label: '实名认证', value: '国内站首次开通套餐前需完成实名认证（需中国大陆居民身份证），一次生效' },
      { label: '登录方式', value: 'QQ / 微信社交账号一键登录' },
      { label: '数据保留期', value: '套餐到期后权益 1 天后暂停，数据自到期日起保留 14 天，保留期满释放且不可恢复' },
      { label: '模型支持', value: '可用套餐 AI 积分直接对话，或配置自有 API Key（DeepSeek、千问、Kimi、智谱、豆包、MiniMax、文心等；Claude / GPT / Gemini 需通过自定义模型自备端点）' },
    ],
    factsNote: '以上为对外口径摘要；实时价格、活动与可售状态以订阅页为准，规则详情见套餐管理与付费版本公告。',
  },
  global: {
    tagline:
      'LightVela is a cloud hosting and management platform for personal AI Agents, keeping the Hermes Agent online around the clock.',
    intro:
      'LightVela helps you configure models, connect channels like Telegram/WhatsApp/Discord/Slack, install skills, set up Scheduled Tasks, and manage your Agent\u2019s memory and cloud files.',
    entryHeading: 'Official Entry Points',
    factsHeading: 'Key Facts',
    docsHeading: 'Documentation',
    channelHeading: 'Channel Configuration',
    supportHeading: 'Support',
    entries: [
      { title: 'Home', path: '/' },
      { title: 'About', path: '/about' },
      { title: 'Blog', path: '/blog' },
      { title: 'Changelog', path: '/changelog' },
    ],
    /**
     * 国际站事实摘要。计费状态本轮按要求冻结（见事实表 1.1），
     * 仅陈述已确认的价格档位与「无中国实名要求」等稳定事实，不改动公测/计费时态口径。
     */
    facts: [
      { label: 'Plans & pricing', value: 'Launch $7.5/month; Cruise $15/month' },
      { label: 'Free trial', value: 'New users can try the Launch plan free for 14 days' },
      {
        label: 'Supported channels',
        value: 'Telegram, WhatsApp, Discord, Slack, WeChat, QQ, WeCom, Lark',
      },
      { label: 'Identity verification', value: 'No China real-name verification required' },
      { label: 'Sign-in', value: 'Google or GitHub' },
    ],
    factsNote:
      'Summary only. Availability, pricing, and current offers are shown on the Subscribe page; see Plans and the paid version announcement for full rules.',
  },
} as const;

function docLinkFor(slug: readonly string[]): DocLink | null {
  // 空 slug 是 /docs 首页（fumadocs 会回退到 overview），与真实的
  // ['overview'] 页面重复，这里跳过，避免 llms.txt 出现两条相同链接。
  if (slug.length === 0) return null;
  const pageSlug = [...slug];
  try {
    // 默认语言（DEFAULT_PUBLIC_DOCS_LOCALE）在 URL 上不带前缀 → prefix = undefined
    const page = getDocsPage(undefined, pageSlug);
    return {
      title: String(page.data.title),
      url: absoluteUrl(`/docs/${pageSlug.join('/')}`),
      slug: pageSlug,
    };
  } catch {
    return null;
  }
}

function isChannelSlug(slug: readonly string[]): boolean {
  return slug[0] === 'configuration' && (slug[1]?.startsWith('channel-') ?? false);
}

function isSupportSlug(slug: readonly string[]): boolean {
  return slug[0] === 'faq' || slug[0] === 'contact-us';
}

function renderLinks(links: readonly DocLink[]): string {
  return links.map((link) => `- [${link.title}](${link.url})`).join('\n');
}

function renderSection(heading: string, links: readonly DocLink[]): string {
  if (links.length === 0) return '';
  return `## ${heading}\n\n${renderLinks(links)}`;
}

/**
 * 渲染「关键事实」段落：`- **字段**：值` 形式，便于 AI 检索时逐条抽取。
 * 放在导航链接之前，确保爬虫截断长文时优先保留事实。
 */
function renderFacts(
  heading: string,
  facts: readonly { label: string; value: string }[],
  note: string,
): string {
  if (facts.length === 0) return '';
  const lines = facts.map((fact) => `- **${fact.label}**：${fact.value}`).join('\n');
  return `## ${heading}\n\n${lines}\n\n${note}`;
}

/**
 * 「最后更新于」时间戳。
 *
 * 取全部文档中**最新**的内容更新日期（真源：`src/content/docs/last-updated.json`），
 * 而**不是构建时间** —— llms.txt 描述的是整站事实口径，只要有任一文档更新过，
 * 这个口径就可能变；但每天重新构建不会让它变化。
 *
 * 与文档页「最后更新于」、sitemap 的 `<lastmod>` 三处同源，不存在时间镜像。
 */
function lastUpdatedLine(region: 'cn' | 'global', docsLocale: DocsRouteLocale): string {
  const dates = DOCS_ROUTE_SLUGS[docsLocale]
    .map((slug) => docsLastUpdated(docsLocale, slug))
    .filter((value): value is string => Boolean(value));
  const date = dates.length > 0 ? dates.reduce((latest, value) => (value > latest ? value : latest)) : undefined;
  if (!date) return '';
  return region === 'global' ? `Last updated: ${date}` : `最后更新于 ${date}`;
}

export function GET() {
  const region = isGlobal ? 'global' : 'cn';
  const copy = COPY[region];
  const docsLocale: DocsRouteLocale = DEFAULT_PUBLIC_DOCS_LOCALE;

  // 官方入口
  const entryLinks: DocLink[] = [
    ...copy.entries,
    ...(region === 'global'
      ? BLOG_POSTS.map((post) => ({ title: post.title, path: `/blog/${post.slug}` }))
      : []),
  ].map((entry) => ({
    title: entry.title,
    url: absoluteUrl(entry.path),
    slug: [],
  }));

  // 遍历默认语言的全部文档 slug，取真实标题后按语义分组
  const docLinks = DOCS_ROUTE_SLUGS[docsLocale]
    .map((slug) => docLinkFor(slug))
    .filter((link): link is DocLink => link !== null);

  const channelLinks = docLinks.filter((link) => isChannelSlug(link.slug));
  const supportLinks = docLinks.filter((link) => isSupportSlug(link.slug));
  const coreDocLinks = docLinks.filter(
    (link) => !isChannelSlug(link.slug) && !isSupportSlug(link.slug),
  );

  const body = [
    '# LightVela',
    '',
    `> ${copy.tagline}`,
    '',
    copy.intro,
    '',
    renderFacts(copy.factsHeading, copy.facts, copy.factsNote),
    renderSection(copy.entryHeading, entryLinks),
    renderSection(copy.docsHeading, coreDocLinks),
    renderSection(copy.channelHeading, channelLinks),
    renderSection(copy.supportHeading, supportLinks),
    lastUpdatedLine(region, docsLocale),
  ]
    .filter((block) => block !== '')
    .join('\n\n')
    .concat('\n');

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
