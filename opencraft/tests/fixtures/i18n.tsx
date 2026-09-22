import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { IntlRuntimeProvider, useIntl } from "@opencraft/i18n/react";
import { LocaleRuntime } from "@opencraft/i18n";
import { UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationKey } from "@opencraft/chat-core";
import { CodexComposer } from "@opencraft/codex-composer";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { IndexedDbUiPreferenceStore } from "../../apps/workbench-web/src/runtime/indexeddb-ui-preference-store";
import { WorkbenchLocaleController, WorkbenchIntlProvider } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { LanguageSetting } from "../../apps/workbench-web/src/i18n/language-setting";
import { localeCatalogs } from "../../apps/workbench-web/src/i18n/catalogs";
import "../../apps/workbench-web/src/styles/app.scss";

const preferences = await UiPreferencesRuntime.open({ installation: await IndexedDbUiPreferenceStore.open({ databaseName: "opencraft-i18n-test" }) });
const locale = new WorkbenchLocaleController(preferences, { ideLocale: "en-US" });
await locale.initialize();
const second = new LocaleRuntime(localeCatalogs);
await second.update({ localeOverride: "en-US" });
let id = 0;
const composer = createComposerController({ type: "existing-thread", key: createConversationKey("test", "i18n") }, { now: Date.now, createId: () => String(++id) });
function Probe() {
  const intl = useIntl();
  return <output data-locale-probe>{intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}</output>;
}
function App() {
  const snapshot = useSyncExternalStore(locale.subscribe, locale.getSnapshot);
  return <main style={{ padding: 32 }}>
    <UiPreferencesProvider runtime={preferences}>
      <WorkbenchIntlProvider controller={locale} target={document.documentElement}>
        <LanguageSetting />
        <Probe />
        <div data-imperative>{snapshot.intl.formatMessage({ id: "settings.title", defaultMessage: "Settings" })}</div>
        <CodexComposer controller={composer} onSubmit={() => false} onCancel={() => {}}
          selectionCatalog={{ agents: [], models: [{ id: "fixture", value: "fixture", label: "Fixture", isDefault: true, description: null, efforts: [], defaultEffort: null, inputModalities: ["text"] }], permissionProfiles: [] }} />
      </WorkbenchIntlProvider>
    </UiPreferencesProvider>
    <section data-independent><IntlRuntimeProvider runtime={second}><Probe /></IntlRuntimeProvider></section>
  </main>;
}
(window as any).__localeFixture = {
  switch: (value: string) => preferences.set("locale.override", value),
  inherited: (ideLocale: string) => locale.configure({ ideLocale }),
  flush: () => preferences.flush(),
  second: (value: string) => second.update({ localeOverride: value }),
};
createRoot(document.getElementById("root")!).render(<App />);
