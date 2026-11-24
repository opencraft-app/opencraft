import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { SshKeysSettings } from "../../apps/workbench-web/src/components/ssh-keys-settings";
import { AsyncNoticesProvider } from "../../apps/workbench-web/src/components/async-notices";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import zh from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import en from "../../apps/workbench-web/src/i18n/locales/en-US.json";
import "../../apps/workbench-web/src/styles/app.scss";
initializeAppearanceTheme();
const params = new URLSearchParams(location.search),
  locale = params.get("locale") ?? "zh-CN";
setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IntlProvider locale={locale} messages={locale === "zh-CN" ? zh : en}>
      <AsyncNoticesProvider>
        {/* The Settings scroll viewport, as the Settings page provides it. */}
        <div className="settings-page__viewport" data-layout="document" style={{ height: "100dvh", overflowY: "auto" }}>
          <main className="settings-page__content">
            <SshKeysSettings />
          </main>
        </div>
      </AsyncNoticesProvider>
    </IntlProvider>
  </StrictMode>,
);
