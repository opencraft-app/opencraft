import { useEffect, useSyncExternalStore } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsGroup, SettingsRow, SettingsSwitch, SettingsButton } from '@opencraft/extension-react';
import { useTurnNotifications } from '../runtime/turn-notifications-context';
import type { TurnNotificationSnapshot } from '../runtime/turn-notification-controller';
import { useAsyncNotices } from './async-notices';

const unavailable: TurnNotificationSnapshot = { supported: false, permission: 'denied', enabled: false,
  busy: false, delivery: 'page', backgroundAvailable: false, testSent: false, error: null };
const noSubscription = () => () => undefined;
const getUnavailable = () => unavailable;

/** One settings feature. Delivery adapters and consent coordination stay in its owner. */
export function TurnNotificationSettings() {
  const intl = useIntl(), notices = useAsyncNotices(), controller = useTurnNotifications();
  const state = useSyncExternalStore(controller?.subscribe ?? noSubscription,
    controller?.getSnapshot ?? getUnavailable, controller?.getSnapshot ?? getUnavailable);
  useEffect(() => { void controller?.refresh(); }, [controller]);
  const label = intl.formatMessage({ id: 'settings.chat.turnNotifications', defaultMessage: 'Notify when a response ends' });
  useEffect(() => {
    if (state.error) {
      const message = state.error === 'permission'
        ? intl.formatMessage({ id: 'settings.chat.turnNotifications.permissionRequired', defaultMessage: 'Notification permission was not granted. You can enable it again when ready.' })
        : state.error === 'save'
        ? intl.formatMessage({ id: 'settings.chat.saveError', defaultMessage: 'Could not save your preference. Please try again.' })
        : state.error === 'delivery'
        ? intl.formatMessage({ id: 'settings.chat.turnNotifications.showError', defaultMessage: 'The browser could not display a notification. Check your browser and system notification settings.' })
        : intl.formatMessage({ id: 'settings.push.error', defaultMessage: 'Could not update push notifications. Check your connection and notification permission, then try again.' });
      notices.error({ key: 'chat:turn-notifications', message });
    }
  }, [state.error, intl, notices]);
  useEffect(() => {
    if (state.testSent) notices.info({ key: 'chat:turn-notifications-test', message: intl.formatMessage({ id: 'settings.push.testSent', defaultMessage: 'Test sent to the push service. Check your device notifications.' }) });
  }, [state.testSent, intl, notices]);
  const background = state.delivery === 'background' || (!state.enabled && state.backgroundAvailable);
  const description = !state.supported
    ? intl.formatMessage({ id: 'settings.chat.turnNotifications.unsupported', defaultMessage: 'Browser notifications are unavailable here. Use a supported browser on HTTPS.' })
    : state.permission === 'denied'
    ? intl.formatMessage({ id: 'settings.chat.turnNotifications.denied', defaultMessage: "Notifications are blocked. Allow them in your browser's site settings, then return here." })
    : background
    ? intl.formatMessage({ id: 'settings.chat.turnNotifications.background', defaultMessage: 'Receive notifications when responses on this server complete, fail or stop, even after closing this app. Other servers require this page to remain open.' })
    : intl.formatMessage({ id: 'settings.chat.turnNotifications.description', defaultMessage: 'Receive a browser notification after each response completes, fails or stops, including while viewing this page. The page must remain open.' });
  return <SettingsGroup>
    <SettingsRow label={label} description={description} controlWidth="compact">
      <SettingsSwitch label={label} checked={state.enabled}
        disabled={state.busy || !state.supported}
        onCheckedChange={enabled => { void controller?.setEnabled(enabled); }} />
    </SettingsRow>
    {state.enabled && state.delivery === 'background' ? <SettingsRow label={intl.formatMessage({ id: 'settings.push.testLabel', defaultMessage: 'Check notification delivery' })} controlWidth="compact">
      <SettingsButton disabled={state.busy} onClick={() => { void controller?.test(); }}>{intl.formatMessage({ id: 'settings.push.test', defaultMessage: 'Send test notification' })}</SettingsButton>
    </SettingsRow> : null}
  </SettingsGroup>;
}
