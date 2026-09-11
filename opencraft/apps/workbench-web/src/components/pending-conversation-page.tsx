import { composerDocumentToPlainText, type SubmitIntent } from "@opencraft/composer-core";
import type { NewThreadDraftSnapshot } from "@opencraft/workbench-runtime";
import { LoaderCircle } from "lucide-react";

export interface PendingConversationPageProps {
  readonly conversation: NewThreadDraftSnapshot;
  readonly onRetry: (intent: SubmitIntent) => void | Promise<void>;
}

/**
 * Conversation-owned presentation used between the local submit commit and
 * the authoritative Thread binding. It deliberately contains no Draft
 * Composer: the immutable first Turn has already crossed that ownership seam.
 */
export function PendingConversationPage({
  conversation,
  onRetry,
}: PendingConversationPageProps) {
  const submission = conversation.submission;
  if (submission === null) {
    throw new Error(
      `Pending Conversation ${conversation.scopeId} has no immutable first Turn`,
    );
  }
  const submittedText = composerDocumentToPlainText(submission.document).trim();

  return (
    <div
      className="pending-conversation-page"
      data-conversation-scope-id={conversation.scopeId}
      data-pending-conversation-phase={conversation.phase}
    >
      <main className="pending-conversation-scroll" aria-label="Conversation">
        <div className="pending-conversation-content thread-layout-width">
          <div className="pending-conversation-user-message">
            {submittedText || submission.attachments[0]?.name || "New task"}
          </div>
          {conversation.phase === "submit-failed" ? (
            <section className="pending-conversation-error" role="alert">
              <div>
                <strong>Could not start this task</strong>
                <p>{conversation.error?.message ?? "The execution host rejected the request."}</p>
              </div>
              <button type="button" onClick={() => void onRetry(submission)}>
                Try again
              </button>
            </section>
          ) : (
            <div className="pending-conversation-status" role="status">
              <LoaderCircle aria-hidden="true" size={15} />
              <span>Starting task…</span>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
