import { useIntl } from '@opencraft/i18n/react';
import { Button } from './ui/button';
import './draft-setup-notice.scss';

/** An actionable projection of the selected Host; never owns a draft or connection. */
export function DraftSetupNotice({ kind, hostName, onConfigure, onRetry, onConnectionSettings }: {
  readonly kind: 'models' | 'catalog-error' | 'connection';
  readonly hostName: string;
  readonly onConfigure?: () => void;
  readonly onRetry: () => void;
  readonly onConnectionSettings: () => void;
}) {
  const intl = useIntl();
  return <section className="draft-setup-notice thread-layout-width" aria-label={intl.formatMessage({ id: 'welcome.nextStep', defaultMessage: 'Next step' })}>
    <p>{intl.formatMessage(kind === 'models'
      ? { id: 'welcome.models.required', defaultMessage: 'Set up a usable model on {host}, or select one that is already configured.' }
      : kind === 'catalog-error'
        ? { id: 'welcome.models.failed', defaultMessage: 'Could not load models from {host}. Try again.' }
        : { id: 'welcome.connection.failed', defaultMessage: 'Could not connect to {host}. Check the connection or retry.' }, { host: hostName })}</p>
    <div className="draft-setup-notice__actions">
      {kind === 'models' && onConfigure ? <Button variant="primary" onClick={onConfigure}>
        {intl.formatMessage({ id: 'welcome.local.configure', defaultMessage: 'Configure models' })}
      </Button> : null}
      {kind !== 'models' ? <Button variant="secondary" onClick={onRetry}>
        {intl.formatMessage({ id: 'welcome.retry', defaultMessage: 'Retry' })}
      </Button> : null}
      <Button variant="ghost" onClick={onConnectionSettings}>
        {intl.formatMessage({ id: 'welcome.connection.settings', defaultMessage: 'Connection settings' })}
      </Button>
    </div>
  </section>;
}
