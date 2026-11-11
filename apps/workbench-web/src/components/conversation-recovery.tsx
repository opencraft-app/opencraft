import React from "react";
import type { ConversationRecoveryDiagnostic } from "../runtime/conversation-recovery-diagnostic";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { ArchiveIcon, RestoreArchiveIcon } from "@opencraft/design-system-web/action-icons";


export type ConversationRecoveryPresentation = "none" | "cold-loading" | "cold-error" | "warm-loading" | "warm-error";
export type ConversationUnavailableReason = "archived" | "not-found";

/** Presentation only: a retained timeline is useful even before it is authoritative. */
export function conversationRecoveryPresentation(input: {
  readonly authoritative: boolean;
  readonly hasVisibleHistory: boolean;
  readonly failed: boolean;
}): ConversationRecoveryPresentation {
  if (input.authoritative) return "none";
  return `${input.hasVisibleHistory ? "warm" : "cold"}-${input.failed ? "error" : "loading"}`;
}

/** Initial connection/history loading is routine, not evidence of instability. */
export function conversationRecoveryIsUnstable(
  presentation: ConversationRecoveryPresentation,
  diagnostic?: ConversationRecoveryDiagnostic,
): boolean {
  if (presentation === "none") return false;
  return presentation.endsWith("-error")
    || diagnostic?.runtime === "reconnecting"
    || diagnostic?.recovery !== undefined
    || diagnostic?.progress?.lastFailure !== undefined;
}

/** Intermediate errors can still belong to an active automatic retry. */
export function conversationRecoveryIsPending(
  presentation: ConversationRecoveryPresentation,
  diagnostic?: ConversationRecoveryDiagnostic,
  requiresUpdate = false,
): boolean {
  if (presentation === "none" || requiresUpdate) return false;
  const stage = diagnostic?.progress?.stage;
  if (stage === "failed" || stage === "blocked") return false;
  if (presentation.endsWith("-loading")) return true;
  return stage !== undefined;
}

/** Host recovery also paints before a Thread lease exists or while cached history is retained. */
export function connectionRecoveryIsPending(
  phase: string,
  diagnostic?: ConversationRecoveryDiagnostic,
  requiresUpdate = false,
): boolean {
  if (requiresUpdate) return false;
  if (phase === "connecting" || phase === "reconnecting") return true;
  return phase === "error" && conversationRecoveryIsPending("cold-error", diagnostic);
}

function ClientUpdateRequired() {
  return <FormattedMessage id="chat.reconnect.updateRequired" defaultMessage="Update or reload to reconnect" />;
}

/** Routine recovery stays in the owner; only incompatible clients need an instruction. */
export function ConversationRecoveryEmptyState({ failed, requiresUpdate = false }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
}) {
  return failed && requiresUpdate
    ? <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><ClientUpdateRequired /></div>
    : null;
}

export function ConversationRecoveryNotice({ failed, requiresUpdate = false }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
}) {
  return failed && requiresUpdate
    ? <div className="conversation-recovery-notice" role="alert"><ClientUpdateRequired /></div>
    : null;
}

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
            ? <FormattedMessage id="chat.archived.title" defaultMessage="Conversation archived" />
            : <FormattedMessage id="chat.unavailable.title" defaultMessage="Conversation unavailable" />}
        </strong>
        <p>
          {archived
            ? <FormattedMessage id="chat.archived.description" defaultMessage="This conversation is archived and read-only until you restore it." />
            : <FormattedMessage id="chat.unavailable.description" defaultMessage="This conversation is no longer available." />}
        </p>
      </div>
      {archived && onRestore ? (
        <button
          aria-busy={restoring || undefined}
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
        </button>
      ) : null}
    </section>
  );
}
