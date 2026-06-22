import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  metadataBase: new URL('https://lightvela.com'),
  title: {
    default: 'LightVela 云端专属个人 Agent',
    template: '%s | LightVela',
  },
  description: '云端托管 Hermes Agent，越聊越懂的智能伙伴。',
  icons: {
    icon: '/lightvela-icon.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
