import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';
import { publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';
import { createPublicMetadata, localizedPublicPath, SEO_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Privacy Policy',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '隱私政策',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '隐私政策',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '隐私政策',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kebijakan Privasi',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'LightVela Privacy Policy, including personal information processing, storage, sharing, and user rights.',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: 'LightVela 隱私政策，說明個人信息的處理、存儲、共享和用戶權利。',
  [PUBLIC_SITE_LOCALES.ZH_CN]: 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kebijakan Privasi LightVela, termasuk pemrosesan, penyimpanan, pembagian informasi pribadi, dan hak pengguna.',
};

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
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
  });
}

export default async function LocalizedPrivacyPolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicPrivacyPolicyPage {...routeLocale} />;
}
