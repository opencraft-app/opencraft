import '../global.css';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import { LightVelaSearchDialog } from '@next-site/lightvela-search-dialog';
import { PublicSiteAppProviders } from '@next-site/public-site-providers';
import { SiteJsonLd } from '@next-site/seo';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      search={{
        SearchDialog: LightVelaSearchDialog,
        options: { api: '/api/search', type: 'static' },
      }}
      theme={{ defaultTheme: 'light' }}
    >
      {/* Keep auth/runtime state at the persistent App Router layout level.
          Public pages still stream as static children, while the header auth island
          can hydrate without resetting on every client-side route transition. */}
      <PublicSiteAppProviders>{children}</PublicSiteAppProviders>
      <SiteJsonLd />
    </RootProvider>
  );
}
