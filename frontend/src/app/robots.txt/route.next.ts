export const dynamic = 'force-static';

export function GET() {
  return new Response(['User-agent: *', 'Allow: /', 'Sitemap: https://lightvela.com/sitemap.xml', ''].join('\n'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}
