import { useSyncExternalStore } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsGroup, SettingsRow, SettingsSwitch, SettingsButton, SettingsNotice } from '@opencraft/extension-react';
import type { PwaTurnPushController } from '../runtime/pwa-turn-push';

/** Rendered only when the actual iOS Home Screen runtime exposes a device port. */
export function PwaPushSettings({controller}:{controller:PwaTurnPushController}) {
  const intl=useIntl();
  const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const busy=['loading','enabling','disabling','testing'].includes(snapshot.phase);
  const label=intl.formatMessage({id:'settings.push.label',defaultMessage:'Background response notifications'});
  return <>
    <SettingsGroup>
    <SettingsRow label={label} controlWidth="compact" description={snapshot.phase==='unavailable'
      ? intl.formatMessage({id:'settings.push.unavailable',defaultMessage:'Sign in to a server that supports push notifications.'})
      : intl.formatMessage({id:'settings.push.description',defaultMessage:'Receive notifications for responses you submit on this server, even after closing this app.'})}>
      <SettingsSwitch label={label} checked={snapshot.enabled} disabled={busy || snapshot.phase==='unavailable'}
        onCheckedChange={enabled=>{void (enabled?controller.enable():controller.disable());}} />
    </SettingsRow>
    {snapshot.enabled ? <SettingsRow label={intl.formatMessage({id:'settings.push.testLabel',defaultMessage:'Check notification delivery'})} controlWidth="compact">
      <SettingsButton disabled={busy} onClick={()=>{void controller.test();}}>{intl.formatMessage({id:'settings.push.test',defaultMessage:'Send test notification'})}</SettingsButton>
    </SettingsRow> : null}
    </SettingsGroup>
    {snapshot.phase==='error' ? <SettingsNotice tone="error">{intl.formatMessage({id:'settings.push.error',defaultMessage:'Could not update push notifications. Check your connection and notification permission, then try again.'})}
      <SettingsButton variant="quiet" onClick={()=>{void controller.refresh();}}>{intl.formatMessage({id:'settings.push.retry',defaultMessage:'Retry connection'})}</SettingsButton>
    </SettingsNotice> : null}
    {snapshot.testSent ? <SettingsNotice>{intl.formatMessage({id:'settings.push.testSent',defaultMessage:'Test sent to the push service. Check your device notifications.'})}</SettingsNotice> : null}
  </>;
}
