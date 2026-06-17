import { bilingualText, localizedPageTree } from '@/lib/bilingual';
import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={localizedPageTree(source.pageTree)}
      nav={{
        title: bilingualText('mono2 Docs', 'mono2 文档', 'mono2 Docs'),
      }}
    >
      {children}
    </DocsLayout>
  );
}
