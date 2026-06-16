import './global.css';

import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: {
    default: 'mono2 Docs',
    template: '%s | mono2 Docs',
  },
  description: 'AI-friendly documentation portal for mono2 services and protocols.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
