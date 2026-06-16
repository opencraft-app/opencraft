import { source } from '@/lib/source';

export const revalidate = false;

export function GET() {
  const data = source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description ?? '',
    slug: page.slugs.join('/'),
    url: page.url,
    section: page.slugs[0] ?? 'root',
    tags: page.data.tags ?? [],
    status: page.data.status,
    owner: page.data.owner ?? '',
    source_path: page.data.source_path ?? '',
    last_reviewed: page.data.last_reviewed ?? '',
  }));

  return Response.json({
    object: 'mono2.docs.index',
    version: 'v1',
    generated_from: 'docs-site/content/docs',
    data,
  });
}
