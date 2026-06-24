import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'velaChat SPEC',
    },
    links: [
      {
        text: 'API Reference',
        url: '/api-reference',
      },
    ],
  };
}
