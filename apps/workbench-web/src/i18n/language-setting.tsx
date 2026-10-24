import { useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsNotice, SettingsRow, SettingsSelect } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { localeCatalogs } from "./catalogs";

export function LanguageSetting() {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const [error, setError] = useState(false);
  const label = intl.formatMessage({ id: "settings.language", defaultMessage: "Language", description: "Interface language preference" });
  return <>
    <SettingsRow label={label} htmlFor="workbench-language" controlWidth="compact">
      <SettingsSelect id="workbench-language" value={snapshot.values["locale.override"]} onChange={event => {
        setError(false);
        void preferences.set("locale.override", event.target.value).catch(() => setError(true));
      }}>
        <option value="">{intl.formatMessage({ id: "settings.language.default", defaultMessage: "Automatic", description: "Use embedding host or system language" })}</option>
        {localeCatalogs.map(entry => <option key={entry.locale} value={entry.locale}>{entry.label}</option>)}
      </SettingsSelect>
    </SettingsRow>
    {error ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.language.saveError", defaultMessage: "Could not save your language preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
