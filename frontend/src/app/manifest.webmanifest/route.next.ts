import { siteUrl, themeColor } from '@next-site/seo';
import { LIGHTVELA_ICON_PNG_URL, LIGHTVELA_ICON_SVG_URL } from '@next-site/site-icons';

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
        src: `${origin}${LIGHTVELA_ICON_PNG_URL}`,
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: `${origin}${LIGHTVELA_ICON_SVG_URL}`,
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
