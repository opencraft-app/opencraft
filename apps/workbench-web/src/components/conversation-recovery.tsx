import React from "react";
import type { ConversationRecoveryDiagnostic } from "../runtime/conversation-recovery-diagnostic";
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

/** Routine recovery stays in the owner; only incompatible clients need an instruction. */
export function ConversationRecoveryEmptyState({ failed, requiresUpdate = false }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
}) {
  return failed && requiresUpdate
    ? <div className="conversation-recovery-empty-error thread-layout-width" role="alert"><ClientUpdateRequired /></div>
    : null;
}

export function ConversationRecoveryNotice({ failed, requiresUpdate = false }: {
  readonly failed: boolean;
  readonly requiresUpdate?: boolean;
}) {
  return failed && requiresUpdate
    ? <div className="conversation-recovery-notice" role="alert"><ClientUpdateRequired /></div>
    : null;
}
