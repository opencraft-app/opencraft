import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';

import { getMDXComponents } from '../mdx-components';
import { source } from './source';

export type DocsLocalePrefix = 'en-us' | 'zh-cn' | 'zh-sg' | undefined;

export function docsSlug(_prefix: DocsLocalePrefix, slug?: string[]) {
  const pageSlug = slug && slug.length > 0 ? slug : ['overview'];
  return pageSlug;
}

export function getDocsPage(prefix: DocsLocalePrefix, slug?: string[]) {
  const page = source.getPage(docsSlug(prefix, slug), prefix);
  if (!page) notFound();
  return page;
}

export function LightVelaDocsPage({ prefix, slug }: { prefix?: DocsLocalePrefix; slug?: string[] }) {
  const page = getDocsPage(prefix, slug);
  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} className="lv-docs-page">
      <DocsTitle className="lv-docs-title !mb-3 !text-[2rem] !font-bold !leading-[1.2] !tracking-normal">
        {page.data.title}
      </DocsTitle>
      <DocsDescription className="lv-docs-description !mb-8 !text-base !leading-[1.7]">
        {page.data.description}
      </DocsDescription>
      <DocsBody className="prose-doc lv-docs-prose">
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function docsMetadata(prefix: DocsLocalePrefix, slug?: string[]) {
  const page = getDocsPage(prefix, slug);
  return {
    title: page.data.title,
    description: page.data.description,
  };
}
