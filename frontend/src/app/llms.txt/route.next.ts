import { isGlobal } from '@/lib/region';
import { getDocsPage } from '@next-site/docs-page';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';
import { DOCS_ROUTE_SLUGS, type DocsRouteLocale } from '@next-site/docs-route-manifest';
import { absoluteUrl } from '@next-site/seo';

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
      'LightVela 帮助用户配置模型、接入微信/QQ/飞书等渠道、安装技能、设置自动任务，并管理 Agent 的记忆与云端文件。',
    entryHeading: '官方入口',
    docsHeading: '文档',
    channelHeading: '渠道配置',
    supportHeading: '支持',
    entries: [
      { title: '首页', path: '/' },
      { title: '产品介绍', path: '/about' },
      { title: '更新日志', path: '/changelog' },
    ],
  },
  global: {
    tagline:
      'LightVela is a cloud hosting and management platform for personal AI Agents, keeping the Hermes Agent online around the clock.',
    intro:
      'LightVela helps you configure models, connect channels like Telegram/WhatsApp/Discord/Slack, install skills, set up automations, and manage your Agent\u2019s memory and cloud files.',
    entryHeading: 'Official Entry Points',
    docsHeading: 'Documentation',
    channelHeading: 'Channel Configuration',
    supportHeading: 'Support',
    entries: [
      { title: 'Home', path: '/' },
      { title: 'About', path: '/about' },
      { title: 'Changelog', path: '/changelog' },
    ],
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

export function GET() {
  const region = isGlobal ? 'global' : 'cn';
  const copy = COPY[region];
  const docsLocale: DocsRouteLocale = DEFAULT_PUBLIC_DOCS_LOCALE;

  // 官方入口
  const entryLinks: DocLink[] = copy.entries.map((entry) => ({
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
    renderSection(copy.entryHeading, entryLinks),
    renderSection(copy.docsHeading, coreDocLinks),
    renderSection(copy.channelHeading, channelLinks),
    renderSection(copy.supportHeading, supportLinks),
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
