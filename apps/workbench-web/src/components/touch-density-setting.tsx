import { useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsNotice, SettingsRow, SettingsSegmented } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";

export function TouchDensitySetting() {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const choice = snapshot.values["interface.touchFriendly"];
  const latestSave = useRef(0);
  const [failed, setFailed] = useState(false);
  const label = intl.formatMessage({ id: "settings.touchFriendly", defaultMessage: "Touch experience" });
  const save = (value: string) => {
    if (value !== "auto" && value !== "on" && value !== "off") return;
    const attempt = ++latestSave.current;
    setFailed(false);
    void preferences.set("interface.touchFriendly", value).catch(() => {
      if (attempt === latestSave.current) setFailed(true);
    });
  };
  return <>
    <SettingsRow label={label} description={intl.formatMessage({ id: "settings.touchFriendly.description", defaultMessage: "Larger touch targets with the touch composer and navigation layout. Automatically follows touch capability, with a manual override." })} controlWidth="compact">
      <SettingsSegmented label={label} value={choice} onValueChange={save} options={[
        { value: "auto", label: intl.formatMessage({ id: "settings.touchFriendly.auto", defaultMessage: "Automatic" }) },
        { value: "on", label: intl.formatMessage({ id: "settings.touchFriendly.on", defaultMessage: "On" }) },
        { value: "off", label: intl.formatMessage({ id: "settings.touchFriendly.off", defaultMessage: "Off" }) },
      ]} />
    </SettingsRow>
    {failed ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
