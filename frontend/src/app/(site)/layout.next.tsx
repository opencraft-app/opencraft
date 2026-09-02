import '../global.css';

import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';

import { LightVelaSearchDialog } from '@next-site/lightvela-search-dialog';
import { PublicSiteAppProviders } from '@next-site/public-site-app-providers';
import { SiteJsonLd } from '@next-site/seo';

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* JSON-LD 挂在 client provider 外层。
          若放进 `<RootProvider>`（fumadocs 的 client component）的 children，
          Next.js 16 dev 会告警 “Scripts inside React components are never
          executed when rendering on the client” —— 因为 client 树 re-render 时
          原生 `<script>` 不再被浏览器执行。挪到 provider 外层后，它仅在 SSR
          输出一次，随后作为静态 DOM 存在，浏览器已按 JSON-LD 解析完毕。 */}
      <SiteJsonLd />
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
      </RootProvider>
    </>
  );
}
