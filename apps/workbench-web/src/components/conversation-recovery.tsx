import React from "react";
import type { ConversationRecoveryDiagnostic } from "../runtime/conversation-recovery-diagnostic";
import { Button } from '@opencraft/design-system-web/button';
import { FormattedMessage } from "@opencraft/i18n/react";


import { type ConversationRecoveryPresentation } from "@opencraft/chat-core";
export { conversationRecoveryPresentation, type ConversationRecoveryPresentation } from "@opencraft/chat-core";
export type ConversationUnavailableReason = "archived" | "not-found";

/** Archive keeps a readable transcript. Only a missing conversation replaces it. */
export function conversationArchivePresentation(
  reason: ConversationUnavailableReason | null,
  hasHistory: boolean,
): { readonly showHistory: boolean; readonly banner: "replace" | "alongside" | "none" } {
  if (reason === "archived") return { showHistory: hasHistory, banner: hasHistory ? "alongside" : "replace" };
  if (reason === "not-found") return { showHistory: false, banner: "replace" };
  return { showHistory: true, banner: "none" };
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

export type ConnectionAccessFailure = 'authentication' | 'permission';
interface AccessRecoveryProps {
  readonly accessFailure?: ConnectionAccessFailure | null;
  readonly onRetry?: () => void;
}
function AccessRecovery({ accessFailure, onRetry }: AccessRecoveryProps) {
  return <>
    <span>{accessFailure === 'authentication'
      ? <FormattedMessage id="chat.reconnect.signInRequired" defaultMessage="Sign in in a new window, then return here and retry. This chat will stay open." />
      : <FormattedMessage id="chat.reconnect.accessDenied" defaultMessage="Your account does not have access to this server. Ask an administrator, then retry." />}</span>
    {accessFailure === 'authentication' ? <Button variant="link" size="sm" onClick={() => {
      // Explicit user action only. Never refresh this page, rewrite its draft or
      // start a login flow from an automatic reconnect/background event.
      window.open(window.location.href, '_blank', 'noopener,noreferrer');
    }}><FormattedMessage id="chat.reconnect.signIn" defaultMessage="Open sign-in" /></Button> : null}
    {onRetry ? <Button variant="link" size="sm" onClick={onRetry}><FormattedMessage id="chat.reconnect.retryConnection" defaultMessage="Retry connection" /></Button> : null}
  </>;
}

/** Routine recovery stays in its owner; manual admission failures need actions. */
export function ConversationRecoveryEmptyState({ failed, requiresUpdate = false, accessFailure, onRetry }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
} & AccessRecoveryProps) {
  if (failed && accessFailure) return <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><AccessRecovery accessFailure={accessFailure} onRetry={onRetry} /></div>;
  return failed && requiresUpdate
    ? <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><ClientUpdateRequired /></div>
    : null;
}

export function ConversationRecoveryNotice({ failed, requiresUpdate = false, accessFailure, onRetry }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
} & AccessRecoveryProps) {
  if (failed && accessFailure) return <div className="conversation-recovery-notice" role="alert"><AccessRecovery accessFailure={accessFailure} onRetry={onRetry} /></div>;
  return failed && requiresUpdate
    ? <div className="conversation-recovery-notice" role="alert"><ClientUpdateRequired /></div>
    : null;
}

