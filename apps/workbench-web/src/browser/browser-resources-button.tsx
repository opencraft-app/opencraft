import { useEffect, useRef, useState } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { GlobeIcon } from '@opencraft/design-system-web/action-icons';
import { SettingsButton, SettingsGroup, SettingsListItem, SettingsPanel } from '@opencraft/extension-react';
import { ModalSurface } from '../components/modal/modal-surface';
import { useAsyncNotices } from '../components/async-notices-context';
import type { BrowserSurfaceHost } from './web-browser-surface-host';
import type { BrowserWorkbenchCoordinator } from './browser-workbench-coordinator';
import type { RemoteBrowserCatalog } from './desktop-browser-storage';

/** Account catalog, independent of conversation aliases and native attachments. */
export function BrowserResourcesButton({ surfaces, workbench, ownerId, showLabel = false }: {
  surfaces?: BrowserSurfaceHost; workbench: BrowserWorkbenchCoordinator; ownerId: string; showLabel?: boolean;
}) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<RemoteBrowserCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const title = intl.formatMessage({ id: 'browser.resources.title', defaultMessage: 'Browser resources' });
  const reportFailure = (operation: 'load' | 'open' | 'close') => {
    const message = operation === 'load'
      ? intl.formatMessage({ id: 'browser.resources.loadFailed', defaultMessage: 'Could not load browser pages. Try refreshing.' })
      : operation === 'open'
        ? intl.formatMessage({ id: 'browser.resources.openFailed', defaultMessage: 'Could not open this page. Try again.' })
        : intl.formatMessage({ id: 'browser.resources.closeFailed', defaultMessage: 'Could not close this page. Try again.' });
    notices.error({ key: `browser-resources:${ownerId}:${operation}`, message });
  };
  const refresh = async () => {
    const intent = ++generation.current; setBusy(true);
    try { const result = await surfaces!.listResources!(); if (intent === generation.current) setCatalog(result); }
    catch { if (intent === generation.current) reportFailure('load'); }
    finally { if (intent === generation.current) setBusy(false); }
  };
  useEffect(() => {
    if (open) void refresh();
    return () => { ++generation.current; };
  }, [open, surfaces]);
  if (!surfaces?.listResources || !surfaces.closeResource) return null;
  return <>
    <button type="button" className="browser-toolbar-button" title={title} aria-label={title} onClick={() => setOpen(true)}><GlobeIcon size={15} />{showLabel ? <span>{title}</span> : null}</button>
    {open ? <ModalSurface label={title} size="wide" onDismiss={() => setOpen(false)} closeLabel={intl.formatMessage({ id: 'common.close', defaultMessage: 'Close' })}>
      <SettingsPanel title={title} actions={<SettingsButton variant="quiet" disabled={busy} onClick={() => void refresh()}>{intl.formatMessage({ id: 'common.refresh', defaultMessage: 'Refresh' })}</SettingsButton>}>
        <p>{intl.formatMessage({ id: 'browser.resources.description', defaultMessage: 'All saved pages in your account, including pages without a conversation. Closing a page discards its unsaved content.' })}</p>
        {catalog ? <p role="status">{intl.formatMessage({ id: 'browser.resources.capacity', defaultMessage: 'Your reserved pages: {used}/{limit} · Shared capacity: {total}/{maximum}' }, { used: catalog.capacity.accountUsed, limit: catalog.capacity.accountLimit, total: catalog.capacity.used, maximum: catalog.capacity.limit })}</p> : null}
        {!catalog && busy ? <p role="status">{intl.formatMessage({ id: 'common.loading', defaultMessage: 'Loading…' })}</p> : null}
        <SettingsGroup appearance="plain">{catalog?.sessions.map(resource => <SettingsListItem key={resource.sessionId}
          label={<SettingsButton variant="quiet" disabled={busy || resource.lifecycle !== 'open' || !!resource.link && resource.link.scopeId !== ownerId} onClick={() => {
            try { workbench.openResource(ownerId, resource.lease, resource.url); setOpen(false); }
            catch { reportFailure('open'); }
          }}>{resource.url || intl.formatMessage({ id: 'browser.newTab', defaultMessage: 'New tab' })}</SettingsButton>}
          description={resource.link ? intl.formatMessage({ id: 'browser.resources.linked', defaultMessage: 'Conversation page' }) : intl.formatMessage({ id: 'browser.resources.unassigned', defaultMessage: 'Unassigned page · open to reconnect' })}
          metadata={resource.lifecycle === 'closing'
            ? intl.formatMessage({ id: 'browser.resources.closing', defaultMessage: 'Closing…' })
            : resource.runtime === 'live' ? intl.formatMessage({ id: 'browser.resources.live', defaultMessage: 'Running' })
            : resource.runtime === 'absent' ? intl.formatMessage({ id: 'browser.resources.saved', defaultMessage: 'Saved · no active page' })
            : intl.formatMessage({ id: 'browser.resources.pending', defaultMessage: 'Awaiting runtime confirmation' })}
          actions={<SettingsButton variant="quiet" disabled={busy} onClick={() => {
            const intent = ++generation.current; setBusy(true);
            void surfaces.closeResource!(resource.lease).then(async () => {
              if (intent === generation.current) { workbench.forgetResource(resource.lease); await refresh(); }
            }).catch(() => { if (intent === generation.current) reportFailure('close'); })
              .finally(() => { if (intent === generation.current) setBusy(false); });
          }}>{intl.formatMessage({ id: 'common.close', defaultMessage: 'Close' })}</SettingsButton>} />)}</SettingsGroup>
        {catalog?.sessions.length === 0 ? <p>{intl.formatMessage({ id: 'browser.resources.empty', defaultMessage: 'No saved browser pages.' })}</p> : null}
      </SettingsPanel>
    </ModalSurface> : null}
  </>;
}
