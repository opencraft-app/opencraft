import { ApiReference } from '@scalar/nextjs-api-reference';

const configuration = {
  url: '/openapi/cloudagent',
  theme: 'deepSpace',
  darkMode: true,
  hideDarkModeToggle: false,
  metaData: {
    title: 'CloudAgent HTTP Run API',
    description: 'Generated OpenAPI reference for CloudAgent sessions, runs, replay, and results.',
  },
} as Parameters<typeof ApiReference>[0] & {
  darkMode: boolean;
  hideDarkModeToggle: boolean;
};

export const GET = ApiReference(configuration);
