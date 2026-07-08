import { siteUrl } from '@next-site/seo';

export const dynamic = 'force-static';

export function GET() {
  return new Response(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /support/lv-console-0925/',
      `Sitemap: ${siteUrl()}/sitemap.xml`,
      '',
    ].join('\n'),
    {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    },
  );
}
