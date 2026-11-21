import type { TimelineSnapshot } from '@opencraft/chat-core';
import type { PendingSubmission, QueuedSubmission } from '@opencraft/chat-runtime';

export interface RecoverableSubmission {
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly preview: string;
  readonly state: 'unknown' | 'failed';
}

export interface SubmissionRecoveryActions {
  readonly byClientId: ReadonlyMap<string, RecoverableSubmission>;
  readonly onAbandon: (id: string) => Promise<void>;
  readonly onRetry: (id: string) => Promise<void>;
}

/** Attach recovery to the exact message, never to matching text or another view's history. */
export function submissionRecoveryPresentation(
  pending: readonly PendingSubmission[], queued: readonly QueuedSubmission[], timeline: TimelineSnapshot | null,
) {
  const rows = new Map<string, RecoverableSubmission>();
  for (const item of pending) if (item.state === 'unknown') rows.set(item.commandId, { ...item, state: 'unknown' });
  for (const item of queued) if (item.state === 'unknown' && item.serverSubmissionId === null
    || item.state === 'failed' && item.pausedReason === 'outbox-failed')
    rows.set(item.commandId, { ...item, state: item.state === 'unknown' ? 'unknown' : 'failed' });
  const byClientId = new Map<string, RecoverableSubmission>();
  const detached: RecoverableSubmission[] = [];
  if (rows.size === 0) return { byClientId, detached };
  const messages = new Set(timeline?.frames.flatMap(frame => frame.blocks.flatMap(block =>
    block.type === 'user-message' && block.clientId !== null ? [block.clientId] : [])) ?? []);
  for (const item of rows.values()) {
    if (messages.has(item.clientMessageId)) byClientId.set(item.clientMessageId, item);
    else if (item.state === "unknown") detached.push(item);
  }
  return { byClientId, detached };
}
