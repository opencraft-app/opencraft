import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_PUBLIC_ROUTE_LOCALE, EN_US_LOCALE } from '@next-site/public-locale';
import { siteUrl, siteVerification, themeColor } from '@next-site/seo';

const defaultEnglish = DEFAULT_PUBLIC_ROUTE_LOCALE.locale === EN_US_LOCALE;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: defaultEnglish ? 'LightVela | Your Personal Cloud AI Agent' : 'LightVela｜云端专属个人 Agent',
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
  // 注意：`suppressHydrationWarning` 同时挂在 `<html>` 与 `<body>` 上。
  //
  // 背景：部分浏览器扩展（如 Youmind、Grammarly、Dark Reader 等）会在客户端
  // 往 `<html>` / `<body>` 注入非标准属性（`youmind-sidebar-open`、
  // `youmind-extension-version` 等），触发 Next.js 的 hydration mismatch 报错。
  // 这类差异属于用户环境注入，与我们代码无关，且只发生在这两个根节点上。
  // 挂 `suppressHydrationWarning` 只抑制该节点本身属性/文本差异的告警，
  // 不会隐藏子树里真正的 hydration 问题，所以是安全的兜底方案。
  return (
    <html lang={DEFAULT_PUBLIC_ROUTE_LOCALE.locale} suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
