import './global.css';

import { LanguageToggle } from '@/components/language-toggle';
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
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var l=localStorage.getItem('mono2-docs-language');if(l!=='en'&&l!=='zh')l=(navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en';document.documentElement.dataset.docsLang=l;}catch(e){document.documentElement.dataset.docsLang='zh';}",
          }}
        />
        <RootProvider theme={{ defaultTheme: 'dark' }}>
          <LanguageToggle />
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
