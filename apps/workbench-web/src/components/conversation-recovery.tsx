import React from "react";
import type { AppServerWorkbenchSnapshot } from "@opencraft/workbench-runtime";
import type { ConversationRecoveryRenderer } from "../runtime/conversation-presentation";
import type { ConversationRecoveryDiagnostic } from "../runtime/conversation-recovery-diagnostic";
import { Button } from '@opencraft/design-system-web/button';
import { FormattedMessage } from "@opencraft/i18n/react";


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

/** Use Host-owned progress even when the conversation has its own recovery in flight. */
export function composerConnectionFeedback(
  { phase, recovery }: Pick<AppServerWorkbenchSnapshot, "phase" | "recovery">,
  requiresAction = false,
) {
  const stage = recovery?.stage;
  return {
    warning: phase === "reconnecting" || phase === "error",
    pending: !requiresAction && (phase === "connecting" || phase === "reconnecting"
      || (phase === "error" && stage !== undefined && stage !== "failed" && stage !== "blocked")),
  };
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

interface RecoveryPresentationProps extends AccessRecoveryProps {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
  readonly reconnecting?: boolean;
  readonly diagnostic?: ConversationRecoveryDiagnostic;
  readonly renderRecovery?: ConversationRecoveryRenderer;
}

/** Routine recovery stays in its owner; manual admission failures need actions. */
export function ConversationRecoveryEmptyState({ failed, requiresUpdate = false, accessFailure, onRetry,
  reconnecting = false, diagnostic, renderRecovery,
}: RecoveryPresentationProps) {
  if (failed && accessFailure) return <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><AccessRecovery accessFailure={accessFailure} onRetry={onRetry} /></div>;
  if (failed && requiresUpdate) {
    return <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><ClientUpdateRequired /></div>;
  }
  return renderRecovery?.({ hasVisibleHistory: false, failed, reconnecting, requiresUpdate, diagnostic, onRetry }) ?? null;
}

export function ConversationRecoveryNotice({ failed, requiresUpdate = false, accessFailure, onRetry,
  reconnecting = false, diagnostic, renderRecovery,
}: RecoveryPresentationProps) {
  if (failed && accessFailure) return <div className="conversation-recovery-notice" role="alert"><AccessRecovery accessFailure={accessFailure} onRetry={onRetry} /></div>;
  if (failed && requiresUpdate) {
    return <div className="conversation-recovery-notice" role="alert"><ClientUpdateRequired /></div>;
  }
  return renderRecovery?.({ hasVisibleHistory: true, failed, reconnecting, requiresUpdate, diagnostic, onRetry }) ?? null;
}
