import { RecoveryScanArtwork } from "@opencraft/design-system-web/action-icons";
import { FormattedMessage } from "@opencraft/i18n/react";

/** Paint only: the conversation owner decides when recovery is pending. */
export function ComposerRecoveryScan({ active }: { readonly active: boolean }) {
  return <div className="opencraft-composer-recovery" data-active={active ? "true" : "false"}>
    <RecoveryScanArtwork className="opencraft-composer-recovery__scan" beamClassName="opencraft-composer-recovery__beam" />
    <span className="opencraft-composer-recovery__label" role="status">
      {active ? <FormattedMessage id="chat.restore.loading" defaultMessage="Loading conversation history…" /> : null}
    </span>
  </div>;
}
