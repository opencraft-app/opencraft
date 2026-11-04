import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FormattedMessage, useIntl } from '@opencraft/i18n/react';
import { WEB_UPDATE_PATH, parseFullUpgradeStatus } from '@opencraft/web-update-protocol';
import type { UpgradeState } from '@opencraft/web-update-protocol';
import { SettingsSection, SettingsGroup, SettingsRow, SettingsActions, SettingsButton, SettingsNotice } from '@opencraft/extension-react';
import { SettingsIdentifier } from './settings-identifier';

const key = ['full-upgrade'] as const;
const messages = {
  queued: { id: 'fullUpgrade.queued', defaultMessage: 'Queued' },
  checking: { id: 'webUpdates.checking', defaultMessage: 'Checking…' },
  downloading: { id: 'fullUpgrade.downloading', defaultMessage: 'Downloading' },
  prepared: { id: 'fullUpgrade.prepared', defaultMessage: 'Ready to switch' },
  switching: { id: 'fullUpgrade.switching', defaultMessage: 'Switching' },
  'active-draining': { id: 'fullUpgrade.draining', defaultMessage: 'Finishing existing work' },
  completed: { id: 'fullUpgrade.completed', defaultMessage: 'Completed' },
  deferred: { id: 'fullUpgrade.deferred', defaultMessage: 'Stopped at a safe point' },
  failed: { id: 'fullUpgrade.failed', defaultMessage: 'Failed' },
  'rolling-back': { id: 'fullUpgrade.rollingBack', defaultMessage: 'Rolling back' },
  'rolled-back': { id: 'fullUpgrade.rolledBack', defaultMessage: 'Rolled back' },
  'recovery-required': { id: 'fullUpgrade.recovery', defaultMessage: 'Local recovery required' },
  blocked: { id: 'fullUpgrade.blocked', defaultMessage: 'Upgrade requirements not met' },
} satisfies Record<UpgradeState, { id: string; defaultMessage: string }>;
export function FullUpgradeSettings({ authenticated }: { authenticated: boolean }) {
  const intl = useIntl();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const query = useQuery({ queryKey: key, enabled: authenticated, retry: false, refetchInterval: 2000,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${WEB_UPDATE_PATH}/full`, { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) throw new Error('full-upgrade-unavailable');
      return parseFullUpgradeStatus(await response.json());
    } });
  if (!authenticated) return null;
  const data = query.data;
  const plan = data?.plan;
  async function action(name: 'check' | 'start' | 'stop', input: object = {}) {
    if (pending) return;
    setPending(true); setFailed(false);
    try {
      const response = await fetch(`${WEB_UPDATE_PATH}/full/${name}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error('full-upgrade-unavailable');
    } catch { setFailed(true); }
    finally { await client.invalidateQueries({ queryKey: key }); setPending(false); }
  }
  const stateText = (state: UpgradeState) => intl.formatMessage(messages[state]);
  return <SettingsSection className="full-upgrade-settings" title={intl.formatMessage({ id: 'fullUpgrade.title', defaultMessage: 'All updates' })}>
    {(failed || query.error || data?.unavailable) && <SettingsNotice tone="error"><FormattedMessage id="fullUpgrade.unavailable" defaultMessage="Upgrade control unavailable. Try again." /></SettingsNotice>}
    {plan && <>
      <SettingsGroup>
        <SettingsRow label={<FormattedMessage id="fullUpgrade.release" defaultMessage="Target release" />} description={plan.channel ?? undefined}>{plan.releaseId ? <SettingsIdentifier value={plan.releaseId} /> : '—'}</SettingsRow>
        <SettingsRow label={<FormattedMessage id="fullUpgrade.status" defaultMessage="Status" />}>{stateText(plan.status)}</SettingsRow>
      </SettingsGroup>
      <details className="full-upgrade-details"><summary><FormattedMessage id="fullUpgrade.details" defaultMessage="View details" /></summary>
        <p className="full-upgrade-revision">{plan.sourceRevision}</p>
        {plan.blockedReasons.map(reason => <p className="full-upgrade-revision" key={reason}>{reason}</p>)}
        {plan.components.length > 0 && <SettingsGroup>{plan.components.map(c => <SettingsRow key={c.componentId} label={c.role} description={stateText(c.state)}>
          {c.runningVersion ? <SettingsIdentifier value={c.runningVersion} /> : '—'} → {c.targetVersion ? <SettingsIdentifier value={c.targetVersion} /> : '—'}
        </SettingsRow>)}</SettingsGroup>}
      </details>
    </>}
    <SettingsActions align="start">
      <SettingsButton disabled={pending || data?.unavailable} aria-busy={pending} onClick={() => void action('check')}><FormattedMessage id="webUpdates.check" defaultMessage="Check updates" /></SettingsButton>
      <SettingsButton variant="primary" disabled={pending || !data?.fullStackExecutable || !plan?.executable} onClick={() => void action('start', { planDigest: plan?.planDigest, jobId: 'full-' + plan?.planDigest })} aria-describedby={!plan?.executable ? 'full-upgrade-blocked' : undefined}><FormattedMessage id="fullUpgrade.install" defaultMessage="Upgrade all components" /></SettingsButton>
    </SettingsActions>
    {!plan?.executable && <SettingsNotice id="full-upgrade-blocked"><FormattedMessage id="fullUpgrade.blocked" defaultMessage="Upgrade requirements not met" /></SettingsNotice>}
    {data?.jobs.map(job => <SettingsGroup key={job.jobId}>
      <SettingsRow label={<FormattedMessage id="fullUpgrade.status" defaultMessage="Status" />} description={job.jobId}>{stateText(job.state)}</SettingsRow>
      <details className="full-upgrade-details"><summary><FormattedMessage id="fullUpgrade.details" defaultMessage="View details" /></summary>
      <p className="full-upgrade-revision">{job.releaseId ?? job.targetVersion}</p>
      {job.components.length > 0 && <SettingsGroup>{job.components.map((c, i) => <SettingsRow key={`${c.componentId}-${i}`} label={c.componentId}>{stateText(c.state)}{c.childJobId && <code>{c.childJobId}</code>}</SettingsRow>)}</SettingsGroup>}
      </details>
      {job.recoveryCommand && <SettingsNotice tone="error">{job.reason}<code className="full-upgrade-recovery">{job.recoveryCommand}</code></SettingsNotice>}
      {!['blocked', 'completed', 'failed', 'deferred', 'rolled-back', 'recovery-required'].includes(job.state) && <SettingsActions>
        <SettingsButton disabled={pending || job.stopRequested} onClick={() => void action('stop', { jobId: job.jobId })}>{job.stopRequested
          ? <FormattedMessage id="fullUpgrade.stopping" defaultMessage="Stopping at a safe point" />
          : ['queued', 'checking', 'downloading', 'prepared'].includes(job.state)
            ? <FormattedMessage id="fullUpgrade.cancel" defaultMessage="Cancel upgrade" />
            : <FormattedMessage id="fullUpgrade.stop" defaultMessage="Stop after this step" />}</SettingsButton>
      </SettingsActions>}
    </SettingsGroup>)}
  </SettingsSection>;
}
