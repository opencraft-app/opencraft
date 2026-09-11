// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { GET as getManifest } from '../../src/app/manifest.webmanifest/route.next';
import { metadata } from '../../src/app/layout.next';
import { siteUrl } from '../seo';
import { LIGHTVELA_ICON_PNG_URL, LIGHTVELA_ICON_SVG_URL } from '../site-icons';

describe('site icon metadata', () => {
  it('uses the cache-busted LightVela icon in the document head', () => {
    expect(metadata.icons).toEqual({
      icon: [
        { url: LIGHTVELA_ICON_PNG_URL, type: 'image/png' },
        { url: LIGHTVELA_ICON_SVG_URL, type: 'image/svg+xml' },
      ],
      shortcut: LIGHTVELA_ICON_PNG_URL,
      apple: LIGHTVELA_ICON_PNG_URL,
    });
  });

  it('keeps the web manifest on the same cache-busted icon URLs', async () => {
    const manifest = (await (await getManifest()).json()) as {
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.icons).toEqual([
      {
        src: `${siteUrl()}${LIGHTVELA_ICON_PNG_URL}`,
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: `${siteUrl()}${LIGHTVELA_ICON_SVG_URL}`,
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ]);
  });
});
