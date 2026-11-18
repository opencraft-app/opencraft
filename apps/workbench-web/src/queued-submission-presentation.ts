import type { IntlShape } from "@opencraft/i18n";
import type { IdentityAvatarContribution } from "@opencraft/extension-react";
import type { MessageSender } from "@opencraft/appserver-protocol";
import { restoreQueuedInput } from "@opencraft/composer-appserver/runtime";
import type { ComposerQueuedSubmissionPresentation } from "@opencraft/composer-editor";
import type { QueuedSubmission } from "@opencraft/chat-runtime";
import type { TimelineSnapshot } from "@opencraft/chat-core";
import type { ChatMediaSourceLoader } from "@opencraft/chat-render-web";
import { resolveConversationMediaSource } from "./components/conversation/conversation-media-source";

/** Queue photos use the same resource policy and byte owner as transcript photos. */
export function createQueuedImageLoader(loader: ChatMediaSourceLoader, context: {
  readonly conversationId: string | null; readonly hostId: string; readonly cwd: string | null;
}) {
  return async (source: string, signal: AbortSignal) => {
    if (signal.aborted) return null;
    const resolution = resolveConversationMediaSource(source, context.cwd, undefined, true);
    if (resolution.directSource !== null) return { source: resolution.directSource };
    const { target, kind } = resolution.decision;
    if (!resolution.loadThroughHost || !target || !kind) return null;
    return loader({ ...context, source, signal, resolvedTarget: target, resourceKind: kind, documentId: "composer-queue-image" });
  };
}

/** A transcript user message already paints this exact input, including during handoff. */
export function visibleQueuedSubmissions(
  submissions: readonly QueuedSubmission[],
  timeline: TimelineSnapshot | null,
): readonly QueuedSubmission[] {
  if (timeline === null) return submissions;
  const clientIds = new Set(timeline.frames.flatMap(frame =>
    frame.blocks.flatMap(block => block.type === "user-message" && block.clientId !== null
      ? [block.clientId] : [])));
  return submissions.filter(submission => !(
    clientIds.has(submission.clientMessageId)
    && (submission.state === "submitting" || submission.state === "queued")
    && submission.operation === "idle" && submission.error === null
    && (submission.pausedReason === null || submission.pausedReason === "outbox-waiting")
  ));
}

export function queueSenderPresentation(sender: MessageSender | null | undefined, avatars: IdentityAvatarContribution | null) {
  return sender ? { name: sender.loginName, avatarUrl: avatars?.resolve(sender.kind, sender.loginName) ?? null } : null;
}

export function queuedSubmissionPresentation(
  submission: QueuedSubmission,
  reorderable: boolean,
  avatars: IdentityAvatarContribution | null = null,
  intl?: IntlShape,
): ComposerQueuedSubmissionPresentation {
  const statusMessage = submission.pausedReason === "execution-recovering"
    ? { id: "chat.queue.executionRecovering", defaultMessage: "Waiting for execution to recover" }
    : submission.pausedReason === "execution-fault-unconfirmed" || submission.pausedReason === "execution-interrupted"
      ? { id: "chat.queue.executionInterrupted", defaultMessage: "Execution interrupted · outcome unknown" }
    : submission.pausedReason === "session-tools-recovering"
    ? { id: "chat.queue.toolsRecovering", defaultMessage: "Waiting for session tools to recover · continues automatically" }
    : submission.pausedReason === "session-tools-unavailable"
      ? { id: "chat.queue.pausedAfterFailure", defaultMessage: "Message not sent. Resume to try again." }
      : submission.pausedReason === "outbox-waiting"
    ? { id: "chat.outbox.waiting", defaultMessage: "Saved locally · sends automatically after reconnect" }
    : submission.pausedReason === "outbox-unconfirmed"
      ? { id: "chat.outbox.unconfirmed", defaultMessage: "Delivery unconfirmed · check the conversation before sending again" }
      : submission.pausedReason === "outbox-failed"
        ? { id: "chat.outbox.failed", defaultMessage: "Message not sent · remove it and retry after reconnect" }
        : submission.pausedReason === "user-stopped"
          ? { id: "chat.queue.pausedAfterStop", defaultMessage: "Paused after stopping. Resume when ready." }
          : submission.pausedReason === "delivery-failed"
            ? { id: "chat.queue.pausedAfterFailure", defaultMessage: "Message not sent. Resume to try again." } : null;
  return {
    sender: queueSenderPresentation(submission.sender, avatars),
    id: submission.serverSubmissionId ?? submission.commandId,
    renderKey: submission.clientMessageId,
    preview: submission.preview,
    state: submission.state,
    operation: submission.operation,
    actionable: submission.serverSubmissionId !== null && submission.actions?.edit !== false,
    deletable: submission.serverSubmissionId !== null && submission.actions?.delete !== false,
    steerable: submission.actions?.start === false || ["execution-recovering", "execution-fault-unconfirmed", "execution-interrupted"].includes(submission.pausedReason ?? "") ? false : submission.steerable,
    dismissible: (submission.local === true && submission.state !== "submitting" && submission.state !== "unknown") || (submission.state === "failed" && submission.serverSubmissionId === null),
    reorderable: !submission.local && reorderable && submission.actions?.reorder !== false,
    resumable: !["execution-recovering", "execution-fault-unconfirmed", "execution-interrupted"].includes(submission.pausedReason ?? ""),
    editableContent: restoreQueuedInput(submission.input),
    pausedReason: statusMessage ? intl?.formatMessage(statusMessage) ?? statusMessage.defaultMessage : submission.pausedReason,
    error: submission.error?.message ?? null,
  };
}
