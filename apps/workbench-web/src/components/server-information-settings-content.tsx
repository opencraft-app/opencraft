import './server-information-settings.scss';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsTextInput } from '@opencraft/extension-react';
import { browserServerContext, serverStorageKey } from '../runtime/server-context';
import { useServerRelaySummary } from '../runtime/server-relay-summary';
import { ServerInformationController } from '../runtime/server-information';

export function ServerInformationSettings() {
  const scope = serverStorageKey('server-information');
  return <ServerInformationContent key={scope} scope={scope} />;
}
function ServerInformationContent({ scope }: { scope: string }) {
  const intl = useIntl();
  const t = (id: string, defaultMessage: string) => intl.formatMessage({ id: 'settings.serverInformation.' + id, defaultMessage });
  const controller = useMemo(() => new ServerInformationController(scope), [scope]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  useEffect(() => { const release = controller.retain(); void controller.read(); return release; }, [controller]);
  useEffect(() => { if (state.phase === 'expired') { setDraft(undefined); setSaved(false); } }, [state.phase]);
  const value = draft ?? state.information?.publicUrl ?? '';
  const editable = state.authority?.canManage === true && !state.busy && !state.mustReload;
  const server = browserServerContext();
  const currentOrigin = window.location.origin;
  const currentEntry = currentOrigin + (server?.basePath ?? '');
  const relays = useServerRelaySummary(state.authority); 
  const reload = () => { setDraft(undefined); setSaved(false); void controller.read(); };
  const save = async () => { setSaved(false); if (await controller.save(value)) { setDraft(undefined); setSaved(true); } };
  const error = state.error === 'address' ? t('invalid', 'Enter a complete HTTP or HTTPS address without credentials, a query or a fragment.')
    : state.error === 'conflict' ? t('conflict', 'Another administrator changed this configuration. Reload before saving again.')
    : state.error === 'forbidden' ? t('forbidden', 'Administrator permission is required to change this server configuration.')
    : state.error ? t('failure', 'The operation could not be confirmed. Your draft is preserved; reload to check the saved configuration.') : null;
  return <>
    <SettingsPageHeader title={t('title', 'Server information')} description={t('description', 'Configure the public entry used by this server’s external notification links.')} />
    {state.phase === 'expired' ? <SettingsNotice role="alert" tone="error">{t('expired', 'Your account changed or expired. Sign in again and reopen this page.')}</SettingsNotice>
      : state.phase === 'unavailable' ? <SettingsNotice>{t('unavailable', 'This server version does not support server information yet.')}</SettingsNotice>
      : <form className="server-information-form" onSubmit={event => { event.preventDefault(); if (editable && value !== state.information?.publicUrl) void save(); }} aria-busy={!!state.busy}>
        {server ? <SettingsSection title={t('current', 'Current server')}><SettingsGroup>
          <SettingsRow label={t('name', 'Name')} description={server.name} />
          <SettingsRow label={t('id', 'Server ID')} description={server.id} />
        </SettingsGroup></SettingsSection> : null}
        <SettingsSection title={t('connection', 'Current connection')} description={t('connectionHint', 'Observed connection information only. It does not change the notification entry saved below.')}>
          <SettingsGroup>
            <SettingsRow layout="stacked" label={t('currentOrigin', 'Current access address')} description={currentOrigin} />
            <SettingsRow layout="stacked" label={t('currentEntry', 'Current server entry')} description={currentEntry} />
            {relays.phase === 'ready' ? relays.peers.length ? relays.peers.map(peer => <SettingsRow key={peer.id} layout="stacked" label={peer.name || t('relay', 'Relay')}
              description={peer.endpoint ?? t('inbound', 'Incoming connection; no public endpoint')}>
              <span>{peer.connected ? t('connected', 'Connected') : t('disconnected', 'Disconnected')}</span>
            </SettingsRow>) : <SettingsRow label={t('relay', 'Relay')} description={t('noRelay', 'No configured relay connections')} />
              : <SettingsRow label={t('relay', 'Relay')} description={relays.phase === 'denied' ? t('relayDenied', 'Relay details require administrator permission') : relays.phase === 'error' ? t('relayError', 'Relay status could not be refreshed; connection state is unknown') : t('relayLoading', 'Reading relay status…')} />}
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title={t('entry', 'Public entry')} description={t('scope', 'Shared by this server. Only administrators can change it; members can view it.')}>
          <SettingsGroup>
            <SettingsRow layout="stacked" label={t('address', 'Public access URL')} htmlFor="server-public-url"
              description={t('hint', 'Include HTTPS and any Hub/server path prefix. Leave empty to use the address saved when each notification destination was registered.')}>
              <SettingsTextInput id="server-public-url" type="url" value={value} placeholder={intl.formatMessage({"id": "settings.serverInformation.addressExample", "defaultMessage": "https://example.com/servers/server-id"})} autoComplete="off" spellCheck={false}
                readOnly={!editable} disabled={!state.information} onChange={event => { setDraft(event.currentTarget.value); setSaved(false); }} />
            </SettingsRow>
          </SettingsGroup>
          <SettingsActions>
            <SettingsButton type="submit" variant="primary" loading={state.busy === 'save'} disabled={!editable || value === state.information?.publicUrl}>{t('save', 'Save')}</SettingsButton>
            <SettingsButton type="button" disabled={!!state.busy} onClick={reload}>{t('reload', 'Reload')}</SettingsButton>
          </SettingsActions>
          {!state.information && state.phase === 'loading' ? <SettingsNotice role="status">{t('loading', 'Loading server information…')}</SettingsNotice> : null}
          {state.information && state.busy === 'read' ? <SettingsNotice role="status">{t('refreshing', 'Refreshing configuration…')}</SettingsNotice> : null}
          {error ? <SettingsNotice tone="error" role="alert">{error}</SettingsNotice> : null}
          {saved ? <SettingsNotice role="status">{t('saved', 'Saved. Existing external notification destinations now use this entry; no restart is needed.')}</SettingsNotice> : null}
          {state.information && state.authority?.canManage === false ? <SettingsNotice>{t('readonly', 'You can view this information. Ask a server administrator to make changes.')}</SettingsNotice> : null}
        </SettingsSection>
        <SettingsSection title={t('effects', 'What this changes')} description={t('effectsHint', 'WeCom and other external notification links use the saved entry at send time, including previously registered destinations.')}>
          <SettingsNotice>{t('limits', 'This does not configure DNS, TLS, reverse proxies or login permissions. Browser push notifications retain their original app origin. The setting is stored with server data and survives container updates.')}</SettingsNotice>
        </SettingsSection>
      </form>}
  </>;
}
