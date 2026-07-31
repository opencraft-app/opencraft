import { DOCS_ROUTE_SLUGS } from './docs-route-manifest';

export const DOCS_RETIRED_ROUTE_SLUGS = {
  'en-us': [],
  'zh-cn': [],
  'zh-sg': [],
  'zh-hant': [],
} as const;

export const DOCS_STATIC_ROUTE_SLUGS = {
  'en-us': DOCS_ROUTE_SLUGS['en-us'],
  'zh-cn': DOCS_ROUTE_SLUGS['zh-cn'],
  'zh-sg': DOCS_ROUTE_SLUGS['zh-sg'],
  'zh-hant': DOCS_ROUTE_SLUGS['zh-hant'],
} as const;
