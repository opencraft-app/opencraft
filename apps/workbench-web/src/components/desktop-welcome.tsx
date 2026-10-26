import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { LaptopIcon, ServerIcon } from '@opencraft/design-system-web/action-icons';
import { SettingsButton, SettingsTextInput } from '@opencraft/extension-react';
import { remoteServerOrigin } from '@opencraft/plugin-local-account/connections';
import { useAsyncNotices } from './async-notices-context';
import { ModalSurface } from './modal/modal-surface';
import { ApplicationBrand } from './application-brand';
import './desktop-welcome.scss';

// Protocol example, identical in every locale.
const SERVER_ADDRESS_EXAMPLE = 'https://workbench.example.com';

/** First-use content is independent of automatic startup and Settings lifetime. */
export function DesktopWelcome({ onDismiss, onConfigureLocal, onConnectServer }: {
  readonly onDismiss: () => void;
  readonly onConfigureLocal?: () => void;
  readonly onConnectServer?: (origin: string, signal: AbortSignal) => Promise<void>;
}) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const [address, setAddress] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const title = intl.formatMessage({ id: 'welcome.title', defaultMessage: 'Welcome to OpenCraft' });
  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (request.current || !onConnectServer) return;
    let origin: string;
    try { origin = remoteServerOrigin(address.trim()); }
    catch { setInvalid(true); return; }
    setInvalid(false);
    const controller = new AbortController();
    request.current = controller;
    setConnecting(true);
    void onConnectServer(origin, controller.signal).then(() => {
      if (request.current === controller) onDismiss();
    }).catch(error => {
      if (request.current === controller && !controller.signal.aborted && !(error instanceof Error && error.name === 'AbortError')) notices.error({
        key: 'desktop-welcome-connect',
        message: intl.formatMessage({ id: 'welcome.connect.failed', defaultMessage: 'Could not connect to the server. Check the address and your access, then try again.' }),
      });
    }).finally(() => {
      if (request.current === controller) { request.current = null; setConnecting(false); }
    });
  };
  return <ModalSurface label={title} presentation="fullscreen" className="desktop-welcome-modal" dismissOnOutsidePress={false}
    closeLabel={intl.formatMessage({ id: 'welcome.close', defaultMessage: 'Close welcome page' })} onDismiss={onDismiss}>
    <main className="desktop-welcome">
      <header className="desktop-welcome__heading">
        <div className="desktop-welcome__brand"><ApplicationBrand /></div>
        <h1>{title}</h1>
        <p>{intl.formatMessage({ id: 'welcome.description', defaultMessage: 'Choose where you want to work. You can finish setting up in a few steps.' })}</p>
      </header>
      <div className="desktop-welcome__choices">
        <section className="desktop-welcome__choice" aria-labelledby="welcome-local-title">
          <span className="desktop-welcome__icon" aria-hidden="true"><LaptopIcon size={24} /></span>
          <h2 id="welcome-local-title">{intl.formatMessage({ id: 'welcome.local.title', defaultMessage: 'Work on this device' })}</h2>
          <p>{intl.formatMessage({ id: 'welcome.local.description', defaultMessage: 'Connect an AI service and let OpenCraft work with files and tools on this device.' })}</p>
          <div className="desktop-welcome__local-action">
            <SettingsButton variant="primary" disabled={!onConfigureLocal} onClick={onConfigureLocal}>
              {intl.formatMessage({ id: 'welcome.local.configure', defaultMessage: 'Configure models' })}
            </SettingsButton>
            <span className="desktop-welcome__hint">{intl.formatMessage({ id: 'welcome.local.hint', defaultMessage: 'No OpenCraft account required.' })}</span>
          </div>
        </section>
        <section className="desktop-welcome__choice" aria-labelledby="welcome-server-title">
          <span className="desktop-welcome__icon" aria-hidden="true"><ServerIcon size={24} /></span>
          <h2 id="welcome-server-title">{intl.formatMessage({ id: 'welcome.server.title', defaultMessage: 'Connect to your server' })}</h2>
          <p>{intl.formatMessage({ id: 'welcome.server.description', defaultMessage: 'Use an existing OpenCraft server. Sign in with the account provided by that server.' })}</p>
          <form className="desktop-welcome__server-form" noValidate onSubmit={connect}>
            <label htmlFor="welcome-server-address">{intl.formatMessage({ id: 'welcome.server.address', defaultMessage: 'Server address' })}</label>
            <SettingsTextInput id="welcome-server-address" type="url" value={address} placeholder={SERVER_ADDRESS_EXAMPLE} autoComplete="url"
              aria-invalid={invalid || undefined} aria-describedby="welcome-server-validation"
              onChange={event => { setAddress(event.currentTarget.value); setInvalid(false); }} />
            <span className="desktop-welcome__validation" id="welcome-server-validation" role="status">
              {invalid ? intl.formatMessage({ id: 'welcome.server.invalid', defaultMessage: 'Enter an HTTPS server address without a path or sign-in details.' }) : '\u00a0'}
            </span>
            <SettingsButton type="submit" loading={connecting} disabled={!address.trim() || !onConnectServer}>
              {intl.formatMessage({ id: 'welcome.server.connect', defaultMessage: 'Connect server' })}
            </SettingsButton>
          </form>
        </section>
      </div>
      <footer className="desktop-welcome__footer">
        <span>{intl.formatMessage({ id: 'welcome.later.hint', defaultMessage: 'You can also configure everything later in Settings.' })}</span>
        <SettingsButton variant="quiet" onClick={onDismiss}>{intl.formatMessage({ id: 'welcome.later', defaultMessage: 'Set up later' })}</SettingsButton>
      </footer>
    </main>
  </ModalSurface>;
}
