import { useEffect, useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsActions, SettingsButton, SettingsNotice, SettingsRow, SettingsSwitch } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";

export function TouchDensitySetting() {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const choice = snapshot.values["interface.touchFriendly"];
  const [coarse, setCoarse] = useState(() => window.matchMedia("(any-pointer: coarse)").matches);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(any-pointer: coarse)");
    const update = () => setCoarse(query.matches);
    query.addEventListener("change", update); update();
    return () => query.removeEventListener("change", update);
  }, []);
  const label = intl.formatMessage({ id: "settings.touchFriendly", defaultMessage: "Touch friendly" });
  const save = (value: "auto" | "on" | "off") => {
    setSaving(true); setFailed(false);
    void preferences.set("interface.touchFriendly", value).catch(() => setFailed(true)).finally(() => setSaving(false));
  };
  return <>
    <SettingsRow label={label} description={intl.formatMessage({ id: "settings.touchFriendly.description", defaultMessage: "Larger touch targets and spacing, with hold-to-dictate. Automatically enabled on touch devices, including tablets and foldables." })} controlWidth="compact">
      <SettingsActions>
        <SettingsSwitch label={label} checked={choice === "on" || (choice === "auto" && coarse)} disabled={saving} onCheckedChange={checked => save(checked ? "on" : "off")} />
        {choice !== "auto" ? <SettingsButton disabled={saving} onClick={() => save("auto")}>{intl.formatMessage({ id: "settings.touchFriendly.auto", defaultMessage: "Restore automatic" })}</SettingsButton> : null}
      </SettingsActions>
    </SettingsRow>
    {failed ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
