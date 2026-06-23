# LightVela Next public site

## Domestic and global SEO contract

LightVela is built as static Next.js output and served from CDN. Search metadata must be present in the generated HTML, sitemap, and robots output; do not rely on client-side code to add SEO tags after hydration.

The public site has two production surfaces:

- Domestic site: `zh-CN`, default base URL `https://lightvela.com`.
- Global site: `en-US` and `zh-SG`, default base URL `https://lightvela.ai`.

The `zh-SG` pages intentionally reuse the Chinese content set while presenting it as the global Chinese locale. This keeps the content workload small while giving search engines a distinct regional signal from `zh-CN`.

Canonical URLs are self-referential for the current page and domain. Do not canonicalize `zh-SG` to `zh-CN`, or `zh-CN` to `zh-SG`; that would tell search engines to fold one regional page into the other. Cross-domain relationships belong in `hreflang` alternates instead.

`frontend/next-site/seo.tsx` owns the SEO contract:

- `SEO_PUBLIC_URL_LANGS` controls which public routes are generated for the current build region.
- `SEO_DOCS_ROUTE_LOCALES` controls which docs routes are generated for the current build region.
- `SEO_ALL_PUBLIC_URL_LANGS` and `SEO_ALL_DOCS_ROUTE_LOCALES` control cross-domain `hreflang` alternates.
- `NEXT_PUBLIC_CN_SITE_URL` and `NEXT_PUBLIC_GLOBAL_SITE_URL` can override the domestic and global production origins used in metadata and sitemap output.

When adding a public page or docs route, make sure it is represented in static route generation, metadata alternates, and `sitemap.xml`.
