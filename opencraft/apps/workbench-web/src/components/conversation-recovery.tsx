import { FormattedMessage } from "@opencraft/i18n/react";
import React from "react";
import { LoadingSpinner } from "./ui/loading-spinner";

export type ConversationRecoveryPresentation = "none" | "cold-loading" | "cold-error" | "warm-loading" | "warm-error";

/** Presentation only: a retained timeline is useful even before it is authoritative. */
export function conversationRecoveryPresentation(input: {
  readonly authoritative: boolean;
  readonly hasVisibleHistory: boolean;
  readonly failed: boolean;
}): ConversationRecoveryPresentation {
  if (input.authoritative) return "none";
  return `${input.hasVisibleHistory ? "warm" : "cold"}-${input.failed ? "error" : "loading"}`;
}

export function ConversationRecoveryEmptyState({ failed, onRetry }: {
  readonly failed: boolean;
  readonly onRetry?: () => void;
}) {
  if (failed) return (
    <div className="conversation-recovery-empty-error thread-layout-width" role="alert">
      <p><FormattedMessage id="chat.restore.failed" defaultMessage="Could not load this conversation" /></p>
      {onRetry ? <button type="button" onClick={onRetry}><FormattedMessage id="common.retry" defaultMessage="Try again" /></button> : null}
    </div>
  );
  return (
    <div className="conversation-recovery-loading" role="status">
      <span className="conversation-recovery-loading__label"><FormattedMessage id="chat.restore.loading" defaultMessage="Loading conversation history…" /></span>
      <LoadingSpinner />
    </div>
  );
}

export function ConversationRecoveryNotice({ failed, reconnecting, onRetry }: {
  readonly failed: boolean;
  readonly reconnecting: boolean;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="conversation-recovery-notice" role={failed ? "alert" : "status"}>
      <span className="conversation-recovery-notice__dot" aria-hidden="true" />
      <span>{failed
        ? <FormattedMessage id="chat.reconnect.failed" defaultMessage="Could not reconnect" />
        : reconnecting
          ? <FormattedMessage id="chat.reconnect.pending" defaultMessage="Reconnecting…" />
          : <FormattedMessage id="chat.sync.pending" defaultMessage="Syncing…" />}
      </span>
      {failed && onRetry ? <button type="button" onClick={onRetry}><FormattedMessage id="common.retry" defaultMessage="Try again" /></button> : null}
    </div>
  );
}
