import { useState, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSwitch } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useDefaultFollowUpAction } from "../runtime/use-default-follow-up-action";
import { useOpenPagesInRightPanel } from "../runtime/use-open-pages-in-right-panel";
import { TurnNotificationSettings } from "./turn-notification-settings";

export function ChatSettings({ agentManagement, onOpenImSettings }: {
  readonly agentManagement?: ReactNode;
  readonly onOpenImSettings?: () => void;
} = {}) {
  const intl = useIntl();
  const preferences = useUiPreferencesRuntime();
  const defaultFollowUpAction = useDefaultFollowUpAction();
  const openPagesInRightPanel = useOpenPagesInRightPanel();
  const [saveError, setSaveError] = useState(false);
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [savingRightPanelPages, setSavingRightPanelPages] = useState(false);
  const label = intl.formatMessage({ id: "settings.chat.immediateFollowUp", defaultMessage: "Follow up immediately while responding" });
  const rightPanelLabel = intl.formatMessage({ id: "settings.chat.openPagesInRightPanel", defaultMessage: "Open web pages in right panel" });

  return <>
    <SettingsPageHeader title={intl.formatMessage({ id: "settings.chat", defaultMessage: "Chat" })} />
    <SettingsGroup>
      <SettingsRow
        label={label}
        description={intl.formatMessage({ id: "settings.chat.immediateFollowUp.description", defaultMessage: "New messages guide the current response. Turn this off to queue them for the next response. Temporary side chats always follow up immediately." })}
        controlWidth="compact"
      >
        <SettingsSwitch checked={defaultFollowUpAction === "steer"} label={label} disabled={savingFollowUp} onCheckedChange={(checked) => {
          setSaveError(false);
          setSavingFollowUp(true);
          void preferences.set("chat.defaultFollowUpAction", checked ? "steer" : "queue")
            .catch(() => setSaveError(true))
            .finally(() => setSavingFollowUp(false));
        }} />
      </SettingsRow>
      <SettingsRow
        label={rightPanelLabel}
        description={intl.formatMessage({ id: "settings.chat.openPagesInRightPanel.description", defaultMessage: "Open clicked links and agent-launched web pages in the right-side browser panel. Turn this off to open links in your external browser and keep agent pages in the background." })}
        controlWidth="compact"
      >
        <SettingsSwitch checked={openPagesInRightPanel} label={rightPanelLabel} disabled={savingRightPanelPages} onCheckedChange={(checked) => {
          setSaveError(false);
          setSavingRightPanelPages(true);
          void preferences.set("chat.openPagesInRightPanel", checked)
            .catch(() => setSaveError(true))
            .finally(() => setSavingRightPanelPages(false));
        }} />
      </SettingsRow>
    </SettingsGroup>
    {agentManagement}
    <TurnNotificationSettings onOpenImSettings={onOpenImSettings} />
    {saveError ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
