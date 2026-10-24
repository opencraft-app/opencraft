import { useState, useSyncExternalStore } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSwitch } from "@opencraft/extension-react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import { useDefaultFollowUpAction } from "../runtime/use-default-follow-up-action";
import { useAsyncNotices } from "./async-notices";
import { useTurnNotifications } from "../runtime/turn-notifications-context";

const unavailableNotifications = { supported: false, permission: "denied" as const, error: false };
const noSubscription = () => () => undefined;
const getUnavailableNotifications = () => unavailableNotifications;

export function ChatSettings() {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const preferences = useUiPreferencesRuntime();
  const defaultFollowUpAction = useDefaultFollowUpAction();
  const notifications = useTurnNotifications();
  const notificationState = useSyncExternalStore(notifications?.subscribe ?? noSubscription,
    notifications?.getSnapshot ?? getUnavailableNotifications, notifications?.getSnapshot ?? getUnavailableNotifications);
  const preferenceState = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const [neweraSaving, setNeweraSaving] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const label = intl.formatMessage({ id: "settings.chat.immediateFollowUp", defaultMessage: "Follow up immediately while responding" });
  const notificationLabel = intl.formatMessage({ id: "settings.chat.turnNotifications", defaultMessage: "Notify when a response ends" });

  return <>
    <SettingsPageHeader title={intl.formatMessage({ id: "settings.chat", defaultMessage: "Chat" })} />
    <SettingsGroup>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.chat.touchNewera", defaultMessage: "Touch Newera experience" })}
        description={intl.formatMessage({ id: "settings.chat.touchNewera.description", defaultMessage: "A subtle glass composer for touch layouts. One line when idle; focusing the input expands it automatically. On by default in the standalone touch workbench; off by default when embedded." })}
        controlWidth="compact"
      >
        <SettingsSwitch label={intl.formatMessage({ id: "settings.chat.touchNewera", defaultMessage: "Touch Newera experience" })}
          checked={preferenceState.values["chat.touchNewera"]} disabled={neweraSaving}
          onCheckedChange={(checked) => {
            setNeweraSaving(true);
            void preferences.set("chat.touchNewera", checked)
              .catch(() => notices.error({ key: "chat:touch-newera", message: intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." }) }))
              .finally(() => setNeweraSaving(false));
          }} />
      </SettingsRow>
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
      <SettingsRow
        label={notificationLabel}
        description={!notificationState.supported
          ? intl.formatMessage({ id: "settings.chat.turnNotifications.unsupported", defaultMessage: "Browser notifications are unavailable here. Use a supported browser on HTTPS." })
          : notificationState.permission === "denied"
            ? intl.formatMessage({ id: "settings.chat.turnNotifications.denied", defaultMessage: "Notifications are blocked. Allow them in your browser's site settings, then return here." })
            : intl.formatMessage({ id: "settings.chat.turnNotifications.description", defaultMessage: "Receive a browser notification after each response completes, fails or stops, including while viewing this page. The page must remain open." })}
        controlWidth="compact"
      >
        <SettingsSwitch label={notificationLabel}
          checked={preferenceState.values["chat.turnNotifications"]}
          disabled={notificationSaving || !notificationState.supported || (notificationState.permission === "denied" && !preferenceState.values["chat.turnNotifications"])}
          onCheckedChange={(checked) => {
            setSaveError(false); setPermissionError(false); setNotificationSaving(true);
            // Preserve transient user activation: ask before any asynchronous preference write.
            const permission = checked && notifications ? notifications.requestPermission() : Promise.resolve("granted" as const);
            void permission.then(async value => {
              if (checked && value !== "granted") { setPermissionError(true); return; }
              await preferences.set("chat.turnNotifications", checked);
            }).catch(() => setSaveError(true)).finally(() => setNotificationSaving(false));
          }} />
      </SettingsRow>
    </SettingsGroup>
    {permissionError ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.turnNotifications.permissionRequired", defaultMessage: "Notification permission was not granted. You can enable it again when ready." })}</SettingsNotice> : null}
    {notificationState.error ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.turnNotifications.showError", defaultMessage: "The browser could not display a notification. Check your browser and system notification settings." })}</SettingsNotice> : null}
    {saveError ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
  </>;
}
