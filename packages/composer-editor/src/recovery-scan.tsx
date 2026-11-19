import { FormattedMessage } from "@opencraft/i18n/react";

/** Paint only: the conversation owner decides when recovery is pending. */
export function ComposerRecoveryScan({ active, waiting }: { readonly active: boolean; readonly waiting: boolean }) {
  return <div className="opencraft-composer-recovery" data-active={active ? "true" : "false"} data-waiting={waiting || undefined}>
    <span className="opencraft-composer-recovery__beam" aria-hidden="true" />
    <span className="opencraft-composer-recovery__label" role="status">
      {active ? <FormattedMessage id="chat.composer.reconnecting" defaultMessage="Reconnecting…" />
        : waiting ? <FormattedMessage id="chat.waitingForHost" defaultMessage="Waiting for execution host" /> : null}
    </span>
  </div>;
}
