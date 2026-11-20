import React from "react";
import {FormattedMessage, useIntl} from "@opencraft/i18n/react";
import {ArchiveIcon, RestoreArchiveIcon} from "@opencraft/design-system-web/action-icons";
import {Button} from "@opencraft/design-system-web/button";
import type {ConversationUnavailableReason} from "./conversation-recovery";
/**
 * A terminal lifecycle result is a conversation state, not a failed Turn.
 * Keep the transcript and composer out of the error path so an archived route
 * cannot grow duplicate "Continue" messages while it is being restored.
 */
export function ConversationUnavailableState({
  reason,
  onRestore,
  restoring = false,
}: {
  readonly reason: ConversationUnavailableReason;
  readonly onRestore?: () => void | Promise<void>;
  readonly restoring?: boolean;
}) {
  const intl = useIntl();
  const archived = reason === "archived";
  return (
    <section
      aria-live="polite"
      className="conversation-unavailable-state"
      data-reason={reason}
      role="status"
    >
      <span aria-hidden="true" className="conversation-unavailable-state__icon">
        <ArchiveIcon size={18} />
      </span>
      <div className="conversation-unavailable-state__copy">
        <strong>
          {archived
            ? <FormattedMessage id="chat.archived.title" defaultMessage="This conversation is archived" />
            : <FormattedMessage id="chat.unavailable.title" defaultMessage="Conversation unavailable" />}
        </strong>
        <p>
          {archived
            ? <FormattedMessage id="chat.archived.description" defaultMessage="You can still view the history. Restore to continue the conversation." />
            : <FormattedMessage id="chat.unavailable.description" defaultMessage="This conversation is no longer available." />}
        </p>
      </div>
      {archived && onRestore ? (
        <Button
          variant="primary"
          loading={restoring}
          aria-label={intl.formatMessage({ id: "chat.archived.restore", defaultMessage: "Restore conversation" })}
          className="conversation-unavailable-state__restore"
          disabled={restoring}
          onClick={() => { void onRestore(); }}
          type="button"
        >
          <RestoreArchiveIcon aria-hidden="true" size={14} />
          <span>{restoring
            ? <FormattedMessage id="chat.archived.restoring" defaultMessage="Restoring…" />
            : <FormattedMessage id="chat.archived.restore" defaultMessage="Restore conversation" />}</span>
        </Button>
      ) : null}
    </section>
  );
}

export function ConversationArchivedBadge() {
  return <span className="conversation-archived-badge"><ArchiveIcon size={14} aria-hidden="true" /><FormattedMessage id="chat.archived.badge" defaultMessage="Archived" /></span>;
}
