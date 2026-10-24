import { useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsRow, SettingsSwitch } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../../runtime/ui-preferences-runtime";
import { useAsyncNotices } from "../../components/async-notices-context";
import { useConversationOverviewEnabled } from "./preference";

export function ConversationOverviewSetting() {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const enabled = useConversationOverviewEnabled();
  const notices = useAsyncNotices();
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "overview.setting", defaultMessage: "Conversation overview button" });
  return <>
    <SettingsRow label={label} description={intl.formatMessage({ id: "overview.setting.description", defaultMessage: "Show a button before sidebar search to browse conversations and their latest exchanges." })} controlWidth="compact">
      <SettingsSwitch label={label} checked={enabled} disabled={saving} onCheckedChange={checked => {
        setSaving(true);
        void preferences.set("sidebar.conversationOverview", checked).catch(() => notices.error({ key: "conversation-overview-preference",
          message: intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." }) })).finally(() => setSaving(false));
      }} />
    </SettingsRow>
  </>;
}
