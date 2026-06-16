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

export function GET(request: Request) {
  const lang = languageFromRequest(request);
  const configuration = {
    ...baseConfiguration,
    url: `/openapi/cloudagent?lang=${lang}`,
    metaData:
      lang === 'en'
        ? {
            title: 'CloudAgent HTTP Run API',
            description: 'Generated OpenAPI reference for CloudAgent sessions, runs, replay, and results.',
          }
        : {
            title: 'CloudAgent HTTP Run API',
            description: 'CloudAgent 会话、运行、回放与结果读取的 OpenAPI 参考。',
          },
  } as Parameters<typeof ApiReference>[0] & {
    darkMode: boolean;
    hideDarkModeToggle: boolean;
  };

  return ApiReference(configuration)();
}
