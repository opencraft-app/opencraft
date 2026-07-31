/**
 * 多语言 /:lang/blog 列表路由。
 * 参考 /:lang/changelog 的实现，使用 SEO_ALL_PUBLIC_URL_LANGS，
 * 让 zh-cn / zh-sg / en-us 三种语言都生成路由。
 * 分类切换在客户端 UI 中实现，路由本身不消费 searchParams，
 * 以兼容 output: "export" 模式（dynamic = "error"）。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { PublicBlogListPage } from '@next-site/public-pages';
import {
  createPublicMetadata,
  localizedPublicPath,
  SEO_ALL_PUBLIC_URL_LANGS,
} from '@next-site/seo';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_ALL_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  const isEn = routeLocale.locale === 'en-US';
  return createPublicMetadata({
    path: localizedPublicPath('/blog', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: isEn ? 'Blog' : '科普',
    description: isEn
      ? 'Deep dives on how next-generation AI agents work, plus how LightVela puts these capabilities into product.'
      : '拆解下一代 AI Agent 的关键机制，看 LightVela 如何把这些能力做成产品。',
  });
}

export default async function LocalizedBlogListRoute({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicBlogListPage {...routeLocale} />;
}
