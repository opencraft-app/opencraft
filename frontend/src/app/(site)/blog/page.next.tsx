import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DEFAULT_PUBLIC_ROUTE_LOCALE, EN_US_LOCALE } from '@next-site/public-locale';
import { PublicBlogPage } from '@next-site/public-pages';
import { buildGlobalPublicAlternates, createPublicMetadata } from '@next-site/seo';
import { isGlobal } from '@/lib/region';

export const metadata: Metadata = createPublicMetadata({
  path: '/blog',
  locale: DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  title: DEFAULT_PUBLIC_ROUTE_LOCALE.locale === EN_US_LOCALE ? 'Blog' : '博客',
  description:
    DEFAULT_PUBLIC_ROUTE_LOCALE.locale === EN_US_LOCALE
      ? 'The LightVela Blog will share product announcements, updates, and use cases for cloud-hosted AI Agents.'
      : 'LightVela 博客将分享云端 AI Agent 的产品公告、更新和使用场景。',
  alternates: buildGlobalPublicAlternates('/blog'),
});

export default function BlogRoute() {
  if (!isGlobal) notFound();

  return <PublicBlogPage />;
}
