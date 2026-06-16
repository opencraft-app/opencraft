import { ApiReference } from '@scalar/nextjs-api-reference';

import { languageFromRequest } from '@/lib/language';

const baseConfiguration = {
  theme: 'deepSpace',
  darkMode: true,
  hideDarkModeToggle: false,
} as Parameters<typeof ApiReference>[0] & {
  darkMode: boolean;
  hideDarkModeToggle: boolean;
};

export async function GET(request: Request, context: { params: Promise<{ component: string }> }) {
  const { component } = await context.params;
  if (!/^[a-z0-9-]+$/.test(component)) {
    return Response.json({ error: `invalid component id: ${component}` }, { status: 400 });
  }

  const lang = languageFromRequest(request);
  const configuration = {
    ...baseConfiguration,
    url: `/openapi/${component}?lang=${lang}`,
    metaData:
      lang === 'en'
        ? {
            title: `${component} API Reference`,
            description: `Generated OpenAPI reference for ${component}.`,
          }
        : {
            title: `${component} API Reference`,
            description: `${component} 的 OpenAPI 参考。`,
          },
  } as Parameters<typeof ApiReference>[0] & {
    darkMode: boolean;
    hideDarkModeToggle: boolean;
  };

  return ApiReference(configuration)();
}
