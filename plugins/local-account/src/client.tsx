import { useEffect, useState } from 'react';
import type { TrustedExtensionDefinition } from '@opencraft/extension-runtime';
import { SettingsButton, SettingsPageHeader, SettingsSection, SettingsGroup, SettingsRow } from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';

const ID = 'opencraft.account';
export function createLocalAccountExtension(fetcher: typeof fetch, manageUrl = '/__opencraft_account/'): TrustedExtensionDefinition {
  function AccountView() {
    const intl = useIntl();
    const [available, setAvailable] = useState<boolean | null>(null);
    useEffect(() => {
      const controller = new AbortController();
      void fetcher('/__opencraft_account/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        .then(async response => {
          const enabled = response.ok && response.headers.get('content-type')?.includes('application/json')
            && typeof (await response.json()).authority === 'string';
          if (!controller.signal.aborted) setAvailable(enabled === true);
        })
        .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
      return () => controller.abort();
    }, []);
    const title = intl.formatMessage({ id: 'localAccount.title', defaultMessage: 'Accounts and members' });
    return <>
      <SettingsPageHeader title={title} description={intl.formatMessage({ id: 'localAccount.description', defaultMessage: 'Sign in to this server and manage its members.' })} />
      <SettingsSection title={title}>
        <SettingsGroup><SettingsRow label={intl.formatMessage({ id: 'localAccount.identity', defaultMessage: 'Human identity' })}
          description={intl.formatMessage({ id: 'localAccount.identity.description', defaultMessage: 'Verified sign-in methods share a stable Human. Server membership controls access.' })}>
          <SettingsButton disabled={available !== true} onClick={() => {
            const destination = new URL(manageUrl, window.location.href);
            destination.searchParams.set('locale', intl.locale);
            window.location.assign(destination.href);
          }}>
            {intl.formatMessage({ id: 'localAccount.manage', defaultMessage: 'Manage accounts' })}
          </SettingsButton>
        </SettingsRow></SettingsGroup>
        {available === false ? <p role="status">{intl.formatMessage({ id: 'localAccount.unavailable', defaultMessage: 'This server has not enabled the local account plugin.' })}</p> : null}
      </SettingsSection>
    </>;
  }
  return {
    manifest: { manifestVersion: 1, id: ID, name: 'Accounts and members', version: '0.1.0', apiVersion: 1,
      trust: 'trusted', platforms: ['web', 'electron'], activationEvents: ['onStartupFinished'] },
    activate(api) {
      api.views.register({ id: ID + '.view', title: 'Accounts and members', viewType: ID + '.view', platforms: ['web', 'electron'] });
      api.settings.registerPage({ id: ID, title: 'Accounts and members', titleMessage: { id: 'localAccount.title', defaultMessage: 'Accounts and members' },
        viewId: ID + '.view', group: 'Server', groupMessage: { id: 'settings.groups.server', defaultMessage: 'Server' }, icon: 'user-round-cog', platforms: ['web', 'electron'] });
      api.internal.register('platformViewRenderer', { viewType: ID + '.view', Component: AccountView });
    },
  };
}
