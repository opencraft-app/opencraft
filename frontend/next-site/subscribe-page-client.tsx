'use client';

import { AppRouteShell, ProductSetupRouteLoading } from './app-route-shell';
import { renderNextLanguageSwitcher } from './language-switcher';
import { DEFAULT_PUBLIC_ROUTE_LOCALE, type PublicRouteLocale } from './public-locale';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { PublicSiteLocaleBridge } from './public-site-providers';
import { SubscribePage } from './subscribe-page';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';

export function SubscribePageClient({
  locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale,
  localized = DEFAULT_PUBLIC_ROUTE_LOCALE.localized,
}: Partial<PublicRouteLocale> = {}) {
  return (
    <AppRouteShell loadingFallback={<ProductSetupRouteLoading />} requireAuth={false}>
      <PublicSiteLocaleBridge locale={locale}>
        <SubscribePage
          authControls={<PublicHeaderAuthIsland locale={locale} />}
          publicLocale={locale}
          publicLocalized={localized}
          renderLanguageSwitcher={renderNextLanguageSwitcher}
          renderLink={renderNextPublicSiteHeaderLink}
        />
      </PublicSiteLocaleBridge>
    </AppRouteShell>
  );
}
