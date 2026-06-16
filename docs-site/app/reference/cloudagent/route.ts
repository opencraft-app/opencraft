import { ApiReference } from '@scalar/nextjs-api-reference';

export const GET = ApiReference({
  url: '/openapi/cloudagent',
  theme: 'kepler',
  metaData: {
    title: 'CloudAgent HTTP Run API',
    description: 'Generated OpenAPI reference for CloudAgent sessions, runs, replay, and results.',
  },
  customCss: `
    :root,
    .light-mode,
    .dark-mode {
      --scalar-font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --scalar-font-code: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --scalar-color-accent: #45ff99;
      --scalar-background-1: #020806;
      --scalar-background-2: #06130e;
      --scalar-background-3: #0b1d15;
      --scalar-color-1: #d7ffe8;
      --scalar-color-2: #baf7d2;
      --scalar-color-3: #82a995;
      --scalar-background-accent: rgba(69, 255, 153, 0.10);
      --scalar-border-color: rgba(69, 255, 153, 0.22);
      --scalar-sidebar-background-1: #020806;
      --scalar-sidebar-item-hover-background: #0b1d15;
      --scalar-sidebar-item-active-background: rgba(69, 255, 153, 0.10);
      --scalar-sidebar-color-1: #d7ffe8;
      --scalar-sidebar-color-2: #82a995;
      --scalar-sidebar-color-active: #45ff99;
      --scalar-sidebar-search-background: #06130e;
      --scalar-sidebar-search-border-color: rgba(69, 255, 153, 0.22);
    }
    body {
      background:
        linear-gradient(rgba(69, 255, 153, 0.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(69, 255, 153, 0.025) 1px, transparent 1px),
        #020806 !important;
      background-size: 28px 28px !important;
    }
  `,
});
