import type { ConversationOutbox, ConversationRuntimeSnapshot } from "@opencraft/chat-runtime";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

/** Release the draft only after another owner has taken this exact input. */
export function completeConversationComposerSubmission(
  intent: SubmitIntent,
  submission: Promise<SubmissionReceipt>,
  snapshot: Pick<ConversationRuntimeSnapshot, "key" | "pendingSubmissions" | "queuedSubmissions"> | null,
  onFailure: () => void,
  outbox: ConversationOutbox | null = null,
): boolean | Promise<boolean> {
  const owned = intent.target.type !== "new-thread" && snapshot !== null
    && snapshot.key.hostId === intent.target.key.hostId
    && snapshot.key.threadId === intent.target.key.threadId
    && [...snapshot.pendingSubmissions, ...snapshot.queuedSubmissions].some(row =>
      row.commandId === intent.commandId && row.clientMessageId === intent.clientMessageId);
  if (owned && outbox === null) {
    // The timeline already presents this input, including a later remote error.
    void submission.catch(onFailure);
    return true;
  }
  // Authority alone does not establish custody: identity restoration, outbox
  // hydration or a storage write may still reject before any item is published.
  const completion = submission.then(() => true, error => { onFailure(); throw error; });
  if (outbox === null || intent.attachments.length > 0 || intent.context.length > 0) return completion;
  let stop = () => {};
  const saved = new Promise<boolean>(resolve => {
    const check = () => { if (outbox.owns(intent)) resolve(true); };
    stop = outbox.subscribe(check);
    check();
  });
  return Promise.race([completion, saved]).finally(stop);
}
