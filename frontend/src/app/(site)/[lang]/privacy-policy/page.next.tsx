import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicPrivacyPolicyPage } from '@next-site/legal-pages';
import { PUBLIC_URL_LANGS, publicRouteLocaleFromLang, type PublicUrlLang } from '@next-site/public-locale';

export function generateStaticParams(): { lang: PublicUrlLang }[] {
  return PUBLIC_URL_LANGS.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return routeLocale.locale === 'en-US'
    ? {
        title: 'Privacy Policy',
        description: 'LightVela Privacy Policy, including personal information processing, storage, sharing, and user rights.',
      }
    : {
        title: '隐私政策',
        description: 'LightVela 隐私政策，说明个人信息的处理、存储、共享和用户权利。',
      };
}

export default async function LocalizedPrivacyPolicyRoute({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const routeLocale = publicRouteLocaleFromLang(lang);
  if (!routeLocale) notFound();
  return <PublicPrivacyPolicyPage {...routeLocale} />;
}
