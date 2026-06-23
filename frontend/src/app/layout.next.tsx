import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_PUBLIC_ROUTE_LOCALE } from '@next-site/public-locale';
import { siteUrl, siteVerification, themeColor } from '@next-site/seo';

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
  applicationName: 'LightVela',
  authors: [{ name: 'Tencent Lighthouse Team' }],
  creator: 'Tencent Lighthouse Team',
  publisher: 'Tencent Cloud',
  category: 'technology',
  referrer: 'origin-when-cross-origin',
  formatDetection: {
    telephone: false,
    address: false,
    email: false,
  },
  manifest: '/manifest.webmanifest',
  verification: siteVerification(),
  icons: {
    icon: [
      { url: '/lightvela-icon.png', type: 'image/png' },
      { url: '/lightvela-icon.svg', type: 'image/svg+xml' },
    ],
    shortcut: '/lightvela-icon.png',
    apple: '/lightvela-icon.png',
  },
  appleWebApp: {
    capable: true,
    title: 'LightVela',
    statusBarStyle: 'default',
  },
  other: {
    'theme-color': themeColor(),
    'color-scheme': 'light',
    'mobile-web-app-capable': 'yes',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
