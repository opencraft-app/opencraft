import './global.css';

import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: {
    default: 'mono2 Docs / mono2 文档',
    template: '%s | mono2 Docs',
  },
  description:
    'AI-friendly bilingual documentation portal for mono2 services and protocols. 面向人类和 AI 的 mono2 双语文档入口。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider theme={{ defaultTheme: 'dark' }}>{children}</RootProvider>
      </body>
    </html>
  );
}
