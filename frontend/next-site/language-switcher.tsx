'use client';

import { useRouter } from 'next/navigation';

import {
  LanguageSwitcher,
  type LanguageSwitcherVariant,
} from '@/components/site/language-switcher';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

export function NextLanguageSwitcher({
  activeLocale,
  reloadAfterSwitch,
  variant,
}: {
  activeLocale: PublicSiteLocale;
  reloadAfterSwitch: boolean;
  variant: LanguageSwitcherVariant;
}) {
  const router = useRouter();

  return (
    <LanguageSwitcher
      activeLocale={activeLocale}
      navigateTo={(targetUrl) => router.replace(targetUrl)}
      reloadAfterSwitch={reloadAfterSwitch}
      variant={variant}
    />
  );
}

export const renderNextLanguageSwitcher = ({
  activeLocale,
  reloadAfterSwitch,
  variant,
}: {
  activeLocale: PublicSiteLocale;
  reloadAfterSwitch: boolean;
  variant: LanguageSwitcherVariant;
}) => (
  <NextLanguageSwitcher activeLocale={activeLocale} reloadAfterSwitch={reloadAfterSwitch} variant={variant} />
);
