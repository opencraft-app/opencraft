import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { I18nProvider } from 'fumadocs-ui/contexts/i18n';
import type { ReactNode } from 'react';

import { source } from './source';
import type { DocsLocalePrefix } from './docs-page';
import { ZH_CN_URL_LANG } from './public-locale';
import { fumadocsTranslations } from './docs-ui-translations';
export { fumadocsTranslations } from './docs-ui-translations';

export function LightVelaDocsLayout({
  children,
  contentLocale = ZH_CN_URL_LANG,
}: {
  children: ReactNode;
  contentLocale?: DocsLocalePrefix;
}) {
  const docsLocale = contentLocale ?? ZH_CN_URL_LANG;
  const translations = fumadocsTranslations(docsLocale);

  return (
    <div className="lv-docs-shell">
      <I18nProvider locale={docsLocale} translations={translations}>
        <DocsLayout
          tree={source.getPageTree(contentLocale)}
          nav={{
            enabled: true,
          }}
          i18n={false}
          themeSwitch={{
            enabled: false,
          }}
          sidebar={{
            className: 'lv-docs-sidebar',
            collapsible: false,
          }}
          containerProps={{
            className: 'lv-docs-layout',
          }}
        >
          {children}
        </DocsLayout>
      </I18nProvider>
    </div>
  );
}
