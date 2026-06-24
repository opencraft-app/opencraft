'use client';

import { AppRouteShell, ProductSetupRouteLoading } from './app-route-shell';
import { renderNextLanguageSwitcher } from './language-switcher';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { DEFAULT_PUBLIC_ROUTE_LOCALE } from './public-locale';
import { SubscribePage } from './subscribe-page';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';

export function SubscribePageClient() {
  const locale = DEFAULT_PUBLIC_ROUTE_LOCALE.locale;

  return (
    <AppRouteShell loadingFallback={<ProductSetupRouteLoading />}>
      <SubscribePage
        authControls={<PublicHeaderAuthIsland locale={locale} />}
        publicLocale={locale}
        publicLocalized={DEFAULT_PUBLIC_ROUTE_LOCALE.localized}
        renderLanguageSwitcher={renderNextLanguageSwitcher}
        renderLink={renderNextPublicSiteHeaderLink}
      />
    </AppRouteShell>
  );
}
