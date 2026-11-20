import { useEffect } from "react";
import type { SubmitIntent } from "@opencraft/composer-core";
import { submittedMessageDisplay } from "@opencraft/workbench-runtime";
import type { NewThreadDraftSnapshot } from "@opencraft/workbench-runtime";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";


import { UserMessageBlock } from "./conversation/user-message";
import { ConversationDocumentContext, type ConversationDocumentContextValue } from "./conversation/document-context";
import { pendingStartFailureMessage } from "./pending-start-failure";

export interface PendingConversationPageProps {
  readonly embedded?: boolean;
  readonly conversation: NewThreadDraftSnapshot;
  readonly documentContext: ConversationDocumentContextValue;
  readonly onRetry: (intent: SubmitIntent) => void | Promise<void>;
}

/**
 * Conversation-owned presentation used between the local submit commit and
 * the authoritative Thread binding. It deliberately contains no Draft
 * Composer for the submitted input: the immutable first Turn has already crossed
 * that ownership seam. The Conversation footer owns the next input.
 */
export function PendingConversationPage({
  conversation,
  embedded = false,
  documentContext,
  onRetry,
}: PendingConversationPageProps) {
  const submission = conversation.submission;
  if (submission === null) {
    throw new Error(
      `Pending Conversation ${conversation.scopeId} has no immutable first Turn`,
    );
  }
  // Use the submit-time sender; rendering must never infer authorship from
  // the currently selected account or fetch identity.
  const message = submittedMessageDisplay(submission, conversation.submissionSender);
  const intl = useIntl();
  const failed = conversation.phase === "submit-failed";
  const failure = failed ? conversation.error?.message ?? null : null;
  useEffect(() => {
    if (failure) console.info("[opencraft] task start failed", failure);
  }, [failure]);
  const retryLabel = intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" });

  const content = <div className="pending-conversation-content" data-conversation-scope-id={conversation.scopeId}
    data-pending-conversation-phase={conversation.phase}>
            <ConversationDocumentContext.Provider value={documentContext}>
              <UserMessageBlock block={message} />
            </ConversationDocumentContext.Provider>
            {failed && (
              <section className="pending-conversation-error" role="alert">
                <div>
                  <strong><FormattedMessage id="chat.start.failedTitle" defaultMessage="Could not start this task" /></strong>
                  <p>{intl.formatMessage(pendingStartFailureMessage(failure))}</p>
                </div>
                <button type="button" onClick={async () => {
                  // The Draft owner publishes the failure into conversation.error.
                  try { await onRetry(submission); } catch { /* Already presented above. */ }
                }}>
                  {retryLabel}
                </button>
              </section>
            )}
  </div>;
  if (embedded) return content;

  return (
    <div className="pending-conversation-page" data-conversation-scope-id={conversation.scopeId}
      data-pending-conversation-phase={conversation.phase}>
      <main className="pending-conversation-scroll thread-scroll" aria-label="Conversation">
        <div className="thread-scroll-surface">
          <div className="thread-content thread-layout-width" data-thread-follow-tail-layout>{content}</div>
        </div>
      </main>
    </div>
  );
}
