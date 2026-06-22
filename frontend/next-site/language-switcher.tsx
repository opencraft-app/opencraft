'use client';

import { useRouter } from 'next/navigation';

import {
  LanguageSwitcher,
  type LanguageSwitcherVariant,
} from '@/components/site/language-switcher';

export function NextLanguageSwitcher({
  reloadAfterSwitch,
  variant,
}: {
  reloadAfterSwitch: boolean;
  variant: LanguageSwitcherVariant;
}) {
  const router = useRouter();

  return (
    <LanguageSwitcher
      navigateTo={(targetUrl) => router.replace(targetUrl)}
      reloadAfterSwitch={reloadAfterSwitch}
      variant={variant}
    />
  );
}

export const renderNextLanguageSwitcher = ({
  reloadAfterSwitch,
  variant,
}: {
  reloadAfterSwitch: boolean;
  variant: LanguageSwitcherVariant;
}) => (
  <NextLanguageSwitcher reloadAfterSwitch={reloadAfterSwitch} variant={variant} />
);
