import { useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSwitch } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useDefaultFollowUpAction } from "../runtime/use-default-follow-up-action";
import { TurnNotificationSettings } from "./turn-notification-settings";

export function ChatSettings() {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const defaultFollowUpAction = useDefaultFollowUpAction();
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.chat.immediateFollowUp", defaultMessage: "Follow up immediately while responding" });

  return <>
    <SettingsPageHeader title={intl.formatMessage({ id: "settings.chat", defaultMessage: "Chat" })} />
    <SettingsGroup>
      <SettingsRow
        label={label}
        description={intl.formatMessage({ id: "settings.chat.immediateFollowUp.description", defaultMessage: "New messages guide the current response. Turn this off to queue them for the next response. Temporary side chats always follow up immediately." })}
        controlWidth="compact"
      >
        <SettingsSwitch checked={defaultFollowUpAction === "steer"} label={label} disabled={saving} onCheckedChange={(checked) => {
          setSaveError(false);
          setSaving(true);
          void preferences.set("chat.defaultFollowUpAction", checked ? "steer" : "queue")
            .catch(() => setSaveError(true))
            .finally(() => setSaving(false));
        }} />
      </SettingsRow>
    </SettingsGroup>
    <TurnNotificationSettings />
    {saveError ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
