import type { ConversationRuntimeSnapshot } from "@opencraft/chat-runtime";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

/** Release the draft only after another owner has taken this exact input. */
export function completeConversationComposerSubmission(
  intent: SubmitIntent,
  submission: Promise<SubmissionReceipt>,
  snapshot: Pick<ConversationRuntimeSnapshot, "key" | "pendingSubmissions" | "queuedSubmissions"> | null,
  onFailure: () => void,
): boolean | Promise<boolean> {
  const owned = intent.target.type !== "new-thread" && snapshot !== null
    && snapshot.key.hostId === intent.target.key.hostId
    && snapshot.key.threadId === intent.target.key.threadId
    && [...snapshot.pendingSubmissions, ...snapshot.queuedSubmissions].some(row =>
      row.commandId === intent.commandId && row.clientMessageId === intent.clientMessageId);
  if (owned) {
    // The timeline already presents this input, including a later remote error.
    void submission.catch(onFailure);
    return true;
  }
  // Authority alone does not establish custody: identity restoration, outbox
  // hydration or a storage write may still reject before any item is published.
  return submission.then(() => true, error => { onFailure(); throw error; });
}
