'use client';

import { PublicSiteHeader } from '@/components/site/public-site-header';
import type { PublicSiteLocale } from '@/lib/public-site-navigation';

import { renderNextLanguageSwitcher } from './language-switcher';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';

export function LightVelaDocsHeader({
  locale,
  localized,
}: {
  locale: PublicSiteLocale;
  localized: boolean;
}) {
  return (
    <PublicSiteHeader
      authControls={<PublicHeaderAuthIsland locale={locale} />}
      currentSection="docs"
      locale={locale}
      localized={localized}
      renderLink={renderNextPublicSiteHeaderLink}
      renderLanguageSwitcher={renderNextLanguageSwitcher}
    />
  );
}
