import { NavigationItem } from "@opencraft/design-system-web/navigation";
import { RefreshIcon as RefreshCw } from "@opencraft/design-system-web/action-icons";
import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormattedMessage, useIntl } from '@opencraft/i18n/react';
import { WEB_UPDATE_PATH, parseWebUpdateStatus } from '@opencraft/web-update-protocol';
import type { WebUpdateStatus } from '@opencraft/web-update-protocol';
import { SettingsPageHeader, SettingsSection, SettingsGroup, SettingsRow, SettingsActions, SettingsButton, SettingsNotice, SettingsTextInput } from '@opencraft/extension-react';

import { browserServerContext } from '../runtime/server-context';

export function currentPlatform(): "web" | "electron" {
  return (globalThis as typeof globalThis & { opencraftDesktop?: { readonly kind?: string } })
    .opencraftDesktop?.kind === "electron" ? "electron" : "web";
}

export function hasManagedWebUpdates(): boolean {
  return !browserServerContext() && typeof document !== 'undefined' && document.querySelector('meta[name="opencraft-web-updates"]')?.getAttribute('content') === WEB_UPDATE_PATH;
}
const queryKey = ['web-deployment-updates'] as const;
function useUpdates() {
  const enabled = currentPlatform() === 'web' && hasManagedWebUpdates();
  return useQuery({ queryKey, enabled, queryFn: async ({ signal }) => {
    const response = await fetch(WEB_UPDATE_PATH, { signal, cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Website update service unavailable');
    return parseWebUpdateStatus(await response.json());
  }, retry: false, refetchInterval: query => query.state.data?.checking || (query.state.data?.job && !['completed', 'failed'].includes(query.state.data.job.phase)) ? 1000 : 30_000 });
}

export interface ManagedWebUpdateNotice {
  visible: boolean;
  updateAvailable: boolean;
  needsRefresh: boolean;
  latestVersion: string | null;
  updating: boolean;
}

export function projectManagedWebUpdateNotice(status: WebUpdateStatus | undefined, currentBuild: string | null): ManagedWebUpdateNotice {
  const needsRefresh = Boolean(status && currentBuild && currentBuild !== status.current.buildId);
  const updateAvailable = Boolean(status?.updateAvailable);
  return {
    visible: updateAvailable || needsRefresh,
    updateAvailable,
    needsRefresh,
    latestVersion: status?.latest?.version ?? null,
    updating: Boolean(status?.job && !['completed', 'failed'].includes(status.job.phase)),
  };
}

export function useManagedWebUpdateNotice(): ManagedWebUpdateNotice {
  const query = useUpdates();
  const client = useQueryClient();
  const status = query.data;
  const checkingRef = useRef(false);

  useEffect(() => {
    if (
      !status?.enabled ||
      status.checkedAt !== null ||
      status.checking ||
      Boolean(status.checkError) ||
      checkingRef.current
    ) {
      return;
    }
    checkingRef.current = true;
    void (async () => {
      try {
        await fetch(`${WEB_UPDATE_PATH}/check`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      } catch {
        // silent auto-check ignores network error; query cache will reflect status
      } finally {
        await client.invalidateQueries({ queryKey });
      }
    })();
  }, [status?.enabled, status?.checkedAt, status?.checking, status?.checkError, client]);

  const currentBuild = typeof document !== 'undefined'
    ? document.querySelector('meta[name="opencraft-build-id"]')?.getAttribute('content') ?? null
    : null;
  return projectManagedWebUpdateNotice(status, currentBuild);
}
export function WebUpdatesNavigation({ selected, onOpen }: { selected: boolean; onOpen: () => void }) {
  const query = useUpdates();
  if (!query.data?.enabled) return null;
  return <NavigationItem type="button" aria-current={selected ? 'page' : undefined} onClick={onOpen}><RefreshCw size={16} /><span><FormattedMessage id="webUpdates.title" defaultMessage="Website updates" /></span></NavigationItem>;
}
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
  return <>
    <SettingsPageHeader title={intl.formatMessage({ id: 'webUpdates.title', defaultMessage: 'Website updates' })} description={status?.execution ? intl.formatMessage({ id: 'webUpdates.serverDescription', defaultMessage: 'Update the website and execution gateway. Codex tasks continue in the independent core; OpenCraft tasks may be interrupted.' }) : intl.formatMessage({ id: 'webUpdates.description', defaultMessage: 'Update this website from the npm registry. Your execution service keeps running.' })} />
    {query.error && <SettingsNotice tone="error">{query.error.message}</SettingsNotice>}
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {status && <SettingsSection title={intl.formatMessage({ id: 'webUpdates.version', defaultMessage: 'Website version' })}>
      {status.execution && <SettingsNotice><FormattedMessage id="webUpdates.executionScope" defaultMessage="Includes the execution gateway and daemon. Codex core, CLI and DSH engine are maintained separately." /></SettingsNotice>}
      <SettingsGroup>
        <SettingsRow label={<FormattedMessage id="webUpdates.installed" defaultMessage="Installed version" />} description={status.current.buildId}>{status.current.version}</SettingsRow>
        {status.execution && <SettingsRow label={<FormattedMessage id="webUpdates.executionVersion" defaultMessage="Execution gateway version" />} description={status.execution.buildId ?? undefined}>
          {status.execution.version ?? '—'}
        </SettingsRow>}
        <SettingsRow label={<FormattedMessage id="webUpdates.latest" defaultMessage="Latest version" />} description={`${status.packageName} · ${status.channel}`}>
          {status.latest?.version ?? (status.checking
            ? intl.formatMessage({ id: 'webUpdates.checking', defaultMessage: 'Checking…' })
            : status.checkError ? intl.formatMessage({ id: 'webUpdates.checkFailed', defaultMessage: 'Check failed' })
            : status.checkedAt ? intl.formatMessage({ id: 'webUpdates.notPublished', defaultMessage: 'No published release' })
            : intl.formatMessage({ id: 'webUpdates.notChecked', defaultMessage: 'Not checked' }))}
        </SettingsRow>
      </SettingsGroup>
      {status.execution && !status.execution.ready && !running && <SettingsNotice tone="error"><FormattedMessage id="webUpdates.executionUnavailable" defaultMessage="Execution gateway has not reached the target version or is unavailable. Check the execution service before retrying." /></SettingsNotice>}
      {status.checkError && <SettingsNotice tone="error">{status.checkErrorCode ? checkErrors[status.checkErrorCode] : status.checkError}</SettingsNotice>}
      {status.checkedAt && !status.checking && !status.latest && !status.checkError && <SettingsNotice><FormattedMessage id="webUpdates.notPublishedHint" defaultMessage="No website release is published on this channel yet. Your installed website keeps running; check again after a release is published." /></SettingsNotice>}
      {status.job?.phase === 'failed' && <SettingsNotice tone="error">{status.job.error}</SettingsNotice>}
      {updating && <SettingsNotice role="status"><FormattedMessage id="webUpdates.running" defaultMessage="Updating… You can leave this page; the server will finish the update." /></SettingsNotice>}
      {status.job?.phase === 'completed' && <SettingsNotice tone="success" role="status">{status.execution ? <FormattedMessage id="webUpdates.serverCompleted" defaultMessage="Website and execution gateway updated. Reconnecting resumes your Codex tasks." /> : <FormattedMessage id="webUpdates.completed" defaultMessage="Website version switched successfully. Existing connections keep running." />}</SettingsNotice>}
      {needsRefresh && <SettingsNotice><FormattedMessage id="webUpdates.refreshHint" defaultMessage="This page is still displaying the previous build. Refresh when you are ready." /> <SettingsButton onClick={() => location.reload()}><FormattedMessage id="webUpdates.refresh" defaultMessage="Refresh page" /></SettingsButton></SettingsNotice>}
      <SettingsActions align="start" className="web-updates-actions">
        <SettingsButton aria-busy={pending === 'check' || status.checking} disabled={pending !== null || !!running} onClick={() => void action('check')}><FormattedMessage id="webUpdates.check" defaultMessage="Check updates" /></SettingsButton>
        {status.authenticated && <>
        <SettingsButton variant="primary" aria-busy={pending === 'install'} disabled={pending !== null || !!running || !status.updateAvailable} onClick={() => void action('install', { version: status.latest?.version })}>{status.execution ? <FormattedMessage id="webUpdates.installServer" defaultMessage="Update website and execution service" /> : <FormattedMessage id="webUpdates.install" defaultMessage="Update website" />}</SettingsButton>
        {status.canRollback && <SettingsButton disabled={pending !== null || !!running} onClick={() => void action('rollback')}><FormattedMessage id="webUpdates.rollback" defaultMessage="Roll back previous version" /></SettingsButton>}
        <SettingsButton variant="quiet" disabled={pending !== null} onClick={() => void action('logout')}><FormattedMessage id="webUpdates.logout" defaultMessage="End administrator session" /></SettingsButton>
        </>}
      </SettingsActions>
      {!status.authenticated && <SettingsGroup><SettingsRow layout="stacked" label={<FormattedMessage id="webUpdates.admin" defaultMessage="Deployment administrator" />} description={<FormattedMessage id="webUpdates.adminHint" defaultMessage="Enter the admin-key from the website state directory to install updates or roll back." />}>
        <form onSubmit={event => { event.preventDefault(); void action('login', { key }); }}>
          <SettingsTextInput aria-label={intl.formatMessage({ id: 'webUpdates.key', defaultMessage: 'Deployment administrator key' })} type="password" autoComplete="off" value={key} onChange={event => setKey(event.currentTarget.value)} disabled={pending === 'login'} />
          <SettingsActions><SettingsButton type="submit" disabled={pending !== null || !key.trim()}><FormattedMessage id="webUpdates.authorize" defaultMessage="Authorize management" /></SettingsButton></SettingsActions>
        </form>
      </SettingsRow></SettingsGroup>}
    </SettingsSection>}
  </>;
}
