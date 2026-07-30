'use client';

import { AppRouteShell, ProductSetupRouteLoading } from './app-route-shell';
import { renderNextLanguageSwitcher } from './language-switcher';
import { PublicHeaderAuthIsland } from './public-header-auth-island';
import { SubscribePage } from './subscribe-page';
import { renderNextPublicSiteHeaderLink } from './user-menu-link';

export function SubscribePageClient() {
  return (
    <AppRouteShell loadingFallback={<ProductSetupRouteLoading />} requireAuth={false}>
      <SubscribePage
        authControls={<PublicHeaderAuthIsland />}
        publicLocalized
        renderLanguageSwitcher={renderNextLanguageSwitcher}
        renderLink={renderNextPublicSiteHeaderLink}
      />
    </AppRouteShell>
  );
}
