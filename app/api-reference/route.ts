import { ApiReference } from '@scalar/nextjs-api-reference';

export const GET = ApiReference({
  url: '/openapi/velachat.v1.yaml',
  theme: 'default',
  layout: 'modern',
  pageTitle: 'velaChat API Reference',
});
