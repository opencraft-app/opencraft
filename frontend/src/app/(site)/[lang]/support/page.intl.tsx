import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { type PublicUrlLang } from '@next-site/public-locale';
import { SupportPageClient } from '@next-site/support-page-client';
import { createPublicMetadata, localizedPublicPath, prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } from '@next-site/seo';
import { PUBLIC_SITE_LOCALES, type PublicSiteLocaleCode } from '@/lib/public-site-routing';

const TITLE_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.MS_MY]: 'Bantuan dan maklum balas',
  [PUBLIC_SITE_LOCALES.TH_TH]: "ความช่วยเหลือและความคิดเห็น",
  [PUBLIC_SITE_LOCALES.EN_US]: 'Support',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '帮助与反馈',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '帮助与反馈',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '幫助與回饋',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Bantuan dan masukan',
  [PUBLIC_SITE_LOCALES.ES]: 'Ayuda y comentarios',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'サポート・フィードバック',
  [PUBLIC_SITE_LOCALES.KO_KR]: '지원 및 피드백',
};

const DESCRIPTION_BY_LOCALE: Record<PublicSiteLocaleCode, string> = {
  [PUBLIC_SITE_LOCALES.MS_MY]: 'Hantar maklum balas, laporkan masalah atau cadangkan ciri untuk LightVela.',
  [PUBLIC_SITE_LOCALES.TH_TH]: "ส่งข้อเสนอแนะ รายงานปัญหา หรือแนะนำฟีเจอร์สำหรับ LightVela",
  [PUBLIC_SITE_LOCALES.EN_US]: 'Submit feedback, report issues, or request features for LightVela.',
  [PUBLIC_SITE_LOCALES.ZH_CN]: '向 LightVela 提交反馈、问题报告或功能建议。',
  [PUBLIC_SITE_LOCALES.ZH_SG]: '向 LightVela 提交反馈、问题报告或功能建议。',
  [PUBLIC_SITE_LOCALES.ZH_HANT]: '向 LightVela 提交回饋、問題回報或功能建議。',
  [PUBLIC_SITE_LOCALES.ID_ID]: 'Kirim masukan, laporkan masalah, atau ajukan fitur untuk LightVela.',
  [PUBLIC_SITE_LOCALES.ES]: 'Envía comentarios, informa problemas o solicita funciones para LightVela.',
  [PUBLIC_SITE_LOCALES.JA_JP]: 'LightVelaへのフィードバック、問題の報告、機能リクエストを送信できます。',
  [PUBLIC_SITE_LOCALES.KO_KR]: 'LightVela에 피드백, 문제 신고, 기능 요청을 보낼 수 있습니다.',
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
  });
}

export default async function LocalizedSupportPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = prefixedPublicRouteLocale(lang);
  if (!routeLocale) notFound();
  return <SupportPageClient {...routeLocale} />;
}
