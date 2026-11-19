import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import { SubmissionOutcomeUnknownError } from '@opencraft/chat-runtime';

/** An optimistic row is presentation, not a custody receipt. Keep the draft
 * until local persistence or the Host acknowledges this exact input. */
export async function completeConversationComposerSubmission(
  intent: SubmitIntent,
  submission: Promise<SubmissionReceipt>,
  onFailure: () => void,
): Promise<boolean> {
  try {
    const receipt = await submission;
    if (receipt.commandId !== intent.commandId || receipt.clientMessageId !== intent.clientMessageId
      || (intent.target.type !== "new-thread"
        && (receipt.hostId !== intent.target.key.hostId || receipt.threadId !== intent.target.key.threadId)))
      throw new Error("Submission receipt does not match this input");
    return true;
  } catch (error) {
    onFailure();
    // The message owns uncertainty and recovery. Keep draft custody without
    // presenting the same transport diagnostic as a Composer failure as well.
    if (error instanceof SubmissionOutcomeUnknownError) return false;
    throw error;
  }
}
