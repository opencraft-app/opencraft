/**
 * 默认 locale 的 /blog 列表路由。
 * 参考 /changelog 的默认路由实现。
 * 分类切换在客户端 UI 中实现，路由本身不消费 searchParams，
 * 以兼容 output: "export" 模式（dynamic = "error"）。
 */
import type { Metadata } from 'next';

import { DEFAULT_PUBLIC_ROUTE_LOCALE, EN_US_LOCALE } from '@next-site/public-locale';
import { PublicBlogListPage } from '@next-site/public-pages';
import { createPublicMetadata } from '@next-site/seo';

export const metadata: Metadata = createPublicMetadata({
  path: '/blog',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === EN_US_LOCALE ? 'Blog' : '科普',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === EN_US_LOCALE
      ? 'Deep dives on how next-generation AI agents work, plus how LightVela puts these capabilities into product.'
      : '拆解下一代 AI Agent 的关键机制，看 LightVela 如何把这些能力做成产品。',
});

export default function BlogListRoute() {
  return <PublicBlogListPage />;
}
