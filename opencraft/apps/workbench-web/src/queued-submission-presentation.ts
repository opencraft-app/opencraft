import { restoreQueuedInput } from "@opencraft/composer-appserver";
import type { ComposerQueuedSubmissionPresentation } from "@opencraft/codex-composer";
import type { QueuedSubmission } from "@opencraft/chat-runtime";

export function queuedSubmissionPresentation(
  submission: QueuedSubmission,
  reorderable: boolean,
): ComposerQueuedSubmissionPresentation {
  return {
    id: submission.serverSubmissionId ?? submission.commandId,
    preview: submission.preview,
    state: submission.state,
    operation: submission.operation,
    actionable: submission.serverSubmissionId !== null,
    dismissible: submission.state === "failed" && submission.serverSubmissionId === null,
    reorderable,
    editableContent: restoreQueuedInput(submission.input),
    pausedReason: submission.pausedReason,
    error: submission.error?.message ?? null,
  };
}
