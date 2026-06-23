import { siteUrl, themeColor } from '@next-site/seo';

export const dynamic = 'force-static';

export function GET() {
  const origin = siteUrl();
  const body = {
    name: 'LightVela',
    short_name: 'LightVela',
    description: 'LightVela cloud AI agent hosting.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: themeColor(),
    icons: [
      {
        src: `${origin}/lightvela-icon.png`,
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: `${origin}/lightvela-icon.svg`,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };

  return Response.json(body, {
    headers: {
      'cache-control': 'public, max-age=3600',
    },
  });
}
