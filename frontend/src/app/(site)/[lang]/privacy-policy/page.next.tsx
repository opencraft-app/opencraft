import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';
import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/privacy-policy', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title:
      routeLocale.locale === 'en-US'
        ? 'Privacy Policy'
        : routeLocale.locale === 'zh-Hant'
          ? '隱私政策'
          : '隐私政策',
    description:
      routeLocale.locale === 'en-US'
        ? 'LightVela Privacy Policy, including personal information processing, storage, sharing, and user rights.'
        : routeLocale.locale === 'zh-Hant'
          ? 'LightVela 隱私政策，說明個人信息的處理、存儲、共享和用戶權利。'
          : 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
  });
}

export default async function LocalizedPrivacyPolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicPrivacyPolicyPage {...routeLocale} />;
}
