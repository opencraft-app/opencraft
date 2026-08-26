import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { SupportPageClient } from '@next-site/support-page-client';
import {
  createPublicMetadata,
  localizedPublicPath,
  prefixedPublicRouteLocale,
  SEO_PREFIXED_PUBLIC_URL_LANGS,
} from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Support',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '帮助与反馈',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '帮助与反馈',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '幫助與意見回饋',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Bantuan dan masukan',
  [PUBLIC_SITE_LOCALES.ES]: 'Ayuda y comentarios',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'Support',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Support',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.EN_US]: 'Submit feedback, report issues, or request features for LightVela.',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '提交反馈、报告问题或申请 LightVela 新功能。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '提交反馈、报告问题或申请 LightVela 新功能。',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '提交意見、回報問題或申請 LightVela 新功能。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kirim masukan, laporkan masalah, atau ajukan fitur baru untuk LightVela.',
  [PUBLIC_SITE_LOCALES.ES]: 'Envía comentarios, informa de problemas o solicita nuevas funciones para LightVela.',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'Submit feedback, report issues, or request features for LightVela.',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'Submit feedback, report issues, or request features for LightVela.',
};

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return SEO_PREFIXED_PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return createPublicMetadata({
    path: localizedPublicPath('/support', lang as PublicUrlLang),
    locale: routeLocale.locale,
    title: TITLE_BY_LOCALE[routeLocale.locale] ?? TITLE_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    description: DESCRIPTION_BY_LOCALE[routeLocale.locale] ?? DESCRIPTION_BY_LOCALE[PUBLIC_SITE_LOCALES.EN_US],
    index: false,
  });
}

export default async function LocalizedSupportPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return <SupportPageClient {...routeLocale} />;
}
