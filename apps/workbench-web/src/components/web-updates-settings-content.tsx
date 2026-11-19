import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FormattedMessage, useIntl } from '@opencraft/i18n/react';
import { WEB_UPDATE_PATH } from '@opencraft/web-update-protocol';
import { SettingsPageHeader, SettingsSection, SettingsGroup, SettingsRow, SettingsActions, SettingsButton, SettingsNotice, SettingsTextInput } from '@opencraft/extension-react';
import { SettingsIdentifier } from './settings-identifier';

import { FullUpgradeSettings } from './full-upgrade-settings';
import { browserServerContext } from '../runtime/server-context';

import { useUpdates, queryKey } from './web-updates-settings';

export function WebUpdatesSettings() {
  if (browserServerContext()) return <SettingsNotice><FormattedMessage id="webUpdates.directManagement" defaultMessage="Manage software updates through this server’s deployment entry." /></SettingsNotice>;
  return <ManagedWebUpdatesSettings />;
}
function ManagedWebUpdatesSettings() {
  const intl = useIntl();
  const query = useUpdates();
  const client = useQueryClient();
  const [key, setKey] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = query.data;
  const checkErrors = {
    authentication: intl.formatMessage({ id: 'webUpdates.error.authentication', defaultMessage: 'npm authentication failed. Configure npm credentials for the website deployment user.' }),
    network: intl.formatMessage({ id: 'webUpdates.error.network', defaultMessage: 'Cannot reach the npm registry. Check the server network and retry.' }),
    unavailable: intl.formatMessage({ id: 'webUpdates.error.unavailable', defaultMessage: 'npm is not available to the website service. Check its PATH configuration.' }),
    registry: intl.formatMessage({ id: 'webUpdates.error.registry', defaultMessage: 'The npm registry rejected the request. Check the server registry configuration.' }),
  };
  const updating = status?.job && !['completed', 'failed'].includes(status.job.phase);
  const running = status?.checking || updating;
  async function action(name: string, input: object = {}) {
    if (pending) return;
    setPending(name); setError(null);
    try {
      const response = await fetch(`${WEB_UPDATE_PATH}/${name}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : 'Website update request failed');
      if (name === 'login') setKey('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { await client.invalidateQueries({ queryKey }); setPending(null); }
  }
  const currentBuild = document.querySelector('meta[name="opencraft-build-id"]')?.getAttribute('content');
  const needsRefresh = status && currentBuild !== status.current.buildId;
  return <div className="web-updates-settings">
    <SettingsPageHeader title={intl.formatMessage({ id: 'webUpdates.title', defaultMessage: 'Website updates' })} description={status?.execution ? intl.formatMessage({ id: 'webUpdates.serverDescription', defaultMessage: 'Update the website and execution gateway. Codex tasks continue in the independent core; OpenCraft tasks may be interrupted.' }) : intl.formatMessage({ id: 'webUpdates.description', defaultMessage: 'Update this website from the npm registry. Your execution service keeps running.' })} />
    <FullUpgradeSettings authenticated={status?.authenticated ?? false} />
    {query.error && <SettingsNotice tone="error">{query.error.message}</SettingsNotice>}
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {status && <SettingsSection title={intl.formatMessage({ id: 'webUpdates.version', defaultMessage: 'Website version' })} description={status.execution ? intl.formatMessage({ id: 'webUpdates.executionScope', defaultMessage: 'Includes the execution gateway and daemon. Codex core, CLI and DSH engine are maintained separately.' }) : undefined} action={<SettingsButton aria-busy={pending === 'check' || status.checking} disabled={pending !== null || !!running} onClick={() => void action('check')}><FormattedMessage id="webUpdates.check" defaultMessage="Check updates" /></SettingsButton>}>
      <SettingsGroup>
        <SettingsRow label={<FormattedMessage id="webUpdates.installed" defaultMessage="Installed version" />} description={status.current.buildId ? <SettingsIdentifier value={status.current.buildId} /> : undefined}><SettingsIdentifier value={status.current.version} /></SettingsRow>
        {status.execution && <SettingsRow label={<FormattedMessage id="webUpdates.executionVersion" defaultMessage="Execution gateway version" />} description={status.execution.buildId ? <SettingsIdentifier value={status.execution.buildId} /> : undefined}>
          {status.execution.version ? <SettingsIdentifier value={status.execution.version} /> : '—'}
        </SettingsRow>}
        <SettingsRow label={<FormattedMessage id="webUpdates.latest" defaultMessage="Latest version" />} description={`${status.packageName} · ${status.channel}`}>
          {status.latest?.version ? <SettingsIdentifier value={status.latest.version} /> : (status.checking
            ? intl.formatMessage({ id: 'webUpdates.checking', defaultMessage: 'Checking…' })
            : status.checkError ? intl.formatMessage({ id: 'webUpdates.checkFailed', defaultMessage: 'Check failed' })
            : status.checkedAt ? intl.formatMessage({ id: 'webUpdates.notPublished', defaultMessage: 'No published release' })
            : intl.formatMessage({ id: 'webUpdates.notChecked', defaultMessage: 'Not checked' }))}
        </SettingsRow>
      </SettingsGroup>
      {status.execution && !status.execution.ready && !running && <SettingsNotice tone="error"><FormattedMessage id="webUpdates.executionUnavailable" defaultMessage="Execution gateway has not reached the target version or is unavailable. Check the execution service before retrying." /></SettingsNotice>}
      {status.checkError && <SettingsNotice tone="error">{status.checkErrorCode ? checkErrors[status.checkErrorCode] : status.checkError}</SettingsNotice>}
      {status.checkedAt && !status.checking && !status.latest && !status.checkError && <SettingsNotice><FormattedMessage id="webUpdates.notPublishedHint" defaultMessage="No website release is published on this channel yet. Your installed website keeps running; check again after a release is published." /></SettingsNotice>}
      {status.recoveryRequired && <SettingsNotice tone="error"><FormattedMessage id="fullUpgrade.recovery" defaultMessage="Local recovery required" /></SettingsNotice>}
      {status.job?.phase === 'failed' && <SettingsNotice tone="error">{status.job.error === 'upgrade-cancelled-at-safe-point' ? <FormattedMessage id="fullUpgrade.deferred" defaultMessage="Stopped at a safe point" /> : status.job.error}</SettingsNotice>}
      {updating && <SettingsNotice role="status"><FormattedMessage id="webUpdates.running" defaultMessage="Updating… You can leave this page; the server will finish the update." /></SettingsNotice>}
      {needsRefresh && <SettingsNotice><FormattedMessage id="webUpdates.refreshHint" defaultMessage="This page is still displaying the previous build. Refresh when you are ready." /> <SettingsButton onClick={() => location.reload()}><FormattedMessage id="webUpdates.refresh" defaultMessage="Refresh page" /></SettingsButton></SettingsNotice>}
      {status.authenticated && <SettingsActions align="start" className="web-updates-actions">
        <SettingsButton variant="primary" aria-busy={pending === 'install'} disabled={pending !== null || !!running || !!status.recoveryRequired || !status.updateAvailable} onClick={() => void action('install', { version: status.latest?.version })}>{status.execution ? <FormattedMessage id="webUpdates.installServer" defaultMessage="Update website and execution service" /> : <FormattedMessage id="webUpdates.install" defaultMessage="Update website" />}</SettingsButton>
        {status.canRollback && <SettingsButton disabled={pending !== null || !!running || !!status.recoveryRequired} onClick={() => void action('rollback')}><FormattedMessage id="webUpdates.rollback" defaultMessage="Roll back previous version" /></SettingsButton>}
        <SettingsButton variant="quiet" disabled={pending !== null} onClick={() => void action('logout')}><FormattedMessage id="webUpdates.logout" defaultMessage="End administrator session" /></SettingsButton>
      </SettingsActions>}
      {!status.authenticated && <SettingsGroup><SettingsRow layout="stacked" htmlFor="web-updates-admin-key" label={<FormattedMessage id="webUpdates.admin" defaultMessage="Deployment administrator" />} description={<FormattedMessage id="webUpdates.adminHint" defaultMessage="Enter the admin-key from the website state directory to install updates or roll back." />}>
        <form onSubmit={event => { event.preventDefault(); void action('login', { key }); }}>
          <SettingsTextInput id="web-updates-admin-key" aria-label={intl.formatMessage({ id: 'webUpdates.key', defaultMessage: 'Deployment administrator key' })} type="password" autoComplete="off" value={key} onChange={event => setKey(event.currentTarget.value)} disabled={pending === 'login'} />
          <SettingsActions><SettingsButton type="submit" disabled={pending !== null || !key.trim()}><FormattedMessage id="webUpdates.authorize" defaultMessage="Authorize management" /></SettingsButton></SettingsActions>
        </form>
      </SettingsRow></SettingsGroup>}
    </SettingsSection>}
  </div>;
}
