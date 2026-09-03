import { readFileSync } from 'node:fs';
import path from 'node:path';

import { InternationalHomeRuntime } from '@next-site/international-home-runtime';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

const FRAGMENT_FILE_BY_LOCALE: Record<PublicSiteLocale, string> = {
  'en-US': 'index-fragment.en-US.html',
  'zh-CN': 'index-fragment.zh-CN.html',
  'zh-SG': 'index-fragment.zh-SG.html',
  'zh-Hant': 'index-fragment.zh-Hant.html',
  'id-ID': 'index-fragment.id-ID.html',
  es: 'index-fragment.es.html',
  'ja-JP': 'index-fragment.ja-JP.html',
  'ko-KR': 'index-fragment.ko-KR.html',
};

function fragmentPathForLocale(locale: PublicSiteLocale): string {
  return path.join(process.cwd(), 'public/lightvela-intl-home', FRAGMENT_FILE_BY_LOCALE[locale]);
}

export function InternationalHomePage({ locale = 'en-US' }: { locale?: PublicSiteLocale } = {}) {
  const markup = readFileSync(fragmentPathForLocale(locale), 'utf8');
  return <InternationalHomeRuntime locale={locale} markup={markup} />;
}
