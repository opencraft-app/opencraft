import type { Metadata } from 'next';

import { FederationAuthorizePageClient } from '@next-site/federation-authorize-page-client';

export const metadata: Metadata = {
  title: 'Authorize',
  robots: {
    index: false,
    follow: false,
  },
};

export default function FederationAuthorizeRoute() {
  return <FederationAuthorizePageClient />;
}
