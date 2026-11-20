import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { ServerInformationSettings } from '../../apps/workbench-web/src/components/server-information-settings';
import { initializeAppearanceTheme, setThemePreference } from '../../apps/workbench-web/src/appearance-theme';
import zh from '../../apps/workbench-web/src/i18n/locales/zh-CN.json';
import en from '../../apps/workbench-web/src/i18n/locales/en-US.json';
import '../../apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();
const params = new URLSearchParams(location.search), locale = params.get('locale') ?? 'zh-CN';
setThemePreference(params.get('theme') === 'dark' ? 'dark' : 'light');
function Fixture() {
  const [visible, setVisible] = useState(true);
  (window as any).__serverInformationFixture = { toggle: () => setVisible(v => !v) };
  return <IntlProvider locale={locale} messages={locale === 'zh-CN' ? zh : en}>
    <main className="settings-page__content">{visible ? <ServerInformationSettings /> : <p>Another settings page</p>}</main>
  </IntlProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
