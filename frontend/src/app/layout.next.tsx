import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { siteUrl } from '@next-site/seo';

const defaultEnglish = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === 'en-US';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: defaultEnglish ? 'LightVela · Your Personal Cloud AI Agent' : 'LightVela 云端专属个人 Agent',
    template: '%s | LightVela',
  },
  description: defaultEnglish
    ? 'LightVela is a cloud Agent hosting product from the Tencent Lighthouse team.'
    : '云端托管 Hermes Agent，越聊越懂的智能伙伴。',
  icons: {
    icon: '/lightvela-icon.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
