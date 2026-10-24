import React, { useState } from "react";
import { writeTextToClipboard } from "@opencraft/chat-render-web/clipboard";
import { conversationRecoveryDiagnosticText, type ConversationRecoveryDiagnostic } from "../runtime/conversation-recovery-diagnostic";
import { FormattedMessage } from "@opencraft/i18n/react";


export type ConversationRecoveryPresentation = "none" | "cold-loading" | "cold-error" | "warm-loading" | "warm-error";

/** Presentation only: a retained timeline is useful even before it is authoritative. */
export function conversationRecoveryPresentation(input: {
  readonly authoritative: boolean;
  readonly hasVisibleHistory: boolean;
  readonly failed: boolean;
}): ConversationRecoveryPresentation {
  if (input.authoritative) return "none";
  return `${input.hasVisibleHistory ? "warm" : "cold"}-${input.failed ? "error" : "loading"}`;
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

function ClientUpdateRequired() {
  return <FormattedMessage id="chat.reconnect.updateRequired" defaultMessage="Update or reload to reconnect" />;
}

function RecoveryFailureStage({ stage }: { readonly stage: ConversationRecoveryDiagnostic["stage"] }) {
  if (stage === "connection") return <FormattedMessage id="chat.recovery.stage.connection" defaultMessage="Connection failed" />;
  if (stage === "activation") return <FormattedMessage id="chat.recovery.stage.activation" defaultMessage="Conversation activation failed" />;
  return <FormattedMessage id="chat.recovery.stage.history" defaultMessage="History restore failed" />;
}

function RecoveryTechnicalDetails({ diagnostic, pending = false }: { readonly diagnostic: ConversationRecoveryDiagnostic; readonly pending?: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const text = conversationRecoveryDiagnosticText(diagnostic);
  return <details className="conversation-recovery-details">
    <summary className="ui-native-disclosure"><FormattedMessage id="chat.recovery.details" defaultMessage="Technical details" /></summary>
    {!pending ? <p><RecoveryFailureStage stage={diagnostic.stage} /></p> : null}
    <pre>{text}</pre>
    <button type="button" onClick={() => {
      try { console.log("[conversation-recovery] copied details\n" + text); } catch { /* Logging cannot prevent copying. */ }
      void writeTextToClipboard(text).then(() => setCopyState("copied"), () => setCopyState("failed"));
    }}><FormattedMessage id="chat.recovery.copy" defaultMessage="Copy details" /></button>
    <span role="status">{copyState === "copied"
      ? <FormattedMessage id="chat.recovery.copied" defaultMessage="Copied" />
      : copyState === "failed" ? <FormattedMessage id="chat.recovery.copyFailed" defaultMessage="Could not copy. Select the details to copy manually." /> : null}</span>
  </details>;
}

/** An intermediate failed request can still be waiting for automatic retry. */
function RecoveryFailureDetails({ diagnostic }: { readonly diagnostic: ConversationRecoveryDiagnostic }) {
  if (diagnostic.progress) {
    if (diagnostic.progress.stage !== "failed" && diagnostic.progress.stage !== "blocked") return null;
  }
  return <RecoveryTechnicalDetails diagnostic={diagnostic} />;
}

export function ConversationRecoveryEmptyState({ failed, requiresUpdate = false, onRetry, diagnostic }: {
  readonly diagnostic?: ConversationRecoveryDiagnostic;
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
  readonly onRetry?: () => void;
}) {
  if (failed) return (
    <div className="conversation-recovery-empty-error thread-layout-width" role="alert">
      <p>{requiresUpdate ? <ClientUpdateRequired /> : <FormattedMessage id="chat.restore.failed" defaultMessage="Could not load this conversation" />}</p>
      {!requiresUpdate && onRetry ? <button type="button" onClick={onRetry}><FormattedMessage id="common.retry" defaultMessage="Try again" /></button> : null}
      {diagnostic ? <RecoveryFailureDetails key={diagnostic.progress ? diagnostic.viewKey : `${diagnostic.viewKey ?? ""}:${conversationRecoveryDiagnosticText(diagnostic)}`} diagnostic={diagnostic} /> : null}
    </div>
  );
  return null;
}

export function ConversationRecoveryNotice({ failed, requiresUpdate = false, onRetry, diagnostic }: {
  readonly failed: boolean;
  readonly reconnecting?: boolean;
  readonly diagnostic?: ConversationRecoveryDiagnostic;
  readonly requiresUpdate?: boolean;
  readonly onRetry?: () => void;
}) {
  // An intermediate request error is not a stopped recovery episode.
  // The existing owner keeps retrying without putting chrome over retained history.
  const stage = diagnostic?.progress?.stage;
  if (!failed || (!requiresUpdate && stage !== undefined && stage !== "failed" && stage !== "blocked")) return null;
  return (
    <div className="conversation-recovery-notice" role="alert">
      <span>{requiresUpdate ? <ClientUpdateRequired /> : <FormattedMessage id="chat.reconnect.failed" defaultMessage="Could not reconnect" />}</span>
      {!requiresUpdate && onRetry ? <button type="button" onClick={onRetry}><FormattedMessage id="common.retry" defaultMessage="Try again" /></button> : null}
      {diagnostic ? <RecoveryFailureDetails key={diagnostic.progress ? diagnostic.viewKey : `${diagnostic.viewKey ?? ""}:${conversationRecoveryDiagnosticText(diagnostic)}`} diagnostic={diagnostic} /> : null}
    </div>
  );
}
